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

console.log("=== EXPLAIN Forecast Sales query with CAST ===");
const [planWithCast] = await pool.query(`
    EXPLAIN SELECT inventory_id, SUM(qty)
    FROM product_periodic_sales s
    WHERE CAST(s.document_date AS DATE) >= '2026-05-01'
      AND CAST(s.document_date AS DATE) <= '2026-07-31'
    GROUP BY inventory_id
`);
console.table(planWithCast);

console.log("\n=== EXPLAIN Forecast Sales query with direct range (s.document_date >= '2026-05-01' AND s.document_date <= '2026-07-31 23:59:59') ===");
const [planDirect] = await pool.query(`
    EXPLAIN SELECT inventory_id, SUM(qty)
    FROM product_periodic_sales s
    WHERE s.document_date >= '2026-05-01 00:00:00'
      AND s.document_date <= '2026-07-31 23:59:59'
    GROUP BY inventory_id
`);
console.table(planDirect);

console.log("\n=== Testing query execution time with CAST vs Direct ===");
console.time("With CAST");
await pool.query(`
    SELECT inventory_id, SUM(qty)
    FROM product_periodic_sales s
    WHERE CAST(s.document_date AS DATE) >= '2026-05-01'
      AND CAST(s.document_date AS DATE) <= '2026-07-31'
    GROUP BY inventory_id
`);
console.timeEnd("With CAST");

console.time("With Direct Range");
await pool.query(`
    SELECT inventory_id, SUM(qty)
    FROM product_periodic_sales s
    WHERE s.document_date >= '2026-05-01 00:00:00'
      AND s.document_date <= '2026-07-31 23:59:59'
    GROUP BY inventory_id
`);
console.timeEnd("With Direct Range");

await pool.end();
