import { MySqlService } from "@/services/mysql";
import { SALES_LOOKBACK_DAYS } from "@/lib/sales-velocity";
import {
    aggregateBranchSales,
    aggregateBranchGrossSales,
    invoicesToPeriodicSalesRows,
} from "@/lib/acumatica-sales-aggregate";
import { isExcludedBranchAlias, isExcludedLocationAlias } from "@/lib/companies";
const ACU_BASE = `${process.env.ACUMATICA_BASE_URL}/entity/Default/20.200.001`;

// Bypasses 'CERT_HAS_EXPIRED' error for Acumatica connections
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const toISODate = (date) => date.toISOString().split("T")[0];

/** --- DATA EXTRACTION HELPERS --- */
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

/** Catalog fields shared across all warehouse rows for one StockItem */
function parsePlanningNumber(raw) {
    if (raw === "" || raw === null || raw === undefined) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function extractStockItemCatalog(item) {
    const invId = String(getF(item, "InventoryID")).trim();
    if (!invId) return null;
    return {
        inventory_id: invId,
        description: String(getF(item, "Description")).trim(),
        item_class: String(getF(item, "ItemClass")).trim(),
        default_price: parseFloat(getF(item, "DefaultPrice") || 0),
        item_status: String(getF(item, "ItemStatus") || "Active"),
        base_unit: String(getF(item, "BaseUnit") || ""),
        item_type: String(getF(item, "ItemType") || ""),
        posting_class: String(getF(item, "PostingClass") || ""),
        vendor_id: String(getAny(item, "PreferredVendorID", "DefaultVendorID", "VendorID", "LastVendorID")).trim() || null,
        lead_time_days: parsePlanningNumber(getAny(item, "LeadTimeDays", "LeadTime", "PurchLeadTime", "VendorLeadTime")),
        safety_stock: parsePlanningNumber(getAny(item, "SafetyStock", "SafetyStockQty", "ReorderPoint")),
        moq: parsePlanningNumber(getAny(item, "MinOrderQty", "MOQ", "MinimumOrderQuantity", "MinQty")),
    };
}

/**
 * Map Acumatica WarehouseDetails to per-site stock rows.
 * SiteID (branch) is the location key — WarehouseID is the physical warehouse only.
 */
export function extractWarehouseLevels(item, catalogFields = {}) {
    const invId = String(getF(item, "InventoryID")).trim();
    if (!invId) return [];

    let wds = item.WarehouseDetails || [];
    if (wds && !Array.isArray(wds) && wds.value) wds = wds.value;
    if (!Array.isArray(wds)) wds = [];

    const levels = [];
    for (const wh of wds) {
        const siteId = String(
            getAny(wh, "SiteID", "Branch", "BranchID", "LinkBranch") || getAny(wh, "WarehouseID")
        ).trim();
        const warehouseId = String(getAny(wh, "WarehouseID") || siteId).trim();
        if (!siteId) continue;
        // Never persist Damage / Discounted (and similar) into MySQL stock totals
        if (isExcludedBranchAlias(siteId) || isExcludedBranchAlias(warehouseId)) continue;

        const onHand = parseFloat(getAny(wh, "QtyOnHand", "OnHand", "Qty") || 0);
        const onHandVal = Number.isNaN(onHand) ? 0 : onHand;
        // When QtyAvailable is absent, getAny returns "" and `"" || 0` becomes 0 — that hid the on-hand fallback.
        const rawAvail = getAny(wh, "QtyAvailable", "Available", "QtyAvail", "AvailableQty", "QtyHardAvailable");
        let available = rawAvail === "" || rawAvail == null ? NaN : parseFloat(rawAvail);
        if (Number.isNaN(available)) available = onHandVal;

        levels.push({
            inventory_id: invId,
            branch_id: siteId,
            site_id: siteId,
            warehouse_id: warehouseId,
            on_hand: onHandVal,
            available,
            ...catalogFields,
            item_type: catalogFields.item_type || getF(item, "ItemType") || "",
            posting_class: catalogFields.posting_class || getF(item, "PostingClass") || "",
        });
    }
    return levels;
}

/**
 * Aggregate Inventory Summary rows by warehouse, omitting DAMAGE / DISCOUNTED locations.
 * Also tracks every warehouse that appeared in the summary (even if all locations
 * were excluded), so callers can tell "zero after exclusion" from "warehouse omitted".
 */
export function aggregateSummaryByWarehouse(summaryResults = []) {
    const byWh = new Map();
    const seenWarehouses = new Set();
    for (const row of summaryResults) {
        const warehouseId = String(getAny(row, "WarehouseID", "SiteID", "Branch") || "").trim();
        if (!warehouseId || isExcludedBranchAlias(warehouseId)) continue;

        const key = warehouseId.toUpperCase();
        seenWarehouses.add(key);

        const locationId = String(getAny(row, "LocationID", "Location") || "").trim();
        if (isExcludedLocationAlias(locationId)) continue;
        // <UNASSIGNED> is allocation noise (often negative Available), not shelf stock.
        const locKey = locationId.replace(/^<|>$/g, "").trim().toUpperCase();
        if (!locKey || locKey === "UNASSIGNED") continue;

        const onHand = parseFloat(getAny(row, "QtyOnHand", "OnHand", "BaseQty") || 0);
        const rawAvail = getAny(
            row,
            "QtyAvailable",
            "Available",
            "QtyAvailableForShipment",
            "QtyAvail"
        );
        let available = rawAvail === "" || rawAvail == null ? NaN : parseFloat(rawAvail);
        if (Number.isNaN(available)) available = Number.isNaN(onHand) ? 0 : onHand;
        // Location rows can carry negative Available (e.g. <UNASSIGNED> allocations).
        // Floor per location so warehouse Available matches sellable qty managers see.
        if (!Number.isNaN(available)) available = Math.max(0, available);

        const prev = byWh.get(key) || {
            warehouse_id: warehouseId,
            on_hand: 0,
            available: 0,
        };
        prev.on_hand += Number.isNaN(onHand) ? 0 : onHand;
        prev.available += Number.isNaN(available) ? 0 : available;
        byWh.set(key, prev);
    }
    return { byWh, seenWarehouses };
}

/**
 * Aggregate DAMAGE / DISCOUNTED qty from Inventory Summary into one DAMAGE row per item.
 * Sellable warehouse totals still exclude these; this is for the Damage KPI only.
 */
export function extractDamageLevelsFromSummary(
    inventoryId,
    summaryResults = [],
    catalogFields = {},
    item = null
) {
    const invId = String(inventoryId || "").trim();
    if (!invId) return [];

    let onHand = 0;
    let available = 0;
    let found = false;

    for (const row of summaryResults) {
        const warehouseId = String(getAny(row, "WarehouseID", "SiteID", "Branch") || "").trim();
        const locationId = String(getAny(row, "LocationID", "Location") || "").trim();
        const isDamage =
            isExcludedBranchAlias(warehouseId) || isExcludedLocationAlias(locationId);
        if (!isDamage) continue;

        found = true;
        const qty = parseFloat(getAny(row, "QtyOnHand", "OnHand", "BaseQty") || 0);
        const rawAvail = getAny(
            row,
            "QtyAvailable",
            "Available",
            "QtyAvailableForShipment",
            "QtyAvail"
        );
        let avail = rawAvail === "" || rawAvail == null ? NaN : parseFloat(rawAvail);
        if (Number.isNaN(avail)) avail = Number.isNaN(qty) ? 0 : qty;
        onHand += Number.isNaN(qty) ? 0 : qty;
        available += Number.isNaN(avail) ? 0 : avail;
    }

    // WarehouseDetails fallback: whole warehouses named DAMAGE / DISCOUNTED
    if (item) {
        let wds = item.WarehouseDetails || [];
        if (wds && !Array.isArray(wds) && wds.value) wds = wds.value;
        if (Array.isArray(wds)) {
            for (const wh of wds) {
                const siteId = String(
                    getAny(wh, "SiteID", "Branch", "BranchID", "LinkBranch") ||
                        getAny(wh, "WarehouseID")
                ).trim();
                const warehouseId = String(getAny(wh, "WarehouseID") || siteId).trim();
                if (!isExcludedBranchAlias(siteId) && !isExcludedBranchAlias(warehouseId)) {
                    continue;
                }
                found = true;
                const qty = parseFloat(getAny(wh, "QtyOnHand", "OnHand", "Qty") || 0);
                const rawAvail = getAny(
                    wh,
                    "QtyAvailable",
                    "Available",
                    "QtyAvail",
                    "AvailableQty",
                    "QtyHardAvailable"
                );
                let avail = rawAvail === "" || rawAvail == null ? NaN : parseFloat(rawAvail);
                if (Number.isNaN(avail)) avail = Number.isNaN(qty) ? 0 : qty;
                onHand += Number.isNaN(qty) ? 0 : qty;
                available += Number.isNaN(avail) ? 0 : avail;
            }
        }
    }

    if (!found) return [];

    return [
        {
            inventory_id: invId,
            branch_id: "DAMAGE",
            site_id: "DAMAGE",
            warehouse_id: "DAMAGE",
            on_hand: onHand,
            available,
            ...catalogFields,
            item_type: catalogFields.item_type || (item ? getF(item, "ItemType") : "") || "",
            posting_class:
                catalogFields.posting_class || (item ? getF(item, "PostingClass") : "") || "",
        },
    ];
}

/**
 * Flatten Inventory Summary rows into location-level lines for tracing.
 */
export function mapSummaryLocations(summaryResults = []) {
    const locations = [];
    for (const row of summaryResults) {
        const warehouseId = String(getAny(row, "WarehouseID", "SiteID", "Branch") || "").trim();
        const locationId = String(getAny(row, "LocationID", "Location") || "").trim();
        if (!warehouseId && !locationId) continue;
        const onHand = parseFloat(getAny(row, "QtyOnHand", "OnHand", "BaseQty") || 0);
        const rawAvail = getAny(
            row,
            "QtyAvailable",
            "Available",
            "QtyAvailableForShipment",
            "QtyAvail"
        );
        let available = rawAvail === "" || rawAvail == null ? NaN : parseFloat(rawAvail);
        if (Number.isNaN(available)) available = Number.isNaN(onHand) ? 0 : onHand;
        const isDamage =
            isExcludedBranchAlias(warehouseId) || isExcludedLocationAlias(locationId);
        locations.push({
            warehouseId: warehouseId || "—",
            locationId: locationId || "—",
            onHand: Number.isNaN(onHand) ? 0 : onHand,
            available: Number.isNaN(available) ? 0 : available,
            isDamage,
        });
    }
    locations.sort((a, b) => {
        if (a.warehouseId !== b.warehouseId) {
            return a.warehouseId.localeCompare(b.warehouseId);
        }
        return String(a.locationId).localeCompare(String(b.locationId));
    });
    return locations;
}

/**
 * Build per-warehouse levels from Inventory Summary (location-accurate).
 * - Warehouses present in Summary: use Summary totals (0 if only DAMAGE/DISCOUNTED).
 * - Warehouses only in WarehouseDetails fallback: keep fallback qty (Summary omitted them).
 */
export function extractWarehouseLevelsFromSummary(
    inventoryId,
    summaryResults,
    catalogFields = {},
    fallbackLevels = []
) {
    const invId = String(inventoryId || "").trim();
    if (!invId) return [];

    const { byWh, seenWarehouses } = aggregateSummaryByWarehouse(summaryResults);
    const warehouseIds = new Set([
        ...byWh.keys(),
        ...seenWarehouses,
        ...fallbackLevels
            .map((l) => String(l.branch_id || l.warehouse_id || "").trim().toUpperCase())
            .filter(Boolean),
    ]);

    const levels = [];
    for (const key of warehouseIds) {
        if (!key || isExcludedBranchAlias(key)) continue;
        const fallback = fallbackLevels.find(
            (l) => String(l.branch_id || l.warehouse_id || "").trim().toUpperCase() === key
        );
        const inSummary = seenWarehouses.has(key);
        const agg = byWh.get(key);
        const onHand = inSummary
            ? (agg?.on_hand ?? 0)
            : (Number(fallback?.on_hand) || 0);
        const available = inSummary
            ? (agg?.available ?? 0)
            : (Number(fallback?.available) || Number(fallback?.on_hand) || 0);

        const warehouseId =
            fallback?.warehouse_id || fallback?.branch_id || agg?.warehouse_id || key;
        const siteId = fallback?.branch_id || fallback?.site_id || warehouseId;

        levels.push({
            inventory_id: invId,
            branch_id: siteId,
            site_id: siteId,
            warehouse_id: warehouseId,
            on_hand: onHand,
            available,
            ...catalogFields,
            item_type: catalogFields.item_type || "",
            posting_class: catalogFields.posting_class || "",
        });
    }
    return levels;
}

/** Extract PO detail lines from an Acumatica PurchaseOrder record */
const extractPoDetails = (po) => {
    let details =
        po?.Details ||
        po?.details ||
        po?.Transactions ||
        po?.transactions ||
        po?.PurchaseOrderDetails ||
        [];
    if (details && !Array.isArray(details) && details.value) details = details.value;
    return Array.isArray(details) ? details : [];
};

/** Map a single Acumatica PO detail line to the flattened UI model */
const mapPoLine = (line) => {
    const qty = parseFloat(getAny(line, "OrderQty", "Qty", "Quantity") || 0);
    const unitCost = parseFloat(getAny(line, "UnitCost", "CuryUnitCost") || 0);
    let extCost = parseFloat(getAny(line, "ExtendedCost", "LineAmount", "Amount", "CuryExtCost") || 0);
    if (!extCost && qty && unitCost) extCost = qty * unitCost;
    const warehouseId = String(
        getAny(line, "WarehouseID", "SiteID", "DestinationWarehouseID") ||
        getAny(line, "BranchID", "Branch") ||
        ""
    ).trim();

    return {
        inventoryId: getF(line, "InventoryID"),
        description: getAny(line, "LineDescription", "Description", "TransactionDescription"),
        qty,
        uom: getF(line, "UOM"),
        extCost,
        warehouseId,
        branchId: warehouseId,
    };
};

/** Map a PurchaseOrder header + lines to the API response shape */
const mapPurchaseOrder = (po) => {
    const headerBranch = String(
        getAny(po, "BranchID", "Branch", "DestinationBranchID", "ShipToBranch") || ""
    ).trim();
    const lines = extractPoDetails(po).map((line) => {
        const mapped = mapPoLine(line);
        // Do not copy document header Branch onto lines — that is often MAIN for all
        // company POs and would mis-attribute branch warehouse receipts as MAIN.
        return mapped;
    });
    return {
        orderNbr: getF(po, "OrderNbr"),
        orderType: getF(po, "OrderType"),
        status: getF(po, "Status"),
        date: getF(po, "Date"),
        // ETD in Acumatica PO (Promised On) — used as read-only ETD in the UI
        promisedDate: getAny(po, "PromisedOn", "ExpectedDate", "RequestedOn") || null,
        // May be empty on live fetch; MySQL sync fills from Purchase Receipts
        receiptDate: getAny(po, "LastReceiptDate", "ReceiptDate") || null,
        vendorId: getF(po, "VendorID"),
        vendorName: getAny(po, "VendorName", "VendorID_description", "VendorDescription"),
        totalAmount: parseFloat(getF(po, "OrderTotal") || 0),
        branchId: headerBranch || lines.find((l) => l.warehouseId)?.warehouseId || "",
        lines,
    };
};

/** Build OData filters for a PO number (handles combined type+nbr like MNLP260480). */
const buildOrderFilters = (orderNbr) => {
    const full = String(orderNbr || "").trim().replace(/'/g, "''");
    if (!full) return [];
    const filters = [`OrderNbr eq '${full}'`];
    const m = full.match(/^([A-Z]+)(\d+)$/);
    if (m) filters.push(`OrderType eq '${m[1]}' and OrderNbr eq '${m[2]}'`);
    return filters;
};

// --- SALES SYNC STATE MANAGEMENT ---
let activeSalesSyncId = 0;
let salesAbortController = null;

/** List Acumatica companies visible to the logged-in user (after main-company auth). */
export async function discoverAcumaticaCompanies(cookie) {
    const endpoints = [
        `${ACU_BASE}/Company?$select=CompanyID,CompanyName`,
        `${ACU_BASE}/Companies?$select=CompanyID,CompanyName`,
    ];
    for (const url of endpoints) {
        try {
            const res = await AcumaticaService.fetchWithRetry(url, cookie);
            const data = await res.json();
            const rows = data.value || (Array.isArray(data) ? data : []);
            if (!rows.length) continue;
            const companies = rows
                .map((r) => ({
                    id: String(getF(r, "CompanyID")).trim(),
                    name: String(getF(r, "CompanyName") || getF(r, "CompanyID")).trim(),
                }))
                .filter((c) => c.id);
            if (companies.length) return companies;
        } catch (err) {
            console.warn("[Acumatica discoverCompanies]", url, err.message);
        }
    }
    return [];
}

/** Pick the ecommerce company ID from discovery or env. */
export function pickEcommerceCompany(companies, mainCompanyId) {
    const mainKey = String(mainCompanyId || "").trim().toUpperCase();
    const envEcom = String(process.env.ACUMATICA_ECOM_COMPANY || "").trim();

    if (envEcom) {
        const envMatch = companies.find((c) => c.id.toUpperCase() === envEcom.toUpperCase());
        if (envMatch) return envMatch.id;
    }

    const ecomMatch = companies.find((c) => {
        const id = c.id.toUpperCase();
        const name = (c.name || "").toUpperCase();
        if (!id || id === mainKey) return false;
        return id.includes("ECOM") || name.includes("ECOM");
    });
    if (ecomMatch) return ecomMatch.id;

    const nonMain = companies.find((c) => c.id.toUpperCase() !== mainKey);
    return nonMain?.id || envEcom || null;
}

export const AcumaticaService = {
    async fetchWithRetry(url, credential, options = {}) {
        // credential can be a cookie string OR "__bearer__<token>" from session-store
        const isBearer = typeof credential === "string" && credential.startsWith("__bearer__");
        const authHeaders = isBearer
            ? { "Authorization": `Bearer ${credential.slice(10)}` }
            : { "Cookie": credential || "" };

        const maxAttempts = 5;
        let lastError = null;
        for (let attempts = 1; attempts <= maxAttempts; attempts++) {
            try {
                const res = await fetch(url, {
                    ...options,
                    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0", ...authHeaders, ...options.headers },
                    cache: 'no-store',
                });
                if (res.status === 401) throw new Error("Unauthorized");
                if (res.ok) return res;

                // Try to get detailed error from body
                let errorDetail = "";
                try {
                    const errJson = await res.json();
                    errorDetail = errJson.message || errJson.exceptionMessage || JSON.stringify(errJson);
                } catch {
                    errorDetail = `HTTP ${res.status}`;
                }

                lastError = new Error(`${errorDetail} (from ${url})`);
                if (res.status < 500) break; // Don't retry client errors
                await new Promise(r => setTimeout(r, 1000 * attempts));
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = err;
                // Transient DNS / network blips (ENOTFOUND, ENETUNREACH, ECONNRESET, …)
                const code = err?.cause?.code || err?.code || "";
                const transient =
                    /ENOTFOUND|ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(
                        `${code} ${err?.message || ""}`
                    );
                if (!transient || attempts >= maxAttempts) break;
                console.warn(
                    `>>> [Acumatica] Network retry ${attempts}/${maxAttempts}:`,
                    err?.message || code
                );
                await new Promise((r) => setTimeout(r, 1500 * attempts));
            }
        }
        throw lastError;
    },

    /**
     * Location-level stock via Inventory Summary (IN401000).
     * Used to exclude DAMAGE / DISCOUNTED location qty from warehouse totals.
     */
    async getInventorySummaryResults(inventoryId, cookie) {
        const id = String(inventoryId || "").trim();
        if (!id || !cookie) return [];

        const url = `${ACU_BASE}/InventorySummaryInquiry?$expand=Results`;
        const res = await this.fetchWithRetry(url, cookie, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ InventoryID: { value: id } }),
        });
        const data = await res.json();
        let results = data?.Results || [];
        if (results && !Array.isArray(results) && results.value) results = results.value;
        return Array.isArray(results) ? results : [];
    },

    /**
     * Warehouse stock with DAMAGE / DISCOUNTED locations excluded.
     * Falls back to WarehouseDetails if Inventory Summary is unavailable.
     */
    async resolveWarehouseLevels(item, catalogFields = {}, cookie) {
        const fallback = extractWarehouseLevels(item, catalogFields);
        const invId = String(getF(item, "InventoryID") || catalogFields.inventory_id || "").trim();
        const damageFromDetails = extractDamageLevelsFromSummary(invId, [], catalogFields, item);

        if (!invId || !cookie) {
            return { levels: fallback, damageLevels: damageFromDetails };
        }

        // Always probe Inventory Summary (IN401000). WarehouseDetails is often empty or
        // rolls DAMAGE locations into warehouse totals — Summary is the sellable source of truth.
        try {
            const results = await this.getInventorySummaryResults(invId, cookie);
            if (!results.length) {
                return { levels: fallback, damageLevels: damageFromDetails };
            }
            const damageLevels = extractDamageLevelsFromSummary(
                invId,
                results,
                catalogFields,
                item
            );
            return {
                levels: extractWarehouseLevelsFromSummary(invId, results, catalogFields, fallback),
                // Prefer summary damage; fall back to WarehouseDetails-only damage
                damageLevels: damageLevels.length ? damageLevels : damageFromDetails,
            };
        } catch (err) {
            console.warn(`[Acumatica] Inventory Summary failed for ${invId}:`, err.message);
            return { levels: fallback, damageLevels: damageFromDetails };
        }
    },

    /**
     * Resolve warehouse levels for many StockItems with limited concurrency.
     * Returns sellable levels plus aggregated DAMAGE rows for the Damage KPI.
     */
    async resolveWarehouseLevelsBatch(itemsWithCatalog, cookie, concurrency = 8) {
        const levels = [];
        const damageLevels = [];
        for (let i = 0; i < itemsWithCatalog.length; i += concurrency) {
            const slice = itemsWithCatalog.slice(i, i + concurrency);
            const batch = await Promise.all(
                slice.map(async ({ item, catalogFields }) => {
                    try {
                        return await this.resolveWarehouseLevels(item, catalogFields, cookie);
                    } catch (err) {
                        console.warn("[Acumatica] resolveWarehouseLevels:", err.message);
                        return {
                            levels: extractWarehouseLevels(item, catalogFields),
                            damageLevels: extractDamageLevelsFromSummary(
                                getF(item, "InventoryID"),
                                [],
                                catalogFields,
                                item
                            ),
                        };
                    }
                })
            );
            for (const part of batch) {
                if (Array.isArray(part)) {
                    // Legacy array return safety
                    levels.push(...part);
                } else {
                    levels.push(...(part.levels || []));
                    damageLevels.push(...(part.damageLevels || []));
                }
            }
        }
        return { levels, damageLevels };
    },

    /** Acumatica Branch master (organizational units) — never Warehouse. */
    async getBranches(cookie) {
        const real = await this.getRealBranches(cookie);
        return real
            .map((b) => {
                const id = String(b.BranchID || "").trim();
                const name = String(b.Description || b.BranchID || id).trim();
                if (!id) return null;
                return {
                    SiteID: id,
                    BranchID: id,
                    Description: { value: name || id },
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.SiteID.localeCompare(b.SiteID));
    },

    /** Physical warehouses / sites (Inventory destinations only — do not use for Branch pickers). */
    async getWarehouses(cookie) {
        const url = `${ACU_BASE}/Warehouse?$select=WarehouseID,Description`;
        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        return (data.value || [])
            .map((w) => ({
                SiteID: w.WarehouseID?.value || w.WarehouseID,
                Description: {
                    value: getF(w, "Description") || (w.WarehouseID?.value || w.WarehouseID),
                },
            }))
            .filter((w) => w.SiteID)
            .sort((a, b) => String(a.SiteID).localeCompare(String(b.SiteID)));
    },

    /**
     * Acumatica Branch entity only.
     * Does NOT fall back to Warehouse — Branch pickers must never show warehouse sites.
     */
    async getRealBranches(cookie) {
        const attempts = [
            `${ACU_BASE}/Branch?$select=BranchID,BranchName,Description,Active&$filter=Active eq true`,
            `${ACU_BASE}/Branch?$select=BranchID,BranchName,Description,Active`,
            `${ACU_BASE}/Branch?$select=BranchID,Description`,
            `${ACU_BASE}/Branch?$top=500`,
        ];

        let lastError = null;
        for (const url of attempts) {
            try {
                const res = await this.fetchWithRetry(url, cookie);
                const data = await res.json();
                const raw = data.value || (Array.isArray(data) ? data : []);
                const mapped = raw
                    .map((b) => {
                        const id = String(getAny(b, "BranchID", "Branch") || "").trim();
                        if (!id) return null;
                        const activeRaw = getAny(b, "Active");
                        if (activeRaw !== "" && activeRaw !== null && activeRaw !== undefined) {
                            const active =
                                activeRaw === true ||
                                activeRaw === "true" ||
                                activeRaw === 1 ||
                                activeRaw === "1";
                            if (!active) return null;
                        }
                        const name = String(
                            getAny(b, "BranchName", "Description", "BranchID") || id
                        ).trim();
                        return { BranchID: id, Description: name || id };
                    })
                    .filter(Boolean);

                if (mapped.length > 0) {
                    console.log(`[Acumatica] Loaded ${mapped.length} Branch record(s)`);
                    return mapped;
                }
            } catch (err) {
                lastError = err;
                console.warn(`[Acumatica] Branch fetch attempt failed: ${err.message}`);
            }
        }

        throw new Error(
            lastError?.message ||
                "Acumatica Branch entity returned no records (Warehouse fallback disabled)"
        );
    },

    async getStockItems({ page = 1, pageSize = 50, search = "", branch = "", cookie, includeStats = false, includeCount = false }) {
        const skip = (page - 1) * pageSize;
        const top = pageSize;

        let filterArr = [];
        if (search) {
            const s = search.replace(/'/g, "''");
            // ERP only supports AND. Using substringof on InventoryID as it's the primary identifier.
            filterArr.push(`substringof('${s}', InventoryID)`);
        }

        let queryParams = [`$expand=WarehouseDetails`, `$top=${top}`, `$skip=${skip}`, `$count=true`];
        if (filterArr.length > 0) {
            queryParams.push(`$filter=${encodeURIComponent(filterArr.join(" and "))}`);
        }

        const url = `${ACU_BASE}/StockItem?${queryParams.join("&")}`;
        console.log(`>>> [Acumatica] Fetching StockItems: ${url}`);

        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        const items = data.value || [];
        const totalCount = data["@odata.count"] || items.length;

        const prepared = items.map((item) => ({
            item,
            catalogFields: {
                description: getF(item, "Description"),
                item_class: getF(item, "ItemClass"),
                default_price: parseFloat(getF(item, "DefaultPrice") || 0),
                item_status: getF(item, "ItemStatus"),
                base_unit: getF(item, "BaseUnit"),
                item_type: getF(item, "ItemType"),
                posting_class: getF(item, "PostingClass"),
            },
        }));
        const resolved = await this.resolveWarehouseLevelsBatch(prepared, cookie, 8);
        const levels = Array.isArray(resolved) ? resolved : resolved?.levels || [];

        let flattened = [];
        const levelsByItem = new Map();
        for (const level of levels) {
            const key = String(level.inventory_id || "").trim();
            if (!levelsByItem.has(key)) levelsByItem.set(key, []);
            levelsByItem.get(key).push(level);
        }

        for (const item of items) {
            const invId = String(getF(item, "InventoryID")).trim();
            const itemLevels = levelsByItem.get(invId) || [];
            if (itemLevels.length === 0) {
                if (!branch) {
                    flattened.push({
                        InventoryID: { value: invId },
                        Description: { value: getF(item, "Description") },
                        Branch: { value: "—" },
                        SiteID: { value: "—" },
                        OnHand: { value: 0 },
                        Available: { value: 0 },
                        DefaultPrice: { value: parseFloat(getF(item, "DefaultPrice") || 0) },
                        ItemClass: { value: getF(item, "ItemClass") },
                    });
                }
                continue;
            }
            for (const level of itemLevels) {
                const siteId = String(level.branch_id || "").trim();
                if (!siteId || isExcludedBranchAlias(siteId)) continue;
                if (branch && siteId.toLowerCase() !== branch.toLowerCase()) continue;

                flattened.push({
                    InventoryID: { value: invId },
                    Description: { value: getF(item, "Description") },
                    Branch: { value: siteId },
                    SiteID: { value: siteId },
                    OnHand: { value: level.on_hand },
                    Available: { value: level.available },
                    DefaultPrice: { value: parseFloat(getF(item, "DefaultPrice") || 0) },
                    ItemClass: { value: getF(item, "ItemClass") },
                    ItemStatus: { value: getF(item, "ItemStatus") },
                    BaseUnit: { value: getF(item, "BaseUnit") },
                    VendorID: { value: getAny(item, "PreferredVendorID", "DefaultVendorID", "VendorID") },
                    LeadTimeDays: { value: parsePlanningNumber(getAny(item, "LeadTimeDays", "LeadTime", "PurchLeadTime")) },
                    SafetyStock: { value: parsePlanningNumber(getAny(item, "SafetyStock", "SafetyStockQty", "ReorderPoint")) },
                    MOQ: { value: parsePlanningNumber(getAny(item, "MinOrderQty", "MOQ", "MinimumOrderQuantity")) },
                });
            }
        }

        return {
            data: flattened,
            totalCount: totalCount,
            hasMore: items.length === pageSize,
            globalStats: includeStats
                ? await this.computeInventoryStats({ cookie, branch, search })
                : undefined,
        };
    },

    /**
     * Aggregate on-hand totals from Acumatica when MySQL warehouse rows are missing.
     */
    async computeInventoryStats({ cookie, branch = "", search = "" }) {
        const searchUpper = search.trim().toUpperCase();
        let skip = 0;
        const pageSize = 100;
        let totalStock = 0;
        let totalValue = 0;
        let lowStock = 0;
        let totalLowStock = 0;
        let outOfStock = 0;
        const productIds = new Set();

        while (true) {
            let filterArr = [];
            if (search) {
                const s = search.replace(/'/g, "''");
                filterArr.push(`substringof('${s}', InventoryID)`);
            }
            let queryParams = [`$expand=WarehouseDetails`, `$top=${pageSize}`, `$skip=${skip}`];
            if (filterArr.length > 0) {
                queryParams.push(`$filter=${encodeURIComponent(filterArr.join(" and "))}`);
            }
            const url = `${ACU_BASE}/StockItem?${queryParams.join("&")}`;
            const res = await this.fetchWithRetry(url, cookie);
            const items = (await res.json()).value || [];
            if (!items.length) break;

            for (const item of items) {
                const invId = String(getF(item, "InventoryID")).trim();
                if (!invId) continue;
                if (searchUpper && !invId.toUpperCase().includes(searchUpper) &&
                    !String(getF(item, "Description")).toUpperCase().includes(searchUpper)) {
                    continue;
                }
                const price = parseFloat(getF(item, "DefaultPrice") || 0);
                const levels = extractWarehouseLevels(item, {});
                for (const l of levels) {
                    if (branch && l.branch_id.toUpperCase() !== branch.toUpperCase()) continue;
                    productIds.add(invId);
                    const oh = Number(l.on_hand) || 0;
                    totalStock += oh;
                    totalValue += oh * price;
                    if (oh <= 0) outOfStock += 1;
                    else if (oh < 10) {
                        lowStock += 1;
                        totalLowStock += oh;
                    }
                }
            }

            if (items.length < pageSize) break;
            skip += pageSize;
        }

        return {
            totalStock,
            totalValue,
            lowStock,
            totalLowStock,
            outOfStock,
            deadStock: 0,
            overstock: 0,
            count: productIds.size,
            lastSync: new Date().toISOString(),
        };
    },

    async getSalesAnalysis({ branch, cookie, startDate, endDate }) {
        let filterArr = [];
        if (startDate) filterArr.push(`Date ge datetimeoffset'${startDate}T00:00:00Z'`);
        if (endDate) filterArr.push(`Date le datetimeoffset'${endDate}T23:59:59Z'`);
        if (branch) filterArr.push(`Branch eq '${branch}'`);

        const filter = filterArr.length > 0 ? `&$filter=${filterArr.join(" and ")}` : "";
        const url = `${ACU_BASE}/SalesInvoice?$expand=Details&$top=1000${filter}`;

        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        return data.value || [];
    },

    /**
     * Paginate an Acumatica sales document entity for a date range.
     */
    async fetchSalesDocuments({ cookie, entity, startDate, endDate, extraFilter = "" }) {
        const filterParts = [
            `Date ge datetimeoffset'${startDate}T00:00:00Z'`,
            `Date le datetimeoffset'${endDate}T23:59:59Z'`,
        ];
        if (extraFilter) filterParts.push(extraFilter);

        const encoded = encodeURIComponent(filterParts.join(" and "));
        const pageSize = 100;
        const all = [];
        let skip = 0;

        while (true) {
            const url = `${ACU_BASE}/${entity}?$expand=Details&$top=${pageSize}&$skip=${skip}&$filter=${encoded}&$orderby=Date desc`;
            const res = await this.fetchWithRetry(url, cookie);
            const data = await res.json();
            const batch = data.value || (Array.isArray(data) ? data : []);
            all.push(...batch);
            if (batch.length < pageSize) break;
            skip += pageSize;
        }
        return all;
    },

    /**
     * Net 90-day sales by inventory ID for one branch — matches Acumatica Sales Invoice lines.
     */
    async fetchBranchSalesSummary({ cookie, branch, lookbackDays = SALES_LOOKBACK_DAYS }) {
        const end = new Date();
        const start = new Date(end);
        start.setDate(end.getDate() - (Number(lookbackDays) || SALES_LOOKBACK_DAYS) + 1);
        const startDate = toISODate(start);
        const endDate = toISODate(end);

        const [salesInvoices, creditMemos, debitMemos] = await Promise.all([
            this.fetchSalesDocuments({ cookie, entity: "SalesInvoice", startDate, endDate }),
            this.fetchSalesDocuments({
                cookie,
                entity: "Invoice",
                startDate,
                endDate,
                extraFilter: "Type eq 'Credit Memo'",
            }),
            this.fetchSalesDocuments({
                cookie,
                entity: "Invoice",
                startDate,
                endDate,
                extraFilter: "Type eq 'Debit Memo'",
            }),
        ]);

        // SalesInvoice can include memo types already pulled from Invoice — keep invoices only.
        const invoicesOnly = salesInvoices.filter((inv) => {
            const t = String(getF(inv, "Type") || "Invoice");
            return t !== "Credit Memo" && t !== "Debit Memo";
        });

        return aggregateBranchSales([...invoicesOnly, ...creditMemos, ...debitMemos], {
            branch,
            startDate,
            endDate,
        });
    },

    /**
     * Gross outbound 90-day sales by inventory ID (invoices + debit memos, no credit subtraction).
     * Primary source for replenishment velocity — matches how branches sell through stock.
     */
    async fetchBranchGrossSalesSummary({ cookie, branch, lookbackDays = SALES_LOOKBACK_DAYS }) {
        const end = new Date();
        const start = new Date(end);
        start.setDate(end.getDate() - (Number(lookbackDays) || SALES_LOOKBACK_DAYS) + 1);
        const startDate = toISODate(start);
        const endDate = toISODate(end);

        const [salesInvoices, debitMemos] = await Promise.all([
            this.fetchSalesDocuments({ cookie, entity: "SalesInvoice", startDate, endDate }),
            this.fetchSalesDocuments({
                cookie,
                entity: "Invoice",
                startDate,
                endDate,
                extraFilter: "Type eq 'Debit Memo'",
            }),
        ]);

        const invoicesOnly = salesInvoices.filter((inv) => {
            const t = String(getF(inv, "Type") || "Invoice");
            return t !== "Credit Memo" && t !== "Debit Memo";
        });

        return aggregateBranchGrossSales([...invoicesOnly, ...debitMemos], {
            branch,
            startDate,
            endDate,
        });
    },

    /**
     * Pull sales documents from Acumatica for MySQL sync (SalesInvoice + AR memos).
     *
     * Incremental mode prefers LastModified* filters. Acumatica often rejects
     * LastModifiedDateTime + $expand=Details over a large window
     * ("An error has occurred") — we fall back to short Date windows.
     *
     * @param {object} opts
     * @param {Function} [opts.onBatch] - async (rows) => {} called after each chunk so MySQL can checkpoint
     */
    async fetchPeriodicSalesForSync({
        cookie,
        startDate,
        endDate,
        lastModifiedAfter = null,
        onBatch = null,
        maxCatchupDays = 14,
        chunkDays = 7,
    }) {
        const pageSize = 50;
        /** Cap long catch-ups so one sync doesn't run for hours / trip the network. */
        const CATCHUP_DAYS = Math.max(1, Math.min(60, Number(maxCatchupDays) || 14));

        const fetchEntityPages = async (entity, filter) => {
            const encoded = encodeURIComponent(filter);
            const all = [];
            let skip = 0;
            while (true) {
                const url = `${ACU_BASE}/${entity}?$expand=Details&$top=${pageSize}&$skip=${skip}&$filter=${encoded}`;
                const res = await this.fetchWithRetry(url, cookie);
                const data = await res.json();
                const batch = data.value || (Array.isArray(data) ? data : []);
                all.push(...batch);
                if (batch.length < pageSize) break;
                skip += pageSize;
            }
            return all;
        };

        /** Sequential entity fetches — fewer parallel Acumatica hits, more stable on flaky networks. */
        const fetchAllEntities = async (baseFilter) => {
            const salesInvoices = await fetchEntityPages("SalesInvoice", baseFilter);
            const creditMemos = await fetchEntityPages(
                "Invoice",
                `${baseFilter} and Type eq 'Credit Memo'`
            );
            const debitMemos = await fetchEntityPages(
                "Invoice",
                `${baseFilter} and Type eq 'Debit Memo'`
            );
            return { salesInvoices, creditMemos, debitMemos };
        };

        const toDay = (d) => {
            const x = d instanceof Date ? d : new Date(d);
            return Number.isFinite(x.getTime()) ? x.toISOString().slice(0, 10) : null;
        };

        const formatOData = (date) => date.toISOString().replace(/\.\d{3}/, "");

        /** Inclusive UTC day windows (keeps $expand=Details payloads small). */
        const dayWindows = (fromDay, toDay, sizeDays = 2) => {
            const windows = [];
            if (!fromDay || !toDay) return windows;
            let cursor = new Date(`${fromDay}T00:00:00Z`);
            const end = new Date(`${toDay}T00:00:00Z`);
            if (cursor > end) return windows;
            while (cursor <= end) {
                const winEnd = new Date(cursor);
                winEnd.setUTCDate(winEnd.getUTCDate() + Math.max(1, sizeDays) - 1);
                if (winEnd > end) winEnd.setTime(end.getTime());
                windows.push({
                    start: cursor.toISOString().slice(0, 10),
                    end: winEnd.toISOString().slice(0, 10),
                });
                cursor = new Date(winEnd);
                cursor.setUTCDate(cursor.getUTCDate() + 1);
            }
            return windows;
        };

        const docsToRows = (docs, lastSyncOverride = null) => {
            const { salesInvoices, creditMemos, debitMemos } = docs || {
                salesInvoices: [],
                creditMemos: [],
                debitMemos: [],
            };
            const rows = [
                ...invoicesToPeriodicSalesRows(salesInvoices, { idPrefix: "SI", defaultOrderType: "Invoice" }),
                ...invoicesToPeriodicSalesRows(creditMemos, { idPrefix: "CM", defaultOrderType: "Credit Memo" }),
                ...invoicesToPeriodicSalesRows(debitMemos, { idPrefix: "DM", defaultOrderType: "Debit Memo" }),
            ];
            if (lastSyncOverride) {
                for (const r of rows) r.last_sync = lastSyncOverride;
            }
            return rows;
        };

        const emit = async (rows) => {
            if (!rows.length) return rows;
            if (typeof onBatch === "function") {
                await onBatch(rows);
            }
            return rows;
        };

        const allRows = [];

        if (lastModifiedAfter) {
            const sinceRaw = String(lastModifiedAfter).trim();
            let sinceIso = sinceRaw.includes("T")
                ? sinceRaw.replace(/\.\d{3}/, "")
                : `${sinceRaw}T00:00:00Z`;
            let sinceDate = new Date(sinceIso);
            const untilDay = endDate || toDay(new Date());

            const capDate = new Date();
            capDate.setUTCDate(capDate.getUTCDate() - CATCHUP_DAYS);
            if (Number.isFinite(sinceDate.getTime()) && sinceDate < capDate) {
                console.warn(
                    `>>> [SalesSync] Watermark ${sinceIso} is older than ${CATCHUP_DAYS}d — capping catch-up to ${formatOData(capDate)}`
                );
                sinceDate = capDate;
                sinceIso = formatOData(capDate);
            }
            const sinceDay = toDay(sinceDate) || startDate;

            let docs = null;
            const strategies = [
                {
                    name: "LastModifiedDateTime",
                    run: () =>
                        fetchAllEntities(`LastModifiedDateTime gt datetimeoffset'${sinceIso}'`),
                },
                {
                    name: "LastModified",
                    run: () => fetchAllEntities(`LastModified gt datetimeoffset'${sinceIso}'`),
                },
            ];

            for (const strategy of strategies) {
                try {
                    console.log(`>>> [SalesSync] Trying filter strategy: ${strategy.name} since ${sinceIso}`);
                    docs = await strategy.run();
                    console.log(`>>> [SalesSync] Strategy ${strategy.name} succeeded`);
                    break;
                } catch (err) {
                    console.warn(
                        `>>> [SalesSync] Strategy ${strategy.name} failed:`,
                        err?.message || err
                    );
                }
            }

            if (docs) {
                const rows = docsToRows(docs);
                await emit(rows);
                allRows.push(...rows);
            } else {
                console.warn(
                    `>>> [SalesSync] Falling back to Date windows ${sinceDay} → ${untilDay}`
                );
                const windows = dayWindows(sinceDay, untilDay, 2);
                for (let i = 0; i < windows.length; i++) {
                    const w = windows[i];
                    const filter =
                        `Date ge datetimeoffset'${w.start}T00:00:00Z' and ` +
                        `Date le datetimeoffset'${w.end}T23:59:59Z'`;
                    console.log(
                        `>>> [SalesSync] Date window ${i + 1}/${windows.length}: ${w.start} .. ${w.end}`
                    );
                    try {
                        const winDocs = await fetchAllEntities(filter);
                        // Checkpoint watermark at window end so a mid-sync failure can resume
                        const rows = docsToRows(winDocs, new Date(`${w.end}T23:59:59Z`));
                        await emit(rows);
                        allRows.push(...rows);
                    } catch (winErr) {
                        console.error(
                            `>>> [SalesSync] Window ${w.start}..${w.end} failed:`,
                            winErr?.message || winErr
                        );
                        if (allRows.length > 0) {
                            console.warn(
                                `>>> [SalesSync] Partial success — ${allRows.length} line(s) saved; resume next run from last checkpoint`
                            );
                            return allRows;
                        }
                        throw winErr;
                    }
                }
            }
        } else {
            const fromDay = startDate;
            const untilDay = endDate || toDay(new Date());
            const from = new Date(`${fromDay}T00:00:00Z`);
            const to = new Date(`${untilDay}T00:00:00Z`);
            const spanDays = Math.max(0, Math.round((to - from) / 86400000));

            const size = Math.max(1, Number(chunkDays) || 7);
            if (spanDays > size) {
                console.log(
                    `>>> [SalesSync] Full range ${fromDay}→${untilDay} (${spanDays}d) — chunking by ${size}d`
                );
                for (const w of dayWindows(fromDay, untilDay, size)) {
                    const filter =
                        `Date ge datetimeoffset'${w.start}T00:00:00Z' and ` +
                        `Date le datetimeoffset'${w.end}T23:59:59Z'`;
                    console.log(`>>> [SalesSync] Date window ${w.start} .. ${w.end}`);
                    try {
                        const winDocs = await fetchAllEntities(filter);
                        const rows = docsToRows(winDocs, new Date(`${w.end}T23:59:59Z`));
                        await emit(rows);
                        allRows.push(...rows);
                    } catch (winErr) {
                        console.error(
                            `>>> [SalesSync] Window ${w.start}..${w.end} failed:`,
                            winErr?.message || winErr
                        );
                    }
                }
            } else {
                const filter =
                    `Date ge datetimeoffset'${fromDay}T00:00:00Z' and ` +
                    `Date le datetimeoffset'${untilDay}T23:59:59Z'`;
                const docs = await fetchAllEntities(filter);
                const rows = docsToRows(docs);
                await emit(rows);
                allRows.push(...rows);
            }
        }

        return allRows;
    },

    /** ── VENDORS ── */

    _vendorAuthHeaders(credential) {
        const isBearer = typeof credential === "string" && credential.startsWith("__bearer__");
        return {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
            ...(isBearer
                ? { Authorization: `Bearer ${credential.slice(10)}` }
                : { Cookie: credential || "" }),
        };
    },

    _mapVendorRow(v) {
        const vendorId = String(getF(v, "VendorID")).trim();
        const vendorName = String(getAny(v, "VendorName", "AccountName", "LegalName")).trim();
        if (!vendorId || !vendorName) return null;
        return {
            vendor_id: vendorId,
            vendor_name: vendorName,
            status: String(getF(v, "Status")).trim() || "Active",
            last_sync: new Date(),
        };
    },

    /**
     * One-shot Vendor read. Does not use fetchWithRetry — a vendor-name
     * search must not sit through five retries and stall the PO list.
     */
    async _getVendorJson(url, credential, timeoutMs = 8000) {
        const res = await fetch(url, {
            headers: this._vendorAuthHeaders(credential),
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(detail.slice(0, 180) || `HTTP ${res.status}`);
        }
        return res.json();
    },

    /**
     * One page of the vendor directory. $select keeps this small — the full
     * Vendor document is slow enough that per-id filters were timing out.
     */
    async lookupVendorDirectory(credential, { top = 500, skip = 0 } = {}) {
        if (!credential || credential === "__bypass__") return [];
        const url = `${ACU_BASE}/Vendor?$top=${top}&$skip=${skip}`;
        try {
            const data = await this._getVendorJson(url, credential, 90000);
            const raw = data.value || [];
            const rows = raw.map((v) => this._mapVendorRow(v)).filter(Boolean);
            if (!rows.length && raw[0]) {
                console.warn("[Acumatica] Vendor directory row had no name. Keys:", Object.keys(raw[0]).slice(0, 20).join(", "));
            }
            console.log(`[Acumatica] Vendor directory page skip=${skip}: ${rows.length} named vendor(s) of ${raw.length}.`);
            return rows;
        } catch (err) {
            console.warn("[Acumatica] Vendor directory lookup skipped:", err.message);
            return [];
        }
    },

    /** Resolve Acumatica vendors whose name contains the search text. */
    async lookupVendorsByName(search, credential) {
        const s = String(search || "").trim().replace(/'/g, "''");
        if (s.length < 2 || !credential || credential === "__bypass__") return [];
        const url = `${ACU_BASE}/Vendor?$top=50&$filter=substringof('${s}', VendorName)`;
        try {
            const data = await this._getVendorJson(url, credential);
            const vendors = data.value || [];
            return vendors.map((v) => this._mapVendorRow(v)).filter(Boolean);
        } catch (err) {
            console.warn("[Acumatica] Vendor name lookup skipped:", err.message);
            return [];
        }
    },

    /** Resolve specific VendorIDs that exist on local POs but not in the vendor directory. */
    async lookupVendorsByIds(vendorIds, credential) {
        const ids = [...new Set((vendorIds || []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 40);
        if (!ids.length || !credential || credential === "__bypass__") return [];

        const out = [];
        const notFound = [];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(6, ids.length) }, async () => {
            while (cursor < ids.length) {
                const id = ids[cursor++];
                const safe = id.replace(/'/g, "''");
                const url = `${ACU_BASE}/Vendor?$top=1&$filter=VendorID eq '${safe}'`;
                try {
                    const data = await this._getVendorJson(url, credential);
                    const row = this._mapVendorRow((data.value || [])[0]);
                    if (row) out.push(row);
                    else notFound.push(id);
                } catch (err) {
                    console.warn(`[Acumatica] Vendor ${id} lookup skipped:`, err.message);
                }
            }
        });
        await Promise.all(workers);
        return { rows: out, notFound };
    },

    async getVendors({ page = 1, pageSize = 50, search = "", cookie }) {
        const top = parseInt(pageSize, 10);
        const skip = (parseInt(page, 10) - 1) * top;
        let url = `${ACU_BASE}/Vendor?$top=${top}&$skip=${skip}`;
        
        if (search) {
            const s = search.replace(/'/g, "''");
            // Only search by VendorID if ERP doesn't support OR
            // Or try substringof if supported. Based on probe, substringof is supported but NOT OR.
            // We'll prioritize VendorID startswith for reliability or just skip OData filter and fetch more.
            url += `&$filter=substringof('${s}', VendorID)`;
        }

        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        const vendors = data.value || [];

        return {
            vendors: vendors.map(v => ({
                vendorId: getF(v, "VendorID"),
                vendorName: getF(v, "VendorName"),
                status: getF(v, "Status"),
                reliabilityScore: 100 // Placeholder
            })),
            totalCount: vendors.length,
            hasMore: vendors.length === top
        };
    },

    /** ── PURCHASE ORDERS ── */
    async getPurchaseOrders({ page = 1, pageSize = 50, search = "", cookie, startDate = "", endDate = "", status = "", branch = "" }) {
        const skip = (page - 1) * pageSize;
        // When filtering by branch client-side, over-fetch so page still fills reasonably
        const top = branch ? Math.min(200, pageSize * 4 + 1) : pageSize + 1;

        let filterArr = [];
        if (search) {
            const s = search.replace(/'/g, "''");
            // ERP only supports AND. Cannot use OR. 
            // We will filter by OrderNbr primarily as it's the most common search target.
            filterArr.push(`substringof('${s}', OrderNbr)`);
        }
        if (status) {
            filterArr.push(`Status eq '${status}'`);
        }
        if (startDate) {
            filterArr.push(`Date ge datetimeoffset'${startDate}T00:00:00Z'`);
        }
        if (endDate) {
            filterArr.push(`Date le datetimeoffset'${endDate}T23:59:59Z'`);
        }

        let queryParams = [
            `$expand=Details`,
            `$top=${top}`,
            `$skip=${skip}`,
            `$orderby=${encodeURIComponent("Date desc,OrderNbr desc")}`
        ];
        if (filterArr.length > 0) {
            queryParams.push(`$filter=${encodeURIComponent(filterArr.join(" and "))}`);
        }

        const url = `${ACU_BASE}/PurchaseOrder?${queryParams.join("&")}`;

        console.log(`>>> [Acumatica] Fetching PO: ${url}`);
        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        const rawOrders = data.value || (Array.isArray(data) ? data : []);

        let orders = rawOrders.map(mapPurchaseOrder);
        if (branch) {
            const b = String(branch).trim().toUpperCase();
            orders = orders.filter((o) => {
                if (String(o.branchId || "").trim().toUpperCase() === b) return true;
                return (o.lines || []).some((l) => {
                    const wh = String(l.warehouseId || l.branchId || "").trim().toUpperCase();
                    return wh === b;
                });
            });
        }

        const hasMore = branch
            ? rawOrders.length >= top
            : rawOrders.length > pageSize;
        orders = orders.slice(0, pageSize);

        return { orders, hasMore };
    },

    /**
     * Authoritative Open PO numbers from Acumatica (all vendors/branches).
     * Uses Status eq 'Open' so ERP-Open rows with receipts are not missed.
     */
    async fetchOpenPurchaseOrderNbrs({ cookie, startDate = "2024-01-01" } = {}) {
        if (!cookie || cookie === "__bypass__") return [];
        const open = new Set();
        const top = 100;
        let skip = 0;
        const start = String(startDate || "2024-01-01").slice(0, 10);
        const filter = start
            ? `Status eq 'Open' and Date ge datetimeoffset'${start}T00:00:00Z'`
            : `Status eq 'Open'`;

        while (true) {
            const url = `${ACU_BASE}/PurchaseOrder?$top=${top}&$skip=${skip}&$filter=${encodeURIComponent(filter)}`;
            const res = await this.fetchWithRetry(url, cookie);
            const data = await res.json();
            const rows = data.value || (Array.isArray(data) ? data : []);
            if (!rows.length) break;
            for (const row of rows) {
                const nbr = String(getF(row, "OrderNbr") || "").trim();
                if (nbr) open.add(nbr);
            }
            if (rows.length < top) break;
            skip += rows.length;
            if (skip > 50000) break;
        }
        return [...open];
    },

    /**
     * Current Acumatica status for specific order numbers.
     * Matches both OrderNbr and OrderType+OrderNbr (MNLP + 260480 = MNLP260480).
     */
    async fetchPurchaseOrderStatusesByNbrs({ cookie, orderNbrs = [] } = {}) {
        if (!cookie || cookie === "__bypass__") return [];
        const nbrs = [...new Set(
            (orderNbrs || []).map((n) => String(n || "").trim()).filter(Boolean)
        )];
        if (!nbrs.length) return [];

        const found = new Map();
        const remember = (key, status) => {
            const id = String(key || "").trim();
            if (!id || !status) return;
            found.set(id, { orderNbr: id, status });
            found.set(id.toUpperCase(), { orderNbr: id, status });
        };
        const BATCH = 20;

        for (let i = 0; i < nbrs.length; i += BATCH) {
            const batch = nbrs.slice(i, i + BATCH);
            const filter = batch
                .map((n) => `OrderNbr eq '${n.replace(/'/g, "''")}'`)
                .join(" or ");
            try {
                const url = `${ACU_BASE}/PurchaseOrder?$top=${BATCH}&$filter=${encodeURIComponent(filter)}`;
                const res = await this.fetchWithRetry(url, cookie);
                const data = await res.json();
                const rows = data.value || (Array.isArray(data) ? data : []);
                for (const row of rows) {
                    const orderNbr = String(getF(row, "OrderNbr") || "").trim();
                    const orderType = String(getF(row, "OrderType") || "").trim();
                    const status = String(getF(row, "Status") || "").trim();
                    remember(orderNbr, status);
                    if (orderType && orderNbr) remember(`${orderType}${orderNbr}`, status);
                }
            } catch (err) {
                console.warn("[Acumatica] PO status batch skipped:", err?.message || err);
            }
            const missed = batch.filter((n) => !found.has(n) && !found.has(n.toUpperCase()));
            const splitFilters = missed
                .map((n) => ({ n, filter: buildOrderFilters(n)[1] }))
                .filter((item) => item.filter);
            for (let j = 0; j < splitFilters.length; j += 10) {
                const group = splitFilters.slice(j, j + 10);
                const splitFilter = group.map((item) => `(${item.filter})`).join(" or ");
                try {
                    const url = `${ACU_BASE}/PurchaseOrder?$top=${group.length}&$filter=${encodeURIComponent(splitFilter)}`;
                    const res = await this.fetchWithRetry(url, cookie);
                    const data = await res.json();
                    const rows = data.value || (Array.isArray(data) ? data : []);
                    for (const row of rows) {
                        const orderNbr = String(getF(row, "OrderNbr") || "").trim();
                        const orderType = String(getF(row, "OrderType") || "").trim();
                        const status = String(getF(row, "Status") || "").trim();
                        const combined = orderType && orderNbr ? `${orderType}${orderNbr}` : "";
                        for (const item of group) {
                            const local = item.n.toUpperCase();
                            if (local === orderNbr.toUpperCase() || (combined && local === combined.toUpperCase())) {
                                remember(item.n, status);
                            }
                        }
                    }
                } catch (err) {
                    console.warn("[Acumatica] PO status lookup skipped:", err?.message || err);
                }
            }
        }
        const localKeys = new Set(nbrs.map((n) => n.toUpperCase()));
        const byLocal = new Map();
        for (const [key, value] of found) {
            if (!localKeys.has(String(key).toUpperCase())) continue;
            const local = nbrs.find((n) => n.toUpperCase() === String(key).toUpperCase());
            if (local) byLocal.set(local, { orderNbr: local, status: value.status });
        }
        return [...byLocal.values()];
    },

    /**
     * Purchase orders in a terminal Acumatica status (Closed, Completed, …).
     * Order date is not the close date, so the window must stay wide enough to
     * include older orders that were finished later.
     */
    async fetchPurchaseOrdersByStatuses({ cookie, statuses = [], startDate = "2024-01-01", onPage = null } = {}) {
        if (!cookie || cookie === "__bypass__") return [];
        const wanted = [...new Set(
            (statuses || []).map((s) => String(s || "").trim()).filter(Boolean)
        )];
        if (!wanted.length) return [];

        const found = new Map();
        const start = String(startDate || "2024-01-01").slice(0, 10);
        const remember = (orderNbr, orderType, rowStatus) => {
            const nbr = String(orderNbr || "").trim();
            const type = String(orderType || "").trim();
            const statusValue = String(rowStatus || "").trim();
            if (!nbr || !statusValue) return [];
            const keys = [nbr];
            if (type && !nbr.toUpperCase().startsWith(type.toUpperCase())) {
                keys.push(`${type}${nbr}`);
            }
            const page = [];
            for (const key of keys) {
                const entry = { orderNbr: key, status: statusValue };
                found.set(key.toUpperCase(), entry);
                page.push(entry);
            }
            return page;
        };

        for (const status of wanted) {
            const top = 100;
            let skip = 0;
            let count = 0;
            const safeStatus = status.replace(/'/g, "''");
            const filter = start
                ? `Status eq '${safeStatus}' and Date ge datetimeoffset'${start}T00:00:00Z'`
                : `Status eq '${safeStatus}'`;
            try {
                while (true) {
                    const url = `${ACU_BASE}/PurchaseOrder?$top=${top}&$skip=${skip}&$filter=${encodeURIComponent(filter)}`;
                    const res = await this.fetchWithRetry(url, cookie);
                    const data = await res.json();
                    const rows = data.value || (Array.isArray(data) ? data : []);
                    if (!rows.length) break;
                    const page = [];
                    for (const row of rows) {
                        page.push(...remember(getF(row, "OrderNbr"), getF(row, "OrderType"), getF(row, "Status") || status));
                    }
                    count += rows.length;
                    if (onPage && page.length) await onPage(page);
                    if (rows.length < top) break;
                    skip += rows.length;
                    if (skip > 50000) break;
                }
                console.log(`[Acumatica] PO status "${status}": ${count} order(s).`);
            } catch (err) {
                console.warn(`[Acumatica] PO status "${status}" fetch skipped:`, err?.message || err);
            }
        }
        return [...found.values()];
    },

    /** Fetch line items for specific order numbers (used when MySQL lines are missing) */
    async getPurchaseOrderLinesByNbrs(orderNbrs, cookie) {
        const nbrs = [...new Set(orderNbrs.map(n => String(n || "").trim()).filter(Boolean))];
        if (!nbrs.length || !cookie) return new Map();

        const lineMap = new Map();
        const CONCURRENCY = 4;

        const fetchOne = async (nbr) => {
            for (const filter of buildOrderFilters(nbr)) {
                try {
                    const url = `${ACU_BASE}/PurchaseOrder?$expand=Details&$filter=${encodeURIComponent(filter)}&$top=1`;
                    const res = await this.fetchWithRetry(url, cookie);
                    const data = await res.json();
                    const rawOrders = data.value || (Array.isArray(data) ? data : []);
                    if (!rawOrders.length) continue;

                    const mapped = mapPurchaseOrder(rawOrders[0]);
                    const key = String(nbr).trim();
                    if (mapped.lines?.length) {
                        lineMap.set(key, mapped.lines);
                        if (mapped.orderNbr && mapped.orderNbr !== key) {
                            lineMap.set(String(mapped.orderNbr).trim(), mapped.lines);
                        }
                        return;
                    }
                } catch {
                    // try next filter variant
                }
            }
        };

        for (let i = 0; i < nbrs.length; i += CONCURRENCY) {
            const batch = nbrs.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(nbr => fetchOne(nbr).catch(err => {
                console.error(`[PO Line Fetch] ${nbr}:`, err.message);
            })));
        }

        return lineMap;
    },

    /** ── REPLENISHMENT RECOMMENDATIONS ── */
    async getReplenishmentRecommendations({ cookie }) {
        // We derive recommendations from active items with low stock availability
        // Scan 300 items to ensure we find enough low-stock candidates
        const url = `${ACU_BASE}/StockItem?$expand=WarehouseDetails&$top=300&$filter=ItemStatus eq 'Active'`;
        const res = await this.fetchWithRetry(url, cookie);
        const data = await res.json();
        const items = data.value || (Array.isArray(data) ? data : []);

        const recommendations = [];
        let recId = 1000;

        for (const item of items) {
            const inventoryId = getF(item, "InventoryID");
            if (!inventoryId) continue;

            const description = getF(item, "Description");
            let wds = item.WarehouseDetails || [];

            // Handle cases where expansion is wrapped in { value: [...] }
            if (wds && !Array.isArray(wds) && wds.value) wds = wds.value;
            if (!Array.isArray(wds)) wds = [];

            // Sum availability across all warehouses
            // We use QtyAvailable as the primary metric, but fallback to QtyOnHand if missing
            const totalAvailable = wds.reduce((sum, wh) => {
                const val = parseFloat(getAny(wh, "QtyAvailable", "Available", "QtyOnHand", "OnHand", "Qty", "AvailableQty", "QtyAvail") || 0);
                return sum + (isNaN(val) ? 0 : val);
            }, 0);

            // Logic: If available < 50 units total, recommend replenishment
            if (totalAvailable < 50) {
                const suggestedQty = 100 - totalAvailable;
                const priority = totalAvailable < 10 ? "High" : totalAvailable < 30 ? "Medium" : "Low";

                recommendations.push({
                    recommendationId: `REC-${recId++}`,
                    itemId: inventoryId,
                    description: description,
                    currentStock: totalAvailable,
                    suggestedQty: Math.ceil(suggestedQty),
                    priorityLevel: priority,
                    generatedDate: new Date().toISOString(),
                    aiInsights: {
                        formula: `(Optimal Stock: 100) - (Current Stock: ${totalAvailable})`,
                        message: totalAvailable < 10 
                            ? "Critical stock level detected. Immediate replenishment advised to avoid complete stockout." 
                            : "Stock level is below safety threshold. Restocking recommended to maintain operational buffer.",
                        stockoutRisk: totalAvailable < 10 ? "Critical (90%+)" : totalAvailable < 30 ? "High (60%)" : "Moderate (30%)"
                    }
                });
            }
        }

        return recommendations.sort((a, b) => {
            const pMap = { "High": 3, "Medium": 2, "Low": 1 };
            if (pMap[b.priorityLevel] !== pMap[a.priorityLevel]) {
                return pMap[b.priorityLevel] - pMap[a.priorityLevel];
            }
            return a.currentStock - b.currentStock; // Lower stock first within same priority
        });
    },

    /** Live branch stock from Acumatica Inventory Summary (DAMAGE locations excluded). */
    async getBranchStockForItems(itemIds, branch, cookie) {
        const map = new Map();
        const ids = [...new Set(itemIds.map((id) => String(id || "").trim()).filter(Boolean))];
        if (!ids.length || !cookie || cookie === "__bypass__") return map;

        const branchKey = String(branch || "").toUpperCase().trim();
        const CHUNK = 4;

        for (let i = 0; i < ids.length; i += CHUNK) {
            const batch = ids.slice(i, i + CHUNK);
            await Promise.all(
                batch.map(async (id) => {
                    try {
                        const results = await this.getInventorySummaryResults(id, cookie);
                        if (!results.length) {
                            // Fallback: WarehouseDetails when Summary returns nothing
                            const filter = encodeURIComponent(
                                `InventoryID eq '${String(id).replace(/'/g, "''")}'`
                            );
                            const url = `${ACU_BASE}/StockItem?$expand=WarehouseDetails&$top=1&$filter=${filter}`;
                            const res = await this.fetchWithRetry(url, cookie);
                            const data = await res.json();
                            const item = (data.value || [])[0];
                            if (!item) return;
                            const levels = extractWarehouseLevels(item);
                            let stock = 0;
                            for (const level of levels) {
                                if (
                                    !branchKey ||
                                    String(level.branch_id || "").toUpperCase() === branchKey ||
                                    String(level.warehouse_id || "").toUpperCase() === branchKey
                                ) {
                                    stock += Number(level.on_hand) || 0;
                                }
                            }
                            map.set(String(id).trim().toUpperCase(), stock);
                            return;
                        }
                        const { byWh } = aggregateSummaryByWarehouse(results);
                        const row = byWh.get(branchKey);
                        map.set(
                            String(id).trim().toUpperCase(),
                            Number(row?.available ?? row?.on_hand) || 0
                        );
                    } catch (err) {
                        console.error("[Acumatica getBranchStockForItems]", id, err.message);
                    }
                })
            );
        }
        return map;
    },

    /** ── SALES: Discover Periods and Fetch Data ── */
    async fetchSalesBySpecificMonths({ cookie, targetMonths }) {
        if (salesAbortController) salesAbortController.abort();
        salesAbortController = new AbortController();
        const signal = salesAbortController.signal;
        const syncId = ++activeSalesSyncId;

        const results = [];
        const pageSize = 1000;

        try {
            // 1. DISCOVER ACTUAL PERIOD IDs FROM ACUMATICA
            console.log(`>>> [Acumatica] [Req #${syncId}] Discovering actual Period IDs for:`, targetMonths);
            const pRes = await this.fetchWithRetry(`${ACU_BASE}/FinancialPeriod?$top=500`, cookie);
            const pData = await pRes.json();
            const allPeriods = Array.isArray(pData) ? pData : (pData.value || []);

            const getPeriodId = (p) => p.FinancialPeriodID?.value || p.FinancialPeriodID || p.PeriodID?.value || p.PeriodID;

            // Match our target months to actual ERP Period IDs
            const discoveredIds = [];
            for (const target of targetMonths) {
                const match = allPeriods.find(p => {
                    const pStart = new Date(p.StartDate?.value || p.StartDate);
                    return pStart.getMonth() === target.month - 1 && pStart.getFullYear() === target.year;
                });
                if (match) discoveredIds.push(getPeriodId(match));
            }

            console.log(`>>> [Acumatica] [Req #${syncId}] Discovered ERP Period IDs:`, discoveredIds);

            if (discoveredIds.length === 0) {
                console.log(`>>> [Acumatica] [Req #${syncId}] No matching periods found in ERP. Falling back to date-based range.`);

                const startMonth = targetMonths[0];
                const endMonth = targetMonths[targetMonths.length - 1];
                if (!startMonth) return [];

                const startDate = `${startMonth.year}-${String(startMonth.month).padStart(2, '0')}-01T00:00:00Z`;
                const lastDay = new Date(endMonth.year, endMonth.month, 0).getDate();
                const endDate = `${endMonth.year}-${String(endMonth.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59Z`;

                // Try multiple entities to find real sales
                const entities = ["Invoice", "SalesInvoice", "CashSale"];
                const flatResults = [];

                for (const entity of entities) {
                    if (signal.aborted) break;
                    console.log(`>>> [Acumatica] [Req #${syncId}] Trying ${entity} (Limit 2000, OrderBy Amount Desc)...`);

                    const filter = `Date ge datetimeoffset'${startDate}' and Date le datetimeoffset'${endDate}'`;
                    const url = `${ACU_BASE}/${entity}?$expand=Details&$top=2000&$filter=${filter}&$orderby=Amount desc`;

                    try {
                        const res = await this.fetchWithRetry(url, cookie, { signal });
                        const data = await res.json();
                        const items = data.value || (Array.isArray(data) ? data : []);
                        console.log(`>>> [Acumatica] [Req #${syncId}] Found ${items.length} records in ${entity}.`);
                        if (items.length > 0) {
                            flatResults.push(...items);
                        }
                    } catch (e) {
                        console.warn(`>>> [Acumatica] [Req #${syncId}] ${entity} fetch failed:`, e.message);
                    }
                }

                console.log(`>>> [Acumatica] [Req #${syncId}] TOTAL FALLBACK RECORDS: ${flatResults.length}`);
                return flatResults;
            }

            // 2. FETCH DATA USING DISCOVERED IDs
            for (const id of discoveredIds) {
                if (signal.aborted) break;
                let skip = 0;
                while (true) {
                    if (signal.aborted) break;
                    console.log(`>>> [Acumatica] [Req #${syncId}] Fetching Period ${id} (Skip ${skip})...`);
                    // Try Invoice for period-based fetching
                    const url = `${ACU_BASE}/Invoice?$expand=Details&$top=${pageSize}&$skip=${skip}&$filter=PostPeriod eq '${id}'`;

                    const res = await this.fetchWithRetry(url, cookie, { signal });
                    const data = await res.json();
                    const items = data.value || (Array.isArray(data) ? data : []);

                    results.push(...items);
                    if (items.length < pageSize) break;
                    skip += pageSize;
                }
            }

            console.log(`>>> [Acumatica] [Req #${syncId}] FETCH COMPLETE. Total: ${results.length} records.`);
            return results;

        } catch (err) {
            return [];
        } finally {
            if (activeSalesSyncId === syncId) salesAbortController = null;
        }
    }
};
