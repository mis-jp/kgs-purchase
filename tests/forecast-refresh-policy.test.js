import test from "node:test";
import assert from "node:assert/strict";

import { shouldWaitForForecastRefresh } from "../lib/forecast-refresh-policy.js";

test("normal loads do not block on refresh", () => {
    assert.equal(
        shouldWaitForForecastRefresh({ isExport: false, isManualRefresh: false }),
        false,
    );
});

test("manual refreshes still wait for a sync", () => {
    assert.equal(
        shouldWaitForForecastRefresh({ isExport: false, isManualRefresh: true }),
        true,
    );
});

test("exports skip waiting for sync", () => {
    assert.equal(
        shouldWaitForForecastRefresh({ isExport: true, isManualRefresh: true }),
        false,
    );
});
