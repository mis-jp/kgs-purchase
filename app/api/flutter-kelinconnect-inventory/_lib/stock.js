import { ECOM_BRANCH_ALIASES, EXCLUDED_BRANCH_KEYWORDS } from "@/lib/companies";
import { getPool, STOCK_TABLE } from "./db";
import { HttpError } from "./http";

/**
 * Read-only stock queries on Purchase-owned `forecast_item_stock`
 * (Acumatica multi-warehouse sync). One row per company / item / warehouse;
 * `__catalog__` rows only carry the item name and class.
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

/** Filters shared by list / summary / categories. */
function buildFilter({ branch = "", search = "", category = "" } = {}) {
    const { clauses, params } = baseWhere("s");
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
    return { where: clauses.join(" AND "), params };
}

function statusHaving(status) {
    if (status === "out_of_stock") return "HAVING on_hand <= 0";
    if (status === "low_stock") return `HAVING on_hand > 0 AND on_hand < ${LOW_STOCK_BELOW}`;
    if (status === "healthy") return `HAVING on_hand >= ${LOW_STOCK_BELOW}`;
    return "";
}

export function stockStatus(onHand) {
    const qty = Number(onHand) || 0;
    if (qty <= 0) return "out_of_stock";
    if (qty < LOW_STOCK_BELOW) return "low_stock";
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
    const { clauses, params } = baseWhere("s");
    const [rows] = await getPool().query(
        `SELECT UPPER(TRIM(s.warehouse_id)) AS id,
                COUNT(DISTINCT TRIM(s.inventory_id)) AS item_count,
                SUM(CASE WHEN COALESCE(s.on_hand, 0) > 0 THEN 1 ELSE 0 END) AS in_stock_count,
                SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                MAX(s.last_sync) AS last_sync
           FROM \`${STOCK_TABLE}\` s
          WHERE ${clauses.join(" AND ")}
          GROUP BY UPPER(TRIM(s.warehouse_id))
          ORDER BY (UPPER(TRIM(s.warehouse_id)) = 'MAIN') DESC, id ASC`,
        params
    );
    return rows.map((r) => ({
        id: r.id,
        name: r.id,
        itemCount: num(r.item_count),
        inStockCount: num(r.in_stock_count),
        onHand: num(r.on_hand),
        lastSync: iso(r.last_sync),
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

function groupedSql(where) {
    return `SELECT TRIM(s.inventory_id) AS inventory_id,
                   MAX(NULLIF(TRIM(s.item_name), '')) AS item_name,
                   MAX(NULLIF(TRIM(s.item_class), '')) AS item_class,
                   SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                   SUM(COALESCE(s.available, s.on_hand, 0)) AS available,
                   COUNT(DISTINCT UPPER(TRIM(s.warehouse_id))) AS branch_count,
                   COUNT(DISTINCT CASE WHEN COALESCE(s.on_hand, 0) > 0 THEN UPPER(TRIM(s.warehouse_id)) END) AS branches_in_stock,
                   MAX(s.last_sync) AS last_sync
              FROM \`${STOCK_TABLE}\` s
             WHERE ${where}
             GROUP BY TRIM(s.inventory_id)`;
}

export async function getSummary({ branch, search, category }) {
    const { where, params } = buildFilter({ branch, search, category });
    const [[row]] = await getPool().query(
        `SELECT COUNT(*) AS products,
                COALESCE(SUM(g.on_hand), 0) AS on_hand,
                COALESCE(SUM(g.available), 0) AS available,
                COALESCE(SUM(g.on_hand >= ${LOW_STOCK_BELOW}), 0) AS healthy,
                COALESCE(SUM(g.on_hand > 0 AND g.on_hand < ${LOW_STOCK_BELOW}), 0) AS low_stock,
                COALESCE(SUM(g.on_hand <= 0), 0) AS out_of_stock,
                MAX(g.last_sync) AS last_sync
           FROM (${groupedSql(where)}) g`,
        params
    );
    return {
        products: num(row?.products),
        onHand: num(row?.on_hand),
        available: num(row?.available),
        healthy: num(row?.healthy),
        lowStock: num(row?.low_stock),
        outOfStock: num(row?.out_of_stock),
        lastSync: iso(row?.last_sync),
        lowStockBelow: LOW_STOCK_BELOW,
    };
}

export async function listItems({ branch, search, category, status, page, pageSize }) {
    const { where, params } = buildFilter({ branch, search, category });
    const having = statusHaving(status);
    const offset = (page - 1) * pageSize;
    const pool = getPool();
    const [rows] = await pool.query(
        `${groupedSql(where)} ${having} ORDER BY inventory_id ASC LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM (${groupedSql(where)} ${having}) t`,
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
                status: stockStatus(onHand),
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

export async function listCategories({ branch }) {
    const { where, params } = buildFilter({ branch });
    const [rows] = await getPool().query(
        `SELECT COALESCE(g.item_class, c.cls, '') AS item_class, COUNT(*) AS item_count
           FROM (${groupedSql(where)}) g
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
    const { clauses, params } = baseWhere("s");
    const [rows] = await getPool().query(
        `SELECT UPPER(TRIM(s.warehouse_id)) AS branch,
                SUM(COALESCE(s.on_hand, 0)) AS on_hand,
                SUM(COALESCE(s.available, s.on_hand, 0)) AS available,
                MAX(NULLIF(TRIM(s.item_name), '')) AS item_name,
                MAX(NULLIF(TRIM(s.item_class), '')) AS item_class,
                MAX(s.item_status) AS item_status,
                MAX(s.last_sync) AS last_sync
           FROM \`${STOCK_TABLE}\` s
          WHERE ${clauses.join(" AND ")} AND UPPER(TRIM(s.inventory_id)) = ?
          GROUP BY UPPER(TRIM(s.warehouse_id))
          ORDER BY on_hand DESC, branch ASC`,
        [...params, inventoryId.toUpperCase()]
    );
    const info = (await catalogInfo([inventoryId])).get(inventoryId.toUpperCase());
    if (!rows.length && !info) throw new HttpError(404, `Item ${inventoryId} was not found.`);

    const branches = rows.map((r) => ({
        branch: r.branch,
        onHand: num(r.on_hand),
        available: num(r.available),
        status: stockStatus(r.on_hand),
        lastSync: iso(r.last_sync),
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
        status: stockStatus(onHand),
        branchCount: branches.length,
        branchesInStock: branches.filter((b) => b.onHand > 0).length,
        lastSync: branches.reduce((latest, b) => (b.lastSync && (!latest || b.lastSync > latest) ? b.lastSync : latest), null),
        branches,
    };
}

/** Snapshot rows for a physical count: one per item at the branch (optionally one class). */
export async function snapshotForCount({ branch, category, includeZero }) {
    const { where, params } = buildFilter({ branch, category });
    const having = includeZero ? "" : "HAVING on_hand <> 0";
    const [rows] = await getPool().query(
        `${groupedSql(where)} ${having} ORDER BY inventory_id ASC LIMIT 20000`,
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
