import test from "node:test";
import assert from "node:assert/strict";
import { reviewUserAccess } from "../lib/access-review.js";

const now = Date.parse("2026-11-11T00:00:00Z");
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

test("reviewUserAccess flags never-signed-in, idle, deactivated and full-access accounts", () => {
    const users = [
        { id: 1, username: "admin", role: "admin", active: true, createdAt: daysAgo(400), allBranches: true, allowedModules: [] },
        { id: 2, username: "maria", role: "user", active: true, createdAt: daysAgo(300), allBranches: false, branchIds: ["CDO"], allowedModules: [] },
        { id: 3, username: "newbie", role: "user", active: true, createdAt: daysAgo(2), allBranches: false, branchIds: ["MAIN"], allowedModules: [] },
        { id: 4, username: "ghost", role: "user", active: true, createdAt: daysAgo(30), allBranches: false, branchIds: ["MAIN"], allowedModules: [] },
        { id: 5, username: "left", role: "user", active: false, createdAt: daysAgo(500), allBranches: false, branchIds: [], allowedModules: [] },
        { id: 6, username: "boss", role: "user", active: true, createdAt: daysAgo(100), allBranches: true, allowedModules: [] },
    ];
    const lastSeen = { 1: daysAgo(0), 2: daysAgo(75), 6: daysAgo(1) };
    const { rows, summary } = reviewUserAccess(users, lastSeen, now);
    const byName = Object.fromEntries(rows.map((r) => [r.username, r]));

    assert.deepEqual(byName.admin.flags, []);
    assert.equal(byName.maria.flags[0].key, "stale");
    assert.equal(byName.maria.idleDays, 75);
    assert.deepEqual(byName.newbie.flags, []);
    assert.equal(byName.ghost.flags[0].key, "never");
    assert.equal(byName.left.flags[0].key, "deactivated");
    assert.equal(byName.boss.flags[0].key, "broad");
    assert.equal(byName.boss.needsReview, false);
    assert.equal(byName.boss.branches, "All branches");
    assert.equal(byName.maria.branches, "CDO");

    assert.deepEqual(
        { needsReview: summary.needsReview, never: summary.neverSignedIn, stale: summary.stale, deactivated: summary.deactivated, broad: summary.broad, admins: summary.activeAdmins },
        { needsReview: 3, never: 1, stale: 1, deactivated: 1, broad: 1, admins: 1 }
    );
    assert.ok(rows.slice(0, 3).every((r) => r.needsReview), "accounts to review are listed first");
});
