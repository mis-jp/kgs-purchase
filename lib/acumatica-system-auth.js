/**
 * Server-side Acumatica credential for BFF routes when the user session
 * cannot call Acumatica (expired OAuth token, bypass mode, etc.).
 */
import { getSessionFromRequest } from "@/lib/session-store";
import { isAcumaticaUnauthorized } from "@/lib/acumatica-retry";

let cachedCredential = null;
let cachedExpiry = 0;

const CACHE_MS = 25 * 60 * 1000;

export function getCachedSystemCredential() {
    if (cachedCredential && Date.now() < cachedExpiry) {
        return cachedCredential;
    }
    return null;
}

export function rememberSystemCredential(cookie, ttlMs = CACHE_MS) {
    if (!cookie || cookie === "__bypass__") return;
    cachedCredential = cookie;
    cachedExpiry = Date.now() + ttlMs;
}

export async function getSystemAcumaticaCredential() {
    const cached = getCachedSystemCredential();
    if (cached) return cached;

    try {
        const { systemLoginForCompany } = await import("@/lib/sync-acumatica-auth");
        const { getAcumaticaCompany } = await import("@/lib/acumatica-env");
        return await systemLoginForCompany(getAcumaticaCompany());
    } catch (err) {
        console.error("[SystemAuth] Login failed:", err.message);
        return null;
    }
}

async function refreshSystemCredential() {
    const { systemLoginForCompany } = await import("@/lib/sync-acumatica-auth");
    const { getAcumaticaCompany } = await import("@/lib/acumatica-env");
    return systemLoginForCompany(getAcumaticaCompany(), { forceRefresh: true });
}

const EXPIRED_USER_TTL_MS = 30 * 60 * 1000;
/** User credentials Acumatica rejected; skipped until the user signs in again. */
const expiredUserCredentials = new Map();

function isKnownExpired(credential) {
    const until = expiredUserCredentials.get(credential);
    if (!until) return false;
    if (Date.now() < until) return true;
    expiredUserCredentials.delete(credential);
    return false;
}

function markExpired(credential) {
    expiredUserCredentials.set(credential, Date.now() + EXPIRED_USER_TTL_MS);
    if (expiredUserCredentials.size > 500) {
        const now = Date.now();
        for (const [key, until] of expiredUserCredentials) {
            if (until <= now) expiredUserCredentials.delete(key);
        }
    }
}

const usable = (credential) => Boolean(credential) && credential !== "__bypass__";

/**
 * Run `task(credential)` with the user's Acumatica credential, falling back to the
 * cached system login and then a fresh system login when Acumatica answers 401.
 * Any other error is thrown straight away. Returns null when no credential exists.
 */
export async function withAcumaticaCredential(userCredential, task, { label = "Acumatica" } = {}) {
    const attempts = [];
    if (usable(userCredential) && !isKnownExpired(userCredential)) {
        attempts.push({ user: true, get: async () => userCredential });
    }
    attempts.push({ user: false, get: getSystemAcumaticaCredential });
    attempts.push({ user: false, get: refreshSystemCredential });

    const tried = new Set();
    let lastAuthError = null;
    for (const attempt of attempts) {
        const credential = await attempt.get();
        if (!usable(credential) || tried.has(credential)) continue;
        tried.add(credential);
        try {
            return await task(credential);
        } catch (err) {
            if (!isAcumaticaUnauthorized(err)) throw err;
            lastAuthError = err;
            if (attempt.user) markExpired(credential);
            console.warn(`[${label}] Acumatica rejected the ${attempt.user ? "user" : "system"} login; trying the next one.`);
        }
    }
    if (lastAuthError) throw lastAuthError;
    return null;
}

/** Prefer user session; fall back to system service account. */
export async function resolveAcumaticaCredential(request) {
    const userCred = getSessionFromRequest(request);
    if (userCred && userCred !== "__bypass__") {
        return userCred;
    }
    return getSystemAcumaticaCredential();
}
