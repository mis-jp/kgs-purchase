import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertOperate } from "./members.js";
import { findBranch } from "./ledger.js";
import { flagOverdueTransfers } from "./transfers.js";
import { iso, num, person } from "./rules.js";

export const ALERT_STATUSES = ["new", "acknowledged", "resolved", "open"];

function mapAlert(r) {
    return {
        id: Number(r.id),
        type: r.type,
        severity: r.severity,
        status: r.status,
        branch: r.branch_code || "",
        branchName: r.branch_name || "",
        inventoryId: r.sku || "",
        description: r.product_name || "",
        entityType: r.entity_type || "",
        entityId: r.entity_id ? Number(r.entity_id) : null,
        message: r.message,
        acknowledgedBy: person(r.acknowledged_by, r.acknowledged_by),
        createdAt: iso(r.created_at),
        acknowledgedAt: iso(r.acknowledged_at),
        resolvedAt: iso(r.resolved_at),
    };
}

export async function listAlerts({ branch, status, type, page, pageSize }) {
    await flagOverdueTransfers().catch((err) => console.warn("[KC Inventory] overdue check", err?.message || err));
    const where = [];
    const params = [];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (!status || status === "open") where.push("a.status <> 'resolved'");
    else {
        where.push("a.status = ?");
        params.push(status);
    }
    if (type) {
        where.push("a.type = ?");
        params.push(type);
    }
    const sqlWhere = `WHERE ${where.join(" AND ")}`;
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `SELECT a.*, b.code AS branch_code, b.name AS branch_name, p.sku, p.name AS product_name
           FROM inv_alerts a
           LEFT JOIN inv_branches b ON b.id = a.branch_id
           LEFT JOIN inv_products p ON p.id = a.product_id
          ${sqlWhere}
          ORDER BY (a.status = 'new') DESC, FIELD(a.severity, 'critical', 'warning', 'info'), a.created_at DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_alerts a LEFT JOIN inv_branches b ON b.id = a.branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return { alerts: rows.map(mapAlert), page, pageSize, totalCount: total, hasMore: offset + rows.length < total };
}

export async function acknowledgeAlert(member, id, request) {
    await withLedgerTx(async (conn) => {
        const [[row]] = await conn.query("SELECT * FROM inv_alerts WHERE id = ? FOR UPDATE", [id]);
        if (!row) throw new HttpError(404, `Alert #${id} was not found.`);
        if (row.branch_id) assertOperate(member, await findBranch(conn, row.branch_id), request, "alert.acknowledge");
        else if (member.role === "viewer") throw new HttpError(403, "You have view-only access.");
        if (row.status !== "new") return;
        const closes = ["large_release", "repeated_adjustment", "erp_mismatch"].includes(row.type);
        await conn.query(
            `UPDATE inv_alerts SET status = ?, acknowledged_by = ?, acknowledged_at = UTC_TIMESTAMP(),
                    resolved_at = IF(? = 'resolved', UTC_TIMESTAMP(), resolved_at)
              WHERE id = ?`,
            [closes ? "resolved" : "acknowledged", member.loginId, closes ? "resolved" : "acknowledged", id]
        );
        await writeAudit(conn, member, {
            action: "alert.acknowledge", entityType: "alert", entityId: id, branchId: row.branch_id, request,
            details: { type: row.type },
        });
    });
    const [[row]] = await getLedgerPool().query(
        `SELECT a.*, b.code AS branch_code, b.name AS branch_name, p.sku, p.name AS product_name
           FROM inv_alerts a LEFT JOIN inv_branches b ON b.id = a.branch_id LEFT JOIN inv_products p ON p.id = a.product_id
          WHERE a.id = ?`,
        [id]
    );
    return mapAlert(row);
}
