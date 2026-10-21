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

console.log("=== Profiling Forecast Generator components ===");

console.time("1. ensureForecastInputsTable");
await pool.query(`
    CREATE TABLE IF NOT EXISTS forecast_generator_inputs (
        company_id VARCHAR(64) NOT NULL DEFAULT 'main',
        branch_id VARCHAR(100) NOT NULL DEFAULT '',
        inventory_id VARCHAR(100) NOT NULL,
        estimate_sales DECIMAL(18,4) NULL,
        buffer_inventory DECIMAL(18,4) NULL,
        target_sales DECIMAL(18,4) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, branch_id, inventory_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
console.timeEnd("1. ensureForecastInputsTable");

console.time("2. purgeForecastDamageStock");
await pool.query(`
    DELETE FROM forecast_item_stock
    WHERE UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DAMAGE%'
       OR UPPER(TRIM(COALESCE(branch_id,''))) LIKE '%DAMAGE%'
       OR UPPER(TRIM(COALESCE(site_id,''))) LIKE '%DAMAGE%'
       OR UPPER(TRIM(COALESCE(warehouse_id,''))) LIKE '%DISCOUNTED%'
       OR UPPER(TRIM(COALESCE(branch_id,''))) LIKE '%DISCOUNTED%'
       OR UPPER(TRIM(COALESCE(site_id,''))) LIKE '%DISCOUNTED%'
`);
console.timeEnd("2. purgeForecastDamageStock");

console.time("3. stockRows query");
const [stockRows] = await pool.query(`
    SELECT
        UPPER(REPLACE(TRIM(f.inventory_id), ' ', '')) AS invKey,
        MAX(TRIM(f.inventory_id)) AS inventoryId,
        MAX(CASE WHEN f.warehouse_id = '__catalog__' THEN f.item_name END) AS catName,
        MAX(CASE WHEN f.warehouse_id = '__catalog__' THEN f.item_class END) AS catClass,
        MAX(CASE WHEN f.warehouse_id = '__catalog__' THEN f.default_price END) AS catSrp,
        MAX(f.item_name) AS anyName,
        MAX(f.item_class) AS anyClass,
        MAX(f.default_price) AS anySrp,
        SUM(CASE WHEN f.warehouse_id != '__catalog__' THEN ABS(COALESCE(f.available, f.on_hand, 0)) ELSE 0 END) AS inventoryQty,
        1 AS atBranch
    FROM forecast_item_stock f
    WHERE f.company_id = 'main'
    GROUP BY UPPER(REPLACE(TRIM(f.inventory_id), ' ', ''))
`);
console.timeEnd("3. stockRows query");
console.log(`   Stock rows returned: ${stockRows.length}`);

console.time("4. salesRows query");
const [salesRows] = await pool.query(`
    SELECT UPPER(REPLACE(TRIM(s.inventory_id), ' ', '')) AS invKey,
        SUM(CASE WHEN CAST(s.document_date AS DATE) >= '2026-05-01' AND CAST(s.document_date AS DATE) <= '2026-07-31' THEN (CASE WHEN s.order_type = 'Credit Memo' AND s.id LIKE 'CM-%' THEN -ABS(s.qty) WHEN s.order_type IN ('Invoice', 'Debit Memo') THEN ABS(s.qty) ELSE 0 END) ELSE 0 END) AS last3Net,
        SUM(CASE WHEN CAST(s.document_date AS DATE) >= '2026-05-01' AND CAST(s.document_date AS DATE) <= '2026-07-31' THEN (CASE WHEN s.order_type IN ('Invoice', 'Debit Memo') THEN ABS(s.qty) ELSE 0 END) ELSE 0 END) AS last3Gross,
        SUM(CASE WHEN CAST(s.document_date AS DATE) >= '2025-05-01' AND CAST(s.document_date AS DATE) <= '2025-07-31' THEN (CASE WHEN s.order_type = 'Credit Memo' AND s.id LIKE 'CM-%' THEN -ABS(s.qty) WHEN s.order_type IN ('Invoice', 'Debit Memo') THEN ABS(s.qty) ELSE 0 END) ELSE 0 END) AS lastYearNet,
        SUM(CASE WHEN CAST(s.document_date AS DATE) >= '2025-05-01' AND CAST(s.document_date AS DATE) <= '2025-07-31' THEN (CASE WHEN s.order_type IN ('Invoice', 'Debit Memo') THEN ABS(s.qty) ELSE 0 END) ELSE 0 END) AS lastYearGross
    FROM product_periodic_sales s
    WHERE CAST(s.document_date AS DATE) >= '2025-05-01' AND CAST(s.document_date AS DATE) <= '2026-07-31'
    GROUP BY UPPER(REPLACE(TRIM(s.inventory_id), ' ', ''))
`);
console.timeEnd("4. salesRows query");
console.log(`   Sales rows returned: ${salesRows.length}`);

console.time("5. Open PO Qty query");
const [poRows] = await pool.query(`
    SELECT d.inventory_id, SUM(GREATEST(0, d.qty - COALESCE(d.received_qty, 0))) as openQty
    FROM purchase_history h
    JOIN purchase_order_details d ON h.order_nbr = d.order_nbr
    WHERE h.status IN ('Open', 'On Hold', 'Hold', 'Pending Approval')
    GROUP BY d.inventory_id
`);
console.timeEnd("5. Open PO Qty query");
console.log(`   PO rows returned: ${poRows.length}`);

console.time("6. listMissingSalesInvoiceMonths query");
const [gapRows] = await pool.query(`
    SELECT DATE_FORMAT(CAST(document_date AS DATE), '%Y-%m') AS ym,
            COUNT(*) AS c,
            DATE_FORMAT(MIN(CAST(document_date AS DATE)), '%Y-%m-%d') AS dmin,
            DATE_FORMAT(MAX(CAST(document_date AS DATE)), '%Y-%m-%d') AS dmax
    FROM product_periodic_sales
    WHERE CAST(document_date AS DATE) >= '2025-05-01' AND CAST(document_date AS DATE) <= '2026-07-31'
      AND order_type IN ('Invoice', 'Debit Memo')
    GROUP BY DATE_FORMAT(CAST(document_date AS DATE), '%Y-%m')
`);
console.timeEnd("6. listMissingSalesInvoiceMonths query");

await pool.end();
