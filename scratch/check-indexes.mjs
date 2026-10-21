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

const tables = [
    { db: 'db_purchase', t: 'product_periodic_sales' },
    { db: 'db_purchase', t: 'purchase_history' },
    { db: 'db_purchase', t: 'purchase_order_details' },
    { db: 'db_purchase', t: 'forecast_item_stock' },
    { db: 'db_purchase', t: 'replenishment_cache' },
    { db: 'db_purchase', t: 'vendors' },
    { db: 'db_kelin_inventory', t: 'inventory_items' },
    { db: 'db_kelin_inventory', t: 'product_inventory_items' }
];

for (const { db, t } of tables) {
    try {
        const [indexes] = await pool.query(`SHOW INDEX FROM \`${db}\`.\`${t}\``);
        console.log(`=== ${db}.${t} ===`);
        const byName = {};
        for (const idx of indexes) {
            if (!byName[idx.Key_name]) byName[idx.Key_name] = [];
            byName[idx.Key_name].push(idx.Column_name);
        }
        for (const [k, cols] of Object.entries(byName)) {
            console.log(`  ${k}: (${cols.join(', ')})`);
        }
    } catch (e) {
        console.log(`=== ${db}.${t} === (ERROR: ${e.message})`);
    }
}
await pool.end();
