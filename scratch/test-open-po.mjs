import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';

dotenv.config({ path: fs.existsSync('.env.local') ? '.env.local' : '.env' });

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_PURCHASE_DATABASE || 'db_purchase'
});

console.time('_getOpenPoQtyAllUncached query');
const [rows] = await pool.query(`
    SELECT
        UPPER(REPLACE(TRIM(d.inventory_id), ' ', '')) as inventoryId,
        COALESCE(SUM(GREATEST(0, d.qty - COALESCE(d.received_qty, 0))), 0) as openQty
    FROM purchase_order_details d
    INNER JOIN purchase_history h
        ON h.order_nbr COLLATE utf8mb4_unicode_ci = d.order_nbr
    WHERE h.status IN ('Open', 'Pending Approval')
      AND d.inventory_id IS NOT NULL
      AND d.inventory_id != ''
      AND (GREATEST(0, d.qty - COALESCE(d.received_qty, 0))) > 0
    GROUP BY UPPER(REPLACE(TRIM(d.inventory_id), ' ', ''))
`);
console.timeEnd('_getOpenPoQtyAllUncached query');
console.log('Open PO count:', rows.length);

await pool.end();
