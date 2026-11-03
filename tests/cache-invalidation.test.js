import test from "node:test";
import assert from "node:assert/strict";

import { getCached, invalidateCache, getCacheStats } from "../lib/server-cache.js";
import {
    cacheKeys,
    clearInvalidationFailures,
    getInvalidationFailures,
    invalidateFor,
    listInvalidationEvents,
    prefixesFor,
    runAfterCommit,
} from "../lib/cache-invalidation.js";

const TTL = 60_000;

/** A tiny "database" plus a cached reader that counts how often it hits the DB. */
function makeReader(db) {
    const reads = { count: 0 };
    const read = (key, rowKey) =>
        getCached(key, TTL, async () => {
            reads.count += 1;
            return structuredClone(db.get(rowKey));
        });
    return { read, reads };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test("creating content: a new forecast input shows on the next read of that branch", async () => {
    const db = new Map([["rows", []]]);
    const { read, reads } = makeReader(db);
    const key = cacheKeys.forecastRows("co-create", "ILOILO", '{"page":1}');

    assert.deepEqual(await read(key, "rows"), []);
    await runAfterCommit(
        async () => db.set("rows", [{ inventoryId: "SKU-1", targetSales: 10 }]),
        "forecast-input.saved",
        { companyId: "co-create", branchKey: "iloilo" }
    );

    assert.deepEqual(await read(key, "rows"), [{ inventoryId: "SKU-1", targetSales: 10 }]);
    assert.equal(reads.count, 2);
});

test("updating content: a saved annotation replaces the cached value", async () => {
    const db = new Map([["po", { "PO-1": { eta: "2026-10-01" } }]]);
    const { read } = makeReader(db);
    const key = cacheKeys.annotations("po-update");

    assert.equal((await read(key, "po"))["PO-1"].eta, "2026-10-01");
    await runAfterCommit(
        async () => db.set("po", { "PO-1": { eta: "2026-11-15" } }),
        "annotation.saved",
        { moduleName: "po-update" }
    );
    assert.equal((await read(key, "po"))["PO-1"].eta, "2026-11-15");
});

test("deleting content: a branch rebuild without an item drops it from cached pages", async () => {
    const db = new Map([["main", ["A", "B"]]]);
    const { read } = makeReader(db);
    const page1 = cacheKeys.replenishmentPage("co-del", "MAIN", "1:50::::cache");
    const page2 = cacheKeys.replenishmentPage("co-del", "MAIN", "2:50::::cache");

    assert.deepEqual(await read(page1, "main"), ["A", "B"]);
    await read(page2, "main");
    await runAfterCommit(async () => db.set("main", ["A"]), "replenishment.branch-rebuilt", {
        companyId: "co-del",
        branchKey: "main",
    });

    assert.deepEqual(await read(page1, "main"), ["A"]);
    assert.deepEqual(await read(page2, "main"), ["A"]);
});

test("publishing: a PO moved from On Hold to Open appears in open-PO and forecast caches", async () => {
    const db = new Map([["open", []]]);
    const { read } = makeReader(db);
    const openKey = "openPo:v5:MAIN:h0:o0";
    const forecastKey = cacheKeys.forecastRows("co-pub", "*", "{}");

    assert.deepEqual(await read(openKey, "open"), []);
    assert.deepEqual(await read(forecastKey, "open"), []);
    await runAfterCommit(async () => db.set("open", ["PO-9"]), "purchase-orders.changed");

    assert.deepEqual(await read(openKey, "open"), ["PO-9"]);
    assert.deepEqual(await read(forecastKey, "open"), ["PO-9"]);
});

test("unpublishing: a cancelled PO leaves the cached open-PO response", async () => {
    const db = new Map([["open", ["PO-7", "PO-8"]]]);
    const { read } = makeReader(db);
    const openKey = "openPo:v5:ALL:h1:o1";

    assert.deepEqual(await read(openKey, "open"), ["PO-7", "PO-8"]);
    await runAfterCommit(async () => db.set("open", ["PO-8"]), "purchase-orders.changed");
    assert.deepEqual(await read(openKey, "open"), ["PO-8"]);
});

test("related content: PO changes also refresh replenishment pages; sales refresh forecast gaps", () => {
    assert.ok(prefixesFor("purchase-orders.changed").includes("replenishment:api:names:"));
    assert.ok(prefixesFor("purchase-orders.changed").includes("forecast:rows:"));
    const sales = prefixesFor("periodic-sales.changed");
    assert.ok(sales.includes("forecast:rows:"));
    assert.ok(sales.includes("forecast:salesGaps:"));
    assert.ok(cacheKeys.forecastSalesGaps("x").startsWith("forecast:salesGaps:"));
});

test("unrelated cached content stays cached", async () => {
    const db = new Map([["v", 1]]);
    const { read, reads } = makeReader(db);
    const iloilo = cacheKeys.forecastRows("co-keep", "ILOILO", "{}");
    const bacolod = cacheKeys.forecastRows("co-keep", "BACOLOD", "{}");
    const otherCompany = cacheKeys.forecastRows("co-other", "ILOILO", "{}");
    const main = cacheKeys.replenishmentPage("co-keep", "MAIN", "1");
    const main2 = cacheKeys.replenishmentPage("co-keep", "MAIN2", "1");
    const notes = cacheKeys.annotations("supplier-keep");

    for (const k of [iloilo, bacolod, otherCompany, main, main2, notes]) await read(k, "v");
    assert.equal(reads.count, 6);

    invalidateFor("forecast-input.saved", { companyId: "co-keep", branchKey: "ILOILO" });
    invalidateFor("replenishment.branch-rebuilt", { companyId: "co-keep", branchKey: "MAIN" });

    for (const k of [bacolod, otherCompany, main2, notes]) await read(k, "v");
    assert.equal(reads.count, 6, "unrelated keys were served from cache");

    await read(iloilo, "v");
    await read(main, "v");
    assert.equal(reads.count, 8, "only the targeted keys reloaded");
});

test("caching stays enabled: repeated reads within the TTL hit the cache", async () => {
    const db = new Map([["v", { ok: true }]]);
    const { read, reads } = makeReader(db);
    const key = cacheKeys.annotations("perf-check");
    const before = getCacheStats().hits;

    for (let i = 0; i < 5; i++) await read(key, "v");
    assert.equal(reads.count, 1);
    assert.ok(getCacheStats().hits >= before + 4);
});

test("a load that started before the write commits is not cached afterwards", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const db = new Map([["v", "old"]]);
    const key = cacheKeys.annotations("race-check");

    let started;
    const loaderStarted = new Promise((resolve) => (started = resolve));
    const slow = getCached(key, TTL, async () => {
        const snapshot = db.get("v");
        started();
        await gate;
        return snapshot;
    });
    await loaderStarted;
    db.set("v", "new");
    invalidateFor("annotation.saved", { moduleName: "race-check" });
    release();
    assert.equal(await slow, "old", "callers already waiting get the in-flight result");

    const fresh = await getCached(key, TTL, async () => db.get("v"));
    assert.equal(fresh, "new", "the stale in-flight result was not written to the cache");
});

test("repeated invalidation is safe and idempotent", async () => {
    const db = new Map([["v", 1]]);
    const { read } = makeReader(db);
    const key = cacheKeys.annotations("idem");
    await read(key, "v");

    const first = invalidateFor("annotation.saved", { moduleName: "idem" });
    const second = invalidateFor("annotation.saved", { moduleName: "idem" });
    assert.deepEqual(first.prefixes, second.prefixes);
    assert.deepEqual(second.failed, []);
    assert.equal(invalidateCache(cacheKeys.annotations("idem")), 0);
    assert.equal(await read(key, "v"), 1);
});

test("a failed write does not invalidate anything", async () => {
    const calls = [];
    const invalidate = (p) => calls.push(p);
    await assert.rejects(
        runAfterCommit(
            async () => {
                throw new Error("deadlock");
            },
            "annotation.saved",
            { moduleName: "x" },
            { invalidate }
        ),
        /deadlock/
    );
    const result = await runAfterCommit(async () => false, "annotation.saved", { moduleName: "x" }, { invalidate });
    assert.equal(result, false);
    assert.deepEqual(calls, []);
});

test("invalidation failures are logged, retried with backoff, and recorded", () => {
    clearInvalidationFailures();
    const queued = [];
    const schedule = (fn, ms) => queued.push({ fn, ms });

    // Fails once, then succeeds on the first retry.
    let flakyCalls = 0;
    const flaky = () => {
        flakyCalls += 1;
        if (flakyCalls === 1) throw new Error("transient");
    };
    const r1 = invalidateFor("annotation.saved", { moduleName: "flaky" }, { invalidate: flaky, schedule, logger: quietLogger });
    assert.deepEqual(r1.failed, ["annotations:flaky"]);
    queued.shift().fn();
    assert.equal(flakyCalls, 2);
    assert.equal(queued.length, 0);
    assert.deepEqual(getInvalidationFailures(), []);

    // Always fails: retried `retries` times with growing delays, then recorded.
    const errors = [];
    const logger = { ...quietLogger, error: (m) => errors.push(m) };
    const broken = () => {
        throw new Error("down");
    };
    assert.doesNotThrow(() =>
        invalidateFor("annotation.saved", { moduleName: "broken" }, {
            invalidate: broken,
            schedule,
            logger,
            retries: 3,
            retryDelayMs: 100,
        })
    );
    const delays = [];
    while (queued.length) {
        const job = queued.shift();
        delays.push(job.ms);
        job.fn();
    }
    assert.deepEqual(delays, [100, 200, 400]);
    assert.equal(errors.length, 1);
    assert.equal(getInvalidationFailures().length, 1);
    assert.equal(getInvalidationFailures()[0].prefix, "annotations:broken");
});

test("unknown events are reported, not thrown", () => {
    const errors = [];
    const result = invalidateFor("no-such-event", {}, { logger: { ...quietLogger, error: (m) => errors.push(m) } });
    assert.deepEqual(result.prefixes, []);
    assert.equal(errors.length, 1);
});

test("every event clears at least one prefix, and reader keys match their event prefixes", () => {
    for (const event of listInvalidationEvents()) {
        assert.ok(prefixesFor(event, { companyId: "c", branchKey: "b", moduleName: "m" }).length > 0, event);
    }
    const [forecastPrefix] = prefixesFor("forecast-input.saved", { companyId: "main", branchKey: "*" });
    assert.ok(cacheKeys.forecastRows("main", "*", "{}").startsWith(forecastPrefix));
    const [replPrefix] = prefixesFor("replenishment.branch-rebuilt", { companyId: "main", branchKey: "iloilo" });
    assert.ok(cacheKeys.replenishmentPage("main", "ILOILO", "1:50").startsWith(replPrefix));
    const [notesPrefix] = prefixesFor("annotation.saved", { moduleName: "po" });
    assert.equal(cacheKeys.annotations("po"), notesPrefix);
});
