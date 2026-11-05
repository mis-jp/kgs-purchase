/**
 * Serial queue for background maintenance jobs (PO status align, repairs,
 * vendor backfills). Running them one at a time keeps them from contending
 * for the same MySQL row locks, which made each UPDATE slow when they overlapped.
 *
 * State lives on globalThis so every route bundle in the PM2 process shares one
 * queue and one status table.
 */
import { kickCached } from "./server-cache.js";

export const JOB_GAP_MS = 2000;
const MAX_ERROR_LENGTH = 300;

const shared =
    globalThis.__kgs_background_jobs__ ??
    (globalThis.__kgs_background_jobs__ = {
        tail: Promise.resolve(),
        pending: 0,
        jobs: new Map(),
    });

function jobRecord(name) {
    let rec = shared.jobs.get(name);
    if (!rec) {
        rec = {
            name,
            state: "idle",
            runs: 0,
            failures: 0,
            queuedAt: null,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            lastError: null,
        };
        shared.jobs.set(name, rec);
    }
    return rec;
}

function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Queue `task` behind every job already waiting. Resolves or rejects with the
 * task's own result; a failed job never blocks the jobs queued after it.
 */
export function runSerial(name, task, { gapMs = JOB_GAP_MS, now = Date.now } = {}) {
    const rec = jobRecord(name);
    rec.state = "queued";
    rec.queuedAt = now();
    shared.pending += 1;

    const run = shared.tail.then(async () => {
        await sleep(gapMs);
        rec.state = "running";
        rec.startedAt = now();
        try {
            const value = await task();
            rec.lastError = null;
            return value;
        } catch (err) {
            rec.failures += 1;
            rec.lastError = String(err?.message || err).slice(0, MAX_ERROR_LENGTH);
            throw err;
        } finally {
            rec.runs += 1;
            rec.finishedAt = now();
            rec.durationMs = rec.finishedAt - rec.startedAt;
            rec.state = rec.lastError ? "failed" : "idle";
            shared.pending -= 1;
        }
    });

    shared.tail = run.catch(() => {});
    return run;
}

/** Like kickCached, but the loader waits its turn in the serial queue. */
export function kickJob(key, ttlMs, loader) {
    kickCached(key, ttlMs, () => runSerial(key, loader));
}

export function getBackgroundJobStatus() {
    return {
        pending: shared.pending,
        jobs: [...shared.jobs.values()].map((rec) => ({ ...rec })),
    };
}
