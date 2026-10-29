import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertOperate } from "./members.js";
import {
    findBranch, findByRequestId, findProducts, findReason, getSettings, insertTransaction,
    nextNumber, raiseAlert, requireLive,
} from "./ledger.js";
import { assertNotOwnRequest, iso, num, person, requireRequestId } from "./rules.js";

/** Stock corrections. Never silent: each one is a document that a manager approves. */

export const ADJUSTMENT_STATUSES = ["pending_approval", "approved", "rejected", "cancelled"];
const SYSTEM = { loginId: "SYSTEM", name: "Auto-approved (small difference)", role: "system" };

const ADJ_SELECT = `
    SELECT a.*, b.code AS branch_code, b.name AS branch_name, rc.label AS reason_label,
           t.txn_number,
           (SELECT COUNT(*) FROM inv_adjustment_lines l WHERE l.adjustment_id = a.id) AS line_count,
           (SELECT COALESCE(SUM(l.difference), 0) FROM inv_adjustment_lines l WHERE l.adjustment_id = a.id) AS net_difference
      FROM inv_adjustments a
      JOIN inv_branches b ON b.id = a.branch_id
      LEFT JOIN inv_reason_codes rc ON rc.code = a.reason_code
      LEFT JOIN inv_transactions t ON t.id = a.transaction_id`;

function mapAdjustment(r) {
    return {
        id: Number(r.id),
        number: r.adjustment_number,
        branch: r.branch_code,
        branchName: r.branch_name,
        source: r.source,
        countId: r.count_id ? Number(r.count_id) : null,
        transferId: r.transfer_id ? Number(r.transfer_id) : null,
        status: r.status,
        reasonCode: r.reason_code,
        reasonLabel: r.reason_label || r.reason_code,
        notes: r.notes || "",
        rejectionReason: r.rejection_reason || "",
        requestedBy: person(r.requested_by, r.requested_by_name),
        approvedBy: person(r.approved_by, r.approved_by === "SYSTEM" ? SYSTEM.name : r.approved_by),
        requestedAt: iso(r.requested_at),
        decidedAt: iso(r.decided_at),
        movementNumber: r.txn_number || "",
        lineCount: num(r.line_count),
        netDifference: num(r.net_difference),
    };
}

export async function getAdjustment(id, conn = getLedgerPool()) {
    const [[row]] = await conn.query(`${ADJ_SELECT} WHERE a.id = ?`, [id]);
    if (!row) throw new HttpError(404, `Adjustment #${id} was not found.`);
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name, COALESCE(bal.qty_on_hand, 0) AS on_hand_now
           FROM inv_adjustment_lines l
           JOIN inv_products p ON p.id = l.product_id
           LEFT JOIN inv_balances bal ON bal.product_id = l.product_id AND bal.branch_id = ?
          WHERE l.adjustment_id = ? ORDER BY ABS(l.difference) DESC, p.sku`,
        [row.branch_id, id]
    );
    return {
        ...mapAdjustment(row),
        lines: lines.map((l) => ({
            inventoryId: l.sku,
            description: l.name,
            systemQty: num(l.system_qty),
            countedQty: num(l.counted_qty),
            difference: num(l.difference),
            onHandNow: num(l.on_hand_now),
            note: l.note || "",
        })),
    };
}

export async function listAdjustments({ branch, status, page, pageSize }) {
    const where = [];
    const params = [];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (status) {
        where.push("a.status = ?");
        params.push(status);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `${ADJ_SELECT} ${sqlWhere}
          ORDER BY (a.status = 'pending_approval') DESC, a.requested_at DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_adjustments a JOIN inv_branches b ON b.id = a.branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return { adjustments: rows.map(mapAdjustment), page, pageSize, totalCount: total, hasMore: offset + rows.length < total };
}

async function applyAdjustment(conn, approver, adj, branch, request) {
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name FROM inv_adjustment_lines l JOIN inv_products p ON p.id = l.product_id
          WHERE l.adjustment_id = ? AND l.difference <> 0`,
        [adj.id]
    );
    let txn = null;
    if (lines.length) {
        txn = await insertTransaction(conn, approver, {
            type: "adjustment", branchId: branch.id, reasonCode: adj.reason_code, adjustmentId: adj.id,
            referenceNo: adj.adjustment_number, notes: adj.notes, requestId: randomUUID(),
            approvedBy: approver.loginId, enforceAvailable: false,
            lines: lines.map((l) => ({
                product: { id: Number(l.product_id), sku: l.sku, name: l.name },
                qtyChange: num(l.difference),
                note: l.note,
            })),
        });
    }
    await conn.query(
        `UPDATE inv_adjustments SET status = 'approved', approved_by = ?, decided_at = UTC_TIMESTAMP(), transaction_id = ?
          WHERE id = ?`,
        [approver.loginId, txn?.id || null, adj.id]
    );
    const settings = await getSettings(conn);
    const limit = Math.max(2, num(settings.repeated_adjustment_count));
    for (const l of lines) {
        const [[recent]] = await conn.query(
            `SELECT COUNT(DISTINCT a.id) AS n FROM inv_adjustments a
               JOIN inv_adjustment_lines l ON l.adjustment_id = a.id
              WHERE a.branch_id = ? AND l.product_id = ? AND a.status = 'approved' AND l.difference <> 0
                AND a.decided_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY`,
            [branch.id, l.product_id]
        );
        if (num(recent.n) >= limit) {
            await raiseAlert(conn, {
                type: "repeated_adjustment", severity: "warning", branchId: branch.id, productId: l.product_id,
                message: `${l.name} (${l.sku}) at ${branch.name} was corrected ${num(recent.n)} times in 30 days. Check how it is handled.`,
                dedupeKey: `repeated_adjustment:${branch.id}:${l.product_id}`,
            });
        }
    }
    await writeAudit(conn, approver, {
        action: "adjustment.approve", entityType: "adjustment", entityId: adj.id, branchId: branch.id,
        transactionId: txn?.id || null, request,
        details: { number: adj.adjustment_number, movement: txn?.number || null,
            lines: lines.map((l) => ({ sku: l.sku, difference: num(l.difference) })) },
    });
    return txn;
}

/**
 * Create an adjustment document. lines: [{ product, systemQty, countedQty, note }].
 * Auto-approves when every |difference| is within `adjustment_auto_approve_units` (> 0).
 */
export async function createAdjustmentRecord(conn, member, doc, request) {
    const number = await nextNumber(conn, "ADJ");
    const [res] = await conn.query(
        `INSERT INTO inv_adjustments
            (adjustment_number, branch_id, source, count_id, transfer_id, status, reason_code, notes,
             request_id, requested_by, requested_by_name)
         VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?)`,
        [number, doc.branch.id, doc.source, doc.countId || null, doc.transferId || null, doc.reasonCode,
            doc.notes || null, doc.requestId, member.loginId, member.name]
    );
    for (const l of doc.lines) {
        await conn.query(
            `INSERT INTO inv_adjustment_lines (adjustment_id, product_id, system_qty, counted_qty, difference, note)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [res.insertId, l.product.id, l.systemQty, l.countedQty, num(l.countedQty) - num(l.systemQty), l.note || null]
        );
    }
    await writeAudit(conn, member, {
        action: "adjustment.request", entityType: "adjustment", entityId: res.insertId, branchId: doc.branch.id,
        requestId: doc.requestId, request,
        details: { number, source: doc.source, lines: doc.lines.map((l) => ({ sku: l.product.sku, system: l.systemQty, counted: l.countedQty })) },
    });
    const settings = await getSettings(conn);
    const auto = num(settings.adjustment_auto_approve_units);
    const small = auto > 0 && doc.lines.every((l) => Math.abs(num(l.countedQty) - num(l.systemQty)) <= auto);
    if (small) {
        const [[adj]] = await conn.query("SELECT * FROM inv_adjustments WHERE id = ?", [res.insertId]);
        await applyAdjustment(conn, SYSTEM, adj, doc.branch, request);
    }
    return { id: res.insertId, number, autoApproved: small };
}

/** Manual correction: the user enters the real quantity; the server computes the difference. */
export async function requestAdjustment(member, body, request) {
    const requestId = requireRequestId(body.requestId);
    if (!Array.isArray(body.lines) || !body.lines.length) throw new HttpError(400, "Add at least one item.");
    if (body.lines.length > 200) throw new HttpError(400, "Use at most 200 items per adjustment.");
    const notes = String(body.notes || "").trim().slice(0, 1000);
    if (!notes) throw new HttpError(400, "Explain why the stock needs correcting.");

    const id = await withLedgerTx(async (conn) => {
        const existing = await findByRequestId(conn, "inv_adjustments", requestId);
        if (existing) return Number(existing.id);
        const branch = await findBranch(conn, body.branch);
        requireLive(branch);
        assertOperate(member, branch, request, "adjustment.request");
        const reason = await findReason(conn, body.reasonCode || "DATA_ENTRY_ERROR", "adjustment");
        const refs = body.lines.map((l) => String(l?.inventoryId || "").trim());
        const products = await findProducts(conn, refs);
        const lines = [];
        for (const raw of body.lines) {
            const product = products.get(String(raw.inventoryId).trim().toUpperCase());
            const counted = Number(raw.countedQty);
            if (!Number.isFinite(counted) || counted < 0) throw new HttpError(400, `Real quantity for ${product.sku} must be zero or more.`);
            const [[bal]] = await conn.query(
                "SELECT qty_on_hand FROM inv_balances WHERE product_id = ? AND branch_id = ?",
                [product.id, branch.id]
            );
            const systemQty = num(bal?.qty_on_hand);
            if (systemQty === counted) continue;
            lines.push({ product, systemQty, countedQty: counted, note: String(raw.note || "").trim().slice(0, 500) || null });
        }
        if (!lines.length) throw new HttpError(400, "The quantities already match the system. Nothing to correct.");
        const adj = await createAdjustmentRecord(conn, member, {
            branch, source: "manual", reasonCode: reason.code, notes, requestId, lines,
        }, request);
        return adj.id;
    });
    return getAdjustment(id);
}

async function lockPending(conn, id) {
    const [[adj]] = await conn.query("SELECT * FROM inv_adjustments WHERE id = ? FOR UPDATE", [id]);
    if (!adj) throw new HttpError(404, `Adjustment #${id} was not found.`);
    if (adj.status !== "pending_approval") {
        throw new HttpError(409, `${adj.adjustment_number} is already ${adj.status.replace(/_/g, " ")}.`);
    }
    return adj;
}

export async function approveAdjustment(member, id, request) {
    await withLedgerTx(async (conn) => {
        const adj = await lockPending(conn, id);
        const branch = await findBranch(conn, adj.branch_id);
        assertApprove(member, branch, request, "adjustment.approve");
        assertNotOwnRequest(member, adj.requested_by);
        await applyAdjustment(conn, member, adj, branch, request);
    });
    return getAdjustment(id);
}

export async function rejectAdjustment(member, id, reason, request) {
    const text = String(reason || "").trim().slice(0, 500);
    if (!text) throw new HttpError(400, "Say why the adjustment is rejected.");
    await withLedgerTx(async (conn) => {
        const adj = await lockPending(conn, id);
        const branch = await findBranch(conn, adj.branch_id);
        assertApprove(member, branch, request, "adjustment.reject");
        await conn.query(
            `UPDATE inv_adjustments SET status = 'rejected', approved_by = ?, decided_at = UTC_TIMESTAMP(), rejection_reason = ?
              WHERE id = ?`,
            [member.loginId, text, id]
        );
        await writeAudit(conn, member, {
            action: "adjustment.reject", entityType: "adjustment", entityId: id, branchId: branch.id, request,
            details: { number: adj.adjustment_number, reason: text },
        });
    });
    return getAdjustment(id);
}
