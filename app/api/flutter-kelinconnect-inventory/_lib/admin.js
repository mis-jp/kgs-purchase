import { randomUUID } from "node:crypto";
import { ECOM_BRANCH_ALIASES, EXCLUDED_BRANCH_KEYWORDS } from "@/lib/companies";
import { HttpError } from "./errors.js";
import { getLedgerPool, invalidateLedgerStatus, PURCHASE_DB, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertAdmin } from "./members.js";
import { clearSettingsCache, findBranch, mapBranch, nextNumber } from "./ledger.js";
import { adminLoginIds, iso, num, ROLES } from "./rules.js";

/** Admin tools: users and branch access, settings, master-data import, branch go-live. */

const CMS_DB = /^[A-Za-z0-9_]+$/.test(String(process.env.MYSQL_INVENTORY_DATABASE || ""))
    ? process.env.MYSQL_INVENTORY_DATABASE
    : "db_kelin_inventory";
export const STOCK = `\`${PURCHASE_DB}\`.\`forecast_item_stock\``;
const ECOM = [...ECOM_BRANCH_ALIASES];

/** Same row rules as stock.js baseWhere, for read-only imports from Purchase. */
export function erpRowsWhere(alias = "s") {
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
        params.push(`%${kw}%`);
    }
    return { where: clauses.join(" AND "), params };
}

function mapUser(r, branches) {
    return {
        loginId: r.login_id,
        name: r.full_name || r.login_id,
        role: r.role,
        allBranches: Number(r.all_branches) === 1,
        status: r.status,
        branches,
        lastSeenAt: iso(r.last_seen_at),
        bootstrapAdmin: adminLoginIds().has(String(r.login_id).toUpperCase()),
    };
}

export async function listUsers(member, { search }, request) {
    assertAdmin(member, request, "user.list");
    const params = [];
    let where = "";
    if (search) {
        where = "WHERE UPPER(u.login_id) LIKE ? OR UPPER(COALESCE(u.full_name, '')) LIKE ?";
        params.push(`%${search.toUpperCase()}%`, `%${search.toUpperCase()}%`);
    }
    const pool = getLedgerPool();
    const [users] = await pool.query(
        `SELECT u.* FROM inv_users u ${where}
          ORDER BY FIELD(u.role, 'admin', 'manager', 'staff', 'viewer'), u.full_name LIMIT 500`,
        params
    );
    const [links] = await pool.query(
        "SELECT ub.user_id, b.code FROM inv_user_branches ub JOIN inv_branches b ON b.id = ub.branch_id"
    );
    const byUser = new Map();
    for (const l of links) {
        if (!byUser.has(Number(l.user_id))) byUser.set(Number(l.user_id), []);
        byUser.get(Number(l.user_id)).push(l.code);
    }
    return users.map((u) => mapUser(u, byUser.get(Number(u.id)) || []));
}

/** Create or update a user's role / branch access (admins only). */
export async function saveUser(member, loginIdRaw, body, request) {
    assertAdmin(member, request, "user.role_change");
    const loginId = String(loginIdRaw || "").trim().toUpperCase();
    if (!/^[A-Z0-9._-]{2,50}$/.test(loginId)) throw new HttpError(400, "Enter a valid KelinConnect login id (e.g. KG0751).");
    const role = body.role === undefined ? undefined : String(body.role);
    if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(", ")}.`);
    if (loginId === member.loginId && role !== undefined && role !== "admin") {
        throw new HttpError(409, "You cannot remove your own admin role. Ask another admin.");
    }
    if (adminLoginIds().has(loginId) && role !== undefined && role !== "admin") {
        throw new HttpError(409, `${loginId} is a bootstrap admin (KC_INVENTORY_ADMIN_LOGIN_IDS). Change the server setting first.`);
    }
    const status = body.status === undefined ? undefined : body.status === "inactive" ? "inactive" : "active";
    if (loginId === member.loginId && status === "inactive") throw new HttpError(409, "You cannot turn off your own access.");

    await withLedgerTx(async (conn) => {
        const [[before]] = await conn.query("SELECT * FROM inv_users WHERE login_id = ? FOR UPDATE", [loginId]);
        let userId = before?.id;
        if (!before) {
            const [res] = await conn.query(
                "INSERT INTO inv_users (login_id, full_name, role, all_branches, status, created_by) VALUES (?, ?, ?, ?, ?, ?)",
                [loginId, String(body.name || "").trim().slice(0, 160) || null, role || "viewer",
                    body.allBranches === true ? 1 : 0, status || "active", member.loginId]
            );
            userId = res.insertId;
        } else {
            await conn.query(
                `UPDATE inv_users SET role = COALESCE(?, role), all_branches = COALESCE(?, all_branches),
                        status = COALESCE(?, status), full_name = COALESCE(?, full_name)
                  WHERE id = ?`,
                [role ?? null, body.allBranches === undefined ? null : (body.allBranches === true ? 1 : 0),
                    status ?? null, String(body.name || "").trim().slice(0, 160) || null, userId]
            );
        }
        let branchCodes;
        if (Array.isArray(body.branches)) {
            branchCodes = [...new Set(body.branches.map((b) => String(b).trim().toUpperCase()).filter(Boolean))];
            const ids = [];
            for (const code of branchCodes) ids.push((await findBranch(conn, code)).id);
            await conn.query("DELETE FROM inv_user_branches WHERE user_id = ?", [userId]);
            for (const id of ids) {
                await conn.query("INSERT INTO inv_user_branches (user_id, branch_id) VALUES (?, ?)", [userId, id]);
            }
        }
        await writeAudit(conn, member, {
            action: Array.isArray(body.branches) ? "user.branch_access_change" : "user.role_change",
            entityType: "user", entityId: loginId, request,
            details: {
                before: before ? { role: before.role, allBranches: Number(before.all_branches) === 1, status: before.status } : null,
                after: { role: role ?? before?.role ?? "viewer", allBranches: body.allBranches, status, branches: branchCodes },
            },
        });
    });
    const users = await listUsers(member, { search: loginId }, request);
    return users.find((u) => u.loginId === loginId) || null;
}

export async function listSettings() {
    const [rows] = await getLedgerPool().query("SELECT * FROM inv_settings ORDER BY setting_key");
    return rows.map((r) => ({
        key: r.setting_key, value: r.setting_value, description: r.description || "",
        updatedBy: r.updated_by || null, updatedAt: iso(r.updated_at),
    }));
}

export async function saveSettings(member, values, request) {
    assertAdmin(member, request, "settings.update");
    if (!values || typeof values !== "object") throw new HttpError(400, "Nothing to save.");
    await withLedgerTx(async (conn) => {
        const [rows] = await conn.query("SELECT setting_key, setting_value FROM inv_settings");
        const known = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
        const changes = {};
        for (const [key, raw] of Object.entries(values)) {
            if (!known.has(key)) throw new HttpError(400, `Unknown setting ${key}.`);
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key} must be a number, zero or more.`);
            await conn.query("UPDATE inv_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?",
                [String(n), member.loginId, key]);
            changes[key] = { before: known.get(key), after: String(n) };
        }
        await writeAudit(conn, member, { action: "settings.update", entityType: "settings", request, details: changes });
    });
    clearSettingsCache();
    return listSettings();
}

export async function adminBranches() {
    const [rows] = await getLedgerPool().query(
        `SELECT b.*,
                (SELECT COUNT(*) FROM inv_balances bal WHERE bal.branch_id = b.id AND bal.qty_on_hand > 0) AS items_in_stock,
                (SELECT COUNT(*) FROM inv_locations l WHERE l.branch_id = b.id AND l.status = 'active') AS locations
           FROM inv_branches b
          ORDER BY (b.live_since IS NULL), b.code`
    );
    return rows.map((r) => ({ ...mapBranch(r), itemsInStock: num(r.items_in_stock), locations: num(r.locations) }));
}

/** Copy branches, categories and products from Purchase / Kelin inventory (read-only sources). Re-runnable. */
export async function importMasterData(member, request) {
    assertAdmin(member, request, "admin.import");
    const { where, params } = erpRowsWhere("s");
    const pool = getLedgerPool();
    const [branches] = await pool.query(
        `INSERT INTO inv_branches (code, name, type, erp_warehouse_id, status)
         SELECT w.wh,
                COALESCE(MAX(NULLIF(TRIM(b.branch_name), '')), w.wh),
                CASE WHEN w.wh LIKE '%WAREHOUSE%' OR w.wh LIKE '% WH%' OR w.wh LIKE 'WH%' THEN 'warehouse' ELSE 'branch' END,
                w.wh, 'active'
           FROM (SELECT DISTINCT CONVERT(UPPER(TRIM(s.warehouse_id)) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS wh
                   FROM ${STOCK} s WHERE ${where}) w
           LEFT JOIN \`${CMS_DB}\`.\`branches\` b
             ON CONVERT(UPPER(TRIM(b.branch_id)) USING utf8mb4) COLLATE utf8mb4_unicode_ci = w.wh
          GROUP BY w.wh
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        params
    );
    const [categories] = await pool.query(
        `INSERT INTO inv_categories (code, name)
         SELECT DISTINCT TRIM(item_class), TRIM(item_class) FROM ${STOCK}
          WHERE TRIM(COALESCE(item_class, '')) <> ''
         ON DUPLICATE KEY UPDATE name = inv_categories.name`
    );
    const [products] = await pool.query(
        `INSERT INTO inv_products (sku, name, category_id, unit_code, erp_inventory_id, status, created_by)
         SELECT x.inv, COALESCE(x.item_name, x.inv), c.id, 'PC', x.inv,
                CASE WHEN LOWER(COALESCE(x.item_status, '')) = 'inactive' THEN 'inactive' ELSE 'active' END, 'import'
           FROM (SELECT CONVERT(TRIM(inventory_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS inv,
                        MAX(NULLIF(TRIM(item_name), '')) AS item_name,
                        CONVERT(MAX(NULLIF(TRIM(item_class), '')) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS item_class,
                        MAX(item_status) AS item_status
                   FROM ${STOCK} WHERE TRIM(COALESCE(inventory_id, '')) <> ''
                  GROUP BY inv) x
           LEFT JOIN inv_categories c ON c.code = x.item_class
         ON DUPLICATE KEY UPDATE name = VALUES(name), category_id = VALUES(category_id), status = VALUES(status)`
    );
    const summary = {
        branchesAffected: branches.affectedRows,
        categoriesAffected: categories.affectedRows,
        productsAffected: products.affectedRows,
    };
    await writeAudit(null, member, { action: "admin.import", entityType: "import", request, details: summary });
    invalidateLedgerStatus();
    const [[totals]] = await pool.query(
        `SELECT (SELECT COUNT(*) FROM inv_branches) AS branches, (SELECT COUNT(*) FROM inv_categories) AS categories,
                (SELECT COUNT(*) FROM inv_products) AS products`
    );
    return { ...summary, branches: num(totals.branches), categories: num(totals.categories), products: num(totals.products) };
}

/** Start a branch on the ledger: opening balance = Acumatica on-hand right now. Once per branch. */
export async function goLive(member, code, request) {
    assertAdmin(member, request, "branch.go_live");
    const { where, params } = erpRowsWhere("s");
    const result = await withLedgerTx(async (conn) => {
        const branch = await findBranch(conn, code);
        const [[row]] = await conn.query("SELECT * FROM inv_branches WHERE id = ? FOR UPDATE", [branch.id]);
        if (row.live_since) throw new HttpError(409, `${branch.name} is already live since ${iso(row.live_since)}.`);
        const [[used]] = await conn.query("SELECT COUNT(*) AS n FROM inv_balances WHERE branch_id = ?", [branch.id]);
        if (num(used.n) > 0) throw new HttpError(409, `${branch.name} already has stock rows. It cannot get an opening balance twice.`);
        const erp = String(row.erp_warehouse_id || row.code).toUpperCase();

        await conn.query(
            `INSERT IGNORE INTO inv_products (sku, name, unit_code, erp_inventory_id, status, created_by)
             SELECT x.inv, COALESCE(x.item_name, x.inv), 'PC', x.inv, 'active', 'go-live'
               FROM (SELECT CONVERT(TRIM(s.inventory_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS inv,
                            MAX(NULLIF(TRIM(s.item_name), '')) AS item_name
                       FROM ${STOCK} s WHERE ${where} AND UPPER(TRIM(s.warehouse_id)) = ?
                      GROUP BY inv) x`,
            [...params, erp]
        );

        const number = await nextNumber(conn, "OPN");
        const [txn] = await conn.query(
            `INSERT INTO inv_transactions (txn_number, type, branch_id, status, reason_code, notes, request_id, created_by, created_by_name)
             VALUES (?, 'opening', ?, 'completed', 'OPENING_BALANCE', ?, ?, ?, ?)`,
            [number, branch.id, `Opening balance copied from Acumatica (${PURCHASE_DB}.forecast_item_stock, warehouse ${erp})`,
                randomUUID(), member.loginId, member.name]
        );
        const [lines] = await conn.query(
            `INSERT INTO inv_transaction_lines (transaction_id, branch_id, product_id, qty_change, qty_before, qty_after)
             SELECT ?, ?, p.id, x.qty, 0, x.qty
               FROM (SELECT CONVERT(TRIM(s.inventory_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS inv,
                            SUM(GREATEST(COALESCE(s.on_hand, 0), 0)) AS qty
                       FROM ${STOCK} s WHERE ${where} AND UPPER(TRIM(s.warehouse_id)) = ?
                      GROUP BY inv) x
               JOIN inv_products p ON p.erp_inventory_id = x.inv
              WHERE x.qty > 0`,
            [txn.insertId, branch.id, ...params, erp]
        );
        await conn.query(
            `INSERT INTO inv_balances (product_id, branch_id, qty_on_hand, last_movement_at)
             SELECT product_id, branch_id, qty_after, UTC_TIMESTAMP() FROM inv_transaction_lines WHERE transaction_id = ?`,
            [txn.insertId]
        );
        await conn.query("UPDATE inv_branches SET live_since = UTC_TIMESTAMP() WHERE id = ?", [branch.id]);
        await writeAudit(conn, member, {
            action: "branch.go_live", entityType: "branch", entityId: branch.id, branchId: branch.id,
            transactionId: txn.insertId, request, details: { number, erpWarehouse: erp, lines: lines.affectedRows },
        });
        return { branch: branch.code, openingNumber: number, items: lines.affectedRows };
    });
    invalidateLedgerStatus();
    return result;
}
