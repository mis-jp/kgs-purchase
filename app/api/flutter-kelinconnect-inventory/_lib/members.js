import { requireInventoryUser } from "./auth.js";
import { HttpError } from "./errors.js";
import { getLedgerPool, ledgerStatus, requireLedger } from "./ledger-db.js";
import { writeAudit, auditLater } from "./audit.js";
import { adminLoginIds, canApprove, canOperate, isAdmin, isManagerOrAdmin, permissionFlags } from "./rules.js";

/**
 * KelinConnect user + Inventory role (`inv_users`).
 * First visit creates a `viewer`; login ids in KC_INVENTORY_ADMIN_LOGIN_IDS are kept as `admin`.
 */
async function loadMember(user, request) {
    const pool = getLedgerPool();
    const loginId = String(user.loginId || "").toUpperCase();
    if (!loginId || loginId === "UNKNOWN") {
        // Not 401: the app answers 401 by fetching a new token, which restarts the employee id lookup.
        throw new HttpError(403,
            "The Inventory server could not match your KelinConnect account to your employee ID (no login id).");
    }
    const bootstrapAdmin = adminLoginIds().has(loginId);
    const [res] = await pool.query(
        `INSERT INTO inv_users (login_id, full_name, role, all_branches, created_by, last_seen_at)
         VALUES (?, ?, ?, ?, 'auto', UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
            full_name = COALESCE(NULLIF(VALUES(full_name), ''), full_name),
            last_seen_at = UTC_TIMESTAMP(),
            role = IF(?, 'admin', role),
            all_branches = IF(?, 1, all_branches)`,
        [loginId, user.name || null, bootstrapAdmin ? "admin" : "viewer", bootstrapAdmin ? 1 : 0, bootstrapAdmin, bootstrapAdmin]
    );
    const [[row]] = await pool.query("SELECT * FROM inv_users WHERE login_id = ?", [loginId]);
    const [branches] = await pool.query(
        `SELECT ub.branch_id, b.code FROM inv_user_branches ub
           JOIN inv_branches b ON b.id = ub.branch_id
          WHERE ub.user_id = ?`,
        [row.id]
    );
    const member = {
        id: Number(row.id),
        loginId,
        name: row.full_name || user.name || loginId,
        role: row.role,
        status: row.status,
        allBranches: Number(row.all_branches) === 1,
        branchIds: new Set(branches.map((b) => Number(b.branch_id))),
        branchCodes: branches.map((b) => String(b.code)),
        ledger: true,
    };
    if (res.affectedRows === 1) {
        await writeAudit(null, member, { action: "auth.first_login", entityType: "user", entityId: loginId, request });
    }
    if (member.status !== "active") {
        throw new HttpError(403, "Your Inventory access is turned off. Ask an Inventory admin.");
    }
    return member;
}

/** Signed-in KelinConnect user with Inventory role. Requires the ledger database. */
export async function requireMember(request) {
    const ctx = await requireInventoryUser(request);
    await requireLedger();
    return loadMember(ctx.user, request);
}

function readOnlyViewer(user, ledger) {
    return {
        id: 0,
        loginId: user.loginId,
        name: user.name,
        role: "viewer",
        status: "active",
        allBranches: true,
        branchIds: new Set(),
        branchCodes: [],
        ledger,
    };
}

/**
 * Like requireMember, but for read-only pages: a read-only viewer when the ledger is not set up,
 * or when the session has no login id to match an Inventory user (so lists still load).
 */
export async function optionalMember(request) {
    const ctx = await requireInventoryUser(request);
    const status = await ledgerStatus();
    if (!status.ready) return readOnlyViewer(ctx.user, false);
    const loginId = String(ctx.user.loginId || "").toUpperCase();
    if (!loginId || loginId === "UNKNOWN") return readOnlyViewer(ctx.user, true);
    return loadMember(ctx.user, request);
}

function deny(member, request, action, branchId, message) {
    auditLater(member, { action, outcome: "denied", branchId, request, details: { message } });
    return new HttpError(403, message);
}

export function assertOperate(member, branch, request, action) {
    if (!canOperate(member, branch.id)) {
        throw deny(member, request, action, branch.id,
            member.role === "viewer"
                ? "You have view-only access. Ask an Inventory admin to give you staff access."
                : `You are not assigned to ${branch.name || branch.code}.`);
    }
}

export function assertApprove(member, branch, request, action) {
    if (!canApprove(member, branch.id)) {
        throw deny(member, request, action, branch.id,
            `Only a manager of ${branch.name || branch.code} or an admin can approve this.`);
    }
}

export function assertAdmin(member, request, action) {
    if (!isAdmin(member)) throw deny(member, request, action, null, "Only Inventory admins can do this.");
}

export function assertManager(member, request, action) {
    if (!isManagerOrAdmin(member)) throw deny(member, request, action, null, "Only managers and admins can do this.");
}

/** Branch filter for lists: admins / all-branch users see everything, others their branches. */
export function scopeBranchIds(member) {
    if (member.role === "admin" || member.allBranches) return null;
    return [...member.branchIds];
}

export function publicMember(member) {
    return {
        loginId: member.loginId,
        name: member.name,
        role: member.role,
        allBranches: member.allBranches,
        branches: member.branchCodes,
        permissions: permissionFlags(member),
    };
}
