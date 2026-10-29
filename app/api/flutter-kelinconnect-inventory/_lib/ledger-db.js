import mysql from "mysql2/promise";
import { HttpError } from "./errors.js";

/**
 * Pool on the KelinConnect Inventory ledger database (`db_kc_inventory`, tables `inv_*`).
 * Created by hand from INVENTORY-DATABASE-SPEC.md. The only change this code makes to the tables is
 * adding columns listed in the spec's "Later additions" when they are missing.
 * Sessions run in UTC so DEFAULT CURRENT_TIMESTAMP values are UTC.
 */

const REQUIRED_TABLES = [
    "inv_users", "inv_user_branches", "inv_branches", "inv_locations", "inv_categories",
    "inv_units", "inv_products", "inv_product_branch_settings", "inv_balances", "inv_sequences",
    "inv_reason_codes", "inv_transfers", "inv_transfer_lines", "inv_count_sessions",
    "inv_count_lines", "inv_adjustments", "inv_adjustment_lines", "inv_transactions",
    "inv_transaction_lines", "inv_discrepancy_cases", "inv_case_notes", "inv_attachments",
    "inv_alerts", "inv_watchlist", "inv_settings", "inv_audit_logs",
];

const STATUS_TTL_MS = 30_000;
const poolKey = "__kcInventoryLedgerPool";
const statusKey = "__kcInventoryLedgerStatus";

function safeName(value, fallback) {
    const name = String(value || fallback).trim();
    return /^[A-Za-z0-9_]+$/.test(name) ? name : fallback;
}

export const LEDGER_DB = safeName(process.env.MYSQL_KC_INVENTORY_DATABASE, "db_kc_inventory");
export const PURCHASE_DB = safeName(process.env.MYSQL_PURCHASE_DATABASE, "db_purchase");

/** Fully qualified ledger table name for cross-database queries. */
export function ledgerTable(name) {
    return `\`${LEDGER_DB}\`.\`${name}\``;
}

export function getLedgerPool() {
    if (!globalThis[poolKey]) {
        const pool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            port: parseInt(process.env.MYSQL_PORT || "3306", 10),
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: LEDGER_DB,
            waitForConnections: true,
            connectionLimit: 8,
            queueLimit: 0,
            connectTimeout: 30000,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
            timezone: "Z",
            decimalNumbers: true,
        });
        pool.pool.on("connection", (conn) => {
            conn.query("SET time_zone = '+00:00'");
        });
        globalThis[poolKey] = pool;
    }
    return globalThis[poolKey];
}

async function probe() {
    try {
        const [rows] = await getLedgerPool().query(
            `SELECT table_name AS name FROM information_schema.tables
              WHERE table_schema = ? AND table_name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})`,
            [LEDGER_DB, ...REQUIRED_TABLES]
        );
        const found = new Set(rows.map((r) => String(r.name || r.NAME || r.TABLE_NAME)));
        const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
        if (missing.length) {
            return { ready: false, reason: `Missing tables in ${LEDGER_DB}: ${missing.join(", ")}`, liveBranches: [] };
        }
        const [live] = await getLedgerPool().query(
            `SELECT id, code, erp_warehouse_id FROM inv_branches
              WHERE live_since IS NOT NULL AND status = 'active'`
        );
        return {
            ready: true,
            reason: "",
            liveBranches: live.map((b) => ({
                id: Number(b.id),
                code: String(b.code).toUpperCase(),
                erp: String(b.erp_warehouse_id || b.code).toUpperCase(),
            })),
        };
    } catch (err) {
        const reason = err?.code === "ER_BAD_DB_ERROR"
            ? `Database ${LEDGER_DB} does not exist yet.`
            : err?.message || String(err);
        return { ready: false, reason, liveBranches: [] };
    }
}

/** Whether the ledger tables exist, plus the branches that are live. Cached briefly. */
export async function ledgerStatus({ fresh = false } = {}) {
    const hit = globalThis[statusKey];
    if (!fresh && hit && hit.until > Date.now()) return hit.value;
    const value = await probe();
    globalThis[statusKey] = { value, until: Date.now() + (value.ready ? STATUS_TTL_MS : 10_000) };
    return value;
}

const transferRefKey = "__kcInventoryTransferRef";

/**
 * Whether `inv_transfers.reference_no` exists, adding it once when missing. Uses the pool, never a
 * transaction connection: ALTER TABLE commits implicitly in MySQL.
 */
export async function transferReferenceReady() {
    const hit = globalThis[transferRefKey];
    if (hit === true) return true;
    if (hit && hit.until > Date.now()) return false;
    const pool = getLedgerPool();
    try {
        const [rows] = await pool.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = ? AND table_name = 'inv_transfers' AND column_name = 'reference_no'`,
            [LEDGER_DB]
        );
        if (!rows.length) {
            await pool.query("ALTER TABLE inv_transfers ADD COLUMN reference_no VARCHAR(100) NULL AFTER reason_code");
        }
        globalThis[transferRefKey] = true;
        return true;
    } catch (err) {
        console.warn("[KC Inventory] transfer reference column", err?.message || err);
        globalThis[transferRefKey] = { until: Date.now() + 10 * 60_000 };
        return false;
    }
}

export function invalidateLedgerStatus() {
    globalThis[statusKey] = null;
}

export async function requireLedger() {
    const status = await ledgerStatus();
    if (!status.ready) {
        throw new HttpError(
            503,
            "The new Inventory database is not set up yet. Ask the admin to follow INVENTORY-DATABASE-SPEC.md.",
            { code: "LEDGER_NOT_READY", details: status.reason }
        );
    }
    return status;
}

/** Run `fn(conn)` inside one ledger transaction. */
export async function withLedgerTx(fn) {
    const conn = await getLedgerPool().getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}
