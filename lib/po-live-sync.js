import { createHash } from "crypto";
import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { getAcumaticaBaseUrl } from "@/lib/acumatica-env";
import { isPoLineCompleted, normalizeErpPoStatus } from "@/lib/open-po-match";

const PAGE_SIZE = 50;

let inflight = null;

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

function parseRows(data) {
    return data?.value || (Array.isArray(data) ? data : []);
}

function formatOData(date) {
    return new Date(date).toISOString().replace(/\.\d{3}/, "");
}

function parseStamp(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
    return d;
}

function pageSignature(orders) {
    const raw = orders.map((order) => storedOrderNbr(order)).join("|");
    return createHash("sha1").update(raw).digest("hex");
}

function holdIsOn(order) {
    const hold = getAny(order, "Hold", "IsHold", "OnHold");
    if (hold === true || hold === 1) return true;
    return /^(true|1|yes)$/i.test(String(hold || "").trim());
}

function headerStatus(order) {
    if (holdIsOn(order)) return "On Hold";
    return normalizeErpPoStatus(getF(order, "Status"));
}

function storedOrderNbr(order) {
    const type = String(getF(order, "OrderType") || "").trim();
    const nbr = String(getF(order, "OrderNbr") || "").trim();
    if (!nbr) return "";
    if (type && !nbr.toUpperCase().startsWith(type.toUpperCase())) return `${type}${nbr}`;
    return nbr;
}

function mapOrder(order) {
    const orderNbr = storedOrderNbr(order);
    if (!orderNbr) return null;
    const modified = parseStamp(getAny(order, "LastModifiedDateTime", "LastModifiedOn"));
    let details = order.Details || order.Transactions || [];
    if (details && !Array.isArray(details) && details.value) details = details.value;
    if (!Array.isArray(details)) details = [];

    let lineExtSum = 0;
    const lines = [];
    for (const d of details) {
        const qty = parseFloat(getAny(d, "OrderQty", "Qty", "Quantity") || 0);
        const unitCost = parseFloat(getAny(d, "UnitCost", "CuryUnitCost") || 0);
        let extCost = parseFloat(getAny(d, "ExtendedCost", "LineAmount", "Amount", "CuryExtCost", "CuryLineAmt") || 0) || 0;
        if (!extCost && qty && unitCost) extCost = qty * unitCost;
        lineExtSum += extCost;
        const warehouseId = String(
            getAny(d, "WarehouseID", "SiteID", "DestinationWarehouseID") ||
            getAny(d, "BranchID", "Branch") ||
            ""
        ).trim();
        lines.push({
            order_nbr: orderNbr,
            line_nbr: parseInt(getF(d, "LineNbr") || 0, 10) || 0,
            inventory_id: getF(d, "InventoryID"),
            description: getAny(d, "LineDescription", "Description"),
            qty,
            received_qty: parseFloat(getAny(d, "QtyOnReceipts", "ReceivedQty", "QtyReceived", "ReceivedQuantity") || 0),
            line_completed: isPoLineCompleted(getAny(d, "Completed", "LineCompleted")),
            uom: getF(d, "UOM"),
            warehouse_id: warehouseId || null,
            branch_id: warehouseId || null,
            ext_cost: extCost,
            last_sync: modified || new Date(),
        });
    }

    const orderTotal = parseFloat(getAny(order, "OrderTotal", "CuryOrderTotal", "LineTotal", "CuryLineTotal") || 0) || 0;
    const controlTotal = parseFloat(getAny(order, "ControlTotal", "CuryControlTotal") || 0) || 0;
    const status = headerStatus(order);
    const receipt = (status === "Closed" || status === "Completed")
        ? getAny(order, "LastReceiptDate", "ReceiptDate") || null
        : null;

    return {
        modified,
        history: {
            order_nbr: orderNbr,
            vendor_id: getF(order, "VendorID"),
            vendor_name: getAny(order, "VendorName", "VendorID_description", "VendorDescription"),
            status,
            order_date: getF(order, "Date"),
            promised_date: getF(order, "PromisedOn"),
            receipt_date: receipt,
            total_amount: orderTotal || controlTotal || lineExtSum,
            last_sync: modified || new Date(),
        },
        lines,
    };
}

async function fetchPage(cookie, filter, { orderBy = "LastModifiedDateTime asc", skip = 0 } = {}) {
    const base = `${getAcumaticaBaseUrl()}/entity/Default/20.200.001`;
    const clause = orderBy === true ? "LastModifiedDateTime asc" : orderBy;
    let url = `${base}/PurchaseOrder?$expand=Details&$top=${PAGE_SIZE}&$filter=${encodeURIComponent(filter)}`;
    if (clause) url += `&$orderby=${encodeURIComponent(clause)}`;
    if (skip > 0) url += `&$skip=${skip}`;
    const res = await AcumaticaService.fetchWithRetry(url, cookie);
    return parseRows(await res.json());
}

/**
 * Acumatica ignores $orderby on this tenant and returns older order numbers first.
 * Page the last few days until the short page so the highest numbers are included.
 */
async function pullNewestOrders(cookie, onProgress) {
    const since = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
    const day = formatOData(since).slice(0, 10);
    const filter = `Date ge datetimeoffset'${day}T00:00:00Z'`;
    const seen = new Set();
    let savedCount = 0;
    let skip = 0;
    let lastNbr = "";

    for (let page = 0; page < 12; page++) {
        let orders = [];
        try {
            orders = await fetchPage(cookie, filter, { orderBy: "", skip });
        } catch (err) {
            console.warn("[PO live] newest window failed:", err?.message || err);
            break;
        }
        if (!orders.length) break;
        const signature = pageSignature(orders);
        if (seen.has(signature)) break;
        seen.add(signature);
        const saved = await saveOrders(orders);
        savedCount += saved.count;
        lastNbr = storedOrderNbr(orders[orders.length - 1]) || lastNbr;
        if (onProgress) {
            onProgress({
                count: savedCount,
                details: `Saved ${savedCount} recent purchase order(s)${lastNbr ? ` through ${lastNbr}` : ""}…`,
                progress: Math.min(95, 20 + page * 6),
            });
        }
        if (orders.length < PAGE_SIZE) break;
        skip += orders.length;
    }

    if (savedCount) {
        console.log(`[PO live] Saved ${savedCount} recent purchase order(s) through ${lastNbr}.`);
    }
    return { count: savedCount, newest: null };
}

/**
 * Page one equality/substring filter until it ends.
 * Order-number OR filters and OrderNbr eq 'TYPE+NBR' fail on this tenant.
 */
async function pullFilter(cookie, filter, label) {
    const seen = new Set();
    let savedCount = 0;
    let skip = 0;
    let failed = false;

    for (let page = 0; page < 8; page++) {
        let orders = [];
        try {
            orders = await fetchPage(cookie, filter, { orderBy: "", skip });
        } catch (err) {
            console.warn(`[PO live] ${label} failed:`, err?.message || err);
            failed = true;
            break;
        }
        if (!orders.length) break;
        const signature = pageSignature(orders);
        if (seen.has(signature)) break;
        seen.add(signature);
        const saved = await saveOrders(orders);
        savedCount += saved.count;
        if (orders.length < PAGE_SIZE) break;
        skip += orders.length;
    }

    return { count: savedCount, failed };
}

/** September MPO numbers that the 7-day window never copied. */
async function pullMissingMpoSeries(cookie) {
    const done = await MySqlService.getAppSetting("po_gap_mpo2605");
    if (done === "done") return { count: 0 };

    const filters = [
        ["substringof('MPO2605', OrderNbr)", "MPO2605 number"],
        ["OrderType eq 'MPO' and substringof('2605', OrderNbr)", "MPO type 2605"],
    ];
    let savedCount = 0;
    let anyOk = false;

    for (const [filter, label] of filters) {
        const result = await pullFilter(cookie, filter, label);
        if (!result.failed) anyOk = true;
        savedCount += result.count;
        if (result.count > 0) break;
    }

    if (savedCount === 0) {
        const numbers = ["MPO260552", "MPO260554", "MPO260555", "MPO260557", "MPO260564", "MPO260583", "MPO260591"];
        for (const nbr of numbers) {
            const result = await pullFilter(cookie, `substringof('${nbr}', OrderNbr)`, nbr);
            if (!result.failed) anyOk = true;
            savedCount += result.count;
        }
    }

    if (anyOk) await MySqlService.setAppSetting("po_gap_mpo2605", "done");
    if (savedCount) console.log(`[PO live] Saved ${savedCount} purchase order(s) from the missing MPO2605 series.`);
    return { count: savedCount };
}

async function saveOrders(orders) {
    const historyRows = [];
    const lineRows = [];
    let newest = null;
    for (const order of orders) {
        const mapped = mapOrder(order);
        if (!mapped) continue;
        historyRows.push(mapped.history);
        lineRows.push(...mapped.lines);
        if (mapped.modified && (!newest || mapped.modified > newest)) newest = mapped.modified;
    }
    if (historyRows.length) await MySqlService.upsertPurchaseHistory(historyRows);
    if (lineRows.length) await MySqlService.upsertPurchaseOrderDetails(lineRows);
    return { count: historyRows.length, newest };
}

/**
 * Copy purchase orders Acumatica has changed since the last successful cursor.
 * One call is intentionally short so the Purchase Orders screen can keep polling.
 */
export async function syncChangedPurchaseOrders({ cookie, onProgress } = {}) {
    if (!cookie || cookie === "__bypass__") {
        return { synced: 0, more: false, reason: "no-credential" };
    }
    if (inflight) return inflight;

    inflight = (async () => {
        const series = await pullMissingMpoSeries(cookie);
        const latest = await pullNewestOrders(cookie, onProgress);
        const synced = (series.count || 0) + (latest.count || 0);
        if (synced > 0) {
            console.log(`[PO live] Saved ${synced} purchase order(s) from Acumatica.`);
        }
        return { synced, more: false };
    })().finally(() => {
        inflight = null;
    });

    return inflight;
}
