import test from "node:test";
import assert from "node:assert/strict";
import { containerOptions, recommendContainerMix, containerMixText } from "../lib/packing-list.js";

test("containerOptions counts containers per type by volume", () => {
    const opts = containerOptions(60, 5000);
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    assert.equal(byId["20ft"].count, 3);
    assert.equal(byId["40ft"].count, 2);
    assert.equal(byId["40hc"].count, 1);
    assert.equal(byId["40hc"].cbmFillPct, 88.2);
    assert.equal(byId["40hc"].limitedBy, "volume");
});

test("containerOptions lets weight set the count for heavy loads", () => {
    const twenty = containerOptions(10, 30000).find((o) => o.id === "20ft");
    assert.equal(twenty.count, 2);
    assert.equal(twenty.limitedBy, "weight");
});

test("containerOptions is empty when there is nothing to ship", () => {
    assert.deepEqual(containerOptions(0, 0), []);
    assert.deepEqual(recommendContainerMix(0, 0), []);
});

test("recommendContainerMix fills High Cubes then uses the smallest fit for the rest", () => {
    assert.equal(containerMixText(recommendContainerMix(20, 3000)), "1 × 20ft Standard");
    assert.equal(containerMixText(recommendContainerMix(50, 3000)), "1 × 40ft Standard");
    assert.equal(containerMixText(recommendContainerMix(90, 8000)), "1 × 40ft High Cube + 1 × 20ft Standard");
    assert.equal(containerMixText(recommendContainerMix(140, 8000)), "2 × 40ft High Cube + 1 × 20ft Standard");
});
