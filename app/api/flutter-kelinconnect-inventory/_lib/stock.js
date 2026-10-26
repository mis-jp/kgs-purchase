import { ECOM_BRANCH_ALIASES, EXCLUDED_BRANCH_KEYWORDS } from "@/lib/companies";
import { getPool, STOCK_TABLE } from "./db";
import { HttpError } from "./http";
import { ledgerStatus, ledgerTable } from "./ledger-db.js";
import { getSettings } from "./ledger.js";

/**
 * Stock views. Branches that are live on the Inventory ledger read `db_kc_inventory.inv_balances`;
 * every other branch reads Purchase-owned `forecast_item_stock` (Acumatica sync, read-only).
 * One row per company / item / warehouse; `__catalog__` rows only carry the item name and class.
 */

export const LOW_STOCK_BELOW = 10;
export const STOCK_STATUSES = ["healthy", "low_stock", "out_of_stock"];

const ECOM = [...ECOM_BRANCH_ALIASES];

/** Real warehouse rows, minus DAMAGE / DISCOUNTED, with ecommerce rows only from the ecommerce bucket. */
function baseWhere(alias = "s") {
    const wh = `UPPER(TRIM(${alias}.warehouse_id))`;
    const clauses = [
        `${alias}.warehouse_id <> '__catalog__'`,
        `TRIM(COALESCE(${alias}.inventory_id, '')) <> ''`,
        `TRIM(COALESCE(${alias}.warehouse_id, '')) <> ''`,
        `((${alias}.company_id = 'ecommerce' AND ${wh} IN (${ECOM.map(() => "?").join(", ")}))
          OR (${alias}.company_id = 'main' AND ${wh} NOT IN (${ECOM.map(() => "?").join(", ")})))`,
    ];
    const params = [...ECOM, ...ECOM];
    for (const kw of EXCLUDED_BRANCH_KEYWORDS) {
        clauses.push(`${wh} NOT LIKE ?`);
        clauses.push(`UPPER(TRIM(COALESCE(${alias}.branch_id, ''))) NOT LIKE ?`);
        clauses.push(`UPPER(TRIM(COALESCE(${alias}.site_id, ''))) NOT LIKE ?`);
        params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    return { clauses, params };
}

function u(expr) {
    return `CONVERT(${expr} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
}

/**
 * Row source for stock queries, aliased `s`, with columns inventory_id, item_name, item_class,
 * warehouse_id, on_hand, available, last_sync, item_status (+ source when the ledger is live).
 */
async function stockSource({ erpOnly = false } = {}) {
    const { clauses, params } = baseWhere("s");
    const status = erpOnly ? { ready: false, liveBranches: [] } : await ledgerStatus();
    const live = status.ready ? status.liveBranches : [];
    if (!live.length) {
        return { from: `\`${STOCK_TABLE}\` s`, where: clauses, params, mixed: false, live: [] };
    }
    const erpIds = live.map((b) => b.erp);
    const erpSql = `SELECT ${u("TRIM(s.inventory_id)")} AS inventory_id, ${u("s.item_name")} AS item_name,
                           ${u("s.item_class")} AS item_class, ${u("UPPER(TRIM(s.warehouse_id))")} AS warehouse_id,
                           s.on_hand, s.available, s.last_sync, ${u("s.item_status")} AS item_status,
                           ${u("'erp'")} AS source
                      FROM \`${STOCK_TABLE}\` s
                     WHERE ${clauses.join(" AND ")}
                       AND UPPER(TRIM(s.warehouse_id)) NOT IN (${erpIds.map(() => "?").join(", ")})`;
    const ledgerSql = `SELECT ${u("p.sku")}, ${u("p.name")}, ${u("c.code")}, ${u("b.code")},
                              bal.qty_on_hand, bal.qty_on_hand - bal.qty_reserved,
                              CONVERT_TZ(COALESCE(bal.last_movement_at, b.live_since), '+00:00', '+08:00'),
                              ${u("IF(p.status = 'active', 'Active', 'Inactive')")}, ${u("'ledger'")}
                         FROM ${ledgerTable("inv_balances")} bal
                         JOIN ${ledgerTable("inv_products")} p ON p.id = bal.product_id
                         JOIN ${ledgerTable("inv_branches")} b ON b.id = bal.branch_id
                         LEFT JOIN ${ledgerTable("inv_categories")} c ON c.id = p.category_id
                        WHERE b.live_since IS NOT NULL AND b.status = 'active'`;
    return {
        from: `(${erpSql} UNION ALL ${ledgerSql}) s`,
        where: [],
        params: [...params, ...erpIds],
        mixed: true,
        live,
    };
}

/** Filters shared by list / summary / categories. */
function buildFilter(src, { branch = "", search = "", category = "", ids = null } = {}) {
    const clauses = [...src.where];
    const params = [...src.params];
    if (branch) {
        clauses.push("UPPER(TRIM(s.warehouse_id)) = ?");
        params.push(branch.toUpperCase());
    }
    if (search) {
        const like = `%${search.toUpperCase()}%`;
        clauses.push(`(UPPER(s.inventory_id) LIKE ? OR UPPER(COALESCE(s.item_name, '')) LIKE ?
            OR TRIM(s.inventory_id) IN (
                SELECT TRIM(c.inventory_id) FROM \`${STOCK_TABLE}\` c
                WHERE c.warehouse_id = '__catalog__' AND UPPER(COALESCE(c.item_name, '')) LIKE ?))`);
        params.push(like, like, like);
    }
    if (category) {
        clauses.push(`(UPPER(TRIM(COALESCE(s.item_class, ''))) = ?
            OR TRIM(s.inventory_id) IN (
                SELECT TRIM(c.inventory_id) FROM \`${STOCK_TABLE}\` c
                WHERE c.warehouse_id = '__catalog__' AND UPPER(TRIM(COALESCE(c.item_class, ''))) = ?))`);
        params.push(category.toUpperCase(), category.toUpperCase());
    }
    if (Array.isArray(ids)) {
        if (!ids.length) clauses.push("1 = 0");
        else {
            clauses.push(`UPPER(TRIM(s.inventory_id)) IN (${ids.map(() => "?").join(", ")})`);
            params.push(...ids.map((id) => String(id).toUpperCase()));
        }
    }
    return { where: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
}

/** The admin "Low stock below" setting when the ledger is set up, else LOW_STOCK_BELOW. */
export async function lowStockBelow() {
    try {
        if (!(await ledgerStatus()).ready) return LOW_STOCK_BELOW;
        const value = Number((await getSettings()).low_stock_default);
        return Number.isFinite(value) && value > 0 ? value : LOW_STOCK_BELOW;
    } catch (err) {
        console.warn("[KC Inventory] low stock setting", err?.message || err);
        return LOW_STOCK_BELOW;
    }
}

function statusHaving(status, limit) {
    if (status === "out_of_stock") return "HAVING on_hand <= 0";
    if (status === "low_stock") return `HAVING on_hand > 0 AND on_hand < ${limit}`;
    if (status === "healthy") return `HAVING on_hand >= ${limit}`;
    return "";
}

export function stockStatus(onHand, limit = LOW_STOCK_BELOW) {
    const qty = Number(onHand) || 0;
    if (qty <= 0) return "out_of_stock";
    if (qty < limit) return "low_stock";
    return "healthy";
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function iso(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Catalog name / class for ids whose warehouse rows have none. */
export async function catalogInfo(ids) {
    const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
    const out = new Map();
    if (!unique.length) return out;
    const [rows] = await getPool().query(
        `SELECT TRIM(inventory_id) AS id,
                MAX(NULLIF(TRIM(item_name), '')) AS name,
                MAX(NULLIF(TRIM(item_class), '')) AS cls
           FROM \`${STOCK_TABLE}\`
          WHERE TRIM(inventory_id) IN (${unique.map(() => "?").join(", ")})
          GROUP BY TRIM(inventory_id)`,
        unique
    );
    for (const r of rows) out.set(String(r.id).toUpperCase(), { name: r.name || "", itemClass: r.cls || "" });
    return out;
}

export function validateStatus(status) {
    if (!status) return "";
    if (!STOCK_STATUSES.includes(status)) {
        throw new HttpError(400, `Unknown stock status "${status}". Use ${STOCK_STATUSES.join(", ")}.`);
    }
    return status;
}

export async function listBranches() {
    const src = await stockSource();
    const { where, params } = buildFilter(src);
    const [rows] = await getPool().query(
        `SELECT UPPER(TRIM(s.warehouse_id)) AS id,
                COUNT(DISTINCT TRIM(s.inventory_id)) AS item_count,
                SUM(CASE WHEN COALESCE(s.on_hand, 0) > 0 THEN 1 ELSE 0 END) AS in_stock_count,
                SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                MAX(s.last_sync) AS last_sync
           FROM ${src.from}
          WHERE ${where}
          GROUP BY UPPER(TRIM(s.warehouse_id))
          ORDER BY (UPPER(TRIM(s.warehouse_id)) = 'MAIN') DESC, id ASC`,
        params
    );
    const live = new Set(src.live.map((b) => b.code));
    return rows.map((r) => ({
        id: r.id,
        name: r.id,
        itemCount: num(r.item_count),
        inStockCount: num(r.in_stock_count),
        onHand: num(r.on_hand),
        lastSync: iso(r.last_sync),
        live: live.has(String(r.id)),
    }));
}

export async function branchExists(branch) {
    const { clauses, params } = baseWhere("s");
    const [[row]] = await getPool().query(
        `SELECT 1 AS ok FROM \`${STOCK_TABLE}\` s
          WHERE ${clauses.join(" AND ")} AND UPPER(TRIM(s.warehouse_id)) = ? LIMIT 1`,
        [...params, branch.toUpperCase()]
    );
    return !!row;
}

function groupedSql(src, where) {
    return `SELECT TRIM(s.inventory_id) AS inventory_id,
                   MAX(NULLIF(TRIM(s.item_name), '')) AS item_name,
                   MAX(NULLIF(TRIM(s.item_class), '')) AS item_class,
                   SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                   SUM(COALESCE(s.available, s.on_hand, 0)) AS available,
                   COUNT(DISTINCT UPPER(TRIM(s.warehouse_id))) AS branch_count,
                   COUNT(DISTINCT CASE WHEN COALESCE(s.on_hand, 0) > 0 THEN UPPER(TRIM(s.warehouse_id)) END) AS branches_in_stock,
                   MAX(s.last_sync) AS last_sync
              FROM ${src.from}
             WHERE ${where}
             GROUP BY TRIM(s.inventory_id)`;
}

/**
 * KelinConnect CMS catalog size (Product Database "Total Items"), one per SKU. Read-only;
 * `null` when the CMS database is not reachable with this API's MySQL user.
 */
async function catalogProductCount() {
    const db = String(process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory").replace(/`/g, "");
    try {
        const [[row]] = await getPool().query(
            `SELECT COUNT(DISTINCT TRIM(inventory_id)) AS total
               FROM \`${db}\`.product_inventory_items
              WHERE deleted_at IS NULL AND TRIM(COALESCE(inventory_id, '')) <> ''`
        );
        return num(row?.total);
    } catch (err) {
        console.warn("[KC Inventory] catalog count unavailable", err?.code || err?.message || err);
        return null;
    }
}

export async function getSummary({ branch, search, category }) {
    const src = await stockSource();
    const { where, params } = buildFilter(src, { branch, search, category });
    const unfiltered = !branch && !search && !category;
    const catalogProducts = unfiltered ? await catalogProductCount() : null;
    const limit = await lowStockBelow();
    const [[row]] = await getPool().query(
        `SELECT COUNT(*) AS products,
                COALESCE(SUM(g.on_hand), 0) AS on_hand,
                COALESCE(SUM(g.available), 0) AS available,
                COALESCE(SUM(g.on_hand >= ${limit}), 0) AS healthy,
                COALESCE(SUM(g.on_hand > 0 AND g.on_hand < ${limit}), 0) AS low_stock,
                COALESCE(SUM(g.on_hand <= 0), 0) AS out_of_stock,
                MAX(g.last_sync) AS last_sync
           FROM (${groupedSql(src, where)}) g`,
        params
    );
    return {
        products: num(row?.products),
        catalogProducts,
        onHand: num(row?.on_hand),
        available: num(row?.available),
        healthy: num(row?.healthy),
        lowStock: num(row?.low_stock),
        outOfStock: num(row?.out_of_stock),
        lastSync: iso(row?.last_sync),
        lowStockBelow: limit,
        liveBranches: src.live.length,
        branchLive: !!branch && src.live.some((b) => b.code === branch.toUpperCase()),
    };
}

export async function listItems({ branch, search, category, status, page, pageSize, ids = null }) {
    const src = await stockSource();
    const { where, params } = buildFilter(src, { branch, search, category, ids });
    const limit = await lowStockBelow();
    const having = statusHaving(status, limit);
    const offset = (page - 1) * pageSize;
    const pool = getPool();
    const [rows] = await pool.query(
        `${groupedSql(src, where)} ${having} ORDER BY inventory_id ASC LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM (${groupedSql(src, where)} ${having}) t`,
        params
    );
    const missingInfo = rows.filter((r) => !r.item_name || !r.item_class).map((r) => r.inventory_id);
    const info = await catalogInfo(missingInfo);
    const total = num(countRow?.total);
    return {
        items: rows.map((r) => {
            const extra = info.get(String(r.inventory_id).toUpperCase()) || {};
            const onHand = num(r.on_hand);
            return {
                inventoryId: r.inventory_id,
                description: r.item_name || extra.name || "",
                itemClass: r.item_class || extra.itemClass || "",
                onHand,
                available: num(r.available),
                status: stockStatus(onHand, limit),
                branchCount: num(r.branch_count),
                branchesInStock: num(r.branches_in_stock),
                lastSync: iso(r.last_sync),
            };
        }),
        page,
        pageSize,
        totalCount: total,
        hasMore: offset + rows.length < total,
    };
}

/** Counts match what the item list shows for the same branch / search / status. */
export async function listCategories({ branch, search = "", status = "" }) {
    const src = await stockSource();
    const { where, params } = buildFilter(src, { branch, search });
    const limit = await lowStockBelow();
    const [rows] = await getPool().query(
        `SELECT COALESCE(g.item_class, c.cls, '') AS item_class, COUNT(*) AS item_count
           FROM (${groupedSql(src, where)} ${statusHaving(status, limit)}) g
           LEFT JOIN (
                SELECT TRIM(inventory_id) AS id, MAX(NULLIF(TRIM(item_class), '')) AS cls
                  FROM \`${STOCK_TABLE}\`
                 WHERE warehouse_id = '__catalog__'
                 GROUP BY TRIM(inventory_id)
           ) c ON c.id = g.inventory_id
          GROUP BY COALESCE(g.item_class, c.cls, '')
          ORDER BY item_class ASC`,
        params
    );
    return rows
        .filter((r) => String(r.item_class || "").trim())
        .map((r) => ({ id: r.item_class, name: r.item_class, itemCount: num(r.item_count) }));
}

export async function getItem(inventoryId) {
    const src = await stockSource();
    const { where, params } = buildFilter(src);
    const [rows] = await getPool().query(
        `SELECT UPPER(TRIM(s.warehouse_id)) AS branch,
                SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                SUM(COALESCE(s.available, s.on_hand, 0)) AS available,
                MAX(NULLIF(TRIM(s.item_name), '')) AS item_name,
                MAX(NULLIF(TRIM(s.item_class), '')) AS item_class,
                MAX(s.item_status) AS item_status,
                MAX(s.last_sync) AS last_sync,
                ${src.mixed ? "MAX(s.source)" : "'erp'"} AS source
           FROM ${src.from}
          WHERE ${where} AND UPPER(TRIM(s.inventory_id)) = ?
          GROUP BY UPPER(TRIM(s.warehouse_id))
          ORDER BY on_hand DESC, branch ASC`,
        [...params, inventoryId.toUpperCase()]
    );
    const info = (await catalogInfo([inventoryId])).get(inventoryId.toUpperCase());
    if (!rows.length && !info) throw new HttpError(404, `Item ${inventoryId} was not found.`);
    const limit = await lowStockBelow();

    const branches = rows.map((r) => ({
        branch: r.branch,
        onHand: num(r.on_hand),
        available: num(r.available),
        status: stockStatus(r.on_hand, limit),
        lastSync: iso(r.last_sync),
        source: r.source,
    }));
    const onHand = branches.reduce((sum, b) => sum + b.onHand, 0);
    const first = rows[0] || {};
    return {
        inventoryId: inventoryId.toUpperCase(),
        description: first.item_name || info?.name || "",
        itemClass: first.item_class || info?.itemClass || "",
        itemStatus: first.item_status || "",
        onHand,
        available: branches.reduce((sum, b) => sum + b.available, 0),
        status: stockStatus(onHand, limit),
        branchCount: branches.length,
        branchesInStock: branches.filter((b) => b.onHand > 0).length,
        lastSync: branches.reduce((latest, b) => (b.lastSync && (!latest || b.lastSync > latest) ? b.lastSync : latest), null),
        branches,
    };
}

/** Acumatica quantity per item at one warehouse (read-only, for the ERP comparison). */
export async function erpQuantities(warehouse) {
    const { clauses, params } = baseWhere("s");
    const [rows] = await getPool().query(
        `SELECT UPPER(TRIM(s.inventory_id)) AS id, SUM(COALESCE(s.on_hand, 0)) AS on_hand, MAX(s.last_sync) AS last_sync
           FROM \`${STOCK_TABLE}\` s
          WHERE ${clauses.join(" AND ")} AND UPPER(TRIM(s.warehouse_id)) = ?
          GROUP BY UPPER(TRIM(s.inventory_id))`,
        [...params, String(warehouse).toUpperCase()]
    );
    return new Map(rows.map((r) => [r.id, { onHand: num(r.on_hand), lastSync: iso(r.last_sync) }]));
}

/** Snapshot rows for a physical count (first version, Acumatica stock): one per item at the branch. */
export async function snapshotForCount({ branch, category, includeZero }) {
    const src = await stockSource({ erpOnly: true });
    const { where, params } = buildFilter(src, { branch, category });
    const having = includeZero ? "" : "HAVING on_hand <> 0";
    const [rows] = await getPool().query(
        `${groupedSql(src, where)} ${having} ORDER BY inventory_id ASC LIMIT 20000`,
        params
    );
    const info = await catalogInfo(rows.filter((r) => !r.item_name || !r.item_class).map((r) => r.inventory_id));
    return rows.map((r) => {
        const extra = info.get(String(r.inventory_id).toUpperCase()) || {};
        return {
            inventoryId: r.inventory_id,
            description: r.item_name || extra.name || "",
            itemClass: r.item_class || extra.itemClass || "",
            systemQty: num(r.on_hand),
        };
    });
}
