import test from "node:test";
import assert from "node:assert/strict";
import {
    homePathForUser,
    moduleAccessLabel,
    normalizeModuleAccessInput,
    parseAllowedModules,
    pathAllowedForUser,
    serializeAllowedModules,
} from "../lib/module-access.js";

const packingOnly = { role: "user", allowedModules: ["packing-list"] };

test("packing-list-only user reaches the packing list page and its APIs only", () => {
    assert.equal(pathAllowedForUser(packingOnly, "/packing-list"), true);
    assert.equal(pathAllowedForUser(packingOnly, "/api/po/packing-list"), true);
    assert.equal(pathAllowedForUser(packingOnly, "/api/po/packing-list/saved/12"), true);
    assert.equal(pathAllowedForUser(packingOnly, "/api/branches"), true);
    assert.equal(pathAllowedForUser(packingOnly, "/account"), true);
    assert.equal(pathAllowedForUser(packingOnly, "/api/po"), false);
    assert.equal(pathAllowedForUser(packingOnly, "/api/po/live"), false);
    assert.equal(pathAllowedForUser(packingOnly, "/purchase-orders"), false);
    assert.equal(pathAllowedForUser(packingOnly, "/dashboard"), false);
    assert.equal(pathAllowedForUser(packingOnly, "/admin"), false);
    assert.equal(pathAllowedForUser(packingOnly, "/packing-listx"), false);
    assert.equal(homePathForUser(packingOnly), "/packing-list");
});

test("several modules combine; home is the first one in menu order", () => {
    const user = { role: "user", allowedModules: ["sales", "packing-list"] };
    assert.equal(pathAllowedForUser(user, "/sales"), true);
    assert.equal(pathAllowedForUser(user, "/api/sales-periodic"), true);
    assert.equal(pathAllowedForUser(user, "/packing-list"), true);
    assert.equal(pathAllowedForUser(user, "/replenishment"), false);
    assert.equal(homePathForUser(user), "/packing-list");
    assert.equal(moduleAccessLabel(user.allowedModules), "Last 3 Months Sales, Packing List Generator");
});

test("inventory module maps to the dashboard page", () => {
    const user = { role: "user", allowedModules: ["inventory"] };
    assert.equal(pathAllowedForUser(user, "/dashboard"), true);
    assert.equal(pathAllowedForUser(user, "/api/inventory/locations"), true);
    assert.equal(homePathForUser(user), "/dashboard");
});

test("admins and unrestricted users can open everything", () => {
    assert.equal(pathAllowedForUser({ role: "admin", allowedModules: ["packing-list"] }, "/admin"), true);
    assert.equal(pathAllowedForUser({ role: "user", allowedModules: [] }, "/syncing"), true);
    assert.equal(homePathForUser({ role: "user", allowedModules: null }), "/dashboard");
});

test("old forecast-only accounts keep working", () => {
    const user = { role: "user", allowedModules: parseAllowedModules("forecast-generator") };
    assert.deepEqual(user.allowedModules, ["forecast-generator"]);
    assert.equal(pathAllowedForUser(user, "/api/forecast-generator/sales-backfill"), true);
    assert.equal(pathAllowedForUser(user, "/packing-list"), false);
    assert.equal(homePathForUser(user), "/forecast-generator");
});

test("admin form input is normalized to known modules", () => {
    assert.deepEqual(normalizeModuleAccessInput("all"), []);
    assert.deepEqual(normalizeModuleAccessInput(undefined), []);
    assert.deepEqual(normalizeModuleAccessInput("forecast-generator"), ["forecast-generator"]);
    assert.deepEqual(normalizeModuleAccessInput(["packing-list", "bogus", "packing-list"]), ["packing-list"]);
    assert.throws(() => normalizeModuleAccessInput(["bogus"]), /at least one module/);
    assert.equal(serializeAllowedModules(normalizeModuleAccessInput(["packing-list"])), '["packing-list"]');
    assert.equal(serializeAllowedModules(normalizeModuleAccessInput("all")), null);
});
