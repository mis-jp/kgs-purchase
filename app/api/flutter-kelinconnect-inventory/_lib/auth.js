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
 * to the login id inside the token.
 */

const KC_ORIGIN = (process.env.KC_ORIGIN || "http://190.92.233.232").replace(/\/+$/, "");
const DEFAULT_VERIFY_PATHS = [
    "/api/auth/session",
    "/api/payroll/me/deductions?page=1&limit=1",
];
const VERIFY_TTL_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 8_000;
const cacheKey = "__kcInventoryTokenCache";

function tokenCache() {
    if (!globalThis[cacheKey]) globalThis[cacheKey] = new Map();
    return globalThis[cacheKey];
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

async function kelinConnectAccepts(token) {
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
            if (res.status === 401 || res.status === 403) return false;
            if (res.ok) {
                const body = await res.json().catch(() => null);
                if (body && (body.authenticated === false || body.success === false)) continue;
                return true;
            }
        } catch (err) {
            console.warn("[KC Inventory auth] verify failed", url, err?.message || err);
        } finally {
            clearTimeout(timer);
        }
    }
    return false;
}

function pickClaim(payload, keys) {
    const sources = [payload, payload.user, payload.data].filter((s) => s && typeof s === "object");
    for (const src of sources) {
        for (const key of keys) {
            const value = src[key];
            if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
        }
    }
    return "";
}

function userFromPayload(payload, request) {
    const loginId = pickClaim(payload, [
        "loginid", "loginId", "LOGINID", "login_id", "employeeId", "employee_id",
        "workcode", "WORKCODE", "username", "sub", "id",
    ]);
    const tokenName = pickClaim(payload, [
        "name", "fullName", "full_name", "fullname", "FULLNAME", "displayName", "employeeName",
    ]);
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
    if (secret) {
        if (!verifyHs256(decoded, secret)) {
            throw new HttpError(401, "Your KelinConnect session is not valid. Please sign in again.");
        }
    } else {
        const cache = tokenCache();
        const key = crypto.createHash("sha256").update(token).digest("hex");
        const hit = cache.get(key);
        if (!hit || hit.until < Date.now()) {
            const accepted = await kelinConnectAccepts(token);
            if (!accepted) {
                cache.delete(key);
                throw new HttpError(401, "Your KelinConnect session has expired. Please sign in again.");
            }
            if (cache.size > 2000) cache.clear();
            cache.set(key, { until: Date.now() + VERIFY_TTL_MS });
        }
    }

    return { user: userFromPayload(decoded.payload, request) };
}

export function publicUser(ctx) {
    return { loginId: ctx.user.loginId, name: ctx.user.name, allBranches: true };
}
