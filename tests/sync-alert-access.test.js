import test from "node:test";
import assert from "node:assert/strict";
import { canSeeSyncAlerts } from "../lib/sync-alert-access.js";

const env = { APP_ADMIN_USERNAME: "admin" };

test("only the built-in admin and johnpaul see sync alerts", () => {
    assert.equal(canSeeSyncAlerts({ username: "admin", role: "admin" }, env), true);
    assert.equal(canSeeSyncAlerts({ username: "JohnPaul", role: "admin" }, env), true);
    assert.equal(canSeeSyncAlerts({ username: "maria", role: "admin" }, env), false);
    assert.equal(canSeeSyncAlerts({ username: "johnpaul", role: "user" }, env), false);
    assert.equal(canSeeSyncAlerts(null, env), false);
});

test("the built-in admin follows the configured admin username", () => {
    const custom = { APP_ADMIN_USERNAME: "sysadmin" };
    assert.equal(canSeeSyncAlerts({ username: "sysadmin", role: "admin" }, custom), true);
    assert.equal(canSeeSyncAlerts({ username: "admin", role: "admin" }, custom), false);
});

test("extra usernames can be added through configuration", () => {
    const extra = { ...env, SYNC_ALERT_USERS: "carlo, ops.lead" };
    assert.equal(canSeeSyncAlerts({ username: "ops.lead", role: "admin" }, extra), true);
});
