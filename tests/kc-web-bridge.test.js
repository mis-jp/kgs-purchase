import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
    canonicalPath,
    rememberNonce,
    resetNonceStore,
    secretFingerprint,
    signCanonical,
    verifyBridgeRequest,
} from "../app/api/kc-web-inventory/_lib/bridge-auth.js";

const SECRET = "test-bridge-secret";
const NOW = 1_700_000_000;
const NONCE = "ab".repeat(16);

function client(overrides = {}) {
    return {
        client_id: "kc-web",
        status: "active",
        secret_sha256: secretFingerprint(SECRET),
        allowed_ips: null,
        identity_mode: "employee_id",
        ...overrides,
    };
}

function headers({
    employee = "KG0751",
    body = "",
    secret = SECRET,
    timestamp = String(NOW),
    nonce = NONCE,
    pathWithQuery = "/me",
    method = "GET",
} = {}) {
    return {
        "x-inv-client": "kc-web",
        "x-inv-employee": employee,
        "x-inv-name": "Joyce",
        "x-inv-timestamp": timestamp,
        "x-inv-nonce": nonce,
        "x-inv-signature": signCanonical({
            method,
            pathWithQuery,
            timestamp,
            nonce,
            clientId: "kc-web",
            employeeId: employee,
            rawBody: body,
            secret,
        }),
    };
}

function verify(overrides = {}) {
    const body = overrides.rawBody ?? "";
    const pathWithQuery = overrides.pathWithQuery ?? "/me";
    const method = overrides.method ?? "GET";
    const store = overrides.nonceStore || new Map();
    return verifyBridgeRequest({
        method,
        pathWithQuery,
        rawBody: body,
        headers: overrides.headers || headers({ body, pathWithQuery, method, ...overrides.signed }),
        nowSec: overrides.nowSec ?? NOW,
        client: overrides.client === undefined ? client() : overrides.client,
        link: overrides.link ?? null,
        remoteIp: overrides.remoteIp ?? "127.0.0.1",
        secrets: overrides.secrets ?? [SECRET],
        nonceStore: store,
        pilotAllowed: overrides.pilotAllowed === undefined ? new Set(["KG0751"]) : overrides.pilotAllowed,
    });
}

test("canonical path sorts query keys and encodes segments", () => {
    const search = new URLSearchParams("b=2&a=1");
    assert.equal(canonicalPath(["items", "SKU 1"], search), "/items/SKU%201?a=1&b=2");
    assert.equal(canonicalPath(["me"], new URLSearchParams()), "/me");
});

test("valid signature", () => {
    const bodyHash = crypto.createHash("sha256").update("").digest("hex");
    const canonical = ["GET", "/me", String(NOW), NONCE, "kc-web", "KG0751", bodyHash].join("\n");
    const expected = crypto.createHmac("sha256", SECRET).update(canonical).digest("hex");
    assert.equal(headers()["x-inv-signature"], expected);
    const result = verify();
    assert.equal(result.ok, true);
    assert.equal(result.user.loginId, "KG0751");
    assert.equal(result.user.name, "Joyce");
});

test("accepts either env secret during rotation when the fingerprint matches one of them", () => {
    const next = "next-bridge-secret";
    const result = verify({
        client: client({ secret_sha256: secretFingerprint(next) }),
        secrets: [SECRET, next],
        signed: { secret: SECRET },
    });
    assert.equal(result.ok, true);
});

test("wrong secret", () => {
    const result = verify({ signed: { secret: "other-secret" } });
    assert.deepEqual(result, { ok: false, status: 401, message: "Inventory bridge not configured" });
});

test("old timestamp", () => {
    const result = verify({ signed: { timestamp: String(NOW - 61) } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    const edge = verify({ signed: { timestamp: String(NOW - 60) }, nonceStore: new Map() });
    assert.equal(edge.ok, true);
});

test("reused nonce", () => {
    const store = new Map();
    assert.equal(verify({ nonceStore: store }).ok, true);
    const again = verify({ nonceStore: store });
    assert.equal(again.ok, false);
    assert.equal(again.status, 401);
});

test("body tampering", () => {
    const signedBody = '{"qty":1}';
    const result = verify({
        method: "POST",
        pathWithQuery: "/stock/receive",
        rawBody: '{"qty":2}',
        signed: { body: signedBody, method: "POST", pathWithQuery: "/stock/receive" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test("disabled client", () => {
    const result = verify({ client: client({ status: "disabled" }) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test("IP not allowed", () => {
    const result = verify({
        client: client({ allowed_ips: "127.0.0.1,190.92.233.232" }),
        remoteIp: "8.8.8.8",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    const allowed = verify({
        client: client({ allowed_ips: "127.0.0.1,190.92.233.232" }),
        remoteIp: "190.92.233.232",
        nonceStore: new Map(),
    });
    assert.equal(allowed.ok, true);
});

test("employee not in the pilot list", () => {
    const result = verify({
        signed: { employee: "KG9999" },
        pilotAllowed: new Set(["KG0751", "KG0089"]),
    });
    assert.deepEqual(result, { ok: false, status: 403, message: "Inventory is not open to your account yet." });
});

test("linked identity mapping", () => {
    const result = verify({
        client: client({ identity_mode: "linked" }),
        signed: { employee: "JDOE" },
        link: { login_id: "kg0751", status: "active" },
        pilotAllowed: new Set(["KG0751"]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.user.loginId, "KG0751");
});

test("rememberNonce drops expired entries and rejects a live one", () => {
    const store = new Map();
    resetNonceStore(store);
    assert.equal(rememberNonce("aa".repeat(16), 1_000, store), true);
    assert.equal(rememberNonce("aa".repeat(16), 1_000, store), false);
    assert.equal(rememberNonce("aa".repeat(16), 1_000 + 120_000, store), true);
});
