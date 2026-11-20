import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { getAcumaticaBaseUrl } from "@/lib/acumatica-env";
import { getAcumaticaCompanyName, getStockWarehouseIdsForBranch } from "@/lib/companies";
import { getCachedSystemCredential } from "@/lib/acumatica-system-auth";
import { obtainSyncCredential } from "@/lib/sync-acumatica-auth";
import {
    isPoLineCompleted,
    openPoPrefixesForDestinations,
    buildForecastPoStatusFilters,
    orderNbrFilters,
} from "@/lib/open-po-match";

const REFRESH_TTL_MS = 2 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 15;
const lastRefreshByKey = new Map();

function getF(obj, keyName) {
    if (!obj) return "";
    const k = Object.keys(obj).find((i) => i.toLowerCase() === keyName.toLowerCase());
    if (!k) return "";
    const val = obj[k];
    if (val === null || val === undefined) return "";
    if (typeof val === "object") return val.value ?? "";
    return val;
}

function getAny(obj, ...keys) {
    for (const k of keys) {
        const v = getF(obj, k);
        if (v !== "" && v !== null && v !== undefined) return v;
    }
    return "";
}

function parseAcumaticaRows(data) {
    return data?.value || (Array.isArray(data) ? data : []);
}

export function forecastPoRefreshKey(branch) {
    return String(branch || "").trim().toUpperCase() || "__ALL__";
}

export { buildForecastPoStatusFilters, orderNbrFilters };

export function mapAcumaticaPoToMysql(order) {
    const orderNbr = String(getF(order, "OrderNbr") || "").trim();
    if (!orderNbr) return { history: null, lines: [] };

    const history = {
        order_nbr: orderNbr,
        vendor_id: getF(order, "VendorID"),
        vendor_name: getF(order, "VendorName"),
        status: getF(order, "Status"),
        order_date: getF(order, "Date"),
        promised_date: getF(order, "PromisedOn"),
        receipt_date: null,
        total_amount: parseFloat(getF(order, "OrderTotal") || 0),
    };

    let details = order.Details || order.Transactions || order.PurchaseOrderDetails || [];
    if (details && !Array.isArray(details) && details.value) details = details.value;
    if (!Array.isArray(details)) details = [];

    const lines = details.map((d) => {
        const warehouseId = String(
            getAny(d, "WarehouseID", "SiteID", "DestinationWarehouseID") ||
            getAny(d, "BranchID", "Branch") ||
            ""
        ).trim();
        return {
            order_nbr: orderNbr,
            line_nbr: parseInt(getF(d, "LineNbr") || 0, 10) || 0,
            inventory_id: String(getF(d, "InventoryID") || "").trim(),
            description: getAny(d, "LineDescription", "Description"),
            qty: parseFloat(getAny(d, "OrderQty", "Qty") || 0),
            received_qty: parseFloat(getAny(
                d,
                "QtyOnReceipts",
                "ReceivedQty",
                "QtyReceived",
                "ReceivedQuantity"
            ) || 0),
            line_completed: isPoLineCompleted(getAny(d, "Completed", "LineCompleted")),
            uom: getF(d, "UOM"),
            warehouse_id: warehouseId || null,
            branch_id: warehouseId || null,
            ext_cost: parseFloat(getAny(d, "ExtendedCost", "LineAmount") || 0),
            last_sync: new Date(),
        };
    }).filter((line) => line.line_nbr > 0 || line.inventory_id);

    return { history, lines };
}

export async function upsertAcumaticaPurchaseOrders(orders = []) {
    const historyRows = [];
    const lineRows = [];
    for (const order of orders) {
        const mapped = mapAcumaticaPoToMysql(order);
        if (mapped.history?.order_nbr) historyRows.push(mapped.history);
        if (mapped.lines?.length) lineRows.push(...mapped.lines);
    }
    if (historyRows.length) await MySqlService.upsertPurchaseHistory(historyRows);
    if (lineRows.length) await MySqlService.upsertPurchaseOrderDetails(lineRows);
    return { headers: historyRows.length, lines: lineRows.length };
}

async function fetchOrdersByFilter(cookie, filter, { maxPages = MAX_PAGES } = {}) {
    const acuBase = `${getAcumaticaBaseUrl()}/entity/Default/20.200.001`;
    const collected = [];
    let skip = 0;
    for (let page = 0; page < maxPages; page++) {
        const url = `${acuBase}/PurchaseOrder?$expand=Details&$top=${PAGE_SIZE}&$skip=${skip}&$filter=${encodeURIComponent(filter)}`;
        const res = await AcumaticaService.fetchWithRetry(url, cookie);
        const orders = parseAcumaticaRows(await res.json());
        if (!orders.length) break;
        collected.push(...orders);
        if (orders.length < PAGE_SIZE) break;
        skip += orders.length;
    }
    return collected;
}

async function fetchOrdersByNbrs(cookie, orderNbrs) {
    const acuBase = `${getAcumaticaBaseUrl()}/entity/Default/20.200.001`;
    const collected = [];
    const seen = new Set();
    for (const nbr of orderNbrs) {
        for (const filter of orderNbrFilters(nbr)) {
            try {
                const url = `${acuBase}/PurchaseOrder?$expand=Details&$filter=${encodeURIComponent(filter)}&$top=1`;
                const res = await AcumaticaService.fetchWithRetry(url, cookie);
                const orders = parseAcumaticaRows(await res.json());
                if (!orders.length) continue;
                const orderNbr = String(getF(orders[0], "OrderNbr") || nbr).trim().toUpperCase();
                if (seen.has(orderNbr)) break;
                seen.add(orderNbr);
                collected.push(orders[0]);
                break;
            } catch {
                // try next filter variant
            }
        }
    }
    return collected;
}

async function resolveCookie(cookie) {
    if (cookie && cookie !== "__bypass__") return cookie;
    const cached = getCachedSystemCredential({ allowStale: true });
    if (cached) return cached;
    return obtainSyncCredential({
        companyName: getAcumaticaCompanyName("main"),
        sessionCookie: cookie && cookie !== "__bypass__" ? cookie : null,
    });
}

async function runRefresh({ branch = "", cookie = null, orderNbrs = null } = {}) {
    const credential = await resolveCookie(cookie);
    if (!credential || credential === "__bypass__") {
        return { ok: false, reason: "no-credential", orders: 0, headers: 0, lines: 0 };
    }

    const nbrs = [...new Set(
        (orderNbrs || []).map((n) => String(n || "").trim()).filter(Boolean)
    )];

    let orders = [];
    if (nbrs.length) {
        orders = await fetchOrdersByNbrs(credential, nbrs);
    } else {
        const destinations = branch ? getStockWarehouseIdsForBranch(branch) : [];
        const prefixes = openPoPrefixesForDestinations(destinations);
        if (branch && !prefixes.length) {
            return { ok: true, reason: "no-prefix", orders: 0, headers: 0, lines: 0 };
        }
        const filters = buildForecastPoStatusFilters({
            prefixes,
            statuses: ["Open", "On Hold"],
        });
        for (const filter of filters) {
            const page = await fetchOrdersByFilter(credential, filter);
            orders.push(...page);
        }
    }

    const upserted = await upsertAcumaticaPurchaseOrders(orders);
    return {
        ok: true,
        orders: orders.length,
        headers: upserted.headers,
        lines: upserted.lines,
    };
}

/**
 * Pull live Open + On Hold POs from Acumatica so MySQL statuses stay current.
 * Forecast Coming PO still counts Open only (On Hold is excluded), same as Replenishment.
 */
export async function refreshForecastComingPos({
    branch = "",
    cookie = null,
    force = false,
    orderNbrs = null,
} = {}) {
    const nbrKey = (orderNbrs || [])
        .map((n) => String(n || "").trim().toUpperCase())
        .filter(Boolean)
        .sort()
        .join(",");
    const key = nbrKey ? `nbrs:${nbrKey}` : forecastPoRefreshKey(branch);
    const prev = lastRefreshByKey.get(key);
    if (prev?.inflight) return prev.inflight;
    if (!force && prev?.at && Date.now() - prev.at < REFRESH_TTL_MS) {
        return { ok: true, skipped: true, reason: "throttled", orders: 0, headers: 0, lines: 0 };
    }

    const run = runRefresh({ branch, cookie, orderNbrs }).catch((err) => {
        console.error("[Forecast Coming PO refresh]", err);
        return { ok: false, reason: "error", error: err.message, orders: 0, headers: 0, lines: 0 };
    });
    lastRefreshByKey.set(key, { at: prev?.at || 0, inflight: run });
    const result = await run;
    lastRefreshByKey.set(key, {
        at: result.ok && !result.skipped ? Date.now() : 0,
        inflight: null,
    });
    return result;
}

export function withTimeout(promise, ms = 20_000) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(
            () => resolve({ ok: false, reason: "timeout", orders: 0, headers: 0, lines: 0 }),
            ms
        )),
    ]);
}
