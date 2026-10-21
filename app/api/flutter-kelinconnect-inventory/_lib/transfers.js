import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertOperate } from "./members.js";
import {
    applyBalanceChanges, findBranch, findByRequestId, findProducts, findReason, getSettings,
    insertTransaction, nextNumber, raiseAlert, requireLive, resolveAlerts,
} from "./ledger.js";
import { createCase } from "./cases.js";
import {
    assertNotOwnRequest, assertTransferAction, iso, normalizeLines, num, person, requireRequestId,
} from "./rules.js";

/**
 * Branch-to-branch transfers:
 * pending_approval -> approved (stock reserved at source) -> in_transit (left source, in transit to
 * destination) -> received / partially_received (arrived; short lines open a discrepancy case).
 */

export const TRANSFER_STATUSES = ["draft", "pending_approval", "approved", "in_transit", "received", "partially_received", "rejected", "cancelled"];

const TRANSFER_SELECT = `
    SELECT t.*, fb.code AS from_code, fb.name AS from_name, tb.code AS to_code, tb.name AS to_name,
           rc.label AS reason_label,
           (SELECT COUNT(*) FROM inv_transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
           (SELECT COALESCE(SUM(l.qty_requested), 0) FROM inv_transfer_lines l WHERE l.transfer_id = t.id) AS total_requested
      FROM inv_transfers t
      JOIN inv_branches fb ON fb.id = t.from_branch_id
      JOIN inv_branches tb ON tb.id = t.to_branch_id
      LEFT JOIN inv_reason_codes rc ON rc.code = t.reason_code`;

function mapTransfer(r) {
    return {
        id: Number(r.id),
        number: r.transfer_number,
        status: r.status,
        fromBranch: r.from_code,
        fromBranchName: r.from_name,
        toBranch: r.to_code,
        toBranchName: r.to_name,
        reasonCode: r.reason_code || "",
        reasonLabel: r.reason_label || r.reason_code || "",
        notes: r.notes || "",
        rejectionReason: r.rejection_reason || "",
        expectedArrival: r.expected_arrival ? iso(r.expected_arrival)?.slice(0, 10) : null,
        requestedBy: person(r.requested_by, r.requested_by_name),
        approvedBy: person(r.approved_by, r.approved_by),
        dispatchedBy: person(r.dispatched_by, r.dispatched_by),
        receivedBy: person(r.received_by, r.received_by),
        requestedAt: iso(r.requested_at),
        approvedAt: iso(r.approved_at),
        dispatchedAt: iso(r.dispatched_at),
        receivedAt: iso(r.received_at),
        lineCount: num(r.line_count),
        totalRequested: num(r.total_requested),
    };
}

export async function getTransfer(id, conn = getLedgerPool()) {
    const [[row]] = await conn.query(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
    if (!row) throw new HttpError(404, `Transfer #${id} was not found.`);
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name, p.unit_code,
                COALESCE(fbal.qty_on_hand, 0) AS from_on_hand, COALESCE(fbal.qty_reserved, 0) AS from_reserved
           FROM inv_transfer_lines l
           JOIN inv_products p ON p.id = l.product_id
           LEFT JOIN inv_balances fbal ON fbal.product_id = l.product_id AND fbal.branch_id = ?
          WHERE l.transfer_id = ? ORDER BY l.id`,
        [row.from_branch_id, id]
    );
    return {
        ...mapTransfer(row),
        lines: lines.map((l) => ({
            inventoryId: l.sku,
            description: l.name,
            unit: l.unit_code,
            qtyRequested: num(l.qty_requested),
            qtySent: l.qty_sent === null ? null : num(l.qty_sent),
            qtyReceived: l.qty_received === null ? null : num(l.qty_received),
            sourceOnHand: num(l.from_on_hand),
            sourceAvailable: Math.max(0, num(l.from_on_hand) - num(l.from_reserved)),
            note: l.note || "",
        })),
    };
}

/** Flag in-transit transfers older than the configured number of days. */
export async function flagOverdueTransfers(conn = getLedgerPool()) {
    const settings = await getSettings(conn);
    const days = Math.max(1, num(settings.transfer_overdue_days));
    const [rows] = await conn.query(
        `SELECT t.id, t.transfer_number, t.to_branch_id, tb.name AS to_name, t.dispatched_at
           FROM inv_transfers t JOIN inv_branches tb ON tb.id = t.to_branch_id
          WHERE t.status = 'in_transit' AND t.dispatched_at < UTC_TIMESTAMP() - INTERVAL ? DAY`,
        [days]
    );
    for (const r of rows) {
        await raiseAlert(conn, {
            type: "transfer_overdue", severity: "warning", branchId: r.to_branch_id,
            entityType: "transfer", entityId: r.id,
            message: `${r.transfer_number} has been in transit to ${r.to_name} for more than ${days} day(s).`,
            dedupeKey: `transfer_overdue:${r.id}`,
        });
    }
}

export async function listTransfers({ branch, status, direction, page, pageSize }) {
    await flagOverdueTransfers().catch((err) => console.warn("[KC Inventory] overdue check", err?.message || err));
    const where = [];
    const params = [];
    if (branch) {
        const code = branch.toUpperCase();
        if (direction === "out") where.push("fb.code = ?");
        else if (direction === "in") where.push("tb.code = ?");
        else where.push("(fb.code = ? OR tb.code = ?)");
        params.push(code);
        if (direction !== "out" && direction !== "in") params.push(code);
    }
    if (status === "active") where.push("t.status IN ('pending_approval', 'approved', 'in_transit')");
    else if (status) {
        where.push("t.status = ?");
        params.push(status);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `${TRANSFER_SELECT} ${sqlWhere}
          ORDER BY (t.status IN ('pending_approval', 'approved', 'in_transit')) DESC, t.requested_at DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_transfers t
           JOIN inv_branches fb ON fb.id = t.from_branch_id
           JOIN inv_branches tb ON tb.id = t.to_branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return { transfers: rows.map(mapTransfer), page, pageSize, totalCount: total, hasMore: offset + rows.length < total };
}

export async function createTransfer(member, body, request) {
    const requestId = requireRequestId(body.requestId);
    const lines = normalizeLines(body.lines);
    const notes = String(body.notes || "").trim().slice(0, 1000) || null;
    const expected = /^\d{4}-\d{2}-\d{2}$/.test(String(body.expectedArrival || "")) ? body.expectedArrival : null;

    const id = await withLedgerTx(async (conn) => {
        const existing = await findByRequestId(conn, "inv_transfers", requestId);
        if (existing) return Number(existing.id);
        const from = await findBranch(conn, body.fromBranch);
        const to = await findBranch(conn, body.toBranch);
        if (from.id === to.id) throw new HttpError(400, "Pick two different branches.");
        requireLive(from);
        requireLive(to);
        assertOperate(member, from, request, "transfer.create");
        const reason = await findReason(conn, body.reasonCode || "REPLENISHMENT", "transfer");
        const products = await findProducts(conn, lines.map((l) => l.ref));
        const number = await nextNumber(conn, "TRF");
        const [res] = await conn.query(
            `INSERT INTO inv_transfers
                (transfer_number, from_branch_id, to_branch_id, status, reason_code, notes, expected_arrival,
                 request_id, requested_by, requested_by_name)
             VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?)`,
            [number, from.id, to.id, reason.code, notes, expected, requestId, member.loginId, member.name]
        );
        for (const line of lines) {
            await conn.query(
                "INSERT INTO inv_transfer_lines (transfer_id, product_id, qty_requested, note) VALUES (?, ?, ?, ?)",
                [res.insertId, products.get(line.ref.toUpperCase()).id, line.qty, line.note]
            );
        }
        await writeAudit(conn, member, {
            action: "transfer.create", entityType: "transfer", entityId: res.insertId, branchId: from.id, requestId, request,
            details: { number, to: to.code, lines: lines.map((l) => ({ sku: l.ref, qty: l.qty })) },
        });
        return res.insertId;
    });
    return getTransfer(id);
}

async function lockTransfer(conn, id) {
    const [[row]] = await conn.query("SELECT * FROM inv_transfers WHERE id = ? FOR UPDATE", [id]);
    if (!row) throw new HttpError(404, `Transfer #${id} was not found.`);
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name FROM inv_transfer_lines l JOIN inv_products p ON p.id = l.product_id
          WHERE l.transfer_id = ? ORDER BY l.id`,
        [id]
    );
    const from = await findBranch(conn, row.from_branch_id);
    const to = await findBranch(conn, row.to_branch_id);
    return { row, lines, from, to };
}

function productOf(line) {
    return { id: Number(line.product_id), sku: line.sku, name: line.name };
}

/** Optional per-line quantities from the app: [{ inventoryId, qty }]. */
function quantitiesFrom(raw, lines, field, fallback) {
    const given = new Map();
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const key = String(item?.inventoryId || "").trim().toUpperCase();
            const qty = Number(item?.qty);
            if (!key) continue;
            if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, `${field} quantity for ${key} must be zero or more.`);
            given.set(key, Math.round(qty * 10000) / 10000);
        }
    }
    return new Map(lines.map((l) => [Number(l.id), given.has(String(l.sku).toUpperCase())
        ? given.get(String(l.sku).toUpperCase())
        : num(fallback(l))]));
}

export async function transferAction(member, id, action, body, request) {
    await withLedgerTx(async (conn) => {
        const { row, lines, from, to } = await lockTransfer(conn, id);
        assertTransferAction(row.status, action);
        const audit = { entityType: "transfer", entityId: id, request, details: { number: row.transfer_number } };

        if (action === "approve") {
            assertApprove(member, from, request, "transfer.approve");
            assertNotOwnRequest(member, row.requested_by);
            await applyBalanceChanges(conn, from.id, lines.map((l) => ({ product: productOf(l), reserved: num(l.qty_requested) })));
            await conn.query(
                "UPDATE inv_transfers SET status = 'approved', approved_by = ?, approved_at = UTC_TIMESTAMP() WHERE id = ?",
                [member.loginId, id]
            );
            await writeAudit(conn, member, { ...audit, action: "transfer.approve", branchId: from.id });
            return;
        }

        if (action === "reject") {
            assertApprove(member, from, request, "transfer.reject");
            const reason = String(body.reason || "").trim().slice(0, 500);
            if (!reason) throw new HttpError(400, "Say why the transfer is rejected.");
            await conn.query(
                "UPDATE inv_transfers SET status = 'rejected', approved_by = ?, approved_at = UTC_TIMESTAMP(), rejection_reason = ? WHERE id = ?",
                [member.loginId, reason, id]
            );
            await writeAudit(conn, member, { ...audit, action: "transfer.reject", branchId: from.id, details: { ...audit.details, reason } });
            return;
        }

        if (action === "cancel") {
            const own = String(row.requested_by).toUpperCase() === member.loginId;
            if (!own) assertApprove(member, from, request, "transfer.cancel");
            if (row.status === "approved") {
                await applyBalanceChanges(conn, from.id, lines.map((l) => ({ product: productOf(l), reserved: -num(l.qty_requested) })));
            }
            const reason = String(body.reason || "").trim().slice(0, 500) || null;
            await conn.query("UPDATE inv_transfers SET status = 'cancelled', rejection_reason = COALESCE(?, rejection_reason) WHERE id = ?", [reason, id]);
            await writeAudit(conn, member, { ...audit, action: "transfer.cancel", branchId: from.id, details: { ...audit.details, reason } });
            return;
        }

        if (action === "dispatch") {
            assertOperate(member, from, request, "transfer.dispatch");
            const sent = quantitiesFrom(body.lines, lines, "Sent", (l) => l.qty_requested);
            if ([...sent.values()].every((q) => q === 0)) throw new HttpError(400, "Nothing is being sent. Cancel the transfer instead.");
            for (const l of lines) {
                if (sent.get(Number(l.id)) > num(l.qty_requested)) {
                    throw new HttpError(400, `You can send at most ${num(l.qty_requested)} of ${l.sku} (the approved quantity).`);
                }
            }
            await applyBalanceChanges(conn, from.id, lines.map((l) => ({ product: productOf(l), reserved: -num(l.qty_requested) })));
            const outLines = lines.filter((l) => sent.get(Number(l.id)) > 0);
            const txn = await insertTransaction(conn, member, {
                type: "transfer_out", branchId: from.id, reasonCode: row.reason_code, transferId: id,
                referenceNo: row.transfer_number, notes: `To ${to.name}`, requestId: randomUUID(),
                lines: outLines.map((l) => ({ product: productOf(l), qtyChange: -sent.get(Number(l.id)) })),
            });
            await applyBalanceChanges(conn, to.id, outLines.map((l) => ({ product: productOf(l), inTransit: sent.get(Number(l.id)) })));
            for (const l of lines) {
                await conn.query("UPDATE inv_transfer_lines SET qty_sent = ? WHERE id = ?", [sent.get(Number(l.id)), l.id]);
            }
            await conn.query(
                "UPDATE inv_transfers SET status = 'in_transit', dispatched_by = ?, dispatched_at = UTC_TIMESTAMP() WHERE id = ?",
                [member.loginId, id]
            );
            await writeAudit(conn, member, {
                ...audit, action: "transfer.dispatch", branchId: from.id, transactionId: txn.id,
                details: { ...audit.details, movement: txn.number, sent: Object.fromEntries(lines.map((l) => [l.sku, sent.get(Number(l.id))])) },
            });
            return;
        }

        if (action === "receive") {
            assertOperate(member, to, request, "transfer.receive");
            const received = quantitiesFrom(body.lines, lines, "Received", (l) => l.qty_sent ?? 0);
            await applyBalanceChanges(conn, to.id, lines
                .filter((l) => num(l.qty_sent) > 0)
                .map((l) => ({ product: productOf(l), inTransit: -num(l.qty_sent) })));
            const inLines = lines.filter((l) => received.get(Number(l.id)) > 0);
            let txn = null;
            if (inLines.length) {
                txn = await insertTransaction(conn, member, {
                    type: "transfer_in", branchId: to.id, reasonCode: row.reason_code, transferId: id,
                    referenceNo: row.transfer_number, notes: `From ${from.name}`, requestId: randomUUID(),
                    lines: inLines.map((l) => ({ product: productOf(l), qtyChange: received.get(Number(l.id)) })),
                });
            }
            let variance = false;
            for (const l of lines) {
                const got = received.get(Number(l.id));
                await conn.query("UPDATE inv_transfer_lines SET qty_received = ? WHERE id = ?", [got, l.id]);
                const sentQty = num(l.qty_sent);
                if (got !== sentQty) {
                    variance = true;
                    await createCase(conn, member, {
                        branchId: to.id, productId: l.product_id, source: "transfer", sourceId: id,
                        expectedQty: sentQty, physicalQty: got,
                        note: `${row.transfer_number}: ${from.name} sent ${sentQty}, ${to.name} received ${got}.`,
                    });
                }
            }
            await conn.query(
                "UPDATE inv_transfers SET status = ?, received_by = ?, received_at = UTC_TIMESTAMP() WHERE id = ?",
                [variance ? "partially_received" : "received", member.loginId, id]
            );
            await resolveAlerts(conn, `transfer_overdue:${id}`);
            await writeAudit(conn, member, {
                ...audit, action: "transfer.receive", branchId: to.id, transactionId: txn?.id || null,
                details: { ...audit.details, movement: txn?.number || null, variance,
                    received: Object.fromEntries(lines.map((l) => [l.sku, received.get(Number(l.id))])) },
            });
            return;
        }

        throw new HttpError(400, `Unknown transfer action "${action}".`);
    });
    return getTransfer(id);
}
