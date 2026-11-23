/**
 * Re-pull Acumatica Inventory Summary into forecast_item_stock.
 * Use after sellable-location rules change (e.g. MAIN bin MARILAO 15) so incremental
 * sync does not leave stale MAIN=0 rows forever.
 *
 *   node scripts/refresh-inventory-summary-stock.mjs --po MNLP261105
 *   node scripts/refresh-inventory-summary-stock.mjs --ids 134115411224030,ABC
 *   node scripts/refresh-inventory-summary-stock.mjs --stale-before 2026-11-20
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { isExcludedBranchAlias, isExcludedLocationAlias } from "../lib/companies.js";

const base = String(process.env.ACUMATICA_BASE_URL || "").replace(/\/$/, "");
const company = process.env.ACUMATICA_COMPANY || "KGSC";
const user = process.env.ACUMATICA_USERNAME;
const pass = process.env.ACUMATICA_PASSWORD;
const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
const ACU = `${base}/entity/Default/20.200.001`;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 60000;

function arg(name, fallback = "") {
    const i = process.argv.indexOf(name);
    return i >= 0 ? String(process.argv[i + 1] || "").trim() : fallback;
}
function hasFlag(name) {
    return process.argv.includes(name);
}

function getAny(row, ...keys) {
    for (const k of keys) {
        const v = row?.[k];
        if (v && typeof v === "object" && "value" in v) return v.value;
        if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
}

function aggregateSummaryByWarehouse(summaryResults = []) {
    const byWh = new Map();
    const seenWarehouses = new Set();
    for (const row of summaryResults) {
        const warehouseId = String(getAny(row, "WarehouseID", "SiteID", "Branch") || "").trim();
        if (!warehouseId || isExcludedBranchAlias(warehouseId)) continue;
        const key = warehouseId.toUpperCase();
        seenWarehouses.add(key);
        const locationId = String(getAny(row, "LocationID", "Location") || "").trim();
        if (isExcludedLocationAlias(locationId)) continue;
        const locKey = locationId.replace(/^<|>$/g, "").trim().toUpperCase();
        if (!locKey || locKey === "UNASSIGNED") continue;
        const onHand = parseFloat(getAny(row, "QtyOnHand", "OnHand", "BaseQty") || 0);
        let available = parseFloat(getAny(row, "QtyAvailable", "Available") || onHand);
        if (Number.isNaN(available)) available = Number.isNaN(onHand) ? 0 : onHand;
        available = Math.max(0, available);
        const prev = byWh.get(key) || { warehouse_id: warehouseId, on_hand: 0, available: 0 };
        prev.on_hand += Number.isNaN(onHand) ? 0 : onHand;
        prev.available += Number.isNaN(available) ? 0 : available;
        byWh.set(key, prev);
    }
    return { byWh, seenWarehouses };
}

function cookieHeader(res) {
    const raw = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    return raw.map((c) => String(c).split(";")[0].trim()).filter(Boolean).join("; ");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function login() {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const res = await fetchWithTimeout(`${base}/entity/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: user, password: pass, company }),
            });
            if (!res.ok && res.status !== 204) {
                throw new Error(`Acumatica login failed: ${res.status}`);
            }
            return cookieHeader(res);
        } catch (err) {
            lastErr = err;
            console.warn(`login retry ${attempt}/5:`, err.message || err.cause?.code || err);
            await sleep(1500 * attempt);
        }
    }
    throw lastErr || new Error("Acumatica login failed");
}

async function logout(cookie) {
    await fetch(`${base}/entity/auth/logout`, { method: "POST", headers: { Cookie: cookie } }).catch(() => {});
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

async function summaryFor(inventoryId, cookie) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const res = await fetchWithTimeout(`${ACU}/InventorySummaryInquiry?$expand=Results`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ InventoryID: { value: inventoryId } }),
            });
            if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { code: 401 });
            if (!res.ok) throw new Error(`Summary HTTP ${res.status}`);
            const data = await res.json().catch(() => ({}));
            const results = Array.isArray(data?.Results) ? data.Results : data?.Results?.value || [];
            return Array.isArray(results) ? results : [];
        } catch (err) {
            lastErr = err;
            if (err.code === 401) throw err;
            await sleep(400 * attempt);
        }
    }
    throw lastErr || new Error("summary failed");
}

async function main() {
    if (!base || !user || !pass) throw new Error("Missing Acumatica env");

    const pool = await mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: purchaseDb,
        connectionLimit: 4,
    });

    let ids = [];
    const po = arg("--po");
    const idList = arg("--ids");
    const staleBefore = arg("--stale-before");

    if (idList) {
        ids.push(...idList.split(",").map((s) => s.trim()).filter(Boolean));
    }
    if (po) {
        const [rows] = await pool.query(
            `SELECT DISTINCT inventory_id AS id FROM purchase_order_details WHERE order_nbr = ?`,
            [po]
        );
        ids.push(...rows.map((r) => String(r.id || "").trim()).filter(Boolean));
        console.log(`PO ${po}: +${rows.length} SKUs`);
    }
    if (!ids.length && staleBefore) {
        const [rows] = await pool.query(
            `SELECT DISTINCT inventory_id AS id
             FROM forecast_item_stock
             WHERE company_id = 'main'
               AND warehouse_id = 'MAIN'
               AND last_sync < ?
             ORDER BY inventory_id`,
            [staleBefore]
        );
        ids = rows.map((r) => String(r.id || "").trim()).filter(Boolean);
        console.log(`Stale MAIN before ${staleBefore}: ${ids.length} SKUs`);
    }
    if (!ids.length) {
        console.error("Usage: --po ORDER | --ids a,b | --stale-before YYYY-MM-DD");
        process.exit(1);
    }

    ids = [...new Set(ids)];
    if (!ids.length) {
        console.log("Nothing to refresh");
        await pool.end();
        return;
    }

    let cookie = await login();
    console.log("Logged in");

    const metaById = new Map();
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const ph = chunk.map(() => "?").join(",");
        const [meta] = await pool.query(
            `SELECT inventory_id, item_name, item_class, default_price, item_status
             FROM forecast_item_stock
             WHERE company_id = 'main' AND inventory_id IN (${ph})
             GROUP BY inventory_id`,
            chunk
        );
        for (const m of meta) metaById.set(String(m.inventory_id).trim(), m);
    }

    let ok = 0;
    let fail = 0;
    let written = 0;
    const now = new Date();

    async function processOne(inventoryId) {
        let results;
        try {
            results = await summaryFor(inventoryId, cookie);
        } catch (err) {
            if (err.code === 401) {
                cookie = await login();
                results = await summaryFor(inventoryId, cookie);
            } else {
                throw err;
            }
        }
        const { byWh, seenWarehouses } = aggregateSummaryByWarehouse(results);
        const meta = metaById.get(inventoryId) || {};
        // Always refresh MAIN even when Summary omits it (keeps last_sync current; qty 0).
        const keys = new Set([...seenWarehouses, "MAIN"]);
        const rows = [];
        for (const key of keys) {
            if (!key || isExcludedBranchAlias(key)) continue;
            const agg = byWh.get(key) || { warehouse_id: key, on_hand: 0, available: 0 };
            rows.push({
                inventory_id: inventoryId,
                warehouse_id: agg.warehouse_id || key,
                branch_id: agg.warehouse_id || key,
                site_id: agg.warehouse_id || key,
                item_name: meta.item_name || null,
                item_class: meta.item_class || null,
                default_price: meta.default_price || 0,
                on_hand: agg.on_hand || 0,
                available: agg.available || 0,
                item_status: meta.item_status || null,
            });
        }
        if (!rows.length) return 0;

        const placeholders = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
        const values = rows.flatMap((r) => [
            "main",
            r.inventory_id,
            r.warehouse_id,
            r.branch_id,
            r.site_id,
            r.item_name,
            r.item_class,
            Number(r.default_price) || 0,
            Number(r.on_hand) || 0,
            Number(r.available) || 0,
            r.item_status,
            now,
        ]);
        await pool.query(
            `INSERT INTO \`${purchaseDb}\`.forecast_item_stock (
                company_id, inventory_id, warehouse_id, branch_id, site_id,
                item_name, item_class, default_price, on_hand, available, item_status, last_sync
            ) VALUES ${placeholders}
            ON DUPLICATE KEY UPDATE
                on_hand = VALUES(on_hand),
                available = VALUES(available),
                last_sync = VALUES(last_sync)`,
            values
        );
        return rows.length;
    }

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const slice = ids.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.allSettled(slice.map((id) => processOne(id)));
        for (const o of outcomes) {
            if (o.status === "fulfilled") {
                ok += 1;
                written += o.value || 0;
            } else {
                fail += 1;
                console.warn("fail", o.reason?.message || o.reason);
            }
        }
        if ((i + CONCURRENCY) % 60 < CONCURRENCY || i + CONCURRENCY >= ids.length) {
            console.log(`progress ${Math.min(i + CONCURRENCY, ids.length)}/${ids.length} ok=${ok} fail=${fail} rows=${written}`);
        }
    }

    if (ids.includes("134115411224030") || hasFlag("--po")) {
        const [check] = await pool.query(
            `SELECT warehouse_id, on_hand, available, last_sync
             FROM forecast_item_stock
             WHERE company_id='main' AND inventory_id='134115411224030' AND warehouse_id='MAIN'`
        );
        console.log("Sintra MAIN after refresh", check);
    }

    await logout(cookie);
    await pool.end();
    console.log(`Done. items ok=${ok} fail=${fail} warehouse rows written=${written}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
