/**
 * Grant Flutter Inventory staff access for one login id at one branch.
 *
 *   node scripts/grant-kc-inventory-staff.mjs KC0035 BACOLOD "Carmel Gilaga Langomez"
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const loginId = String(process.argv[2] || "").trim().toUpperCase();
const branchCode = String(process.argv[3] || "").trim().toUpperCase();
const fullName = String(process.argv[4] || "").trim() || null;
if (!loginId || !branchCode) {
    console.error('Usage: node scripts/grant-kc-inventory-staff.mjs <LOGIN_ID> <BRANCH> ["Full Name"]');
    process.exit(1);
}

const ledgerDb = process.env.MYSQL_KC_INVENTORY_DATABASE || "db_kc_inventory";
const pool = await mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: ledgerDb,
    connectTimeout: 30000,
});

try {
    const [[branch]] = await pool.query(
        `SELECT id, code, name, status, live_since FROM inv_branches WHERE UPPER(TRIM(code)) = ? LIMIT 1`,
        [branchCode]
    );
    if (!branch) throw new Error(`Branch ${branchCode} not found in ${ledgerDb}.inv_branches`);

    const [userRes] = await pool.query(
        `INSERT INTO inv_users (login_id, full_name, role, all_branches, status, created_by, last_seen_at)
         VALUES (?, ?, 'staff', 0, 'active', 'grant-script', UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
           full_name = COALESCE(NULLIF(VALUES(full_name), ''), full_name),
           role = 'staff',
           all_branches = 0,
           status = 'active'`,
        [loginId, fullName]
    );

    const [[user]] = await pool.query(`SELECT id, login_id, full_name, role, all_branches, status FROM inv_users WHERE login_id = ?`, [loginId]);
    await pool.query(`DELETE FROM inv_user_branches WHERE user_id = ?`, [user.id]);
    await pool.query(`INSERT INTO inv_user_branches (user_id, branch_id) VALUES (?, ?)`, [user.id, branch.id]);

    const [assigned] = await pool.query(
        `SELECT b.code, b.name FROM inv_user_branches ub JOIN inv_branches b ON b.id = ub.branch_id WHERE ub.user_id = ?`,
        [user.id]
    );

    console.log(JSON.stringify({
        ok: true,
        insertId: userRes.insertId || null,
        user,
        branch: { id: branch.id, code: branch.code, name: branch.name, status: branch.status, live: Boolean(branch.live_since) },
        assignedBranches: assigned,
    }, null, 2));
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
} finally {
    await pool.end();
}
