import dotenv from "dotenv";
import fs from "fs";

dotenv.config({ path: fs.existsSync(".env.local") ? ".env.local" : ".env" });

const BASE = "http://localhost:3002";
const cookie = "acu_session=7e1892e2-f97c-496c-8430-56d9f2c0474f";

const endpoints = [
    { name: "Health", url: `${BASE}/api/health` },
    { name: "Branches", url: `${BASE}/api/branches` },
    { name: "Company", url: `${BASE}/api/company` },
    { name: "Inventory Stats Only", url: `${BASE}/api/inventory?statsOnly=true` },
    { name: "Inventory Page 1 (No stats)", url: `${BASE}/api/inventory?page=1&pageSize=10` },
    { name: "Inventory Page 1 + Stats", url: `${BASE}/api/inventory?page=1&pageSize=10&stats=true` },
    { name: "Replenishment (MAIN)", url: `${BASE}/api/replenishment?branch=MAIN` },
    { name: "Replenishment (BACOLOD)", url: `${BASE}/api/replenishment?branch=BACOLOD` },
    { name: "Forecast Generator (Defaults)", url: `${BASE}/api/forecast-generator` },
    { name: "Purchase Orders Page 1", url: `${BASE}/api/po?page=1&pageSize=20` },
    { name: "Stock Items Page 1", url: `${BASE}/api/stock-items?page=1&pageSize=20` },
    { name: "Vendors", url: `${BASE}/api/vendors` },
];

console.log("\n=== Benchmarking Endpoints ===");
for (const ep of endpoints) {
    const start = Date.now();
    try {
        const res = await fetch(ep.url, {
            headers: { Cookie: cookie },
        });
        const elapsed = Date.now() - start;
        const text = await res.text();
        let size = text.length;
        console.log(`${ep.name.padEnd(30)}: ${String(elapsed).padStart(6)}ms | Status ${res.status} | Size ${(size / 1024).toFixed(1)} KB`);
    } catch (err) {
        console.log(`${ep.name.padEnd(30)}: FAILED - ${err.message}`);
    }
}
