import { getAcumaticaBaseUrl } from "@/lib/acumatica-env";

// Bypasses 'CERT_HAS_EXPIRED' error for Acumatica connections
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const COMMON_HEADERS = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
};

function authUrls() {
    const base = getAcumaticaBaseUrl();
    return {
        authUrl: `${base}/entity/auth/login`,
        logoutUrl: `${base}/entity/auth/logout`,
        tokenUrl: `${base}/identity/connect/token`,
        apiBase: base,
    };
}

// Parse Acumatica error responses into a clean user-facing message
function parseAcuError(raw) {
    try {
        const obj = JSON.parse(raw);
        let msg = obj.exceptionMessage || obj.message || raw;
        
        if (msg.includes("API Login Limit")) {
            return "Acumatica API Login Limit reached. Please wait 30 minutes for sessions to expire, or ask your administrator to terminate active sessions for this user.";
        }
        
        return msg;
    } catch { /* not JSON */ }
    
    if (raw.includes("API Login Limit")) {
        return "Acumatica API Login Limit reached. Please wait 30 minutes for sessions to expire, or ask your administrator to terminate active sessions for this user.";
    }
    
    return raw || "Login failed";
}

export const AuthService = {
    /**
     * OAuth2 Resource Owner Password flow → returns a Bearer token object.
     * { access_token, refresh_token, expires_in, token_type }
     */
    async loginWithToken({ username, password, company }) {
        const body = new URLSearchParams({
            grant_type: "password",
            client_id: "frontend",
            client_secret: "",
            username,
            password,
            scope: "api",
            ...(company ? { acumatica_company: company } : {}),
        });

        const { tokenUrl } = authUrls();

        const res = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });

        if (!res.ok) {
            const raw = await res.text().catch(() => "Token request failed");
            throw new Error(parseAcuError(raw));
        }

        const data = await res.json();
        if (!data.access_token) throw new Error("No access_token in response");
        return data; // { access_token, refresh_token, expires_in, token_type }
    },

    async login({ username, password, company }) {
        // We cannot call LOGOUT_URL here without a session cookie. 
        // Acumatica sessions are tied to the 'Set-Cookie' headers returned by this endpoint.
        
        const { authUrl } = authUrls();

        const res = await fetch(authUrl, {
            method: "POST",
            headers: COMMON_HEADERS,
            body: JSON.stringify({ name: username, password, company }),
        });

        if (!res.ok) {
            const raw = await res.text().catch(() => "Login failed");
            throw new Error(parseAcuError(raw));
        }

        const cookies = res.headers.getSetCookie();
        if (cookies && cookies.length > 0) return cookies;

        // Fallback for older environments or specific headers
        const singleCookie = res.headers.get("Set-Cookie");
        if (singleCookie) return [singleCookie];

        return [];
    },

    async logout(cookie) {
        try {
            const { logoutUrl } = authUrls();
            await fetch(logoutUrl, {
                method: "POST",
                headers: { ...COMMON_HEADERS, Cookie: cookie },
            });
        } catch { /* ignore */ }
        return true;
    },

    async getUserInfo(username, cookie) {
        const { apiBase } = authUrls();
        const safeUsername = username.replace(/'/g, "''");
        const url = `${apiBase}/entity/Default/20.200.001/Users?$filter=Username eq '${safeUsername}'&$select=Username,FirstName,LastName&$top=1`;

        const res = await fetch(url, {
            headers: { ...COMMON_HEADERS, Cookie: cookie },
        });

        if (!res.ok) return { fullName: username };

        const data = await res.json();
        const user = Array.isArray(data) ? data[0] : data;

        if (!user) return { fullName: username };

        const first = (user.FirstName?.value ?? user.FirstName ?? "").trim();
        const last = (user.LastName?.value ?? user.LastName ?? "").trim();

        return {
            first,
            last,
            fullName: [first, last].filter(Boolean).join(" ") || username
        };
    },

    /**
     * Probe Acumatica with the stored cookie or Bearer token.
     * This is the source of truth for "still logged in" — not the local app cookie alone.
     */
    async validateSession(credential) {
        if (!credential) {
            return { ok: false, reason: "missing" };
        }
        if (credential === "__bypass__") {
            return { ok: true, bypass: true, source: "bypass" };
        }

        const { apiBase } = authUrls();
        // Tiny read — validates the Acumatica session without pulling business data.
        // Prefer StockItem (always present) over Branch — some tenants return
        // "Entity Branch not found" even with a valid cookie.
        const url = `${apiBase}/entity/Default/20.200.001/StockItem?$top=1&$select=InventoryID`;

        const headers = { ...COMMON_HEADERS };
        if (typeof credential === "string" && credential.startsWith("__bearer__")) {
            headers.Authorization = `Bearer ${credential.slice("__bearer__".length)}`;
        } else {
            headers.Cookie = credential;
        }

        try {
            const res = await fetch(url, {
                method: "GET",
                headers,
                cache: "no-store",
            });

            if (res.status === 401 || res.status === 403) {
                return { ok: false, reason: "acumatica_expired", status: res.status, source: "acumatica" };
            }

            // Transient ERP errors should not force logout
            if (!res.ok) {
                return { ok: true, degraded: true, status: res.status, source: "acumatica" };
            }

            return { ok: true, source: "acumatica" };
        } catch (err) {
            // Network / TLS issues — keep app session until Acumatica is reachable again
            return { ok: true, degraded: true, reason: err.message, source: "acumatica" };
        }
    },
};
