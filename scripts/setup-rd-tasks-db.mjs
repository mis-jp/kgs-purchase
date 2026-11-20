/**
 * Creates rd_tasks on the shared MySQL host (credentials from KGS-PURCHASE .env),
 * without touching purchase/inventory databases.
 */
import { config } from "dotenv";
import mysql from "mysql2/promise";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kgsEnv = "C:/Kelin HRIS/hris3/acu/KGS-PURCHASE/.env";
const localEnv = path.join(__dirname, "..", ".env");

if (existsSync(kgsEnv)) config({ path: kgsEnv });
config({ path: localEnv, override: false });

const host = process.env.MYSQL_HOST || "127.0.0.1";
const port = Number(process.env.MYSQL_PORT || 3306);
const user = process.env.MYSQL_USER || "root";
const password = process.env.MYSQL_PASSWORD || "";
const database = "rd_tasks";

console.log(`Connecting to ${host}:${port} as ${user} ...`);

const conn = await mysql.createConnection({
  host,
  port,
  user,
  password,
  connectTimeout: 20000,
});

await conn.query(
  `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
);
await conn.changeUser({ database });
const [tables] = await conn.query("SHOW TABLES");
console.log(
  `Database ${database} ready. Tables:`,
  tables.map((t) => Object.values(t)[0]).join(", ") || "(none yet)",
);
await conn.end();
console.log("OK");
