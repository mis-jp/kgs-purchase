import { AcumaticaService, extractStockItemCatalog, extractWarehouseLevels } from "@/services/acumatica";
import { MySqlService, INVENTORY_SYNC_TABLE } from "@/services/mysql";
import { NextResponse } from "next/server";
import { getSessionFromRequest, getSessionIdFromRequest, getCompanyCredential, getSessionCookies } from "@/lib/session-store";
import { COMPANIES, getAcumaticaCompanyName, splitLevelsByCompany } from "@/lib/companies";
import { rebuildAllReplenishmentCache } from "@/lib/replenishment-engine";
import {
    systemLoginForCompany,
    obtainSyncCredential,
    isUnauthorizedError,
    hasSystemAcumaticaCredentials,
} from "@/lib/sync-acumatica-auth";
import { syncChangedPurchaseOrders } from "@/lib/po-live-sync";
import mysql from "mysql2/promise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prevent overlapping syncs in this Node process (manual + auto-sync). */
let syncInProgress = false;
let syncProgressState = { running: false, progress: 0, section: "", mode: "" };

/**
 * BFF API Route for Data Synchronization
 * Syncs data from Acumatica ERP to the MySQL database.
 */
export async function POST(request) {
    console.log(">>> [Sync API] Starting MySQL Sync Process");
    const encoder = new TextEncoder();
    const signal = request.signal;

    const cookie = getSessionFromRequest(request);
    const sessionId = getSessionIdFromRequest(request);
    const syncSecret = request.headers.get("x-sync-secret");
    const isSecretValid = process.env.SYNC_SECRET && syncSecret === process.env.SYNC_SECRET;

    if (!cookie && !isSecretValid) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

    if (syncInProgress) {
        return NextResponse.json(
            { message: "A synchronization is already in progress. Try again shortly." },
            { status: 409 }
        );
    }
    syncInProgress = true;
    syncProgressState = { running: true, progress: 2, section: "Starting", mode: "" };

    let effectiveCookie = cookie;
    // Prefer a fresh system login for long syncs (user OAuth tokens expire mid-run)
    try {
        const fresh = await obtainSyncCredential({
            companyName: getAcumaticaCompanyName("main"),
            sessionCookie: cookie,
            sessionId,
            getSessionCookies,
            getCompanyCredential,
        });
        if (fresh) {
            effectiveCookie = fresh;
        } else if (isSecretValid && !cookie) {
            console.log(">>> [Sync API] Secret valid. Performing system login to Acumatica...");
            effectiveCookie = await systemLoginForCompany(getAcumaticaCompanyName("main"));
            console.log(">>> [Sync API] System login successful. Captured cookies.");
        }
    } catch (loginErr) {
        console.error(">>> [Sync API] Credential bootstrap failed:", loginErr.message);
        if (isSecretValid && !cookie) {
            syncInProgress = false;
            return NextResponse.json({ message: "System login failed" }, { status: 500 });
        }
    }

    // Local app login without ERP cookies cannot call Acumatica.
    if (effectiveCookie === "__bypass__") effectiveCookie = null;

    if (!effectiveCookie && !isSecretValid && !hasSystemAcumaticaCredentials()) {
        syncInProgress = false;
        return NextResponse.json({
            message:
                "Synchronization needs Acumatica system credentials in the server environment (ACUMATICA_USERNAME / ACUMATICA_PASSWORD). Local app login alone cannot call Acumatica.",
        }, { status: 403 });
    }

    // --- AUTO MIGRATION ---
    try {
        console.log(">>> [Sync API] Running Auto-Migrations...");
        const conn = await mysql.createConnection({
            host: process.env.MYSQL_HOST,
            port: parseInt(process.env.MYSQL_PORT || "3306", 10),
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
        });
        
        const inventoryDb = process.env.MYSQL_INVENTORY_DATABASE || "db_kelin_inventory";
        const purchaseDb = process.env.MYSQL_PURCHASE_DATABASE || "db_purchase";

        // Ensure Databases exist
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${inventoryDb}\``);
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${purchaseDb}\``);

        // Ensure inventory_items exists (VIEW / read-only legacy table — do not sync into this)
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${inventoryDb}\`.\`inventory_items\` (
                \`inventory_id\` VARCHAR(100) NOT NULL,
                \`default_warehouse\` VARCHAR(100) NOT NULL DEFAULT '__catalog__',
                PRIMARY KEY (\`inventory_id\`, \`default_warehouse\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure product_inventory_items exists (SYNC / write destination)
        await MySqlService.ensureProductInventoryItemsTable();
        console.log(`>>> [Sync API] Inventory sync target/source: ${INVENTORY_SYNC_TABLE}`);

        // Ensure product_periodic_sales table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`product_periodic_sales\` (
                \`id\` VARCHAR(255) PRIMARY KEY,
                \`inventory_id\` VARCHAR(100),
                \`last_sync\` DATETIME
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure vendors table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`vendors\` (
                \`vendor_id\` VARCHAR(100) PRIMARY KEY,
                \`vendor_name\` VARCHAR(255),
                \`status\` VARCHAR(50),
                \`avg_lead_time\` INT DEFAULT 0,
                \`reliability_score\` DECIMAL(5,2) DEFAULT 100.00,
                \`last_sync\` DATETIME
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure vendors has performance columns (for older schemas)
        const vCols = [
            { name: "avg_lead_time", def: "INT DEFAULT 0" },
            { name: "reliability_score", def: "DECIMAL(5,2) DEFAULT 100.00" }
        ];
        for (const c of vCols) {
            const [[row]] = await conn.query(
                `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS 
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='vendors' AND COLUMN_NAME=?`,
                [purchaseDb, c.name]
            );
            if (row.cnt === 0) {
                await conn.query(`ALTER TABLE \`${purchaseDb}\`.\`vendors\` ADD COLUMN \`${c.name}\` ${c.def}`);
            }
        }

        // Ensure purchase_history table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`purchase_history\` (
                \`order_nbr\` VARCHAR(50) PRIMARY KEY,
                \`vendor_id\` VARCHAR(100),
                \`vendor_name\` VARCHAR(255),
                \`status\` VARCHAR(50),
                \`order_date\` DATETIME,
                \`promised_date\` DATETIME,
                \`receipt_date\` DATETIME,
                \`total_amount\` DECIMAL(18,4),
                \`last_sync\` DATETIME
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure purchase_history has vendor_name column (for older schemas)
        const [[phVendorNameCol]] = await conn.query(
            `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS 
             WHERE TABLE_SCHEMA=? AND TABLE_NAME='purchase_history' AND COLUMN_NAME='vendor_name'`,
            [purchaseDb]
        );
        if (phVendorNameCol.cnt === 0) {
            await conn.query(`ALTER TABLE \`${purchaseDb}\`.\`purchase_history\` ADD COLUMN \`vendor_name\` VARCHAR(255) NULL AFTER \`vendor_id\``);
        }

        // Ensure sync_logs table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`sync_logs\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`timestamp\` DATETIME DEFAULT CURRENT_TIMESTAMP,
                \`mode\` VARCHAR(50),
                \`section\` VARCHAR(100),
                \`status\` VARCHAR(50),
                \`records_processed\` INT DEFAULT 0,
                \`message\` TEXT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure purchase_order_details table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`purchase_order_details\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`order_nbr\` VARCHAR(50),
                \`line_nbr\` INT,
                \`inventory_id\` VARCHAR(100),
                \`description\` VARCHAR(255),
                \`qty\` DECIMAL(18,4),
                \`received_qty\` DECIMAL(18,4) DEFAULT 0,
                \`line_completed\` TINYINT(1) NOT NULL DEFAULT 0,
                \`uom\` VARCHAR(50),
                \`warehouse_id\` VARCHAR(100) NULL,
                \`branch_id\` VARCHAR(100) NULL,
                \`ext_cost\` DECIMAL(18,4),
                \`last_sync\` DATETIME,
                UNIQUE KEY \`uq_po_line\` (\`order_nbr\`, \`line_nbr\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await MySqlService.ensureReceivedQtyColumn();
        await MySqlService.ensurePoWarehouseColumns();

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`forecast_item_stock\` (
                \`company_id\` VARCHAR(64) NOT NULL DEFAULT 'main',
                \`inventory_id\` VARCHAR(100) NOT NULL,
                \`warehouse_id\` VARCHAR(100) NOT NULL,
                \`branch_id\` VARCHAR(100) NULL,
                \`site_id\` VARCHAR(100) NULL,
                \`item_name\` VARCHAR(255) NULL,
                \`item_class\` VARCHAR(100) NULL,
                \`default_price\` DECIMAL(18,4) DEFAULT 0,
                \`on_hand\` DECIMAL(18,4) DEFAULT 0,
                \`available\` DECIMAL(18,4) DEFAULT 0,
                \`item_status\` VARCHAR(50) NULL,
                \`last_sync\` DATETIME NULL,
                PRIMARY KEY (\`company_id\`, \`inventory_id\`, \`warehouse_id\`),
                KEY \`idx_fis_branch\` (\`company_id\`, \`branch_id\`),
                KEY \`idx_fis_site\` (\`company_id\`, \`site_id\`),
                KEY \`idx_fis_class\` (\`item_class\`),
                KEY \`idx_fis_name\` (\`inventory_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await MySqlService.ensureForecastItemStockTable();

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${purchaseDb}\`.\`replenishment_cache\` (
                \`company_id\` VARCHAR(50) NOT NULL DEFAULT 'main',
                \`branch_id\` VARCHAR(100) NOT NULL,
                \`inventory_id\` VARCHAR(100) NOT NULL,
                \`description\` VARCHAR(500) NULL,
                \`current_stock\` DECIMAL(18,4) DEFAULT 0,
                \`qty_sold_90\` DECIMAL(18,4) DEFAULT 0,
                \`sales_velocity\` DECIMAL(18,6) DEFAULT 0,
                \`days_remaining\` INT DEFAULT 0,
                \`suggested_qty\` DECIMAL(18,4) DEFAULT 0,
                \`priority_level\` VARCHAR(20) NOT NULL DEFAULT 'Low',
                \`lead_time_days\` INT DEFAULT 0,
                \`vendor_id\` VARCHAR(100) NULL,
                \`branch_order_qty\` DECIMAL(18,4) DEFAULT 0,
                \`main_inventory\` DECIMAL(18,4) DEFAULT 0,
                \`coming_po\` DECIMAL(18,4) DEFAULT 0,
                \`total_branch_replenishment\` DECIMAL(18,4) DEFAULT 0,
                \`sales_scope\` VARCHAR(50) NULL,
                \`restock_source\` VARCHAR(255) NULL,
                \`what_to_do\` TEXT NULL,
                \`ai_preview\` TEXT NULL,
                \`ai_insights_json\` JSON NULL,
                \`is_main_warehouse_view\` TINYINT(1) NOT NULL DEFAULT 0,
                \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (\`company_id\`, \`branch_id\`, \`inventory_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure branches table exists
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`${inventoryDb}\`.\`branches\` (
                \`branch_id\` VARCHAR(100) PRIMARY KEY,
                \`branch_name\` VARCHAR(255),
                \`active\` TINYINT(1) DEFAULT 1
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ensure inventory_items columns exist
        const cols = [
            { name: "on_hand", def: "DECIMAL(18, 4) DEFAULT 0" },
            { name: "available", def: "DECIMAL(18, 4) DEFAULT 0" },
            { name: "branch_id", def: "VARCHAR(100) NULL" },
            { name: "site_id", def: "VARCHAR(100) NULL" },
            { name: "last_sync", def: "DATETIME NULL" },
            { name: "type", def: "VARCHAR(50) NULL" },
            { name: "item_type", def: "VARCHAR(50) NULL" },
            { name: "posting_class", def: "VARCHAR(100) NULL" },
            { name: "base_unit", def: "VARCHAR(50) NULL" },
            { name: "item_class", def: "VARCHAR(100) NULL" },
            { name: "default_price", def: "DECIMAL(18, 4) DEFAULT 0" },
            { name: "inventory_name", def: "VARCHAR(255) NULL" },
            { name: "company_id", def: "VARCHAR(50) NOT NULL DEFAULT 'main'" },
            { name: "vendor_id", def: "VARCHAR(100) NULL" },
            { name: "lead_time_days", def: "INT NULL" },
            { name: "safety_stock", def: "DECIMAL(18,4) NULL" },
            { name: "moq", def: "DECIMAL(18,4) NULL" },
        ];

        for (const c of cols) {
            const [[row]] = await conn.query(
                `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS 
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_items' AND COLUMN_NAME=?`,
                [inventoryDb, c.name]
            );
            if (row.cnt === 0) {
                await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` ADD COLUMN \`${c.name}\` ${c.def}`);
            }
        }

        await MySqlService.ensureInventoryPlanningColumns();

        await conn.query(
            `ALTER TABLE \`${inventoryDb}\`.\`inventory_items\`
             MODIFY COLUMN \`base_unit\` VARCHAR(50) NULL DEFAULT '',
             MODIFY COLUMN \`posting_class\` VARCHAR(100) NULL DEFAULT ''`
        ).catch((e) => console.warn(">>> [Sync API] Column default migration:", e.message));

        // Always drop inventory_id-only unique indexes — they block per-warehouse rows
        try {
            for (const idx of ["uq_inventory_items_inventory_id", "inventory_id"]) {
                const [[row]] = await conn.query(
                    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_items' AND INDEX_NAME=?`,
                    [inventoryDb, idx]
                );
                if (row.cnt > 0) {
                    await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` DROP INDEX \`${idx}\``);
                    console.log(`>>> [Sync API] Dropped blocking index: ${idx}`);
                }
            }
        } catch (idxErr) {
            console.warn(">>> [Sync API] Index cleanup skipped:", idxErr.message);
        }

        const [[pkCheck]] = await conn.query(
            `SELECT COUNT(*) as cnt FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_items' AND CONSTRAINT_NAME='PRIMARY' AND COLUMN_NAME='company_id'`,
            [inventoryDb]
        );
        if (pkCheck.cnt === 0) {
            try {
                const [[uqOld]] = await conn.query(
                    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_items' AND INDEX_NAME='uq_inv_warehouse'`,
                    [inventoryDb]
                );
                if (uqOld.cnt > 0) {
                    await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` DROP INDEX uq_inv_warehouse`);
                }
                const [[idCol]] = await conn.query(
                    `SELECT EXTRA FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_items' AND COLUMN_NAME='id'`,
                    [inventoryDb]
                );
                if (idCol?.EXTRA?.includes("auto_increment")) {
                    await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` MODIFY COLUMN id INT NOT NULL`);
                }
                await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` DROP PRIMARY KEY`);
                await conn.query(
                    `ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` ADD PRIMARY KEY (inventory_id, default_warehouse, company_id)`
                );
                await conn.query(
                    `ALTER TABLE \`${inventoryDb}\`.\`inventory_items\`
                     ADD UNIQUE KEY uq_inv_warehouse (inventory_id, default_warehouse, company_id)`
                ).catch(() => {});
                const [[{ maxId }]] = await conn.query(
                    `SELECT COALESCE(MAX(id), 0) AS maxId FROM \`${inventoryDb}\`.\`inventory_items\``
                );
                await conn.query(
                    `ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` ADD KEY idx_inventory_row_id (id)`
                ).catch(() => {});
                await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT`);
                await conn.query(`ALTER TABLE \`${inventoryDb}\`.\`inventory_items\` AUTO_INCREMENT = ${maxId + 1}`);
                console.log(">>> [Sync API] Updated inventory_items primary key to include company_id.");
            } catch (pkErr) {
                console.warn(">>> [Sync API] PK migration skipped:", pkErr.message);
            }
        }

        try {
            const cleaned = await MySqlService.sanitizeCatalogStockFields();
            if (cleaned > 0) {
                console.log(`>>> [Sync API] Cleared stock fields on ${cleaned} catalog row(s).`);
            }
        } catch (sanitizeErr) {
            console.warn(">>> [Sync API] Catalog sanitize skipped:", sanitizeErr.message);
        }

        try {
            const cleaned = await MySqlService.cleanupMisclassifiedEcomBranches();
            if (cleaned > 0) {
                console.log(`>>> [Sync API] Removed ${cleaned} misclassified ecommerce branch rows from main company.`);
            }
        } catch (cleanErr) {
            console.warn(">>> [Sync API] Ecommerce cleanup skipped:", cleanErr.message);
        }

        await conn.end();
        console.log(">>> [Sync API] Auto-Migrations Complete.");
    } catch (migErr) {
        console.error(">>> [Sync API] Auto-Migration Error:", migErr.message);
        // Continue anyway, maybe it's just permissions
    }

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "incremental";
    const options = {
        inventory: searchParams.get("inventory") === "true",
        sales: searchParams.get("sales") === "true",
        mode: mode,
        startDate: searchParams.get("startDate"),
        endDate: searchParams.get("endDate"),
    };

    const stream = new ReadableStream({
        async start(controller) {
            const send = (data) => {
                if (signal.aborted) return;
                if (data && !data.ping) {
                    const p = Number(data.progress);
                    syncProgressState = {
                        running: true,
                        progress: Number.isFinite(p)
                            ? Math.max(0, Math.min(100, p))
                            : (syncProgressState.progress || 0),
                        section: data.section || syncProgressState.section || "",
                        mode: options.mode || "incremental",
                    };
                }
                controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
            };

            const keepAlive = setInterval(() => {
                if (!signal.aborted) {
                    try { controller.enqueue(encoder.encode(JSON.stringify({ ping: true }) + "\n")); } catch { }
                }
            }, 15000);
            const finish = () => {
                clearInterval(keepAlive);
                syncInProgress = false;
                syncProgressState = { running: false, progress: 0, section: "", mode: "" };
                controller.close();
            };

            const getF = (obj, keyName) => {
                if (!obj) return "";
                const k = Object.keys(obj).find(i => i.toLowerCase() === keyName.toLowerCase());
                if (!k) return "";
                const val = obj[k];
                if (val === null || val === undefined) return "";
                if (typeof val === "object") return val.value ?? "";
                return val;
            };

            const getAny = (obj, ...keys) => {
                for (const k of keys) {
                    const v = getF(obj, k);
                    if (v !== "" && v !== null && v !== undefined) return v;
                }
                return "";
            };

            const parseAcumaticaRows = (data) => data?.value || (Array.isArray(data) ? data : []);

            const resolveReceiptDate = (order, receiptDateByOrder) => {
                const orderNbr = getF(order, "OrderNbr");
                const status = String(getF(order, "Status") || "").trim();
                const fromReceipt = receiptDateByOrder.get(orderNbr);
                if (fromReceipt) return fromReceipt;
                if (status === "Closed" || status === "Completed") {
                    return getAny(order, "LastReceiptDate", "ReceiptDate", "LastModifiedDateTime") || null;
                }
                return null;
            };

            const buildReceiptDateMap = async (acuBase, startDate) => {
                const receiptDateByOrder = new Map();
                let prSkip = 0;
                let prTotal = 0;
                const maxReceiptPages = 40;
                let prPage = 0;
                while (!signal.aborted && prPage < maxReceiptPages) {
                    const prFilter = `Date ge datetimeoffset'${startDate}T00:00:00Z'`;
                    const prUrl = `${acuBase}/PurchaseReceipt?$expand=Details&$top=100&$skip=${prSkip}&$filter=${encodeURIComponent(prFilter)}`;
                    try {
                        const prRes = await AcumaticaService.fetchWithRetry(prUrl, effectiveCookie);
                        const prData = await prRes.json();
                        const receipts = parseAcumaticaRows(prData);
                        if (receipts.length === 0) break;

                        for (const pr of receipts) {
                            const receiptDate = getF(pr, "Date");
                            if (!receiptDate) continue;
                            let details = pr.Details || [];
                            if (details.value) details = details.value;
                            if (!Array.isArray(details)) details = [];

                            for (const d of details) {
                                const poNbr = getF(d, "POOrderNbr");
                                if (!poNbr) continue;
                                const existing = receiptDateByOrder.get(poNbr);
                                if (!existing || new Date(receiptDate) > new Date(existing)) {
                                    receiptDateByOrder.set(poNbr, receiptDate);
                                }
                            }
                        }

                        prTotal += receipts.length;
                        prSkip += receipts.length;
                        prPage++;
                        const prProg = Math.min(65, 50 + Math.floor(prPage * 1.5));
                        send({
                            section: "Incoming PO",
                            details: `Loading receipt dates… (${prTotal} receipts)`,
                            progress: prProg,
                        });

                        if (receipts.length < 100) break;
                    } catch (prErr) {
                        console.warn(">>> [Sync API] PurchaseReceipt fetch skipped:", prErr.message);
                        break;
                    }
                }
                return receiptDateByOrder;
            };

            try {
                const ACU_BASE = `${process.env.ACUMATICA_BASE_URL}/entity/Default/20.200.001`;
                const isDelta = options.mode === "delta" || options.mode === "incremental";
                const todayStr = new Date().toISOString().split('T')[0];

                await MySqlService.logSyncEvent(options.mode, "All", "started", 0, `Sync started via API`);

                // Get last sync timestamps for incremental mode
                let lastInvSync = null;
                let lastSalesSync = null;
                let lastPoSync = null;
                if (isDelta) {
                    lastInvSync = await MySqlService.getLastInventorySyncTime();
                    lastSalesSync = await MySqlService.getLastSalesSyncTime();
                    lastPoSync = await MySqlService.getLastPOSyncTime();
                    
                    // Add 5-minute safety overlap buffer if timestamp exists
                    // Also format to ISO without milliseconds for better OData compatibility
                    const formatOData = (date) => date.toISOString().replace(/\.\d{3}/, "");

                    if (lastInvSync) {
                        const d = new Date(new Date(lastInvSync).getTime() - (5 * 60 * 1000));
                        lastInvSync = formatOData(d);
                    }
                    if (lastSalesSync) {
                        const d = new Date(new Date(lastSalesSync).getTime() - (5 * 60 * 1000));
                        lastSalesSync = formatOData(d);
                    }
                    if (lastPoSync) {
                        // A later page can fail after an earlier page stamps last_sync.
                        // Look back far enough to retry those orders on the next Quick Sync.
                        const d = new Date(new Date(lastPoSync).getTime() - (21 * 24 * 60 * 60 * 1000));
                        lastPoSync = formatOData(d);
                    }

                    // "Sync Today's Changes" — clamp watermarks to start of today (UTC)
                    if (options.mode === "delta") {
                        const startOfToday = new Date();
                        startOfToday.setUTCHours(0, 0, 0, 0);
                        const todayStamp = formatOData(new Date(startOfToday.getTime() - (5 * 60 * 1000)));
                        lastInvSync = todayStamp;
                        lastSalesSync = todayStamp;
                        lastPoSync = todayStamp;
                    }
                }

                let inventoryRowsSynced = 0;
                let salesRowsSynced = 0;
                let poRowsSynced = 0;

                // 1. BRANCHES (Acumatica Branch entity only — not Warehouse)
                send({ section: "Inventory", details: "Updating branches...", progress: 5 });
                try {
                    const realBranches = await AcumaticaService.getRealBranches(effectiveCookie).catch((e) => {
                        console.warn("[Sync API] getRealBranches:", e.message);
                        return [];
                    });

                    const byId = new Map();
                    for (const b of realBranches) {
                        const id = String(b.BranchID || "").trim();
                        if (!id) continue;
                        byId.set(id.toUpperCase(), {
                            branch_id: id,
                            branch_name: String(b.Description || b.BranchID || id).trim(),
                            active: true,
                        });
                    }

                    const branchRows = [...byId.values()];
                    if (branchRows.length > 0) {
                        await MySqlService.replaceMasterBranches(branchRows);
                    }
                    await MySqlService.logSyncEvent(options.mode, "Branches", "completed", branchRows.length);
                } catch (e) {
                    await MySqlService.logSyncEvent(options.mode, "Branches", "error", 0, e.message);
                }

                // 1.5 VENDORS (Sync every time or if inventory/sales is selected)
                if (options.inventory || options.sales) {
                    send({ section: "Suppliers", details: "Updating vendor directory...", progress: 5 });
                    let vendorCount = 0;
                    try {
                        const vendorPageSize = 500;
                        let vendorSkip = 0;
                        while (true) {
                            const url = `${ACU_BASE}/Vendor?$top=${vendorPageSize}&$skip=${vendorSkip}`;
                            const res = await AcumaticaService.fetchWithRetry(url, effectiveCookie);
                            const data = await res.json();
                            const vendors = data.value || [];
                            if (vendors.length === 0) break;

                            const vendorRows = vendors.map(v => ({
                                vendor_id: String(getF(v, "VendorID")).trim(),
                                vendor_name: String(getF(v, "VendorName")).trim(),
                                status: String(getF(v, "Status")).trim(),
                                last_sync: new Date()
                            }));
                            await MySqlService.upsertVendors(vendorRows);
                            vendorCount += vendorRows.length;

                            send({
                                section: "Suppliers",
                                details: `Synced ${vendorCount} vendor(s)...`,
                                progress: Math.min(90, 10 + Math.floor(vendorCount / 20)),
                                count: vendorCount
                            });

                            if (vendors.length < vendorPageSize) break;
                            vendorSkip += vendorPageSize;
                        }
                        await MySqlService.logSyncEvent(options.mode, "Suppliers", "completed", vendorCount);
                        send({
                            section: "Suppliers",
                            status: "done",
                            details: `Supplier sync complete (${vendorCount} vendors).`,
                            progress: 100,
                            count: vendorCount
                        });
                    } catch (e) {
                        console.error(">>> [Sync API] Vendor sync error:", e.message);
                        await MySqlService.logSyncEvent(options.mode, "Suppliers", "error", 0, e.message);
                        send({ section: "Suppliers", details: `Supplier sync error: ${e.message}`, progress: 5 });
                    }
                }

                // 2. INVENTORY — multi-warehouse stock goes to forecast_item_stock (CMS is one-SKU)
                if (options.inventory) {
                  try {
                    let invCookie = effectiveCookie;
                    let totalSynced = 0;
                    try {
                        const freshInv = await obtainSyncCredential({
                            companyName: getAcumaticaCompanyName("main"),
                            sessionCookie: effectiveCookie,
                            sessionId,
                            getSessionCookies,
                            getCompanyCredential,
                        });
                        if (freshInv) invCookie = freshInv;
                    } catch (loginErr) {
                        console.error(">>> [Sync API] Inventory login error:", loginErr.message);
                    }

                    const refreshInventoryAuth = async (reason) => {
                        send({
                            section: "Inventory",
                            details: `Acumatica session expired (${reason}) — signing in again and retrying…`,
                            progress: Math.max(10, Math.min(95, Math.floor((totalSynced || 0) / 30))),
                            count: totalSynced || 0,
                        });
                        invCookie = await systemLoginForCompany(getAcumaticaCompanyName("main"), {
                            forceRefresh: true,
                        });
                        effectiveCookie = invCookie;
                        console.log(">>> [Sync API] Re-authenticated after Unauthorized");
                        return invCookie;
                    };

                    if (!invCookie || invCookie === "__bypass__") {
                        console.warn(">>> [Sync API] Skipping inventory — no credential");
                        send({
                            section: "Inventory",
                            details: "Skipped inventory — no Acumatica credentials available.",
                            progress: 0,
                        });
                    } else {
                        const inventorySyncStartedAt = new Date();
                        const filterArr = [];
                        if (isDelta && lastInvSync) {
                            filterArr.push(`LastModified gt datetimeoffset'${lastInvSync}'`);
                            send({ section: "Inventory", details: `Incremental sync since ${lastInvSync}...`, progress: 10 });
                        } else {
                            send({ section: "Inventory", details: "Full refresh: syncing stock from KGSC (existing data kept until complete)...", progress: 8 });
                        }

                        const filterStr = filterArr.length > 0 ? `&$filter=${filterArr.join(" and ")}` : "";
                        let skip = 0;
                        let totalLevelsSynced = 0;
                        const top = 50;
                        let authRetries = 0;

                        while (!signal.aborted) {
                            let items = [];
                            try {
                                const url = `${ACU_BASE}/StockItem?$expand=WarehouseDetails&$top=${top}&$skip=${skip}${filterStr}`;
                                const res = await AcumaticaService.fetchWithRetry(url, invCookie);
                                const data = await res.json();
                                items = data.value || (Array.isArray(data) ? data : []);
                                authRetries = 0;
                            } catch (fetchErr) {
                                if (isUnauthorizedError(fetchErr) && authRetries < 3 && hasSystemAcumaticaCredentials()) {
                                    authRetries += 1;
                                    await refreshInventoryAuth(`page skip=${skip}`);
                                    continue;
                                }
                                console.error(`>>> [Sync API] Inventory Fetch Error at skip ${skip}:`, fetchErr.message);
                                throw fetchErr;
                            }

                            if (items.length === 0) break;

                            const allLevels = [];
                            const catalogs = [];
                            const batchItemIds = [];
                            const prepared = [];
                            for (const item of items) {
                                try {
                                    const catalog = extractStockItemCatalog(item);
                                    if (!catalog) continue;
                                    batchItemIds.push(catalog.inventory_id);
                                    catalogs.push({ ...catalog });
                                    const catalogFields = {
                                        description: catalog.description,
                                        item_class: catalog.item_class,
                                        default_price: catalog.default_price,
                                        item_status: catalog.item_status,
                                        base_unit: catalog.base_unit,
                                        item_type: catalog.item_type,
                                        posting_class: catalog.posting_class,
                                    };
                                    prepared.push({ item, catalogFields });
                                } catch (itemErr) {
                                    console.error(`>>> [Sync API] Item Processing Error:`, itemErr);
                                }
                            }

                            // Inventory Summary per item so DAMAGE / DISCOUNTED locations are excluded from sellable,
                            // and aggregated into DAMAGE rows for the Damage KPI.
                            try {
                                let resolved;
                                try {
                                    resolved = await AcumaticaService.resolveWarehouseLevelsBatch(
                                        prepared,
                                        invCookie,
                                        8
                                    );
                                } catch (summaryErr) {
                                    if (isUnauthorizedError(summaryErr) && hasSystemAcumaticaCredentials()) {
                                        await refreshInventoryAuth("inventory summary");
                                        resolved = await AcumaticaService.resolveWarehouseLevelsBatch(
                                            prepared,
                                            invCookie,
                                            8
                                        );
                                    } else {
                                        throw summaryErr;
                                    }
                                }
                                const sellable = Array.isArray(resolved)
                                    ? resolved
                                    : resolved?.levels || [];
                                const damage = Array.isArray(resolved)
                                    ? []
                                    : resolved?.damageLevels || [];
                                allLevels.push(...sellable, ...damage);
                            } catch (summaryErr) {
                                console.warn(
                                    ">>> [Sync API] Location summary batch failed; falling back to WarehouseDetails:",
                                    summaryErr.message
                                );
                                for (const { item, catalogFields } of prepared) {
                                    allLevels.push(...extractWarehouseLevels(item, catalogFields));
                                }
                            }

                            const { main: mainLevels, ecommerce: ecomLevels } = splitLevelsByCompany(allLevels);

                            if (catalogs.length > 0) {
                                if (isDelta && batchItemIds.length > 0) {
                                    await MySqlService.deleteInventoryLevelsForItems(batchItemIds, "main");
                                    await MySqlService.deleteInventoryLevelsForItems(batchItemIds, "ecommerce");
                                }
                                await MySqlService.upsertInventoryItems(catalogs, "main");
                                if (mainLevels.length) {
                                    await MySqlService.upsertInventoryLevels(mainLevels, "main");
                                    totalLevelsSynced += mainLevels.length;
                                }
                                if (ecomLevels.length) {
                                    await MySqlService.upsertInventoryItems(catalogs, "ecommerce");
                                    await MySqlService.upsertInventoryLevels(ecomLevels, "ecommerce");
                                    totalLevelsSynced += ecomLevels.length;
                                }
                            }

                            totalSynced += items.length;
                            skip += items.length;
                            const invProgress = isDelta
                                ? Math.min(99, Math.floor(totalSynced / 5))
                                : Math.min(99, Math.floor(totalSynced / 30));
                            send({
                                section: "Inventory",
                                details: `Processed ${totalSynced} items (${totalLevelsSynced} stock rows)...`,
                                progress: Math.max(10, invProgress),
                                count: totalSynced,
                            });
                            if (items.length < top) break;
                        }

                        if (!isDelta && !signal.aborted && totalLevelsSynced > 0) {
                            // Verify rows were written to the sync table before pruning stale rows
                            const writtenMain = await MySqlService.countWarehouseRows("main", INVENTORY_SYNC_TABLE);
                            const writtenEcom = await MySqlService.countWarehouseRows("ecommerce", INVENTORY_SYNC_TABLE);
                            if (writtenMain + writtenEcom > 0) {
                                // Guard: never prune when this run barely refreshed warehouses
                                // (e.g. MAIN-only summary) — that wiped CEBU/ILOILO/etc. before.
                                const freshMain = await MySqlService.countFreshWarehouses(inventorySyncStartedAt, "main");
                                const freshEcom = await MySqlService.countFreshWarehouses(inventorySyncStartedAt, "ecommerce");
                                const minWarehousesToPrune = 5;
                                if (freshMain + freshEcom < minWarehousesToPrune) {
                                    console.warn(
                                        `>>> [Sync API] Skipping stale cleanup — only ${freshMain}+${freshEcom} warehouses refreshed (need ≥${minWarehousesToPrune}).`
                                    );
                                } else {
                                    const removedMain = await MySqlService.deleteStaleInventoryLevels(inventorySyncStartedAt, "main");
                                    const removedEcom = await MySqlService.deleteStaleInventoryLevels(inventorySyncStartedAt, "ecommerce");
                                    console.log(`>>> [Sync API] Removed stale stock rows from ${INVENTORY_SYNC_TABLE}: main=${removedMain}, ecommerce=${removedEcom}`);
                                }
                                await MySqlService.ensureCatalogRowsFromWarehouse("main").catch(() => 0);
                                await MySqlService.ensureCatalogRowsFromWarehouse("ecommerce").catch(() => 0);
                            } else {
                                console.warn(`>>> [Sync API] Skipping stale cleanup — no warehouse rows in ${INVENTORY_SYNC_TABLE} after upsert.`);
                            }
                        } else if (!isDelta && totalLevelsSynced === 0) {
                            console.warn(">>> [Sync API] Skipping stale row cleanup — no warehouse levels were synced.");
                        }

                        await MySqlService.sanitizeCatalogStockFields("main").catch(() => 0);
                        await MySqlService.sanitizeCatalogStockFields("ecommerce").catch(() => 0);

                        await MySqlService.logSyncEvent(options.mode, "Inventory", "completed", totalSynced, `${totalLevelsSynced} stock rows`);
                        inventoryRowsSynced = totalLevelsSynced || totalSynced;
                        send({ section: "Inventory", status: "done", details: `Inventory sync complete (${totalLevelsSynced} stock rows).`, progress: 100 });
                    }
                  } catch (invErr) {
                    console.error(">>> [Sync API] Inventory sync error:", invErr.message);
                    await MySqlService.logSyncEvent(options.mode, "Inventory", "error", 0, invErr.message);
                    send({
                        section: "Inventory",
                        status: "error",
                        details: `Inventory sync error: ${invErr.message}`,
                        progress: 0,
                    });
                    // Continue Sales / PO — do not fail the whole Quick Sync on CMS SKU conflicts.
                  }
                }

                // 3. SALES (SalesInvoice + AR credit/debit memos, line-level branch)
                const affectedInventoryIds = new Set();
                if (options.sales) {
                    const sStart = options.startDate || "2024-01-01";
                    const sEnd = options.endDate || todayStr;

                    if (isDelta && lastSalesSync) {
                        send({ section: "Sales history", details: `Incremental Sync: Fetching changes since ${lastSalesSync}...`, progress: 10 });
                    } else {
                        send({ section: "Sales history", details: `Full Sync: SalesInvoice + memos (${sStart} to ${sEnd})`, progress: 10 });
                    }

                    let sTotal = 0;
                    let salesFinished = false;
                    try {
                        const runSales = async (cookie) =>
                            AcumaticaService.fetchPeriodicSalesForSync({
                                cookie,
                                startDate: sStart,
                                endDate: sEnd,
                                lastModifiedAfter: isDelta && lastSalesSync ? lastSalesSync : null,
                                maxCatchupDays: 14,
                                onBatch: async (batch) => {
                                    if (signal.aborted || !batch?.length) return;
                                    await MySqlService.upsertPeriodicSales(batch);
                                    sTotal += batch.length;
                                    if (options.mode === "delta") {
                                        for (const r of batch) {
                                            if (r.inventory_id) affectedInventoryIds.add(r.inventory_id);
                                        }
                                    }
                                    const salesProg = Math.min(95, 10 + Math.floor(sTotal / 20));
                                    send({
                                        section: "Sales history",
                                        details: `Synced ${sTotal} line(s)...`,
                                        progress: salesProg,
                                        count: sTotal,
                                    });
                                },
                            });

                        let salesRows;
                        try {
                            salesRows = await runSales(effectiveCookie);
                        } catch (salesAuthErr) {
                            if (!isUnauthorizedError(salesAuthErr) || !hasSystemAcumaticaCredentials()) {
                                throw salesAuthErr;
                            }
                            send({
                                section: "Sales history",
                                details: "Acumatica session expired — signing in again and retrying sales…",
                                progress: 12,
                            });
                            effectiveCookie = await systemLoginForCompany(getAcumaticaCompanyName("main"), {
                                forceRefresh: true,
                            });
                            salesRows = await runSales(effectiveCookie);
                        }

                        // Safety: upsert return value only if onBatch did not run
                        if (sTotal === 0 && salesRows?.length) {
                            const CHUNK = 400;
                            for (let i = 0; i < salesRows.length; i += CHUNK) {
                                if (signal.aborted) break;
                                const chunk = salesRows.slice(i, i + CHUNK);
                                await MySqlService.upsertPeriodicSales(chunk);
                                sTotal += chunk.length;
                                if (options.mode === "delta") {
                                    for (const r of chunk) {
                                        if (r.inventory_id) affectedInventoryIds.add(r.inventory_id);
                                    }
                                }
                            }
                        }
                    } catch (salesFetchErr) {
                        console.error(`>>> [Sync API] Sales Fetch Error:`, salesFetchErr.message);
                        send({ section: "Sales history", details: `Sales sync error: ${salesFetchErr.message}`, progress: 10 });
                        if (sTotal > 0) {
                            console.warn(`>>> [Sync API] Sales partial sync kept (${sTotal} lines).`);
                            salesRowsSynced = sTotal;
                            await MySqlService.logSyncEvent(
                                options.mode,
                                "Sales history",
                                "completed",
                                sTotal,
                                `Partial: ${salesFetchErr.message}`
                            );
                            send({
                                section: "Sales history",
                                status: "done",
                                details: `Sales sync partial (${sTotal} lines). Will resume next run.`,
                                progress: 100,
                            });
                            salesFinished = true;
                        } else {
                            throw salesFetchErr;
                        }
                    }

                    if (!salesFinished) {
                        salesRowsSynced = sTotal;
                        await MySqlService.logSyncEvent(options.mode, "Sales history", "completed", sTotal);
                        send({ section: "Sales history", status: "done", details: `Sales sync complete (${sTotal} lines).`, progress: 100 });
                    }
                }

                // 3.5 PURCHASE ORDERS (Incoming PO Details — runs with inventory or sales sync)
                if (options.sales || options.inventory) {
                    send({ section: "Incoming PO", details: "Updating purchase orders from Acumatica...", progress: 10 });
                    try {
                        const batch = await syncChangedPurchaseOrders({
                            cookie: effectiveCookie,
                            onProgress: (info) => send({
                                section: "Incoming PO",
                                details: info.details,
                                progress: info.progress,
                                count: info.count || 0,
                            }),
                        });
                        poRowsSynced = batch.synced || 0;
                        await MySqlService.logSyncEvent(options.mode, "Incoming PO", "completed", poRowsSynced);
                        send({
                            section: "Incoming PO",
                            status: "done",
                            details: `Purchase order sync complete (${poRowsSynced} orders).`,
                            progress: 100,
                            count: poRowsSynced,
                        });
                    } catch (poErr) {
                        console.error(">>> [Sync API] PO sync error:", poErr.message);
                        await MySqlService.logSyncEvent(options.mode, "Incoming PO", "error", 0, poErr.message);
                        send({
                            section: "Incoming PO",
                            status: "error",
                            details: poErr.message || "Purchase order sync failed",
                            progress: 100,
                        });
                    }
                }

                // 4. SMART DELTA REFRESH (Only for items sold today)
                if (options.mode === "delta" && affectedInventoryIds.size > 0) {
                    send({ section: "Inventory", details: `Updating stocks for ${affectedInventoryIds.size} sold items...`, progress: 95 });
                    const idList = Array.from(affectedInventoryIds);
                    const idChunks = [];
                    for (let i = 0; i < idList.length; i += 10) idChunks.push(idList.slice(i, i + 10));

                    for (const batch of idChunks) {
                        const filter = batch.map(id => `InventoryID eq '${id}'`).join(" or ");
                        const url = `${ACU_BASE}/StockItem?$expand=WarehouseDetails&$filter=${filter}`;
                        const res = await AcumaticaService.fetchWithRetry(url, effectiveCookie);
                        const data = await res.json();
                        const items = data.value || [];
                        const levels = [];
                        const batchItemIds = [];
                        const prepared = [];
                        for (const item of items) {
                            const catalog = extractStockItemCatalog(item);
                            if (!catalog) continue;
                            batchItemIds.push(catalog.inventory_id);
                            prepared.push({
                                item,
                                catalogFields: {
                                    description: catalog.description,
                                    item_class: catalog.item_class,
                                    default_price: catalog.default_price,
                                    item_status: catalog.item_status,
                                    base_unit: catalog.base_unit,
                                    item_type: catalog.item_type,
                                    posting_class: catalog.posting_class,
                                },
                            });
                        }
                        try {
                            const resolved = await AcumaticaService.resolveWarehouseLevelsBatch(
                                prepared,
                                effectiveCookie,
                                8
                            );
                            const sellable = Array.isArray(resolved)
                                ? resolved
                                : resolved?.levels || [];
                            const damage = Array.isArray(resolved)
                                ? []
                                : resolved?.damageLevels || [];
                            levels.push(...sellable, ...damage);
                        } catch {
                            for (const { item, catalogFields } of prepared) {
                                levels.push(...extractWarehouseLevels(item, catalogFields));
                            }
                        }
                        const { main: mainLevels, ecommerce: ecomLevels } = splitLevelsByCompany(levels);
                        if (batchItemIds.length > 0) {
                            await MySqlService.deleteInventoryLevelsForItems(batchItemIds, "main");
                            await MySqlService.deleteInventoryLevelsForItems(batchItemIds, "ecommerce");
                        }
                        if (mainLevels.length > 0) await MySqlService.upsertInventoryLevels(mainLevels, "main");
                        if (ecomLevels.length > 0) await MySqlService.upsertInventoryLevels(ecomLevels, "ecommerce");
                    }
                    await MySqlService.logSyncEvent(options.mode, "Smart Delta", "completed", idList.length);
                    send({ section: "Inventory", status: "done", details: "Stock refresh complete.", progress: 100 });
                }

                // 5. FINAL ENRICHMENT — full sync always; incremental only when data changed
                const dataChanged =
                    inventoryRowsSynced > 0 || salesRowsSynced > 0 || poRowsSynced > 0;
                if ((options.sales || options.inventory) && (options.mode === "full" || dataChanged)) {
                    send({ section: "Data Enrichment", details: "Filling missing categories...", progress: 98 });
                    try {
                        await MySqlService.enrichSalesData();
                        await MySqlService.validateSalesIntegrity();
                        
                        // New: Calculate Vendor Performance
                        send({ section: "Data Enrichment", details: "Calculating vendor performance...", progress: 99 });
                        const vCount = await MySqlService.calculateAndStoreVendorPerformance();
                        await MySqlService.logSyncEvent(options.mode, "Suppliers Performance", "completed", vCount);

                        send({ section: "Replenishment", details: "Building replenishment cache...", progress: 99 });
                        await MySqlService.ensureReplenishmentCacheTable();
                        const replResult = await rebuildAllReplenishmentCache("main");
                        await MySqlService.logSyncEvent(options.mode, "Replenishment", "completed", replResult.totalRows);
                        send({ section: "Replenishment", status: "done", details: `Replenishment cache built (${replResult.totalRows} rows).`, progress: 100 });
                    } catch (e) {
                        console.error(">>> [Sync API] Enrichment error:", e);
                        await MySqlService.logSyncEvent(options.mode, "Data Enrichment", "error", 0, e.message);
                    }
                    send({ section: "Data Enrichment", status: "done", details: "Enrichment complete.", progress: 100 });
                } else if (options.sales || options.inventory) {
                    send({
                        section: "Data Enrichment",
                        status: "done",
                        details: "Skipped enrichment (no new/changed rows).",
                        progress: 100,
                    });
                }

                await MySqlService.logSyncEvent(options.mode, "All", "completed", 0, "Sync finished successfully");
                send({ status: "complete", message: "Sync completed successfully" });
                finish();
            } catch (err) {
                console.error(">>> [Sync Error]", err);
                await MySqlService.logSyncEvent(options.mode, "All", "error", 0, err.message);
                send({ status: "error", message: err?.message || String(err) || "An unknown sync error occurred" });
                finish();
            }
        }
    });

    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/**
 * GET handler to fetch recent sync logs
 */
export async function GET(request) {
    try {
        const cookie = getSessionFromRequest(request);
        if (!cookie) return Response.json({ message: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        if (searchParams.get("status") === "1") {
            return Response.json({
                running: Boolean(syncInProgress),
                progress: Number(syncProgressState.progress) || 0,
                section: syncProgressState.section || "",
                mode: syncProgressState.mode || "",
            });
        }

        const limit = parseInt(searchParams.get("limit") || "20");

        const logs = await MySqlService.getSyncLogs(limit);
        return Response.json(logs);
    } catch (err) {
        console.error("[GET Sync Logs Error]", err);
        return Response.json({ message: "Internal server error" }, { status: 500 });
    }
}
