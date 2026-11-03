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

console.log("Checking columns of purchase_history:");
const [cols] = await pool.query(`SHOW FULL COLUMNS FROM purchase_history`);
for (const c of cols) {
    if (c.Collation) {
        console.log(`  ${c.Field}: ${c.Type} Collation: ${c.Collation}`);
    }
}

console.log("\nChecking columns of purchase_order_details:");
const [dcols] = await pool.query(`SHOW FULL COLUMNS FROM purchase_order_details`);
for (const c of dcols) {
    if (c.Collation) {
        console.log(`  ${c.Field}: ${c.Type} Collation: ${c.Collation}`);
    }
}

await pool.end();
