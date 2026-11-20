/**
 * Server-side Acumatica credential for BFF routes when the user session
 * cannot call Acumatica (expired OAuth token, bypass mode, etc.).
 *
 * Goal: stay logged in as long as possible — reuse the system cookie across
 * sync sections, login-limit windows, and process restarts.
 */
import fs from "fs";
import path from "path";
import { getSessionFromRequest } from "@/lib/session-store";
import { isAcumaticaUnauthorized } from "@/lib/acumatica-retry";

let cachedCredential = null;
let cachedExpiry = 0;

/** Acumatica cookie sessions often last hours; keep ours warm for the full workday. */
const CACHE_MS = 8 * 60 * 60 * 1000;
const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "acu-system-session.json");

function readPersisted() {
    try {
        if (!fs.existsSync(STORE_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
        const cookie = String(raw?.cookie || "").trim();
        const expiry = Number(raw?.expiry) || 0;
        if (!cookie || cookie === "__bypass__") return null;
        return { cookie, expiry };
    } catch {
        return null;
    }
}

function writePersisted(cookie, expiry) {
    try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
        fs.writeFileSync(
            STORE_PATH,
            JSON.stringify({ cookie, expiry, updatedAt: new Date().toISOString() }),
            "utf8"
        );
    } catch (err) {
        console.warn("[SystemAuth] Could not persist Acumatica session:", err.message);
    }
}

function hydrateFromDisk() {
    if (cachedCredential && Date.now() < cachedExpiry) return;
    const persisted = readPersisted();
    if (!persisted) return;
    cachedCredential = persisted.cookie;
    // Keep at least a warm window even if the file expiry lapsed — Acumatica
    // may still accept the cookie; 401 handling will refresh when needed.
    cachedExpiry = Math.max(persisted.expiry, Date.now() + 60 * 60 * 1000);
}

/**
 * @param {{ allowStale?: boolean }} [opts]
 * allowStale: return the last cookie even past our TTL (login-limit / keep-alive).
 */
export function getCachedSystemCredential({ allowStale = false } = {}) {
    hydrateFromDisk();
    if (!cachedCredential) return null;
    if (Date.now() < cachedExpiry) return cachedCredential;
    if (allowStale) return cachedCredential;
    return null;
}

export function rememberSystemCredential(cookie, ttlMs = CACHE_MS) {
    if (!cookie || cookie === "__bypass__") return;
    cachedCredential = cookie;
    cachedExpiry = Date.now() + ttlMs;
    writePersisted(cookie, cachedExpiry);
}

/** Extend the warm window after a successful Acumatica call. */
export function touchSystemCredential(ttlMs = CACHE_MS) {
    if (!cachedCredential) return;
    cachedExpiry = Date.now() + ttlMs;
    writePersisted(cachedCredential, cachedExpiry);
}

export function clearSystemCredential() {
    cachedCredential = null;
    cachedExpiry = 0;
    try {
        if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    } catch {
        /* ignore */
    }
}

export async function getSystemAcumaticaCredential() {
    const cached = getCachedSystemCredential();
    if (cached) return cached;
    // Prefer a stale cookie over a new login when Acumatica login slots are tight.
    const stale = getCachedSystemCredential({ allowStale: true });
    if (stale) {
        touchSystemCredential();
        return stale;
    }

    try {
        const { systemLoginForCompany } = await import("@/lib/sync-acumatica-auth");
        const { getAcumaticaCompany } = await import("@/lib/acumatica-env");
        return await systemLoginForCompany(getAcumaticaCompany());
    } catch (err) {
        console.error("[SystemAuth] Login failed:", err.message);
        return getCachedSystemCredential({ allowStale: true });
    }
}

async function refreshSystemCredential() {
    const previous = getCachedSystemCredential({ allowStale: true });
    try {
        const { systemLoginForCompany } = await import("@/lib/sync-acumatica-auth");
        const { getAcumaticaCompany } = await import("@/lib/acumatica-env");
        return await systemLoginForCompany(getAcumaticaCompany(), { forceRefresh: true });
    } catch (err) {
        // Login limit / transient failure — keep the previous session alive.
        if (previous) {
            console.warn("[SystemAuth] Refresh failed; keeping previous Acumatica session:", err.message);
            touchSystemCredential();
            return previous;
        }
        throw err;
    }
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
            const result = await task(credential);
            if (!attempt.user) touchSystemCredential();
            return result;
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
