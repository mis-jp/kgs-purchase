/**
 * Server-side in-memory session store.
 * Local app cookie identifies the store entry; local sessions are also persisted
 * in MySQL so they survive restarts and only end on explicit logout.
 */
import { COMPANIES, isValidCompanyId } from "@/lib/companies";

/** Browser cookie lifetime (~10 years). Server store does not auto-expire before logout. */
export const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365 * 10;

const store = globalThis.__acu_session_store__ ?? (globalThis.__acu_session_store__ = new Map());

function credentialFromEntry(entry) {
    if (!entry) return null;
    if (entry.isBypass) return "__bypass__";
    if (entry.isTokenAuth && entry.token) return `__bearer__${entry.token}`;
    const cookieString = (entry.cookies || []).map((c) => c.split(";")[0]).join("; ");
    return cookieString || null;
}

function normalizeCompanyEntry(entry) {
    if (!entry) return null;
    return {
        token: entry.token || null,
        refreshToken: entry.refreshToken || null,
        cookies: entry.cookies || [],
        isTokenAuth: !!entry.isTokenAuth,
        isBypass: !!entry.isBypass,
        expiresAt: null,
    };
}

export function setSession(sessionId, cookies, companyId = "main") {
    const existing = store.get(sessionId) || { companies: {}, activeCompanyId: "main" };
    existing.companies[companyId] = {
        cookies,
        expiresAt: null,
    };
    existing.activeCompanyId = companyId;
    existing.expiresAt = null;
    store.set(sessionId, existing);
}

export function setTokenSession(sessionId, tokenData, cookies = [], companyId = "main") {
    const existing = store.get(sessionId) || { companies: {}, activeCompanyId: "main" };
    existing.companies[companyId] = {
        token: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: null,
        acumaticaTokenExpiresAt: tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : null,
        isTokenAuth: true,
        cookies: cookies || [],
    };
    existing.activeCompanyId = companyId;
    existing.expiresAt = null;
    store.set(sessionId, existing);
}

export function setBypassSession(sessionId) {
    const existing = store.get(sessionId) || { companies: {}, activeCompanyId: "main" };
    for (const c of COMPANIES) {
        existing.companies[c.id] = {
            isBypass: true,
            expiresAt: null,
            cookies: [],
        };
    }
    existing.activeCompanyId = "main";
    existing.expiresAt = null;
    store.set(sessionId, existing);
}

export function initMultiCompanySession(sessionId, { activeCompanyId = "main" } = {}) {
    store.set(sessionId, {
        companies: {},
        activeCompanyId: isValidCompanyId(activeCompanyId) ? activeCompanyId : "main",
        expiresAt: null,
        loginUsername: null,
        loginPassword: null,
        ecommerceAcumaticaCompany: null,
        companyErrors: {},
    });
}

export function setLoginCredentials(sessionId, username, password) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return;
    entry.loginUsername = username;
    entry.loginPassword = password;
    store.set(sessionId, entry);
}

/** Attach a local app user (admin/user) to the session. */
export function setLocalUserSession(sessionId, user) {
    const entry = getSessionMeta(sessionId) || {
        companies: {},
        activeCompanyId: "main",
        expiresAt: null,
    };
    entry.localUser = {
        id: Number(user.id),
        username: user.username,
        role: user.role === "admin" ? "admin" : "user",
        fullName: user.fullName || user.full_name || "",
        email: user.email || "",
        branchIds: Array.isArray(user.branchIds) ? user.branchIds : [],
        allBranches: user.role === "admin" || user.allBranches === true,
        allowedModules: user.role === "admin"
            ? []
            : (Array.isArray(user.allowedModules) ? user.allowedModules : []),
    };
    entry.authType = "local";
    store.set(sessionId, entry);
}

/**
 * Refresh the cached profile (role, modules, branches) on every live session of
 * one user after an admin edit commits, so page-level module checks in proxy.js
 * use the new permissions without waiting for that user to sign in again.
 * Returns how many sessions were updated.
 */
export function refreshLocalUserSessions(userId, user) {
    const id = Number(userId);
    if (!Number.isFinite(id) || !user) return 0;
    let updated = 0;
    for (const [sessionId, entry] of store) {
        if (Number(entry?.localUser?.id) === id) {
            setLocalUserSession(sessionId, user);
            updated += 1;
        }
    }
    return updated;
}

export function getLocalUserSession(sessionId) {
    return getSessionMeta(sessionId)?.localUser || null;
}

export function clearLocalUserSession(sessionId) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return;
    delete entry.localUser;
    if (entry.authType === "local") delete entry.authType;
    store.set(sessionId, entry);
}

export function getLoginCredentials(sessionId) {
    const entry = getSessionMeta(sessionId);
    if (!entry?.loginUsername || !entry?.loginPassword) return null;
    return { username: entry.loginUsername, password: entry.loginPassword };
}

export function setDiscoveredEcomCompany(sessionId, acumaticaCompanyId) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return;
    entry.ecommerceAcumaticaCompany = acumaticaCompanyId;
    store.set(sessionId, entry);
}

export function getDiscoveredEcomCompany(sessionId) {
    return getSessionMeta(sessionId)?.ecommerceAcumaticaCompany || null;
}

export function setCompanyError(sessionId, companyId, message) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return;
    entry.companyErrors = entry.companyErrors || {};
    if (message) entry.companyErrors[companyId] = message;
    else delete entry.companyErrors[companyId];
    store.set(sessionId, entry);
}

export function getCompanyErrors(sessionId) {
    return getSessionMeta(sessionId)?.companyErrors || {};
}

/** Ecommerce shares the main Acumatica session — stock is split by branch in MySQL. */
export function linkVirtualEcommerceCompany(sessionId) {
    const entry = getSessionMeta(sessionId);
    if (!entry?.companies?.main) return false;
    entry.companies.ecommerce = {
        ...entry.companies.main,
        virtual: true,
    };
    entry.virtualCompanies = { ...(entry.virtualCompanies || {}), ecommerce: true };
    store.set(sessionId, entry);
    return true;
}

export function isVirtualCompanySession(sessionId, companyId) {
    const entry = getSessionMeta(sessionId);
    return !!entry?.virtualCompanies?.[companyId] || !!entry?.companies?.[companyId]?.virtual;
}

export function getSessionMeta(sessionId) {
    if (!sessionId) return null;
    const entry = store.get(sessionId);
    if (!entry) return null;
    return entry;
}

export function getActiveCompanyId(sessionId) {
    const entry = getSessionMeta(sessionId);
    return entry?.activeCompanyId || "main";
}

export function setActiveCompany(sessionId, companyId) {
    if (!isValidCompanyId(companyId)) return false;
    const entry = getSessionMeta(sessionId);
    if (!entry) return false;
    if (!entry.companies?.[companyId]) return false;
    entry.activeCompanyId = companyId;
    store.set(sessionId, entry);
    return true;
}

export function getCompanyCredential(sessionId, companyId) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return null;
    const companyEntry = entry.companies?.[companyId];
    if (!companyEntry) return null;
    return credentialFromEntry(companyEntry);
}

export function getSession(sessionId) {
    const entry = getSessionMeta(sessionId);
    if (!entry) {
        return null;
    }
    const companyId = entry.activeCompanyId || "main";
    const cred = getCompanyCredential(sessionId, companyId);
    if (!cred) {
        console.warn(`[SessionStore] No credential for company "${companyId}" in session ${sessionId}`);
        return null;
    }
    return cred;
}

export function deleteSession(sessionId) {
    store.delete(sessionId);
}

export function getSessionIdFromRequest(request) {
    const authHeader = request.headers.get("Authorization");
    let sessionId = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    if (!sessionId) {
        sessionId = request.cookies.get("acu_session")?.value;
    }
    return sessionId || null;
}

export function getSessionCookies(sessionId, companyId) {
    const entry = getSessionMeta(sessionId);
    if (!entry) return null;
    const cid = companyId || entry.activeCompanyId || "main";
    const companyEntry = entry.companies?.[cid];
    if (!companyEntry?.cookies?.length) return null;
    return companyEntry.cookies.map((c) => c.split(";")[0]).join("; ");
}

export function getPoCredentialFromRequest(request) {
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) return null;
    const cookies = getSessionCookies(sessionId);
    if (cookies) return cookies;
    return getSession(sessionId);
}

export function getSessionFromRequest(request) {
    return getSession(getSessionIdFromRequest(request));
}

export function getActiveCompanyFromRequest(request) {
    const sessionId = getSessionIdFromRequest(request);
    return getActiveCompanyId(sessionId);
}
