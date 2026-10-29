import mysql from "mysql2/promise";

/**
 * Pool on the Purchase database (db_purchase) for the KelinConnect Inventory API.
 * Reads Purchase-owned `forecast_item_stock` and owns the `kc_inventory_count_*` tables.
 * Never point this at Connect catalog tables (product_inventory_*).
 */
function createPool() {
    return mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: parseInt(process.env.MYSQL_PORT || "3306", 10),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_PURCHASE_DATABASE || "db_purchase",
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
        connectTimeout: 30000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        timezone: "+08:00",
    });
}

const globalKey = "__kcInventoryPurchasePool";

export function getPool() {
    if (!globalThis[globalKey]) globalThis[globalKey] = createPool();
    return globalThis[globalKey];
}

export const STOCK_TABLE = "forecast_item_stock";
export const COUNT_SESSIONS_TABLE = "kc_inventory_count_sessions";
export const COUNT_LINES_TABLE = "kc_inventory_count_lines";
