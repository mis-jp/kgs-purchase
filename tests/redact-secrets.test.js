import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/redact-secrets.js";
import { summarizeSyncLogs } from "../lib/sync-status.js";

test("redactSecrets masks session cookies, tokens and passwords", () => {
    const out = redactSecrets(
        "Login failed: ASP.NET_SessionId=abc123def; .ASPXAUTH=XYZ987 password=Hunter2 Authorization: Bearer eyJabc.def.ghi"
    );
    assert.ok(!out.includes("abc123def"));
    assert.ok(!out.includes("XYZ987"));
    assert.ok(!out.includes("Hunter2"));
    assert.ok(!out.includes("eyJabc"));
    assert.match(out, /ASP\.NET_SessionId=\[hidden\]/);
    assert.match(out, /password=\[hidden\]/);
});

test("redactSecrets masks JSON secrets, JWTs and URL credentials", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const out = redactSecrets(`{"access_token": "tok_live_123456", "note": "${jwt}"} at https://admin:s3cret@erp.example.com/api`);
    assert.ok(!out.includes("tok_live_123456"));
    assert.ok(!out.includes(jwt));
    assert.ok(!out.includes("s3cret"));
    assert.match(out, /https:\/\/\[hidden\]@erp\.example\.com/);
});

test("redactSecrets leaves ordinary error text alone", () => {
    const msg = "HTTP 429 Too Many Requests (from https://erp.example.com/entity/Default/20.200.001/PurchaseOrder)";
    assert.equal(redactSecrets(msg), msg);
    assert.equal(redactSecrets("Unauthorized"), "Unauthorized");
    assert.equal(redactSecrets(null), null);
});

test("summarizeSyncLogs hides secrets in the last error shown to admins", () => {
    const [entry] = summarizeSyncLogs([
        { timestamp: "2026-11-06T01:00:00Z", section: "Inventory", status: "error", message: "Cookie: ASP.NET_SessionId=leaky; failed" },
    ]);
    assert.ok(!entry.lastError.includes("leaky"));
});
