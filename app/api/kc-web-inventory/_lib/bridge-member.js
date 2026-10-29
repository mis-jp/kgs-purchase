import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "../../flutter-kelinconnect-inventory/_lib/errors.js";
import { getLedgerPool, LEDGER_DB, ledgerStatus, requireLedger } from "../../flutter-kelinconnect-inventory/_lib/ledger-db.js";
import { writeAudit } from "../../flutter-kelinconnect-inventory/_lib/audit.js";
import { adminLoginIds } from "../../flutter-kelinconnect-inventory/_lib/rules.js";

const storage = new AsyncLocalStorage();
const transferRefKey = "__kcInventoryTransferRef";

export function runWithBridgeUser(user, fn) {
    return storage.run({ user }, fn);
}

function currentUser() {
    return storage.getStore()?.user || null;
}

/** The signed employee, without loading a ledger row. Replaces `requireInventoryUser` on read routes. */
export function requireBridgeIdentity() {
    const user = currentUser();
    if (!user?.loginId) throw new HttpError(401, "Inventory bridge not configured");
    return { user };
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
 * Same `inv_users` row as Flutter `loadMember` (that function is not exported).
 * New people start as viewer. Bootstrap admins stay admin. First insert is audited as kc-web.
 */
async function loadBridgeMember(user, request) {
    const pool = getLedgerPool();
    const loginId = String(user.loginId || "").toUpperCase();
    if (!loginId || loginId === "UNKNOWN") {
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
        await writeAudit(null, member, {
            action: "auth.first_login",
            entityType: "user",
            entityId: loginId,
            request,
            details: { source: "kc-web" },
        });
    }
    if (member.status !== "active") {
        throw new HttpError(403, "Your Inventory access is turned off. Ask an Inventory admin.");
    }
    return member;
}

export async function requireBridgeMember(request) {
    const user = currentUser();
    if (!user?.loginId) throw new HttpError(401, "Inventory bridge not configured");
    await requireLedger();
    return loadBridgeMember(user, request);
}

export async function optionalBridgeMember(request) {
    const user = currentUser() || { loginId: "", name: "" };
    const status = await ledgerStatus();
    if (!status.ready) return readOnlyViewer(user, false);
    const loginId = String(user.loginId || "").toUpperCase();
    if (!loginId || loginId === "UNKNOWN") return readOnlyViewer(user, true);
    return loadBridgeMember(user, request);
}

/**
 * If `inv_transfers.reference_no` is missing, tell the shared library not to ALTER TABLE.
 * When the column already exists, leave the cache alone so the library can use it.
 */
export async function blockTransferAlter() {
    const hit = globalThis[transferRefKey];
    if (hit === true) return;
    if (hit && hit.until > Date.now()) return;
    try {
        const pool = getLedgerPool();
        const [rows] = await pool.query(
            `SELECT 1 AS ok FROM information_schema.columns
              WHERE table_schema = ? AND table_name = 'inv_transfers' AND column_name = 'reference_no'
              LIMIT 1`,
            [LEDGER_DB]
        );
        if (!rows.length) {
            globalThis[transferRefKey] = { until: Date.now() + 10 * 60_000 };
        }
    } catch {
        globalThis[transferRefKey] = { until: Date.now() + 10 * 60_000 };
    }
}
