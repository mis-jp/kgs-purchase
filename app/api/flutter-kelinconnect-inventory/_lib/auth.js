import crypto from "node:crypto";
import { HttpError } from "./errors.js";

/**
 * KelinConnect sign-in for the Inventory module.
 *
 * The Flutter app sends the KelinConnect session JWT as `Authorization: Bearer <jwt>`.
 * The token is accepted when either:
 *   1. `KC_JWT_SECRET` is set and the HS256 signature verifies locally, or
 *   2. KelinConnect itself accepts the token on a read-only endpoint
 *      (`KC_AUTH_VERIFY_URLS`, comma separated; defaults below).
 * Remote results are cached per token for a few minutes.
 *
 * Every verified KelinConnect user may read all branches; counts are attributed
 * to the login id inside the token, KelinConnect's verify reply, or `session-from-ci`
 * for the app's HRIS session (`X-KC-CI-Session`).
 */

const KC_ORIGIN = (process.env.KC_ORIGIN || "http://190.92.233.232").replace(/\/+$/, "");
const DEFAULT_VERIFY_PATHS = [
    "/api/auth/session",
    "/api/payroll/me/deductions?page=1&limit=1",
];
const VERIFY_TTL_MS = 5 * 60_000;
/** A reply without an employee id is often a brief HRIS hiccup; retry soon instead of showing View only for minutes. */
const MISSING_ID_TTL_MS = 20_000;
const VERIFY_TIMEOUT_MS = 8_000;
/** Upper bound for remembering a token's employee id when the token has no `exp`. */
const KNOWN_ID_MAX_MS = 12 * 60 * 60_000;
const cacheKey = "__kcInventoryTokenCache";
const knownKey = "__kcInventoryKnownIds";

function tokenCache() {
    if (!globalThis[cacheKey]) globalThis[cacheKey] = new Map();
    return globalThis[cacheKey];
}

/** Employee id already matched to a token; a token never changes owner, so lookups that later come back empty reuse it. */
function knownIds() {
    if (!globalThis[knownKey]) globalThis[knownKey] = new Map();
    return globalThis[knownKey];
}

function verifyUrls() {
    const raw = String(process.env.KC_AUTH_VERIFY_URLS || "").trim();
    const list = raw
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : DEFAULT_VERIFY_PATHS;
    return list.map((u) => (/^https?:\/\//i.test(u) ? u : `${KC_ORIGIN}${u.startsWith("/") ? "" : "/"}${u}`));
}

function base64UrlDecode(part) {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
}

export function decodeJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
        const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
        if (!payload || typeof payload !== "object") return null;
        return { header, payload, parts };
    } catch {
        return null;
    }
}

function verifyHs256(decoded, secret) {
    if (String(decoded.header?.alg || "").toUpperCase() !== "HS256") return false;
    const expected = crypto
        .createHmac("sha256", secret)
        .update(`${decoded.parts[0]}.${decoded.parts[1]}`)
        .digest();
    const given = base64UrlDecode(decoded.parts[2]);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Asks KelinConnect whether the token is valid. Returns `null` when rejected, otherwise
 * `{ loginId, name }` from the first reply that names the employee (empty when none does).
 * Later URLs are only tried for the identity once the token is accepted.
 */
async function kelinConnectAccepts(token) {
    let accepted = null;
    for (const url of verifyUrls()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                    Cookie: `session_token=${token}`,
                },
                redirect: "manual",
                cache: "no-store",
                signal: controller.signal,
            });
            if (res.status === 401 || res.status === 403) {
                if (!accepted) return null;
                continue;
            }
            if (res.ok) {
                const body = await res.json().catch(() => null);
                if (body && (body.authenticated === false || body.success === false)) continue;
                const identity = identityFrom(body);
                if (identity.loginId) return { loginId: identity.loginId, name: identity.name || accepted?.name || "" };
                accepted = { loginId: "", name: accepted?.name || identity.name };
            }
        } catch (err) {
            console.warn("[KC Inventory auth] verify failed", url, err?.message || err);
        } finally {
            clearTimeout(timer);
        }
    }
    return accepted;
}

const LOGIN_ID_KEYS = [
    "loginid", "loginId", "LOGINID", "login_id", "employeeId", "employee_id",
    "workcode", "WORKCODE", "username",
];
const NAME_KEYS = ["name", "fullName", "full_name", "fullname", "FULLNAME", "displayName", "employeeName"];

/** Objects in a KelinConnect reply that may describe the signed-in employee. */
function replySources(body) {
    const out = [];
    const add = (value) => {
        const obj = Array.isArray(value) ? value[0] : value;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    };
    add(body);
    for (const key of ["user", "employee", "profile", "session", "data", "items", "rows", "deductions"]) {
        add(body[key]);
    }
    const data = Array.isArray(body.data) ? body.data[0] : body.data;
    if (data && typeof data === "object") {
        for (const key of ["user", "employee", "profile"]) add(data[key]);
    }
    if (body.session && typeof body.session === "object") add(body.session.user);
    return out;
}

function identityFrom(body) {
    if (!body || typeof body !== "object") return { loginId: "", name: "" };
    let loginId = "";
    let name = "";
    for (const src of replySources(body)) {
        loginId ||= pickClaim(src, LOGIN_ID_KEYS);
        name ||= pickClaim(src, NAME_KEYS);
        if (loginId && name) break;
    }
    return { loginId, name };
}

function pickClaim(payload, keys) {
    const sources = [payload, payload.user, payload.data, payload.data?.user, payload.session?.user]
        .filter((s) => s && typeof s === "object");
    for (const src of sources) {
        for (const key of keys) {
            const value = src[key];
            if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
        }
    }
    return "";
}

/**
 * Employee id from the app's HRIS session (`X-KC-CI-Session`), confirmed by KelinConnect's
 * `/api/auth/session-from-ci`. Only accepted when KelinConnect's user for that session is the same
 * account as the bearer token (`userId` / `sub`), so a session can't vouch for someone else's token.
 */
async function employeeFromCiSession(request, payload) {
    const ciSession = String(request.headers.get("x-kc-ci-session") || "").trim();
    if (!/^[A-Za-z0-9,-]{16,128}$/.test(ciSession)) return null;
    const tokenUserId = pickClaim(payload, ["userId", "userid", "sub"]);
    if (!tokenUserId) return null;

    const url = String(process.env.KC_CI_SESSION_URL || "").trim() || `${KC_ORIGIN}/api/auth/session-from-ci`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Cookie: `ci_session=${ciSession}`,
            },
            body: "{}",
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        const user = body?.user || body?.data?.user;
        if (!user || typeof user !== "object" || String(user.id || "") !== tokenUserId) return null;
        const loginId = pickClaim(user, ["employee_id", "employeeId", "loginid", "LOGINID", "workcode"]).toUpperCase();
        if (!/^[A-Z0-9_-]{2,32}$/.test(loginId)) return null;
        return { loginId, name: pickClaim(user, NAME_KEYS) };
    } catch (err) {
        console.warn("[KC Inventory auth] session-from-ci failed", err?.message || err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Employee id the app read at sign-in (`X-KC-Login-Id`). Only consulted after the token itself
 * was verified and names no employee, and only when KC_TRUST_APP_LOGIN_ID=1: the header is
 * client-supplied, so any signed-in employee could otherwise claim another employee's id.
 */
function appLoginId(request) {
    if (String(process.env.KC_TRUST_APP_LOGIN_ID ?? "").trim() !== "1") return "";
    const value = String(request.headers.get("x-kc-login-id") || "").trim().toUpperCase();
    return /^[A-Z0-9_-]{2,32}$/.test(value) ? value : "";
}

/**
 * Login id (employee id such as KG0751): token claims, then KelinConnect's verify reply, then the
 * app's sign-in id. `sub` / `id` are only a last resort: KelinConnect uses UUIDs there.
 */
function userFromPayload(payload, request, verified) {
    const loginId = pickClaim(payload, LOGIN_ID_KEYS) || verified?.loginId || appLoginId(request)
        || pickClaim(payload, ["sub", "id"]);
    const tokenName = pickClaim(payload, NAME_KEYS) || verified?.name || "";
    const headerName = String(request.headers.get("x-kc-user-name") || "").trim().slice(0, 120);
    return {
        loginId: loginId || "unknown",
        name: tokenName || headerName || loginId || "KelinConnect user",
    };
}

/** Resolve the signed-in KelinConnect user from `Authorization: Bearer <jwt>`. */
export async function requireInventoryUser(request) {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "Please sign in to KelinConnect again.");

    const decoded = decodeJwt(token);
    if (!decoded) throw new HttpError(401, "Your KelinConnect session is not valid. Please sign in again.");

    const exp = Number(decoded.payload.exp);
    if (Number.isFinite(exp) && exp * 1000 < Date.now()) {
        throw new HttpError(401, "Your KelinConnect session has expired. Please sign in again.");
    }

    const secret = String(process.env.KC_JWT_SECRET || "").trim();
    const signed = secret ? verifyHs256(decoded, secret) : false;
    if (secret && !signed) {
        throw new HttpError(401, "Your KelinConnect session is not valid. Please sign in again.");
    }
    let verified = null;
    if (!signed || !pickClaim(decoded.payload, LOGIN_ID_KEYS)) {
        const cache = tokenCache();
        const key = crypto.createHash("sha256").update(token).digest("hex");
        const hit = cache.get(key);
        if (hit && hit.until >= Date.now()) {
            verified = hit.identity;
        } else {
            verified = await kelinConnectAccepts(token);
            if (!verified && !signed) {
                cache.delete(key);
                throw new HttpError(401, "Your KelinConnect session has expired. Please sign in again.");
            }
            if (!verified?.loginId) {
                const fromCi = await employeeFromCiSession(request, decoded.payload);
                if (fromCi) verified = { loginId: fromCi.loginId, name: fromCi.name || verified?.name || "" };
            }
            const known = knownIds();
            if (verified?.loginId) {
                if (known.size > 2000) known.clear();
                const until = Number.isFinite(exp) ? exp * 1000 : Date.now() + KNOWN_ID_MAX_MS;
                known.set(key, { until, loginId: verified.loginId, name: verified.name || "" });
            } else {
                const prior = known.get(key);
                if (prior && prior.until >= Date.now()) {
                    verified = { loginId: prior.loginId, name: verified?.name || prior.name };
                } else if (prior) {
                    known.delete(key);
                }
            }
            if (cache.size > 2000) cache.clear();
            if (verified) {
                const ttl = verified.loginId ? VERIFY_TTL_MS : MISSING_ID_TTL_MS;
                cache.set(key, { until: Date.now() + ttl, identity: verified });
            }
        }
    }

    return { user: userFromPayload(decoded.payload, request, verified) };
}

export function publicUser(ctx) {
    return { loginId: ctx.user.loginId, name: ctx.user.name, allBranches: true };
}
