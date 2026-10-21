import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertOperate } from "./members.js";
import {
    completePendingTransaction, findBranch, findByRequestId, findProducts, findReason,
    getSettings, insertTransaction, raiseAlert, requireLive,
} from "./ledger.js";
import { assertNotOwnRequest, iso, normalizeLines, num, person, requireRequestId } from "./rules.js";

export const MOVEMENT_TYPES = ["opening", "receive", "release", "transfer_out", "transfer_in", "adjustment"];
export const MOVEMENT_STATUSES = ["completed", "pending_approval", "rejected", "cancelled"];

function mapTransaction(r) {
    return {
        id: Number(r.id),
        number: r.txn_number,
        type: r.type,
        status: r.status,
        branch: r.branch_code,
        branchName: r.branch_name || r.branch_code,
        reasonCode: r.reason_code || "",
        reasonLabel: r.reason_label || r.reason_code || "",
        referenceNo: r.reference_no || "",
        notes: r.notes || "",
        transferId: r.transfer_id ? Number(r.transfer_id) : null,
        adjustmentId: r.adjustment_id ? Number(r.adjustment_id) : null,
        createdBy: person(r.created_by, r.created_by_name),
        approvedBy: person(r.approved_by, r.approved_by),
        createdAt: iso(r.created_at),
        approvedAt: iso(r.approved_at),
        lineCount: num(r.line_count),
        totalQty: num(r.total_qty),
    };
}

const TXN_SELECT = `
    SELECT t.*, b.code AS branch_code, b.name AS branch_name, rc.label AS reason_label,
           (SELECT COUNT(*) FROM inv_transaction_lines l WHERE l.transaction_id = t.id) AS line_count,
           (SELECT COALESCE(SUM(l.qty_change), 0) FROM inv_transaction_lines l WHERE l.transaction_id = t.id) AS total_qty
      FROM inv_transactions t
      JOIN inv_branches b ON b.id = t.branch_id
      LEFT JOIN inv_reason_codes rc ON rc.code = t.reason_code`;

export async function getTransaction(id, conn = getLedgerPool()) {
    const [[row]] = await conn.query(`${TXN_SELECT} WHERE t.id = ?`, [id]);
    if (!row) throw new HttpError(404, `Movement #${id} was not found.`);
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name, p.unit_code, loc.code AS location_code
           FROM inv_transaction_lines l
           JOIN inv_products p ON p.id = l.product_id
           LEFT JOIN inv_locations loc ON loc.id = l.location_id
          WHERE l.transaction_id = ? ORDER BY l.id`,
        [id]
    );
    return {
        ...mapTransaction(row),
        lines: lines.map((l) => ({
            inventoryId: l.sku,
            description: l.name,
            unit: l.unit_code,
            qtyChange: num(l.qty_change),
            qtyBefore: l.qty_before === null ? null : num(l.qty_before),
            qtyAfter: l.qty_after === null ? null : num(l.qty_after),
            location: l.location_code || "",
            note: l.note || "",
        })),
    };
}

export async function listTransactions({ branch, type, status, search, from, to, page, pageSize }) {
    const where = [];
    const params = [];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (type) {
        where.push("t.type = ?");
        params.push(type);
    }
    if (status) {
        where.push("t.status = ?");
        params.push(status);
    }
    if (search) {
        const like = `%${search.toUpperCase()}%`;
        where.push(`(UPPER(t.txn_number) LIKE ? OR UPPER(COALESCE(t.reference_no, '')) LIKE ?
            OR t.id IN (SELECT l.transaction_id FROM inv_transaction_lines l JOIN inv_products p ON p.id = l.product_id
                         WHERE UPPER(p.sku) LIKE ? OR UPPER(p.name) LIKE ?))`);
        params.push(like, like, like, like);
    }
    if (from) {
        where.push("t.created_at >= ?");
        params.push(new Date(from));
    }
    if (to) {
        where.push("t.created_at < ?");
        params.push(new Date(to));
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `${TXN_SELECT} ${sqlWhere} ORDER BY t.created_at DESC, t.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_transactions t JOIN inv_branches b ON b.id = t.branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return { movements: rows.map(mapTransaction), page, pageSize, totalCount: total, hasMore: offset + rows.length < total };
}

/** Receive (+) or release (-) stock at one live branch. */
export async function postMovement(member, kind, body, request) {
    const requestId = requireRequestId(body.requestId);
    const lines = normalizeLines(body.lines);
    const notes = String(body.notes || "").trim().slice(0, 1000) || null;
    const referenceNo = String(body.referenceNo || "").trim().slice(0, 100) || null;

    const id = await withLedgerTx(async (conn) => {
        const existing = await findByRequestId(conn, "inv_transactions", requestId);
        if (existing) return Number(existing.id);

        const branch = await findBranch(conn, body.branch);
        requireLive(branch);
        assertOperate(member, branch, request, `stock.${kind}`);
        const reason = await findReason(conn, body.reasonCode, kind);
        if (reason.requiresReference && !referenceNo) {
            throw new HttpError(400, `${reason.label} needs a reference number (DR, invoice, or OR).`);
        }
        const products = await findProducts(conn, lines.map((l) => l.ref));
        const sign = kind === "receive" ? 1 : -1;
        const docLines = lines.map((l) => ({
            product: products.get(l.ref.toUpperCase()),
            qtyChange: sign * l.qty,
            note: l.note,
        }));
        const txn = await insertTransaction(conn, member, {
            type: kind,
            branchId: branch.id,
            status: reason.requiresApproval ? "pending_approval" : "completed",
            reasonCode: reason.code,
            referenceNo,
            notes,
            requestId,
            lines: docLines,
        });

        if (kind === "release" && txn.status === "completed") {
            const settings = await getSettings(conn);
            for (const line of docLines) {
                if (Math.abs(line.qtyChange) > num(settings.large_release_units)) {
                    await raiseAlert(conn, {
                        type: "large_release", severity: "warning", branchId: branch.id, productId: line.product.id,
                        entityType: "transaction", entityId: txn.id,
                        message: `${Math.abs(line.qtyChange)} × ${line.product.name} released at ${branch.name} (${txn.number}).`,
                        dedupeKey: `large_release:${txn.id}:${line.product.id}`,
                    });
                }
            }
        }

        await writeAudit(conn, member, {
            action: `stock.${kind}`,
            entityType: "transaction",
            entityId: txn.id,
            branchId: branch.id,
            transactionId: txn.id,
            requestId,
            request,
            details: {
                number: txn.number,
                status: txn.status,
                reason: reason.code,
                referenceNo,
                lines: docLines.map((l) => ({
                    sku: l.product.sku,
                    change: l.qtyChange,
                    before: txn.applied.get(Number(l.product.id))?.before ?? null,
                    after: txn.applied.get(Number(l.product.id))?.after ?? null,
                })),
            },
        });
        return txn.id;
    });
    return getTransaction(id);
}

async function lockTransaction(conn, id) {
    const [[row]] = await conn.query("SELECT * FROM inv_transactions WHERE id = ? FOR UPDATE", [id]);
    if (!row) throw new HttpError(404, `Movement #${id} was not found.`);
    if (row.status !== "pending_approval") {
        throw new HttpError(409, `${row.txn_number} is already ${row.status.replace(/_/g, " ")}.`);
    }
    if (row.type !== "receive" && row.type !== "release") {
        throw new HttpError(409, `${row.txn_number} is approved from its own screen.`);
    }
    return row;
}

export async function approveTransaction(member, id, request) {
    await withLedgerTx(async (conn) => {
        const txn = await lockTransaction(conn, id);
        const branch = await findBranch(conn, txn.branch_id);
        assertApprove(member, branch, request, "stock.approve");
        assertNotOwnRequest(member, txn.created_by);
        const applied = await completePendingTransaction(conn, txn, member);
        await writeAudit(conn, member, {
            action: "stock.approve", entityType: "transaction", entityId: id, branchId: branch.id,
            transactionId: id, request,
            details: { number: txn.txn_number, lines: [...applied.entries()].map(([productId, q]) => ({ productId, ...q })) },
        });
    });
    return getTransaction(id);
}

export async function rejectTransaction(member, id, reason, request) {
    const text = String(reason || "").trim().slice(0, 500);
    if (!text) throw new HttpError(400, "Say why it is rejected.");
    await withLedgerTx(async (conn) => {
        const txn = await lockTransaction(conn, id);
        const branch = await findBranch(conn, txn.branch_id);
        assertApprove(member, branch, request, "stock.reject");
        await conn.query(
            `UPDATE inv_transactions SET status = 'rejected', approved_by = ?, approved_at = UTC_TIMESTAMP(),
                    notes = CONCAT(COALESCE(notes, ''), IF(notes IS NULL OR notes = '', '', '\n'), 'Rejected: ', ?)
              WHERE id = ?`,
            [member.loginId, text, id]
        );
        await writeAudit(conn, member, {
            action: "stock.reject", entityType: "transaction", entityId: id, branchId: branch.id,
            transactionId: id, request, details: { number: txn.txn_number, reason: text },
        });
    });
    return getTransaction(id);
}

/** Ledger lines for one product (optionally one branch), newest first. */
export async function productHistory(productRef, { branch, page, pageSize }) {
    const pool = getLedgerPool();
    const products = await findProducts(pool, [productRef], { activeOnly: false });
    const product = products.get(String(productRef).trim().toUpperCase());
    const where = ["l.product_id = ?", "t.status = 'completed'"];
    const params = [product.id];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
        `SELECT l.qty_change, l.qty_before, l.qty_after, l.note, t.id AS txn_id, t.txn_number, t.type,
                t.reason_code, rc.label AS reason_label, t.reference_no, t.created_by, t.created_by_name,
                t.created_at, b.code AS branch_code, b.name AS branch_name
           FROM inv_transaction_lines l
           JOIN inv_transactions t ON t.id = l.transaction_id
           JOIN inv_branches b ON b.id = l.branch_id
           LEFT JOIN inv_reason_codes rc ON rc.code = t.reason_code
          WHERE ${where.join(" AND ")}
          ORDER BY t.created_at DESC, l.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_transaction_lines l
           JOIN inv_transactions t ON t.id = l.transaction_id
           JOIN inv_branches b ON b.id = l.branch_id
          WHERE ${where.join(" AND ")}`,
        params
    );
    const total = num(count?.total);
    return {
        history: rows.map((r) => ({
            transactionId: Number(r.txn_id),
            number: r.txn_number,
            type: r.type,
            branch: r.branch_code,
            branchName: r.branch_name,
            reasonLabel: r.reason_label || r.reason_code || "",
            referenceNo: r.reference_no || "",
            qtyChange: num(r.qty_change),
            qtyBefore: r.qty_before === null ? null : num(r.qty_before),
            qtyAfter: r.qty_after === null ? null : num(r.qty_after),
            note: r.note || "",
            by: person(r.created_by, r.created_by_name),
            at: iso(r.created_at),
        })),
        page,
        pageSize,
        totalCount: total,
        hasMore: offset + rows.length < total,
    };
}

export async function listReasonCodes(type) {
    const [rows] = await getLedgerPool().query(
        `SELECT * FROM inv_reason_codes WHERE active = 1 ${type ? "AND applies_to = ?" : ""}
          ORDER BY sort_order, label`,
        type ? [type] : []
    );
    return rows.map((r) => ({
        code: r.code,
        appliesTo: r.applies_to,
        label: r.label,
        requiresApproval: Number(r.requires_approval) === 1,
        requiresReference: Number(r.requires_reference) === 1,
    }));
}
