/** Pure rules behind the admin Access review: which accounts look unused or broader than needed. */

import { moduleAccessLabel } from "./module-access.js";

export const STALE_DAYS = 60;
const NEW_ACCOUNT_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

function toMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * users: sanitized users ({ id, username, fullName, role, active, createdAt, allBranches, branchIds, allowedModules })
 * lastSeenById: { [id]: ISO string }
 * Returns { rows, summary } with one row per user and the reasons it may need attention.
 */
export function reviewUserAccess(users = [], lastSeenById = {}, now = Date.now(), staleDays = STALE_DAYS) {
    const rows = users.map((u) => {
        const lastSeenMs = toMs(lastSeenById[u.id]);
        const createdMs = toMs(u.createdAt);
        const idleDays = lastSeenMs == null ? null : Math.floor((now - lastSeenMs) / DAY_MS);
        const flags = [];
        if (!u.active) {
            flags.push({ key: "deactivated", text: "Deactivated. Delete it if the person has left." });
        } else if (lastSeenMs == null) {
            const ageDays = createdMs == null ? Infinity : (now - createdMs) / DAY_MS;
            if (ageDays > NEW_ACCOUNT_GRACE_DAYS) flags.push({ key: "never", text: "Has never signed in." });
        } else if (idleDays >= staleDays) {
            flags.push({ key: "stale", text: `Not active for ${idleDays} days.` });
        }
        const allModules = u.role === "admin" || !(u.allowedModules || []).length;
        if (u.active && u.role !== "admin" && u.allBranches && allModules) {
            flags.push({ key: "broad", text: "Has every module and every branch. Confirm this is needed." });
        }
        return {
            id: u.id,
            username: u.username,
            fullName: u.fullName || "",
            role: u.role,
            active: Boolean(u.active),
            modules: allModules ? "All modules" : moduleAccessLabel(u.allowedModules),
            branches: u.role === "admin" || u.allBranches ? "All branches" : (u.branchIds || []).join(", ") || "None",
            lastSeenAt: lastSeenMs == null ? null : new Date(lastSeenMs).toISOString(),
            idleDays,
            flags,
            needsReview: flags.some((f) => f.key !== "broad"),
        };
    });

    rows.sort((a, b) => Number(b.needsReview) - Number(a.needsReview)
        || (b.idleDays ?? Infinity) - (a.idleDays ?? Infinity)
        || a.username.localeCompare(b.username));

    const activeAdmins = rows.filter((r) => r.active && r.role === "admin").length;
    return {
        rows,
        summary: {
            total: rows.length,
            active: rows.filter((r) => r.active).length,
            needsReview: rows.filter((r) => r.needsReview).length,
            neverSignedIn: rows.filter((r) => r.flags.some((f) => f.key === "never")).length,
            stale: rows.filter((r) => r.flags.some((f) => f.key === "stale")).length,
            deactivated: rows.filter((r) => !r.active).length,
            broad: rows.filter((r) => r.flags.some((f) => f.key === "broad")).length,
            activeAdmins,
            staleDays,
        },
    };
}
