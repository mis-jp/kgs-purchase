import test from "node:test";
import assert from "node:assert/strict";
import {
    changedDimensionFields,
    mergeDimensionsFillEmpty,
    mergeDimensionsReplace,
} from "../lib/item-dimensions.js";

const saved = { inventory_id: "A1", pcs_per_box: 20, length_m: "0.450", height_m: null, width_m: 0.28, weight_kg: 8.5, cbm: null };
const file = { inventory_id: "A1", pcs_per_box: 24, length_m: null, height_m: 0.32, width_m: 0.3, weight_kg: null, cbm: null };

test("fill mode keeps saved values and only fills empty fields", () => {
    const merged = mergeDimensionsFillEmpty(saved, file);
    assert.equal(merged.pcs_per_box, 20);
    assert.equal(merged.width_m, 0.28);
    assert.equal(merged.height_m, 0.32);
    assert.deepEqual(changedDimensionFields(saved, merged), ["height_m"]);
});

test("replace mode uses file values but a blank cell keeps the saved value", () => {
    const merged = mergeDimensionsReplace(saved, file);
    assert.equal(merged.pcs_per_box, 24);
    assert.equal(merged.width_m, 0.3);
    assert.equal(merged.height_m, 0.32);
    assert.equal(merged.length_m, "0.450");
    assert.equal(merged.weight_kg, 8.5);
    assert.deepEqual(changedDimensionFields(saved, merged), ["pcs_per_box", "height_m", "width_m"]);
});

test("replace mode works for items with nothing saved yet", () => {
    const merged = mergeDimensionsReplace(null, file);
    assert.equal(merged.pcs_per_box, 24);
    assert.equal(merged.weight_kg, null);
});

test("matching values count as unchanged, even when saved as text", () => {
    const merged = mergeDimensionsReplace(saved, { inventory_id: "A1", length_m: 0.45 });
    assert.deepEqual(changedDimensionFields(saved, merged), []);
});
