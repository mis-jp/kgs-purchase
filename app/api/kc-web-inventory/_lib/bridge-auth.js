import crypto from "node:crypto";

const NONCE_TTL_MS = 120_000;
const MAX_NONCES = 5000;
const nonces = new Map();
const lastUsed = new Map();

const DEFAULT_ALLOWED_LOGIN_IDS = "KG0751,KG0089,KG0452,KG0543,KG0882";
const BRIDGE_MESSAGE = "Inventory bridge not configured";
const PILOT_MESSAGE = "Inventory is not open to your account yet.";

export function resetNonceStore(store = nonces) {
    store.clear();
}

/** `/path?a=1&b=2` with query keys sorted. Must match the KelinConnect sender. */
export function canonicalPath(path, searchParams) {
    const segments = Array.isArray(path) ? path : [];
    const p = "/" + segments.map((segment) => encodeURIComponent(segment)).join("/");
    const sorted = new URLSearchParams(
        [...searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    ).toString();
    return sorted ? `${p}?${sorted}` : p;
}

export function bodySha256(raw) {
    return crypto.createHash("sha256").update(raw || "").digest("hex");
}

export function signCanonical({ method, pathWithQuery, timestamp, nonce, clientId, employeeId, rawBody, secret }) {
    const canonical = [
        String(method || "").toUpperCase(),
        pathWithQuery,
        String(timestamp),
        nonce,
        clientId,
        employeeId,
        bodySha256(rawBody),
    ].join("\n");
    return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

function timingEqual(a, b) {
    const left = Buffer.from(String(a ?? ""), "utf8");
    const right = Buffer.from(String(b ?? ""), "utf8");
    const sameHash = crypto.timingSafeEqual(
        crypto.createHash("sha256").update(left).digest(),
        crypto.createHash("sha256").update(right).digest()
    );
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right) && sameHash;
}

export function rememberNonce(nonce, nowMs, store = nonces) {
    for (const [key, exp] of store) {
        if (exp <= nowMs) store.delete(key);
    }
    if (store.size >= MAX_NONCES) store.clear();
    const exp = store.get(nonce);
    if (exp && exp > nowMs) return false;
    store.set(nonce, nowMs + NONCE_TTL_MS);
    return true;
}

export function secretFingerprint(secret) {
    return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

export function secretMatches(secretSha256, secrets) {
    const expected = String(secretSha256 || "").toLowerCase();
    return secrets.some((secret) => timingEqual(secretFingerprint(secret), expected));
}

export function ipAllowed(allowedIps, ip) {
    if (allowedIps == null || String(allowedIps).trim() === "") return true;
    const list = String(allowedIps).split(",").map((part) => part.trim()).filter(Boolean);
    if (!list.length) return true;
    return list.includes(ip);
}

export function bridgeSecrets() {
    return [process.env.INV_WEB_BRIDGE_SECRET, process.env.INV_WEB_BRIDGE_SECRET_NEXT].filter(Boolean);
}

function headerValue(headers, name) {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || "";
    return headers[name] || headers[name.toLowerCase()] || "";
}

function pilotSet(pilotAllowed) {
    if (pilotAllowed === null) return null;
    if (pilotAllowed instanceof Set) return pilotAllowed;
    return new Set(DEFAULT_ALLOWED_LOGIN_IDS.split(","));
}

/**
 * Signature and identity checks from the bridge spec.
 * `client` and `link` are already loaded. This function does not touch MySQL.
 * `pilotAllowed`: a Set of login ids, or null when everyone is allowed.
 */
export function verifyBridgeRequest({
    method,
    pathWithQuery,
    rawBody,
    headers,
    nowSec,
    client,
    link = null,
    remoteIp = "",
    secrets,
    nonceStore = nonces,
    pilotAllowed,
}) {
    if (!client || client.status !== "active") {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: client ? "client-disabled" : "client-missing" };
    }
    const secretList = Array.isArray(secrets) ? secrets.filter(Boolean) : [];
    if (!secretList.length || !secretMatches(client.secret_sha256, secretList)) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: secretList.length ? "secret-mismatch" : "secret-missing" };
    }
    if (!ipAllowed(client.allowed_ips, remoteIp)) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "ip-denied" };
    }

    const timestamp = headerValue(headers, "x-inv-timestamp");
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 60) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "timestamp" };
    }

    const nonce = headerValue(headers, "x-inv-nonce");
    if (!/^[a-f0-9]{32,}$/i.test(nonce)) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "nonce" };
    }
    if (!rememberNonce(nonce, nowSec * 1000, nonceStore)) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "nonce-reused" };
    }

    const clientId = headerValue(headers, "x-inv-client");
    const employeeHeader = String(headerValue(headers, "x-inv-employee") || "").trim().toUpperCase();
    if (!clientId || clientId !== client.client_id || !/^[A-Z0-9_-]{2,32}$/.test(employeeHeader)) {
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "employee-id" };
    }

    const presented = headerValue(headers, "x-inv-signature");
    const signed = secretList.some((secret) => timingEqual(
        signCanonical({
            method,
            pathWithQuery,
            timestamp,
            nonce,
            clientId,
            employeeId: employeeHeader,
            rawBody,
            secret,
        }),
        presented
    ));
    if (!signed) return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: "signature" };

    let loginId = employeeHeader;
    if (client.identity_mode === "linked") {
        if (!link || link.status !== "active") {
            return { ok: false, status: 403, message: PILOT_MESSAGE };
        }
        loginId = String(link.login_id || "").trim().toUpperCase();
        if (!/^[A-Z0-9_-]{2,32}$/.test(loginId)) {
            return { ok: false, status: 401, message: BRIDGE_MESSAGE };
        }
    }

    const allowed = pilotSet(pilotAllowed);
    if (allowed && !allowed.has(loginId)) {
        return { ok: false, status: 403, message: PILOT_MESSAGE };
    }

    const name = String(headerValue(headers, "x-inv-name") || "").slice(0, 120);
    return { ok: true, user: { loginId, name: name || loginId } };
}

function normalizeIp(value) {
    const ip = String(value || "").trim().replace(/^::ffff:/i, "");
    if (ip === "::1" || ip === "localhost") return "127.0.0.1";
    return ip;
}

export function callerIp(request) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
        const first = normalizeIp(forwarded.split(",")[0]);
        if (first) return first;
    }
    const real = request.headers.get("x-real-ip");
    if (real && real.trim()) return normalizeIp(real);
    if (request.ip) return normalizeIp(request.ip);
    try {
        const host = new URL(request.url).hostname;
        if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "127.0.0.1";
    } catch {
        /* ignore malformed URLs */
    }
    return "";
}

async function touchLastUsed(pool, clientId) {
    const now = Date.now();
    const prev = lastUsed.get(clientId) || 0;
    if (now - prev < 60_000) return;
    lastUsed.set(clientId, now);
    try {
        await pool.query(
            "UPDATE inv_web_clients SET last_used_at = UTC_TIMESTAMP() WHERE client_id = ?",
            [clientId]
        );
    } catch {
        /* a clock update must not fail a signed request */
    }
}

/** Verify one incoming bridge call. Loads `inv_web_clients` and, for linked mode, the identity row. */
export async function authenticateBridge(request, rawBody, pathWithQuery) {
    const clientId = String(request.headers.get("x-inv-client") || "");
    try {
        const { getLedgerPool } = await import("../../flutter-kelinconnect-inventory/_lib/ledger-db.js");
        const { allowedLoginIds } = await import("../../flutter-kelinconnect-inventory/_lib/auth.js");
        const pool = getLedgerPool();
        const [rows] = await pool.query(
            `SELECT client_id, status, secret_sha256, allowed_ips, identity_mode
               FROM inv_web_clients WHERE client_id = ? LIMIT 1`,
            [clientId]
        );
        const client = rows[0] || null;
        let link = null;
        if (client && client.identity_mode === "linked") {
            const external = String(request.headers.get("x-inv-employee") || "").trim().toUpperCase();
            const [links] = await pool.query(
                `SELECT login_id, status FROM inv_web_identity_links
                  WHERE client_id = ? AND external_user = ? LIMIT 1`,
                [client.client_id, external]
            );
            link = links[0] || null;
        }
        const result = verifyBridgeRequest({
            method: request.method,
            pathWithQuery,
            rawBody,
            headers: request.headers,
            nowSec: Math.floor(Date.now() / 1000),
            client,
            link,
            remoteIp: callerIp(request),
            secrets: bridgeSecrets(),
            nonceStore: nonces,
            pilotAllowed: allowedLoginIds(),
        });
        if (result.ok && client) await touchLastUsed(pool, client.client_id);
        if (!result.ok) {
            console.error(
                "[kc-web-inventory] rejected",
                result.reason || "unknown",
                "path=" + pathWithQuery,
                "ip=" + callerIp(request),
                "secrets=" + bridgeSecrets().length,
                "client=" + (client ? client.status : "none")
            );
        }
        return result;
    } catch (err) {
        const code = err && (err.code || err.message) || "error";
        console.error("[kc-web-inventory] bridge auth failed", code);
        return { ok: false, status: 401, message: BRIDGE_MESSAGE, reason: code };
    }
}
