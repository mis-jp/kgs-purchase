import { getPool, COUNT_SESSIONS_TABLE, COUNT_LINES_TABLE } from "./db";
import { HttpError } from "./http";
import { branchExists, snapshotForCount } from "./stock";

/**
 * Physical counts owned by the KelinConnect Inventory module (db_purchase, kc_* tables).
 * A count snapshots the system on-hand of every item at one branch; staff then record
 * what they physically find. Stock itself is never changed (Acumatica owns it).
 */

export const LINE_FILTERS = ["all", "pending", "matched", "short", "over", "missing"];
const READY_KEY = "__kcInventoryCountTablesReady";

export async function ensureCountTables() {
    if (globalThis[READY_KEY]) return;
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS \`${COUNT_SESSIONS_TABLE}\` (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          branch_id VARCHAR(100) NOT NULL,
          category VARCHAR(100) NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'open',
          note VARCHAR(500) NULL,
          started_by_login_id VARCHAR(100) NOT NULL,
          started_by_name VARCHAR(160) NULL,
          submitted_by_login_id VARCHAR(100) NULL,
          submitted_by_name VARCHAR(160) NULL,
          item_count INT NOT NULL DEFAULT 0,
          counted_count INT NOT NULL DEFAULT 0,
          matched_count INT NOT NULL DEFAULT 0,
          short_count INT NOT NULL DEFAULT 0,
          over_count INT NOT NULL DEFAULT 0,
          missing_count INT NOT NULL DEFAULT 0,
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          submitted_at DATETIME NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_kcic_branch_status (branch_id, status),
          KEY idx_kcic_started (started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS \`${COUNT_LINES_TABLE}\` (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          session_id INT UNSIGNED NOT NULL,
          inventory_id VARCHAR(100) NOT NULL,
          description VARCHAR(255) NULL,
          item_class VARCHAR(100) NULL,
          system_qty DECIMAL(18,4) NOT NULL DEFAULT 0,
          counted_qty DECIMAL(18,4) NULL,
          is_missing TINYINT(1) NOT NULL DEFAULT 0,
          note VARCHAR(500) NULL,
          counted_by_login_id VARCHAR(100) NULL,
          counted_by_name VARCHAR(160) NULL,
          counted_at DATETIME NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_kcicl_session_item (session_id, inventory_id),
          KEY idx_kcicl_session (session_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    globalThis[READY_KEY] = true;
}

/** SQL expression for a line's result. */
const LINE_STATE_SQL = `CASE
    WHEN l.is_missing = 1 THEN 'missing'
    WHEN l.counted_qty IS NULL THEN 'pending'
    WHEN l.counted_qty = l.system_qty THEN 'matched'
    WHEN l.counted_qty < l.system_qty THEN 'short'
    ELSE 'over' END`;

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function iso(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapSession(r) {
    const itemCount = num(r.item_count);
    const counted = num(r.counted_count);
    return {
        id: num(r.id),
        branch: r.branch_id,
        category: r.category || "",
        status: r.status,
        note: r.note || "",
        startedBy: { loginId: r.started_by_login_id, name: r.started_by_name || r.started_by_login_id },
        submittedBy: r.submitted_by_login_id
            ? { loginId: r.submitted_by_login_id, name: r.submitted_by_name || r.submitted_by_login_id }
            : null,
        itemCount,
        countedCount: counted,
        pendingCount: Math.max(0, itemCount - counted),
        matchedCount: num(r.matched_count),
        shortCount: num(r.short_count),
        overCount: num(r.over_count),
        missingCount: num(r.missing_count),
        startedAt: iso(r.started_at),
        submittedAt: iso(r.submitted_at),
        updatedAt: iso(r.updated_at),
    };
}

function mapLine(r) {
    const counted = r.counted_qty === null || r.counted_qty === undefined ? null : num(r.counted_qty);
    const system = num(r.system_qty);
    const missing = num(r.is_missing) === 1;
    return {
        inventoryId: r.inventory_id,
        description: r.description || "",
        itemClass: r.item_class || "",
        systemQty: system,
        countedQty: missing ? 0 : counted,
        missing,
        variance: missing ? -system : counted === null ? null : counted - system,
        state: r.state,
        note: r.note || "",
        countedBy: r.counted_by_login_id
            ? { loginId: r.counted_by_login_id, name: r.counted_by_name || r.counted_by_login_id }
            : null,
        countedAt: iso(r.counted_at),
    };
}

async function loadSession(id, conn = getPool()) {
    const [[row]] = await conn.query(`SELECT * FROM \`${COUNT_SESSIONS_TABLE}\` WHERE id = ?`, [id]);
    if (!row) throw new HttpError(404, `Count #${id} was not found.`);
    return row;
}

async function refreshTotals(id, conn = getPool()) {
    await conn.query(
        `UPDATE \`${COUNT_SESSIONS_TABLE}\` s
           JOIN (
                SELECT l.session_id,
                       COUNT(*) AS item_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} <> 'pending' THEN 1 ELSE 0 END) AS counted_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'matched' THEN 1 ELSE 0 END) AS matched_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'short' THEN 1 ELSE 0 END) AS short_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'over' THEN 1 ELSE 0 END) AS over_count,
                       SUM(CASE WHEN ${LINE_STATE_SQL} = 'missing' THEN 1 ELSE 0 END) AS missing_count
                  FROM \`${COUNT_LINES_TABLE}\` l
                 WHERE l.session_id = ?
                 GROUP BY l.session_id
           ) t ON t.session_id = s.id
            SET s.item_count = t.item_count,
                s.counted_count = t.counted_count,
                s.matched_count = t.matched_count,
                s.short_count = t.short_count,
                s.over_count = t.over_count,
                s.missing_count = t.missing_count
          WHERE s.id = ?`,
        [id, id]
    );
}

export async function listCounts({ branch, status, limit }) {
    await ensureCountTables();
    const where = [];
    const params = [];
    if (branch) {
        where.push("branch_id = ?");
        params.push(branch);
    }
    if (status) {
        where.push("status = ?");
        params.push(status);
    }
    const [rows] = await getPool().query(
        `SELECT * FROM \`${COUNT_SESSIONS_TABLE}\`
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY (status = 'open') DESC, started_at DESC, id DESC
          LIMIT ${limit}`,
        params
    );
    return rows.map(mapSession);
}

export async function countActivity() {
    await ensureCountTables();
    const [[row]] = await getPool().query(
        `SELECT SUM(status = 'open') AS open_counts,
                SUM(CASE WHEN status = 'submitted' AND submitted_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                         THEN short_count + over_count + missing_count ELSE 0 END) AS discrepancies_30d,
                MAX(CASE WHEN status = 'submitted' THEN submitted_at END) AS last_submitted_at
           FROM \`${COUNT_SESSIONS_TABLE}\``
    );
    return {
        openCounts: num(row?.open_counts),
        discrepancies30d: num(row?.discrepancies_30d),
        lastCountAt: iso(row?.last_submitted_at),
    };
}

export async function startCount({ branch, category, note, includeZero, user }) {
    await ensureCountTables();
    if (!branch) throw new HttpError(400, "Pick a branch to count.");
    if (!(await branchExists(branch))) throw new HttpError(404, `Branch ${branch} has no synced stock.`);

    const lines = await snapshotForCount({ branch, category, includeZero });
    if (!lines.length) {
        throw new HttpError(400, category
            ? `No ${category} items with stock at ${branch}.`
            : `No items with stock at ${branch}.`);
    }

    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        const [ins] = await conn.query(
            `INSERT INTO \`${COUNT_SESSIONS_TABLE}\`
                (branch_id, category, status, note, started_by_login_id, started_by_name, item_count)
             VALUES (?, ?, 'open', ?, ?, ?, ?)`,
            [branch, category || null, note || null, user.loginId, user.name, lines.length]
        );
        const sessionId = ins.insertId;
        for (let i = 0; i < lines.length; i += 500) {
            const chunk = lines.slice(i, i + 500);
            await conn.query(
                `INSERT INTO \`${COUNT_LINES_TABLE}\`
                    (session_id, inventory_id, description, item_class, system_qty)
                 VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
                chunk.flatMap((l) => [sessionId, l.inventoryId, l.description, l.itemClass, l.systemQty])
            );
        }
        await conn.commit();
        return mapSession(await loadSession(sessionId));
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

export async function getCount(id, { filter, search, page, pageSize }) {
    await ensureCountTables();
    const session = mapSession(await loadSession(id));
    const where = ["l.session_id = ?"];
    const params = [id];
    if (filter && filter !== "all") {
        where.push(`${LINE_STATE_SQL} = ?`);
        params.push(filter);
    }
    if (search) {
        const like = `%${search.toUpperCase()}%`;
        where.push("(UPPER(l.inventory_id) LIKE ? OR UPPER(COALESCE(l.description, '')) LIKE ?)");
        params.push(like, like);
    }
    const offset = (page - 1) * pageSize;
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT l.*, ${LINE_STATE_SQL} AS state
           FROM \`${COUNT_LINES_TABLE}\` l
          WHERE ${where.join(" AND ")}
          ORDER BY (${LINE_STATE_SQL} = 'pending') DESC, l.inventory_id ASC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM \`${COUNT_LINES_TABLE}\` l WHERE ${where.join(" AND ")}`,
        params
    );
    const total = num(countRow?.total);
    return {
        count: session,
        lines: rows.map(mapLine),
        page,
        pageSize,
        totalCount: total,
        hasMore: offset + rows.length < total,
    };
}

function requireOpen(row) {
    if (row.status !== "open") {
        throw new HttpError(409, `Count #${row.id} is already ${row.status}. Start a new count to make changes.`);
    }
}

export async function saveLines(id, lines, user) {
    await ensureCountTables();
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, "Nothing to save.");
    if (lines.length > 500) throw new HttpError(400, "Save at most 500 lines at a time.");

    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        const row = await loadSession(id, conn);
        requireOpen(row);
        let updated = 0;
        for (const raw of lines) {
            const inventoryId = String(raw?.inventoryId || "").trim();
            if (!inventoryId) continue;
            const missing = raw?.missing === true;
            const clear = raw?.clear === true;
            let counted = null;
            if (!missing && !clear) {
                counted = Number(raw?.countedQty);
                if (!Number.isFinite(counted) || counted < 0) {
                    throw new HttpError(400, `Counted quantity for ${inventoryId} must be zero or more.`);
                }
            }
            const note = raw?.note === undefined ? null : String(raw.note || "").trim().slice(0, 500);
            const [res] = await conn.query(
                `UPDATE \`${COUNT_LINES_TABLE}\`
                    SET counted_qty = ?,
                        is_missing = ?,
                        note = COALESCE(?, note),
                        counted_by_login_id = ?,
                        counted_by_name = ?,
                        counted_at = ?
                  WHERE session_id = ? AND inventory_id = ?`,
                [
                    clear ? null : (missing ? 0 : counted),
                    missing ? 1 : 0,
                    note,
                    clear ? null : user.loginId,
                    clear ? null : user.name,
                    clear ? null : new Date(),
                    id,
                    inventoryId,
                ]
            );
            updated += res.affectedRows || 0;
        }
        await refreshTotals(id, conn);
        await conn.commit();
        return { updated, count: mapSession(await loadSession(id)) };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

export async function submitCount(id, user) {
    await ensureCountTables();
    const row = await loadSession(id);
    requireOpen(row);
    await refreshTotals(id);
    await getPool().query(
        `UPDATE \`${COUNT_SESSIONS_TABLE}\`
            SET status = 'submitted', submitted_at = NOW(),
                submitted_by_login_id = ?, submitted_by_name = ?
          WHERE id = ? AND status = 'open'`,
        [user.loginId, user.name, id]
    );
    return mapSession(await loadSession(id));
}

export async function cancelCount(id, user) {
    await ensureCountTables();
    const row = await loadSession(id);
    requireOpen(row);
    if (row.started_by_login_id !== user.loginId) {
        throw new HttpError(403, `Only ${row.started_by_name || row.started_by_login_id} can cancel this count.`);
    }
    await getPool().query(
        `UPDATE \`${COUNT_SESSIONS_TABLE}\` SET status = 'cancelled' WHERE id = ? AND status = 'open'`,
        [id]
    );
    return mapSession(await loadSession(id));
}
