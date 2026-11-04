import test from "node:test";
import assert from "node:assert/strict";
import {
    MAX_BUSY_WAIT_MS,
    busyRetryDelayMs,
    isAcumaticaBusy,
    isAcumaticaUnauthorized,
} from "../lib/acumatica-retry.js";

test("Retry-After in seconds is honored and capped", () => {
    assert.equal(busyRetryDelayMs("5", 1), 5000);
    assert.equal(busyRetryDelayMs("0", 3), 0);
    assert.equal(busyRetryDelayMs("120", 1), MAX_BUSY_WAIT_MS);
});

test("Retry-After as an HTTP date waits until that time", () => {
    const now = Date.parse("2026-11-03T05:00:00Z");
    assert.equal(busyRetryDelayMs("Tue, 03 Nov 2026 05:00:07 GMT", 1, now), 7000);
    assert.equal(busyRetryDelayMs("Tue, 03 Nov 2026 04:59:00 GMT", 1, now), 0);
});

test("without Retry-After the wait doubles per attempt up to the cap", () => {
    assert.equal(busyRetryDelayMs(null, 1), 2000);
    assert.equal(busyRetryDelayMs("", 2), 4000);
    assert.equal(busyRetryDelayMs(undefined, 3), 8000);
    assert.equal(busyRetryDelayMs("not a date", 10), MAX_BUSY_WAIT_MS);
});

test("error helpers tell expired logins from busy responses", () => {
    assert.equal(isAcumaticaUnauthorized(new Error("Unauthorized")), true);
    assert.equal(isAcumaticaUnauthorized(new Error("HTTP 401 Unauthorized access to X")), false);
    assert.equal(isAcumaticaBusy(new Error("HTTP 429 Too Many Requests (from https://x)")), true);
    assert.equal(isAcumaticaBusy(new Error("Unauthorized")), false);
});
