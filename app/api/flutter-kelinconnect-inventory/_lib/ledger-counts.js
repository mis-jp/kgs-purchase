import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertOperate } from "./members.js";
import { findBranch, findByRequestId, getSettings, nextNumber, raiseAlert } from "./ledger.js";
import { createAdjustmentRecord } from "./adjustments.js";
import { erpRowsWhere, STOCK } from "./admin.js";
import { createCase } from "./cases.js";
import { canApprove, countLineDifference, iso, num, person } from "./rules.js";

/**
 * Physical counts on the ledger (`inv_count_sessions` / `inv_count_lines`).
 * Same JSON shape as the first version so the app screens keep working; adds blind counts,
 * recounts, and a manager review that turns differences into an adjustment + cases.
 */

export const LEDGER_LINE_FILTERS = ["all", "pending", "counted", "matched", "short", "over", "missing"];

const FINAL = "COALESCE(l.recount_qty, l.counted_qty)";
const LINE_STATE_SQL = `CASE
    WHEN l.is_missing = 1 THEN 'missing'
    WHEN ${FINAL} IS NULL THEN 'pending'
    WHEN ${FINAL} = l.system_qty THEN 'matched'
    WHEN ${FINAL} < l.system_qty THEN 'short'
    ELSE 'over' END`;

const SESSION_SELECT = `
    SELECT s.*, b.code AS branch_code, b.name AS branch_name, c.code AS category_code,
           loc.code AS location_code,
           (SELECT a.id FROM inv_adjustments a WHERE a.count_id = s.id ORDER BY a.id DESC LIMIT 1) AS adjustment_id,
           (SELECT a.adjustment_number FROM inv_adjustments a WHERE a.count_id = s.id ORDER BY a.id DESC LIMIT 1) AS adjustment_number,
           (SELECT a.status FROM inv_adjustments a WHERE a.count_id = s.id ORDER BY a.id DESC LIMIT 1) AS adjustment_status
      FROM inv_count_sessions s
      JOIN inv_branches b ON b.id = s.branch_id
      LEFT JOIN inv_categories c ON c.id = s.category_id
      LEFT JOIN inv_locations loc ON loc.id = s.location_id`;

function hidesSystem(member, row) {
    return Number(row.blind) === 1 && row.status === "open" && !canApprove(member, row.branch_id);
}

function mapSession(r, member) {
    const hide = hidesSystem(member, r);
    const itemCount = num(r.item_count);
    const counted = num(r.counted_count);
    return {
        id: Number(r.id),
        number: r.count_number,
        branch: r.branch_code,
        branchName: r.branch_name,
        category: r.category_code || "",
        location: r.location_code || "",
        scope: r.scope,
        blind: Number(r.blind) === 1,
        systemHidden: hide,
        status: r.status,
        note: r.note || "",
        startedBy: person(r.started_by, r.started_by_name),
        submittedBy: person(r.submitted_by, r.submitted_by),
        reviewedBy: person(r.reviewed_by, r.reviewed_by),
        itemCount,
        countedCount: counted,
        pendingCount: Math.max(0, itemCount - counted),
        matchedCount: hide ? 0 : num(r.matched_count),
        shortCount: hide ? 0 : num(r.short_count),
        overCount: hide ? 0 : num(r.over_count),
        missingCount: num(r.missing_count),
        startedAt: iso(r.started_at),
        submittedAt: iso(r.submitted_at),
        reviewedAt: iso(r.reviewed_at),
        updatedAt: iso(r.updated_at),
        adjustment: r.adjustment_id
            ? { id: Number(r.adjustment_id), number: r.adjustment_number, status: r.adjustment_status }
            : null,
        source: "ledger",
    };
}

function mapLine(r, hide) {
    const missing = num(r.is_missing) === 1;
    const counted = r.counted_qty === null ? null : num(r.counted_qty);
    const recount = r.recount_qty === null ? null : num(r.recount_qty);
    const system = num(r.system_qty);
    const diff = countLineDifference({ systemQty: system, countedQty: counted, recountQty: recount, missing });
    let state = r.state;
    if (hide && (state === "matched" || state === "short" || state === "over")) state = "counted";
    return {
        inventoryId: r.sku,
        description: r.name || "",
        itemClass: r.category_code || "",
        location: r.location_code || "",
        systemQty: hide ? null : system,
        countedQty: missing ? 0 : counted,
        recountQty: recount,
        missing,
        variance: hide ? null : diff,
        state,
        note: r.note || "",
        countedBy: person(r.counted_by, r.counted_by_name),
        countedAt: iso(r.counted_at),
    };
}

async function loadRow(conn, id, { lock = false } = {}) {
    const [[row]] = await conn.query(`SELECT * FROM inv_count_sessions WHERE id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!row) throw new HttpError(404, `Count #${id} was not found.`);
    return row;
}

async function loadSession(conn, id, member) {
    const [[row]] = await conn.query(`${SESSION_SELECT} WHERE s.id = ?`, [id]);
    if (!row) throw new HttpError(404, `Count #${id} was not found.`);
    return mapSession(row, member);
}

async function refreshTotals(conn, id) {
    await conn.query(
        `UPDATE inv_count_sessions s
           JOIN (
                SELECT l.count_id,
                       COUNT(*) AS item_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} <> 'pending' THEN 1 ELSE 0 END) AS counted_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'matched' THEN 1 ELSE 0 END) AS matched_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'short' THEN 1 ELSE 0 END) AS short_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'over' THEN 1 ELSE 0 END) AS over_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'missing' THEN 1 ELSE 0 END) AS missing_count
                  FROM inv_count_lines l WHERE l.count_id = ? GROUP BY l.count_id
           ) t ON t.count_id = s.id
            SET s.item_count = t.item_count, s.counted_count = t.counted_count, s.matched_count = t.matched_count,
                s.short_count = t.short_count, s.over_count = t.over_count, s.missing_count = t.missing_count
          WHERE s.id = ?`,
        [id, id]
    );
}

export async function listLedgerCounts(member, { branch, status, limit }) {
    const where = [];
    const params = [];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (status) {
        where.push("s.status = ?");
        params.push(status);
    }
    const [rows] = await getLedgerPool().query(
        `${SESSION_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY (s.status = 'open') DESC, (s.status = 'submitted') DESC, s.started_at DESC, s.id DESC
          LIMIT ${limit}`,
        params
    );
    return rows.map((r) => mapSession(r, member));
}

export async function ledgerCountActivity({ branch } = {}) {
    const params = [];
    let where = "";
    if (branch) {
        where = "WHERE b.code = ?";
        params.push(branch.toUpperCase());
    }
    const [[row]] = await getLedgerPool().query(
        `SELECT SUM(s.status = 'open') AS open_counts,
                SUM(s.status = 'submitted') AS to_review,
                SUM(CASE WHEN s.status IN ('submitted', 'reviewed') AND s.submitted_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY
                         THEN s.short_count + s.over_count + s.missing_count ELSE 0 END) AS discrepancies_30d,
                MAX(CASE WHEN s.status IN ('submitted', 'reviewed') THEN s.submitted_at END) AS last_submitted_at
           FROM inv_count_sessions s JOIN inv_branches b ON b.id = s.branch_id ${where}`,
        params
    );
    return {
        openCounts: num(row?.open_counts),
        countsToReview: num(row?.to_review),
        discrepancies30d: num(row?.discrepancies_30d),
        lastCountAt: iso(row?.last_submitted_at),
    };
}

export async function startLedgerCount(member, body, request) {
    const requestId = /^[0-9a-f-]{36}$/i.test(String(body.requestId || "")) ? String(body.requestId).toLowerCase() : randomUUID();
    const id = await withLedgerTx(async (conn) => {
        const existing = await findByRequestId(conn, "inv_count_sessions", requestId);
        if (existing) return Number(existing.id);
        const branch = await findBranch(conn, body.branch);
        if (branch.status !== "active") throw new HttpError(409, `${branch.name} is inactive.`);
        assertOperate(member, branch, request, "count.start");
        const settings = await getSettings(conn);
        const blind = body.blind === undefined ? num(settings.count_blind_default) === 1 : body.blind === true;
        const includeZero = body.includeZero === true;

        let categoryId = null;
        const categoryCode = String(body.category || "").trim();
        if (categoryCode) {
            const [[cat]] = await conn.query("SELECT id FROM inv_categories WHERE code = ?", [categoryCode]);
            if (!cat) throw new HttpError(404, `Category ${categoryCode} was not found.`);
            categoryId = Number(cat.id);
        }
        let locationId = null;
        const locationCode = String(body.location || "").trim().toUpperCase();
        if (locationCode) {
            const [[loc]] = await conn.query("SELECT id FROM inv_locations WHERE branch_id = ? AND code = ?", [branch.id, locationCode]);
            if (!loc) throw new HttpError(404, `Shelf ${locationCode} was not found at ${branch.name}.`);
            locationId = Number(loc.id);
        }

        // Live branches count against the app's stock; others against Acumatica on-hand (read-only).
        let stockJoin;
        let params;
        if (branch.live) {
            stockJoin = "LEFT JOIN inv_balances bal ON bal.product_id = p.id AND bal.branch_id = ?";
            params = [branch.id, branch.id];
        } else {
            const erp = erpRowsWhere("s");
            const warehouse = String(branch.erpWarehouseId || branch.code).toUpperCase();
            await conn.query(
                `INSERT IGNORE INTO inv_products (sku, name, unit_code, erp_inventory_id, status, created_by)
                 SELECT x.inv, COALESCE(x.item_name, x.inv), 'PC', x.inv, 'active', 'count'
                   FROM (SELECT CONVERT(TRIM(s.inventory_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS inv,
                                MAX(NULLIF(TRIM(s.item_name), '')) AS item_name
                           FROM ${STOCK} s WHERE ${erp.where} AND UPPER(TRIM(s.warehouse_id)) = ?
                          GROUP BY inv) x`,
                [...erp.params, warehouse]
            );
            stockJoin = `LEFT JOIN (
                    SELECT CONVERT(TRIM(s.inventory_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS inv,
                           SUM(GREATEST(COALESCE(s.on_hand, 0), 0)) AS qty_on_hand
                      FROM ${STOCK} s WHERE ${erp.where} AND UPPER(TRIM(s.warehouse_id)) = ?
                     GROUP BY inv) bal ON bal.inv = p.erp_inventory_id`;
            params = [...erp.params, warehouse, branch.id];
        }
        const where = ["p.status = 'active'"];
        if (categoryId) {
            where.push("p.category_id = ?");
            params.push(categoryId);
        }
        if (locationId) {
            where.push("pbs.default_location_id = ?");
            params.push(locationId);
        }
        if (!includeZero) where.push("COALESCE(bal.qty_on_hand, 0) <> 0");
        const [items] = await conn.query(
            `SELECT p.id, COALESCE(bal.qty_on_hand, 0) AS qty, pbs.default_location_id
               FROM inv_products p
               ${stockJoin}
               LEFT JOIN inv_product_branch_settings pbs ON pbs.product_id = p.id AND pbs.branch_id = ?
              WHERE ${where.join(" AND ")}
              ORDER BY p.sku LIMIT 20000`,
            params
        );
        if (!items.length) {
            throw new HttpError(400, includeZero ? "No items match this count." : `No items with stock at ${branch.name} for this count.`);
        }
        const number = await nextNumber(conn, "CNT");
        const scope = locationId ? "location" : categoryId ? "category" : "full";
        const [res] = await conn.query(
            `INSERT INTO inv_count_sessions
                (count_number, branch_id, scope, category_id, location_id, blind, status, note, assigned_to,
                 started_by, started_by_name, item_count, request_id)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
            [number, branch.id, scope, categoryId, locationId, blind ? 1 : 0,
                String(body.note || "").trim().slice(0, 500) || null,
                String(body.assignedTo || "").trim().toUpperCase().slice(0, 50) || null,
                member.loginId, member.name, items.length, requestId]
        );
        for (let i = 0; i < items.length; i += 500) {
            const chunk = items.slice(i, i + 500);
            await conn.query(
                `INSERT INTO inv_count_lines (count_id, product_id, location_id, system_qty)
                 VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
                chunk.flatMap((it) => [res.insertId, it.id, it.default_location_id || null, num(it.qty)])
            );
        }
        await writeAudit(conn, member, {
            action: "count.start", entityType: "count", entityId: res.insertId, branchId: branch.id, requestId, request,
            details: { number, scope, category: categoryCode || null, location: locationCode || null, blind, items: items.length },
        });
        return res.insertId;
    });
    return loadSession(getLedgerPool(), id, member);
}

export async function getLedgerCount(member, id, { filter, search, page, pageSize }) {
    const pool = getLedgerPool();
    const count = await loadSession(pool, id, member);
    const hide = count.systemHidden;
    const where = ["l.count_id = ?"];
    const params = [id];
    if (filter && filter !== "all") {
        if (hide && ["matched", "short", "over"].includes(filter)) {
            throw new HttpError(403, "This is a blind count. Results show after it is submitted.");
        }
        if (filter === "counted") where.push(`${LINE_STATE_SQL} <> 'pending'`);
        else {
            where.push(`${LINE_STATE_SQL} = ?`);
            params.push(filter);
        }
    }
    if (search) {
        const like = `%${search.toUpperCase()}%`;
        where.push("(UPPER(p.sku) LIKE ? OR UPPER(p.name) LIKE ? OR UPPER(COALESCE(p.barcode, '')) LIKE ?)");
        params.push(like, like, like);
    }
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
        `SELECT l.*, p.sku, p.name, c.code AS category_code, loc.code AS location_code, ${LINE_STATE_SQL} AS state
           FROM inv_count_lines l
           JOIN inv_products p ON p.id = l.product_id
           LEFT JOIN inv_categories c ON c.id = p.category_id
           LEFT JOIN inv_locations loc ON loc.id = l.location_id
          WHERE ${where.join(" AND ")}
          ORDER BY (${LINE_STATE_SQL} = 'pending') DESC, loc.code IS NULL, loc.code, p.sku
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_count_lines l JOIN inv_products p ON p.id = l.product_id
          WHERE ${where.join(" AND ")}`,
        params
    );
    const total = num(countRow?.total);
    return {
        count,
        lines: rows.map((r) => mapLine(r, hide)),
        page,
        pageSize,
        totalCount: total,
        hasMore: offset + rows.length < total,
    };
}

export async function saveLedgerLines(member, id, lines, request) {
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, "Nothing to save.");
    if (lines.length > 500) throw new HttpError(400, "Save at most 500 lines at a time.");
    let updated = 0;
    await withLedgerTx(async (conn) => {
        const row = await loadRow(conn, id, { lock: true });
        const branch = await findBranch(conn, row.branch_id);
        const recounting = row.status === "submitted";
        if (row.status !== "open" && !recounting) {
            throw new HttpError(409, `Count #${id} is already ${row.status}. Start a new count to make changes.`);
        }
        if (recounting) assertApprove(member, branch, request, "count.recount");
        else assertOperate(member, branch, request, "count.line_save");

        for (const raw of lines) {
            const sku = String(raw?.inventoryId || "").trim();
            if (!sku) continue;
            const missing = raw?.missing === true;
            const clear = raw?.clear === true;
            let qty = null;
            if (!missing && !clear) {
                qty = Number(recounting ? (raw?.recountQty ?? raw?.countedQty) : raw?.countedQty);
                if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, `Counted quantity for ${sku} must be zero or more.`);
            }
            const note = raw?.note === undefined ? null : String(raw.note || "").trim().slice(0, 500);
            const target = `l.count_id = ? AND l.product_id = (SELECT id FROM inv_products WHERE sku = ?)`;
            const [res] = recounting
                ? await conn.query(
                    `UPDATE inv_count_lines l SET recount_qty = ?, is_missing = IF(? = 1, 1, IF(? IS NULL, is_missing, 0)),
                            note = COALESCE(?, note)
                      WHERE ${target}`,
                    [clear ? null : (missing ? 0 : qty), missing ? 1 : 0, clear ? null : qty, note, id, sku])
                : await conn.query(
                    `UPDATE inv_count_lines l
                        SET counted_qty = ?, recount_qty = NULL, is_missing = ?, note = COALESCE(?, note),
                            counted_by = ?, counted_by_name = ?, counted_at = ?
                      WHERE ${target}`,
                    [clear ? null : (missing ? 0 : qty), missing ? 1 : 0, note,
                        clear ? null : member.loginId, clear ? null : member.name, clear ? null : new Date(), id, sku]);
            updated += res.affectedRows || 0;
        }
        await refreshTotals(conn, id);
        await writeAudit(conn, member, {
            action: recounting ? "count.recount" : "count.line_save", entityType: "count", entityId: id,
            branchId: branch.id, request, details: { lines: lines.length, updated },
        });
    });
    return { updated, count: await loadSession(getLedgerPool(), id, member) };
}

export async function submitLedgerCount(member, id, request) {
    await withLedgerTx(async (conn) => {
        const row = await loadRow(conn, id, { lock: true });
        if (row.status !== "open") throw new HttpError(409, `Count #${id} is already ${row.status}.`);
        const branch = await findBranch(conn, row.branch_id);
        assertOperate(member, branch, request, "count.submit");
        await refreshTotals(conn, id);
        await conn.query(
            "UPDATE inv_count_sessions SET status = 'submitted', submitted_at = UTC_TIMESTAMP(), submitted_by = ? WHERE id = ?",
            [member.loginId, id]
        );
        await writeAudit(conn, member, { action: "count.submit", entityType: "count", entityId: id, branchId: branch.id, request });
    });
    return loadSession(getLedgerPool(), id, member);
}

export async function cancelLedgerCount(member, id, request) {
    await withLedgerTx(async (conn) => {
        const row = await loadRow(conn, id, { lock: true });
        if (row.status !== "open" && row.status !== "submitted") throw new HttpError(409, `Count #${id} is already ${row.status}.`);
        const branch = await findBranch(conn, row.branch_id);
        if (String(row.started_by).toUpperCase() !== member.loginId) assertApprove(member, branch, request, "count.cancel");
        await conn.query("UPDATE inv_count_sessions SET status = 'cancelled' WHERE id = ?", [id]);
        await writeAudit(conn, member, { action: "count.cancel", entityType: "count", entityId: id, branchId: branch.id, request });
    });
    return loadSession(getLedgerPool(), id, member);
}

/** Manager review: differences become one adjustment (approval) and big ones open cases. */
export async function reviewLedgerCount(member, id, body, request) {
    const result = await withLedgerTx(async (conn) => {
        const row = await loadRow(conn, id, { lock: true });
        if (row.status !== "submitted") throw new HttpError(409, `Count #${id} must be submitted before review (now ${row.status}).`);
        const branch = await findBranch(conn, row.branch_id);
        assertApprove(member, branch, request, "count.review");
        const settings = await getSettings(conn);
        const caseAbove = num(settings.adjustment_auto_approve_units);

        const [lines] = await conn.query(
            `SELECT l.*, p.sku, p.name, p.status AS product_status FROM inv_count_lines l
               JOIN inv_products p ON p.id = l.product_id
              WHERE l.count_id = ? AND (l.is_missing = 1 OR COALESCE(l.recount_qty, l.counted_qty) IS NOT NULL)`,
            [id]
        );
        const diffs = [];
        for (const l of lines) {
            const diff = countLineDifference({
                systemQty: num(l.system_qty),
                countedQty: l.counted_qty === null ? null : num(l.counted_qty),
                recountQty: l.recount_qty === null ? null : num(l.recount_qty),
                missing: num(l.is_missing) === 1,
            });
            if (diff) diffs.push({ line: l, diff });
        }

        let adjustment = null;
        let cases = 0;
        if (diffs.length && branch.live) {
            adjustment = await createAdjustmentRecord(conn, member, {
                branch,
                source: "count",
                countId: id,
                reasonCode: "PHYSICAL_COUNT",
                notes: String(body?.notes || "").trim().slice(0, 1000) || `From count ${row.count_number}`,
                requestId: randomUUID(),
                lines: diffs.map(({ line, diff }) => ({
                    product: { id: Number(line.product_id), sku: line.sku, name: line.name },
                    systemQty: num(line.system_qty),
                    countedQty: num(line.system_qty) + diff,
                    note: line.note || null,
                })),
            }, request);
        }
        for (const { line, diff } of diffs) {
            if (Math.abs(diff) > caseAbove && diff < 0) {
                const c = await createCase(conn, member, {
                    branchId: branch.id, productId: line.product_id, source: "count", sourceId: id,
                    expectedQty: num(line.system_qty), physicalQty: num(line.system_qty) + diff,
                    note: `${row.count_number}: expected ${num(line.system_qty)}, found ${num(line.system_qty) + diff}.`,
                });
                cases += 1;
                await raiseAlert(conn, {
                    type: "count_variance", severity: num(line.is_missing) === 1 ? "critical" : "warning",
                    branchId: branch.id, productId: line.product_id, entityType: "case", entityId: c.id,
                    message: `${line.name} (${line.sku}) at ${branch.name}: ${Math.abs(diff)} short in ${row.count_number}. Case ${c.number}.`,
                    dedupeKey: `case:${c.id}`,
                });
            }
        }
        if (adjustment) adjustment.cases = cases;
        await conn.query(
            `UPDATE inv_balances bal JOIN inv_count_lines l ON l.product_id = bal.product_id AND bal.branch_id = ?
                SET bal.last_counted_at = UTC_TIMESTAMP()
              WHERE l.count_id = ? AND (l.is_missing = 1 OR COALESCE(l.recount_qty, l.counted_qty) IS NOT NULL)`,
            [branch.id, id]
        );
        await conn.query(
            "UPDATE inv_count_sessions SET status = 'reviewed', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?",
            [member.loginId, id]
        );
        await writeAudit(conn, member, {
            action: "count.review", entityType: "count", entityId: id, branchId: branch.id, request,
            details: { number: row.count_number, differences: diffs.length, adjustment: adjustment?.number || null },
        });
        return { adjustment, differences: diffs.length, cases, stockSource: branch.live ? "app" : "acumatica" };
    });
    return { count: await loadSession(getLedgerPool(), id, member), ...result };
}
