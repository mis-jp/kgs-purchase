/**
 * Fresh Acumatica cookie login for long-running sync jobs.
 * OAuth/user tokens expire mid-full-sync; cookie login can be refreshed.
 * Prefer reusing / keeping the system session so Acumatica login slots are not burned.
 */
import { AuthService } from "@/services/auth";
import {
    getAcumaticaBaseUrl,
    getAcumaticaCompany,
    getAcumaticaCredentialCandidates,
    unwrapEnvValue,
} from "@/lib/acumatica-env";
import {
    clearSystemCredential,
    getCachedSystemCredential,
    rememberSystemCredential,
    touchSystemCredential,
} from "@/lib/acumatica-system-auth";

function cookiesToString(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return "";
    return cookies
        .map((c) => String(c).split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
}

async function loginOnce(username, password, company) {
    const cookies = await AuthService.login({
        username,
        password,
        company: company || undefined,
    });
    const cookieString = cookiesToString(cookies);
    if (!cookieString) {
        throw new Error("Acumatica login returned no session cookies.");
    }
    return cookieString;
}

let loginInflight = null;
let loginLimitedUntil = 0;

function isLoginLimitError(err) {
    return /login limit/i.test(String(err?.message || err || ""));
}

function reuseExistingSession(reason) {
    const existing = getCachedSystemCredential({ allowStale: true });
    if (existing) {
        touchSystemCredential();
        console.log(`>>> [Sync Auth] Keeping existing Acumatica session (${reason})`);
        return existing;
    }
    return null;
}

export async function systemLoginForCompany(acumaticaCompany, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const cached = getCachedSystemCredential();
        if (cached) {
            touchSystemCredential();
            return cached;
        }
    }

    if (Date.now() < loginLimitedUntil) {
        const kept = reuseExistingSession("login limit active");
        if (kept) return kept;
        throw new Error("Acumatica API Login Limit reached. Reusing existing sessions until it expires.");
    }

    if (loginInflight) return loginInflight;

    loginInflight = (async () => {
        try {
            getAcumaticaBaseUrl();
        } catch {
            throw new Error("Acumatica system credentials are not configured in the environment.");
        }

        const candidates = getAcumaticaCredentialCandidates();
        if (!candidates.length) {
            throw new Error("Acumatica system credentials are not configured in the environment.");
        }

        const company = unwrapEnvValue(acumaticaCompany || getAcumaticaCompany() || "");
        const previous = getCachedSystemCredential({ allowStale: true });

        let lastErr;
        for (let i = 0; i < candidates.length; i++) {
            const { username, password } = candidates[i];
            const label = i === 0 ? "primary" : "secondary";
            try {
                const cookie = await loginOnce(username, password, company);
                rememberSystemCredential(cookie);
                console.log(`>>> [Sync Auth] ${label} Acumatica login succeeded`);
                return cookie;
            } catch (err) {
                lastErr = err;
                console.warn(
                    `>>> [Sync Auth] ${label} login${company ? ` for ${company}` : ""} failed:`,
                    err.message
                );
                if (isLoginLimitError(err)) {
                    loginLimitedUntil = Date.now() + 30 * 60 * 1000;
                    const kept = reuseExistingSession("login limit");
                    if (kept) return kept;
                    break;
                }
                if (!company) continue;
                try {
                    const cookie = await loginOnce(username, password, "");
                    rememberSystemCredential(cookie);
                    console.log(`>>> [Sync Auth] ${label} Acumatica login succeeded without company`);
                    return cookie;
                } catch (err2) {
                    lastErr = err2;
                    console.warn(`>>> [Sync Auth] ${label} login without company failed:`, err2.message);
                    if (isLoginLimitError(err2)) {
                        loginLimitedUntil = Date.now() + 30 * 60 * 1000;
                        const kept = reuseExistingSession("login limit");
                        if (kept) return kept;
                        break;
                    }
                }
            }
        }

        // Only keep a previous cookie on login-limit (or soft reuse when not forcing).
        // After a 401 forceRefresh, returning the same dead cookie causes endless Unauthorized.
        if (previous && (isLoginLimitError(lastErr) || !forceRefresh)) {
            console.warn(
                `>>> [Sync Auth] Login failed; keeping previous Acumatica session: ${lastErr?.message || "unknown"}`
            );
            touchSystemCredential();
            return previous;
        }

        throw new Error(
            `Acumatica login failed for ${company || "(default)"}: ${lastErr?.message || "unknown error"}`
        );
    })().finally(() => {
        loginInflight = null;
    });

    return loginInflight;
}

export function hasSystemAcumaticaCredentials() {
    try {
        getAcumaticaBaseUrl();
    } catch {
        return false;
    }
    return getAcumaticaCredentialCandidates().length > 0;
}

export function isUnauthorizedError(err) {
    const msg = String(err?.message || err || "");
    return /unauthorized|401/i.test(msg);
}

/**
 * Prefer a system cookie for sync. Reuse the in-memory / persisted session when
 * possible so full sync does not burn Acumatica API login slots on every section.
 */
export async function obtainSyncCredential({
    companyName,
    sessionCookie,
    sessionId,
    getSessionCookies,
    getCompanyCredential,
} = {}) {
    try {
        const { ensureAcumaticaKeepAlive } = await import("@/lib/acumatica-keepalive");
        ensureAcumaticaKeepAlive();
    } catch {
        /* keep-alive is best-effort */
    }

    const cached = getCachedSystemCredential({ allowStale: true });
    if (cached) {
        try {
            const probe = await AuthService.validateSession(cached);
            if (probe?.ok) {
                touchSystemCredential();
                console.log(">>> [Sync Auth] Reusing cached ACU_* session");
                return cached;
            }
            if (probe?.reason === "acumatica_expired") {
                console.warn(">>> [Sync Auth] Cached ACU_* session expired — clearing and signing in again");
                clearSystemCredential();
            } else {
                // Network / degraded — still try the cookie; caller handles failures.
                touchSystemCredential();
                console.log(">>> [Sync Auth] Reusing cached ACU_* session (probe degraded)");
                return cached;
            }
        } catch (probeErr) {
            console.warn(">>> [Sync Auth] Session probe failed; trying cached cookie:", probeErr.message);
            touchSystemCredential();
            return cached;
        }
    }

    if (sessionCookie && sessionCookie !== "__bypass__") return sessionCookie;
    if (sessionId && typeof getSessionCookies === "function") {
        const fromCookies = getSessionCookies(sessionId, "main");
        if (fromCookies && fromCookies !== "__bypass__") return fromCookies;
    }
    if (sessionId && typeof getCompanyCredential === "function") {
        const fromCompany = getCompanyCredential(sessionId, "main");
        if (fromCompany && fromCompany !== "__bypass__") return fromCompany;
    }

    if (hasSystemAcumaticaCredentials()) {
        try {
            const cookie = await systemLoginForCompany(companyName);
            console.log(">>> [Sync Auth] Using ACU_* Acumatica session");
            return cookie;
        } catch (err) {
            console.warn(">>> [Sync Auth] ACU_* login failed, trying session:", err.message);
            const kept = getCachedSystemCredential({ allowStale: true });
            if (kept) return kept;
        }
    }

    return null;
}
