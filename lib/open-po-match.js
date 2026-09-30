import { isEcomBranchAlias } from "./companies.js";

/**
 * Acumatica PO numbers are prefixed by branch (NAGP…, MNLP…, MPO…).
 * Used only when warehouse_id and branch_id on the line are blank.
 */
export const PO_NBR_PREFIX_BY_BRANCH = {
    MAIN: ["MPO"],
    MANILA: ["MNLP"],
    GENSAN: ["GENP"],
    DAVAO: ["DVOP"],
    CEBU: ["CEBP"],
    BACOLOD: ["BCDP"],
    ILOILO: ["ILOP"],
    NAGA: ["NAGP"],
    ZAMBOANGA: ["ZAMP"],
    CDO: ["CDOP"],
    LAUNION: ["LAUP"],
    TACLOBAN: ["TACP"],
    ECOMMERCE: ["ECMP"],
    PAGADIAN: ["PAGP"],
    ISABELA: ["ISAP", "ISBP"],
    TARLAC: ["TRLP"],
    BOHOL: ["BOHP"],
};

export function openPoPrefixesForDestinations(destinations) {
    const destSet = new Set(
        (destinations || []).map((d) => String(d || "").trim().toUpperCase()).filter(Boolean)
    );
    const prefixes = [];
    for (const [branch, pfxs] of Object.entries(PO_NBR_PREFIX_BY_BRANCH)) {
        if (destSet.has(branch)) prefixes.push(...pfxs);
    }
    if ([...destSet].some(isEcomBranchAlias) && !prefixes.includes("ECMP")) {
        prefixes.push("ECMP");
    }
    return [...new Set(prefixes)];
}

/**
 * SQL fragment: blank warehouse+branch lines whose order number matches this branch.
 */
export function openPoPrefixMatch(headerAlias, detailsAlias, destinations) {
    const prefixes = openPoPrefixesForDestinations(destinations);
    if (!prefixes.length) return { clause: "1=0", params: [] };
    const likes = prefixes.map(() => `UPPER(${headerAlias}.order_nbr) LIKE ?`);
    return {
        clause: `(
            TRIM(COALESCE(${detailsAlias}.warehouse_id,'')) = ''
            AND TRIM(COALESCE(${detailsAlias}.branch_id,'')) = ''
            AND (${likes.join(" OR ")})
        )`,
        params: prefixes.map((p) => `${p}%`),
    };
}

/** Acumatica "Completed" is finished work — this app shows that as Closed. */
export function normalizeErpPoStatus(status) {
    const s = String(status || "").trim();
    const key = s.toLowerCase();
    if (!key) return "";
    if (key === "hold") return "On Hold";
    if (key === "canceled" || key === "cancelled") return "Cancelled";
    if (key === "completed" || key === "complete" || key === "closed") return "Closed";
    return s;
}

export function isPoLineCompleted(value) {
    if (value === true || value === 1) return true;
    const s = String(value ?? "").trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
}

/**
 * Acumatica Open Qty ≈ Order Qty − QtyOnReceipts.
 * Do not use the line Completed flag — Acumatica still shows Order/Open Qty
 * when Completed is true and QtyOnReceipts is 0.
 */
export function poLineOpenQty({ orderQty = 0, receivedQty = 0 } = {}) {
    return Math.max(0, (Number(orderQty) || 0) - (Number(receivedQty) || 0));
}

export function sqlPoLineOpenQty(alias = "d") {
    return `GREATEST(${alias}.qty - COALESCE(${alias}.received_qty, 0), 0)`;
}

/** Acumatica PO301000 Order Qty — used by Forecast Coming PO. */
export function sqlPoLineOrderQty(alias = "d") {
    return `COALESCE(${alias}.qty, 0)`;
}

/**
 * Acumatica Default endpoint does not reliably support OR.
 * Fetch each status separately, optionally AND a PO-number prefix.
 */
export function buildForecastPoStatusFilters({
    prefixes = [],
    statuses = ["Open", "On Hold"],
} = {}) {
    const cleanStatuses = [...new Set(
        (statuses || []).map((s) => String(s || "").trim()).filter(Boolean)
    )];
    const cleanPrefixes = [...new Set(
        (prefixes || []).map((p) => String(p || "").trim().toUpperCase()).filter(Boolean)
    )];
    const filters = [];
    for (const status of cleanStatuses) {
        const statusFilter = `Status eq '${status.replace(/'/g, "''")}'`;
        if (!cleanPrefixes.length) {
            filters.push(statusFilter);
            continue;
        }
        for (const prefix of cleanPrefixes) {
            filters.push(`${statusFilter} and substringof('${prefix.replace(/'/g, "''")}', OrderNbr)`);
        }
    }
    return filters;
}

export function orderNbrFilters(orderNbr) {
    const full = String(orderNbr || "").trim().replace(/'/g, "''");
    if (!full) return [];
    const filters = [`OrderNbr eq '${full}'`];
    const m = full.match(/^([A-Z]+)(\d+)$/i);
    if (m) filters.push(`OrderType eq '${m[1].toUpperCase()}' and OrderNbr eq '${m[2]}'`);
    return filters;
}

export function openPoHeaderStatuses({ includeOnHold = false } = {}) {
    const statuses = [
        "Open", "OPEN", "open",
        "Balanced", "BALANCED", "balanced",
        "Pending Approval", "PENDING APPROVAL",
        "Pending Printing", "PENDING PRINTING",
        "Pending Email", "PENDING EMAIL",
    ];
    if (includeOnHold) {
        statuses.push("On Hold", "ON HOLD", "Hold", "HOLD");
    }
    return statuses;
}

/**
 * Line-level Coming PO attribution (not whole-order dest).
 * Explicit warehouse/branch on the line wins; dest table + PO prefix only apply when both are blank.
 */
export function sqlMatchOpenPoForBranch({
    detailsAlias = "d",
    headerAlias = "h",
    destTable = "purchase_order_dest",
    destinations = [],
} = {}) {
    const dests = [...new Set(
        (destinations || []).map((d) => String(d || "").trim().toUpperCase()).filter(Boolean)
    )];
    if (!dests.length) return { clause: "1=0", params: [] };
    const destPh = dests.map(() => "?").join(", ");
    const prefixMatch = openPoPrefixMatch(headerAlias, detailsAlias, dests);
    return {
        clause: `(
            UPPER(TRIM(COALESCE(${detailsAlias}.warehouse_id, ''))) IN (${destPh})
            OR UPPER(TRIM(COALESCE(${detailsAlias}.branch_id, ''))) IN (${destPh})
            OR ${prefixMatch.clause}
            OR (
                TRIM(COALESCE(${detailsAlias}.warehouse_id, '')) = ''
                AND TRIM(COALESCE(${detailsAlias}.branch_id, '')) = ''
                AND EXISTS (
                    SELECT 1 FROM ${destTable} pd
                    WHERE pd.order_nbr COLLATE utf8mb4_unicode_ci = ${detailsAlias}.order_nbr COLLATE utf8mb4_unicode_ci
                      AND UPPER(TRIM(pd.branch_id)) IN (${destPh})
                )
            )
        )`,
        params: [...dests, ...dests, ...prefixMatch.params, ...dests],
    };
}
