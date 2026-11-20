/**
 * Writes DATABASE_URL for the R&D Management Next.js app so it uses the
 * shared MySQL host + dedicated rd_tasks database.
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });

const host = process.env.MYSQL_HOST;
const port = process.env.MYSQL_PORT || "3306";
const user = process.env.MYSQL_USER;
const password = process.env.MYSQL_PASSWORD || "";
if (!host || !user) {
  console.error("MYSQL_HOST / MYSQL_USER missing in KGS-PURCHASE .env");
  process.exit(1);
}

const encUser = encodeURIComponent(user);
const encPass = encodeURIComponent(password);
const url = `mysql://${encUser}:${encPass}@${host}:${port}/rd_tasks`;

const target = "F:/jp/R&D Management/.env";
if (!existsSync(target)) {
  console.error("Missing", target);
  process.exit(1);
}

let text = readFileSync(target, "utf8");
if (/^DATABASE_URL=.*/m.test(text)) {
  text = text.replace(/^DATABASE_URL=.*/m, `DATABASE_URL="${url}"`);
} else {
  text += `\nDATABASE_URL="${url}"\n`;
}
writeFileSync(target, text);
console.log("Updated DATABASE_URL in R&D Management .env (host=%s db=rd_tasks user=%s)", host, user);
