import test from "node:test";
import assert from "node:assert/strict";
import { runSerial, getBackgroundJobStatus } from "../lib/background-jobs.js";

test("jobs run one at a time in queue order", async () => {
    const events = [];
    const job = (name, ms) => async () => {
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`end:${name}`);
        return name;
    };
    const results = await Promise.all([
        runSerial("t-a", job("a", 20), { gapMs: 0 }),
        runSerial("t-b", job("b", 5), { gapMs: 0 }),
    ]);
    assert.deepEqual(results, ["a", "b"]);
    assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
});

test("a failed job records the error and does not block the next job", async () => {
    const failed = runSerial("t-fail", async () => { throw new Error("boom"); }, { gapMs: 0 });
    const next = runSerial("t-after", async () => "ok", { gapMs: 0 });
    await assert.rejects(failed, /boom/);
    assert.equal(await next, "ok");

    const { jobs } = getBackgroundJobStatus();
    const rec = jobs.find((j) => j.name === "t-fail");
    assert.equal(rec.state, "failed");
    assert.equal(rec.failures, 1);
    assert.equal(rec.lastError, "boom");
    assert.equal(jobs.find((j) => j.name === "t-after").state, "idle");
});
