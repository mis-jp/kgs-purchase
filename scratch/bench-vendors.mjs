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

console.time("getVendors query");
const [vRows] = await pool.query(`
    SELECT vendor_id as VendorID, vendor_name as VendorName, status as Status,
           COALESCE(avg_lead_time, 0) as AvgLeadTime,
           COALESCE(reliability_score, 100.00) as ReliabilityScore
    FROM vendors
    ORDER BY VendorName ASC
    LIMIT 10 OFFSET 0
`);
const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM vendors`);
console.timeEnd("getVendors query");
console.log(`Vendors count: ${total}`);

console.time("_computeSupplierPerformance query");
const [pRows] = await pool.query(`
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
console.timeEnd("_computeSupplierPerformance query");
console.log(`Performance rows: ${pRows.length}`);

console.time("_computeVendorLeadTimes query");
const [lRows] = await pool.query(`
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
console.timeEnd("_computeVendorLeadTimes query");
console.log(`Lead time rows: ${lRows.length}`);

await pool.end();
