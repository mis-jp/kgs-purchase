import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";

let pool: Pool | null = null;

export function rdDatabaseName(): string {
  return (process.env.MYSQL_RD_DATABASE || "db_rd_management").trim();
}

/** Admin connection (no default database) — used only to CREATE DATABASE IF NOT EXISTS. */
export async function withServerConnection<T>(
  fn: (conn: mysql.Connection) => Promise<T>,
): Promise<T> {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "",
    password: process.env.MYSQL_PASSWORD || "",
    multipleStatements: false,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

export function getPool(): Pool {
  if (pool) return pool;
  const user = process.env.MYSQL_USER || "";
  const password = process.env.MYSQL_PASSWORD || "";
  if (!user) {
    throw new Error("MYSQL_USER env not set");
  }
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user,
    password,
    database: rdDatabaseName(),
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4",
    timezone: "+08:00",
  });
  return pool;
}

/** Reset cached pool (tests / after CREATE DATABASE). */
export function resetPool(): void {
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
}

export type Db = Pool;
export type { RowDataPacket, ResultSetHeader };
