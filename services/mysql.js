import mysql from "mysql2/promise";
import { mergeDimensionsFillEmpty, hasAnyDimensionValue } from "@/lib/item-dimensions.js";
import {
    sqlExcludeEcomBranches,
    ECOM_BRANCH_ALIASES,
    isEcomBranchAlias,
    isExcludedBranchAlias,
    isWarehouseLikeAlias,
    isRetailReplenishmentBranch,
    sqlOnlyEcomBranches,
    sqlExcludeBranches,
    sqlOnlyDamageBranches,
    sqlExcludeSalesBranches,
    resolveCompanyIdForBranch,
    sqlExcludeEcomSalesBranches,
    sqlOnlyEcomSalesBranches,
    getStockWarehouseIdsForBranch,
    resolveSalesBranchForWarehouse,
    EXCLUDED_BRANCH_KEYWORDS,
} from "@/lib/companies.js";
import { SALES_LOOKBACK_DAYS, SQL_NET_QTY, SQL_NET_AMOUNT, SQL_GROSS_QTY, netQtySold, mergeBranchFirstSalesMaps } from "@/lib/sales-velocity.js";
import { TARGET_DAYS_OF_COVER } from "@/lib/replenishment-insights.js";
import { getCached, invalidateCache } from "@/lib/server-cache";
import { FORECAST_ALL_BRANCH, forecastBranchKey, forecastSoldQty, listMonthsInRange, monthInvoiceCoverageComplete, normalizeInvKey } from "@/lib/forecast-generator.js";
import {
    openPoHeaderStatuses,
    sqlMatchOpenPoForBranch,
    sqlPoLineOpenQty,
    sqlPoLineOrderQty,
} from "@/lib/open-po-match.js";

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory",
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

const purchasePool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_PURCHASE_DATABASE || "db_purchase",
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // Match Acumatica / Manila calendar dates for Forecast period windows
    timezone: "+08:00",
});

/** Flag queries slower than 100ms for performance logging. */
function instrumentPool(p, label) {
    const origQuery = p.query.bind(p);
    const origExecute = p.execute.bind(p);
    const wrap = (fn) => async (...args) => {
        const start = Date.now();
        try {
            return await fn(...args);
        } finally {
            const ms = Date.now() - start;
            if (ms >= 100) {
                const sql = typeof args[0] === "string" ? args[0] : "";
                console.warn(`[Slow SQL ${label}] ${ms}ms — ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
            }
        }
    };
    p.query = wrap(origQuery);
    p.execute = wrap(origExecute);
    return p;
}

instrumentPool(pool, "inventory");
instrumentPool(purchasePool, "purchase");

/**
 * product_inventory_items — CMS / Connect catalog (ONE row per SKU; DB trigger blocks twins).
 * forecast_item_stock — Acumatica multi-warehouse stock (Inventory UI source of truth).
 * Do not use product_inventory_items for per-warehouse on-hand — CMS collapses it.
 */
export const INVENTORY_SYNC_TABLE = "product_inventory_items";
/** @deprecated Prefer forecast_item_stock for stock reads; kept for CMS catalog joins. */
export const INVENTORY_VIEW_TABLE = INVENTORY_SYNC_TABLE;
export const FORECAST_STOCK_TABLE = "forecast_item_stock";

function isTransientMysqlError(err) {
    const code = String(err?.code || "");
    const msg = String(err?.message || "");
    return /ENETUNREACH|ECONNRESET|ETIMEDOUT|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|EPIPE|ER_LOCK_DEADLOCK/i.test(
        `${code} ${msg}`
    );
}

/** Connect CMS trigger: product_inventory_items allows only one row per inventory_id. */
function isCmsSkuTwinError(err) {
    const msg = String(err?.sqlMessage || err?.message || "");
    return (
        err?.errno === 1644 ||
        /one row per SKU|Refusing duplicate inventory_id/i.test(msg)
    );
}

async function withMysqlRetry(label, fn, retries = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isTransientMysqlError(err) || attempt >= retries) throw err;
            console.warn(
                `[MySQL ${label}] transient ${err.code || err.message} — retry ${attempt}/${retries}`
            );
            await new Promise((r) => setTimeout(r, 800 * attempt));
        }
    }
    throw lastErr;
}

async function countWarehouseRows(companyId = "main", table = INVENTORY_VIEW_TABLE) {
    return getCached(`wh-count:fis-or-${table}:${companyId}`, 60_000, async () => {
        try {
            const [[fis]] = await purchasePool.query(
                `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ? AND warehouse_id != '__catalog__'`,
                [companyId]
            );
            if (Number(fis?.c) > 0) return Number(fis.c);
        } catch {
            /* fall through to legacy table */
        }
        const [[row]] = await pool.query(
            `SELECT COUNT(*) AS c FROM \`${table}\`
             WHERE company_id = ? AND default_warehouse != '__catalog__'`,
            [companyId]
        );
        return Number(row?.c) || 0;
    });
}

async function countCatalogRows(companyId = "main", table = INVENTORY_VIEW_TABLE) {
    return getCached(`cat-count:fis-or-${table}:${companyId}`, 60_000, async () => {
        try {
            const [[fis]] = await purchasePool.query(
                `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ? AND warehouse_id = '__catalog__'`,
                [companyId]
            );
            if (Number(fis?.c) > 0) return Number(fis.c);
            // Forecast may only have warehouse rows — distinct items still count as catalog size
            const [[distinct]] = await purchasePool.query(
                `SELECT COUNT(DISTINCT TRIM(inventory_id)) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ? AND warehouse_id != '__catalog__'`,
                [companyId]
            );
            if (Number(distinct?.c) > 0) return Number(distinct.c);
        } catch {
            /* fall through */
        }
        const [[row]] = await pool.query(
            `SELECT COUNT(*) AS c FROM \`${table}\`
             WHERE company_id = ? AND default_warehouse = '__catalog__'`,
            [companyId]
        );
        return Number(row?.c) || 0;
    });
}

/** warehouse = per-site synced rows; catalog = product master only; catalog-empty = no products yet */
async function resolveInventoryLayout(companyId = "main") {
    const warehouseRows = await countWarehouseRows(companyId);
    if (warehouseRows > 0) return "warehouse";
    const catalogRows = await countCatalogRows(companyId);
    if (catalogRows > 0) return "catalog";
    return "catalog-empty";
}

function salesLookbackSql(days = SALES_LOOKBACK_DAYS) {
    const window = parseInt(days, 10) || SALES_LOOKBACK_DAYS;
    return `document_date >= DATE_SUB(CURDATE(), INTERVAL ${window} DAY) AND document_date <= CURDATE()`;
}

/** Join catalog metadata when reading per-branch warehouse stock rows. */
function inventoryFromClause(layout, { useForecast = false, purchaseDb = "db_purchase" } = {}) {
    if (useForecast) {
        const t = `\`${purchaseDb}\`.\`${FORECAST_STOCK_TABLE}\``;
        if (layout === "warehouse") {
            return `FROM ${t} i
                LEFT JOIN ${t} c
                  ON c.inventory_id = i.inventory_id
                 AND c.company_id = i.company_id
                 AND c.warehouse_id = '__catalog__'`;
        }
        return `FROM ${t} i`;
    }
    if (layout === "warehouse") {
        return `FROM \`${INVENTORY_VIEW_TABLE}\` i
                LEFT JOIN \`${INVENTORY_VIEW_TABLE}\` c
                  ON c.inventory_id = i.inventory_id
                 AND c.company_id = i.company_id
                 AND c.default_warehouse = '__catalog__'`;
    }
    return `FROM \`${INVENTORY_VIEW_TABLE}\` i`;
}

function inventoryPlanningCols(alias = "c") {
    return `
                    ${alias}.vendor_id as VendorID,
                    ${alias}.lead_time_days as LeadTimeDays,
                    ${alias}.safety_stock as SafetyStock,
                    ${alias}.moq as MOQ`;
}

function inventorySelectCols(layout) {
    if (layout === "warehouse") {
        return `
                    i.inventory_id as InventoryID,
                    COALESCE(c.inventory_name, i.inventory_name) as Description,
                    COALESCE(c.item_class, i.item_class) as ItemClass,
                    i.branch_id as Branch,
                    i.site_id as SiteID,
                    COALESCE(i.on_hand, 0) as OnHand,
                    COALESCE(i.available, i.on_hand, 0) as Available,
                    COALESCE(c.default_price, i.default_price, 0) as DefaultPrice,
                    ${inventoryPlanningCols("c")}`;
    }
    return `
                    i.inventory_id as InventoryID,
                    i.inventory_name as Description,
                    i.item_class as ItemClass,
                    i.branch_id as Branch,
                    i.site_id as SiteID,
                    COALESCE(i.on_hand, 0) as OnHand,
                    COALESCE(i.available, i.on_hand, 0) as Available,
                    i.default_price as DefaultPrice,
                    ${inventoryPlanningCols("i")}`;
}

/** Match stock rows for a retail branch and its related warehouses (e.g. MANILA + Marilao). */
function sqlMatchBranchWarehouses(alias, destinations) {
    const sites = (destinations || []).map((d) => String(d || "").trim().toUpperCase()).filter(Boolean);
    if (!sites.length) return { clause: "1=0", params: [] };
    const ph = sites.map(() => "?").join(", ");
    return {
        clause: `(UPPER(TRIM(${alias}.branch_id)) IN (${ph}) OR UPPER(TRIM(${alias}.default_warehouse)) IN (${ph}))`,
        params: [...sites, ...sites],
    };
}

function sqlMatchForecastWarehouses(alias, destinations, warehouseCol = "warehouse_id") {
    const sites = (destinations || []).map((d) => String(d || "").trim().toUpperCase()).filter(Boolean);
    if (!sites.length) return { clause: "1=1", params: [] };
    const ph = sites.map(() => "?").join(", ");
    return {
        clause: `(UPPER(TRIM(COALESCE(${alias}.branch_id,''))) IN (${ph})
              OR UPPER(TRIM(COALESCE(${alias}.${warehouseCol},''))) IN (${ph})
              OR UPPER(TRIM(COALESCE(${alias}.site_id,''))) IN (${ph}))`,
        params: [...sites, ...sites, ...sites],
    };
}

function sqlExcludeForecastDamage(alias, warehouseCol = "warehouse_id") {
    const cols = [
        `UPPER(TRIM(COALESCE(${alias}.branch_id,'')))`,
        `UPPER(TRIM(COALESCE(${alias}.site_id,'')))`,
        `UPPER(TRIM(COALESCE(${alias}.${warehouseCol},'')))`,
    ];
    const likes = EXCLUDED_BRANCH_KEYWORDS.flatMap(() => cols.map((c) => `${c} NOT LIKE ?`));
    return {
        clause: `(${likes.join(" AND ")})`,
        params: EXCLUDED_BRANCH_KEYWORDS.flatMap((kw) => [`%${kw}%`, `%${kw}%`, `%${kw}%`]),
    };
}

/** Literal (no-bind) form for CASE expressions — keywords are fixed app constants. */
function sqlExcludeForecastDamageLiteral(alias, warehouseCol = "warehouse_id") {
    const cols = [
        `UPPER(TRIM(COALESCE(${alias}.branch_id,'')))`,
        `UPPER(TRIM(COALESCE(${alias}.site_id,'')))`,
        `UPPER(TRIM(COALESCE(${alias}.${warehouseCol},'')))`,
    ];
    const likes = EXCLUDED_BRANCH_KEYWORDS.flatMap((kw) =>
        cols.map((c) => `${c} NOT LIKE '%${String(kw).replace(/'/g, "''")}%'`)
    );
    return `(${likes.join(" AND ")})`;
}

function isForecastDamageRow(row = {}) {
    const keys = [row.warehouse_id, row.default_warehouse, row.branch_id, row.site_id];
    return keys.some((k) => isExcludedBranchAlias(k));
}

function normalizeInventorySearch(search) {
    return String(search || "").trim().replace(/\s+/g, " ");
}

function mapInventoryRows(rows) {
    return rows.map((item) => {
        const onHand = Number(item.OnHand);
        const onHandVal = Number.isFinite(onHand) ? onHand : 0;
        let available = item.Available == null || item.Available === ""
            ? NaN
            : Number(item.Available);
        if (!Number.isFinite(available)) available = onHandVal;
        return {
            InventoryID: { value: item.InventoryID },
            Description: { value: item.Description || "—" },
            SiteID: { value: item.SiteID },
            Branch: { value: item.Branch },
            OnHand: { value: onHandVal },
            Available: { value: available },
            DefaultPrice: { value: item.DefaultPrice || 0 },
            ItemClass: { value: item.ItemClass || "" },
            VendorID: { value: item.VendorID || "" },
            LeadTimeDays: { value: item.LeadTimeDays },
            SafetyStock: { value: item.SafetyStock },
            MOQ: { value: item.MOQ },
            QtySold: { value: item.QtySold },
        };
    });
}

function netSalesQtySubquery(purchaseDb, salesEx, branch = "") {
    const branchClause = branch
        ? ` AND TRIM(UPPER(branch_name)) = TRIM(UPPER(?))`
        : "";
    return `(
        SELECT inventory_id, SUM(${SQL_NET_QTY}) as total_qty
        FROM \`${purchaseDb}\`.product_periodic_sales
        WHERE ${salesEx.clause}
          AND ${salesLookbackSql()}${branchClause}
        GROUP BY inventory_id
    )`;
}

const EMPTY_GLOBAL_STATS = {
    totalStock: 0,
    totalValue: 0,
    lowStock: 0,
    totalLowStock: 0,
    outOfStock: 0,
    deadStock: 0,
    overstock: 0,
    damageStock: 0,
    damageCount: 0,
    count: 0,
    lastSync: null,
};

export const MySqlService = {
    /**
     * Get the latest last_sync timestamp for inventory items
     */
    async getLastInventorySyncTime() {
        try {
            // Prefer multi-warehouse stock watermark (CMS catalog table is one-row-per-SKU).
            try {
                const [[fis]] = await purchasePool.query(
                    `SELECT MAX(last_sync) as lastSync FROM \`${FORECAST_STOCK_TABLE}\``
                );
                if (fis?.lastSync) return fis.lastSync;
            } catch {
                /* fall through */
            }
            const [[res]] = await pool.query(
                `SELECT MAX(last_sync) as lastSync FROM \`${INVENTORY_SYNC_TABLE}\``
            );
            return res.lastSync || null;
        } catch (err) {
            console.error("[MySQL getLastInventorySyncTime Error]", err);
            return null;
        }
    },

    /**
     * Get the latest last_sync timestamp for sales
     */
    async getLastSalesSyncTime() {
        try {
            const [[res]] = await purchasePool.query(
                `SELECT MAX(last_sync) as lastSync FROM product_periodic_sales`
            );
            return res.lastSync || null;
        } catch (err) {
            console.error("[MySQL getLastSalesSyncTime Error]", err);
            return null;
        }
    },

    /** Latest sync timestamp across inventory, sales, and PO — used to invalidate replenishment cache. */
    async getReplenishmentDataWatermark() {
        const [inv, sales, po] = await Promise.all([
            this.getLastInventorySyncTime(),
            this.getLastSalesSyncTime(),
            this.getLastPOSyncTime(),
        ]);
        const stamps = [inv, sales, po]
            .filter(Boolean)
            .map((d) => new Date(d).getTime())
            .filter(Number.isFinite);
        return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
    },

    /**
     * Get the latest last_sync timestamp for Purchase Orders
     */
    async getLastPOSyncTime() {
        try {
            const [[res]] = await purchasePool.query(
                `SELECT MAX(last_sync) as lastSync FROM purchase_history`
            );
            return res.lastSync || null;
        } catch (err) {
            console.error("[MySQL getLastPOSyncTime Error]", err);
            return null;
        }
    },

    /**
     * Fetch purchase orders from MySQL (for Purchase Orders module).
     * No TTL cache — lists must stay live after sync / receipt updates.
     */
    async getPurchaseOrders({ page = 1, pageSize = 50, search = "", status = "", startDate = "", endDate = "", branch = "", vendorId = "", companyId = "main", orderNbrs = null, excludeZeroQty = true } = {}) {
        return this._getPurchaseOrdersImpl({ page, pageSize, search, status, startDate, endDate, branch, vendorId, companyId, orderNbrs, excludeZeroQty });
    },

    async _getPurchaseOrdersImpl({ page = 1, pageSize = 50, search = "", status = "", startDate = "", endDate = "", branch = "", vendorId = "", companyId = "main", orderNbrs = null, excludeZeroQty = true } = {}) {
        const offset = (page - 1) * pageSize;
        const limitInt = parseInt(pageSize, 10);
        const offsetInt = parseInt(offset, 10);
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";

        try {
            if (Array.isArray(orderNbrs) && orderNbrs.length === 0) {
                return { orders: [], totalCount: 0, hasMore: false };
            }

            let whereClauses = [];
            let params = [];

            if (status) {
                // Support multi-status: "Open,On Hold,Pending Approval" or preset "active"
                const raw = String(status).trim();
                let parts = raw.toLowerCase() === "active"
                    ? ["Open", "On Hold", "Hold", "Pending Approval"]
                    : raw.split(",").map((s) => {
                        const t = s.trim();
                        if (/^hold$/i.test(t)) return "On Hold";
                        if (/^canceled$/i.test(t)) return "Cancelled";
                        return t;
                    }).filter(Boolean);
                // Matching "On Hold" also includes legacy "Hold" rows
                if (parts.includes("On Hold") && !parts.includes("Hold")) {
                    parts = [...parts, "Hold"];
                }
                if (parts.length === 1) {
                    whereClauses.push("h.status = ?");
                    params.push(parts[0]);
                } else if (parts.length > 1) {
                    whereClauses.push(`h.status IN (${parts.map(() => "?").join(",")})`);
                    params.push(...parts);
                }
            }

            if (startDate) {
                // Compare calendar dates so timezone/DATETIME storage does not drop valid rows
                whereClauses.push("DATE(h.order_date) >= ?");
                params.push(String(startDate).slice(0, 10));
            }

            if (endDate) {
                whereClauses.push("DATE(h.order_date) <= ?");
                params.push(String(endDate).slice(0, 10));
            }

            if (search) {
                // Order # / Vendor / Item ID only.
                // Do NOT match line descriptions — brand text (e.g. "Sofie … Vinyl") collides
                // with vendor-name searches and buries the real vendor POs under unrelated orders.
                const like = `%${search}%`;
                whereClauses.push(`(
                    h.order_nbr LIKE ? OR h.vendor_id LIKE ? OR h.vendor_name LIKE ? OR v.vendor_name LIKE ?
                    OR EXISTS (
                        SELECT 1 FROM purchase_order_details d
                        WHERE d.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                          AND d.inventory_id LIKE ?
                    )
                )`);
                params.push(like, like, like, like, like);
            }

            if (vendorId) {
                whereClauses.push("h.vendor_id = ?");
                params.push(vendorId);
            }

            if (Array.isArray(orderNbrs) && orderNbrs.length > 0) {
                const ids = [...new Set(orderNbrs.map((n) => String(n || "").trim()).filter(Boolean))].slice(0, 500);
                if (!ids.length) {
                    return { orders: [], totalCount: 0, hasMore: false };
                }
                whereClauses.push(`h.order_nbr IN (${ids.map(() => "?").join(",")})`);
                params.push(...ids);
            }

            // Match Acumatica "Order Qty != 0", but keep amount-only headers if lines not synced yet
            if (excludeZeroQty && !(Array.isArray(orderNbrs) && orderNbrs.length > 0)) {
                whereClauses.push(`(
                    EXISTS (
                        SELECT 1 FROM purchase_order_details dqty
                        WHERE dqty.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                          AND dqty.qty > 0
                    )
                    OR (
                        NOT EXISTS (
                            SELECT 1 FROM purchase_order_details dany
                            WHERE dany.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                        )
                        AND COALESCE(h.total_amount, 0) > 0
                    )
                )`);
            }

            if (branch) {
                // Match Acumatica Branch + related warehouse destinations (e.g. MAIN → MAIN WH11).
                // COLLATE required: purchase_history is utf8mb4_0900_ai_ci, dest/details are unicode_ci.
                const destinations = getStockWarehouseIdsForBranch(branch);
                const ids = (destinations.length ? destinations : [String(branch).trim().toUpperCase()])
                    .map((id) => String(id).trim().toUpperCase())
                    .filter(Boolean);
                const ph = ids.map(() => "?").join(",");
                whereClauses.push(`(
                    EXISTS (
                        SELECT 1 FROM purchase_order_dest pd
                        WHERE pd.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                          AND UPPER(TRIM(pd.branch_id)) IN (${ph})
                    )
                    OR EXISTS (
                        SELECT 1 FROM purchase_order_details d
                        WHERE d.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                          AND (
                            UPPER(TRIM(COALESCE(d.branch_id, ''))) IN (${ph})
                            OR UPPER(TRIM(COALESCE(d.warehouse_id, ''))) IN (${ph})
                          )
                    )
                )`);
                params.push(...ids, ...ids, ...ids);
            }

            const wherePart = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

            const [[rows], [[{ total }]]] = await Promise.all([
                purchasePool.query(
                    `SELECT 
                        h.order_nbr as orderNbr,
                        h.vendor_id as vendorId,
                        COALESCE(NULLIF(TRIM(h.vendor_name), ''), v.vendor_name, h.vendor_id) as vendorName,
                        h.status,
                        h.order_date as date,
                        h.promised_date as promisedDate,
                        h.receipt_date as receiptDate,
                        COALESCE(
                            NULLIF(h.total_amount, 0),
                            (
                                SELECT SUM(d.ext_cost)
                                FROM purchase_order_details d
                                WHERE d.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                            ),
                            0
                        ) as totalAmount
                     FROM purchase_history h
                     LEFT JOIN vendors v ON v.vendor_id COLLATE utf8mb4_unicode_ci = h.vendor_id
                     ${wherePart}
                     ORDER BY h.order_date DESC, h.order_nbr DESC
                     LIMIT ${limitInt} OFFSET ${offsetInt}`,
                    params
                ),
                purchasePool.query(
                    `SELECT COUNT(*) as total FROM purchase_history h
                     LEFT JOIN vendors v ON v.vendor_id COLLATE utf8mb4_unicode_ci = h.vendor_id
                     ${wherePart}`,
                    params
                ),
            ]);

            let linesByOrder = new Map();
            if (rows.length > 0) {
                const orderNbrs = rows.map(r => r.orderNbr);
                const placeholders = orderNbrs.map(() => "?").join(",");
                const [lineRows] = await purchasePool.query(
                    `SELECT order_nbr, line_nbr as lineNbr, inventory_id as inventoryId, description, qty,
                            received_qty as receivedQty, uom, ext_cost as extCost,
                            warehouse_id as warehouseId, branch_id as branchId
                     FROM purchase_order_details
                     WHERE order_nbr COLLATE utf8mb4_unicode_ci IN (${placeholders})
                     ORDER BY line_nbr ASC`,
                    orderNbrs
                );
                for (const line of lineRows) {
                    const key = String(line.order_nbr || "").trim();
                    if (!linesByOrder.has(key)) linesByOrder.set(key, []);
                    const qty = Number(line.qty) || 0;
                    const receivedQty = Number(line.receivedQty) || 0;
                    linesByOrder.get(key).push({
                        inventoryId: line.inventoryId,
                        description: line.description,
                        qty,
                        receivedQty,
                        openQty: Math.max(qty - receivedQty, 0),
                        uom: line.uom,
                        extCost: line.extCost,
                        warehouseId: line.warehouseId || line.branchId || "",
                        branchId: line.branchId || line.warehouseId || "",
                    });
                }
            }

            const ordersWithLines = rows.map(order => ({
                ...order,
                orderType: "Normal",
                lines: linesByOrder.get(String(order.orderNbr || "").trim()) || [],
            }));

            return {
                orders: ordersWithLines,
                totalCount: total,
                hasMore: total > offset + rows.length
            };
        } catch (err) {
            console.error("[MySQL getPurchaseOrders Error]", err);
            throw err;
        }
    },

    /**
     * Bulk upsert purchase history for reliability calculation
     */
    async upsertPurchaseHistory(rows) {
        if (!rows.length) return;
        const connection = await purchasePool.getConnection();
        try {
            await connection.beginTransaction();
            const sql = `
                INSERT INTO purchase_history 
                (order_nbr, vendor_id, vendor_name, status, order_date, promised_date, receipt_date, total_amount, last_sync)
                VALUES ?
                ON DUPLICATE KEY UPDATE
                vendor_id = VALUES(vendor_id),
                vendor_name = COALESCE(NULLIF(VALUES(vendor_name), ''), vendor_name),
                status = VALUES(status),
                order_date = COALESCE(VALUES(order_date), order_date),
                promised_date = COALESCE(NULLIF(VALUES(promised_date), ''), promised_date),
                receipt_date = COALESCE(VALUES(receipt_date), receipt_date),
                total_amount = IF(VALUES(total_amount) > 0, VALUES(total_amount), COALESCE(NULLIF(total_amount, 0), VALUES(total_amount))),
                last_sync = VALUES(last_sync)
            `;
            const values = rows.map(r => {
                let status = String(r.status || "").trim();
                if (/^hold$/i.test(status)) status = "On Hold";
                if (/^canceled$/i.test(status)) status = "Cancelled";
                return [
                    r.order_nbr, r.vendor_id, r.vendor_name, status, r.order_date, r.promised_date, r.receipt_date, r.total_amount, new Date()
                ];
            });
            await connection.query(sql, [values]);
            await connection.commit();
            invalidateCache("itemVendorMap");
            invalidateCache("po:");
            invalidateCache("openPo:");
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    },

    /** Update local PO ERP status (Acumatica-aligned values). */
    async updatePurchaseOrderStatus(orderNbr, status) {
        const nbr = String(orderNbr || "").trim();
        const next = String(status || "").trim();
        if (!nbr) throw Object.assign(new Error("Order number is required."), { status: 400 });
        if (!next) throw Object.assign(new Error("Status is required."), { status: 400 });

        const [result] = await purchasePool.query(
            `UPDATE purchase_history SET status = ? WHERE order_nbr = ?`,
            [next, nbr]
        );
        if (!result?.affectedRows) {
            throw Object.assign(new Error("Purchase order not found."), { status: 404 });
        }
        invalidateCache("po:");
        invalidateCache("openPo:");
        return { orderNbr: nbr, status: next };
    },

    /**
     * Status must come from Acumatica sync only.
     * Do not invent Open/Closed from receipt_date or received_qty — that caused:
     * - Open ERP POs to show as Closed (Sofie DVOP260049 / MPO260273), and
     * - Closed ERP POs to be wrongly reopened (extra Sofie rows beyond Acumatica's 4).
     */
    async reconcilePurchaseOrderStatuses() {
        return { closed: 0, repaired: 0 };
    },

    /**
     * Align local statuses with an authoritative Acumatica Open set (global).
     * Always force ERP Open → local Open.
     * Optionally close local Open+receipt_date rows not in that set (undo false reopens),
     * scoped by sinceDate so a partial Open list cannot close ERP-Open POs.
     */
    async applyAcumaticaOpenPoStatuses(openOrderNbrs, { closeStale = true, sinceDate = "" } = {}) {
        const openIds = [...new Set(
            (openOrderNbrs || []).map((n) => String(n || "").trim()).filter(Boolean)
        )];
        if (!openIds.length) return { opened: 0, closed: 0 };

        let opened = 0;
        const CHUNK = 200;
        for (let i = 0; i < openIds.length; i += CHUNK) {
            const chunk = openIds.slice(i, i + CHUNK);
            const ph = chunk.map(() => "?").join(",");
            const [res] = await purchasePool.query(
                `UPDATE purchase_history SET status = 'Open' WHERE order_nbr IN (${ph}) AND status <> 'Open'`,
                chunk
            );
            opened += Number(res?.affectedRows) || 0;
        }

        let closed = 0;
        if (closeStale) {
            const phAll = openIds.map(() => "?").join(",");
            const since = String(sinceDate || "").slice(0, 10);
            const sinceClause = since ? " AND DATE(order_date) >= ?" : "";
            const params = since ? [...openIds, since] : openIds;
            const [closeRes] = await purchasePool.query(
                `UPDATE purchase_history
                 SET status = 'Closed'
                 WHERE status = 'Open'
                   AND receipt_date IS NOT NULL
                   AND order_nbr NOT IN (${phAll})
                   ${sinceClause}`,
                params
            );
            closed = Number(closeRes?.affectedRows) || 0;
        }

        if (opened > 0 || closed > 0) {
            invalidateCache("po:");
            invalidateCache("openPo:");
        }
        return { opened, closed };
    },

    async ensureReceivedQtyColumn() {
        try {
            const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
            const [[row]] = await purchasePool.query(
                `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='purchase_order_details' AND COLUMN_NAME='received_qty'`,
                [purchaseDb]
            );
            if (Number(row?.cnt) === 0) {
                await purchasePool.query(
                    `ALTER TABLE purchase_order_details ADD COLUMN received_qty DECIMAL(18,4) DEFAULT 0 AFTER qty`
                );
            }
            await this.ensurePoLineCompletedColumn();
            return true;
        } catch (err) {
            console.error("[MySQL ensureReceivedQtyColumn Error]", err);
            return false;
        }
    },

    async ensurePoLineCompletedColumn() {
        try {
            const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
            const [[row]] = await purchasePool.query(
                `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='purchase_order_details' AND COLUMN_NAME='line_completed'`,
                [purchaseDb]
            );
            if (Number(row?.cnt) === 0) {
                await purchasePool.query(
                    `ALTER TABLE purchase_order_details ADD COLUMN line_completed TINYINT(1) NOT NULL DEFAULT 0 AFTER received_qty`
                );
            }
            return true;
        } catch (err) {
            console.error("[MySQL ensurePoLineCompletedColumn Error]", err);
            return false;
        }
    },

    /** Ensure PO detail warehouse/branch columns exist for Acumatica-accurate branch filtering. */
    async ensurePoWarehouseColumns() {
        try {
            const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
            for (const col of [
                { name: "warehouse_id", def: "VARCHAR(100) NULL AFTER uom" },
                { name: "branch_id", def: "VARCHAR(100) NULL AFTER warehouse_id" },
            ]) {
                const [[row]] = await purchasePool.query(
                    `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME='purchase_order_details' AND COLUMN_NAME=?`,
                    [purchaseDb, col.name]
                );
                if (Number(row?.cnt) === 0) {
                    await purchasePool.query(
                        `ALTER TABLE purchase_order_details ADD COLUMN ${col.name} ${col.def}`
                    );
                }
            }
            await this.ensurePoDestTable();
            return true;
        } catch (err) {
            console.error("[MySQL ensurePoWarehouseColumns Error]", err);
            return false;
        }
    },

    /** Indexed destination branches per PO — avoids EXISTS + UPPER(TRIM()) on every list filter. */
    async ensurePoDestTable() {
        if (MySqlService._poDestReady) return true;
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS purchase_order_dest (
                  order_nbr VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
                  branch_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
                  PRIMARY KEY (order_nbr, branch_id),
                  KEY idx_podest_branch (branch_id, order_nbr)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            MySqlService._poDestReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensurePoDestTable Error]", err);
            return false;
        }
    },

    /** Rebuild destination index rows for the given order numbers from line warehouses. */
    async upsertPurchaseOrderDestFromLines(rows = []) {
        if (!rows.length) return;
        await this.ensurePoDestTable();
        const byOrder = new Map();
        for (const r of rows) {
            const orderNbr = String(r.order_nbr || "").trim();
            const branch = String(r.warehouse_id || r.branch_id || "").trim().toUpperCase();
            if (!orderNbr || !branch) continue;
            if (!byOrder.has(orderNbr)) byOrder.set(orderNbr, new Set());
            byOrder.get(orderNbr).add(branch);
        }
        if (!byOrder.size) return;

        const connection = await purchasePool.getConnection();
        try {
            const orderNbrs = [...byOrder.keys()];
            const ph = orderNbrs.map(() => "?").join(",");
            await connection.query(`DELETE FROM purchase_order_dest WHERE order_nbr IN (${ph})`, orderNbrs);

            const values = [];
            for (const [orderNbr, branches] of byOrder) {
                for (const branchId of branches) values.push([orderNbr, branchId]);
            }
            if (values.length) {
                await connection.query(
                    `INSERT INTO purchase_order_dest (order_nbr, branch_id) VALUES ?`,
                    [values]
                );
            }
        } finally {
            connection.release();
        }
    },

    async upsertPurchaseOrderDetails(rows) {
        if (!rows.length) return;
        await this.ensureReceivedQtyColumn();
        await this.ensurePoWarehouseColumns();
        const connection = await purchasePool.getConnection();
        try {
            const sql = `
                INSERT INTO purchase_order_details
                (order_nbr, line_nbr, inventory_id, description, qty, received_qty, line_completed, uom, warehouse_id, branch_id, ext_cost, last_sync)
                VALUES ?
                ON DUPLICATE KEY UPDATE
                inventory_id = VALUES(inventory_id),
                description = VALUES(description),
                qty = VALUES(qty),
                received_qty = VALUES(received_qty),
                line_completed = VALUES(line_completed),
                uom = VALUES(uom),
                warehouse_id = COALESCE(NULLIF(VALUES(warehouse_id), ''), warehouse_id),
                branch_id = COALESCE(NULLIF(VALUES(branch_id), ''), branch_id),
                ext_cost = VALUES(ext_cost),
                last_sync = VALUES(last_sync)
            `;
            const values = rows.map(r => [
                r.order_nbr,
                r.line_nbr,
                r.inventory_id,
                r.description,
                r.qty,
                r.received_qty ?? 0,
                r.line_completed ? 1 : 0,
                r.uom,
                r.warehouse_id || r.branch_id || null,
                r.branch_id || r.warehouse_id || null,
                r.ext_cost,
                r.last_sync,
            ]);
            await connection.query(sql, [values]);
            invalidateCache("itemVendorMap");
            invalidateCache("openPo:");
        } finally {
            connection.release();
        }
        await this.upsertPurchaseOrderDestFromLines(rows);
    },

    async upsertVendors(rows) {
        if (!rows.length) return;
        const connection = await purchasePool.getConnection();
        try {
            const sql = `
                INSERT INTO vendors (vendor_id, vendor_name, status, last_sync)
                VALUES ?
                ON DUPLICATE KEY UPDATE
                vendor_name = COALESCE(NULLIF(VALUES(vendor_name), ''), vendor_name),
                status = VALUES(status),
                last_sync = VALUES(last_sync)
            `;
            const values = rows.map(r => [r.vendor_id, r.vendor_name, r.status, r.last_sync]);
            await connection.query(sql, [values]);
        } finally {
            connection.release();
        }
    },

    async getVendorNamesByIds(vendorIds = []) {
        const ids = [...new Set((vendorIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
        if (!ids.length) return {};

        try {
            const placeholders = ids.map(() => "?").join(", ");
            const [rows] = await purchasePool.query(
                `SELECT vendor_id, vendor_name
                 FROM vendors
                 WHERE vendor_id IN (${placeholders})`,
                ids
            );
            return rows.reduce((acc, row) => {
                const name = String(row.vendor_name || "").trim();
                if (name) acc[row.vendor_id] = name;
                return acc;
            }, {});
        } catch (err) {
            console.error("[MySQL getVendorNamesByIds Error]", err);
            return {};
        }
    },

    /**
     * Backfill missing purchase_history.vendor_name from vendors table and sibling PO rows.
     */
    async backfillPurchaseHistoryVendorNames() {
        try {
            let updated = 0;
            const [fromVendors] = await purchasePool.query(`
                UPDATE purchase_history h
                INNER JOIN vendors v ON v.vendor_id COLLATE utf8mb4_unicode_ci = h.vendor_id
                SET h.vendor_name = v.vendor_name
                WHERE (h.vendor_name IS NULL OR TRIM(h.vendor_name) = '')
                  AND v.vendor_name IS NOT NULL
                  AND TRIM(v.vendor_name) != ''
            `);
            updated += Number(fromVendors?.affectedRows) || 0;

            // Same vendor_id already has a name on another PO — copy it
            const [fromSibling] = await purchasePool.query(`
                UPDATE purchase_history h
                INNER JOIN (
                    SELECT vendor_id, MAX(NULLIF(TRIM(vendor_name), '')) AS vendor_name
                    FROM purchase_history
                    WHERE vendor_id IS NOT NULL AND TRIM(COALESCE(vendor_name, '')) != ''
                    GROUP BY vendor_id
                ) src ON src.vendor_id COLLATE utf8mb4_unicode_ci = h.vendor_id
                SET h.vendor_name = src.vendor_name
                WHERE (h.vendor_name IS NULL OR TRIM(h.vendor_name) = '')
                  AND src.vendor_name IS NOT NULL
            `);
            updated += Number(fromSibling?.affectedRows) || 0;
            if (updated > 0) invalidateCache("po:");
            return updated;
        } catch (err) {
            console.error("[MySQL backfillPurchaseHistoryVendorNames Error]", err);
            return 0;
        }
    },

    /**
     * Normalize legacy status spellings so Active / On Hold filters stay consistent.
     */
    async normalizePurchaseOrderStatusAliases() {
        try {
            let n = 0;
            const [hold] = await purchasePool.query(
                `UPDATE purchase_history SET status = 'On Hold' WHERE status = 'Hold'`
            );
            n += Number(hold?.affectedRows) || 0;
            const [canceled] = await purchasePool.query(
                `UPDATE purchase_history SET status = 'Cancelled' WHERE status = 'Canceled'`
            );
            n += Number(canceled?.affectedRows) || 0;
            if (n > 0) {
                invalidateCache("po:");
                invalidateCache("openPo:");
            }
            return n;
        } catch (err) {
            console.error("[MySQL normalizePurchaseOrderStatusAliases Error]", err);
            return 0;
        }
    },

    /**
     * Repair header total_amount from line extended costs when header is 0 but lines have value.
     */
    async repairPurchaseOrderAmounts() {
        try {
            const [result] = await purchasePool.query(`
                UPDATE purchase_history h
                INNER JOIN (
                    SELECT order_nbr, SUM(ext_cost) AS line_total
                    FROM purchase_order_details
                    GROUP BY order_nbr
                    HAVING SUM(ext_cost) > 0
                ) x ON x.order_nbr COLLATE utf8mb4_unicode_ci = h.order_nbr COLLATE utf8mb4_unicode_ci
                SET h.total_amount = x.line_total
                WHERE h.total_amount IS NULL OR h.total_amount = 0
            `);
            const n = Number(result?.affectedRows) || 0;
            if (n > 0) invalidateCache("po:");
            return n;
        } catch (err) {
            console.error("[MySQL repairPurchaseOrderAmounts Error]", err);
            return 0;
        }
    },

    /**
     * Fetch unique vendors from vendors table
     */
    async getVendors({ page = 1, pageSize = 50, search = "" }) {
        const offset = (page - 1) * pageSize;
        const limitInt = parseInt(pageSize, 10);
        const offsetInt = parseInt(offset, 10);

        try {
            let whereClause = "";
            let params = [];

            if (search) {
                whereClause = "WHERE vendor_id LIKE ? OR vendor_name LIKE ?";
                params = [`%${search}%`, `%${search}%`];
            }

            const [rows] = await purchasePool.query(
                `SELECT 
                    vendor_id as VendorID,
                    vendor_name as VendorName,
                    status as Status,
                    COALESCE(avg_lead_time, 0) as AvgLeadTime,
                    COALESCE(reliability_score, 100.00) as ReliabilityScore
                 FROM vendors
                 ${whereClause}
                 ORDER BY VendorName ASC
                 LIMIT ${limitInt} OFFSET ${offsetInt}`,
                params
            );

            const [[{ total }]] = await purchasePool.query(
                `SELECT COUNT(*) as total FROM vendors ${whereClause}`,
                params
            );

            return {
                data: rows.map(r => ({
                    VendorID: { value: r.VendorID },
                    VendorName: { value: r.VendorName },
                    Status: { value: r.Status },
                    AvgLeadTime: { value: r.AvgLeadTime },
                    ReliabilityScore: { value: r.ReliabilityScore }
                })),
                totalCount: total
            };
        } catch (err) {
            console.error("[MySQL getVendors Error]", err);
            throw err;
        }
    },

    /**
     * Calculate and persist performance metrics for all vendors
     */
    async calculateAndStoreVendorPerformance() {
        try {
            console.log(">>> [MySQL] Calculating Vendor Performance Metrics...");
            
            // 1. Get Lead Times
            const leadTimes = await this.getVendorLeadTimes();
            
            // 2. Get Reliability Scores
            const reliability = await this.getSupplierPerformance();
            
            // 3. Update Vendors table
            const vendorIds = new Set([...Object.keys(leadTimes), ...Object.keys(reliability)]);
            
            for (const vid of vendorIds) {
                const lt = leadTimes[vid]?.days || 0;
                const rs = reliability[vid]?.score ?? null;
                
                await purchasePool.query(
                    `UPDATE vendors SET avg_lead_time = ?, reliability_score = ? WHERE vendor_id = ?`,
                    [lt, rs, vid]
                );
            }
            
            console.log(`>>> [MySQL] Performance calculation complete for ${vendorIds.size} vendors.`);
            return vendorIds.size;
        } catch (err) {
            console.error("[MySQL calculateAndStoreVendorPerformance Error]", err);
            throw err;
        }
    },

    /**
     * Get a map of inventory IDs to their latest vendor IDs.
     * Cached briefly — invalidated when PO history/details upsert.
     */
    async getItemVendorMap() {
        return getCached("itemVendorMap", 180_000, () => this._getItemVendorMapImpl());
    },

    async _getItemVendorMapImpl() {
        try {
            const [rows] = await purchasePool.query(`
                SELECT d.inventory_id, h.vendor_id
                FROM purchase_history h
                JOIN purchase_order_details d ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
                INNER JOIN (
                    SELECT d2.inventory_id, MAX(h2.order_date) as max_date
                    FROM purchase_history h2
                    JOIN purchase_order_details d2 ON h2.order_nbr COLLATE utf8mb4_unicode_ci = d2.order_nbr
                    GROUP BY d2.inventory_id
                ) latest ON d.inventory_id = latest.inventory_id AND h.order_date = latest.max_date
            `);
            const map = new Map();
            rows.forEach(r => map.set(String(r.inventory_id || "").toUpperCase().trim(), r.vendor_id));
            return map;
        } catch (err) {
            console.error("[MySQL getItemVendorMap Error]", err);
            return new Map();
        }
    },

    /**
     * Get the latest vendor for a specific inventory item from purchase history
     */
    async getLatestVendorForItem(inventoryId) {
        try {
            const [rows] = await purchasePool.query(`
                SELECT h.vendor_id
                FROM purchase_history h
                JOIN purchase_order_details d ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
                WHERE d.inventory_id = ?
                ORDER BY h.order_date DESC
                LIMIT 1
            `, [inventoryId]);
            return rows[0]?.vendor_id || null;
        } catch (err) {
            console.error("[MySQL getLatestVendorForItem Error]", err);
            return null;
        }
    },

    /**
     * Calculate average lead times per vendor (Order Date to Receipt Date)
     */
    async getVendorLeadTimes() {
        return getCached("vendorLeadTimes", 60_000, () => this._computeVendorLeadTimes());
    },

    async _computeVendorLeadTimes() {
        try {
            const [rows] = await purchasePool.query(`
                SELECT 
                    vendor_id,
                    AVG(DATEDIFF(receipt_date, order_date)) as avg_lead_time,
                    COUNT(*) as sample_size
                FROM purchase_history
                WHERE status IN ('Closed', 'Completed') 
                  AND order_date IS NOT NULL 
                  AND receipt_date IS NOT NULL
                  AND order_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
                GROUP BY vendor_id
            `);
            return rows.reduce((acc, row) => {
                acc[row.vendor_id] = {
                    days: Math.round(row.avg_lead_time) || 0,
                    sample: row.sample_size,
                    source: "actual",
                };
                return acc;
            }, {});
        } catch (err) {
            console.error("[MySQL getVendorLeadTimes Error]", err);
            return {};
        }
    },

    /**
     * Vendor lead times for replenishment — user-entered values from Suppliers take priority over calculated actuals.
     */
    async getEffectiveVendorLeadTimes() {
        const calculated = await this.getVendorLeadTimes();
        const annotations = await this.getAnnotations("supplier");
        const merged = { ...calculated };

        for (const [vendorId, fields] of Object.entries(annotations)) {
            const raw = fields?.leadTime;
            if (raw === undefined || raw === null || raw === "") continue;
            const days = parseInt(String(raw).trim(), 10);
            if (!Number.isNaN(days) && days >= 0) {
                merged[vendorId] = { days, sample: 0, source: "user" };
            }
        }

        return merged;
    },

    /**
     * Open purchase order quantities by inventory ID for a destination warehouse
     * (or retail branch stock-warehouse group, e.g. MANILA + MNL-MRILAO).
     * Forecast and Replenishment both use remaining qty (Order Qty − QtyOnReceipts)
     * and exclude On Hold / Hold.
     */
    async getOpenPoQtyByItem({ warehouseId = "MAIN", includeOnHold = false, useOrderQty = false } = {}) {
        const destKey = String(warehouseId || "MAIN").trim().toUpperCase() || "MAIN";
        const cacheKey = `openPo:v5:${destKey}:h${includeOnHold ? 1 : 0}:o${useOrderQty ? 1 : 0}`;
        return getCached(cacheKey, 60_000, () =>
            this._getOpenPoQtyByItemUncached(destKey, { includeOnHold, useOrderQty })
        );
    },

    async _getOpenPoQtyByItemUncached(warehouseId = "MAIN", { includeOnHold = false, useOrderQty = false } = {}) {
        try {
            await this.ensureReceivedQtyColumn();
            await this.ensurePoWarehouseColumns();
            const destinations = getStockWarehouseIdsForBranch(warehouseId);
            if (!destinations.length) return new Map();

            const openStatuses = openPoHeaderStatuses({ includeOnHold });
            const branchMatch = sqlMatchOpenPoForBranch({
                detailsAlias: "d",
                headerAlias: "h",
                destinations,
            });
            const qtyExpr = useOrderQty ? sqlPoLineOrderQty("d") : sqlPoLineOpenQty("d");

            const [rows] = await purchasePool.query(
                `
                SELECT
                    UPPER(REPLACE(TRIM(d.inventory_id), ' ', '')) as inventoryId,
                    COALESCE(SUM(${qtyExpr}), 0) as openQty
                FROM purchase_order_details d
                INNER JOIN purchase_history h
                    ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
                WHERE h.status IN (${openStatuses.map(() => "?").join(", ")})
                  AND d.inventory_id IS NOT NULL
                  AND d.inventory_id != ''
                  AND (${qtyExpr}) > 0
                  AND ${branchMatch.clause}
                GROUP BY UPPER(REPLACE(TRIM(d.inventory_id), ' ', ''))
                `,
                [...openStatuses, ...branchMatch.params]
            );
            const map = new Map();
            for (const row of rows) {
                const key = normalizeInvKey(row.inventoryId);
                if (key) map.set(key, Number(row.openQty) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL getOpenPoQtyByItem Error]", err);
            return new Map();
        }
    },

    /** Open PO qty for a small set of SKUs — avoids scanning all PO lines on paginated reads. */
    async getOpenPoQtyForItems(inventoryIds, { warehouseId = "MAIN", includeOnHold = false, useOrderQty = false } = {}) {
        const keys = [...new Set((inventoryIds || []).map((id) => normalizeInvKey(id)).filter(Boolean))];
        if (!keys.length) return new Map();

        try {
            await this.ensureReceivedQtyColumn();
            await this.ensurePoWarehouseColumns();
            const destKey = String(warehouseId || "MAIN").trim().toUpperCase() || "MAIN";
            const destinations = getStockWarehouseIdsForBranch(destKey);
            if (!destinations.length) return new Map();

            const openStatuses = openPoHeaderStatuses({ includeOnHold });
            const branchMatch = sqlMatchOpenPoForBranch({
                detailsAlias: "d",
                headerAlias: "h",
                destinations,
            });
            const qtyExpr = useOrderQty ? sqlPoLineOrderQty("d") : sqlPoLineOpenQty("d");
            const idPh = keys.map(() => "?").join(", ");

            const [rows] = await purchasePool.query(
                `
                SELECT
                    UPPER(REPLACE(TRIM(d.inventory_id), ' ', '')) as inventoryId,
                    COALESCE(SUM(${qtyExpr}), 0) as openQty
                FROM purchase_order_details d
                INNER JOIN purchase_history h
                    ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
                WHERE h.status IN (${openStatuses.map(() => "?").join(", ")})
                  AND d.inventory_id IS NOT NULL
                  AND d.inventory_id != ''
                  AND (${qtyExpr}) > 0
                  AND ${branchMatch.clause}
                  AND UPPER(REPLACE(TRIM(d.inventory_id), ' ', '')) IN (${idPh})
                GROUP BY UPPER(REPLACE(TRIM(d.inventory_id), ' ', ''))
                `,
                [...openStatuses, ...branchMatch.params, ...keys]
            );
            const map = new Map();
            for (const row of rows) {
                const key = normalizeInvKey(row.inventoryId);
                if (key) map.set(key, Number(row.openQty) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL getOpenPoQtyForItems Error]", err);
            return new Map();
        }
    },

    /**
     * Get calculated reliability scores for all vendors
     */
    async getSupplierPerformance() {
        return getCached("supplierPerformance", 60_000, () => this._computeSupplierPerformance());
    },

    async _computeSupplierPerformance() {
        try {
            const [rows] = await purchasePool.query(`
                SELECT 
                    vendor_id,
                    COUNT(*) as total_orders,
                    SUM(CASE WHEN receipt_date <= promised_date THEN 1 ELSE 0 END) as on_time_orders,
                    ROUND(
                        (SUM(CASE WHEN receipt_date <= promised_date THEN 1 ELSE 0 END) / COUNT(*)) * 100, 
                        2
                    ) as reliability_score
                FROM purchase_history
                WHERE status IN ('Closed', 'Completed')
                  AND promised_date IS NOT NULL
                  AND receipt_date IS NOT NULL
                  AND order_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
                GROUP BY vendor_id
            `);
            return rows.reduce((acc, row) => {
                acc[row.vendor_id] = {
                    score: Number(row.reliability_score),
                    totalOrders: Number(row.total_orders),
                    onTimeOrders: Number(row.on_time_orders)
                };
                return acc;
            }, {});
        } catch (err) {
            console.error("[MySQL getSupplierPerformance Error]", err);
            return {};
        }
    },

    /**
     * Fetch inventory with pagination, search, and branch filtering (for Dashboard)
     */
    async getInventory({ page = 1, pageSize = 50, search = "", branch = "", filter = "", companyId = "main" }) {
        const offset = (page - 1) * pageSize;
        const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
        const searchTerm = normalizeInventorySearch(search);
        const destinations = branch ? getStockWarehouseIdsForBranch(branch) : [];

        if (branch && isExcludedBranchAlias(branch)) {
            return { data: [], totalCount: 0, hasMore: false };
        }

        try {
            await this.ensureInventoryPlanningColumns();
            // Catalog rows can be wiped while warehouse stock remains — rebuild before listing.
            await this.ensureCatalogRowsFromWarehouse(effectiveCompanyId);

            if (filter === "damage") {
                return await this._getDamageInventory({
                    page,
                    pageSize,
                    offset,
                    searchTerm,
                    effectiveCompanyId,
                });
            }

            const layout = await resolveInventoryLayout(effectiveCompanyId);
            const hasWarehouse = layout === "warehouse";

            if (filter && !hasWarehouse) {
                return { data: [], totalCount: 0, hasMore: false, dataMode: "warehouse-missing" };
            }

            // Always list from catalog so imported Stock Items appear even when
            // only a subset of warehouses have stock rows (branch filter LEFT JOINs qty).
            // Dead/overstock still need warehouse-anchored rows with sales joins.
            const needsWarehouseFilter = filter === "dead_stock" || filter === "overstock";
            if (!needsWarehouseFilter) {
                return await this._getInventoryFromCatalogWithStock({
                    page,
                    pageSize,
                    offset,
                    searchTerm,
                    branch,
                    destinations,
                    filter,
                    effectiveCompanyId,
                    purchaseDb,
                    hasWarehouse,
                    layout,
                });
            }

            // Browse warehouse stock (optional branch / related-warehouse group)
            let whereClauses = [
                "i.company_id = ?",
                "i.default_warehouse IS NOT NULL",
                "i.default_warehouse != '__catalog__'",
            ];
            let params = [effectiveCompanyId];

            const branchEx = sqlExcludeBranches("i");
            whereClauses.push(branchEx.clause);
            params.push(...branchEx.params);

            if (branch) {
                const match = sqlMatchBranchWarehouses("i", destinations);
                whereClauses.push(match.clause);
                params.push(...match.params);
            }

            if (effectiveCompanyId === "main") {
                const ecomEx = sqlExcludeEcomBranches("i");
                whereClauses.push(ecomEx.clause);
                params.push(...ecomEx.params);
            } else if (effectiveCompanyId === "ecommerce") {
                const ecomOnly = sqlOnlyEcomBranches("i");
                whereClauses.push(ecomOnly.clause);
                params.push(...ecomOnly.params);
            }

            if (filter === "low_stock") {
                whereClauses.push("i.on_hand > 0 AND i.on_hand < 10");
            } else if (filter === "out_of_stock") {
                whereClauses.push("i.on_hand <= 0");
            } else if (filter === "dead_stock") {
                whereClauses.push("i.on_hand > 0 AND COALESCE(s.total_qty, 0) <= 0");
            } else if (filter === "overstock") {
                whereClauses.push("i.on_hand > (COALESCE(s.total_qty, 0) * 2) AND COALESCE(s.total_qty, 0) > 0");
            }

            if (searchTerm) {
                whereClauses.push(
                    "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(c.inventory_name, i.inventory_name, '')) LIKE UPPER(?))"
                );
                params.push(`%${searchTerm}%`, `%${searchTerm}%`);
            }

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;
            const limitInt = parseInt(pageSize, 10);
            const offsetInt = parseInt(offset, 10);

            const needsSalesJoin = filter === "dead_stock" || filter === "overstock";
            const salesEx = needsSalesJoin ? sqlExcludeSalesBranches("branch_name") : null;
            const salesParams = needsSalesJoin ? [...salesEx.params] : [];
            const salesJoin = needsSalesJoin
                ? `LEFT JOIN ${netSalesQtySubquery(purchaseDb, salesEx)} s ON i.inventory_id = s.inventory_id`
                : "";
            const qtySoldSelect = needsSalesJoin ? "COALESCE(s.total_qty, 0) as QtySold" : "0 as QtySold";

            // Branch groups (MAIN + MAIN WH11, MANILA + satellites): one row per item with summed qty
            if (branch && destinations.length > 1) {
                const stockMatch = sqlMatchBranchWarehouses("w", destinations);
                const aggFrom = `
                    FROM (
                        SELECT
                            w.inventory_id,
                            w.company_id,
                            SUM(COALESCE(w.on_hand, 0)) AS on_hand,
                            SUM(COALESCE(w.available, w.on_hand, 0)) AS available,
                            MIN(w.branch_id) AS branch_id,
                            MIN(w.site_id) AS site_id,
                            MIN(w.default_warehouse) AS default_warehouse,
                            MAX(w.last_sync) AS last_sync
                        FROM \`${INVENTORY_VIEW_TABLE}\` w
                        WHERE w.company_id = ?
                          AND w.default_warehouse != '__catalog__'
                          AND ${stockMatch.clause}
                        GROUP BY w.inventory_id, w.company_id
                    ) i
                    LEFT JOIN \`${INVENTORY_VIEW_TABLE}\` c
                      ON c.inventory_id = i.inventory_id
                     AND c.company_id = i.company_id
                     AND c.default_warehouse = '__catalog__'
                `;
                const aggParams = [effectiveCompanyId, ...stockMatch.params];
                // Rebuild filter where on aggregated aliases (no branch exclude needed — already scoped)
                const aggWhere = [];
                const aggWhereParams = [];
                if (searchTerm) {
                    aggWhere.push(
                        "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(c.inventory_name, '')) LIKE UPPER(?))"
                    );
                    aggWhereParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
                }
                if (filter === "low_stock") {
                    aggWhere.push("i.on_hand > 0 AND i.on_hand < 10");
                } else if (filter === "out_of_stock") {
                    aggWhere.push("i.on_hand <= 0");
                } else if (filter === "dead_stock") {
                    aggWhere.push("i.on_hand > 0 AND COALESCE(s.total_qty, 0) <= 0");
                } else if (filter === "overstock") {
                    aggWhere.push("i.on_hand > (COALESCE(s.total_qty, 0) * 2) AND COALESCE(s.total_qty, 0) > 0");
                }
                const aggWherePart = aggWhere.length ? `WHERE ${aggWhere.join(" AND ")}` : "";
                const selectCols = `
                    i.inventory_id as InventoryID,
                    COALESCE(c.inventory_name, i.inventory_id) as Description,
                    COALESCE(c.item_class, '') as ItemClass,
                    COALESCE(i.branch_id, ?) as Branch,
                    COALESCE(i.site_id, i.default_warehouse, ?) as SiteID,
                    COALESCE(i.on_hand, 0) as OnHand,
                    COALESCE(i.available, i.on_hand, 0) as Available,
                    COALESCE(c.default_price, 0) as DefaultPrice,
                    ${inventoryPlanningCols("c")}`;
                const displayBranch = branch || destinations[0];
                const query = `
                    SELECT ${selectCols}, ${qtySoldSelect}
                    ${aggFrom}
                    ${salesJoin}
                    ${aggWherePart}
                    ORDER BY i.inventory_id ASC
                    LIMIT ${limitInt} OFFSET ${offsetInt}`;
                const [rows] = await pool.query(query, [
                    displayBranch,
                    displayBranch,
                    ...aggParams,
                    ...salesParams,
                    ...aggWhereParams,
                ]);
                const [[{ total }]] = await pool.query(
                    `SELECT COUNT(*) as total ${aggFrom} ${salesJoin} ${aggWherePart}`,
                    [...aggParams, ...salesParams, ...aggWhereParams]
                );
                return {
                    data: mapInventoryRows(rows),
                    totalCount: total,
                    hasMore: total > offset + pageSize,
                    dataMode: "warehouse",
                };
            }

            const fromClause = inventoryFromClause("warehouse");
            const selectCols = inventorySelectCols("warehouse");
            const query = `
                SELECT 
                    ${selectCols},
                    ${qtySoldSelect}
                 ${fromClause}
                 ${salesJoin}
                 ${wherePart} 
                 ORDER BY i.inventory_id ASC 
                 LIMIT ${limitInt} OFFSET ${offsetInt}`;

            const [rows] = await pool.query(query, [...salesParams, ...params]);
            const [[{ total }]] = await pool.query(
                `SELECT COUNT(*) as total 
                 ${fromClause}
                 ${salesJoin}
                 ${wherePart}`,
                [...salesParams, ...params]
            );

            return {
                data: mapInventoryRows(rows),
                totalCount: total,
                hasMore: total > offset + pageSize,
                dataMode: "warehouse",
            };
        } catch (err) {
            console.error("[MySQL getInventory Error]", err);
            throw err;
        }
    },

    /**
     * Catalog-anchored inventory list with optional branch stock (LEFT JOIN).
     * Used for search (always) and when warehouse levels are not synced yet.
     */
    async _getInventoryFromCatalogWithStock({
        page,
        pageSize,
        offset,
        searchTerm,
        branch,
        destinations,
        filter,
        effectiveCompanyId,
        purchaseDb,
        hasWarehouse,
        layout,
    }) {
        const limitInt = parseInt(pageSize, 10);
        const offsetInt = parseInt(offset, 10);
        const displayBranch = branch || (destinations[0] || "");
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";

        // Multi-warehouse stock lives in forecast_item_stock (CMS blocks twins on product_inventory_items).
        await this.ensureForecastItemStockTable();
        const [[fisWh]] = await purchasePool.query(
            `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
             WHERE company_id = ? AND warehouse_id != '__catalog__'`,
            [effectiveCompanyId]
        );
        const useForecast = Number(fisWh?.c) > 0;
        const stockTable = useForecast ? FORECAST_STOCK_TABLE : INVENTORY_VIEW_TABLE;
        const whCol = useForecast ? "warehouse_id" : "default_warehouse";
        const nameCol = useForecast ? "item_name" : "inventory_name";
        const queryPool = useForecast ? purchasePool : pool;

        let stockJoin = "";
        let stockParams = [];
        if (hasWarehouse && destinations.length) {
            const match = useForecast
                ? sqlMatchForecastWarehouses("w", destinations, whCol)
                : sqlMatchBranchWarehouses("w", destinations);
            stockJoin = `
                LEFT JOIN (
                    SELECT
                        w.inventory_id,
                        w.company_id,
                        SUM(COALESCE(w.on_hand, 0)) AS on_hand,
                        SUM(COALESCE(w.available, w.on_hand, 0)) AS available,
                        MIN(w.branch_id) AS branch_id,
                        MIN(w.site_id) AS site_id,
                        MIN(w.${whCol}) AS default_warehouse
                    FROM \`${stockTable}\` w
                    WHERE w.company_id = ?
                      AND w.${whCol} != '__catalog__'
                      AND ${match.clause}
                    GROUP BY w.inventory_id, w.company_id
                ) w ON w.inventory_id = i.inventory_id AND w.company_id = i.company_id`;
            stockParams = [effectiveCompanyId, ...match.params];
        } else if (hasWarehouse && !branch) {
            stockJoin = `
                LEFT JOIN (
                    SELECT
                        w.inventory_id,
                        w.company_id,
                        SUM(COALESCE(w.on_hand, 0)) AS on_hand,
                        SUM(COALESCE(w.available, w.on_hand, 0)) AS available,
                        MIN(w.branch_id) AS branch_id,
                        MIN(w.site_id) AS site_id,
                        MIN(w.${whCol}) AS default_warehouse
                    FROM \`${stockTable}\` w
                    WHERE w.company_id = ?
                      AND w.${whCol} != '__catalog__'
                    GROUP BY w.inventory_id, w.company_id
                ) w ON w.inventory_id = i.inventory_id AND w.company_id = i.company_id`;
            stockParams = [effectiveCompanyId];
        }

        // Prefer forecast catalog; if missing, distinct warehouse IDs as product list.
        const [[fisCat]] = useForecast
            ? await purchasePool.query(
                `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ? AND warehouse_id = '__catalog__'`,
                [effectiveCompanyId]
              )
            : [[{ c: 0 }]];
        const catalogFromForecast = useForecast && Number(fisCat?.c) > 0;
        const synthesizeCatalog = useForecast && !catalogFromForecast;

        const whereClauses = synthesizeCatalog
            ? [`i.company_id = ?`]
            : [`i.company_id = ?`, `i.${whCol} = '__catalog__'`];
        const params = [effectiveCompanyId];

        if (searchTerm) {
            whereClauses.push(
                `(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.${nameCol}, '')) LIKE UPPER(?))`
            );
            params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        if (filter && hasWarehouse) {
            if (filter === "low_stock") {
                whereClauses.push("COALESCE(w.on_hand, 0) > 0 AND COALESCE(w.on_hand, 0) < 10");
            } else if (filter === "out_of_stock") {
                whereClauses.push("COALESCE(w.on_hand, 0) <= 0");
            }
        } else if (filter && !hasWarehouse) {
            return { data: [], totalCount: 0, hasMore: false, dataMode: "warehouse-missing" };
        }

        const wherePart = `WHERE ${whereClauses.join(" AND ")}`;
        // Planning fields live on CMS product row (one per SKU).
        const planningJoin = useForecast
            ? `LEFT JOIN \`${inventoryDb}\`.\`${INVENTORY_SYNC_TABLE}\` p
                 ON TRIM(p.inventory_id) = TRIM(i.inventory_id)
                AND p.company_id = i.company_id`
            : "";
        const planningAlias = useForecast ? "p" : "i";

        const selectCols = `
            i.inventory_id as InventoryID,
            COALESCE(i.${nameCol}, i.inventory_id) as Description,
            COALESCE(i.item_class, '') as ItemClass,
            COALESCE(NULLIF(TRIM(w.branch_id), ''), NULLIF(TRIM(w.default_warehouse), ''), ?) as Branch,
            COALESCE(NULLIF(TRIM(w.site_id), ''), NULLIF(TRIM(w.default_warehouse), ''), ?) as SiteID,
            COALESCE(w.on_hand, 0) as OnHand,
            COALESCE(w.available, w.on_hand, 0) as Available,
            COALESCE(i.default_price, 0) as DefaultPrice,
            ${inventoryPlanningCols(planningAlias)},
            0 as QtySold`;

        const fromBody = !synthesizeCatalog
            ? `FROM \`${stockTable}\` i
               ${planningJoin}
               ${stockJoin}`
            : `FROM (
                 SELECT company_id, TRIM(inventory_id) AS inventory_id,
                        MAX(${nameCol}) AS ${nameCol},
                        MAX(item_class) AS item_class,
                        MAX(default_price) AS default_price,
                        MAX(item_status) AS item_status,
                        '__catalog__' AS ${whCol}
                 FROM \`${stockTable}\`
                 WHERE company_id = ?
                   AND ${whCol} != '__catalog__'
                 GROUP BY company_id, TRIM(inventory_id)
               ) i
               ${planningJoin}
               ${stockJoin}`;

        const fromParams = synthesizeCatalog ? [effectiveCompanyId] : [];

        const query = `
            SELECT ${selectCols}
            ${fromBody}
            ${wherePart}
            ORDER BY i.inventory_id ASC
            LIMIT ${limitInt} OFFSET ${offsetInt}`;

        const [rows] = await queryPool.query(query, [
            displayBranch || null,
            displayBranch || null,
            ...fromParams,
            ...stockParams,
            ...params,
        ]);

        const [[{ total }]] = await queryPool.query(
            `SELECT COUNT(*) as total
             ${fromBody}
             ${wherePart}`,
            [...fromParams, ...stockParams, ...params]
        );

        return {
            data: mapInventoryRows(rows),
            totalCount: total,
            hasMore: total > offset + pageSize,
            dataMode: hasWarehouse ? "warehouse" : (total > 0 ? "warehouse-missing" : layout),
        };
    },

    /** Damage / discounted warehouse stock for the Damage KPI modal. */
    async _getDamageInventory({ page, pageSize, offset, searchTerm, effectiveCompanyId }) {
        await this.ensureForecastItemStockTable();
        const [[fisDmg]] = await purchasePool.query(
            `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
             WHERE company_id = ?
               AND (
                 UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DAMAGE%'
                 OR UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DISCOUNTED%'
               )
               AND COALESCE(on_hand, 0) > 0`,
            [effectiveCompanyId]
        );
        const useForecast = Number(fisDmg?.c) > 0;
        const limitInt = parseInt(pageSize, 10) || 50;
        const offsetInt = parseInt(offset, 10) || 0;

        if (useForecast) {
            const whereClauses = [
                "i.company_id = ?",
                "i.warehouse_id != '__catalog__'",
                `(UPPER(TRIM(COALESCE(i.warehouse_id,''))) LIKE '%DAMAGE%'
                  OR UPPER(TRIM(COALESCE(i.warehouse_id,''))) LIKE '%DISCOUNTED%'
                  OR UPPER(TRIM(COALESCE(i.branch_id,''))) LIKE '%DAMAGE%'
                  OR UPPER(TRIM(COALESCE(i.branch_id,''))) LIKE '%DISCOUNTED%')`,
                "COALESCE(i.on_hand, 0) > 0",
            ];
            const params = [effectiveCompanyId];
            if (searchTerm) {
                whereClauses.push(
                    "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.item_name,'')) LIKE UPPER(?))"
                );
                params.push(`%${searchTerm}%`, `%${searchTerm}%`);
            }
            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;
            const [rows] = await purchasePool.query(
                `SELECT
                    TRIM(i.inventory_id) AS InventoryID,
                    i.item_name AS Description,
                    i.item_class AS ItemClass,
                    i.branch_id AS Branch,
                    i.site_id AS SiteID,
                    i.on_hand AS OnHand,
                    i.available AS Available,
                    i.default_price AS DefaultPrice,
                    NULL AS SafetyStock,
                    NULL AS MOQ,
                    NULL AS VendorID,
                    NULL AS LeadTimeDays,
                    0 AS QtySold
                 FROM \`${FORECAST_STOCK_TABLE}\` i
                 ${wherePart}
                 ORDER BY i.on_hand DESC, TRIM(i.inventory_id) ASC
                 LIMIT ${limitInt} OFFSET ${offsetInt}`,
                params
            );
            const [[{ total }]] = await purchasePool.query(
                `SELECT COUNT(*) AS total FROM \`${FORECAST_STOCK_TABLE}\` i ${wherePart}`,
                params
            );
            return {
                data: mapInventoryRows(rows),
                totalCount: Number(total) || 0,
                hasMore: (Number(total) || 0) > offsetInt + limitInt,
                dataMode: "damage",
            };
        }

        const damageEx = sqlOnlyDamageBranches("i");
        const whereClauses = [
            "i.company_id = ?",
            "i.default_warehouse != '__catalog__'",
            damageEx.clause,
            "COALESCE(i.on_hand, 0) > 0",
        ];
        const params = [effectiveCompanyId, ...damageEx.params];

        if (searchTerm) {
            whereClauses.push(
                "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.inventory_name,'')) LIKE UPPER(?))"
            );
            params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        const wherePart = `WHERE ${whereClauses.join(" AND ")}`;

        const [rows] = await pool.query(
            `SELECT
                TRIM(i.inventory_id) AS InventoryID,
                i.inventory_name AS Description,
                i.item_class AS ItemClass,
                i.branch_id AS Branch,
                i.site_id AS SiteID,
                i.on_hand AS OnHand,
                i.available AS Available,
                i.default_price AS DefaultPrice,
                i.safety_stock AS SafetyStock,
                i.moq AS MOQ,
                i.vendor_id AS VendorID,
                i.lead_time_days AS LeadTimeDays,
                0 AS QtySold
             FROM \`${INVENTORY_VIEW_TABLE}\` i
             ${wherePart}
             ORDER BY i.on_hand DESC, TRIM(i.inventory_id) ASC
             LIMIT ${limitInt} OFFSET ${offsetInt}`,
            params
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM \`${INVENTORY_VIEW_TABLE}\` i ${wherePart}`,
            params
        );

        return {
            data: mapInventoryRows(rows),
            totalCount: Number(total) || 0,
            hasMore: (Number(total) || 0) > offsetInt + limitInt,
            dataMode: "damage",
        };
    },

    /**
     * List products from catalog rows when warehouse levels have not been synced yet.
     */
    async getInventoryFromCatalog({ page, pageSize, search, companyId, offset, purchaseDb }) {
        await this.ensureInventoryPlanningColumns();

        const limitInt = parseInt(pageSize, 10);
        const offsetInt = parseInt(offset, 10);
        const whereParts = ["i.company_id = ?", "i.default_warehouse = '__catalog__'"];
        const params = [companyId];

        if (search) {
            whereParts.push("(i.inventory_id LIKE ? OR i.inventory_name LIKE ?)");
            params.push(`%${search}%`, `%${search}%`);
        }

        const wherePart = `WHERE ${whereParts.join(" AND ")}`;
        const salesEx = sqlExcludeSalesBranches("branch_name");
        const salesParams = [...salesEx.params];
        const db = purchaseDb || process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";

        const query = `
            SELECT
                i.inventory_id as InventoryID,
                i.inventory_name as Description,
                i.item_class as ItemClass,
                i.branch_id as Branch,
                i.site_id as SiteID,
                COALESCE(i.on_hand, 0) as OnHand,
                COALESCE(i.available, i.on_hand, 0) as Available,
                i.default_price as DefaultPrice,
                i.vendor_id as VendorID,
                i.lead_time_days as LeadTimeDays,
                i.safety_stock as SafetyStock,
                i.moq as MOQ,
                COALESCE(s.total_qty, 0) as QtySold
             FROM \`${INVENTORY_VIEW_TABLE}\` i
             LEFT JOIN ${netSalesQtySubquery(db, salesEx)} s ON i.inventory_id = s.inventory_id
             ${wherePart}
             ORDER BY i.inventory_id ASC
             LIMIT ${limitInt} OFFSET ${offsetInt}`;

        const [rows] = await pool.query(query, [...salesParams, ...params]);
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM \`${INVENTORY_VIEW_TABLE}\` i ${wherePart}`,
            params
        );

        const transformed = rows.map((item) => {
            const onHand = Number(item.OnHand);
            const onHandVal = Number.isFinite(onHand) ? onHand : 0;
            let available = item.Available == null || item.Available === ""
                ? NaN
                : Number(item.Available);
            if (!Number.isFinite(available)) available = onHandVal;
            return {
                InventoryID: { value: item.InventoryID },
                Description: { value: item.Description || "—" },
                SiteID: { value: item.SiteID },
                Branch: { value: item.Branch },
                OnHand: { value: onHandVal },
                Available: { value: available },
                DefaultPrice: { value: item.DefaultPrice || 0 },
                ItemClass: { value: item.ItemClass || "" },
                VendorID: { value: item.VendorID || "" },
                LeadTimeDays: { value: item.LeadTimeDays },
                SafetyStock: { value: item.SafetyStock },
                MOQ: { value: item.MOQ },
                QtySold: { value: item.QtySold },
            };
        });

        return {
            data: transformed,
            totalCount: total,
            hasMore: total > offsetInt + pageSize,
            dataMode: "catalog",
        };
    },

    /**
     * Calculate global stats (Total Value, Low Stock, Dead Stock, Overstock, etc.)
     */
    async getGlobalStats(branch = "", search = "", companyId = "main") {
        const cacheKey = `global-stats-v8:${companyId}:${branch}:${search}`;
        return getCached(cacheKey, 120_000, () => this._computeGlobalStats(branch, search, companyId));
    },

    async _computeGlobalStats(branch = "", search = "", companyId = "main") {
        try {
            const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
            const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);

            if (branch && isExcludedBranchAlias(branch)) {
                return { ...EMPTY_GLOBAL_STATS };
            }

            await this.ensureForecastItemStockTable();
            await this.ensureCatalogRowsFromWarehouse(effectiveCompanyId);

            const catalogCount = await countCatalogRows(effectiveCompanyId);
            const warehouseRows = await countWarehouseRows(effectiveCompanyId);

            // Catalog-only import (or no warehouse stock yet): product count = full catalog
            if (warehouseRows === 0) {
                return {
                    ...EMPTY_GLOBAL_STATS,
                    count: catalogCount,
                    lastSync: await this.getLastInventorySyncTime(),
                    dataMode: catalogCount > 0 ? "warehouse-missing" : "catalog-empty",
                };
            }

            await this.ensureForecastItemStockTable();
            const [[fisWh]] = await purchasePool.query(
                `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ? AND warehouse_id != '__catalog__'`,
                [effectiveCompanyId]
            );
            const useForecast = Number(fisWh?.c) > 0;
            const whCol = useForecast ? "warehouse_id" : "default_warehouse";
            const nameCol = useForecast ? "item_name" : "inventory_name";
            const queryPool = useForecast ? purchasePool : pool;

            let whereClauses = [
                "i.company_id = ?",
                `i.${whCol} IS NOT NULL`,
                `i.${whCol} != '__catalog__'`,
            ];
            let params = [effectiveCompanyId];

            if (useForecast) {
                const damageEx = sqlExcludeForecastDamage("i", whCol);
                whereClauses.push(damageEx.clause);
                params.push(...damageEx.params);
            } else {
                const branchEx = sqlExcludeBranches("i");
                whereClauses.push(branchEx.clause);
                params.push(...branchEx.params);
            }

            if (branch) {
                const destinations = getStockWarehouseIdsForBranch(branch);
                const match = useForecast
                    ? sqlMatchForecastWarehouses("i", destinations, whCol)
                    : sqlMatchBranchWarehouses("i", destinations);
                whereClauses.push(match.clause);
                params.push(...match.params);
            }

            if (!useForecast) {
                if (effectiveCompanyId === "main") {
                    const ecomEx = sqlExcludeEcomBranches("i");
                    whereClauses.push(ecomEx.clause);
                    params.push(...ecomEx.params);
                } else if (effectiveCompanyId === "ecommerce") {
                    const ecomOnly = sqlOnlyEcomBranches("i");
                    whereClauses.push(ecomOnly.clause);
                    params.push(...ecomOnly.params);
                }
            }

            if (search) {
                const searchTerm = normalizeInventorySearch(search);
                whereClauses.push(
                    `(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(c.${nameCol}, i.${nameCol}, '')) LIKE UPPER(?))`
                );
                params.push(`%${searchTerm}%`, `%${searchTerm}%`);
            }

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;

            const salesEx = sqlExcludeSalesBranches("branch_name");
            const salesParams = branch
                ? [...salesEx.params, branch]
                : [...salesEx.params];

            const fromClause = inventoryFromClause("warehouse", { useForecast, purchaseDb });
            const priceExpr = `COALESCE(c.default_price, i.default_price, 0)`;

            const query = `
                SELECT
                    COUNT(DISTINCT i.inventory_id) as totalProducts,
                    SUM(COALESCE(i.on_hand, 0)) as totalStock,
                    SUM(COALESCE(i.on_hand, 0) * ${priceExpr}) as totalValue,
                    SUM(CASE WHEN i.on_hand > 0 AND i.on_hand < 10 THEN 1 ELSE 0 END) as lowStockCount,
                    SUM(CASE WHEN i.on_hand > 0 AND i.on_hand < 10 THEN i.on_hand ELSE 0 END) as totalLowStock,
                    SUM(CASE WHEN i.on_hand <= 0 THEN 1 ELSE 0 END) as outOfStockCount,
                    SUM(CASE WHEN i.on_hand > 0 AND COALESCE(s.total_qty, 0) <= 0 THEN 1 ELSE 0 END) as deadStockCount,
                    SUM(CASE WHEN i.on_hand > (COALESCE(s.total_qty, 0) * 2) AND COALESCE(s.total_qty, 0) > 0 THEN 1 ELSE 0 END) as overstockCount,
                    MAX(i.last_sync) as lastSync
                 ${fromClause}
                 LEFT JOIN ${netSalesQtySubquery(purchaseDb, salesEx, branch)} s ON i.inventory_id = s.inventory_id
                 ${wherePart}`;

            const [[stats]] = await queryPool.query(query, [...salesParams, ...params]);

            // Damage warehouse rows
            const damageParams = [effectiveCompanyId];
            let damageWhere;
            if (useForecast) {
                damageWhere = `WHERE i.company_id = ? AND i.warehouse_id != '__catalog__'
                  AND (
                    UPPER(TRIM(COALESCE(i.warehouse_id,''))) LIKE '%DAMAGE%'
                    OR UPPER(TRIM(COALESCE(i.warehouse_id,''))) LIKE '%DISCOUNTED%'
                    OR UPPER(TRIM(COALESCE(i.branch_id,''))) LIKE '%DAMAGE%'
                    OR UPPER(TRIM(COALESCE(i.branch_id,''))) LIKE '%DISCOUNTED%'
                  )`;
            } else {
                const damageEx = sqlOnlyDamageBranches("i");
                damageWhere = `WHERE i.company_id = ? AND i.default_warehouse != '__catalog__' AND ${damageEx.clause}`;
                damageParams.push(...damageEx.params);
            }
            if (search) {
                const searchTerm = normalizeInventorySearch(search);
                damageWhere +=
                    ` AND (UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.${nameCol},'')) LIKE UPPER(?))`;
                damageParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
            }
            const damageFrom = useForecast
                ? `\`${purchaseDb}\`.\`${FORECAST_STOCK_TABLE}\``
                : `\`${INVENTORY_VIEW_TABLE}\``;
            const [[damageStats]] = await queryPool.query(
                `SELECT
                    COALESCE(SUM(COALESCE(i.on_hand, 0)), 0) AS damageStock,
                    COUNT(DISTINCT CASE WHEN COALESCE(i.on_hand, 0) > 0 THEN i.inventory_id END) AS damageCount
                 FROM ${damageFrom} i
                 ${damageWhere}`,
                damageParams
            );

            // Prefer catalog count for all-branches; when a branch is selected use that site's SKU count
            // so "products in MAIN" matches Total Stocks scope (not network-wide catalog).
            const warehouseProducts = Number(stats.totalProducts) || 0;
            let productCount = branch
                ? warehouseProducts || catalogCount
                : Math.max(catalogCount, warehouseProducts);
            if (search) {
                const searchTerm = normalizeInventorySearch(search);
                if (useForecast) {
                    const [[catSearch]] = await purchasePool.query(
                        `SELECT COUNT(*) AS c FROM \`${FORECAST_STOCK_TABLE}\`
                         WHERE company_id = ? AND warehouse_id = '__catalog__'
                           AND (UPPER(inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(item_name,'')) LIKE UPPER(?))`,
                        [effectiveCompanyId, `%${searchTerm}%`, `%${searchTerm}%`]
                    );
                    const catHits = Number(catSearch?.c) || 0;
                    productCount = branch ? warehouseProducts || catHits : Math.max(catHits, warehouseProducts);
                } else {
                    const [[catSearch]] = await pool.query(
                        `SELECT COUNT(*) AS c FROM \`${INVENTORY_VIEW_TABLE}\`
                         WHERE company_id = ? AND default_warehouse = '__catalog__'
                           AND (UPPER(inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(inventory_name,'')) LIKE UPPER(?))`,
                        [effectiveCompanyId, `%${searchTerm}%`, `%${searchTerm}%`]
                    );
                    const catHits = Number(catSearch?.c) || 0;
                    productCount = branch ? warehouseProducts || catHits : Math.max(catHits, warehouseProducts);
                }
            }

            return {
                totalStock: Number(stats.totalStock) || 0,
                totalValue: Number(stats.totalValue) || 0,
                lowStock: Number(stats.lowStockCount) || 0,
                totalLowStock: Number(stats.totalLowStock) || 0,
                outOfStock: Number(stats.outOfStockCount) || 0,
                deadStock: Number(stats.deadStockCount) || 0,
                overstock: Number(stats.overstockCount) || 0,
                damageStock: Number(damageStats?.damageStock) || 0,
                damageCount: Number(damageStats?.damageCount) || 0,
                count: productCount,
                lastSync: stats.lastSync || await this.getLastInventorySyncTime(),
                dataMode: "warehouse",
            };
        } catch (err) {
            console.error("[MySQL getGlobalStats Error]", err);
            throw err;
        }
    },

    /**
     * Planning KPIs for the inventory dashboard (supplier, lead time, MOQ gaps).
     * Branch filter applies only when warehouse rows exist; catalog mode is company-wide.
     */
    async getPlanningStats(branch = "", search = "", companyId = "main") {
        try {
            const layout = await resolveInventoryLayout(companyId);
            let whereClauses = ["i.company_id = ?", "i.default_warehouse = '__catalog__'"];
            const params = [companyId];

            if (search) {
                whereClauses.push("(i.inventory_id LIKE ? OR i.inventory_name LIKE ?)");
                params.push(`%${search}%`, `%${search}%`);
            }

            if (layout === "warehouse" && branch) {
                whereClauses.push(
                    `EXISTS (
                        SELECT 1 FROM \`${INVENTORY_VIEW_TABLE}\` w
                        WHERE w.company_id = i.company_id
                          AND w.inventory_id = i.inventory_id
                          AND w.default_warehouse != '__catalog__'
                          AND w.branch_id = ?
                    )`
                );
                params.push(branch);
            }

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;
            const [rows] = await pool.query(
                `SELECT TRIM(i.inventory_id) AS inventory_id
                 FROM \`${INVENTORY_VIEW_TABLE}\` i
                 ${wherePart}`,
                params
            );

            const vendorMap = await this.getItemVendorMap();
            const leadTimeMap = await this.getVendorLeadTimes();
            const ids = rows.map((r) => String(r.inventory_id || "").toUpperCase().trim()).filter(Boolean);

            let withSupplier = 0;
            let withLeadTime = 0;
            for (const id of ids) {
                const supplierId = vendorMap.get(id);
                if (!supplierId) continue;
                withSupplier += 1;
                if ((leadTimeMap[supplierId]?.days || 0) > 0) withLeadTime += 1;
            }

            const totalProducts = ids.length;
            const lastSync = await this.getLastInventorySyncTime();

            return {
                totalProducts,
                withSupplier,
                withLeadTime,
                missingSafetyStock: totalProducts,
                missingMoq: totalProducts,
                lastSync,
                dataMode: layout,
                branchScoped: layout === "warehouse" && !!branch,
            };
        } catch (err) {
            console.error("[MySQL getPlanningStats Error]", err);
            throw err;
        }
    },

    /**
     * Stock Items masterlist — product types from catalog (__catalog__),
     * with optional warehouse on-hand rollup. Not limited to sites that have stock.
     */
    async getStockItems({ page = 1, pageSize = 50, search = "", branch = "", itemClass = "", dimsStatus = "", companyId = "main", cursor = "" } = {}) {
        const offset = (page - 1) * pageSize;
        const limitInt = parseInt(pageSize, 10);
        const offsetInt = parseInt(offset, 10);
        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
        const cursorId = String(cursor || "").trim();
        const classFilter = String(itemClass || "").trim();
        const dimsFilter = String(dimsStatus || "").trim().toLowerCase(); // '', 'set', 'unset'

        if (branch && branch !== "All Branches" && isExcludedBranchAlias(branch)) {
            return { items: [], totalCount: 0, totalStock: 0, nextCursor: null, itemClasses: [], dimsSetCount: 0, dimsUnsetCount: 0 };
        }

        try {
            const itemClasses = await this.getStockItemClasses(effectiveCompanyId);
            const catalogRows = await countCatalogRows(effectiveCompanyId);
            if (catalogRows > 0) {
                const result = await this._getStockItemsFromCatalogWithStock({
                    page,
                    pageSize,
                    offset: offsetInt,
                    limitInt,
                    search,
                    branch,
                    itemClass: classFilter,
                    dimsStatus: dimsFilter,
                    companyId: effectiveCompanyId,
                    cursorId,
                });
                return { ...result, itemClasses };
            }

            // Legacy fallback: no catalog yet — list distinct IDs from warehouse rows
            const whereParts = ["i.company_id = ?", "i.default_warehouse != '__catalog__'"];
            const params = [effectiveCompanyId];

            const branchEx = sqlExcludeBranches("i");
            whereParts.push(branchEx.clause);
            params.push(...branchEx.params);

            if (search) {
                whereParts.push("(i.inventory_id LIKE ? OR i.inventory_name LIKE ?)");
                params.push(`%${search}%`, `%${search}%`);
            }
            if (cursorId) {
                whereParts.push("TRIM(i.inventory_id) > ?");
                params.push(cursorId);
            }
            if (classFilter) {
                whereParts.push("UPPER(TRIM(COALESCE(i.item_class,''))) = UPPER(TRIM(?))");
                params.push(classFilter);
            }
            if (branch && branch !== "All Branches") {
                whereParts.push("i.branch_id IS NOT NULL AND TRIM(i.branch_id) != ''");
                whereParts.push("UPPER(TRIM(i.branch_id)) = UPPER(TRIM(?))");
                params.push(branch);
            }

            if (effectiveCompanyId === "main") {
                const ecomEx = sqlExcludeEcomBranches("i");
                whereParts.push(ecomEx.clause);
                params.push(...ecomEx.params);
            } else if (effectiveCompanyId === "ecommerce") {
                const ecomOnly = sqlOnlyEcomBranches("i");
                whereParts.push(ecomOnly.clause);
                params.push(...ecomOnly.params);
            }

            const whereClause = `WHERE ${whereParts.join(" AND ")}`;
            const query = `
                SELECT 
                    TRIM(i.inventory_id) as inventoryId, 
                    MAX(i.inventory_name) as description, 
                    MAX(i.item_class) as itemClass, 
                    MAX(i.item_status) as itemStatus,
                    MAX(i.base_unit) as baseUnit,
                    MAX(i.default_price) as price,
                    MAX(i.moq) as moq,
                    SUM(COALESCE(i.on_hand, 0)) as totalOnHand,
                    GROUP_CONCAT(DISTINCT CASE WHEN i.on_hand > 0 THEN i.branch_id END SEPARATOR ', ') as branches
                 FROM \`${INVENTORY_VIEW_TABLE}\` i
                 ${whereClause} 
                 GROUP BY TRIM(i.inventory_id)
                 ORDER BY TRIM(i.inventory_id) ASC 
                 LIMIT ${limitInt} OFFSET ${offsetInt}`;

            const [[rows], [[{ total, overallStock }]]] = await Promise.all([
                pool.query(query, params),
                pool.query(
                    `SELECT 
                        COUNT(DISTINCT TRIM(i.inventory_id)) as total,
                        SUM(COALESCE(i.on_hand, 0)) as overallStock
                     FROM \`${INVENTORY_VIEW_TABLE}\` i ${whereClause}`,
                    params
                ),
            ]);

            const pageIds = rows.map((r) => r.inventoryId);
            const [salesMap, dimSet] = await Promise.all([
                this.getPeriodicSalesSummaryForIds({ ids: pageIds, branch }),
                this.getDimensionIdSet(pageIds),
            ]);

            const withDims = rows.map((r) => {
                const key = (r.inventoryId || "").toUpperCase().trim();
                const sales = salesMap.get(key) || { qty_sold: 0, total_sales: 0 };
                return {
                    ...r,
                    totalOnHand: Number(r.totalOnHand) || 0,
                    totalQtySold: sales.qty_sold,
                    totalSales: sales.total_sales,
                    hasDimensions: dimSet.has(key),
                };
            });

            return {
                items: withDims,
                totalCount: total,
                totalStock: Number(overallStock) || 0,
                dimsSetCount: 0,
                dimsUnsetCount: 0,
                nextCursor: withDims.length ? withDims[withDims.length - 1].inventoryId : null,
                dataMode: "warehouse",
                itemClasses,
            };
        } catch (err) {
            console.error("[MySQL getStockItems Error]", err);
            throw err;
        }
    },

    /** Distinct item classes for the Stock Items filter dropdown. */
    async getStockItemClasses(companyId = "main") {
        try {
            const [catalog] = await pool.query(
                `SELECT DISTINCT TRIM(item_class) AS itemClass
                 FROM \`${INVENTORY_VIEW_TABLE}\`
                 WHERE company_id = ?
                   AND default_warehouse = '__catalog__'
                   AND item_class IS NOT NULL AND TRIM(item_class) != ''
                 ORDER BY TRIM(item_class) ASC`,
                [companyId]
            );
            if (catalog.length > 0) {
                return catalog.map((r) => r.itemClass).filter(Boolean);
            }
            const [rows] = await pool.query(
                `SELECT DISTINCT TRIM(item_class) AS itemClass
                 FROM \`${INVENTORY_VIEW_TABLE}\`
                 WHERE company_id = ?
                   AND default_warehouse != '__catalog__'
                   AND item_class IS NOT NULL AND TRIM(item_class) != ''
                 ORDER BY TRIM(item_class) ASC`,
                [companyId]
            );
            return rows.map((r) => r.itemClass).filter(Boolean);
        } catch (err) {
            console.error("[MySQL getStockItemClasses Error]", err);
            return [];
        }
    },

    /**
     * Catalog-first Stock Items list (product types) with warehouse on-hand rollup.
     */
    async _getStockItemsFromCatalogWithStock({
        page,
        pageSize,
        offset,
        limitInt,
        search,
        branch,
        itemClass = "",
        dimsStatus = "",
        companyId,
        cursorId,
    }) {
        await this.ensureItemDimensionsTable();
        const dimsExistsSql = `EXISTS (
            SELECT 1 FROM item_dimensions d
            WHERE TRIM(UPPER(d.inventory_id)) = TRIM(UPPER(i.inventory_id))
              AND (
                d.pcs_per_box IS NOT NULL OR d.length_m IS NOT NULL OR d.height_m IS NOT NULL
                OR d.width_m IS NOT NULL OR d.weight_kg IS NOT NULL OR d.cbm IS NOT NULL
              )
        )`;
        const whereParts = ["i.company_id = ?", "i.default_warehouse = '__catalog__'"];
        const params = [companyId];
        const classFilter = String(itemClass || "").trim();
        const dimsFilter = String(dimsStatus || "").trim().toLowerCase();

        if (search) {
            whereParts.push(
                "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.inventory_name,'')) LIKE UPPER(?))"
            );
            params.push(`%${search}%`, `%${search}%`);
        }
        if (cursorId) {
            whereParts.push("TRIM(i.inventory_id) > ?");
            params.push(cursorId);
        }
        if (classFilter) {
            whereParts.push("UPPER(TRIM(COALESCE(i.item_class,''))) = UPPER(TRIM(?))");
            params.push(classFilter);
        }
        if (dimsFilter === "set") {
            whereParts.push(dimsExistsSql);
        } else if (dimsFilter === "unset") {
            whereParts.push(`NOT ${dimsExistsSql}`);
        }

        // Summary counts ignore dims filter so both Set / Not set KPIs stay visible
        const summaryWhereParts = ["i.company_id = ?", "i.default_warehouse = '__catalog__'"];
        const summaryParams = [companyId];
        if (search) {
            summaryWhereParts.push(
                "(UPPER(i.inventory_id) LIKE UPPER(?) OR UPPER(COALESCE(i.inventory_name,'')) LIKE UPPER(?))"
            );
            summaryParams.push(`%${search}%`, `%${search}%`);
        }
        if (classFilter) {
            summaryWhereParts.push("UPPER(TRIM(COALESCE(i.item_class,''))) = UPPER(TRIM(?))");
            summaryParams.push(classFilter);
        }
        const summaryWhere = `WHERE ${summaryWhereParts.join(" AND ")}`;

        const whereClause = `WHERE ${whereParts.join(" AND ")}`;

        // Optional stock rollup (all warehouses, or one branch)
        let stockJoin = `
            LEFT JOIN (
                SELECT
                    TRIM(w.inventory_id) AS inventory_id,
                    w.company_id,
                    SUM(COALESCE(w.on_hand, 0)) AS on_hand,
                    GROUP_CONCAT(DISTINCT CASE WHEN w.on_hand > 0 THEN w.branch_id END SEPARATOR ', ') AS branches
                FROM \`${INVENTORY_VIEW_TABLE}\` w
                WHERE w.company_id = ?
                  AND w.default_warehouse != '__catalog__'
                GROUP BY TRIM(w.inventory_id), w.company_id
            ) w ON w.inventory_id = TRIM(i.inventory_id) AND w.company_id = i.company_id`;
        const stockParams = [companyId];

        if (branch && branch !== "All Branches") {
            stockJoin = `
            LEFT JOIN (
                SELECT
                    TRIM(w.inventory_id) AS inventory_id,
                    w.company_id,
                    SUM(COALESCE(w.on_hand, 0)) AS on_hand,
                    GROUP_CONCAT(DISTINCT CASE WHEN w.on_hand > 0 THEN w.branch_id END SEPARATOR ', ') AS branches
                FROM \`${INVENTORY_VIEW_TABLE}\` w
                WHERE w.company_id = ?
                  AND w.default_warehouse != '__catalog__'
                  AND UPPER(TRIM(w.branch_id)) = UPPER(TRIM(?))
                GROUP BY TRIM(w.inventory_id), w.company_id
            ) w ON w.inventory_id = TRIM(i.inventory_id) AND w.company_id = i.company_id`;
            stockParams.push(branch);
        }

        const offsetInt = parseInt(offset, 10) || 0;
        const lim = parseInt(limitInt || pageSize, 10) || 50;

        const query = `
            SELECT
                TRIM(i.inventory_id) as inventoryId,
                i.inventory_name as description,
                i.item_class as itemClass,
                i.item_status as itemStatus,
                i.base_unit as baseUnit,
                i.default_price as price,
                i.moq as moq,
                COALESCE(w.on_hand, 0) as totalOnHand,
                COALESCE(w.branches, '') as branches
             FROM \`${INVENTORY_VIEW_TABLE}\` i
             ${stockJoin}
             ${whereClause}
             ORDER BY TRIM(i.inventory_id) ASC
             LIMIT ${lim} ${cursorId ? "" : `OFFSET ${offsetInt}`}`;

        const stockWhere = `
            FROM \`${INVENTORY_VIEW_TABLE}\` w
            ${classFilter
                ? `INNER JOIN \`${INVENTORY_VIEW_TABLE}\` c
                     ON TRIM(c.inventory_id) = TRIM(w.inventory_id)
                    AND c.company_id = w.company_id
                    AND c.default_warehouse = '__catalog__'
                    AND UPPER(TRIM(COALESCE(c.item_class,''))) = UPPER(TRIM(?))`
                : ""}
            WHERE w.company_id = ?
              AND w.default_warehouse != '__catalog__'
              ${branch && branch !== "All Branches" ? "AND UPPER(TRIM(w.branch_id)) = UPPER(TRIM(?))" : ""}
        `;
        const stockSumParams = [];
        if (classFilter) stockSumParams.push(classFilter);
        stockSumParams.push(companyId);
        if (branch && branch !== "All Branches") stockSumParams.push(branch);

        const [[rows], [[{ total }]], [[{ overallStock }]], [[{ dimsSetCount, dimsUnsetCount }]]] = await Promise.all([
            pool.query(query, [...stockParams, ...params]),
            pool.query(
                `SELECT COUNT(*) AS total FROM \`${INVENTORY_VIEW_TABLE}\` i ${whereClause}`,
                params
            ),
            pool.query(
                `SELECT COALESCE(SUM(COALESCE(w.on_hand, 0)), 0) AS overallStock ${stockWhere}`,
                stockSumParams
            ),
            pool.query(
                `SELECT
                    COALESCE(SUM(CASE WHEN ${dimsExistsSql} THEN 1 ELSE 0 END), 0) AS dimsSetCount,
                    COALESCE(SUM(CASE WHEN NOT ${dimsExistsSql} THEN 1 ELSE 0 END), 0) AS dimsUnsetCount
                 FROM \`${INVENTORY_VIEW_TABLE}\` i ${summaryWhere}`,
                summaryParams
            ),
        ]);

        const pageIds = rows.map((r) => r.inventoryId);
        const [salesMap, dimSet] = await Promise.all([
            this.getPeriodicSalesSummaryForIds({ ids: pageIds, branch }),
            this.getDimensionIdSet(pageIds),
        ]);

        const withDims = rows.map((r) => {
            const key = (r.inventoryId || "").toUpperCase().trim();
            const sales = salesMap.get(key) || { qty_sold: 0, total_sales: 0 };
            return {
                ...r,
                totalOnHand: Number(r.totalOnHand) || 0,
                totalQtySold: sales.qty_sold,
                totalSales: sales.total_sales,
                hasDimensions: dimSet.has(key),
            };
        });

        return {
            items: withDims,
            totalCount: Number(total) || 0,
            totalStock: Number(overallStock) || 0,
            dimsSetCount: Number(dimsSetCount) || 0,
            dimsUnsetCount: Number(dimsUnsetCount) || 0,
            nextCursor: withDims.length ? withDims[withDims.length - 1].inventoryId : null,
            dataMode: "catalog",
        };
    },

    /**
     * Stock items masterlist from catalog when warehouse levels are not synced yet.
     */
    async getStockItemsFromCatalog({ page, pageSize, search, companyId, offset }) {
        return this._getStockItemsFromCatalogWithStock({
            page,
            pageSize,
            offset,
            limitInt: pageSize,
            search,
            branch: "",
            itemClass: "",
            companyId,
            cursorId: "",
        });
    },

    /**
     * Retail replenishment branch picker — merge Acumatica master branches,
     * inventory sites, and sales branch names so warehouses with little/no
     * synced stock rows still appear when they exist in Acumatica.
     */
    async getReplenishmentBranches(companyId = "main") {
        return getCached(`branches:repl:${companyId}`, 600_000, () =>
            this._getReplenishmentBranchesUncached(companyId)
        );
    },

    async _getReplenishmentBranchesUncached(companyId = "main") {
        try {
            // Branch entity master only — do not merge Warehouse / inventory site IDs
            const masterBranches = await this.getMasterBranches();

            const byId = new Map();
            const add = (id, name = "") => {
                const key = String(id || "").trim();
                if (!key || key === "__catalog__") return;
                const upper = key.toUpperCase();
                if (isExcludedBranchAlias(upper)) return;
                if (isWarehouseLikeAlias(upper) || isWarehouseLikeAlias(name)) return;
                const existing = byId.get(upper);
                const label = String(name || "").trim();
                if (!existing) {
                    byId.set(upper, { SiteID: key, Description: { value: label || key } });
                    return;
                }
                if (label && label.toUpperCase() !== upper && (!existing.Description?.value || existing.Description.value === existing.SiteID)) {
                    existing.Description = { value: label };
                }
            };

            add("MAIN", "MAIN");
            for (const b of masterBranches) add(b.branch_id || b.SiteID, b.branch_name || b.Description);

            return [...byId.values()].sort((a, b) => {
                if (a.SiteID === "MAIN") return -1;
                if (b.SiteID === "MAIN") return 1;
                return String(a.SiteID).localeCompare(String(b.SiteID));
            });
        } catch (err) {
            console.error("[MySQL getReplenishmentBranches Error]", err);
            const fallback = await this.getBranches(companyId);
            return fallback.length ? fallback : [{ SiteID: "MAIN", Description: { value: "MAIN" } }];
        }
    },

    /** Active Acumatica Branch master list (organizational units — not warehouses). */
    async getMasterBranches() {
        try {
            const [rows] = await pool.query(
                `SELECT branch_id, branch_name, active
                 FROM branches
                 WHERE COALESCE(active, 1) = 1
                   AND branch_id IS NOT NULL
                   AND TRIM(branch_id) != ''
                 ORDER BY branch_id ASC`
            );
            return rows.map((r) => ({
                branch_id: String(r.branch_id || "").trim(),
                branch_name: String(r.branch_name || r.branch_id || "").trim(),
                SiteID: String(r.branch_id || "").trim(),
                Description: String(r.branch_name || r.branch_id || "").trim(),
            }));
        } catch (err) {
            console.error("[MySQL getMasterBranches Error]", err);
            return [];
        }
    },

    /** Distinct sales branch names used for replenishment picker completeness. */
    async getSalesBranchNames() {
        return getCached("salesBranchNames", 600_000, () => this._getSalesBranchNamesUncached());
    },

    async _getSalesBranchNamesUncached() {
        try {
            const salesEx = sqlExcludeSalesBranches("branch_name");
            const [rows] = await purchasePool.query(
                `SELECT DISTINCT branch_name AS branchId
                 FROM product_periodic_sales
                 WHERE branch_name IS NOT NULL
                   AND TRIM(branch_name) != ''
                   AND ${salesEx.clause}
                 ORDER BY branch_name ASC`
            , salesEx.params);
            return rows
                .map((r) => String(r.branchId || "").trim())
                .filter(Boolean);
        } catch (err) {
            console.error("[MySQL getSalesBranchNames Error]", err);
            return [];
        }
    },

    /**
     * Qty Available (sellable) by inventory ID for a branch/warehouse group.
     * Reads Acumatica-synced forecast_item_stock — Available floored, DAMAGE excluded at sync.
     * Falls back to on_hand when Available is null.
     */
    async getBranchOnHandMap({ branch = "MAIN", companyId = "main" } = {}) {
        const map = new Map();
        if (isExcludedBranchAlias(branch)) return map;

        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
        const destinations = getStockWarehouseIdsForBranch(branch);
        if (!destinations.length) return map;

        try {
            const src = await this._forecastStockSource();
            const whCol = src.warehouseCol;
            const ph = destinations.map(() => "?").join(", ");
            const damageEx = sqlExcludeForecastDamage("f", whCol);
            const where = [
                `f.${whCol} != '__catalog__'`,
                `UPPER(TRIM(COALESCE(f.${whCol},''))) IN (${ph})`,
                damageEx.clause,
            ];
            const params = [...destinations, ...damageEx.params];

            if (isEcomBranchAlias(branch) || effectiveCompanyId === "ecommerce") {
                // Ecommerce stock may live under company ecommerce or main with ECOM warehouse IDs.
                where.unshift(`(f.company_id = 'ecommerce' OR f.company_id = 'main')`);
            } else {
                where.unshift(`f.company_id = ?`);
                params.unshift(effectiveCompanyId);
                const ecomEx = sqlExcludeEcomBranches("f");
                where.push(ecomEx.clause);
                params.push(...ecomEx.params);
            }

            const [rows] = await purchasePool.query(
                `SELECT UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) AS invKey,
                        COALESCE(SUM(GREATEST(0, COALESCE(f.available, f.on_hand, 0))), 0) AS onHand
                 FROM ${src.qualified} f
                 WHERE ${where.join(" AND ")}
                 GROUP BY UPPER(REPLACE(TRIM(f.inventory_id), ' ', ''))`,
                params
            );
            for (const r of rows) {
                const key = String(r.invKey || "").trim();
                if (!key) continue;
                map.set(key, Number(r.onHand) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL getBranchOnHandMap Error]", err);
            return map;
        }
    },

    /** On-hand for a small set of SKUs — used for fast paginated replenishment overlay. */
    async getBranchOnHandForItems(inventoryIds, { branch = "MAIN", companyId = "main" } = {}) {
        const keys = [...new Set((inventoryIds || []).map((id) => normalizeInvKey(id)).filter(Boolean))];
        const map = new Map();
        if (!keys.length || isExcludedBranchAlias(branch)) return map;

        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
        const destinations = getStockWarehouseIdsForBranch(branch);
        if (!destinations.length) return map;

        try {
            const src = await this._forecastStockSource();
            const whCol = src.warehouseCol;
            const whPh = destinations.map(() => "?").join(", ");
            const idPh = keys.map(() => "?").join(", ");
            const damageEx = sqlExcludeForecastDamage("f", whCol);
            const where = [
                `f.${whCol} != '__catalog__'`,
                `UPPER(TRIM(COALESCE(f.${whCol},''))) IN (${whPh})`,
                `UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) IN (${idPh})`,
                damageEx.clause,
            ];
            const params = [...destinations, ...keys, ...damageEx.params];

            if (isEcomBranchAlias(branch) || effectiveCompanyId === "ecommerce") {
                where.unshift(`(f.company_id = 'ecommerce' OR f.company_id = 'main')`);
            } else {
                where.unshift(`f.company_id = ?`);
                params.unshift(effectiveCompanyId);
                const ecomEx = sqlExcludeEcomBranches("f");
                where.push(ecomEx.clause);
                params.push(...ecomEx.params);
            }

            const [rows] = await purchasePool.query(
                `SELECT UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) AS invKey,
                        COALESCE(SUM(GREATEST(0, COALESCE(f.available, f.on_hand, 0))), 0) AS onHand
                 FROM ${src.qualified} f
                 WHERE ${where.join(" AND ")}
                 GROUP BY UPPER(REPLACE(TRIM(f.inventory_id), ' ', ''))`,
                params
            );
            for (const r of rows) {
                const key = String(r.invKey || "").trim();
                if (!key) continue;
                map.set(key, Number(r.onHand) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL getBranchOnHandForItems Error]", err);
            return map;
        }
    },

    /**
     * Branch-accurate stock + sales for replenishment analysis.
     * Stock qty = Acumatica Qty Available (sellable) from forecast_item_stock, excl. DAMAGE.
     */
    async getReplenishmentItems({ branch = "MAIN", companyId = "main", salesMap = null } = {}) {
        if (isExcludedBranchAlias(branch)) {
            return [];
        }

        try {
            const isMainWarehouse = String(branch).trim().toUpperCase() === "MAIN";
            const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
            const isEcomBranch = isEcomBranchAlias(branch);

            const resolvedSales =
                salesMap ??
                (await this.getPeriodicSalesSummary({
                    branch: isMainWarehouse ? "" : branch,
                }));

            const onHandMap = await this.getBranchOnHandMap({ branch, companyId: effectiveCompanyId });

            // Seed items from stock rows + catalog metadata where needed.
            const whereClauses = [
                "i.default_warehouse != '__catalog__'",
                "(i.item_status IS NULL OR UPPER(TRIM(i.item_status)) = 'ACTIVE')",
            ];
            const params = [];
            const stockWarehouses = getStockWarehouseIdsForBranch(branch);
            const ph = stockWarehouses.map(() => "?").join(", ");
            // Match Acumatica Inventory Summary warehouse IDs (default_warehouse), not only branch_id.
            whereClauses.push(
                `(UPPER(TRIM(COALESCE(i.default_warehouse,''))) IN (${ph})
                  OR UPPER(TRIM(COALESCE(i.branch_id,''))) IN (${ph}))`
            );
            params.push(...stockWarehouses, ...stockWarehouses);

            if (isEcomBranch) {
                whereClauses.push(
                    `(i.company_id = 'ecommerce' OR i.company_id = 'main')`
                );
            } else {
                whereClauses.push("i.company_id = ?");
                params.push(effectiveCompanyId);
                const branchEx = sqlExcludeBranches("i");
                whereClauses.push(branchEx.clause);
                params.push(...branchEx.params);
                if (effectiveCompanyId === "main") {
                    const ecomEx = sqlExcludeEcomBranches("i");
                    whereClauses.push(ecomEx.clause);
                    params.push(...ecomEx.params);
                }
            }

            const [rows] = await pool.query(
                `SELECT
                    TRIM(i.inventory_id) as inventoryId,
                    MAX(i.inventory_name) as description,
                    MAX(i.item_status) as itemStatus,
                    MAX(i.item_class) as itemClass,
                    COALESCE(SUM(GREATEST(0, COALESCE(i.available, i.on_hand, 0))), 0) as totalOnHand
                 FROM \`${INVENTORY_VIEW_TABLE}\` i
                 WHERE ${whereClauses.join(" AND ")}
                 GROUP BY TRIM(i.inventory_id)
                 ORDER BY TRIM(i.inventory_id) ASC`,
                params
            );

            const itemMap = new Map();
            for (const r of rows) {
                const key = normalizeInvKey(r.inventoryId);
                if (!key) continue;
                const sales =
                    resolvedSales.get(key) ||
                    resolvedSales.get(String(r.inventoryId || "").toUpperCase().trim()) ||
                    { qty_sold: 0, total_sales: 0 };
                // Prefer live Acumatica-synced on-hand when present (space-normalized keys).
                const onHand = onHandMap.has(key)
                    ? Number(onHandMap.get(key)) || 0
                    : Number(r.totalOnHand) || 0;
                itemMap.set(key, {
                    inventoryId: r.inventoryId,
                    description: r.description,
                    itemStatus: r.itemStatus,
                    itemClass: r.itemClass,
                    totalOnHand: onHand,
                    totalAvailable: onHand,
                    totalQtySold: sales.qty_sold,
                    totalSales: sales.total_sales,
                    salesScope: sales.salesScope || (isMainWarehouse ? "network" : "branch"),
                    stockSource: onHandMap.has(key) ? "forecast_item_stock" : "inventory_items",
                });
            }

            // Items with synced on-hand but no inventory_items warehouse row (common after sync
            // writes only to product_inventory_items / forecast_item_stock).
            const missingStockKeys = [];
            for (const [key, qty] of onHandMap.entries()) {
                const norm = normalizeInvKey(key);
                if (!norm) continue;
                if (!itemMap.has(norm) && (Number(qty) || 0) > 0) missingStockKeys.push(norm);
            }
            // Include items with branch sales but no on-hand stock at this branch (stockout risk).
            const missingSalesKeys = [];
            for (const [rawKey, sales] of resolvedSales) {
                const key = normalizeInvKey(rawKey);
                if (!key) continue;
                if (!itemMap.has(key) && sales.qty_sold > 0) missingSalesKeys.push(key);
            }
            const missingKeys = [...new Set([...missingStockKeys, ...missingSalesKeys])];
            if (missingKeys.length > 0) {
                const placeholders = missingKeys.map(() => "?").join(", ");
                const catalogCompanyId = isEcomBranch ? "ecommerce" : effectiveCompanyId;
                const [catalogRows] = await pool.query(
                    `SELECT TRIM(inventory_id) AS inventoryId, inventory_name AS description, item_class AS itemClass
                     FROM \`${INVENTORY_VIEW_TABLE}\`
                     WHERE company_id = ? AND default_warehouse = '__catalog__'
                       AND UPPER(REPLACE(TRIM(inventory_id), ' ', '')) IN (${placeholders})`,
                    [catalogCompanyId, ...missingKeys]
                );
                const catalogByKey = new Map(
                    catalogRows.map((c) => [normalizeInvKey(c.inventoryId), c])
                );
                for (const key of missingKeys) {
                    if (itemMap.has(key)) continue;
                    let salesRow = resolvedSales.get(key) || { qty_sold: 0, total_sales: 0 };
                    if (!(Number(salesRow.qty_sold) > 0)) {
                        for (const [sk, sv] of resolvedSales) {
                            if (normalizeInvKey(sk) === key && (Number(sv?.qty_sold) || 0) > 0) {
                                salesRow = sv;
                                break;
                            }
                        }
                    }
                    const cat = catalogByKey.get(key);
                    const onHand = Number(onHandMap.get(key)) || 0;
                    itemMap.set(key, {
                        inventoryId: cat?.inventoryId || key,
                        description: cat?.description || "",
                        itemStatus: "ACTIVE",
                        itemClass: cat?.itemClass || "",
                        totalOnHand: onHand,
                        totalAvailable: onHand,
                        totalQtySold: salesRow.qty_sold,
                        totalSales: salesRow.total_sales,
                        salesScope: salesRow.salesScope || (isMainWarehouse ? "network" : "branch"),
                        stockSource: onHandMap.has(key) ? "forecast_item_stock" : "catalog",
                    });
                }
            }

            const nameless = [...itemMap.entries()].filter(([, item]) =>
                this._blankProductName(item.description) || !String(item.itemClass || "").trim()
            );
            if (nameless.length > 0) {
                const names = await this.getProductNameMap(
                    nameless.map(([key]) => key),
                    isEcomBranch ? "ecommerce" : effectiveCompanyId
                );
                for (const [key, item] of nameless) {
                    const meta = names.get(key);
                    if (!meta) continue;
                    if (this._blankProductName(item.description) && !this._blankProductName(meta.description)) {
                        item.description = meta.description;
                    }
                    if (!String(item.itemClass || "").trim() && meta.itemClass) {
                        item.itemClass = meta.itemClass;
                    }
                }
            }

            return [...itemMap.values()];
        } catch (err) {
            console.error("[MySQL getReplenishmentItems Error]", err);
            throw err;
        }
    },

    _blankProductName(value) {
        const text = String(value ?? "").trim();
        return !text || text === "—" || text === "-";
    },

    /**
     * Product name + class for SKUs. Names live on forecast stock (any warehouse)
     * and on the CMS one-row product table — not only on __catalog__ warehouse rows.
     */
    async getProductNameMap(inventoryIds = [], companyId = "main") {
        const keys = [...new Set((inventoryIds || []).map((id) => normalizeInvKey(id)).filter(Boolean))];
        const map = new Map();
        if (!keys.length) return map;

        const apply = (rows) => {
            for (const row of rows || []) {
                const key = normalizeInvKey(row.inventoryId);
                if (!key) continue;
                const prev = map.get(key) || {
                    inventoryId: String(row.inventoryId || "").trim(),
                    description: "",
                    itemClass: "",
                };
                const description = String(row.description || "").trim();
                const itemClass = String(row.itemClass || "").trim();
                if (this._blankProductName(prev.description) && !this._blankProductName(description)) {
                    prev.description = description;
                    if (row.inventoryId) prev.inventoryId = String(row.inventoryId).trim();
                }
                if (!prev.itemClass && itemClass) prev.itemClass = itemClass;
                map.set(key, prev);
            }
        };

        const CHUNK = 400;
        for (let i = 0; i < keys.length; i += CHUNK) {
            const chunk = keys.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => "?").join(", ");
            try {
                const [cmsRows] = await pool.query(
                    `SELECT TRIM(inventory_id) AS inventoryId,
                            MAX(NULLIF(TRIM(inventory_name), '')) AS description,
                            MAX(NULLIF(TRIM(item_class), '')) AS itemClass
                     FROM \`${INVENTORY_VIEW_TABLE}\`
                     WHERE company_id = ?
                       AND UPPER(REPLACE(TRIM(inventory_id), ' ', '')) IN (${placeholders})
                     GROUP BY TRIM(inventory_id)`,
                    [companyId, ...chunk]
                );
                apply(cmsRows);
            } catch (err) {
                console.warn("[MySQL getProductNameMap CMS]", err.message);
            }
            try {
                await this.ensureForecastItemStockTable();
                const [stockRows] = await purchasePool.query(
                    `SELECT TRIM(inventory_id) AS inventoryId,
                            MAX(NULLIF(TRIM(item_name), '')) AS description,
                            MAX(NULLIF(TRIM(item_class), '')) AS itemClass
                     FROM \`${FORECAST_STOCK_TABLE}\`
                     WHERE company_id = ?
                       AND UPPER(REPLACE(TRIM(inventory_id), ' ', '')) IN (${placeholders})
                     GROUP BY TRIM(inventory_id)`,
                    [companyId, ...chunk]
                );
                apply(stockRows);
            } catch (err) {
                console.warn("[MySQL getProductNameMap forecast]", err.message);
            }
        }
        return map;
    },

    /**
     * Fill blank replenishment product names from forecast stock and the CMS catalog.
     * Branch rows were stored with an empty description after stock moved off the one-SKU table.
     */
    async backfillReplenishmentProductNames(companyId = "main", branchId = "") {
        const branch = String(branchId || "").trim();
        if (!branch) return 0;
        await this.ensureReplenishmentCacheTable();
        await this.ensureForecastItemStockTable();
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
        const blankSql = `(description IS NULL OR TRIM(description) = '' OR description IN ('—', '-'))`;
        try {
            const [[blank]] = await purchasePool.query(
                `SELECT COUNT(*) AS c FROM replenishment_cache
                 WHERE company_id = ? AND branch_id = ? AND ${blankSql}`,
                [companyId, branch]
            );
            if (!Number(blank?.c)) return 0;

            const setName = `
                SET c.description = n.item_name,
                    c.item_class = IF(
                        c.item_class IS NULL OR TRIM(c.item_class) = '',
                        COALESCE(n.item_class, c.item_class),
                        c.item_class
                    )`;
            const whereBlank = `
                WHERE c.company_id = ? AND c.branch_id = ?
                  AND ${blankSql}
                  AND n.item_name IS NOT NULL`;

            const [fromStock] = await purchasePool.query(
                `UPDATE replenishment_cache c
                 JOIN (
                    SELECT UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inv_key,
                           MAX(NULLIF(TRIM(item_name), '')) AS item_name,
                           MAX(NULLIF(TRIM(item_class), '')) AS item_class
                    FROM \`${FORECAST_STOCK_TABLE}\`
                    WHERE company_id = ?
                    GROUP BY UPPER(REPLACE(TRIM(inventory_id), ' ', ''))
                 ) n ON UPPER(REPLACE(TRIM(c.inventory_id), ' ', '')) = n.inv_key
                 ${setName}
                 ${whereBlank}`,
                [companyId, companyId, branch]
            );

            const [fromCms] = await purchasePool.query(
                `UPDATE replenishment_cache c
                 JOIN (
                    SELECT UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inv_key,
                           MAX(NULLIF(TRIM(inventory_name), '')) AS item_name,
                           MAX(NULLIF(TRIM(item_class), '')) AS item_class
                    FROM \`${inventoryDb}\`.\`${INVENTORY_SYNC_TABLE}\`
                    WHERE company_id = ?
                    GROUP BY UPPER(REPLACE(TRIM(inventory_id), ' ', ''))
                 ) n ON UPPER(REPLACE(TRIM(c.inventory_id), ' ', '')) = n.inv_key
                 ${setName}
                 ${whereBlank}`,
                [companyId, companyId, branch]
            );
            return (Number(fromStock?.affectedRows) || 0) + (Number(fromCms?.affectedRows) || 0);
        } catch (err) {
            console.warn("[MySQL backfillReplenishmentProductNames]", err.message);
            return 0;
        }
    },

    /**
     * Fetch catalog metadata for a list of inventory IDs (uppercase keys).
     */
    async getCatalogItemsByIds(itemIds = [], companyId = "main") {
        try {
            const map = await this.getProductNameMap(itemIds, companyId);
            return [...map.values()];
        } catch (err) {
            console.error("[MySQL getCatalogItemsByIds Error]", err);
            return [];
        }
    },

    /**
     * Fetch stock item detail from MySQL including all warehouse locations
     */
    async getStockItemDetail(inventoryId, companyId = "main") {
        try {
            const [rows] = await pool.execute(
                `SELECT 
                    TRIM(inventory_id) as inventoryId, 
                    inventory_name as description, 
                    item_class as itemClass, 
                    default_warehouse as branch, 
                    default_price as price,
                    item_status as itemStatus,
                    base_unit as baseUnit,
                    type,
                    posting_class as postingClass,
                    branch_id as branchId,
                    site_id as siteId,
                    on_hand as onHand,
                    available as available,
                    last_sync as lastSync,
                    company_id as companyId
                 FROM \`${INVENTORY_VIEW_TABLE}\` 
                 WHERE TRIM(UPPER(inventory_id)) = TRIM(UPPER(?))
                 AND company_id = ?
                 AND default_warehouse != '__catalog__'`,
                [inventoryId, companyId]
            );

            if (rows.length === 0) return null;

            // Use the first row for shared metadata
            const first = rows[0];
            
            // Map all rows to branch details
            const branches = rows.map(r => ({
                branchId: r.branchId || r.siteId,
                siteId: r.siteId,
                onHand: Number(r.onHand) || 0,
                available: Number(r.available) || 0,
                updatedAt: r.lastSync
            })).filter(b => b.branchId && !isExcludedBranchAlias(b.branchId) && (
                companyId === "ecommerce"
                    ? isEcomBranchAlias(b.branchId)
                    : !isEcomBranchAlias(b.branchId)
            ));

            const totalOnHand = branches.reduce((sum, b) => sum + b.onHand, 0);
            const totalAvailable = branches.reduce((sum, b) => sum + b.available, 0);

            return {
                inventoryId: first.inventoryId,
                description: first.description || "—",
                itemClass: first.itemClass || "—",
                unitPrice: first.price || 0,
                itemStatus: first.itemStatus || "—",
                baseUnit: first.baseUnit || "—",
                type: first.type || "—",
                postingClass: first.postingClass || "—",
                defaultWarehouse: first.branch || "—",
                companyId: first.companyId || companyId,
                totalOnHand,
                totalAvailable,
                lastSync: first.lastSync,
                branches
            };
        } catch (err) {
            console.error("[MySQL getStockItemDetail Error]", err);
            return null;
        }
    },

    /**
     * Fetch unique branches for Inventory / PO filters from MySQL only.
     * Merges the branches master table with distinct inventory site IDs so
     * every operational branch appears (Acumatica Branch entity is not used).
     * Cached 10 min — invalidated on replaceMasterBranches / upsertBranches.
     */
    async getBranches(companyId = "main") {
        return getCached(`branches:list:v2:${companyId}`, 600_000, () =>
            this._getBranchesUncached(companyId)
        );
    },

    async _getBranchesUncached(companyId = "main") {
        try {
            const [masterBranches, inventoryIds] = await Promise.all([
                this.getMasterBranches(),
                this.getInventoryBranchIds(companyId),
            ]);

            const byId = new Map();
            const add = (id, name = "") => {
                const key = String(id || "").trim();
                if (!key || key === "__catalog__") return;
                if (isExcludedBranchAlias(key)) return;
                if (isExcludedBranchAlias(name)) return;
                if (companyId === "ecommerce" && !isEcomBranchAlias(key)) return;

                const upper = key.toUpperCase();
                const label = String(name || "").trim();
                const existing = byId.get(upper);
                if (!existing) {
                    byId.set(upper, {
                        SiteID: key,
                        Description: { value: label || key },
                    });
                    return;
                }
                if (
                    label &&
                    label.toUpperCase() !== upper &&
                    (!existing.Description?.value || existing.Description.value === existing.SiteID)
                ) {
                    existing.Description = { value: label };
                }
            };

            // Prefer master names, then fill any site IDs present in inventory
            for (const b of masterBranches) {
                add(b.branch_id || b.SiteID, b.branch_name || b.Description);
            }
            for (const id of inventoryIds) {
                add(id, "");
            }

            // Always expose MAIN when browsing the main company
            if (companyId !== "ecommerce") {
                add("MAIN", "MAIN");
            }

            if (byId.size === 0) {
                return companyId === "ecommerce"
                    ? [{ SiteID: "ECOMMERCE", Description: { value: "ECOMMERCE" } }]
                    : [{ SiteID: "MAIN", Description: { value: "MAIN" } }];
            }

            return [...byId.values()].sort((a, b) => {
                const aId = String(a.SiteID).toUpperCase();
                const bId = String(b.SiteID).toUpperCase();
                if (aId === "MAIN") return -1;
                if (bId === "MAIN") return 1;
                return String(a.SiteID).localeCompare(String(b.SiteID));
            });
        } catch (err) {
            console.error("[MySQL getBranches Error]", err);
            return [];
        }
    },

    async getInventoryBranchIds(companyId = "main") {
        try {
            const branchEx = sqlExcludeBranches("i");
            let query;
            let params;

            if (companyId === "ecommerce") {
                const ecomOnly = sqlOnlyEcomBranches("i");
                query = `SELECT DISTINCT branch_id FROM \`${INVENTORY_VIEW_TABLE}\` i
                         WHERE company_id = 'ecommerce'
                           AND branch_id IS NOT NULL AND branch_id != '' AND branch_id != '__catalog__'
                           AND ${ecomOnly.clause}
                           AND ${branchEx.clause}
                         ORDER BY branch_id ASC`;
                params = [...ecomOnly.params, ...branchEx.params];
            } else {
                query = `SELECT DISTINCT branch_id FROM \`${INVENTORY_VIEW_TABLE}\` i
                         WHERE company_id IN ('main', 'ecommerce')
                           AND branch_id IS NOT NULL AND branch_id != '' AND branch_id != '__catalog__'
                           AND ${branchEx.clause}
                         ORDER BY branch_id ASC`;
                params = [...branchEx.params];
            }

            const [rows] = await pool.execute(query, params);
            return rows.map((r) => String(r.branch_id || "").trim()).filter(Boolean);
        } catch (err) {
            console.error("[MySQL getInventoryBranchIds Error]", err);
            return [];
        }
    },

    async getInventoryBranchesLegacy(companyId = "main") {
        try {
            const ids = await this.getInventoryBranchIds(companyId);
            return ids.map((id) => ({
                SiteID: id,
                Description: { value: id },
            }));
        } catch (err) {
            console.error("[MySQL getInventoryBranchesLegacy Error]", err);
            return [];
        }
    },

    /** Move ecommerce branch rows from main company into ecommerce company bucket (sync table). */
    async cleanupMisclassifiedEcomBranches() {
        try {
            const branches = [...ECOM_BRANCH_ALIASES];
            const [result] = await pool.query(
                `UPDATE \`${INVENTORY_SYNC_TABLE}\` SET company_id = 'ecommerce'
                 WHERE company_id = 'main'
                   AND default_warehouse != '__catalog__'
                   AND UPPER(TRIM(branch_id)) IN (${branches.map(() => "?").join(", ")})`,
                branches
            );
            return result.affectedRows || 0;
        } catch (err) {
            console.error("[MySQL cleanupMisclassifiedEcomBranches Error]", err);
            return 0;
        }
    },

    /**
     * Fetch product catalog (id, class, description) for mapping
     */
    async getProductCatalog() {
        try {
            const [rows] = await pool.execute(
                `SELECT DISTINCT inventory_id, item_class, inventory_name as description FROM \`${INVENTORY_VIEW_TABLE}\``
            );
            return rows;
        } catch (err) {
            console.error("[MySQL getProductCatalog Error]", err);
            return [];
        }
    },

    /**
     * Get overall stock sum, optionally filtered by branch
     */
    async getOverallStocks(branch = "") {
        try {
            let whereClause = "default_warehouse != '__catalog__'";
            let params = [];
            if (branch) {
                whereClause += " AND branch_id = ?";
                params.push(branch);
            }
            const [[{ total }]] = await pool.query(
                `SELECT SUM(COALESCE(on_hand, 0)) as total FROM \`${INVENTORY_VIEW_TABLE}\` WHERE ${whereClause}`,
                params
            );
            return Number(total) || 0;
        } catch (err) {
            console.error("[MySQL getOverallStocks Error]", err);
            return 0;
        }
    },

    // ── Local app users (admin / user accounts) ─────────────────

    async ensureAppUsersTable() {
        if (MySqlService._appUsersReady) return true;
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS app_users (
                  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                  username VARCHAR(64) NOT NULL,
                  password_hash VARCHAR(255) NOT NULL,
                  full_name VARCHAR(160) NULL,
                  email VARCHAR(160) NULL,
                  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
                  allowed_modules VARCHAR(255) NULL,
                  active TINYINT(1) NOT NULL DEFAULT 1,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (id),
                  UNIQUE KEY uq_app_users_username (username),
                  KEY idx_app_users_role (role),
                  KEY idx_app_users_active (active)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try {
                const [[col]] = await purchasePool.query(
                    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_users' AND COLUMN_NAME = 'allowed_modules'`
                );
                if (!Number(col?.cnt)) {
                    await purchasePool.query(
                        `ALTER TABLE app_users ADD COLUMN allowed_modules VARCHAR(255) NULL AFTER role`
                    );
                }
            } catch (alterErr) {
                if (!/duplicate column/i.test(alterErr.message)) {
                    console.warn("[MySQL app_users allowed_modules]", alterErr.message);
                }
            }
            MySqlService._appUsersReady = true;
            await this.ensureAppUserBranchesTable();
            return true;
        } catch (err) {
            console.error("[MySQL ensureAppUsersTable]", err.message);
            return false;
        }
    },

    async ensureAppUserBranchesTable() {
        if (MySqlService._appUserBranchesReady) return true;
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS app_user_branches (
                  user_id INT UNSIGNED NOT NULL,
                  branch_id VARCHAR(100) NOT NULL,
                  PRIMARY KEY (user_id, branch_id),
                  KEY idx_aub_branch (branch_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            MySqlService._appUserBranchesReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensureAppUserBranchesTable]", err.message);
            return false;
        }
    },

    async getAppUserBranchIds(userId) {
        const uid = Number(userId);
        if (!uid) return [];
        await this.ensureAppUserBranchesTable();
        const [rows] = await purchasePool.execute(
            `SELECT branch_id FROM app_user_branches WHERE user_id = ? ORDER BY branch_id ASC`,
            [uid]
        );
        return rows.map((r) => String(r.branch_id || "").trim()).filter(Boolean);
    },

    async getAppUserBranchesMap(userIds = []) {
        const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => id > 0))];
        const map = new Map();
        if (!ids.length) return map;
        await this.ensureAppUserBranchesTable();
        const ph = ids.map(() => "?").join(",");
        const [rows] = await purchasePool.execute(
            `SELECT user_id, branch_id FROM app_user_branches WHERE user_id IN (${ph}) ORDER BY branch_id ASC`,
            ids
        );
        for (const row of rows) {
            const uid = Number(row.user_id);
            const bid = String(row.branch_id || "").trim();
            if (!uid || !bid) continue;
            if (!map.has(uid)) map.set(uid, []);
            map.get(uid).push(bid);
        }
        return map;
    },

    async setAppUserBranches(userId, branchIds = []) {
        const uid = Number(userId);
        if (!uid) return false;
        await this.ensureAppUserBranchesTable();
        const unique = [];
        const seen = new Set();
        for (const raw of Array.isArray(branchIds) ? branchIds : []) {
            const id = String(raw || "").trim().toUpperCase();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            unique.push(id);
        }
        const conn = await purchasePool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute(`DELETE FROM app_user_branches WHERE user_id = ?`, [uid]);
            if (unique.length) {
                const values = unique.map((b) => [uid, b]);
                await conn.query(
                    `INSERT INTO app_user_branches (user_id, branch_id) VALUES ?`,
                    [values]
                );
            }
            await conn.commit();
            return true;
        } catch (err) {
            await conn.rollback();
            console.error("[MySQL setAppUserBranches]", err.message);
            return false;
        } finally {
            conn.release();
        }
    },

    async seedDefaultAdmin({ username, passwordHash, fullName = "System Administrator" } = {}) {
        await this.ensureAppUsersTable();
        // Only seed when the table is empty — never recreate a deleted "admin" user
        // while other accounts still exist (that made deletes look broken).
        const [[countRow]] = await purchasePool.execute(
            `SELECT COUNT(*) AS c FROM app_users`
        );
        if (Number(countRow?.c) > 0) {
            return { created: false, username: String(username || "admin").trim(), reason: "users_exist" };
        }
        const user = String(username || process.env.APP_ADMIN_USERNAME || "admin").trim();
        const id = await this.createAppUser({
            username: user,
            passwordHash,
            fullName,
            email: "",
            role: "admin",
            active: true,
        });
        console.log(`[AppUsers] Seeded admin account "${user}" (id=${id})`);
        return { created: true, username: user, id };
    },

    async getAppUserByUsername(username) {
        await this.ensureAppUsersTable();
        const [rows] = await purchasePool.execute(
            `SELECT id, username, password_hash, full_name, email, role, allowed_modules, active, created_at, updated_at
             FROM app_users WHERE username = ? LIMIT 1`,
            [String(username || "").trim()]
        );
        return rows[0] || null;
    },

    async getAppUserById(id) {
        await this.ensureAppUsersTable();
        const [rows] = await purchasePool.execute(
            `SELECT id, username, password_hash, full_name, email, role, allowed_modules, active, created_at, updated_at
             FROM app_users WHERE id = ? LIMIT 1`,
            [Number(id)]
        );
        return rows[0] || null;
    },

    async listAppUsers() {
        await this.ensureAppUsersTable();
        const [rows] = await purchasePool.execute(
            `SELECT id, username, full_name, email, role, allowed_modules, active, created_at, updated_at
             FROM app_users
             ORDER BY role ASC, username ASC`
        );
        const map = await this.getAppUserBranchesMap(rows.map((r) => r.id));
        return rows.map((r) => ({
            ...r,
            branchIds: map.get(Number(r.id)) || [],
        }));
    },

    async createAppUser({ username, passwordHash, fullName = "", email = "", role = "user", active = true, allowedModules = null }) {
        await this.ensureAppUsersTable();
        const [result] = await purchasePool.execute(
            `INSERT INTO app_users (username, password_hash, full_name, email, role, allowed_modules, active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                String(username).trim(),
                passwordHash,
                String(fullName || "").trim() || null,
                String(email || "").trim() || null,
                role === "admin" ? "admin" : "user",
                role === "admin" ? null : allowedModules,
                active ? 1 : 0,
            ]
        );
        return result.insertId;
    },

    async updateAppUser(id, fields = {}) {
        await this.ensureAppUsersTable();
        const sets = [];
        const params = [];
        if (fields.username !== undefined) {
            sets.push("username = ?");
            params.push(String(fields.username).trim());
        }
        if (fields.passwordHash !== undefined) {
            sets.push("password_hash = ?");
            params.push(fields.passwordHash);
        }
        if (fields.fullName !== undefined) {
            sets.push("full_name = ?");
            params.push(String(fields.fullName || "").trim() || null);
        }
        if (fields.email !== undefined) {
            sets.push("email = ?");
            params.push(String(fields.email || "").trim() || null);
        }
        if (fields.role !== undefined) {
            sets.push("role = ?");
            params.push(fields.role === "admin" ? "admin" : "user");
        }
        if (fields.allowedModules !== undefined) {
            sets.push("allowed_modules = ?");
            params.push(fields.role === "admin" ? null : fields.allowedModules);
        }
        if (fields.active !== undefined) {
            sets.push("active = ?");
            params.push(fields.active ? 1 : 0);
        }
        if (!sets.length) return false;
        params.push(Number(id));
        const [result] = await purchasePool.execute(
            `UPDATE app_users SET ${sets.join(", ")} WHERE id = ?`,
            params
        );
        return result.affectedRows > 0;
    },

    async deleteAppUser(id) {
        await this.ensureAppUsersTable();
        await this.ensureAppUserBranchesTable();
        const uid = Number(id);
        await purchasePool.execute(`DELETE FROM app_user_branches WHERE user_id = ?`, [uid]);
        const [result] = await purchasePool.execute(
            `DELETE FROM app_users WHERE id = ?`,
            [uid]
        );
        return result.affectedRows > 0;
    },

    async countAppAdmins() {
        await this.ensureAppUsersTable();
        const [[{ c }]] = await purchasePool.execute(
            `SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin' AND active = 1`
        );
        return Number(c) || 0;
    },

    // ── Persistent app sessions (survive restarts; logout clears) ─

    async ensureAppSessionsTable() {
        if (MySqlService._appSessionsReady) return true;
        try {
            await this.ensureAppUsersTable();
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS app_sessions (
                  session_id VARCHAR(64) NOT NULL,
                  user_id INT UNSIGNED NOT NULL,
                  active_company_id VARCHAR(32) NOT NULL DEFAULT 'main',
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (session_id),
                  KEY idx_app_sessions_user (user_id),
                  KEY idx_app_sessions_seen (last_seen_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            MySqlService._appSessionsReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensureAppSessionsTable]", err.message);
            return false;
        }
    },

    async upsertAppSession({ sessionId, userId, activeCompanyId = "main" } = {}) {
        await this.ensureAppSessionsTable();
        await purchasePool.execute(
            `INSERT INTO app_sessions (session_id, user_id, active_company_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
               user_id = VALUES(user_id),
               active_company_id = VALUES(active_company_id),
               last_seen_at = CURRENT_TIMESTAMP`,
            [String(sessionId), Number(userId), String(activeCompanyId || "main")]
        );
        return true;
    },

    async getAppSession(sessionId) {
        await this.ensureAppSessionsTable();
        const [rows] = await purchasePool.execute(
            `SELECT session_id, user_id, active_company_id, created_at, last_seen_at
             FROM app_sessions WHERE session_id = ? LIMIT 1`,
            [String(sessionId || "")]
        );
        return rows[0] || null;
    },

    async touchAppSession(sessionId) {
        await this.ensureAppSessionsTable();
        await purchasePool.execute(
            `UPDATE app_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE session_id = ?`,
            [String(sessionId || "")]
        );
    },

    async deleteAppSession(sessionId) {
        await this.ensureAppSessionsTable();
        const [result] = await purchasePool.execute(
            `DELETE FROM app_sessions WHERE session_id = ?`,
            [String(sessionId || "")]
        );
        return result.affectedRows > 0;
    },

    async ensureAppUserActionLogsTable() {
        if (MySqlService._appUserActionLogsReady) return true;
        try {
            await this.ensureAppUsersTable();
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS app_user_action_logs (
                  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                  user_id INT UNSIGNED NOT NULL,
                  action VARCHAR(64) NOT NULL,
                  module VARCHAR(50) NULL,
                  ref_id VARCHAR(100) NULL,
                  field_key VARCHAR(50) NULL,
                  detail TEXT NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (id),
                  KEY idx_ual_user_created (user_id, created_at),
                  KEY idx_ual_action (action)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            MySqlService._appUserActionLogsReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensureAppUserActionLogsTable]", err.message);
            return false;
        }
    },

    /**
     * Record a user action for admin activity review (annotations, login, etc.).
     */
    async logAppUserAction({
        userId,
        action,
        moduleName = null,
        refId = null,
        fieldKey = null,
        detail = null,
    } = {}) {
        const uid = Number(userId);
        if (!uid || !action) return false;
        try {
            await this.ensureAppUserActionLogsTable();
            await purchasePool.execute(
                `INSERT INTO app_user_action_logs
                    (user_id, action, module, ref_id, field_key, detail)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    uid,
                    String(action).slice(0, 64),
                    moduleName != null ? String(moduleName).slice(0, 50) : null,
                    refId != null ? String(refId).slice(0, 100) : null,
                    fieldKey != null ? String(fieldKey).slice(0, 50) : null,
                    detail != null ? String(detail).slice(0, 2000) : null,
                ]
            );
            return true;
        } catch (err) {
            console.error("[MySQL logAppUserAction]", err.message);
            return false;
        }
    },

    async listAppUserActionLogs(userId, { limit = 100 } = {}) {
        const uid = Number(userId);
        if (!uid) return [];
        await this.ensureAppUserActionLogsTable();
        const lim = Math.min(300, Math.max(1, parseInt(limit, 10) || 100));
        const [rows] = await purchasePool.execute(
            `SELECT id, user_id, action, module, ref_id, field_key, detail, created_at
             FROM app_user_action_logs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ${lim}`,
            [uid]
        );
        return rows;
    },

    async getLatestAppSessionForUser(userId) {
        const uid = Number(userId);
        if (!uid) return null;
        await this.ensureAppSessionsTable();
        const [rows] = await purchasePool.execute(
            `SELECT session_id, user_id, active_company_id, created_at, last_seen_at
             FROM app_sessions
             WHERE user_id = ?
             ORDER BY last_seen_at DESC
             LIMIT 1`,
            [uid]
        );
        return rows[0] || null;
    },

    /**
     * Users with a session heartbeated within the last N minutes (one row per user).
     */
    async listOnlineUsers({ withinMinutes = 3 } = {}) {
        const all = await this.listUserPresence();
        const mins = Math.min(15, Math.max(1, parseInt(withinMinutes, 10) || 3));
        const cutoff = Date.now() - mins * 60 * 1000;
        return all.filter((row) => {
            if (!row.last_seen_at) return false;
            const t = new Date(row.last_seen_at).getTime();
            return Number.isFinite(t) && t >= cutoff;
        });
    },

    /**
     * Active app users with their latest session (online or offline).
     */
    async listUserPresence() {
        await this.ensureAppSessionsTable();
        await this.ensureAppUsersTable();
        const [rows] = await purchasePool.execute(
            `SELECT
                u.id,
                u.username,
                u.full_name,
                u.role,
                latest.active_company_id,
                latest.last_seen_at
             FROM app_users u
             LEFT JOIN (
                SELECT s.user_id, s.active_company_id, s.last_seen_at
                FROM app_sessions s
                INNER JOIN (
                    SELECT user_id, MAX(last_seen_at) AS last_seen_at
                    FROM app_sessions
                    GROUP BY user_id
                ) m ON m.user_id = s.user_id AND m.last_seen_at = s.last_seen_at
             ) latest ON latest.user_id = u.id
             WHERE u.active = 1
             GROUP BY u.id, u.username, u.full_name, u.role, latest.active_company_id, latest.last_seen_at
             ORDER BY (latest.last_seen_at IS NULL) ASC, latest.last_seen_at DESC`
        );
        return rows;
    },

    /**
     * Bulk upsert branches
     */
    async upsertBranches(branches) {
        if (!branches.length) return;
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const b of branches) {
                await connection.execute(
                    `INSERT INTO branches (branch_id, branch_name, active) 
                     VALUES (?, ?, ?) 
                     ON DUPLICATE KEY UPDATE branch_name = VALUES(branch_name), active = VALUES(active)`,
                    [b.branch_id, b.branch_name, b.active ? 1 : 0]
                );
            }
            await connection.commit();
            invalidateCache("branches:");
        } catch (err) {
            await connection.rollback();
            console.error("[MySQL upsertBranches Error]", err);
            throw err;
        } finally {
            connection.release();
        }
    },

    /**
     * Replace master Branch list with Acumatica Branch entities only.
     * Removes stale Warehouse IDs previously merged into this table.
     */
    async replaceMasterBranches(branches) {
        if (!branches.length) return;
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const keepIds = [];
            for (const b of branches) {
                const id = String(b.branch_id || "").trim();
                if (!id) continue;
                keepIds.push(id);
                await connection.execute(
                    `INSERT INTO branches (branch_id, branch_name, active)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE branch_name = VALUES(branch_name), active = VALUES(active)`,
                    [id, String(b.branch_name || id).trim(), b.active === false ? 0 : 1]
                );
            }
            if (keepIds.length) {
                const ph = keepIds.map(() => "?").join(",");
                await connection.execute(
                    `DELETE FROM branches WHERE branch_id NOT IN (${ph})`,
                    keepIds
                );
            }
            await connection.commit();
            invalidateCache("branches:");
        } catch (err) {
            await connection.rollback();
            console.error("[MySQL replaceMasterBranches Error]", err);
            throw err;
        } finally {
            connection.release();
        }
    },

    /**
     * Ensure product_inventory_items exists (sync destination + Inventory UI reads).
     */
    async ensureProductInventoryItemsTable() {
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS \`${INVENTORY_SYNC_TABLE}\` (
                    \`id\` INT NOT NULL AUTO_INCREMENT,
                    \`inventory_id\` VARCHAR(100) NOT NULL,
                    \`default_warehouse\` VARCHAR(100) NOT NULL DEFAULT '__catalog__',
                    \`inventory_name\` VARCHAR(255) NULL,
                    \`item_class\` VARCHAR(100) NULL,
                    \`default_price\` DECIMAL(18,4) DEFAULT 0,
                    \`item_status\` VARCHAR(50) DEFAULT 'active',
                    \`base_unit\` VARCHAR(50) NULL DEFAULT '',
                    \`type\` VARCHAR(50) NULL,
                    \`posting_class\` VARCHAR(100) NULL DEFAULT '',
                    \`branch_id\` VARCHAR(100) NULL,
                    \`site_id\` VARCHAR(100) NULL,
                    \`on_hand\` DECIMAL(18,4) DEFAULT 0,
                    \`available\` DECIMAL(18,4) DEFAULT 0,
                    \`last_sync\` DATETIME NULL,
                    \`company_id\` VARCHAR(50) NOT NULL DEFAULT 'main',
                    \`vendor_id\` VARCHAR(100) NULL,
                    \`lead_time_days\` INT NULL,
                    \`safety_stock\` DECIMAL(18,4) NULL,
                    \`moq\` DECIMAL(18,4) NULL,
                    PRIMARY KEY (\`inventory_id\`, \`default_warehouse\`, \`company_id\`),
                    UNIQUE KEY \`uq_inv_warehouse\` (\`inventory_id\`, \`default_warehouse\`, \`company_id\`),
                    KEY \`idx_inventory_row_id\` (\`id\`),
                    KEY \`idx_inv_company_wh\` (\`company_id\`, \`default_warehouse\`, \`branch_id\`, \`on_hand\`),
                    KEY \`idx_inv_company_branch\` (\`company_id\`, \`branch_id\`, \`default_warehouse\`),
                    KEY \`idx_inv_status\` (\`item_status\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            const cols = [
                { name: "on_hand", def: "DECIMAL(18, 4) DEFAULT 0" },
                { name: "available", def: "DECIMAL(18, 4) DEFAULT 0" },
                { name: "branch_id", def: "VARCHAR(100) NULL" },
                { name: "site_id", def: "VARCHAR(100) NULL" },
                { name: "last_sync", def: "DATETIME NULL" },
                { name: "type", def: "VARCHAR(50) NULL" },
                { name: "posting_class", def: "VARCHAR(100) NULL DEFAULT ''" },
                { name: "base_unit", def: "VARCHAR(50) NULL DEFAULT ''" },
                { name: "item_class", def: "VARCHAR(100) NULL" },
                { name: "default_price", def: "DECIMAL(18, 4) DEFAULT 0" },
                { name: "inventory_name", def: "VARCHAR(255) NULL" },
                { name: "item_status", def: "VARCHAR(50) DEFAULT 'active'" },
                { name: "company_id", def: "VARCHAR(50) NOT NULL DEFAULT 'main'" },
                { name: "vendor_id", def: "VARCHAR(100) NULL" },
                { name: "lead_time_days", def: "INT NULL" },
                { name: "safety_stock", def: "DECIMAL(18,4) NULL" },
                { name: "moq", def: "DECIMAL(18,4) NULL" },
            ];
            for (const c of cols) {
                const [[row]] = await pool.query(
                    `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
                    [inventoryDb, INVENTORY_SYNC_TABLE, c.name]
                );
                if (row.cnt === 0) {
                    await pool.query(
                        `ALTER TABLE \`${INVENTORY_SYNC_TABLE}\` ADD COLUMN \`${c.name}\` ${c.def}`
                    );
                }
            }

            // Drop inventory_id-only unique indexes — they collapse all warehouses into one row
            // and catalog upserts wipe sellable stock (Branch Stock then reads stale forecast).
            // Keep PK on `id` (FK from product_inventory_attachments); add composite UNIQUE instead.
            for (const idx of [
                "uq_product_inventory_items_inventory_id",
                "uq_inventory_items_inventory_id",
                "inventory_id",
            ]) {
                try {
                    const [[row]] = await pool.query(
                        `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
                         WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?`,
                        [inventoryDb, INVENTORY_SYNC_TABLE, idx]
                    );
                    if (Number(row?.cnt) > 0) {
                        await pool.query(
                            `ALTER TABLE \`${INVENTORY_SYNC_TABLE}\` DROP INDEX \`${idx}\``
                        );
                        console.log(
                            `[MySQL] Dropped blocking ${INVENTORY_SYNC_TABLE} index: ${idx}`
                        );
                    }
                } catch (idxErr) {
                    console.warn(
                        `[MySQL] ${INVENTORY_SYNC_TABLE} index drop ${idx}:`,
                        idxErr.message
                    );
                }
            }

            const [[uqWh]] = await pool.query(
                `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME='uq_inv_warehouse'`,
                [inventoryDb, INVENTORY_SYNC_TABLE]
            );
            if (Number(uqWh?.cnt) === 0) {
                try {
                    await pool.query(
                        `ALTER TABLE \`${INVENTORY_SYNC_TABLE}\`
                         ADD UNIQUE KEY uq_inv_warehouse (inventory_id, default_warehouse, company_id)`
                    );
                    console.log(
                        `[MySQL] ${INVENTORY_SYNC_TABLE} added uq_inv_warehouse (inventory_id, default_warehouse, company_id)`
                    );
                } catch (uqErr) {
                    console.warn(
                        `[MySQL] ${INVENTORY_SYNC_TABLE} uq_inv_warehouse skipped:`,
                        uqErr.message
                    );
                }
            }

            return true;
        } catch (err) {
            console.error("[MySQL ensureProductInventoryItemsTable Error]", err);
            return false;
        }
    },

    async ensureInventoryPlanningColumns() {
        if (MySqlService._planningColsReady) return true;

        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
        const cols = [
            { name: "vendor_id", def: "VARCHAR(100) NULL" },
            { name: "lead_time_days", def: "INT NULL" },
            { name: "safety_stock", def: "DECIMAL(18,4) NULL" },
            { name: "moq", def: "DECIMAL(18,4) NULL" },
        ];
        try {
            await this.ensureProductInventoryItemsTable();
            for (const c of cols) {
                const [[row]] = await pool.query(
                    `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
                    [inventoryDb, INVENTORY_SYNC_TABLE, c.name]
                );
                if (row.cnt === 0) {
                    await pool.query(
                        `ALTER TABLE \`${INVENTORY_SYNC_TABLE}\` ADD COLUMN \`${c.name}\` ${c.def}`
                    );
                }
            }
            MySqlService._planningColsReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensureInventoryPlanningColumns Error]", err);
            return false;
        }
    },
    _planningColsReady: false,

    /**
     * Bulk-update catalog fields on product_inventory_items (CMS one-row-per-SKU).
     * Also mirrors catalog into forecast_item_stock (Inventory source of truth).
     */
    async upsertInventoryItems(items, companyId = "main") {
        if (!items.length) return;
        await this.ensureInventoryPlanningColumns();
        const CHUNK = 200;
        const now = new Date();
        const safeNum = (v) => { const n = Number(v); return (isNaN(n) ? null : n); };

        // Forecast catalog first — Inventory KPIs read from here.
        await this.upsertForecastItemStockRows(
            items.map((item) => ({
                inventory_id: item.inventory_id,
                warehouse_id: "__catalog__",
                item_name: item.description,
                item_class: item.item_class,
                default_price: item.default_price,
                on_hand: 0,
                available: 0,
                item_status: item.item_status,
            })),
            companyId
        );

        // CMS product table: update existing SKU row, or insert once if missing.
        // Never insert a second warehouse/catalog twin (Connect trigger blocks it).
        for (let i = 0; i < items.length; i += CHUNK) {
            const chunk = items.slice(i, i + CHUNK);
            for (const item of chunk) {
                const invId = String(item.inventory_id || "").trim();
                if (!invId) continue;
                try {
                    const [upd] = await pool.query(
                        `UPDATE \`${INVENTORY_SYNC_TABLE}\`
                         SET inventory_name = COALESCE(?, inventory_name),
                             item_class = COALESCE(?, item_class),
                             default_price = COALESCE(?, default_price),
                             item_status = COALESCE(?, item_status),
                             base_unit = COALESCE(NULLIF(?, ''), base_unit),
                             type = COALESCE(NULLIF(?, ''), type),
                             posting_class = COALESCE(NULLIF(?, ''), posting_class),
                             vendor_id = COALESCE(NULLIF(?, ''), vendor_id),
                             lead_time_days = COALESCE(?, lead_time_days),
                             safety_stock = COALESCE(?, safety_stock),
                             moq = COALESCE(?, moq),
                             last_sync = ?
                         WHERE company_id = ? AND TRIM(inventory_id) = ?`,
                        [
                            item.description || null,
                            item.item_class || null,
                            safeNum(item.default_price),
                            item.item_status || "active",
                            item.base_unit || "",
                            item.item_type || "",
                            item.posting_class || "",
                            item.vendor_id || null,
                            item.lead_time_days != null ? parseInt(item.lead_time_days, 10) : null,
                            safeNum(item.safety_stock),
                            safeNum(item.moq),
                            now,
                            companyId,
                            invId,
                        ]
                    );
                    if ((upd.affectedRows || 0) > 0) continue;
                    await pool.query(
                        `INSERT INTO \`${INVENTORY_SYNC_TABLE}\`
                            (inventory_id, company_id, default_warehouse, inventory_name, item_class,
                             default_price, item_status, base_unit, type, posting_class,
                             vendor_id, lead_time_days, safety_stock, moq, last_sync)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [
                            invId,
                            companyId,
                            "__catalog__",
                            item.description || null,
                            item.item_class || null,
                            safeNum(item.default_price),
                            item.item_status || "active",
                            item.base_unit || "",
                            item.item_type || "",
                            item.posting_class || "",
                            item.vendor_id || null,
                            item.lead_time_days != null ? parseInt(item.lead_time_days, 10) : null,
                            safeNum(item.safety_stock),
                            safeNum(item.moq),
                            now,
                        ]
                    );
                } catch (err) {
                    if (isCmsSkuTwinError(err)) {
                        console.warn(
                            `[MySQL upsertInventoryItems] CMS one-SKU skip insert for ${invId}`
                        );
                        continue;
                    }
                    console.error("[MySQL upsertInventoryItems Error]", err);
                    throw err;
                }
            }
        }
    },

    /** Clear branch/stock fields on catalog rows — stock lives on warehouse rows only. */
    async sanitizeCatalogStockFields(companyId = null) {
        try {
            const sql = companyId
                ? `UPDATE \`${INVENTORY_SYNC_TABLE}\`
                   SET branch_id = NULL, site_id = NULL, on_hand = 0, available = 0
                   WHERE company_id = ? AND default_warehouse = '__catalog__'`
                : `UPDATE \`${INVENTORY_SYNC_TABLE}\`
                   SET branch_id = NULL, site_id = NULL, on_hand = 0, available = 0
                   WHERE default_warehouse = '__catalog__'`;
            const params = companyId ? [companyId] : [];
            const [result] = await pool.query(sql, params);
            return result.affectedRows || 0;
        } catch (err) {
            console.error("[MySQL sanitizeCatalogStockFields Error]", err);
            throw err;
        }
    },

    /** Inventory IDs with sellable on-hand (excludes DAMAGE / DISCOUNTED warehouses). */
    async listStockedInventoryIds({ companyId = "main", limit = 120 } = {}) {
        const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 120));
        const [rows] = await pool.query(
            `SELECT DISTINCT TRIM(inventory_id) AS inventory_id
             FROM \`${INVENTORY_VIEW_TABLE}\`
             WHERE company_id = ?
               AND default_warehouse != '__catalog__'
               AND UPPER(TRIM(COALESCE(default_warehouse, ''))) NOT LIKE '%DAMAGE%'
               AND UPPER(TRIM(COALESCE(default_warehouse, ''))) NOT LIKE '%DISCOUNTED%'
               AND UPPER(TRIM(COALESCE(branch_id, ''))) NOT LIKE '%DAMAGE%'
               AND UPPER(TRIM(COALESCE(branch_id, ''))) NOT LIKE '%DISCOUNTED%'
               AND COALESCE(on_hand, 0) > 0
             ORDER BY on_hand DESC
             LIMIT ${lim}`,
            [companyId]
        );
        return rows.map((r) => String(r.inventory_id || "").trim()).filter(Boolean);
    },

    /**
     * Write warehouse stock levels.
     * Source of truth = forecast_item_stock (multi-warehouse).
     * CMS product_inventory_items stays one row per SKU — only mirror MAIN qty onto that row.
     */
    async upsertInventoryLevels(levels, companyId = "main") {
        if (!levels.length) return;
        const now = new Date();
        const safeNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };

        // 1) Multi-warehouse stock for Inventory UI
        await this.upsertForecastItemStockRows(
            levels.map((l) => ({
                inventory_id: l.inventory_id,
                warehouse_id: l.warehouse_id || l.branch_id || "",
                branch_id: l.branch_id || "",
                site_id: l.site_id || "",
                item_name: l.description,
                item_class: l.item_class,
                default_price: l.default_price,
                on_hand: l.on_hand,
                available: l.available,
                item_status: l.item_status,
            })),
            companyId
        );

        invalidateCache("branches:");
        invalidateCache("global-stats-v8:");
        invalidateCache("global-stats-v7:");
        invalidateCache("global-stats-v6:");
        invalidateCache(`wh-count:fis-or-${INVENTORY_SYNC_TABLE}:`);
        invalidateCache(`cat-count:fis-or-${INVENTORY_SYNC_TABLE}:`);

        // 2) Best-effort CMS mirror: update existing SKU row only (no warehouse twins).
        await this.ensureProductInventoryItemsTable();
        for (const l of levels) {
            const invId = String(l.inventory_id || "").trim();
            const wh = String(l.warehouse_id || l.branch_id || "").trim().toUpperCase();
            if (!invId) continue;
            // Prefer MAIN qty on the single CMS product row; otherwise refresh metadata only.
            const setQty = wh === "MAIN" || wh === "MAIN WH11";
            try {
                if (setQty) {
                    await pool.query(
                        `UPDATE \`${INVENTORY_SYNC_TABLE}\`
                         SET on_hand = ?,
                             available = ?,
                             inventory_name = COALESCE(?, inventory_name),
                             item_class = COALESCE(?, item_class),
                             default_price = COALESCE(?, default_price),
                             item_status = COALESCE(?, item_status),
                             last_sync = ?
                         WHERE company_id = ? AND TRIM(inventory_id) = ?`,
                        [
                            safeNum(l.on_hand),
                            safeNum(l.available ?? l.on_hand),
                            l.description || null,
                            l.item_class || null,
                            safeNum(l.default_price),
                            l.item_status || "active",
                            now,
                            companyId,
                            invId,
                        ]
                    );
                } else {
                    await pool.query(
                        `UPDATE \`${INVENTORY_SYNC_TABLE}\`
                         SET inventory_name = COALESCE(?, inventory_name),
                             item_class = COALESCE(?, item_class),
                             default_price = COALESCE(?, default_price),
                             item_status = COALESCE(?, item_status),
                             last_sync = ?
                         WHERE company_id = ? AND TRIM(inventory_id) = ?`,
                        [
                            l.description || null,
                            l.item_class || null,
                            safeNum(l.default_price),
                            l.item_status || "active",
                            now,
                            companyId,
                            invId,
                        ]
                    );
                }
            } catch (err) {
                if (isCmsSkuTwinError(err)) continue;
                console.warn("[MySQL upsertInventoryLevels CMS mirror]", err.message);
            }
        }
    },

    /**
     * Ensure multi-warehouse stock catalog rows exist in forecast_item_stock.
     * NOTE: product_inventory_items is CMS one-row-per-SKU (trigger blocks twins) —
     * do not try to insert __catalog__ alongside warehouse rows there.
     */
    async ensureCatalogRowsFromWarehouse(companyId = "main") {
        try {
            await this.ensureForecastItemStockTable();
            const [result] = await purchasePool.query(
                `INSERT INTO \`${FORECAST_STOCK_TABLE}\`
                    (company_id, inventory_id, warehouse_id, item_name, item_class,
                     default_price, on_hand, available, item_status, last_sync)
                 SELECT
                    w.company_id,
                    TRIM(w.inventory_id),
                    '__catalog__',
                    MAX(NULLIF(TRIM(w.item_name), '')),
                    MAX(NULLIF(TRIM(w.item_class), '')),
                    MAX(w.default_price),
                    0,
                    0,
                    MAX(NULLIF(TRIM(w.item_status), '')),
                    MAX(w.last_sync)
                 FROM \`${FORECAST_STOCK_TABLE}\` w
                 WHERE w.company_id = ?
                   AND w.warehouse_id != '__catalog__'
                   AND TRIM(COALESCE(w.inventory_id, '')) != ''
                   AND NOT EXISTS (
                        SELECT 1 FROM \`${FORECAST_STOCK_TABLE}\` c
                        WHERE c.company_id = w.company_id
                          AND c.warehouse_id = '__catalog__'
                          AND TRIM(c.inventory_id) = TRIM(w.inventory_id)
                   )
                 GROUP BY TRIM(w.inventory_id), w.company_id`,
                [companyId]
            );
            const inserted = result.affectedRows || 0;
            if (inserted > 0) {
                invalidateCache(`cat-count:fis-or-`);
                invalidateCache("global-stats-v7:");
                console.log(
                    `[MySQL] ensureCatalogRowsFromWarehouse(${companyId}): restored ${inserted} forecast catalog rows`
                );
            }
            return inserted;
        } catch (err) {
            console.error("[MySQL ensureCatalogRowsFromWarehouse Error]", err);
            return 0;
        }
    },

    async countDistinctWarehouses(companyId = "main") {
        try {
            const [[row]] = await pool.query(
                `SELECT COUNT(DISTINCT default_warehouse) AS c
                 FROM \`${INVENTORY_SYNC_TABLE}\`
                 WHERE company_id = ?
                   AND default_warehouse IS NOT NULL
                   AND default_warehouse != '__catalog__'
                   AND TRIM(default_warehouse) != ''`,
                [companyId]
            );
            return Number(row?.c) || 0;
        } catch (err) {
            console.error("[MySQL countDistinctWarehouses Error]", err);
            return 0;
        }
    },

    /** Warehouses refreshed at/after sync start (used to guard stale prune). */
    async countFreshWarehouses(syncStartedAt, companyId = "main") {
        try {
            await this.ensureForecastItemStockTable();
            const cutoff = new Date(new Date(syncStartedAt).getTime() - 2 * 60 * 1000);
            const [[row]] = await purchasePool.query(
                `SELECT COUNT(DISTINCT warehouse_id) AS c
                 FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ?
                   AND warehouse_id != '__catalog__'
                   AND last_sync IS NOT NULL
                   AND last_sync >= ?`,
                [companyId, cutoff]
            );
            return Number(row?.c) || 0;
        } catch (err) {
            console.error("[MySQL countFreshWarehouses Error]", err);
            return 0;
        }
    },

    /** Remove forecast warehouse rows not refreshed during the current full sync run. */
    async deleteStaleInventoryLevels(syncStartedAt, companyId = "main") {
        try {
            await this.ensureForecastItemStockTable();
            // 2-minute buffer so freshly upserted rows are never removed due to clock skew
            const cutoff = new Date(new Date(syncStartedAt).getTime() - 2 * 60 * 1000);
            const [result] = await purchasePool.query(
                `DELETE FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ?
                   AND warehouse_id != '__catalog__'
                   AND (last_sync IS NULL OR last_sync < ?)`,
                [companyId, cutoff]
            );
            invalidateCache("global-stats-v8:");
            invalidateCache(`wh-count:fis-or-${INVENTORY_SYNC_TABLE}:`);
            return result.affectedRows || 0;
        } catch (err) {
            console.error("[MySQL deleteStaleInventoryLevels Error]", err);
            throw err;
        }
    },

    async countWarehouseRows(companyId = "main", table = INVENTORY_VIEW_TABLE) {
        return countWarehouseRows(companyId, table);
    },

    async resolveInventoryLayout(companyId = "main") {
        return resolveInventoryLayout(companyId);
    },

    /** Remove all synced stock-level rows (keeps catalog rows). Used only for manual repair. */
    async purgeInventoryLevels(companyId = null) {
        try {
            const sql = companyId
                ? `DELETE FROM \`${INVENTORY_SYNC_TABLE}\` WHERE default_warehouse != '__catalog__' AND company_id = ?`
                : `DELETE FROM \`${INVENTORY_SYNC_TABLE}\` WHERE default_warehouse != '__catalog__'`;
            const params = companyId ? [companyId] : [];
            const [result] = await pool.query(sql, params);
            return result.affectedRows || 0;
        } catch (err) {
            console.error("[MySQL purgeInventoryLevels Error]", err);
            throw err;
        }
    },

    /**
     * Remove warehouse stock rows before re-importing an item batch (Quick/Full sync).
     * Deletes from forecast_item_stock only — never wipe CMS product_inventory_items SKUs.
     */
    async deleteInventoryLevelsForItems(itemIds, companyId = "main") {
        const ids = [...new Set(itemIds.map((id) => String(id || "").trim()).filter(Boolean))];
        if (!ids.length) return 0;
        try {
            await this.ensureForecastItemStockTable();
            const placeholders = ids.map(() => "?").join(",");
            const [result] = await purchasePool.query(
                `DELETE FROM \`${FORECAST_STOCK_TABLE}\`
                 WHERE company_id = ?
                   AND warehouse_id != '__catalog__'
                   AND TRIM(inventory_id) IN (${placeholders})`,
                [companyId, ...ids]
            );
            invalidateCache("global-stats-v8:");
            invalidateCache("global-stats-v7:");
            invalidateCache(`wh-count:fis-or-${INVENTORY_SYNC_TABLE}:`);
            return result.affectedRows || 0;
        } catch (err) {
            console.error("[MySQL deleteInventoryLevelsForItems Error]", err);
            throw err;
        }
    },

    async ensurePurchaseReceiptsTable() {
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS purchase_receipts (
                    id VARCHAR(80) NOT NULL PRIMARY KEY,
                    receipt_nbr VARCHAR(40) NOT NULL,
                    type VARCHAR(40) NULL,
                    status VARCHAR(40) NULL,
                    receipt_date DATE NULL,
                    vendor_id VARCHAR(40) NULL,
                    vendor_name VARCHAR(255) NULL,
                    total_qty DECIMAL(18,4) NULL DEFAULT 0,
                    currency VARCHAR(16) NULL,
                    created_on DATE NULL,
                    last_sync DATETIME NULL,
                    KEY idx_pr_date (receipt_date),
                    KEY idx_pr_vendor (vendor_id),
                    KEY idx_pr_nbr (receipt_nbr)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
        } catch (err) {
            console.error("[MySQL ensurePurchaseReceiptsTable Error]", err);
            throw err;
        }
    },

    /**
     * Upsert Acumatica Purchase Receipt header rows (file import or API).
     */
    async upsertPurchaseReceipts(rows = []) {
        if (!rows.length) return 0;
        await this.ensurePurchaseReceiptsTable();
        return withMysqlRetry("upsertPurchaseReceipts", async () => {
            const connection = await purchasePool.getConnection();
            const CHUNK = 200;
            let written = 0;
            try {
                await connection.beginTransaction();
                const sql = `INSERT INTO purchase_receipts
                    (id, receipt_nbr, type, status, receipt_date, vendor_id, vendor_name,
                     total_qty, currency, created_on, last_sync)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE
                    type = VALUES(type),
                    status = VALUES(status),
                    receipt_date = VALUES(receipt_date),
                    vendor_id = VALUES(vendor_id),
                    vendor_name = VALUES(vendor_name),
                    total_qty = VALUES(total_qty),
                    currency = VALUES(currency),
                    created_on = VALUES(created_on),
                    last_sync = VALUES(last_sync)`;
                for (let i = 0; i < rows.length; i += CHUNK) {
                    const chunk = rows.slice(i, i + CHUNK);
                    const values = chunk.map((r) => [
                        r.id || `${String(r.type || "Receipt").toUpperCase()}::${r.receipt_nbr}`,
                        r.receipt_nbr,
                        r.type ?? null,
                        r.status ?? null,
                        r.receipt_date ?? null,
                        r.vendor_id ?? null,
                        r.vendor_name ?? null,
                        r.total_qty ?? 0,
                        r.currency ?? null,
                        r.created_on ?? null,
                        r.last_sync ? new Date(r.last_sync) : new Date(),
                    ]);
                    await connection.query(sql, [values]);
                    written += chunk.length;
                }
                await connection.commit();
                return written;
            } catch (err) {
                await connection.rollback();
                console.error("[MySQL upsertPurchaseReceipts Error]", err);
                throw err;
            } finally {
                connection.release();
            }
        });
    },

    /**
     * Bulk upsert rows from Supabase product_periodic_sales into db_purchase.
     * Multi-row VALUES batches (not per-row execute) to cut sync time and pool load.
     */
    async upsertPeriodicSales(rows) {
        if (!rows.length) return;
        return withMysqlRetry("upsertPeriodicSales", async () => {
            const connection = await purchasePool.getConnection();
            const CHUNK = 200;
            try {
                await connection.beginTransaction();
                const sql = `INSERT INTO product_periodic_sales
                            (id, branch_name, order_type, financial_period, document_date,
                             description, qty, total_amount, item_class, inventory_id,
                             posting_class, last_sync)
                         VALUES ?
                         ON DUPLICATE KEY UPDATE
                            branch_name      = VALUES(branch_name),
                            order_type       = VALUES(order_type),
                            financial_period = VALUES(financial_period),
                            document_date    = VALUES(document_date),
                            description      = VALUES(description),
                            qty              = VALUES(qty),
                            total_amount     = VALUES(total_amount),
                            item_class       = VALUES(item_class),
                            inventory_id     = VALUES(inventory_id),
                            posting_class    = VALUES(posting_class),
                            last_sync        = VALUES(last_sync)`;

                for (let i = 0; i < rows.length; i += CHUNK) {
                    const chunk = rows.slice(i, i + CHUNK);
                    const values = chunk.map((r) => [
                        r.id,
                        r.branch_name ?? null,
                        r.order_type ?? null,
                        r.financial_period ?? null,
                        r.document_date ?? null,
                        r.description ?? null,
                        r.qty ?? null,
                        r.total_amount ?? null,
                        r.item_class ?? null,
                        r.inventory_id ?? null,
                        r.posting_class ?? null,
                        r.last_sync ? new Date(r.last_sync) : new Date(),
                    ]);
                    await connection.query(sql, [values]);
                }
                await connection.commit();
                invalidateCache("salesIds:");
                invalidateCache("salesAnalysis:");
                invalidateCache("replSalesMap:");
                invalidateCache("salesBranchNames");
                invalidateCache("resolveSalesBranch:");
                invalidateCache("salesSummary:");
            } catch (err) {
                await connection.rollback();
                console.error("[MySQL upsertPeriodicSales Error]", err);
                throw err;
            } finally {
                connection.release();
            }
        });
    },

    /**
     * Identify and handle orphaned sales records (no matching inventory item)
     */
    async validateSalesIntegrity() {
        const connection = await purchasePool.getConnection();
        try {
            console.log(">>> [MySQL] Validating Sales Integrity...");
            const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
            
            // 1. Find orphaned records
            const [orphans] = await connection.query(`
                SELECT COUNT(*) as count 
                FROM product_periodic_sales s
                LEFT JOIN \`${inventoryDb}\`.\`${INVENTORY_VIEW_TABLE}\` i ON s.inventory_id = i.inventory_id
                WHERE i.inventory_id IS NULL
            `);
            
            console.log(`>>> [MySQL] Found ${orphans[0].count} orphaned sales records.`);
            
            // 2. Mark orphans with a special class if they exist (optional, for visibility)
            if (orphans[0].count > 0) {
                await connection.query(`
                    UPDATE product_periodic_sales s
                    LEFT JOIN \`${inventoryDb}\`.\`${INVENTORY_VIEW_TABLE}\` i ON s.inventory_id = i.inventory_id
                    SET s.item_class = 'ORPHANED'
                    WHERE i.inventory_id IS NULL
                `);
            }
            
            return orphans[0].count;
        } catch (err) {
            console.error("[MySQL validateSalesIntegrity Error]", err);
            throw err;
        } finally {
            connection.release();
        }
    },

    /**
     * Log a synchronization event
     */
    async logSyncEvent(mode, section, status, records = 0, message = null) {
        try {
            await withMysqlRetry("logSyncEvent", () =>
                purchasePool.query(
                    `INSERT INTO sync_logs (mode, section, status, records_processed, message)
                     VALUES (?, ?, ?, ?, ?)`,
                    [mode, section, status, records, message]
                )
            );
            return true;
        } catch (err) {
            console.error("[MySQL logSyncEvent Error]", err?.code || err?.message || err);
            return false;
        }
    },

    /**
     * Fetch recent sync logs
     */
    async getSyncLogs(limit = 20) {
        try {
            const [rows] = await purchasePool.query(
                `SELECT id, timestamp, mode, section, status, records_processed as records, message 
                 FROM sync_logs 
                 ORDER BY timestamp DESC 
                 LIMIT ?`,
                [limit]
            );
            return rows;
        } catch (err) {
            console.error("[MySQL getSyncLogs Error]", err);
            return [];
        }
    },

    /**
     * Get all persistent user annotations for a specific module.
     * Short TTL — invalidated on upsertAnnotation.
     */
    async getAnnotations(moduleName) {
        return getCached(`annotations:${moduleName}`, 60_000, () =>
            this._getAnnotationsUncached(moduleName)
        );
    },

    async _getAnnotationsUncached(moduleName) {
        try {
            const [rows] = await purchasePool.query(
                "SELECT ref_id, field_key, field_value FROM user_annotations WHERE module = ?",
                [moduleName]
            );
            // Transform to { [ref_id]: { [field_key]: value } }
            return rows.reduce((acc, row) => {
                if (!acc[row.ref_id]) acc[row.ref_id] = {};
                acc[row.ref_id][row.field_key] = row.field_value;
                return acc;
            }, {});
        } catch (err) {
            console.error("[MySQL getAnnotations Error]", err);
            return {};
        }
    },

    /**
     * Persist or update a user annotation
     */
    async upsertAnnotation(moduleName, refId, fieldKey, fieldValue) {
        try {
            await purchasePool.query(
                `INSERT INTO user_annotations (module, ref_id, field_key, field_value)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE field_value = VALUES(field_value)`,
                [moduleName, refId, fieldKey, fieldValue]
            );
            invalidateCache(`annotations:${moduleName}`);
            return true;
        } catch (err) {
            console.error("[MySQL upsertAnnotation Error]", err);
            return false;
        }
    },

    async ensureItemDimensionsTable() {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS item_dimensions (
                    inventory_id VARCHAR(100) NOT NULL,
                    pcs_per_box DECIMAL(18,4) NULL,
                    length_m DECIMAL(18,6) NULL,
                    height_m DECIMAL(18,6) NULL,
                    width_m DECIMAL(18,6) NULL,
                    weight_kg DECIMAL(18,4) NULL,
                    cbm DECIMAL(18,8) NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (inventory_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (err) {
            console.error("[MySQL ensureItemDimensionsTable Error]", err);
            throw err;
        }
    },

    async getItemDimensions(inventoryId) {
        await this.ensureItemDimensionsTable();
        const [rows] = await pool.execute(
            `SELECT inventory_id, pcs_per_box, length_m, height_m, width_m, weight_kg, cbm, updated_at
             FROM item_dimensions WHERE TRIM(UPPER(inventory_id)) = TRIM(UPPER(?))`,
            [inventoryId]
        );
        if (!rows.length) return null;
        const r = rows[0];
        return {
            inventoryId: r.inventory_id,
            pcs_per_box: r.pcs_per_box != null ? Number(r.pcs_per_box) : null,
            length_m: r.length_m != null ? Number(r.length_m) : null,
            height_m: r.height_m != null ? Number(r.height_m) : null,
            width_m: r.width_m != null ? Number(r.width_m) : null,
            weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
            cbm: r.cbm != null ? Number(r.cbm) : null,
            updatedAt: r.updated_at,
        };
    },

    async getItemDimensionsBatch(inventoryIds = []) {
        await this.ensureItemDimensionsTable();
        const ids = [...new Set(inventoryIds.map((id) => String(id || "").trim()).filter(Boolean))];
        if (!ids.length) return {};
        const [rows] = await pool.query(
            `SELECT inventory_id, pcs_per_box, length_m, height_m, width_m, weight_kg, cbm, updated_at
             FROM item_dimensions
             WHERE TRIM(UPPER(inventory_id)) IN (${ids.map(() => "TRIM(UPPER(?))").join(",")})`,
            ids
        );
        const out = {};
        for (const r of rows) {
            const key = String(r.inventory_id || "").trim();
            if (!key) continue;
            out[key] = {
                inventoryId: key,
                pcs_per_box: r.pcs_per_box != null ? Number(r.pcs_per_box) : null,
                length_m: r.length_m != null ? Number(r.length_m) : null,
                height_m: r.height_m != null ? Number(r.height_m) : null,
                width_m: r.width_m != null ? Number(r.width_m) : null,
                weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
                cbm: r.cbm != null ? Number(r.cbm) : null,
                updatedAt: r.updated_at,
            };
            out[key.toUpperCase()] = out[key];
        }
        return out;
    },

    async upsertItemDimensions(inventoryId, data) {
        await this.ensureItemDimensionsTable();
        await pool.execute(
            `INSERT INTO item_dimensions
                (inventory_id, pcs_per_box, length_m, height_m, width_m, weight_kg, cbm)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                pcs_per_box = VALUES(pcs_per_box),
                length_m = VALUES(length_m),
                height_m = VALUES(height_m),
                width_m = VALUES(width_m),
                weight_kg = VALUES(weight_kg),
                cbm = VALUES(cbm)`,
            [
                String(inventoryId).trim(),
                data.pcs_per_box ?? null,
                data.length_m ?? null,
                data.height_m ?? null,
                data.width_m ?? null,
                data.weight_kg ?? null,
                data.cbm ?? null,
            ]
        );
        return this.getItemDimensions(inventoryId);
    },

    async getDimensionIdSet(inventoryIds = []) {
        await this.ensureItemDimensionsTable();
        const ids = [...new Set(inventoryIds.map((id) => String(id || "").trim()).filter(Boolean))];
        const set = new Set();
        if (!ids.length) return set;
        const placeholders = ids.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT UPPER(TRIM(inventory_id)) AS id FROM item_dimensions
             WHERE TRIM(inventory_id) IN (${placeholders})
               AND (
                 pcs_per_box IS NOT NULL OR length_m IS NOT NULL OR height_m IS NOT NULL
                 OR width_m IS NOT NULL OR weight_kg IS NOT NULL OR cbm IS NOT NULL
               )`,
            ids
        );
        for (const r of rows) set.add(r.id);
        return set;
    },

    async inventoryIdExists(inventoryId) {
        const [[row]] = await pool.query(
            `SELECT 1 FROM \`${INVENTORY_VIEW_TABLE}\` WHERE TRIM(UPPER(inventory_id)) = TRIM(UPPER(?)) LIMIT 1`,
            [inventoryId]
        );
        return !!row;
    },

    async importItemDimensions(rows, { fillEmpty = true } = {}) {
        await this.ensureItemDimensionsTable();
        let imported = 0;
        let skipped = 0;
        const skippedIds = [];

        for (const row of rows) {
            const id = String(row.inventory_id || "").trim();
            if (!id) continue;
            if (!hasAnyDimensionValue(row)) continue;

            const exists = await this.inventoryIdExists(id);
            if (!exists) {
                skipped++;
                if (skippedIds.length < 50) skippedIds.push(id);
                continue;
            }

            if (fillEmpty) {
                const existing = await this.getItemDimensions(id);
                const merged = mergeDimensionsFillEmpty(existing, { ...row, inventory_id: id });
                await this.upsertItemDimensions(id, merged);
            } else {
                await this.upsertItemDimensions(id, row);
            }
            imported++;
        }

        return { imported, skipped, skippedIds };
    },

    /**
     * Post-sync enrichment: Fill missing item_class and posting_class in sales table
     * by joining with the inventory catalog.
     */
    async enrichSalesData() {
        const connection = await purchasePool.getConnection();
        try {
            console.log(">>> [MySQL] Starting Sales Data Enrichment...");
            
            const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
            
            // Update item_class and posting_class from inventory_items catalog where missing
            const sql = `
                UPDATE product_periodic_sales s
                JOIN \`${inventoryDb}\`.\`${INVENTORY_VIEW_TABLE}\` i ON s.inventory_id = i.inventory_id
                SET 
                    s.item_class = COALESCE(s.item_class, i.item_class),
                    s.posting_class = COALESCE(s.posting_class, i.posting_class)
                WHERE (s.item_class IS NULL OR s.posting_class IS NULL)
                AND i.default_warehouse = '__catalog__'
            `;
            const [res] = await connection.query(sql);
            console.log(`>>> [MySQL] Enrichment complete. Rows updated: ${res.affectedRows}`);
            return res.affectedRows;
        } catch (err) {
            console.error("[MySQL enrichSalesData Error]", err);
            throw err;
        } finally {
            connection.release();
        }
    },

    /**
     * Get 90-day comparative sales analysis from MySQL (3 x 30-day periods).
     * Supports SQL-level pagination — metrics are computed over the full set;
     * page rows use LIMIT/OFFSET on the sorted aggregate.
     */
    async getSalesAnalysis({ branch = "", periods = [], page = 1, pageSize = 0 } = {}) {
        const cacheKey = `salesAnalysis:${branch}:${periods.map((p) => `${p.key}:${p.start}:${p.end}`).join("|")}:p${page}:s${pageSize || "all"}`;
        return getCached(cacheKey, 300_000, () =>
            this._computeSalesAnalysis({ branch, periods, page, pageSize })
        );
    },

    async _computeSalesAnalysis({ branch = "", periods = [], page = 1, pageSize = 0 } = {}) {
        try {
            console.log(`[MySQL getSalesAnalysis] Params: branch="${branch}", periodsCount=${periods.length}, page=${page}, pageSize=${pageSize}`);
            if (periods.length === 0) return { data: [], metrics: {}, totalItems: 0 };

            if (branch && branch !== "All Branches" && isExcludedBranchAlias(branch)) {
                return { data: [], metrics: { totalRevenue: 0, totalQtySold: 0, uniqueProducts: 0 }, totalItems: 0 };
            }

            // periods = [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', key: 'P1' }, ...]
            const allDates = periods.flatMap(p => [p.start, p.end]);
            const overallStart = allDates.reduce((a, b) => a < b ? a : b);
            const overallEnd = allDates.reduce((a, b) => a > b ? a : b);

            const whereClauses = ["s.document_date >= ?", "s.document_date <= ?"];
            const params = [overallStart, overallEnd];

            const salesEx = sqlExcludeSalesBranches("branch_name", "s");
            whereClauses.push(salesEx.clause);
            params.push(...salesEx.params);

            if (branch && branch !== "All Branches") {
                whereClauses.push("TRIM(UPPER(s.branch_name)) = TRIM(UPPER(?))");
                params.push(branch);
            }

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;

            const periodCases = periods.map(p =>
                `SUM(CASE WHEN s.document_date >= '${p.start}' AND s.document_date <= '${p.end}' THEN (${SQL_NET_QTY}) ELSE 0 END) as qty_${p.key},
                 SUM(CASE WHEN s.document_date >= '${p.start}' AND s.document_date <= '${p.end}' THEN (${SQL_NET_AMOUNT}) ELSE 0 END) as sales_${p.key}`
            ).join(",\n                    ");

            const totalSalesExpr = periods
                .map((p) => `SUM(CASE WHEN s.document_date >= '${p.start}' AND s.document_date <= '${p.end}' THEN (${SQL_NET_AMOUNT}) ELSE 0 END)`)
                .join(" + ");

            // Metrics over full filtered set (cheap aggregate, no per-SKU catalog join)
            const [[metricsRow]] = await purchasePool.query(
                `SELECT
                    COUNT(*) AS uniqueProducts,
                    COALESCE(SUM(row_sales), 0) AS totalRevenue,
                    COALESCE(SUM(row_qty), 0) AS totalQtySold
                 FROM (
                    SELECT
                        (${totalSalesExpr}) AS row_sales,
                        (${periods.map((p) => `SUM(CASE WHEN s.document_date >= '${p.start}' AND s.document_date <= '${p.end}' THEN (${SQL_NET_QTY}) ELSE 0 END)`).join(" + ")}) AS row_qty
                    FROM product_periodic_sales s
                    ${wherePart}
                    GROUP BY s.inventory_id, s.branch_name
                 ) t`,
                params
            );

            const totalItems = Number(metricsRow?.uniqueProducts) || 0;
            const metrics = {
                totalRevenue: Math.max(0, Number(metricsRow?.totalRevenue) || 0),
                totalQtySold: netQtySold(metricsRow?.totalQtySold),
                uniqueProducts: totalItems,
            };

            if (totalItems === 0) {
                return { data: [], metrics, totalItems: 0 };
            }

            const limitInt = pageSize > 0 ? Math.max(1, parseInt(pageSize, 10) || 10) : 0;
            const offsetInt = limitInt > 0 ? Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * limitInt) : 0;
            const limitSql = limitInt > 0 ? `LIMIT ${limitInt} OFFSET ${offsetInt}` : "";

            const query = `SELECT 
                    s.inventory_id,
                    s.branch_name,
                    MAX(s.description) as last_description,
                    ${periodCases},
                    (${totalSalesExpr}) AS sort_sales
                 FROM product_periodic_sales s
                 ${wherePart}
                 GROUP BY s.inventory_id, s.branch_name
                 ORDER BY sort_sales DESC, s.inventory_id ASC
                 ${limitSql}`;

            const [rows] = await purchasePool.query(query, params);
            console.log(`[MySQL getSalesAnalysis] Success: page ${rows.length} of ${totalItems} rows.`);

            // Descriptions only for this page — avoid full catalog scan
            const pageIds = [...new Set(rows.map((r) => String(r.inventory_id || "").trim()).filter(Boolean))];
            let catalogMap = new Map();
            if (pageIds.length) {
                try {
                    const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
                    const ph = pageIds.map(() => "?").join(",");
                    const [catRows] = await pool.query(
                        `SELECT UPPER(TRIM(inventory_id)) AS inventory_id, MAX(inventory_name) AS description
                         FROM \`${inventoryDb}\`.\`${INVENTORY_VIEW_TABLE}\`
                         WHERE UPPER(TRIM(inventory_id)) IN (${ph})
                         GROUP BY UPPER(TRIM(inventory_id))`,
                        pageIds.map((id) => id.toUpperCase())
                    );
                    catalogMap = new Map(catRows.map((i) => [i.inventory_id, i.description]));
                } catch (catErr) {
                    console.warn("[MySQL getSalesAnalysis] catalog lookup skipped:", catErr.message);
                }
            }

            const finalData = rows.map(r => {
                const invId = (r.inventory_id || "").toUpperCase().trim();
                const description = r.last_description || catalogMap.get(invId) || "—";

                const item = {
                    inventoryId: r.inventory_id,
                    branchName: r.branch_name,
                    description: description,
                    monthlyData: {},
                    totalQty: 0,
                    totalSales: 0
                };

                periods.forEach(p => {
                    const q = netQtySold(r[`qty_${p.key}`]);
                    const s = Math.max(0, Number(r[`sales_${p.key}`]) || 0);
                    item.monthlyData[p.key] = { qty: q, sales: s };
                    item.totalQty += q;
                    item.totalSales += s;
                });

                return item;
            });

            return {
                data: finalData,
                metrics,
                totalItems,
            };
        } catch (err) {
            console.error("[MySQL getSalesAnalysis Error]", err);
            throw err;
        }
    },

    /**
     * Aggregate periodic sales for specific inventory IDs only (fast path for paginated lists).
     */
    async getPeriodicSalesSummaryForIds({ ids = [], branch = "", lookbackDays = SALES_LOOKBACK_DAYS } = {}) {
        const normalized = [...new Set(
            ids.map((id) => String(id || "").toUpperCase().trim()).filter(Boolean)
        )];
        if (!normalized.length) return new Map();

        const cacheKey = `salesIds:${lookbackDays}:${branch}:${normalized.slice().sort().join(",")}`;
        return getCached(cacheKey, 45_000, () =>
            this._queryPeriodicSalesForIds(normalized, branch, lookbackDays)
        );
    },

    async _queryPeriodicSalesForIds(normalized, branch, lookbackDays) {
        try {
            if (branch && branch !== "All Branches" && isExcludedBranchAlias(branch)) {
                return new Map();
            }

            const whereClauses = [salesLookbackSql(lookbackDays)];
            const params = [];

            const salesEx = sqlExcludeSalesBranches("branch_name");
            whereClauses.push(salesEx.clause);
            params.push(...salesEx.params);

            if (branch && branch !== "All Branches") {
                const branchNames = await this.resolveSalesBranchNames(branch);
                // Exact names from resolve (index-friendly; no TRIM/UPPER on column)
                whereClauses.push(`branch_name IN (${branchNames.map(() => "?").join(", ")})`);
                params.push(...branchNames);
            }

            const idPlaceholders = normalized.map(() => "?").join(", ");
            whereClauses.push(`UPPER(TRIM(inventory_id)) IN (${idPlaceholders})`);
            params.push(...normalized);

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;

            const [rows] = await purchasePool.query(
                `SELECT
                    UPPER(TRIM(inventory_id)) AS inventory_id,
                    SUM(${SQL_NET_QTY}) AS qty_sold,
                    SUM(${SQL_NET_AMOUNT}) AS total_sales
                 FROM product_periodic_sales
                 ${wherePart}
                 GROUP BY UPPER(TRIM(inventory_id))`,
                params
            );

            const map = new Map();
            for (const r of rows) {
                if (r.inventory_id) {
                    map.set(r.inventory_id, {
                        qty_sold: netQtySold(r.qty_sold),
                        total_sales: Math.max(0, Number(r.total_sales) || 0),
                    });
                }
            }
            return map;
        } catch (err) {
            console.error("[MySQL getPeriodicSalesSummaryForIds Error]", err);
            return new Map();
        }
    },

    /**
     * Aggregate periodic sales by inventory_id for a given branch/search filter.
     * Returns Map<inventory_id_upper, { qty_sold, total_sales }>
     * Required by Dashboard Inventory API.
     */
    async getPeriodicSalesSummary({ branch = "", search = "", lookbackDays = SALES_LOOKBACK_DAYS } = {}) {
        if (branch && branch !== "All Branches" && isExcludedBranchAlias(branch)) {
            return new Map();
        }
        if (!search) {
            const key = `salesSummary:${lookbackDays}:${String(branch || "ALL").toUpperCase()}`;
            return getCached(key, 60_000, () =>
                this._getPeriodicSalesSummaryUncached({ branch, search: "", lookbackDays })
            );
        }
        return this._getPeriodicSalesSummaryUncached({ branch, search, lookbackDays });
    },

    async _getPeriodicSalesSummaryUncached({ branch = "", search = "", lookbackDays = SALES_LOOKBACK_DAYS } = {}) {
        try {
            const whereClauses = [salesLookbackSql(lookbackDays)];
            const params = [];

            const salesEx = sqlExcludeSalesBranches("branch_name");
            whereClauses.push(salesEx.clause);
            params.push(...salesEx.params);

            if (branch && branch !== "All Branches") {
                const branchNames = await this.resolveSalesBranchNames(branch);
                whereClauses.push(`branch_name IN (${branchNames.map(() => "?").join(", ")})`);
                params.push(...branchNames);
            }
            if (search) {
                whereClauses.push("(inventory_id LIKE ? OR description LIKE ?)");
                params.push(`%${search}%`, `%${search}%`);
            }

            const wherePart = `WHERE ${whereClauses.join(" AND ")}`;

            const [rows] = await purchasePool.query(
                `SELECT
                    UPPER(TRIM(inventory_id)) AS inventory_id,
                    SUM(${SQL_NET_QTY})          AS qty_sold,
                    SUM(${SQL_NET_AMOUNT}) AS total_sales
                 FROM product_periodic_sales
                 ${wherePart}
                 GROUP BY UPPER(TRIM(inventory_id))`,
                params
            );

            const map = new Map();
            for (const r of rows) {
                if (r.inventory_id) {
                    map.set(r.inventory_id, {
                        qty_sold: netQtySold(r.qty_sold),
                        total_sales: Math.max(0, Number(r.total_sales) || 0),
                    });
                }
            }
            return map;
        } catch (err) {
            console.error("[MySQL getPeriodicSalesSummary Error]", err);
            return new Map();
        }
    },

    /**
     * Gross sales for SKUs stocked at a branch, counted across all invoice branches.
     * Retail locations (ILOILO, CEBU, etc.) often post invoices under BACOLOD/BOHOL lines.
     */
    async getBranchCatalogNetworkSalesSummary({
        branch = "",
        companyId = "main",
        lookbackDays = SALES_LOOKBACK_DAYS,
    } = {}) {
        if (!branch || isExcludedBranchAlias(branch)) {
            return { map: new Map(), mode: "gross", salesScope: "catalog-network" };
        }

        try {
            const inv = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
            const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
            const isEcomBranch = isEcomBranchAlias(branch);
            const window = parseInt(lookbackDays, 10) || SALES_LOOKBACK_DAYS;
            const whereClauses = [
                `s.document_date >= DATE_SUB(CURDATE(), INTERVAL ${window} DAY)`,
                `s.document_date <= CURDATE()`,
                `s.order_type IN ('Invoice', 'Debit Memo')`,
            ];
            const joinParams = [];
            const whereParams = [];

            const salesEx = sqlExcludeSalesBranches("s.branch_name");
            whereClauses.push(salesEx.clause);
            whereParams.push(...salesEx.params);

            let invBranchClause;
            if (isEcomBranch) {
                const ecomAliases = [...ECOM_BRANCH_ALIASES];
                invBranchClause = `UPPER(TRIM(i.branch_id)) IN (${ecomAliases.map(() => "?").join(", ")})`;
                joinParams.push(...ecomAliases);
                whereClauses.push(
                    `(i.company_id = 'ecommerce' OR (i.company_id = 'main' AND UPPER(TRIM(i.branch_id)) IN (${ecomAliases.map(() => "?").join(", ")})))`
                );
                whereParams.push(...ecomAliases);
            } else {
                invBranchClause = `UPPER(TRIM(i.branch_id)) = UPPER(TRIM(?))`;
                joinParams.push(branch);

                const branchEx = sqlExcludeBranches("i");
                whereClauses.push(branchEx.clause);
                whereParams.push(...branchEx.params);

                if (effectiveCompanyId === "main") {
                    const ecomEx = sqlExcludeEcomBranches("i");
                    whereClauses.push(ecomEx.clause);
                    whereParams.push(...ecomEx.params);

                    const ecomSalesEx = sqlExcludeEcomSalesBranches("s.branch_name");
                    whereClauses.push(ecomSalesEx.clause);
                    whereParams.push(...ecomSalesEx.params);
                } else if (effectiveCompanyId === "ecommerce") {
                    const ecomOnly = sqlOnlyEcomBranches("i");
                    whereClauses.push(ecomOnly.clause);
                    whereParams.push(...ecomOnly.params);
                }

                whereClauses.push(`i.company_id = ?`);
                whereParams.push(effectiveCompanyId);
            }

            const params = [...joinParams, ...whereParams];

            const [rows] = await purchasePool.query(
                `SELECT UPPER(TRIM(s.inventory_id)) AS inventory_id,
                        SUM(CASE WHEN s.order_type IN ('Invoice','Debit Memo') THEN ABS(s.qty) ELSE 0 END) AS qty_sold,
                        SUM(CASE WHEN s.order_type IN ('Invoice','Debit Memo') THEN ABS(s.total_amount) ELSE 0 END) AS total_sales
                 FROM product_periodic_sales s
                 INNER JOIN \`${inv}\`.\`${INVENTORY_VIEW_TABLE}\` i
                   ON UPPER(TRIM(s.inventory_id)) = UPPER(TRIM(i.inventory_id))
                  AND ${invBranchClause}
                  AND i.default_warehouse != '__catalog__'
                  AND (i.item_status IS NULL OR UPPER(TRIM(i.item_status)) = 'ACTIVE')
                 WHERE ${whereClauses.join(" AND ")}
                 GROUP BY UPPER(TRIM(s.inventory_id))
                 HAVING qty_sold > 0`,
                params
            );

            const map = new Map();
            for (const r of rows) {
                if (r.inventory_id) {
                    map.set(r.inventory_id, {
                        qty_sold: Number(r.qty_sold) || 0,
                        total_sales: Math.max(0, Number(r.total_sales) || 0),
                    });
                }
            }
            return { map, mode: "gross", salesScope: "catalog-network", lookbackDays };
        } catch (err) {
            console.error("[MySQL getBranchCatalogNetworkSalesSummary Error]", err);
            return { map: new Map(), mode: "gross", salesScope: "catalog-network" };
        }
    },

    /** Resolve sales invoice branch names that match an inventory branch/site id. */
    async resolveSalesBranchNames(branchId) {
        const key = String(branchId || "").trim();
        if (!key) return [];

        const cacheKey = `resolveSalesBranch:${key.toUpperCase()}`;
        return getCached(cacheKey, 600_000, () => this._resolveSalesBranchNamesUncached(key));
    },

    async _resolveSalesBranchNamesUncached(key) {
        const salesBranch = resolveSalesBranchForWarehouse(key) || key;
        const candidates = new Set([
            String(key || "").toUpperCase(),
            String(salesBranch || "").toUpperCase(),
        ].filter(Boolean));
        if (isEcomBranchAlias(key) || isEcomBranchAlias(salesBranch)) {
            for (const alias of ECOM_BRANCH_ALIASES) candidates.add(String(alias).toUpperCase());
        }

        try {
            // Match in JS against cached DISTINCT names — avoids repeated full-table
            // TRIM(UPPER(branch_name)) LIKE scans (often 300–900ms each).
            const allNames = await this.getSalesBranchNames();
            const names = new Set();
            for (const raw of allNames) {
                const n = String(raw || "").trim();
                if (!n) continue;
                const upper = n.toUpperCase();
                for (const candidate of candidates) {
                    if (
                        upper === candidate ||
                        upper.startsWith(`${candidate} `) ||
                        upper.startsWith(`${candidate}-`)
                    ) {
                        names.add(n);
                        break;
                    }
                }
            }
            const resolved = [...names];
            return resolved.length ? resolved : [key];
        } catch (err) {
            console.error("[MySQL resolveSalesBranchNames Error]", err);
            return [key];
        }
    },

    async getReplenishmentSalesSummary({ branch = "", lookbackDays = SALES_LOOKBACK_DAYS } = {}) {
        if (branch && branch !== "All Branches" && isExcludedBranchAlias(branch)) {
            return { map: new Map(), mode: "net" };
        }

        try {
            const netRaw = await this.getPeriodicSalesSummary({ branch, lookbackDays });
            const netMap = new Map();
            for (const [key, val] of netRaw) {
                const qty = netQtySold(val?.qty_sold);
                if (qty > 0) {
                    netMap.set(key, {
                        qty_sold: qty,
                        total_sales: Math.max(0, Number(val?.total_sales) || 0),
                        salesScope: branch ? "branch" : "network",
                    });
                }
            }

            // Only fall back to gross when the branch has no usable net sales at all
            // (e.g. credit-memo sync noise zeroing everything). Never replace a
            // per-SKU net of 0 with gross — that inflates Sells / day when returns
            // exceed invoices for that product.
            if (netMap.size > 0) {
                return { map: netMap, mode: "net" };
            }

            const grossMap = await this._queryBranchGrossSalesSummary(branch, lookbackDays);
            const map = new Map();
            for (const [key, val] of grossMap) {
                const qty = netQtySold(val?.qty_sold);
                if (qty > 0) {
                    map.set(key, {
                        qty_sold: qty,
                        total_sales: Math.max(0, Number(val?.total_sales) || 0),
                        salesScope: branch ? "branch" : "network",
                    });
                }
            }
            return { map, mode: "gross" };
        } catch (err) {
            console.error("[MySQL getReplenishmentSalesSummary Error]", err);
            return { map: new Map(), mode: "net" };
        }
    },

    async _queryBranchGrossSalesSummary(branch = "", lookbackDays = SALES_LOOKBACK_DAYS) {
        const whereClauses = [salesLookbackSql(lookbackDays)];
        const params = [];
        const salesEx = sqlExcludeSalesBranches("branch_name");
        whereClauses.push(salesEx.clause);
        params.push(...salesEx.params);

        if (branch && branch !== "All Branches") {
            const branchNames = await this.resolveSalesBranchNames(branch);
            whereClauses.push(`branch_name IN (${branchNames.map(() => "?").join(", ")})`);
            params.push(...branchNames);
        }

        const [rows] = await purchasePool.query(
            `SELECT UPPER(TRIM(inventory_id)) AS inventory_id,
                    SUM(${SQL_GROSS_QTY}) AS qty_sold,
                    SUM(CASE WHEN order_type IN ('Invoice','Debit Memo') THEN ABS(total_amount) ELSE 0 END) AS total_sales
             FROM product_periodic_sales
             WHERE ${whereClauses.join(" AND ")}
             GROUP BY UPPER(TRIM(inventory_id))
             HAVING SUM(${SQL_GROSS_QTY}) > 0`,
            params
        );

        const map = new Map();
        for (const r of rows) {
            if (r.inventory_id) {
                map.set(r.inventory_id, {
                    qty_sold: Number(r.qty_sold) || 0,
                    total_sales: Math.max(0, Number(r.total_sales) || 0),
                });
            }
        }
        return map;
    },

    /** Extended lookback gross sales when 90-day window has no invoice rows for a branch. */
    async getAccurateReplenishmentSalesMap({ branch = "", companyId = "main" } = {}) {
        const branchKey = String(branch || "MAIN").trim().toUpperCase() || "MAIN";
        const companyKey = String(companyId || "main");
        // Watermark-aware TTL: invalidate when sales/inventory sync advances last_sync
        let watermark = "0";
        try {
            const wm = await this.getReplenishmentDataWatermark();
            watermark = wm ? new Date(wm).toISOString() : "0";
        } catch { /* ignore */ }

        const cacheKey = `replSalesMap:v6:${companyKey}:${branchKey}:${watermark}`;
        return getCached(cacheKey, 300_000, () =>
            this._getAccurateReplenishmentSalesMapUncached({ branch, companyId })
        );
    },

    async _getAccurateReplenishmentSalesMapUncached({ branch = "", companyId = "main" } = {}) {
        const isMain = !branch || String(branch).trim().toUpperCase() === "MAIN";
        const branchKey = String(branch || "").trim().toUpperCase();
        const effectiveCompanyId = isMain ? companyId : resolveCompanyIdForBranch(companyId, branch);
        let lookbackDays = SALES_LOOKBACK_DAYS;

        const countPositive = (map) => {
            let n = 0;
            for (const v of map.values()) if ((v.qty_sold ?? 0) > 0) n++;
            return n;
        };

        if (isMain) {
            let result = await this.getRetailNetworkSalesSummary({ companyId, lookbackDays });
            let map = result.map;
            let count = countPositive(map);

            if (count < 20) {
                for (const days of [180, 365]) {
                    const extended = await this.getRetailNetworkSalesSummary({ companyId, lookbackDays: days });
                    const extCount = countPositive(extended.map);
                    if (extCount > count) {
                        map = extended.map;
                        lookbackDays = days;
                        count = extCount;
                        result = extended;
                    }
                    if (count >= 20) break;
                }
            }

            return {
                map,
                salesScope: "network",
                lookbackDays,
                salesMode: result.mode || "net",
            };
        }

        // Stock warehouses (e.g. MNL-MRILAO): use sales posted to THIS site only.
        // Do NOT copy full parent POS (MANILA) velocity — that inflates Sells/day
        // against warehouse-only on-hand. Plan Manila metro demand from MANILA branch
        // (which aggregates related warehouse stock).
        if (isWarehouseLikeAlias(branchKey) && !isRetailReplenishmentBranch(branchKey)) {
            let strict = await this.getReplenishmentSalesSummary({ branch: branchKey, lookbackDays });
            let count = countPositive(strict.map);
            let salesMode = strict.mode;

            if (count < 20) {
                for (const days of [180, 365]) {
                    const extStrict = await this.getReplenishmentSalesSummary({
                        branch: branchKey,
                        lookbackDays: days,
                    });
                    const extCount = countPositive(extStrict.map);
                    if (extCount > count) {
                        strict = extStrict;
                        lookbackDays = days;
                        count = extCount;
                        salesMode = extStrict.mode;
                    }
                    if (count >= 20) break;
                }
            }

            const map = new Map();
            for (const [key, val] of strict.map) {
                map.set(key, {
                    qty_sold: netQtySold(val?.qty_sold),
                    total_sales: Math.max(0, Number(val?.total_sales) || 0),
                    salesScope: "warehouse",
                });
            }
            return { map, salesScope: "warehouse", lookbackDays, salesMode };
        }

        // Retail branches: Acumatica branch invoices only — never catalog-network
        // (company-wide) fallback. That invents Sells/day for SKUs with 0 local stock.
        let strict = await this.getReplenishmentSalesSummary({ branch, lookbackDays });
        let map = new Map();
        for (const [key, val] of strict.map) {
            map.set(key, {
                qty_sold: netQtySold(val?.qty_sold),
                total_sales: Math.max(0, Number(val?.total_sales) || 0),
                salesScope: "branch",
            });
        }
        let count = countPositive(map);
        let salesMode = strict.mode;
        let salesScope = "branch";

        if (count < 20) {
            for (const days of [180, 365]) {
                const extStrict = await this.getReplenishmentSalesSummary({ branch, lookbackDays: days });
                const extMap = new Map();
                for (const [key, val] of extStrict.map) {
                    extMap.set(key, {
                        qty_sold: netQtySold(val?.qty_sold),
                        total_sales: Math.max(0, Number(val?.total_sales) || 0),
                        salesScope: "branch",
                    });
                }
                const extCount = countPositive(extMap);
                if (extCount > count) {
                    map = extMap;
                    lookbackDays = days;
                    count = extCount;
                    salesMode = extStrict.mode;
                }
                if (count >= 20) break;
            }
        }

        return { map, salesScope, lookbackDays, salesMode };
    },

    /** Inventory IDs with any sales document at this branch in the lookback window. */
    async getBranchSalesDocumentIds(branch = "", lookbackDays = SALES_LOOKBACK_DAYS) {
        if (!branch || branch === "All Branches" || isExcludedBranchAlias(branch)) {
            return new Set();
        }
        try {
            const whereClauses = [salesLookbackSql(lookbackDays)];
            const params = [];
            const salesEx = sqlExcludeSalesBranches("branch_name");
            whereClauses.push(salesEx.clause);
            params.push(...salesEx.params);
            const branchNames = await this.resolveSalesBranchNames(branch);
            whereClauses.push(`branch_name IN (${branchNames.map(() => "?").join(", ")})`);
            params.push(...branchNames);

            const [rows] = await purchasePool.query(
                `SELECT DISTINCT UPPER(TRIM(inventory_id)) AS inventory_id
                 FROM product_periodic_sales
                 WHERE ${whereClauses.join(" AND ")}
                   AND order_type IN ('Invoice', 'Debit Memo', 'Credit Memo')`,
                params
            );
            return new Set(rows.map((r) => r.inventory_id).filter(Boolean));
        } catch (err) {
            console.error("[MySQL getBranchSalesDocumentIds Error]", err);
            return new Set();
        }
    },

    /** Network-wide sales for retail invoice branches (MAIN warehouse demand). Net first, gross fallback. */
    async getRetailNetworkSalesSummary({ companyId = "main", lookbackDays = SALES_LOOKBACK_DAYS } = {}) {
        try {
            const whereClauses = [salesLookbackSql(lookbackDays)];
            const params = [];

            const salesEx = sqlExcludeSalesBranches("branch_name");
            whereClauses.push(salesEx.clause);
            params.push(...salesEx.params);

            if (companyId === "main") {
                const ecomEx = sqlExcludeEcomSalesBranches("branch_name");
                whereClauses.push(ecomEx.clause);
                params.push(...ecomEx.params);
            }

            const wherePart = whereClauses.join(" AND ");

            const [netRows] = await purchasePool.query(
                `SELECT UPPER(TRIM(inventory_id)) AS inventory_id,
                        SUM(${SQL_NET_QTY}) AS qty_sold,
                        SUM(${SQL_NET_AMOUNT}) AS total_sales
                 FROM product_periodic_sales
                 WHERE ${wherePart}
                 GROUP BY UPPER(TRIM(inventory_id))`,
                params
            );

            const netMap = new Map();
            for (const r of netRows) {
                const qty = netQtySold(r.qty_sold);
                if (qty > 0 && r.inventory_id) {
                    netMap.set(r.inventory_id, {
                        qty_sold: qty,
                        total_sales: Math.max(0, Number(r.total_sales) || 0),
                        salesScope: "network",
                    });
                }
            }
            if (netMap.size > 0) {
                return { map: netMap, mode: "net", lookbackDays };
            }

            const [rows] = await purchasePool.query(
                `SELECT UPPER(TRIM(inventory_id)) AS inventory_id,
                        SUM(${SQL_GROSS_QTY}) AS qty_sold,
                        SUM(CASE WHEN order_type IN ('Invoice','Debit Memo') THEN ABS(total_amount) ELSE 0 END) AS total_sales
                 FROM product_periodic_sales
                 WHERE ${wherePart}
                   AND order_type IN ('Invoice', 'Debit Memo')
                 GROUP BY UPPER(TRIM(inventory_id))
                 HAVING SUM(${SQL_GROSS_QTY}) > 0`,
                params
            );

            const map = new Map();
            for (const r of rows) {
                if (r.inventory_id) {
                    map.set(r.inventory_id, {
                        qty_sold: Number(r.qty_sold) || 0,
                        total_sales: Math.max(0, Number(r.total_sales) || 0),
                        salesScope: "network",
                    });
                }
            }
            return { map, mode: "gross", lookbackDays };
        } catch (err) {
            console.error("[MySQL getRetailNetworkSalesSummary Error]", err);
            return { map: new Map(), mode: "net", lookbackDays };
        }
    },

    async getReplenishmentSalesSummaryExtended({ branch = "", companyId = "main", branchStrict = false } = {}) {
        let result = await this.getReplenishmentSalesSummary({ branch, lookbackDays: SALES_LOOKBACK_DAYS });
        let count = 0;
        for (const v of result.map.values()) if ((v.qty_sold ?? 0) > 0) count++;

        if (count < 20) {
            for (const days of [180, 365]) {
                const extended = await this.getReplenishmentSalesSummary({ branch, lookbackDays: days });
                let extCount = 0;
                for (const v of extended.map.values()) if ((v.qty_sold ?? 0) > 0) extCount++;
                if (extCount > count) {
                    result = { ...extended, lookbackDays: days };
                    count = extCount;
                }
            }
        }

        const isMain = !branch || String(branch).trim().toUpperCase() === "MAIN";
        if (!isMain && !branchStrict && count < 20) {
            const catalog = await this.getBranchCatalogNetworkSalesSummary({ branch, companyId });
            let catCount = 0;
            for (const v of catalog.map.values()) if ((v.qty_sold ?? 0) > 0) catCount++;
            if (catCount > count) {
                return catalog;
            }
        }

        return {
            ...result,
            salesScope: isMain ? "network" : "branch",
            lookbackDays: result.lookbackDays || SALES_LOOKBACK_DAYS,
        };
    },

    async ensureReplenishmentCacheTable() {
        return getCached("replenishment:table-ready:v2", 3_600_000, async () => {
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS replenishment_cache (
                    company_id VARCHAR(50) NOT NULL DEFAULT 'main',
                    branch_id VARCHAR(100) NOT NULL,
                    inventory_id VARCHAR(100) NOT NULL,
                    description VARCHAR(500) NULL,
                    item_class VARCHAR(100) NULL,
                    current_stock DECIMAL(18,4) DEFAULT 0,
                    qty_sold_90 DECIMAL(18,4) DEFAULT 0,
                    sales_velocity DECIMAL(18,6) DEFAULT 0,
                    days_remaining INT DEFAULT 0,
                    suggested_qty DECIMAL(18,4) DEFAULT 0,
                    priority_level VARCHAR(20) NOT NULL DEFAULT 'Low',
                    lead_time_days INT DEFAULT 0,
                    vendor_id VARCHAR(100) NULL,
                    branch_order_qty DECIMAL(18,4) DEFAULT 0,
                    main_inventory DECIMAL(18,4) DEFAULT 0,
                    coming_po DECIMAL(18,4) DEFAULT 0,
                    total_branch_replenishment DECIMAL(18,4) DEFAULT 0,
                    sales_scope VARCHAR(50) NULL,
                    restock_source VARCHAR(255) NULL,
                    what_to_do TEXT NULL,
                    ai_preview TEXT NULL,
                    ai_insights_json JSON NULL,
                    is_main_warehouse_view TINYINT(1) NOT NULL DEFAULT 0,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (company_id, branch_id, inventory_id),
                    KEY idx_repl_branch_priority (company_id, branch_id, priority_level),
                    KEY idx_repl_updated (updated_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try {
                await purchasePool.query(
                    `ALTER TABLE replenishment_cache ADD COLUMN item_class VARCHAR(100) NULL AFTER description`
                );
            } catch (alterErr) {
                // Column already exists on upgraded DBs
                if (alterErr?.code !== "ER_DUP_FIELDNAME") throw alterErr;
            }
            return true;
        } catch (err) {
            console.error("[MySQL ensureReplenishmentCacheTable Error]", err);
            return false;
        }
        });
    },

    /**
     * Accurate MAIN Total Branch Repl / Branch Order Qty.
     *
     * Uses a few bulk SQL queries (sales + stock) plus light Coming-PO lookups —
     * not stale replenishment_cache.sales_velocity (often catalog-network inflated)
     * and not N full getAccurateReplenishmentSalesMap calls (ECONNRESET).
     *
     * Demand uses each retail branch's own net invoice sales only (no catalog-network
     * fallback), matching the MAIN column help text.
     */
    async getAccurateRetailBranchDemandRollup(companyId = "main") {
        let watermark = "0";
        try {
            const wm = await this.getReplenishmentDataWatermark();
            watermark = wm ? new Date(wm).toISOString() : "0";
        } catch { /* ignore */ }

        const cacheKey = `accurateRetailDemand:v5:${companyId}:${watermark}`;
        return getCached(cacheKey, 120_000, async () => {
            const [live, cached, suggestedTotals] = await Promise.all([
                this._getAccurateRetailBranchDemandRollupUncached(companyId),
                this.getRetailBranchDemandRollupFromCache(companyId),
                this.getBranchSuggestedQtyTotals(companyId),
            ]);
            return this._mergeRetailDemandRollups([
                live,
                cached,
                {
                    qtyByItem: suggestedTotals,
                    salesByItem: new Map(),
                    branchesNeedingByItem: new Map(),
                    lookbackDays: live?.lookbackDays || SALES_LOOKBACK_DAYS,
                    source: "branch-suggested-sum",
                },
            ]);
        });
    },

    /** Sum branch suggested_qty per SKU (retail branches only) — floor when live rollup misses rows. */
    async getBranchSuggestedQtyTotals(companyId = "main") {
        await this.ensureReplenishmentCacheTable();
        const map = new Map();
        try {
            const [rows] = await purchasePool.query(
                `SELECT UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inventoryId,
                        branch_id AS branchId,
                        COALESCE(suggested_qty, 0) AS suggestedQty
                 FROM replenishment_cache
                 WHERE company_id = ?
                   AND UPPER(TRIM(branch_id)) != 'MAIN'
                   AND COALESCE(suggested_qty, 0) > 0`,
                [companyId]
            );
            for (const r of rows) {
                const branchId = String(r.branchId || "").trim();
                if (!branchId || !isRetailReplenishmentBranch(branchId)) continue;
                const inv = normalizeInvKey(r.inventoryId) || String(r.inventoryId || "").trim();
                if (!inv) continue;
                const n = Number(r.suggestedQty) || 0;
                if (n <= 0) continue;
                map.set(inv, (map.get(inv) || 0) + n);
            }
        } catch (err) {
            console.error("[MySQL getBranchSuggestedQtyTotals Error]", err);
        }
        return map;
    },

    _mergeRetailDemandRollups(rollups = []) {
        const qtyByItem = new Map();
        const salesByItem = new Map();
        const branchesNeedingByItem = new Map();
        let lookbackDays = SALES_LOOKBACK_DAYS;
        const sources = [];

        for (const rollup of rollups) {
            if (!rollup) continue;
            if (rollup.lookbackDays) lookbackDays = rollup.lookbackDays;
            if (rollup.source) sources.push(rollup.source);

            for (const [rawKey, rawVal] of rollup.qtyByItem || []) {
                const key = normalizeInvKey(rawKey) || String(rawKey || "").trim();
                if (!key) continue;
                const n = Number(rawVal) || 0;
                if (n > (qtyByItem.get(key) || 0)) qtyByItem.set(key, n);
            }

            for (const [rawKey, rawVal] of rollup.salesByItem || []) {
                const key = normalizeInvKey(rawKey) || String(rawKey || "").trim();
                if (!key || !rawVal) continue;
                const prev = salesByItem.get(key);
                const ads = Number(rawVal.ads) || 0;
                if (!prev || ads > (Number(prev.ads) || 0)) {
                    salesByItem.set(key, { ...rawVal });
                }
            }

            for (const [rawKey, rawVal] of rollup.branchesNeedingByItem || []) {
                const key = normalizeInvKey(rawKey) || String(rawKey || "").trim();
                if (!key) continue;
                const n = Number(rawVal) || 0;
                if (n > (branchesNeedingByItem.get(key) || 0)) {
                    branchesNeedingByItem.set(key, n);
                }
            }
        }

        return {
            qtyByItem,
            salesByItem,
            branchesNeedingByItem,
            lookbackDays,
            source: sources.length ? sources.join("+") : "empty",
        };
    },

    async _getAccurateRetailBranchDemandRollupUncached(companyId = "main") {
        const qtyByItem = new Map();
        const salesByItem = new Map();
        const branchesNeedingByItem = new Map();
        const lookbackDays = SALES_LOOKBACK_DAYS;

        try {
            const branchList = await this.getReplenishmentBranches(companyId);
            const retailBranches = [...new Set(
                (branchList || [])
                    .map((b) => String(b.SiteID || b.branch_id || "").trim())
                    .filter((id) => id && id.toUpperCase() !== "MAIN" && isRetailReplenishmentBranch(id))
            )];

            if (!retailBranches.length) {
                console.warn("[MySQL accurateRetailDemand] no retail branches for", companyId);
                return { qtyByItem, salesByItem, branchesNeedingByItem, lookbackDays, source: "empty-branches" };
            }

            const salesNameToSite = new Map();
            const whToSite = new Map();
            await Promise.all(
                retailBranches.map(async (site) => {
                    const siteKey = String(site).trim().toUpperCase();
                    const names = await this.resolveSalesBranchNames(site);
                    for (const n of names) {
                        const u = String(n || "").trim().toUpperCase();
                        if (!u || u === "MAIN") continue;
                        if (!salesNameToSite.has(u) || u === siteKey) {
                            salesNameToSite.set(u, siteKey);
                        }
                    }
                    salesNameToSite.set(siteKey, siteKey);
                    for (const wh of getStockWarehouseIdsForBranch(site)) {
                        whToSite.set(String(wh).trim().toUpperCase(), siteKey);
                    }
                })
            );

            const allWh = [...new Set(
                retailBranches.flatMap((b) => getStockWarehouseIdsForBranch(b))
            )];

            const salesEx = sqlExcludeSalesBranches("branch_name");
            const salesWhere = [salesLookbackSql(lookbackDays), salesEx.clause];
            const salesParams = [...salesEx.params];
            if (String(companyId).toLowerCase() !== "ecommerce") {
                const ecomSalesEx = sqlExcludeEcomSalesBranches("branch_name");
                salesWhere.push(ecomSalesEx.clause);
                salesParams.push(...ecomSalesEx.params);
            }

            const salesBySite = new Map();
            for (const site of retailBranches) salesBySite.set(site.toUpperCase(), new Map());

            const [salesRows] = await purchasePool.query(
                `SELECT UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inv,
                        UPPER(TRIM(branch_name)) AS branch,
                        SUM(${SQL_NET_QTY}) AS qty_sold,
                        SUM(CASE WHEN order_type IN ('Invoice','Debit Memo') THEN ABS(total_amount) ELSE 0 END) AS total_sales
                 FROM product_periodic_sales
                 WHERE ${salesWhere.join(" AND ")}
                 GROUP BY UPPER(REPLACE(TRIM(inventory_id), ' ', '')), UPPER(TRIM(branch_name))
                 HAVING SUM(${SQL_NET_QTY}) > 0`,
                salesParams
            );

            for (const r of salesRows) {
                const site = salesNameToSite.get(String(r.branch || "").trim().toUpperCase());
                if (!site) continue;
                const inv = normalizeInvKey(r.inv) || String(r.inv || "").trim();
                if (!inv) continue;
                const qty = netQtySold(r.qty_sold);
                if (qty <= 0) continue;
                const m = salesBySite.get(site);
                if (!m) continue;
                const prev = m.get(inv) || { qty_sold: 0, total_sales: 0 };
                m.set(inv, {
                    qty_sold: prev.qty_sold + qty,
                    total_sales: prev.total_sales + Math.max(0, Number(r.total_sales) || 0),
                });
            }

            const stockBySite = await this._retailBranchLiveStockBySite(companyId, retailBranches);

            const cacheSuggestedBySite = new Map();
            try {
                const [cacheSuggestedRows] = await purchasePool.query(
                    `SELECT UPPER(TRIM(branch_id)) AS branchId,
                            UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inventoryId,
                            COALESCE(suggested_qty, 0) AS suggestedQty
                     FROM replenishment_cache
                     WHERE company_id = ?
                       AND UPPER(TRIM(branch_id)) != 'MAIN'
                       AND COALESCE(suggested_qty, 0) > 0`,
                    [companyId]
                );
                for (const r of cacheSuggestedRows) {
                    const siteKey = String(r.branchId || "").trim().toUpperCase();
                    const inv = normalizeInvKey(r.inventoryId) || String(r.inventoryId || "").trim();
                    if (!siteKey || !inv || !isRetailReplenishmentBranch(siteKey)) continue;
                    if (!cacheSuggestedBySite.has(siteKey)) {
                        cacheSuggestedBySite.set(siteKey, new Map());
                    }
                    const m = cacheSuggestedBySite.get(siteKey);
                    const n = Number(r.suggestedQty) || 0;
                    if (n > (m.get(inv) || 0)) m.set(inv, n);
                }
            } catch (err) {
                console.warn("[MySQL accurateRetailDemand] cache suggested floor skipped:", err?.message);
            }

            for (const site of retailBranches) {
                const siteKey = String(site).trim().toUpperCase();
                const salesMap = salesBySite.get(siteKey) || new Map();
                const stockMap = stockBySite.get(siteKey) || new Map();
                const keys = new Set([
                    ...salesMap.keys(),
                    ...stockMap.keys(),
                    ...(cacheSuggestedBySite.get(siteKey)?.keys() || []),
                ]);

                for (const inventoryId of keys) {
                    const sales = salesMap.get(inventoryId);
                    const qtySold = netQtySold(sales?.qty_sold);
                    const ads = qtySold > 0 ? qtySold / lookbackDays : 0;
                    const stock = Number(stockMap.get(inventoryId)) || 0;
                    // a + b = c; need = max(0, d − c). Coming PO not in this rollup path
                    // (stock-only sites); live overlay applies Coming PO per branch.
                    const suggested = ads > 0 ? Math.max(0, ads - stock) : 0;
                    const cachedSuggested = Number(cacheSuggestedBySite.get(siteKey)?.get(inventoryId)) || 0;
                    const branchNeed = Math.max(suggested, cachedSuggested > 0 ? cachedSuggested : 0);

                    if (qtySold > 0 || ads > 0) {
                        const prev = salesByItem.get(inventoryId) || {
                            qty_sold: 0,
                            total_sales: 0,
                            salesScope: "network",
                            ads: 0,
                        };
                        salesByItem.set(inventoryId, {
                            ...prev,
                            qty_sold: (Number(prev.qty_sold) || 0) + qtySold,
                            ads: (Number(prev.ads) || 0) + ads,
                            total_sales:
                                (Number(prev.total_sales) || 0) +
                                Math.max(0, Number(sales?.total_sales) || 0),
                            salesScope: "network",
                        });
                    }

                    if (branchNeed > 0) {
                        qtyByItem.set(
                            inventoryId,
                            (qtyByItem.get(inventoryId) || 0) + branchNeed
                        );
                        branchesNeedingByItem.set(
                            inventoryId,
                            (branchesNeedingByItem.get(inventoryId) || 0) + 1
                        );
                    }
                }
            }

            return {
                qtyByItem,
                salesByItem,
                branchesNeedingByItem,
                lookbackDays,
                source: "live",
                retailBranchCount: retailBranches.length,
            };
        } catch (err) {
            console.error("[MySQL getAccurateRetailBranchDemandRollup Error]", err);
            return { qtyByItem, salesByItem, branchesNeedingByItem, lookbackDays, source: "error" };
        }
    },

    /**
     * Fast MAIN page-load rollup: retail branches only, one SQL read from cache.
     * Recomputes need from cached ads + live on-hand (not stale cache stock).
     * Also floors each SKU total with the sum of branch suggested_qty in cache.
     */
    async getRetailBranchDemandRollupFromCache(companyId = "main") {
        await this.ensureReplenishmentCacheTable();
        const qtyByItem = new Map();
        const salesByItem = new Map();
        const branchesNeedingByItem = new Map();

        try {
            const [rows] = await purchasePool.query(
                `SELECT branch_id AS branchId,
                        UPPER(REPLACE(TRIM(inventory_id), ' ', '')) AS inventoryId,
                        COALESCE(sales_velocity, 0) AS ads,
                        COALESCE(qty_sold_90, 0) AS qtySold,
                        COALESCE(current_stock, 0) AS stock,
                        COALESCE(suggested_qty, 0) AS suggestedQty
                 FROM replenishment_cache
                 WHERE company_id = ?
                   AND UPPER(TRIM(branch_id)) != 'MAIN'`,
                [companyId]
            );

            const branchList = await this.getReplenishmentBranches(companyId);
            const retailBranches = [...new Set(
                [
                    ...(branchList || [])
                        .map((b) => String(b.SiteID || b.branch_id || "").trim())
                        .filter((id) => id && isRetailReplenishmentBranch(id)),
                    ...rows
                        .map((r) => String(r.branchId || "").trim())
                        .filter((id) => id && isRetailReplenishmentBranch(id)),
                ].map((id) => id.toUpperCase())
            )];

            const stockBySite = await this._retailBranchLiveStockBySite(companyId, retailBranches);

            for (const r of rows) {
                const branchId = String(r.branchId || "").trim();
                const inventoryId = normalizeInvKey(r.inventoryId) || String(r.inventoryId || "").trim();
                if (!branchId || !inventoryId) continue;
                if (!isRetailReplenishmentBranch(branchId)) continue;

                const siteKey = branchId.toUpperCase();
                const ads = Number(r.ads) || 0;
                const qtySold = Number(r.qtySold) || 0;
                const cachedStock = Number(r.stock) || 0;
                const liveStock = Number(stockBySite.get(siteKey)?.get(inventoryId)) ?? cachedStock;
                // a + b = c; need = max(0, d − a). Coming PO applied on live overlay / live rollup.
                const suggested = ads > 0 ? Math.max(0, ads - liveStock) : 0;
                const branchNeed = suggested;

                if (qtySold > 0 || ads > 0) {
                    const prev = salesByItem.get(inventoryId) || {
                        qty_sold: 0,
                        total_sales: 0,
                        salesScope: "network",
                        ads: 0,
                    };
                    salesByItem.set(inventoryId, {
                        ...prev,
                        qty_sold: (Number(prev.qty_sold) || 0) + qtySold,
                        ads: (Number(prev.ads) || 0) + ads,
                        salesScope: "network",
                    });
                }

                if (branchNeed > 0) {
                    qtyByItem.set(inventoryId, (qtyByItem.get(inventoryId) || 0) + branchNeed);
                    branchesNeedingByItem.set(
                        inventoryId,
                        (branchesNeedingByItem.get(inventoryId) || 0) + 1
                    );
                }
            }

            return { qtyByItem, salesByItem, branchesNeedingByItem };
        } catch (err) {
            console.error("[MySQL getRetailBranchDemandRollupFromCache Error]", err);
            return { qtyByItem, salesByItem, branchesNeedingByItem };
        }
    },

    /** Live on-hand by retail site (BACOLOD, ILOILO, …) from forecast_item_stock. */
    async _retailBranchLiveStockBySite(companyId = "main", retailBranches = []) {
        const stockBySite = new Map();
        for (const site of retailBranches) {
            stockBySite.set(String(site).trim().toUpperCase(), new Map());
        }
        if (!retailBranches.length) return stockBySite;

        const whToSite = new Map();
        const allWh = [];
        for (const site of retailBranches) {
            const siteKey = String(site).trim().toUpperCase();
            for (const wh of getStockWarehouseIdsForBranch(site)) {
                const whKey = String(wh).trim().toUpperCase();
                whToSite.set(whKey, siteKey);
                allWh.push(whKey);
            }
        }
        const uniqueWh = [...new Set(allWh)];
        if (!uniqueWh.length) return stockBySite;

        try {
            const src = await this._forecastStockSource();
            const whCol = src.warehouseCol;
            const ph = uniqueWh.map(() => "?").join(", ");
            const damageEx = sqlExcludeForecastDamage("f", whCol);
            const ecomEx = sqlExcludeEcomBranches("f");
            const [stockRows] = await purchasePool.query(
                `SELECT UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) AS inv,
                        UPPER(TRIM(COALESCE(f.${whCol},''))) AS wh,
                        COALESCE(SUM(GREATEST(0, COALESCE(f.available, f.on_hand, 0))), 0) AS onHand
                 FROM ${src.qualified} f
                 WHERE f.company_id = ?
                   AND f.${whCol} != '__catalog__'
                   AND UPPER(TRIM(COALESCE(f.${whCol},''))) IN (${ph})
                   AND ${damageEx.clause}
                   AND ${ecomEx.clause}
                 GROUP BY UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')),
                          UPPER(TRIM(COALESCE(f.${whCol},'')))`,
                [companyId, ...uniqueWh, ...damageEx.params, ...ecomEx.params]
            );

            for (const r of stockRows) {
                const site = whToSite.get(String(r.wh || "").trim().toUpperCase());
                if (!site) continue;
                const inv = normalizeInvKey(r.inv) || String(r.inv || "").trim();
                if (!inv) continue;
                const m = stockBySite.get(site);
                if (!m) continue;
                m.set(inv, (m.get(inv) || 0) + (Number(r.onHand) || 0));
            }
        } catch (err) {
            console.error("[MySQL _retailBranchLiveStockBySite Error]", err);
        }

        return stockBySite;
    },

    async getLiveBranchDemandByItem(companyId = "main") {
        let watermark = "0";
        try {
            const wm = await this.getReplenishmentDataWatermark();
            watermark = wm ? new Date(wm).toISOString() : "0";
        } catch { /* ignore */ }

        const cacheKey = `liveBranchDemand:v6:${companyId}:${watermark}`;
        return getCached(cacheKey, 60_000, () =>
            this._getLiveBranchDemandByItemUncached(companyId)
        );
    },

    /**
     * Live Total Branch Replenishment for MAIN.
     *
     * IMPORTANT: Do NOT trust cached sales_velocity — stale branch caches often
     * still hold catalog-network rates (~full company velocity per branch), which
     * multiplies Total Branch Repl when summed.
     *
     * For each retail branch: live sales map + live on-hand →
     * suggested = max(0, ceil(ads × 60) − stock), then sum.
     * Coming PO is not subtracted (shown separately; must not hide shelf gap).
     */
    async _getLiveBranchDemandByItemUncached(companyId = "main") {
        const qtyByItem = new Map();
        const salesByItem = new Map();
        const branchesNeedingByItem = new Map();

        try {
            const branchList = await this.getReplenishmentBranches(companyId);
            const retailBranches = [...new Set(
                (branchList || [])
                    .map((b) => String(b.SiteID || b.branch_id || "").trim())
                    .filter((id) => id && id.toUpperCase() !== "MAIN" && isRetailReplenishmentBranch(id))
            )];

            if (!retailBranches.length) {
                return { qtyByItem, salesByItem, branchesNeedingByItem };
            }

            const CONCURRENCY = 1;
            for (let i = 0; i < retailBranches.length; i += CONCURRENCY) {
                const batch = retailBranches.slice(i, i + CONCURRENCY);
                await Promise.all(
                    batch.map(async (branchId) => {
                        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branchId);
                        try {
                            const [salesBundle, onHandMap, comingPoMap] = await Promise.all([
                                this.getAccurateReplenishmentSalesMap({
                                    branch: branchId,
                                    companyId: effectiveCompanyId,
                                }),
                                this.getBranchOnHandMap({ branch: branchId, companyId: effectiveCompanyId }),
                                this.getOpenPoQtyByItem({ warehouseId: branchId }),
                            ]);

                            const lookbackDays = Number(salesBundle.lookbackDays) || SALES_LOOKBACK_DAYS;
                            const salesMap = salesBundle.map || new Map();
                            const keys = new Set([
                                ...salesMap.keys(),
                                ...onHandMap.keys(),
                                ...comingPoMap.keys(),
                            ]);

                            for (const inventoryId of keys) {
                                const sales = salesMap.get(inventoryId);
                                const qtySold = netQtySold(sales?.qty_sold);
                                const ads = qtySold > 0 ? qtySold / lookbackDays : 0;
                                const stock = Number(onHandMap.get(inventoryId)) || 0;
                                const comingPo = Number(comingPoMap.get(inventoryId)) || 0;
                                // a + b = c; branch need = max(0, d − c)
                                const suggested = ads > 0 ? Math.max(0, ads - (stock + comingPo)) : 0;

                                if (qtySold > 0 || ads > 0) {
                                    const prevSales = salesByItem.get(inventoryId) || {
                                        qty_sold: 0,
                                        total_sales: 0,
                                        salesScope: "network",
                                        ads: 0,
                                    };
                                    salesByItem.set(inventoryId, {
                                        ...prevSales,
                                        qty_sold: (Number(prevSales.qty_sold) || 0) + qtySold,
                                        ads: (Number(prevSales.ads) || 0) + ads,
                                        total_sales:
                                            (Number(prevSales.total_sales) || 0) +
                                            Math.max(0, Number(sales?.total_sales) || 0),
                                        salesScope: "network",
                                    });
                                }

                                if (suggested > 0) {
                                    qtyByItem.set(
                                        inventoryId,
                                        (qtyByItem.get(inventoryId) || 0) + suggested
                                    );
                                    branchesNeedingByItem.set(
                                        inventoryId,
                                        (branchesNeedingByItem.get(inventoryId) || 0) + 1
                                    );
                                }
                            }
                        } catch (err) {
                            console.error(
                                `[MySQL getLiveBranchDemandByItem] branch ${branchId}:`,
                                err.message
                            );
                        }
                    })
                );
            }

            return { qtyByItem, salesByItem, branchesNeedingByItem };
        } catch (err) {
            console.error("[MySQL getLiveBranchDemandByItem Error]", err);
            return { qtyByItem, salesByItem, branchesNeedingByItem };
        }
    },

    /** Fast SQL rollup of branch demand for MAIN warehouse planning (stale — prefer getLiveBranchDemandByItem). */
    async getBranchOrderQtyFromCache(companyId = "main") {
        await this.ensureReplenishmentCacheTable();
        try {
            const [rows] = await purchasePool.query(
                `SELECT UPPER(TRIM(inventory_id)) AS inventoryId,
                        SUM(COALESCE(suggested_qty, 0)) AS qty
                 FROM replenishment_cache
                 WHERE company_id = ?
                   AND UPPER(TRIM(branch_id)) != 'MAIN'
                   AND COALESCE(suggested_qty, 0) > 0
                 GROUP BY UPPER(TRIM(inventory_id))`,
                [companyId]
            );
            const map = new Map();
            for (const r of rows) {
                const key = String(r.inventoryId || "").trim();
                if (key) map.set(key, Number(r.qty) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL getBranchOrderQtyFromCache Error]", err);
            return new Map();
        }
    },

    /**
     * Sum retail-branch sales qty / velocity for MAIN Sells / day.
     * Matches the same branches that feed Total Branch Replenishment (excludes MAIN itself).
     */
    async getBranchSalesRollupFromCache(companyId = "main") {
        await this.ensureReplenishmentCacheTable();
        try {
            const [rows] = await purchasePool.query(
                `SELECT UPPER(TRIM(inventory_id)) AS inventoryId,
                        SUM(GREATEST(0, COALESCE(qty_sold_90, 0))) AS qtySold,
                        SUM(GREATEST(0, COALESCE(sales_velocity, 0))) AS ads
                 FROM replenishment_cache
                 WHERE company_id = ?
                   AND UPPER(TRIM(branch_id)) != 'MAIN'
                 GROUP BY UPPER(TRIM(inventory_id))
                 HAVING SUM(GREATEST(0, COALESCE(qty_sold_90, 0))) > 0
                     OR SUM(GREATEST(0, COALESCE(sales_velocity, 0))) > 0`,
                [companyId]
            );
            const map = new Map();
            for (const r of rows) {
                const key = String(r.inventoryId || "").trim();
                if (!key) continue;
                const ads = Number(r.ads) || 0;
                const qtySold = Number(r.qtySold) || 0;
                // Prefer summed qty; if only velocity was stored, reconstruct period qty at 90 days
                const qty = qtySold > 0 ? qtySold : ads * SALES_LOOKBACK_DAYS;
                if (qty > 0) {
                    map.set(key, {
                        qty_sold: qty,
                        total_sales: 0,
                        salesScope: "network",
                        ads,
                    });
                }
            }
            return map;
        } catch (err) {
            console.error("[MySQL getBranchSalesRollupFromCache Error]", err);
            return new Map();
        }
    },

    async getCachedReplenishmentBranchIds(companyId = "main") {
        await this.ensureReplenishmentCacheTable();
        try {
            const [rows] = await purchasePool.query(
                `SELECT DISTINCT branch_id AS branchId
                 FROM replenishment_cache
                 WHERE company_id = ? AND UPPER(TRIM(branch_id)) != 'MAIN'`,
                [companyId]
            );
            return new Set(rows.map((r) => String(r.branchId || "").trim()).filter(Boolean));
        } catch (err) {
            console.error("[MySQL getCachedReplenishmentBranchIds Error]", err);
            return new Set();
        }
    },

    /**
     * Retail branches whose cached sales velocity predates the branch-first sales fix.
     * MAIN rollup must not sum stale inflated branch Sells / day values.
     */
    async getStaleSalesLogicBranchIds(companyId = "main", minVersion = 3) {
        await this.ensureReplenishmentCacheTable();
        try {
            const [rows] = await purchasePool.query(
                `SELECT branch_id AS branchId,
                        MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(ai_insights_json, '$.salesLogicVersion')) AS UNSIGNED)) AS ver
                 FROM replenishment_cache
                 WHERE company_id = ?
                   AND UPPER(TRIM(branch_id)) != 'MAIN'
                 GROUP BY branch_id
                 HAVING ver IS NULL OR ver < ?`,
                [companyId, minVersion]
            );
            return new Set(rows.map((r) => String(r.branchId || "").trim()).filter(Boolean));
        } catch (err) {
            console.error("[MySQL getStaleSalesLogicBranchIds Error]", err);
            return new Set();
        }
    },

    recommendationToCacheRow(companyId, branchId, rec) {
        const ai = {
            ...(rec.aiInsights || {}),
            lookbackDays: rec.lookbackDays,
            qtySold90: rec.qtySold90,
            salesScope: rec.salesScope || rec.aiInsights?.salesScope,
            salesLogicVersion: rec.salesLogicVersion,
        };
        const ads = Number(ai.salesVelocity) || 0;
        const isMain = !!rec.isMainWarehouseView;
        return [
            companyId,
            branchId,
            rec.itemId,
            rec.description || "",
            rec.itemClass || "",
            rec.currentStock ?? 0,
            rec.qtySold90 ?? 0,
            ads,
            ai.daysRemaining === "N/A" ? 0 : Number(ai.daysRemaining) || 0,
            rec.suggestedQty ?? 0,
            rec.priorityLevel || "Low",
            rec.leadTimeDays ?? ai.leadTimeDays ?? 0,
            rec.vendorId || null,
            rec.branchOrderQty ?? 0,
            rec.mainInventory ?? rec.currentStock ?? 0,
            rec.comingPO ?? 0,
            rec.totalBranchReplenishment ?? rec.branchOrderQty ?? 0,
            rec.salesScope || ai.salesScope || null,
            rec.restockSource || ai.restockSource || null,
            ai.whatToDo || null,
            ai.howItWorks?.preview || null,
            JSON.stringify(ai),
            isMain ? 1 : 0,
            new Date(),
        ];
    },

    cacheRowToRecommendation(row, index, { slim = false } = {}) {
        let aiInsights = null;
        if (!slim && row.ai_insights_json) {
            try {
                aiInsights = typeof row.ai_insights_json === "string"
                    ? JSON.parse(row.ai_insights_json)
                    : row.ai_insights_json;
            } catch {
                aiInsights = null;
            }
        }
        if (!aiInsights) {
            aiInsights = {
                salesVelocity: String(row.sales_velocity ?? 0),
                daysRemaining: row.days_remaining ?? 0,
                whatToDo: row.what_to_do || "",
                howItWorks: { preview: row.ai_preview || "" },
                leadTimeDays: row.lead_time_days ?? 0,
            };
        }

        const rec = {
            recommendationId: `REC-C${index}`,
            itemId: row.inventory_id,
            description: row.description,
            itemClass: row.item_class || "",
            currentStock: Number(row.current_stock) || 0,
            suggestedQty: Number(row.suggested_qty) || 0,
            priorityLevel: row.priority_level,
            branchId: row.branch_id,
            restockSource: row.restock_source,
            generatedDate: row.updated_at,
            aiInsights,
            leadTimeDays: row.lead_time_days ?? 0,
            vendorId: row.vendor_id,
            qtySold90: Number(row.qty_sold_90) || aiInsights.qtySold90 || 0,
            lookbackDays: aiInsights.lookbackDays,
            salesScope: row.sales_scope || aiInsights.salesScope,
            stockSource: "mysql",
            isMainWarehouseView: !!row.is_main_warehouse_view,
        };

        if (row.is_main_warehouse_view) {
            rec.mainInventory = Number(row.main_inventory) || 0;
            rec.branchOrderQty = Number(row.branch_order_qty) || 0;
            rec.totalBranchReplenishment = Number(row.total_branch_replenishment) || 0;
        }
        // Always attach Coming PO for the cache row's branch (MAIN or branch-specific)
        rec.comingPO = Number(row.coming_po) || 0;

        return rec;
    },

    _replenishmentFilterSql({ search = "", priority = "", itemClass = "" } = {}, params) {
        let sql = "";
        const q = String(search || "").trim();
        if (q) {
            const escaped = q.replace(/[%_\\]/g, (c) => `\\${c}`);
            const likePrefix = `${escaped}%`;
            const likeContains = `%${escaped}%`;
            sql += ` AND (inventory_id LIKE ? OR description LIKE ? OR item_class LIKE ?)`;
            params.push(likePrefix, likeContains, likeContains);
        }
        const pri = String(priority || "").trim().toLowerCase();
        if (pri === "urgent") sql += ` AND priority_level = 'High'`;
        else if (pri === "soon") sql += ` AND priority_level = 'Medium'`;
        const cls = String(itemClass || "").trim();
        if (cls) {
            sql += ` AND LOWER(TRIM(item_class)) = LOWER(?)`;
            params.push(cls);
        }
        return sql;
    },

    async getReplenishmentItemClasses(companyId, branchId) {
        await this.ensureReplenishmentCacheTable();
        const [rows] = await purchasePool.query(
            `SELECT DISTINCT item_class AS itemClass
             FROM replenishment_cache
             WHERE company_id = ? AND branch_id = ?
               AND item_class IS NOT NULL AND TRIM(item_class) != ''
             ORDER BY item_class ASC`,
            [companyId, branchId]
        );
        return rows.map((r) => String(r.itemClass || "").trim()).filter(Boolean);
    },

    async getReplenishmentCacheStats(companyId, branchId, filters = {}) {
        await this.ensureReplenishmentCacheTable();
        const params = [companyId, branchId];
        const filterSql = this._replenishmentFilterSql(filters, params);
        const [[row]] = await purchasePool.query(
            `SELECT
                COUNT(*) AS itemCount,
                MAX(updated_at) AS updatedAt,
                SUM(CASE WHEN priority_level = 'High' THEN 1 ELSE 0 END) AS urgentCount,
                SUM(CASE WHEN priority_level = 'Medium' THEN 1 ELSE 0 END) AS soonCount,
                SUM(CASE WHEN COALESCE(suggested_qty, 0) > 0 THEN suggested_qty ELSE 0 END) AS totalSuggested,
                MAX(sales_scope) AS salesScope,
                MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(ai_insights_json, '$.salesLogicVersion')) AS UNSIGNED)) AS salesLogicVersion
             FROM replenishment_cache
             WHERE company_id = ? AND branch_id = ?${filterSql}`,
            params
        );
        return {
            itemCount: Number(row?.itemCount) || 0,
            updatedAt: row?.updatedAt || null,
            urgentCount: Number(row?.urgentCount) || 0,
            soonCount: Number(row?.soonCount) || 0,
            totalSuggested: Number(row?.totalSuggested) || 0,
            salesScope: row?.salesScope || null,
            salesLogicVersion: Number(row?.salesLogicVersion) || 1,
        };
    },

    /**
     * Paginated cache read — used for ultra-fast first paint (default slim, no heavy JSON).
     */
    async getReplenishmentFromCachePage(companyId, branchId, {
        page = 1,
        pageSize = 10,
        slim = true,
        search = "",
        priority = "",
        itemClass = "",
    } = {}) {
        await this.ensureReplenishmentCacheTable();
        await this.backfillReplenishmentProductNames(companyId, branchId);
        try {
            const filters = {
                search: String(search || "").trim(),
                priority: String(priority || "").trim(),
                itemClass: String(itemClass || "").trim(),
            };
            const branchStats = await this.getReplenishmentCacheStats(companyId, branchId);
            if (!branchStats.itemCount) return null;

            const hasFilters = filters.search || filters.priority || filters.itemClass;
            const filteredStats = hasFilters
                ? await this.getReplenishmentCacheStats(companyId, branchId, filters)
                : branchStats;

            const safePage = Math.max(1, page);
            const limit = Math.max(1, Math.min(pageSize, 5000));
            const offset = (safePage - 1) * limit;
            const totalItems = filteredStats.itemCount;
            const cols = slim
                ? `inventory_id, description, item_class, current_stock, qty_sold_90, sales_velocity, days_remaining,
                   suggested_qty, priority_level, lead_time_days, vendor_id, branch_order_qty,
                   main_inventory, coming_po, total_branch_replenishment, sales_scope, restock_source,
                   what_to_do, ai_preview, is_main_warehouse_view, updated_at, branch_id`
                : `*`;

            const params = [companyId, branchId];
            const filterSql = this._replenishmentFilterSql(filters, params);
            params.push(limit, offset);

            const [rows] = totalItems > 0
                ? await purchasePool.query(
                    `SELECT ${cols}
                     FROM replenishment_cache
                     WHERE company_id = ? AND branch_id = ?${filterSql}
                     ORDER BY FIELD(priority_level, 'High', 'Medium', 'Low'), suggested_qty DESC, inventory_id ASC
                     LIMIT ? OFFSET ?`,
                    params
                )
                : [[]];

            let recommendations = rows.map((row, i) =>
                this.cacheRowToRecommendation(row, offset + i, { slim })
            );

            const needsMeta = recommendations.filter(
                (r) => this._blankProductName(r.description) || !String(r.itemClass || "").trim()
            );
            if (needsMeta.length > 0) {
                const names = await this.getProductNameMap(
                    needsMeta.map((r) => r.itemId),
                    companyId
                );
                recommendations = recommendations.map((r) => {
                    const meta = names.get(normalizeInvKey(r.itemId));
                    if (!meta) return r;
                    return {
                        ...r,
                        description: this._blankProductName(r.description) && !this._blankProductName(meta.description)
                            ? meta.description
                            : r.description,
                        itemClass: String(r.itemClass || "").trim() || meta.itemClass || "",
                    };
                });
            }

            return {
                recommendations,
                meta: {
                    branch: branchId,
                    generatedAt: branchStats.updatedAt,
                    itemCount: branchStats.itemCount,
                    cacheSource: "mysql",
                    salesScope: branchStats.salesScope,
                    salesMode: "gross",
                    pagination: {
                        page: safePage,
                        pageSize: limit,
                        totalItems,
                        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
                    },
                    stats: {
                        urgent: branchStats.urgentCount,
                        soon: branchStats.soonCount,
                        totalSuggested: branchStats.totalSuggested,
                    },
                    salesLogicVersion: branchStats.salesLogicVersion,
                },
            };
        } catch (err) {
            console.error("[MySQL getReplenishmentFromCachePage Error]", err);
            return null;
        }
    },

    async upsertReplenishmentCache(companyId, branchId, recommendations = []) {
        await this.ensureReplenishmentCacheTable();
        const connection = await purchasePool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(
                "DELETE FROM replenishment_cache WHERE company_id = ? AND branch_id = ?",
                [companyId, branchId]
            );

            if (!recommendations.length) {
                await connection.commit();
                invalidateCache(`replenishment:full:${companyId}:${branchId}`);
                invalidateCache(`replenishment:page:${companyId}:${branchId}`);
                return 0;
            }

            const sql = `
                INSERT INTO replenishment_cache (
                    company_id, branch_id, inventory_id, description, item_class, current_stock,
                    qty_sold_90, sales_velocity, days_remaining, suggested_qty, priority_level,
                    lead_time_days, vendor_id, branch_order_qty, main_inventory, coming_po,
                    total_branch_replenishment, sales_scope, restock_source, what_to_do,
                    ai_preview, ai_insights_json, is_main_warehouse_view, updated_at
                ) VALUES ?
            `;
            const values = recommendations.map((rec) =>
                this.recommendationToCacheRow(companyId, branchId, rec)
            );
            // Insert in chunks to avoid huge packets
            const CHUNK = 400;
            for (let i = 0; i < values.length; i += CHUNK) {
                await connection.query(sql, [values.slice(i, i + CHUNK)]);
            }
            await connection.commit();
            invalidateCache(`replenishment:full:${companyId}:${branchId}`);
            invalidateCache(`replenishment:page:${companyId}:${branchId}`);
            return values.length;
        } catch (err) {
            await connection.rollback();
            console.error("[MySQL upsertReplenishmentCache Error]", err);
            throw err;
        } finally {
            connection.release();
        }
    },

    async getReplenishmentFromCache(companyId, branchId, filters = {}) {
        return this.getReplenishmentFromCachePage(companyId, branchId, {
            page: 1,
            pageSize: 100000,
            slim: true,
            ...filters,
        });
    },

    // ── Forecast Generator ─────────────────────────────────────

    async ensureForecastInputsTable() {
        if (MySqlService._forecastInputsReady) return true;
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS forecast_generator_inputs (
                  company_id VARCHAR(64) NOT NULL DEFAULT 'main',
                  branch_id VARCHAR(100) NOT NULL,
                  inventory_id VARCHAR(100) NOT NULL,
                  estimate_sales DECIMAL(18,4) NULL,
                  buffer_inventory DECIMAL(18,4) NULL,
                  target_sales DECIMAL(18,4) NULL,
                  updated_by INT UNSIGNED NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (company_id, branch_id, inventory_id),
                  KEY idx_fgi_branch (branch_id),
                  KEY idx_fgi_item (inventory_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try {
                const [[col]] = await purchasePool.query(
                    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'forecast_generator_inputs' AND COLUMN_NAME = 'target_sales'`
                );
                if (!Number(col?.cnt)) {
                    await purchasePool.query(
                        `ALTER TABLE forecast_generator_inputs ADD COLUMN target_sales DECIMAL(18,4) NULL AFTER buffer_inventory`
                    );
                }
            } catch (alterErr) {
                if (!/duplicate column/i.test(alterErr.message)) {
                    console.warn("[MySQL forecast target_sales]", alterErr.message);
                }
            }
            MySqlService._forecastInputsReady = true;
            return true;
        } catch (err) {
            console.error("[MySQL ensureForecastInputsTable]", err.message);
            return false;
        }
    },

    async ensureForecastItemStockTable() {
        if (MySqlService._forecastStockReady) return true;
        try {
            await purchasePool.query(`
                CREATE TABLE IF NOT EXISTS forecast_item_stock (
                  company_id VARCHAR(64) NOT NULL DEFAULT 'main',
                  inventory_id VARCHAR(100) NOT NULL,
                  warehouse_id VARCHAR(100) NOT NULL,
                  branch_id VARCHAR(100) NULL,
                  site_id VARCHAR(100) NULL,
                  item_name VARCHAR(255) NULL,
                  item_class VARCHAR(100) NULL,
                  default_price DECIMAL(18,4) DEFAULT 0,
                  on_hand DECIMAL(18,4) DEFAULT 0,
                  available DECIMAL(18,4) DEFAULT 0,
                  item_status VARCHAR(50) NULL,
                  last_sync DATETIME NULL,
                  PRIMARY KEY (company_id, inventory_id, warehouse_id),
                  KEY idx_fis_branch (company_id, branch_id),
                  KEY idx_fis_site (company_id, site_id),
                  KEY idx_fis_class (item_class),
                  KEY idx_fis_name (inventory_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            MySqlService._forecastStockReady = true;
            await this.backfillForecastItemStock();
            return true;
        } catch (err) {
            console.error("[MySQL ensureForecastItemStockTable]", err.message);
            return false;
        }
    },

    async backfillForecastItemStock() {
        if (MySqlService._forecastStockBackfilled) return true;
        try {
            const [[cnt]] = await purchasePool.query(`SELECT COUNT(*) AS n FROM forecast_item_stock`);
            if (Number(cnt?.n) > 0) {
                MySqlService._forecastStockBackfilled = true;
                return true;
            }
            const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
            const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
            for (const table of ["product_inventory_items", "inventory_items"]) {
                try {
                    const [result] = await purchasePool.query(
                        `INSERT INTO \`${purchaseDb}\`.forecast_item_stock (
                            company_id, inventory_id, warehouse_id, branch_id, site_id,
                            item_name, item_class, default_price, on_hand, available, item_status, last_sync
                        )
                        SELECT
                            COALESCE(NULLIF(TRIM(company_id), ''), 'main'),
                            TRIM(inventory_id),
                            COALESCE(NULLIF(TRIM(default_warehouse), ''), '__catalog__'),
                            NULLIF(TRIM(branch_id), ''),
                            NULLIF(TRIM(site_id), ''),
                            inventory_name,
                            item_class,
                            COALESCE(default_price, 0),
                            COALESCE(on_hand, 0),
                            COALESCE(available, on_hand, 0),
                            item_status,
                            last_sync
                        FROM \`${inventoryDb}\`.\`${table}\`
                        WHERE inventory_id IS NOT NULL AND TRIM(inventory_id) != ''
                          AND UPPER(TRIM(COALESCE(default_warehouse,''))) NOT LIKE '%DAMAGE%'
                          AND UPPER(TRIM(COALESCE(branch_id,''))) NOT LIKE '%DAMAGE%'
                          AND UPPER(TRIM(COALESCE(site_id,''))) NOT LIKE '%DAMAGE%'
                          AND UPPER(TRIM(COALESCE(default_warehouse,''))) NOT LIKE '%DISCOUNTED%'
                          AND UPPER(TRIM(COALESCE(branch_id,''))) NOT LIKE '%DISCOUNTED%'
                          AND UPPER(TRIM(COALESCE(site_id,''))) NOT LIKE '%DISCOUNTED%'
                        ON DUPLICATE KEY UPDATE
                            branch_id = COALESCE(VALUES(branch_id), branch_id),
                            site_id = COALESCE(VALUES(site_id), site_id),
                            item_name = COALESCE(VALUES(item_name), item_name),
                            item_class = COALESCE(VALUES(item_class), item_class),
                            default_price = COALESCE(VALUES(default_price), default_price),
                            on_hand = VALUES(on_hand),
                            available = VALUES(available),
                            item_status = COALESCE(VALUES(item_status), item_status),
                            last_sync = VALUES(last_sync)`
                    );
                    console.log(`[Forecast stock] backfill from ${table}: ${result?.affectedRows || 0} rows`);
                    break;
                } catch (err) {
                    console.warn(`[Forecast stock] backfill ${table} skipped:`, err.message);
                }
            }
            MySqlService._forecastStockBackfilled = true;
            return true;
        } catch (err) {
            console.error("[MySQL backfillForecastItemStock]", err.message);
            return false;
        }
    },

    async purgeForecastDamageStock() {
        if (MySqlService._forecastDamagePurged) return 0;
        try {
            await this.ensureForecastItemStockTable();
            const [result] = await purchasePool.query(
                `DELETE FROM forecast_item_stock
                 WHERE UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DAMAGE%'
                    OR UPPER(TRIM(COALESCE(branch_id,''))) LIKE '%DAMAGE%'
                    OR UPPER(TRIM(COALESCE(site_id,''))) LIKE '%DAMAGE%'
                    OR UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DISCOUNTED%'
                    OR UPPER(TRIM(COALESCE(branch_id,''))) LIKE '%DISCOUNTED%'
                    OR UPPER(TRIM(COALESCE(site_id,''))) LIKE '%DISCOUNTED%'`
            );
            MySqlService._forecastDamagePurged = true;
            const removed = result?.affectedRows || 0;
            if (removed > 0) {
                console.log(`[Forecast stock] purged ${removed} DAMAGE/DISCOUNTED rows`);
                invalidateCache("forecastGen:");
            }
            return removed;
        } catch (err) {
            console.warn("[MySQL purgeForecastDamageStock]", err.message);
            return 0;
        }
    },

    async upsertForecastItemStockRows(rows = [], companyId = "main") {
        // Forecast must never store DAMAGE / DISCOUNTED — Inventory Damage KPI keeps those
        // in product_inventory_items only.
        const list = (rows || []).filter(
            (r) => String(r?.inventory_id || "").trim() && !isForecastDamageRow(r)
        );
        if (!list.length) return 0;
        try {
            await this.ensureForecastItemStockTable();
            await this.purgeForecastDamageStock();
            const company = String(companyId || "main").trim() || "main";
            const CHUNK = 200;
            const now = new Date();
            let written = 0;
            for (let i = 0; i < list.length; i += CHUNK) {
                const chunk = list.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
                const values = chunk.flatMap((r) => [
                    company,
                    String(r.inventory_id || "").trim(),
                    String(r.warehouse_id || r.default_warehouse || "__catalog__").trim() || "__catalog__",
                    String(r.branch_id || "").trim() || null,
                    String(r.site_id || "").trim() || null,
                    r.item_name || r.description || null,
                    r.item_class ?? null,
                    Number(r.default_price) || 0,
                    Number(r.on_hand) || 0,
                    Number(r.available ?? r.on_hand) || 0,
                    r.item_status || null,
                    now,
                ]);
                await purchasePool.query(
                    `INSERT INTO forecast_item_stock (
                        company_id, inventory_id, warehouse_id, branch_id, site_id,
                        item_name, item_class, default_price, on_hand, available, item_status, last_sync
                    ) VALUES ${placeholders}
                    ON DUPLICATE KEY UPDATE
                        branch_id = COALESCE(VALUES(branch_id), branch_id),
                        site_id = COALESCE(VALUES(site_id), site_id),
                        item_name = COALESCE(VALUES(item_name), item_name),
                        item_class = COALESCE(VALUES(item_class), item_class),
                        default_price = COALESCE(VALUES(default_price), default_price),
                        on_hand = VALUES(on_hand),
                        available = VALUES(available),
                        item_status = COALESCE(VALUES(item_status), item_status),
                        last_sync = VALUES(last_sync)`,
                    values
                );
                written += chunk.length;
            }
            invalidateCache("forecastGen:");
            return written;
        } catch (err) {
            console.warn("[MySQL upsertForecastItemStockRows]", err.message);
            return 0;
        }
    },

    async upsertForecastGeneratorInput({
        companyId = "main",
        branchId = FORECAST_ALL_BRANCH,
        inventoryId,
        estimateSales = null,
        bufferInventory = null,
        targetSales = null,
        updatedBy = null,
    } = {}) {
        const id = String(inventoryId || "").trim();
        if (!id) return false;
        await this.ensureForecastInputsTable();
        const company = String(companyId || "main").trim() || "main";
        const branch = forecastBranchKey(branchId);
        try {
            await purchasePool.query(
                `INSERT INTO forecast_generator_inputs
                    (company_id, branch_id, inventory_id, estimate_sales, buffer_inventory, target_sales, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    estimate_sales = VALUES(estimate_sales),
                    buffer_inventory = VALUES(buffer_inventory),
                    target_sales = VALUES(target_sales),
                    updated_by = VALUES(updated_by),
                    updated_at = CURRENT_TIMESTAMP`,
                [company, branch, id, estimateSales, bufferInventory, targetSales, updatedBy]
            );
            invalidateCache(`forecastGen:${company}:${branch}`);
            return true;
        } catch (err) {
            console.error("[MySQL upsertForecastGeneratorInput]", err.message);
            return false;
        }
    },

    async _forecastStockSource() {
        await this.ensureForecastItemStockTable();
        const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
        try {
            const [[row]] = await purchasePool.query(`SELECT COUNT(*) AS n FROM forecast_item_stock`);
            if (Number(row?.n) > 0) {
                return {
                    qualified: `\`${purchaseDb}\`.forecast_item_stock`,
                    warehouseCol: "warehouse_id",
                    nameCol: "item_name",
                };
            }
        } catch { /* fall through */ }
        return {
            qualified: `\`${inventoryDb}\`.\`${INVENTORY_VIEW_TABLE}\``,
            warehouseCol: "default_warehouse",
            nameCol: "inventory_name",
        };
    },

    async listMissingSalesInvoiceMonths({ ranges = [], branch = "", asOf = new Date() } = {}) {
        const months = [...new Set(
            (ranges || []).flatMap((r) => listMonthsInRange(r.start, r.end))
        )];
        if (!months.length) return [];

        const start = ranges.reduce((min, r) => (!min || (r.start && r.start < min) ? r.start : min), "");
        const end = ranges.reduce((max, r) => (!max || (r.end && r.end > max) ? r.end : max), "");
        if (!start || !end) return months;

        const where = [
            "CAST(document_date AS DATE) >= ?",
            "CAST(document_date AS DATE) <= ?",
            "order_type IN ('Invoice', 'Debit Memo')",
        ];
        const params = [start, end];
        if (branch) {
            const branchNames = await this.resolveSalesBranchNames(branch);
            if (branchNames.length) {
                where.push(`branch_name IN (${branchNames.map(() => "?").join(",")})`);
                params.push(...branchNames);
            }
        }

        try {
            const [rows] = await purchasePool.query(
                `SELECT DATE_FORMAT(CAST(document_date AS DATE), '%Y-%m') AS ym,
                        COUNT(*) AS c,
                        DATE_FORMAT(MIN(CAST(document_date AS DATE)), '%Y-%m-%d') AS dmin,
                        DATE_FORMAT(MAX(CAST(document_date AS DATE)), '%Y-%m-%d') AS dmax
                 FROM product_periodic_sales
                 WHERE ${where.join(" AND ")}
                 GROUP BY ym`,
                params
            );
            const coverage = new Map(
                rows.map((r) => [
                    String(r.ym || "").trim(),
                    {
                        c: Number(r.c) || 0,
                        dmin: r.dmin,
                        dmax: r.dmax,
                    },
                ])
            );
            return months.filter((ym) => {
                const row = coverage.get(ym);
                if (!row || row.c <= 0) return true;
                // Partial months (e.g. Jul 1–14 only) must stay missing so Forecast re-pulls.
                return !monthInvoiceCoverageComplete(ym, row.dmin, row.dmax, row.c, asOf);
            });
        } catch (err) {
            console.error("[MySQL listMissingSalesInvoiceMonths]", err.message);
            return months;
        }
    },

    async getForecastGenerator({
        companyId = "main",
        branch = "",
        search = "",
        itemClass = "",
        last3Start,
        last3End,
        lastYearStart,
        lastYearEnd,
        page = 1,
        pageSize = 10,
    } = {}) {
        await this.ensureForecastInputsTable();
        await this.purgeForecastDamageStock();
        const src = await this._forecastStockSource();
        const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
        const searchTerm = normalizeInventorySearch(search);
        const classFilter = String(itemClass || "").trim();
        const branchKey = forecastBranchKey(branch);
        const destinations = branch ? getStockWarehouseIdsForBranch(branch) : [];
        const limitInt = Math.max(1, parseInt(pageSize, 10) || 10);
        const pageInt = Math.max(1, parseInt(page, 10) || 1);
        const offsetInt = (pageInt - 1) * limitInt;
        const whCol = src.warehouseCol;
        const nameCol = src.nameCol;
        const stockMatch = sqlMatchForecastWarehouses("f", destinations, whCol);
        const damageEx = sqlExcludeForecastDamage("f", whCol);
        const damageLit = sqlExcludeForecastDamageLiteral("f", whCol);

        const stockWhere = ["f.company_id = ?", damageEx.clause];
        const stockParams = [effectiveCompanyId, ...damageEx.params];
        if (effectiveCompanyId === "main" && !branch) {
            const ecomEx = sqlExcludeEcomBranches("f");
            stockWhere.push(ecomEx.clause);
            stockParams.push(...ecomEx.params);
        } else if (effectiveCompanyId === "ecommerce" || (branch && isEcomBranchAlias(branch))) {
            const ecomOnly = sqlOnlyEcomBranches("f");
            stockWhere.push(ecomOnly.clause);
            stockParams.push(...ecomOnly.params);
        }

        // Keep v1.2.25 source (Qty Available) but drop the minus sign Acumatica
        // stores when allocations exceed on-hand (e.g. -133 → 133).
        // DAMAGE / DISCOUNTED are excluded in WHERE and again in CASE (never count them).
        const qtyCase = destinations.length
            ? `SUM(CASE WHEN f.${whCol} != '__catalog__' AND ${damageLit} AND ${stockMatch.clause} THEN ABS(COALESCE(f.available, f.on_hand, 0)) ELSE 0 END)`
            : `SUM(CASE WHEN f.${whCol} != '__catalog__' AND ${damageLit} THEN ABS(COALESCE(f.available, f.on_hand, 0)) ELSE 0 END)`;
        const qtyParams = destinations.length ? stockMatch.params : [];

        const atBranchCase = destinations.length
            ? `MAX(CASE WHEN f.${whCol} != '__catalog__' AND ${damageLit} AND ${stockMatch.clause} THEN 1 ELSE 0 END)`
            : "1";
        const atBranchParams = destinations.length ? stockMatch.params : [];

        const [stockRows] = await purchasePool.query(
            `SELECT
                UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) AS invKey,
                MAX(TRIM(f.inventory_id)) AS inventoryId,
                MAX(CASE WHEN f.${whCol} = '__catalog__' THEN f.${nameCol} END) AS catName,
                MAX(CASE WHEN f.${whCol} = '__catalog__' THEN f.item_class END) AS catClass,
                MAX(CASE WHEN f.${whCol} = '__catalog__' THEN f.default_price END) AS catSrp,
                MAX(f.${nameCol}) AS anyName,
                MAX(f.item_class) AS anyClass,
                MAX(f.default_price) AS anySrp,
                ${qtyCase} AS inventoryQty,
                ${atBranchCase} AS atBranch
             FROM ${src.qualified} f
             WHERE ${stockWhere.join(" AND ")}
             GROUP BY UPPER(REPLACE(TRIM(f.inventory_id), ' ', ''))`,
            [...qtyParams, ...atBranchParams, ...stockParams]
        );

        const overallStart = last3Start < lastYearStart ? last3Start : lastYearStart;
        const overallEnd = last3End > lastYearEnd ? last3End : lastYearEnd;
        const salesWhere = ["CAST(s.document_date AS DATE) >= ?", "CAST(s.document_date AS DATE) <= ?"];
        const salesParams = [overallStart, overallEnd];
        const salesEx = sqlExcludeSalesBranches("branch_name", "s");
        salesWhere.push(salesEx.clause);
        salesParams.push(...salesEx.params);
        if (effectiveCompanyId === "main" && !branch) {
            const ecomSalesEx = sqlExcludeEcomSalesBranches("branch_name", "s");
            salesWhere.push(ecomSalesEx.clause);
            salesParams.push(...ecomSalesEx.params);
        } else if (effectiveCompanyId === "ecommerce" && !branch) {
            const ecomOnly = sqlOnlyEcomSalesBranches("branch_name", "s");
            salesWhere.push(ecomOnly.clause);
            salesParams.push(...ecomOnly.params);
        } else if (branch) {
            const branchNames = await this.resolveSalesBranchNames(branch);
            if (branchNames.length) {
                salesWhere.push(`s.branch_name IN (${branchNames.map(() => "?").join(",")})`);
                salesParams.push(...branchNames);
            }
        }

        const [salesRows] = await purchasePool.query(
            `SELECT UPPER(REPLACE(TRIM(s.inventory_id), ' ', '')) AS invKey,
                    SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_NET_QTY}) ELSE 0 END) AS last3Net,
                    SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_GROSS_QTY}) ELSE 0 END) AS last3Gross,
                    SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_NET_QTY}) ELSE 0 END) AS lastYearNet,
                    SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_GROSS_QTY}) ELSE 0 END) AS lastYearGross
             FROM product_periodic_sales s
             WHERE ${salesWhere.join(" AND ")}
             GROUP BY UPPER(REPLACE(TRIM(s.inventory_id), ' ', ''))`,
            [
                last3Start, last3End,
                last3Start, last3End,
                lastYearStart, lastYearEnd,
                lastYearStart, lastYearEnd,
                ...salesParams,
            ]
        );
        const salesMap = new Map(salesRows.map((r) => [
            r.invKey,
            {
                // Prefer net (invoice − credit memo) to match Acumatica Sales Profitability Quantity.
                // Fall back to gross only when the window has no nettable invoice qty.
                last3: netQtySold(r.last3Net) || forecastSoldQty(r.last3Gross, 0),
                lastYear: netQtySold(r.lastYearNet) || forecastSoldQty(r.lastYearGross, 0),
            },
        ]));

        const comingPoRaw = branch
            ? await this.getOpenPoQtyByItem({ warehouseId: branch })
            : await this._getOpenPoQtyAllUncached(effectiveCompanyId);
        const comingPoMap = new Map();
        for (const [id, qty] of comingPoRaw.entries()) {
            const key = normalizeInvKey(id);
            comingPoMap.set(key, (comingPoMap.get(key) || 0) + (Number(qty) || 0));
        }

        const [inputRows] = await purchasePool.query(
            `SELECT inventory_id, estimate_sales, buffer_inventory, target_sales
             FROM forecast_generator_inputs
             WHERE company_id = ? AND branch_id = ?`,
            [effectiveCompanyId, branchKey]
        );
        const inputMap = new Map();
        for (const r of inputRows) {
            inputMap.set(normalizeInvKey(r.inventory_id), r);
        }

        const [classRows] = await purchasePool.query(
            `SELECT DISTINCT TRIM(f.item_class) AS itemClass
             FROM ${src.qualified} f
             WHERE f.company_id = ?
               AND f.item_class IS NOT NULL
               AND TRIM(f.item_class) != ''
             ORDER BY itemClass ASC`,
            [effectiveCompanyId]
        );
        const itemClasses = classRows.map((r) => r.itemClass).filter(Boolean);

        const searchUpper = searchTerm.toUpperCase();
        const classUpper = classFilter.toUpperCase();
        const merged = [];
        const seen = new Set();

        for (const r of stockRows) {
            const key = r.invKey || normalizeInvKey(r.inventoryId);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const sales = salesMap.get(key) || { last3: 0, lastYear: 0 };
            const itemName = r.catName || r.anyName || "—";
            const itemClassName = r.catClass || r.anyClass || "";
            if (searchUpper && !String(r.inventoryId || "").toUpperCase().includes(searchUpper) && !String(itemName).toUpperCase().includes(searchUpper)) {
                continue;
            }
            if (classUpper && String(itemClassName).toUpperCase().trim() !== classUpper) continue;
            const inventoryQty = Number(r.inventoryQty) || 0;
            const comingPo = comingPoMap.get(key) || 0;
            // Keep zero-sale items: catalog / stock rows stay in Forecast even with no history.
            const input = inputMap.get(key);
            merged.push({
                inventoryId: r.inventoryId,
                itemClass: itemClassName,
                itemName,
                srp: Number(r.catSrp ?? r.anySrp) || 0,
                inventoryQty,
                comingPo,
                last3MonthsQty: sales.last3,
                lastYearQty: sales.lastYear,
                estimateSales: input?.estimate_sales == null ? null : Number(input.estimate_sales),
                bufferInventory: input?.buffer_inventory == null ? null : Number(input.buffer_inventory),
                targetSales: input?.target_sales == null ? null : Number(input.target_sales),
            });
        }

        if (!branch) {
            for (const [key, sales] of salesMap.entries()) {
                if (seen.has(key)) continue;
                if (searchUpper && !key.includes(searchUpper.replace(/\s+/g, ""))) continue;
                seen.add(key);
                const input = inputMap.get(key);
                merged.push({
                    inventoryId: key,
                    itemClass: "",
                    itemName: "—",
                    srp: 0,
                    inventoryQty: 0,
                    comingPo: comingPoMap.get(key) || 0,
                    last3MonthsQty: sales.last3,
                    lastYearQty: sales.lastYear,
                    estimateSales: input?.estimate_sales == null ? null : Number(input.estimate_sales),
                    bufferInventory: input?.buffer_inventory == null ? null : Number(input.buffer_inventory),
                    targetSales: input?.target_sales == null ? null : Number(input.target_sales),
                });
            }
        }

        for (const [key, qty] of comingPoMap.entries()) {
            if (seen.has(key)) continue;
            if ((Number(qty) || 0) <= 0) continue;
            if (searchUpper && !key.includes(searchUpper.replace(/\s+/g, ""))) continue;
            if (classUpper) continue;
            seen.add(key);
            const sales = salesMap.get(key) || { last3: 0, lastYear: 0 };
            const input = inputMap.get(key);
            merged.push({
                inventoryId: key,
                itemClass: "",
                itemName: "—",
                srp: 0,
                inventoryQty: 0,
                comingPo: Number(qty) || 0,
                last3MonthsQty: sales.last3,
                lastYearQty: sales.lastYear,
                estimateSales: input?.estimate_sales == null ? null : Number(input.estimate_sales),
                bufferInventory: input?.buffer_inventory == null ? null : Number(input.buffer_inventory),
                targetSales: input?.target_sales == null ? null : Number(input.target_sales),
            });
        }

        merged.sort((a, z) => {
            const aAct = (a.last3MonthsQty || 0) + (a.lastYearQty || 0);
            const zAct = (z.last3MonthsQty || 0) + (z.lastYearQty || 0);
            if (zAct !== aAct) return zAct - aAct;
            if ((z.inventoryQty || 0) !== (a.inventoryQty || 0)) return (z.inventoryQty || 0) - (a.inventoryQty || 0);
            if ((z.comingPo || 0) !== (a.comingPo || 0)) return (z.comingPo || 0) - (a.comingPo || 0);
            return String(a.inventoryId).localeCompare(String(z.inventoryId));
        });

        const totalItems = merged.length;
        const pageRows = merged.slice(offsetInt, offsetInt + limitInt);

        const classTotals = new Map();
        let bufferAmountTotal = 0;
        for (const r of merged) {
            const est = r.estimateSales == null ? Math.max(r.last3MonthsQty, r.lastYearQty) : r.estimateSales;
            const buffer = Number(r.bufferInventory) || 0;
            const suggestedTarget = (Number(est) || 0) + buffer;
            const target = r.targetSales == null ? suggestedTarget : Number(r.targetSales);
            const srp = Number(r.srp) || 0;
            const bufferAmount = buffer * srp;
            const estimatedSalesAmount = (Number(target) || 0) * srp;
            bufferAmountTotal += bufferAmount;
            const cls = String(r.itemClass || "").trim() || "(No class)";
            const prev = classTotals.get(cls) || {
                itemClass: cls,
                itemCount: 0,
                bufferQty: 0,
                bufferAmount: 0,
                estimatedSalesAmount: 0,
                last3MonthsQty: 0,
                lastYearQty: 0,
            };
            prev.itemCount += 1;
            prev.bufferQty += buffer;
            prev.bufferAmount += bufferAmount;
            prev.estimatedSalesAmount += estimatedSalesAmount;
            prev.last3MonthsQty += Number(r.last3MonthsQty) || 0;
            prev.lastYearQty += Number(r.lastYearQty) || 0;
            classTotals.set(cls, prev);
        }
        const classSummary = [...classTotals.values()].sort((a, z) =>
            z.estimatedSalesAmount - a.estimatedSalesAmount
            || String(a.itemClass).localeCompare(String(z.itemClass))
        );

        const metrics = {
            productCount: totalItems,
            inventoryQty: merged.reduce((s, r) => s + Math.abs(Number(r.inventoryQty) || 0), 0),
            last3MonthsQty: merged.reduce((s, r) => s + (Number(r.last3MonthsQty) || 0), 0),
            lastYearQty: merged.reduce((s, r) => s + (Number(r.lastYearQty) || 0), 0),
            comingPo: merged.reduce((s, r) => s + (Number(r.comingPo) || 0), 0),
            bufferAmount: bufferAmountTotal,
            needPoCount: merged.filter((r) => {
                const est = r.estimateSales == null ? Math.max(r.last3MonthsQty, r.lastYearQty) : r.estimateSales;
                const suggestedTarget = (Number(est) || 0) + (Number(r.bufferInventory) || 0);
                const target = r.targetSales == null ? suggestedTarget : Number(r.targetSales);
                return target - (r.inventoryQty || 0) - (r.comingPo || 0) > 0;
            }).length,
            estimatedSalesAmount: merged.reduce((s, r) => {
                const est = r.estimateSales == null ? Math.max(r.last3MonthsQty, r.lastYearQty) : r.estimateSales;
                const suggestedTarget = (Number(est) || 0) + (Number(r.bufferInventory) || 0);
                const target = r.targetSales == null ? suggestedTarget : Number(r.targetSales);
                return s + (Number(target) || 0) * (Number(r.srp) || 0);
            }, 0),
        };

        return { rows: pageRows, totalItems, itemClasses, metrics, classSummary };
    },

    async _getOpenPoQtyAllUncached(companyId = "main", { includeOnHold = false, useOrderQty = false } = {}) {
        try {
            await this.ensureReceivedQtyColumn();
            await this.ensurePoWarehouseColumns();
            const openStatuses = openPoHeaderStatuses({ includeOnHold });
            const qtyExpr = useOrderQty ? sqlPoLineOrderQty("d") : sqlPoLineOpenQty("d");
            const [rows] = await purchasePool.query(
                `
                SELECT
                    UPPER(REPLACE(TRIM(d.inventory_id), ' ', '')) as inventoryId,
                    COALESCE(SUM(${qtyExpr}), 0) as openQty
                FROM purchase_order_details d
                INNER JOIN purchase_history h
                    ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
                WHERE h.status IN (${openStatuses.map(() => "?").join(", ")})
                  AND d.inventory_id IS NOT NULL
                  AND d.inventory_id != ''
                  AND (${qtyExpr}) > 0
                GROUP BY UPPER(REPLACE(TRIM(d.inventory_id), ' ', ''))
                `,
                openStatuses
            );
            const map = new Map();
            for (const row of rows) {
                const key = normalizeInvKey(row.inventoryId);
                if (key) map.set(key, Number(row.openQty) || 0);
            }
            return map;
        } catch (err) {
            console.error("[MySQL _getOpenPoQtyAllUncached]", err.message);
            return new Map();
        }
    },

    async _forecastMetrics({
        effectiveCompanyId,
        branch,
        destinations,
        last3Start,
        last3End,
        lastYearStart,
        lastYearEnd,
        productCount = 0,
        comingPoTotal = null,
    } = {}) {
        const stockWhere = ["w.company_id = ?", "w.default_warehouse != '__catalog__'"];
        const stockParams = [effectiveCompanyId];
        const branchEx = sqlExcludeBranches("w");
        stockWhere.push(branchEx.clause);
        stockParams.push(...branchEx.params);
        if (effectiveCompanyId === "main" && !branch) {
            const ecomEx = sqlExcludeEcomBranches("w");
            stockWhere.push(ecomEx.clause);
            stockParams.push(...ecomEx.params);
        } else if (effectiveCompanyId === "ecommerce" || (branch && isEcomBranchAlias(branch))) {
            const ecomOnly = sqlOnlyEcomBranches("w");
            stockWhere.push(ecomOnly.clause);
            stockParams.push(...ecomOnly.params);
        }
        if (destinations?.length) {
            const stockMatch = sqlMatchBranchWarehouses("w", destinations);
            stockWhere.push(stockMatch.clause);
            stockParams.push(...stockMatch.params);
        }
        const [[{ inventoryQty }]] = await pool.query(
            `SELECT COALESCE(SUM(ABS(COALESCE(w.available, w.on_hand, 0))), 0) AS inventoryQty
             FROM \`${INVENTORY_VIEW_TABLE}\` w
             WHERE ${stockWhere.join(" AND ")}`,
            stockParams
        );

        const overallStart = last3Start < lastYearStart ? last3Start : lastYearStart;
        const overallEnd = last3End > lastYearEnd ? last3End : lastYearEnd;
        const salesWhere = ["CAST(s.document_date AS DATE) >= ?", "CAST(s.document_date AS DATE) <= ?"];
        const salesParams = [overallStart, overallEnd];
        const salesEx = sqlExcludeSalesBranches("branch_name", "s");
        salesWhere.push(salesEx.clause);
        salesParams.push(...salesEx.params);
        if (effectiveCompanyId === "main" && !branch) {
            const ecomSalesEx = sqlExcludeEcomSalesBranches("branch_name", "s");
            salesWhere.push(ecomSalesEx.clause);
            salesParams.push(...ecomSalesEx.params);
        } else if (effectiveCompanyId === "ecommerce" && !branch) {
            const ecomOnly = sqlOnlyEcomSalesBranches("branch_name", "s");
            salesWhere.push(ecomOnly.clause);
            salesParams.push(...ecomOnly.params);
        } else if (branch) {
            const branchNames = await this.resolveSalesBranchNames(branch);
            if (branchNames.length) {
                salesWhere.push(`s.branch_name IN (${branchNames.map(() => "?").join(",")})`);
                salesParams.push(...branchNames);
            }
        }
        const [[salesMetrics]] = await purchasePool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_NET_QTY}) ELSE 0 END), 0) AS last3Net,
                COALESCE(SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_GROSS_QTY}) ELSE 0 END), 0) AS last3Gross,
                COALESCE(SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_NET_QTY}) ELSE 0 END), 0) AS lastYearNet,
                COALESCE(SUM(CASE WHEN CAST(s.document_date AS DATE) >= ? AND CAST(s.document_date AS DATE) <= ? THEN (${SQL_GROSS_QTY}) ELSE 0 END), 0) AS lastYearGross
             FROM product_periodic_sales s
             WHERE ${salesWhere.join(" AND ")}`,
            [
                last3Start, last3End,
                last3Start, last3End,
                lastYearStart, lastYearEnd,
                lastYearStart, lastYearEnd,
                ...salesParams,
            ]
        );

        let comingPo = comingPoTotal;
        if (comingPo == null) {
            const map = branch
                ? await this.getOpenPoQtyByItem({ warehouseId: branch })
                : await this._getOpenPoQtyAllUncached(effectiveCompanyId);
            comingPo = [...map.values()].reduce((sum, n) => sum + (Number(n) || 0), 0);
        }

        return {
            productCount,
            inventoryQty: Number(inventoryQty) || 0,
            last3MonthsQty: netQtySold(salesMetrics?.last3Net) || forecastSoldQty(salesMetrics?.last3Gross, 0),
            lastYearQty: netQtySold(salesMetrics?.lastYearNet) || forecastSoldQty(salesMetrics?.lastYearGross, 0),
            comingPo: Number(comingPo) || 0,
            needPoCount: 0,
            estimatedSalesAmount: 0,
        };
    },

    /**
     * Lightweight DB reachability check for /api/health (short timeout).
     */
    async pingDatabases(timeoutMs = 5000) {
        const ms = Math.max(1000, Math.min(15000, Number(timeoutMs) || 5000));
        const started = Date.now();
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(Object.assign(new Error("DB_PING_TIMEOUT"), { code: "ETIMEDOUT" })), ms);
        });
        try {
            await Promise.race([
                Promise.all([
                    purchasePool.query("SELECT 1 AS ok"),
                    pool.query("SELECT 1 AS ok"),
                ]),
                timeout,
            ]);
            return { ok: true, ms: Date.now() - started };
        } catch (err) {
            return {
                ok: false,
                ms: Date.now() - started,
                error: err?.code || err?.message || "database unreachable",
            };
        }
    },
};
