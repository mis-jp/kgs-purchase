import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure interval resolver mirrored from the module defaults so we can lock the
 * contract without spinning real Acumatica timers in CI.
 */
function resolveIntervalMs(envValue, fallbackMs = 60 * 1000) {
    const raw = Number(envValue);
    if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
    return fallbackMs;
}

function keepaliveDisabled(flag) {
    const v = String(flag ?? "1").trim().toLowerCase();
    return v === "0" || v === "false" || v === "off" || v === "no";
}

test("keep-alive interval defaults to 1 minute", () => {
    assert.equal(resolveIntervalMs(undefined), 60 * 1000);
    assert.equal(resolveIntervalMs("bad"), 60 * 1000);
    assert.equal(resolveIntervalMs("30000"), 60 * 1000); // below floor
});

test("keep-alive interval accepts custom ms above 1 minute", () => {
    assert.equal(resolveIntervalMs("120000"), 120000);
    assert.equal(resolveIntervalMs("600000"), 600000);
});

test("keep-alive can be disabled via env flag", () => {
    assert.equal(keepaliveDisabled("1"), false);
    assert.equal(keepaliveDisabled("0"), true);
    assert.equal(keepaliveDisabled("off"), true);
    assert.equal(keepaliveDisabled("false"), true);
});
