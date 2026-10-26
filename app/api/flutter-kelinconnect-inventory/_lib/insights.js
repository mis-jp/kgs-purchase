import { HttpError } from "./errors.js";
import { getLedgerPool, ledgerStatus, transferReferenceReady, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertManager, scopeBranchIds } from "./members.js";
import { findBranch, findProducts, getSettings, raiseAlert, requireLive } from "./ledger.js";
import { ledgerCountActivity } from "./ledger-counts.js";
import { erpQuantities, getItem, listItems } from "./stock.js";
import { iso, num, person, toCsv } from "./rules.js";

/** Dashboard numbers, lookups, watchlist, shelves, ERP comparison, audit log, CSV reports. */

function branchClause(branch, column = "b.code") {
    return branch ? { sql: `AND ${column} = ?`, params: [branch.toUpperCase()] } : { sql: "", params: [] };
}

export async function dashboardActivity({ branch }) {
    const pool = getLedgerPool();
    const bc = branchClause(branch);
    const [[row]] = await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM inv_transactions t JOIN inv_branches b ON b.id = t.branch_id
              WHERE t.status = 'pending_approval' ${bc.sql}) AS pending_movements,
            (SELECT COUNT(*) FROM inv_adjustments a JOIN inv_branches b ON b.id = a.branch_id
              WHERE a.status = 'pending_approval' ${bc.sql}) AS pending_adjustments,
            (SELECT COUNT(*) FROM inv_transfers t JOIN inv_branches b ON b.id = t.from_branch_id
              WHERE t.status = 'pending_approval' ${bc.sql}) AS pending_transfers,
            (SELECT COUNT(*) FROM inv_transfers t JOIN inv_branches b ON b.id = t.to_branch_id
              WHERE t.status = 'in_transit' ${bc.sql}) AS incoming_transfers,
            (SELECT COUNT(*) FROM inv_transfers t JOIN inv_branches b ON b.id = t.from_branch_id
              WHERE t.status = 'approved' ${bc.sql}) AS to_dispatch,
            (SELECT COUNT(*) FROM inv_discrepancy_cases c JOIN inv_branches b ON b.id = c.branch_id
              WHERE c.status IN ('open', 'investigating') ${bc.sql}) AS open_cases,
            (SELECT COUNT(*) FROM inv_alerts a LEFT JOIN inv_branches b ON b.id = a.branch_id
              WHERE a.status = 'new' ${bc.sql}) AS new_alerts,
            (SELECT COUNT(*) FROM inv_transactions t JOIN inv_branches b ON b.id = t.branch_id
              WHERE t.status = 'completed' AND t.created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY ${bc.sql}) AS movements_today`,
        [...bc.params, ...bc.params, ...bc.params, ...bc.params, ...bc.params, ...bc.params, ...bc.params, ...bc.params]
    );
    const counts = await ledgerCountActivity({ branch });
    return {
        pendingMovements: num(row.pending_movements),
        pendingAdjustments: num(row.pending_adjustments),
        pendingTransfers: num(row.pending_transfers),
        pendingApprovals: num(row.pending_movements) + num(row.pending_adjustments) + num(row.pending_transfers),
        incomingTransfers: num(row.incoming_transfers),
        transfersToDispatch: num(row.to_dispatch),
        openCases: num(row.open_cases),
        newAlerts: num(row.new_alerts),
        movementsToday: num(row.movements_today),
        ...counts,
    };
}

export async function recentActivity({ branch, limit = 15 }) {
    const bc = branchClause(branch);
    const [rows] = await getLedgerPool().query(
        `SELECT t.id, t.txn_number, t.type, t.status, t.created_by, t.created_by_name, t.created_at,
                b.code AS branch_code, b.name AS branch_name, rc.label AS reason_label,
                (SELECT COUNT(*) FROM inv_transaction_lines l WHERE l.transaction_id = t.id) AS line_count,
                (SELECT COALESCE(SUM(l.qty_change), 0) FROM inv_transaction_lines l WHERE l.transaction_id = t.id) AS total_qty,
                (SELECT p.name FROM inv_transaction_lines l JOIN inv_products p ON p.id = l.product_id
                  WHERE l.transaction_id = t.id ORDER BY l.id LIMIT 1) AS first_item
           FROM inv_transactions t
           JOIN inv_branches b ON b.id = t.branch_id
           LEFT JOIN inv_reason_codes rc ON rc.code = t.reason_code
          WHERE t.type <> 'opening' ${bc.sql}
          ORDER BY t.created_at DESC, t.id DESC LIMIT ${Math.min(50, Math.max(1, limit))}`,
        bc.params
    );
    return rows.map((r) => ({
        id: Number(r.id),
        number: r.txn_number,
        type: r.type,
        status: r.status,
        branch: r.branch_code,
        branchName: r.branch_name,
        reasonLabel: r.reason_label || "",
        lineCount: num(r.line_count),
        totalQty: num(r.total_qty),
        firstItem: r.first_item || "",
        createdBy: person(r.created_by, r.created_by_name),
        createdAt: iso(r.created_at),
    }));
}

/** Barcode / SKU lookup. */
export async function scanLookup(code) {
    const raw = String(code || "").trim();
    if (!raw) throw new HttpError(400, "Scan or type a barcode or SKU.");
    const status = await ledgerStatus();
    if (status.ready) {
        try {
            const products = await findProducts(getLedgerPool(), [raw], { activeOnly: false });
            const p = products.get(raw.toUpperCase());
            return { inventoryId: p.sku, description: p.name, barcode: p.barcode || "", status: p.status };
        } catch (err) {
            if (!(err instanceof HttpError) || err.status !== 404) throw err;
        }
    }
    const item = await getItem(raw).catch(() => null);
    if (!item) throw new HttpError(404, `No item matches "${raw}".`);
    return { inventoryId: item.inventoryId, description: item.description, barcode: "", status: "active" };
}

export async function listWatchlist(member) {
    const [rows] = await getLedgerPool().query(
        "SELECT p.sku FROM inv_watchlist w JOIN inv_products p ON p.id = w.product_id WHERE w.login_id = ? ORDER BY w.created_at DESC",
        [member.loginId]
    );
    if (!rows.length) return [];
    const page = await listItems({ ids: rows.map((r) => r.sku), page: 1, pageSize: 200 });
    return page.items;
}

export async function setWatch(member, sku, watching) {
    const pool = getLedgerPool();
    const product = (await findProducts(pool, [sku], { activeOnly: false })).get(String(sku).trim().toUpperCase());
    if (watching) {
        await pool.query("INSERT IGNORE INTO inv_watchlist (login_id, product_id) VALUES (?, ?)", [member.loginId, product.id]);
    } else {
        await pool.query("DELETE FROM inv_watchlist WHERE login_id = ? AND product_id = ?", [member.loginId, product.id]);
    }
    return { inventoryId: product.sku, watching: !!watching };
}

/** Ledger facts for the item screen: per-branch shelf, minimum, reserved, in transit, last count. */
export async function itemLedgerInfo(member, sku) {
    const pool = getLedgerPool();
    let product;
    try {
        product = (await findProducts(pool, [sku], { activeOnly: false })).get(String(sku).trim().toUpperCase());
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
    }
    const [rows] = await pool.query(
        `SELECT b.code, b.live_since, bal.qty_on_hand, bal.qty_reserved, bal.qty_in_transit, bal.last_counted_at,
                loc.code AS location_code, s.min_stock, s.max_stock
           FROM inv_branches b
           LEFT JOIN inv_balances bal ON bal.branch_id = b.id AND bal.product_id = ?
           LEFT JOIN inv_product_branch_settings s ON s.branch_id = b.id AND s.product_id = ?
           LEFT JOIN inv_locations loc ON loc.id = s.default_location_id
          WHERE b.live_since IS NOT NULL OR s.product_id IS NOT NULL`,
        [product.id, product.id]
    );
    const [[watch]] = await pool.query("SELECT 1 AS w FROM inv_watchlist WHERE login_id = ? AND product_id = ?",
        [member.loginId, product.id]);
    return {
        barcode: product.barcode || "",
        unit: product.unit_code,
        minStock: num(product.min_stock),
        watching: !!watch,
        branches: rows.map((r) => ({
            branch: r.code,
            live: !!r.live_since,
            reserved: num(r.qty_reserved),
            inTransit: num(r.qty_in_transit),
            lastCountedAt: iso(r.last_counted_at),
            location: r.location_code || "",
            minStock: r.min_stock === null ? null : num(r.min_stock),
            maxStock: r.max_stock === null ? null : num(r.max_stock),
        })),
    };
}

export async function saveItemBranchSettings(member, sku, body, request) {
    await withLedgerTx(async (conn) => {
        const branch = await findBranch(conn, body.branch);
        assertApprove(member, branch, request, "product.update");
        const product = (await findProducts(conn, [sku], { activeOnly: false })).get(String(sku).trim().toUpperCase());
        let locationId = null;
        const locationCode = String(body.location || "").trim().toUpperCase();
        if (locationCode) {
            const [[loc]] = await conn.query("SELECT id FROM inv_locations WHERE branch_id = ? AND code = ? AND status = 'active'",
                [branch.id, locationCode]);
            if (!loc) throw new HttpError(404, `Shelf ${locationCode} does not exist at ${branch.name}. Add it first.`);
            locationId = Number(loc.id);
        }
        const minStock = body.minStock === null || body.minStock === undefined || body.minStock === "" ? null : Number(body.minStock);
        if (minStock !== null && (!Number.isFinite(minStock) || minStock < 0)) throw new HttpError(400, "Minimum stock must be zero or more.");
        await conn.query(
            `INSERT INTO inv_product_branch_settings (product_id, branch_id, min_stock, default_location_id, updated_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE min_stock = VALUES(min_stock), default_location_id = VALUES(default_location_id),
                                     updated_by = VALUES(updated_by)`,
            [product.id, branch.id, minStock, locationId, member.loginId]
        );
        await writeAudit(conn, member, {
            action: "product.update", entityType: "product", entityId: product.id, branchId: branch.id, productId: product.id,
            request, details: { location: locationCode || null, minStock },
        });
    });
    return itemLedgerInfo(member, sku);
}

export async function listLocations(branchCode) {
    const pool = getLedgerPool();
    const branch = await findBranch(pool, branchCode);
    const [rows] = await pool.query(
        `SELECT l.*, (SELECT COUNT(*) FROM inv_product_branch_settings s WHERE s.default_location_id = l.id) AS item_count
           FROM inv_locations l WHERE l.branch_id = ? AND l.status = 'active' ORDER BY l.sort_order, l.code`,
        [branch.id]
    );
    return rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name || "", zone: r.zone || "", itemCount: num(r.item_count),
    }));
}

export async function addLocation(member, branchCode, body, request) {
    const code = String(body.code || "").trim().toUpperCase().slice(0, 50);
    if (!/^[A-Z0-9][A-Z0-9 ._/-]*$/.test(code)) throw new HttpError(400, "Shelf code uses letters, numbers, - . / (e.g. A-01-03).");
    await withLedgerTx(async (conn) => {
        const branch = await findBranch(conn, branchCode);
        assertApprove(member, branch, request, "location.create");
        await conn.query(
            `INSERT INTO inv_locations (branch_id, code, name, zone) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), zone = VALUES(zone), status = 'active'`,
            [branch.id, code, String(body.name || "").trim().slice(0, 120) || null, String(body.zone || "").trim().slice(0, 50) || null]
        );
        await writeAudit(conn, member, { action: "location.create", entityType: "location", entityId: code, branchId: branch.id, request });
    });
    return listLocations(branchCode);
}

/** App balance vs Acumatica for one live branch. Flags big differences as alerts. */
export async function erpCompare(member, { branch, onlyDifferences, search, page, pageSize }, request) {
    assertManager(member, request, "erp.compare");
    const pool = getLedgerPool();
    const b = await findBranch(pool, branch);
    requireLive(b);
    const erp = await erpQuantities(b.erpWarehouseId || b.code);
    const params = [b.id];
    let filter = "";
    if (search) {
        filter = "AND (UPPER(p.sku) LIKE ? OR UPPER(p.name) LIKE ?)";
        params.push(`%${search.toUpperCase()}%`, `%${search.toUpperCase()}%`);
    }
    const [rows] = await pool.query(
        `SELECT p.id, p.sku, p.name, p.erp_inventory_id, bal.qty_on_hand
           FROM inv_balances bal JOIN inv_products p ON p.id = bal.product_id
          WHERE bal.branch_id = ? ${filter}`,
        params
    );
    const settings = await getSettings(pool);
    const tolerance = num(settings.erp_mismatch_units);
    const seen = new Set();
    const all = rows.map((r) => {
        const key = String(r.erp_inventory_id || r.sku).toUpperCase();
        seen.add(key);
        const e = erp.get(key);
        const erpQty = e ? e.onHand : 0;
        return {
            inventoryId: r.sku, description: r.name, appQty: num(r.qty_on_hand), erpQty,
            difference: num(r.qty_on_hand) - erpQty, erpLastSync: e?.lastSync || null, productId: Number(r.id),
        };
    });
    for (const [key, e] of erp.entries()) {
        if (seen.has(key) || e.onHand === 0) continue;
        if (search && !key.includes(search.toUpperCase())) continue;
        all.push({ inventoryId: key, description: "", appQty: 0, erpQty: e.onHand, difference: -e.onHand, erpLastSync: e.lastSync, productId: null });
    }
    const flagged = all.filter((r) => Math.abs(r.difference) > tolerance);
    for (const r of flagged.slice(0, 200)) {
        if (!r.productId) continue;
        await raiseAlert(pool, {
            type: "erp_mismatch", severity: "info", branchId: b.id, productId: r.productId,
            message: `${r.description || r.inventoryId} at ${b.name}: app ${r.appQty}, Acumatica ${r.erpQty}.`,
            dedupeKey: `erp_mismatch:${b.id}:${r.productId}`,
        });
    }
    const list = (onlyDifferences ? flagged : all).sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference));
    const offset = (page - 1) * pageSize;
    return {
        branch: b.code,
        tolerance,
        totalItems: all.length,
        differences: flagged.length,
        rows: list.slice(offset, offset + pageSize).map(({ productId, ...r }) => r),
        page,
        pageSize,
        totalCount: list.length,
        hasMore: offset + pageSize < list.length,
    };
}

export async function listAuditLogs(member, { branch, action, actor, from, to, page, pageSize }) {
    const where = [];
    const params = [];
    if (member.role === "staff" || member.role === "viewer") {
        where.push("a.actor_login_id = ?");
        params.push(member.loginId);
    } else {
        const scope = scopeBranchIds(member);
        if (scope) {
            where.push(scope.length ? `(a.branch_id IN (${scope.map(() => "?").join(", ")}) OR a.actor_login_id = ?)` : "a.actor_login_id = ?");
            params.push(...scope, member.loginId);
        }
    }
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (action) {
        where.push("a.action LIKE ?");
        params.push(`${action}%`);
    }
    if (actor) {
        where.push("a.actor_login_id = ?");
        params.push(actor.toUpperCase());
    }
    if (from) {
        where.push("a.occurred_at >= ?");
        params.push(new Date(from));
    }
    if (to) {
        where.push("a.occurred_at < ?");
        params.push(new Date(to));
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `SELECT a.*, b.code AS branch_code, p.sku FROM inv_audit_logs a
           LEFT JOIN inv_branches b ON b.id = a.branch_id
           LEFT JOIN inv_products p ON p.id = a.product_id
          ${sqlWhere} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_audit_logs a LEFT JOIN inv_branches b ON b.id = a.branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return {
        logs: rows.map((r) => ({
            id: Number(r.id),
            at: iso(r.occurred_at),
            actor: person(r.actor_login_id, r.actor_name),
            role: r.actor_role || "",
            action: r.action,
            outcome: r.outcome,
            entityType: r.entity_type || "",
            entityId: r.entity_id || "",
            branch: r.branch_code || "",
            inventoryId: r.sku || "",
            details: typeof r.details === "string" ? safeJson(r.details) : r.details || null,
        })),
        page, pageSize, totalCount: total, hasMore: offset + rows.length < total,
    };
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export const REPORTS = ["stock", "movements", "adjustments", "discrepancies", "transfers", "user-activity"];

function dateRange(from, to) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new HttpError(400, "Dates must look like 2026-10-21.");
    return [start, end];
}

/** CSV export. Returns { filename, csv }. */
export async function buildReport(member, name, { branch, from, to }, request) {
    assertManager(member, request, "report.export");
    if (!REPORTS.includes(name)) throw new HttpError(404, `Unknown report ${name}. Use ${REPORTS.join(", ")}.`);
    const pool = getLedgerPool();
    const bc = branchClause(branch);
    const [start, end] = dateRange(from, to);
    let headers;
    let rows;

    if (name === "stock") {
        const page = await listItems({ branch, page: 1, pageSize: 50000 });
        headers = ["SKU", "Description", "Category", "On hand", "Available", "Status", "Branches in stock", "Branches", "Last update"];
        rows = page.items.map((i) => [i.inventoryId, i.description, i.itemClass, i.onHand, i.available, i.status,
            i.branchesInStock, i.branchCount, i.lastSync]);
    } else if (name === "movements") {
        const [data] = await pool.query(
            `SELECT t.created_at, t.txn_number, t.type, t.status, b.code, p.sku, p.name, l.qty_change, l.qty_before, l.qty_after,
                    rc.label, t.reference_no, t.created_by, t.created_by_name, t.approved_by, t.notes
               FROM inv_transaction_lines l
               JOIN inv_transactions t ON t.id = l.transaction_id
               JOIN inv_branches b ON b.id = t.branch_id
               JOIN inv_products p ON p.id = l.product_id
               LEFT JOIN inv_reason_codes rc ON rc.code = t.reason_code
              WHERE t.created_at >= ? AND t.created_at < ? ${bc.sql}
              ORDER BY t.created_at, t.id, l.id LIMIT 100000`,
            [start, end, ...bc.params]
        );
        headers = ["Date (UTC)", "Number", "Type", "Status", "Branch", "SKU", "Description", "Change", "Before", "After",
            "Reason", "Reference", "By", "By name", "Approved by", "Notes"];
        rows = data.map((r) => Object.values(r));
    } else if (name === "adjustments") {
        const [data] = await pool.query(
            `SELECT a.requested_at, a.adjustment_number, a.status, a.source, b.code, p.sku, p.name, l.system_qty, l.counted_qty,
                    l.difference, a.reason_code, a.requested_by, a.approved_by, a.decided_at, a.rejection_reason
               FROM inv_adjustment_lines l
               JOIN inv_adjustments a ON a.id = l.adjustment_id
               JOIN inv_branches b ON b.id = a.branch_id
               JOIN inv_products p ON p.id = l.product_id
              WHERE a.requested_at >= ? AND a.requested_at < ? ${bc.sql}
              ORDER BY a.requested_at, a.id LIMIT 100000`,
            [start, end, ...bc.params]
        );
        headers = ["Requested (UTC)", "Number", "Status", "Source", "Branch", "SKU", "Description", "System", "Counted",
            "Difference", "Reason", "Requested by", "Decided by", "Decided (UTC)", "Rejection reason"];
        rows = data.map((r) => Object.values(r));
    } else if (name === "discrepancies") {
        const [data] = await pool.query(
            `SELECT c.opened_at, c.case_number, c.status, c.source, b.code, p.sku, p.name, c.expected_qty, c.physical_qty,
                    c.difference, c.resolution, c.assigned_to, c.findings, c.closed_by, c.closed_at
               FROM inv_discrepancy_cases c
               JOIN inv_branches b ON b.id = c.branch_id
               JOIN inv_products p ON p.id = c.product_id
              WHERE c.opened_at >= ? AND c.opened_at < ? ${bc.sql}
              ORDER BY c.opened_at LIMIT 100000`,
            [start, end, ...bc.params]
        );
        headers = ["Opened (UTC)", "Case", "Status", "Source", "Branch", "SKU", "Description", "Expected", "Physical",
            "Difference", "Resolution", "Assigned to", "Findings", "Closed by", "Closed (UTC)"];
        rows = data.map((r) => Object.values(r));
    } else if (name === "transfers") {
        const fromClause = branchClause(branch, "fb.code");
        const toClause = branchClause(branch, "tb.code");
        const branchSql = branch ? `AND (${fromClause.sql.slice(4)} OR ${toClause.sql.slice(4)})` : "";
        const reference = (await transferReferenceReady()) ? "t.reference_no" : "NULL";
        const [data] = await pool.query(
            `SELECT t.requested_at, t.transfer_number, ${reference} AS reference_no, t.status, fb.code AS from_code,
                    tb.code AS to_code, p.sku, p.name,
                    l.qty_requested, l.qty_sent, l.qty_received, t.requested_by, t.approved_by, t.dispatched_at, t.received_at
               FROM inv_transfer_lines l
               JOIN inv_transfers t ON t.id = l.transfer_id
               JOIN inv_branches fb ON fb.id = t.from_branch_id
               JOIN inv_branches tb ON tb.id = t.to_branch_id
               JOIN inv_products p ON p.id = l.product_id
              WHERE t.requested_at >= ? AND t.requested_at < ? ${branchSql}
              ORDER BY t.requested_at LIMIT 100000`,
            [start, end, ...(branch ? [...fromClause.params, ...toClause.params] : [])]
        );
        headers = ["Requested (UTC)", "Number", "Reference", "Status", "From", "To", "SKU", "Description", "Requested", "Sent",
            "Received", "Requested by", "Approved by", "Dispatched (UTC)", "Received (UTC)"];
        rows = data.map((r) => Object.values(r));
    } else {
        const [data] = await pool.query(
            `SELECT a.occurred_at, a.actor_login_id, a.actor_name, a.actor_role, a.action, a.outcome, b.code, a.entity_type, a.entity_id
               FROM inv_audit_logs a LEFT JOIN inv_branches b ON b.id = a.branch_id
              WHERE a.occurred_at >= ? AND a.occurred_at < ? ${bc.sql}
              ORDER BY a.occurred_at LIMIT 100000`,
            [start, end, ...bc.params]
        );
        headers = ["When (UTC)", "Login id", "Name", "Role", "Action", "Outcome", "Branch", "Entity", "Entity id"];
        rows = data.map((r) => Object.values(r));
    }

    await writeAudit(null, member, {
        action: "report.export", entityType: "report", entityId: name, request,
        details: { branch: branch || "ALL", from: start.toISOString(), to: end.toISOString(), rows: rows.length },
    });
    const day = new Date().toISOString().slice(0, 10);
    return { filename: `inventory-${name}-${(branch || "all").toLowerCase()}-${day}.csv`, csv: toCsv(headers, rows) };
}
