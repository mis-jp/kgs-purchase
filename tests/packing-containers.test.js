import test from "node:test";
import assert from "node:assert/strict";
import {
    containerFillSummary,
    containerLimitError,
    containerMixText,
    containerOptions,
    containerTypesChanged,
    recommendContainerMix,
    resolveContainerTypes,
} from "../lib/packing-list.js";

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

test("a large load matches the counts and fill shown on the screen", () => {
    const cbm = 1906.9;
    const kg = 623500;
    const byId = Object.fromEntries(containerOptions(cbm, kg).map((o) => [o.id, o]));
    assert.deepEqual([byId["20ft"].count, byId["40ft"].count, byId["40hc"].count], [69, 33, 29]);
    assert.equal(byId["20ft"].cbmFillPct, 98.7);
    assert.equal(byId["40hc"].weightFillPct, 82.7);
    assert.equal(containerMixText(recommendContainerMix(cbm, kg)), "28 × 40ft High Cube + 1 × 20ft Standard");
});

test("blank or invalid custom limits keep the standard values", () => {
    const types = resolveContainerTypes({ "20ft": { cbm: "", kg: "abc" }, "40ft": { cbm: "0", kg: "-5" } });
    assert.deepEqual(types.map((t) => [t.usableCbm, t.maxKg]), [[28, 21000], [58, 26000], [68, 26000]]);
    assert.equal(containerTypesChanged(types), false);
    assert.equal(containerLimitError("", "cbm"), "");
    assert.equal(containerLimitError("0.5", "cbm"), "Enter 1–200 m³");
    assert.equal(containerLimitError("50", "kg"), "Enter 100–100,000 kg");
    assert.equal(containerLimitError("25,000", "kg"), "");
});

test("custom limits change the counts and fill", () => {
    const types = resolveContainerTypes({ "40hc": { cbm: "60", kg: "24,000" } });
    assert.equal(containerTypesChanged(types), true);
    const hc = containerOptions(120, 30000, types).find((o) => o.id === "40hc");
    assert.equal(hc.count, 2);
    assert.equal(hc.cbmFillPct, 100);
    assert.equal(hc.weightFillPct, 62.5);
});

test("a complete custom container is added and used in the mix", () => {
    const incomplete = resolveContainerTypes({ custom: { enabled: true, label: "Truck", cbm: "30", kg: "" } });
    assert.equal(incomplete.length, 3);
    const off = resolveContainerTypes({ custom: { enabled: false, label: "Truck", cbm: "30", kg: "10000" } });
    assert.equal(off.length, 3);

    const types = resolveContainerTypes({ custom: { enabled: true, label: "10-wheeler", cbm: "35", kg: "12000" } });
    assert.equal(types.length, 4);
    const truck = containerOptions(70, 15000, types).find((o) => o.id === "custom");
    assert.equal(truck.label, "10-wheeler");
    assert.equal(truck.count, 2);
    assert.equal(containerMixText(recommendContainerMix(32, 5000, types)), "1 × 10-wheeler");
});

test("the mix is the true minimum when custom limits make the biggest box not the strongest", () => {
    const types = resolveContainerTypes({ "40ft": { kg: "40000" } });
    const mix = recommendContainerMix(100, 70000, types);
    assert.equal(containerMixText(mix), "2 × 40ft Standard");
    const fill = containerFillSummary(100, 70000, types);
    assert.equal(fill.volumePct, 86.2);
    assert.equal(fill.weightPct, 87.5);
});

test("floating-point dust does not add a container", () => {
    const cbm = 0.1 + 0.2 + 27.7;
    assert.equal(containerOptions(cbm, 1000).find((o) => o.id === "20ft").count, 1);
});
