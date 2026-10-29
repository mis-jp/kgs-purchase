import { HttpError } from "./errors.js";
import { getLedgerPool } from "./ledger-db.js";
import { formatDocNumber, manilaDay, num } from "./rules.js";

/**
 * Shared ledger helpers. `applyBalanceChanges` is the only code that updates `inv_balances`;
 * every caller runs inside `withLedgerTx` and records an `inv_transactions` row.
 */

const SETTING_DEFAULTS = {
    low_stock_default: 10,
    adjustment_auto_approve_units: 0,
    large_release_units: 50,
    transfer_overdue_days: 3,
    repeated_adjustment_count: 3,
    count_blind_default: 0,
    erp_mismatch_units: 1,
};
const settingsKey = "__kcInventorySettings";

export async function getSettings(conn = getLedgerPool(), { fresh = false } = {}) {
    const hit = globalThis[settingsKey];
    if (!fresh && hit && hit.until > Date.now()) return hit.value;
    const [rows] = await conn.query("SELECT setting_key, setting_value FROM inv_settings");
    const value = { ...SETTING_DEFAULTS };
    for (const r of rows) {
        const n = Number(r.setting_value);
        value[r.setting_key] = Number.isFinite(n) ? n : r.setting_value;
    }
    globalThis[settingsKey] = { value, until: Date.now() + 60_000 };
    return value;
}

export function clearSettingsCache() {
    globalThis[settingsKey] = null;
}

export function mapBranch(row) {
    return {
        id: Number(row.id),
        code: String(row.code),
        name: row.name || row.code,
        type: row.type,
        live: !!row.live_since,
        liveSince: row.live_since ? new Date(row.live_since).toISOString() : null,
        status: row.status,
        erpWarehouseId: row.erp_warehouse_id || null,
        managerLoginId: row.manager_login_id || null,
    };
}

/** Branch by code (case-insensitive) or numeric id. */
export async function findBranch(conn, ref) {
    const raw = String(ref ?? "").trim();
    if (!raw) throw new HttpError(400, "Pick a branch.");
    const [[row]] = /^\d+$/.test(raw)
        ? await conn.query("SELECT * FROM inv_branches WHERE id = ?", [Number(raw)])
        : await conn.query("SELECT * FROM inv_branches WHERE code = ?", [raw.toUpperCase()]);
    if (!row) throw new HttpError(404, `Branch ${raw} is not in the Inventory branch list.`);
    return mapBranch(row);
}

export function requireLive(branch) {
    if (branch.status !== "active") throw new HttpError(409, `${branch.name} is inactive.`);
    if (!branch.live) {
        throw new HttpError(409, `${branch.name} is not live yet. An admin must start it (Go live) before stock can move.`);
    }
}

/** Products by SKU / ERP id / barcode / numeric id. Returns Map(upper ref -> product). */
export async function findProducts(conn, refs, { activeOnly = true } = {}) {
    const unique = [...new Set(refs.map((r) => String(r).trim()).filter(Boolean))];
    if (!unique.length) return new Map();
    const marks = unique.map(() => "?").join(", ");
    const upper = unique.map((r) => r.toUpperCase());
    const ids = unique.filter((r) => /^\d+$/.test(r)).map(Number);
    const [rows] = await conn.query(
        `SELECT p.*, c.code AS category_code FROM inv_products p
           LEFT JOIN inv_categories c ON c.id = p.category_id
          WHERE UPPER(p.sku) IN (${marks}) OR UPPER(p.erp_inventory_id) IN (${marks})
             OR UPPER(p.barcode) IN (${marks})
             ${ids.length ? `OR p.id IN (${ids.map(() => "?").join(", ")})` : ""}`,
        [...upper, ...upper, ...upper, ...ids]
    );
    const out = new Map();
    for (const ref of unique) {
        const key = ref.toUpperCase();
        const product = rows.find((p) =>
            String(p.sku).toUpperCase() === key
            || String(p.erp_inventory_id || "").toUpperCase() === key
            || String(p.barcode || "").toUpperCase() === key
            || (/^\d+$/.test(ref) && Number(p.id) === Number(ref)));
        if (!product) throw new HttpError(404, `Item ${ref} is not in the Inventory product list.`);
        if (activeOnly && product.status !== "active") throw new HttpError(409, `Item ${product.sku} is inactive.`);
        out.set(key, product);
    }
    return out;
}

export async function findReason(conn, code, appliesTo) {
    const raw = String(code || "").trim().toUpperCase();
    if (!raw) throw new HttpError(400, "Pick a reason.");
    const [[row]] = await conn.query("SELECT * FROM inv_reason_codes WHERE code = ? AND active = 1", [raw]);
    if (!row || row.applies_to !== appliesTo) {
        throw new HttpError(400, `Reason ${raw} cannot be used here.`);
    }
    return {
        code: row.code,
        label: row.label,
        requiresApproval: Number(row.requires_approval) === 1,
        requiresReference: Number(row.requires_reference) === 1,
    };
}

/** Next document number, e.g. REL-20261021-0007 (per prefix, per Manila day). */
export async function nextNumber(conn, prefix) {
    const day = manilaDay();
    await conn.query(
        `INSERT INTO inv_sequences (name, period, \`last_value\`) VALUES (?, ?, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE \`last_value\` = LAST_INSERT_ID(\`last_value\` + 1)`,
        [prefix, day]
    );
    const [[row]] = await conn.query("SELECT LAST_INSERT_ID() AS v");
    return formatDocNumber(prefix, day, num(row.v));
}

export async function minStockFor(conn, productId, branchId, settings) {
    const [[row]] = await conn.query(
        `SELECT COALESCE(s.min_stock, NULLIF(p.min_stock, 0)) AS min_stock
           FROM inv_products p
           LEFT JOIN inv_product_branch_settings s ON s.product_id = p.id AND s.branch_id = ?
          WHERE p.id = ?`,
        [branchId, productId]
    );
    const value = row?.min_stock;
    return value === null || value === undefined ? num(settings.low_stock_default) : num(value);
}

/** Open an alert unless one with the same key is still open. */
export async function raiseAlert(conn, alert) {
    const [[open]] = await conn.query(
        "SELECT id FROM inv_alerts WHERE dedupe_key = ? AND status <> 'resolved' LIMIT 1",
        [alert.dedupeKey]
    );
    if (open) return Number(open.id);
    const [res] = await conn.query(
        `INSERT INTO inv_alerts (type, severity, branch_id, product_id, entity_type, entity_id, message, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [alert.type, alert.severity || "warning", alert.branchId || null, alert.productId || null,
            alert.entityType || null, alert.entityId || null, String(alert.message).slice(0, 500), alert.dedupeKey]
    );
    return res.insertId;
}

export async function resolveAlerts(conn, dedupeKey) {
    await conn.query(
        "UPDATE inv_alerts SET status = 'resolved', resolved_at = UTC_TIMESTAMP() WHERE dedupe_key = ? AND status <> 'resolved'",
        [dedupeKey]
    );
}

async function stockAlerts(conn, product, branchId, onHand, settings) {
    const min = await minStockFor(conn, product.id, branchId, settings);
    const lowKey = `low_stock:${branchId}:${product.id}`;
    const outKey = `out_of_stock:${branchId}:${product.id}`;
    if (onHand <= 0) {
        await resolveAlerts(conn, lowKey);
        await raiseAlert(conn, {
            type: "out_of_stock", severity: "critical", branchId, productId: product.id,
            message: `${product.name} (${product.sku}) is out of stock.`, dedupeKey: outKey,
        });
    } else if (onHand < min) {
        await resolveAlerts(conn, outKey);
        await raiseAlert(conn, {
            type: "low_stock", severity: "warning", branchId, productId: product.id,
            message: `${product.name} (${product.sku}) is low: ${onHand} left (minimum ${min}).`, dedupeKey: lowKey,
        });
    } else {
        await resolveAlerts(conn, lowKey);
        await resolveAlerts(conn, outKey);
    }
}

/**
 * Lock and change balances for one branch.
 * changes: [{ product, onHand, reserved, inTransit }] (deltas; product = inv_products row).
 * Returns Map(productId -> { before, after }) of on-hand quantities.
 * `enforceAvailable` keeps on_hand >= reserved (releases / transfers); adjustments skip it.
 */
export async function applyBalanceChanges(conn, branchId, changes, { enforceAvailable = true, settings } = {}) {
    const result = new Map();
    const ordered = [...changes].sort((a, b) => Number(a.product.id) - Number(b.product.id));
    const cfg = settings || (await getSettings(conn));
    for (const change of ordered) {
        const productId = Number(change.product.id);
        await conn.query("INSERT IGNORE INTO inv_balances (product_id, branch_id) VALUES (?, ?)", [productId, branchId]);
        const [[bal]] = await conn.query(
            "SELECT qty_on_hand, qty_reserved, qty_in_transit FROM inv_balances WHERE product_id = ? AND branch_id = ? FOR UPDATE",
            [productId, branchId]
        );
        const before = num(bal.qty_on_hand);
        const after = round(before + num(change.onHand));
        const reserved = round(num(bal.qty_reserved) + num(change.reserved));
        const inTransit = round(num(bal.qty_in_transit) + num(change.inTransit));
        const label = `${change.product.name} (${change.product.sku})`;
        if (after < 0) {
            throw new HttpError(409, `Only ${before} of ${label} on hand. You tried to take ${Math.abs(num(change.onHand))}.`,
                { code: "INSUFFICIENT_STOCK", inventoryId: change.product.sku, onHand: before });
        }
        if (reserved < 0 || inTransit < 0) {
            throw new HttpError(409, `Stock numbers for ${label} do not add up. Refresh and try again.`);
        }
        if (enforceAvailable && num(change.onHand) <= 0 && num(change.reserved) >= 0 && after < reserved) {
            const available = Math.max(0, round(before - num(bal.qty_reserved)));
            throw new HttpError(409, `Only ${available} of ${label} available (${num(bal.qty_reserved)} reserved for transfers).`,
                { code: "INSUFFICIENT_STOCK", inventoryId: change.product.sku, available });
        }
        await conn.query(
            `UPDATE inv_balances
                SET qty_on_hand = ?, qty_reserved = ?, qty_in_transit = ?,
                    last_movement_at = IF(? <> 0, UTC_TIMESTAMP(), last_movement_at),
                    version = version + 1
              WHERE product_id = ? AND branch_id = ?`,
            [after, reserved, inTransit, num(change.onHand), productId, branchId]
        );
        if (num(change.onHand) !== 0) await stockAlerts(conn, change.product, branchId, after, cfg);
        result.set(productId, { before, after });
    }
    return result;
}

function round(value) {
    return Math.round(value * 10000) / 10000;
}

/**
 * Insert a ledger document (header + lines). When `status = 'completed'` the balances are applied
 * now and lines get before / after quantities; `pending_approval` leaves balances untouched.
 * lines: [{ product, qtyChange, note, locationId }]
 */
export async function insertTransaction(conn, member, doc) {
    const prefix = { opening: "OPN", receive: "RCV", release: "REL", transfer_out: "TRO", transfer_in: "TRI", adjustment: "ADJ" }[doc.type];
    const number = doc.number || (await nextNumber(conn, prefix));
    const status = doc.status || "completed";
    const [res] = await conn.query(
        `INSERT INTO inv_transactions
            (txn_number, type, branch_id, status, reason_code, reference_no, notes, transfer_id, adjustment_id,
             request_id, created_by, created_by_name, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [number, doc.type, doc.branchId, status, doc.reasonCode || null, doc.referenceNo || null, doc.notes || null,
            doc.transferId || null, doc.adjustmentId || null, doc.requestId, member.loginId, member.name,
            doc.approvedBy || null, doc.approvedBy ? new Date() : null]
    );
    const txnId = res.insertId;
    let applied = new Map();
    if (status === "completed") {
        applied = await applyBalanceChanges(
            conn, doc.branchId,
            doc.lines.map((l) => ({ product: l.product, onHand: l.qtyChange, ...(doc.extra?.get(Number(l.product.id)) || {}) })),
            { enforceAvailable: doc.enforceAvailable !== false }
        );
    }
    for (const line of doc.lines) {
        const qty = applied.get(Number(line.product.id));
        await conn.query(
            `INSERT INTO inv_transaction_lines
                (transaction_id, branch_id, product_id, location_id, qty_change, qty_before, qty_after, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [txnId, doc.branchId, line.product.id, line.locationId || null, line.qtyChange,
                qty ? qty.before : null, qty ? qty.after : null, line.note || null]
        );
    }
    return { id: txnId, number, status, applied };
}

/** Apply a pending transaction (after approval): fill before / after on its lines. */
export async function completePendingTransaction(conn, txn, approver) {
    const [lines] = await conn.query(
        `SELECT l.*, p.sku, p.name, p.status AS product_status FROM inv_transaction_lines l
           JOIN inv_products p ON p.id = l.product_id WHERE l.transaction_id = ?`,
        [txn.id]
    );
    const applied = await applyBalanceChanges(
        conn, txn.branch_id,
        lines.map((l) => ({ product: { id: l.product_id, sku: l.sku, name: l.name }, onHand: num(l.qty_change) })),
        { enforceAvailable: txn.type !== "adjustment" }
    );
    for (const line of lines) {
        const qty = applied.get(Number(line.product_id));
        await conn.query("UPDATE inv_transaction_lines SET qty_before = ?, qty_after = ? WHERE id = ?",
            [qty.before, qty.after, line.id]);
    }
    await conn.query(
        `UPDATE inv_transactions SET status = 'completed', approved_by = ?, approved_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [approver.loginId, txn.id]
    );
    return applied;
}

/** Existing document with the same requestId (idempotent retry), or null. */
export async function findByRequestId(conn, table, requestId) {
    const allowed = ["inv_transactions", "inv_transfers", "inv_adjustments", "inv_count_sessions"];
    if (!allowed.includes(table)) throw new Error(`Unknown table ${table}`);
    const [[row]] = await conn.query(`SELECT * FROM ${table} WHERE request_id = ?`, [requestId]);
    return row || null;
}
