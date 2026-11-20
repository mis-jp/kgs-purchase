/**
 * Acumatica company registry.
 * Ecommerce is a logical company in this app — stock comes from the ECOMMERCE
 * branch/site under the main Acumatica company (KGSC), not a second ERP login.
 */

export const COMPANIES = [
    {
        id: "main",
        label: process.env.ACUMATICA_COMPANY || process.env.ACU_COMPANY || "Main Company",
        acumaticaCompany: process.env.ACUMATICA_COMPANY || process.env.ACU_COMPANY || "",
        virtual: false,
    },
    {
        id: "ecommerce",
        label: process.env.ACUMATICA_ECOM_LABEL || "Ecommerce",
        /** Same Acumatica tenant as main; stock filtered by ECOMMERCE branch. */
        acumaticaCompany: process.env.ACUMATICA_COMPANY || process.env.ACU_COMPANY || "",
        virtual: true,
        branchIds: ["ECOMMERCE", "ECOM", "E-COMMERCE", "E COMMERCE"],
    },
];

/** Branch/site IDs routed to the ecommerce company bucket (excluded from main-company totals unless branch is selected). */
export const ECOM_BRANCH_ALIASES = new Set([
    "ECOM",
    "ECOMMERCE",
    "E-COMMERCE",
    "E COMMERCE",
    "ECOM BRANCH",
]);

/**
 * Exact warehouse / site IDs excluded from sellable stock and Packing List
 * (Acumatica Inventory Summary: Warehouse Does Not Equal).
 * MAIN stays allowed. Marilao *warehouse* (MARILAO / MNL-MRILAO) is excluded —
 * but MAIN bin locations like "MARILAO 15" are NOT (see location helpers).
 */
export const EXCLUDED_BRANCH_ALIASES = new Set([
    "DAMAGE",
    "DISCOUNTED LOCATION",
    "DISCOUNTED",
    "SPAREPARTS",
    "SPARE PARTS",
    "EXPIRED",
    "DEMO",
    "MAIN WH11",
    "SKYTECH",
    "SKYTECHMNL",
    "MNL CAL WH",
    "MNL-MRILAO",
    "MARILAO",
    "MNL-TECH",
    "SKY ECOM",
    "TESTING",
]);

/**
 * Substrings for warehouse / branch "Does Not Contain" filters.
 * Do NOT put MARILAO here — it falsely matches MAIN location bins like "MARILAO 15".
 * Marilao warehouse sites are covered by exact aliases above (MARILAO, MNL-MRILAO).
 */
export const EXCLUDED_BRANCH_KEYWORDS = [
    "SPAREPARTS",
    "SPARE PART",
    "DAMAGE",
    "DISCOUNTED",
    "EXPIRED",
    "DEMO",
    "TECH",
];

/**
 * Non-sellable *location* (bin) names inside a warehouse.
 * DAMAGE / DISCOUNTED / etc. — not warehouse sites, and not "MARILAO 15".
 */
export const EXCLUDED_LOCATION_KEYWORDS = [
    "SPAREPARTS",
    "SPARE PART",
    "DAMAGE",
    "DISCOUNTED",
    "EXPIRED",
    "DEMO",
];

/** Damage KPI only — do not fold SPAREPARTS / EXPIRED / DEMO / TECH into Damage totals. */
export const DAMAGE_LOCATION_KEYWORDS = ["DAMAGE", "DISCOUNTED"];

export function getCompanyById(companyId) {
    return COMPANIES.find((c) => c.id === companyId) || COMPANIES[0];
}

export function getAcumaticaCompanyName(companyId) {
    return getCompanyById(companyId).acumaticaCompany;
}

export function isValidCompanyId(companyId) {
    return COMPANIES.some((c) => c.id === companyId);
}

export function listCompaniesForClient(activeCompanyId = "main") {
    return {
        activeCompanyId,
        companies: COMPANIES.map((c) => ({
            id: c.id,
            label: c.label,
        })),
    };
}

export function isEcomBranchAlias(branchId) {
    const key = String(branchId || "").trim().toUpperCase();
    return ECOM_BRANCH_ALIASES.has(key);
}

export function isExcludedBranchAlias(branchId) {
    const key = String(branchId || "").trim().toUpperCase();
    if (!key) return false;
    if (EXCLUDED_BRANCH_ALIASES.has(key)) return true;
    return EXCLUDED_BRANCH_KEYWORDS.some((kw) => key.includes(kw));
}

/** Exact location/bin IDs that are never sellable (Acumatica Location Does Not Equal). */
export const EXCLUDED_LOCATION_ALIASES = new Set([
    "DAMAGE",
    "DISCOUNTED LOCATION",
    "DISCOUNTED",
    "SPAREPARTS",
    "SPARE PARTS",
    "EXPIRED",
    "DEMO",
    "MNL CAL WH",
    "TESTING",
]);

/**
 * Non-sellable location/bin IDs inside a warehouse (Inventory Summary Location).
 * "MARILAO 15" under MAIN is sellable shelf stock — only DAMAGE-style bins are out.
 */
export function isExcludedLocationAlias(locationId) {
    const key = String(locationId || "").trim().toUpperCase();
    if (!key) return false;
    if (EXCLUDED_LOCATION_ALIASES.has(key)) return true;
    return EXCLUDED_LOCATION_KEYWORDS.some((kw) => key.includes(kw));
}

/** True only for DAMAGE / DISCOUNTED (Damage KPI), not SPAREPARTS / EXPIRED / DEMO. */
export function isDamageLocationAlias(locationId) {
    const key = String(locationId || "").trim().toUpperCase();
    if (!key) return false;
    return DAMAGE_LOCATION_KEYWORDS.some((kw) => key.includes(kw));
}

/**
 * Retail / sellable branches eligible for replenishment planning.
 * Warehouse, tech, and office locations have stock but no POS sales at that site.
 */
export function isRetailReplenishmentBranch(branchId) {
    const key = String(branchId || "").trim().toUpperCase();
    if (!key || key === "__CATALOG__") return false;
    if (isExcludedBranchAlias(key)) return false;
    if (key === "MAIN") return true;
    if (isEcomBranchAlias(key)) return true;
    if (key.endsWith("-TECH") || key === "MNL-TECH" || key.startsWith("TECH-") || key.startsWith("TECH ")) return false;
    if (key.includes("OFFICE")) return false;
    // Physical warehouses / staging — not retail POS branches
    if (key.includes("WAREHOUSE")) return false;
    if (
        key === "WH1" ||
        key.includes("WH11") ||
        key.endsWith(" WH") ||
        key.includes(" WH ") ||
        /\bWH\d+\b/.test(key)
    ) {
        return false;
    }
    if (["SKYTECHMNL", "SKY ECOM", "MNL-MRILAO", "MNL CAL WH", "MAIN WH11", "TESTING"].includes(key)) return false;
    if (key.startsWith("TESTING")) return false;
    return true;
}

/**
 * Extra warehouses whose on-hand should count toward a retail branch's stock.
 * Acumatica often invoices sales under the POS branch (e.g. MANILA) while stock
 * lives in related metro warehouses (Marilao / Caloocan / WH1).
 */
export const BRANCH_STOCK_WAREHOUSE_GROUPS = {
    MANILA: ["MANILA", "WH1", "MNL CAL WH", "MNL-MRILAO"],
    // MAIN often keeps overflow / related stock in MAIN WH11
    MAIN: ["MAIN", "MAIN WH11"],
};

/** Warehouses to read stock/Coming PO from when planning a retail branch. */
export function getStockWarehouseIdsForBranch(branchId) {
    const key = String(branchId || "").trim().toUpperCase();
    if (!key || isExcludedBranchAlias(key)) return [];
    if (isEcomBranchAlias(key)) {
        return [...ECOM_BRANCH_ALIASES].filter((id) => !isExcludedBranchAlias(id));
    }
    const grouped = BRANCH_STOCK_WAREHOUSE_GROUPS[key];
    if (grouped?.length) {
        return [...new Set(
            grouped
                .map((id) => String(id).trim().toUpperCase())
                .filter((id) => id && !isExcludedBranchAlias(id))
        )];
    }
    return [key];
}

/**
 * For Sells / day only: map a satellite stock warehouse to the POS branch that
 * invoices its demand (e.g. MNL-MRILAO → MANILA). Does not change which branch
 * is selected or which warehouse stock is shown.
 */
export function resolveSalesBranchForWarehouse(branchId) {
    const key = String(branchId || "").trim().toUpperCase();
    if (!key) return "";
    for (const [parent, warehouses] of Object.entries(BRANCH_STOCK_WAREHOUSE_GROUPS)) {
        const parentKey = String(parent).trim().toUpperCase();
        const members = (warehouses || []).map((id) => String(id).trim().toUpperCase()).filter(Boolean);
        if (members.includes(key) && key !== parentKey) {
            return parentKey;
        }
    }
    return key;
}

/** @deprecated Alias — prefer resolveSalesBranchForWarehouse */
export const resolveSalesBranchForStockSite = resolveSalesBranchForWarehouse;

export function filterReplenishmentBranchList(branches) {
    return filterBranchList(branches).filter((b) => {
        const id = b.SiteID ?? b.branch_id ?? b.id ?? "";
        return isRetailReplenishmentBranch(id);
    });
}

/**
 * True when an ID/name looks like a physical warehouse site (not an org Branch).
 * Used to keep Branch pickers clean even if stale warehouse rows remain in MySQL.
 */
export function isWarehouseLikeAlias(value) {
    const key = String(
        typeof value === "object" && value !== null ? (value.value ?? value.label ?? "") : value
    )
        .trim()
        .toUpperCase();
    if (!key) return false;
    if (key.includes("WAREHOUSE")) return true;
    if (key.endsWith(" WH") || key.includes(" WH ") || key.startsWith("WH ")) return true;
    if (/\bWH\d+\b/.test(key) || key.includes("WH11") || key.includes("WH14")) return true;
    if (["WH1", "MAIN WH11", "MNL CAL WH", "MNL-MRILAO", "MAIN2"].includes(key)) return true;
    return false;
}

/** Remove Damage / Discounted locations from Branch dropdown lists. */
export function filterBranchList(branches) {
    return (branches || []).filter((b) => {
        const id = b.SiteID ?? b.branch_id ?? b.id ?? "";
        const name = b.Description ?? b.branch_name ?? b.name ?? "";
        const nameText = typeof name === "object" && name !== null ? name.value ?? "" : name;
        return !isExcludedBranchAlias(id) && !isExcludedBranchAlias(nameText);
    });
}

/** SQL fragment to omit DAMAGE / DISCOUNTED from sellable inventory totals. */
export function sqlExcludeBranches(alias = "i") {
    const branchCol = `UPPER(TRIM(COALESCE(${alias}.branch_id, '')))`;
    const siteCol = `UPPER(TRIM(COALESCE(${alias}.site_id, '')))`;
    const whCol = `UPPER(TRIM(COALESCE(${alias}.default_warehouse, '')))`;
    const parts = EXCLUDED_BRANCH_KEYWORDS.flatMap(() => [
        `${branchCol} NOT LIKE ?`,
        `${siteCol} NOT LIKE ?`,
        `${whCol} NOT LIKE ?`,
    ]);
    return {
        clause: `(${parts.join(" AND ")})`,
        params: EXCLUDED_BRANCH_KEYWORDS.flatMap((kw) => [`%${kw}%`, `%${kw}%`, `%${kw}%`]),
    };
}

/** SQL fragment: only DAMAGE / DISCOUNTED warehouse rows (for Damage KPI). */
export function sqlOnlyDamageBranches(alias = "i") {
    const branchCol = `UPPER(TRIM(COALESCE(${alias}.branch_id, '')))`;
    const siteCol = `UPPER(TRIM(COALESCE(${alias}.site_id, '')))`;
    const whCol = `UPPER(TRIM(COALESCE(${alias}.default_warehouse, '')))`;
    const parts = DAMAGE_LOCATION_KEYWORDS.flatMap(() => [
        `${branchCol} LIKE ?`,
        `${siteCol} LIKE ?`,
        `${whCol} LIKE ?`,
    ]);
    return {
        clause: `(${parts.join(" OR ")})`,
        params: DAMAGE_LOCATION_KEYWORDS.flatMap((kw) => [`%${kw}%`, `%${kw}%`, `%${kw}%`]),
    };
}

/** SQL fragment to omit excluded branches from product_periodic_sales queries. */
export function sqlExcludeSalesBranches(column = "branch_name", tableAlias = "") {
    const colName = tableAlias ? `${tableAlias}.${column}` : column;
    const col = `UPPER(TRIM(${colName}))`;
    const likes = EXCLUDED_BRANCH_KEYWORDS.map(() => `${col} NOT LIKE ?`).join(" AND ");
    return {
        clause: `(${colName} IS NULL OR TRIM(${colName}) = '' OR (${likes}))`,
        params: EXCLUDED_BRANCH_KEYWORDS.map((kw) => `%${kw}%`),
    };
}

/** SQL fragment to omit ecommerce invoice branches from sales totals. */
export function sqlExcludeEcomSalesBranches(column = "branch_name", tableAlias = "") {
    const col = tableAlias ? `${tableAlias}.${column}` : column;
    const branches = [...ECOM_BRANCH_ALIASES];
    return {
        clause: `(${col} IS NULL OR TRIM(${col}) = '' OR UPPER(TRIM(${col})) NOT IN (${branches.map(() => "?").join(", ")}))`,
        params: branches,
    };
}

/** SQL fragment to include only ecommerce invoice branches in sales totals. */
export function sqlOnlyEcomSalesBranches(column = "branch_name", tableAlias = "") {
    const col = tableAlias ? `${tableAlias}.${column}` : column;
    const branches = [...ECOM_BRANCH_ALIASES];
    return {
        clause: `UPPER(TRIM(${col})) IN (${branches.map(() => "?").join(", ")})`,
        params: branches,
    };
}

/** When a user picks an ecommerce branch, read stock from the ecommerce company bucket. */
export function resolveCompanyIdForBranch(companyId, branchId) {
    if (branchId && isEcomBranchAlias(branchId)) return "ecommerce";
    return companyId || "main";
}

/** SQL fragment + params to hide ecommerce misclassified as a branch under main company. */
export function sqlExcludeEcomBranches(alias = "i") {
    const branches = [...ECOM_BRANCH_ALIASES];
    return {
        clause: `(${alias}.branch_id IS NULL OR TRIM(${alias}.branch_id) = '' OR UPPER(TRIM(${alias}.branch_id)) NOT IN (${branches.map(() => "?").join(", ")}))`,
        params: branches,
    };
}

/** SQL fragment to include only ecommerce branch rows. */
export function sqlOnlyEcomBranches(alias = "i") {
    const branches = [...ECOM_BRANCH_ALIASES];
    return {
        clause: `UPPER(TRIM(${alias}.branch_id)) IN (${branches.map(() => "?").join(", ")})`,
        params: branches,
    };
}

/** Split Acumatica warehouse levels into main vs ecommerce company buckets. */
export function splitLevelsByCompany(levels) {
    const main = [];
    const ecommerce = [];
    for (const level of levels) {
        if (isEcomBranchAlias(level.branch_id)) ecommerce.push(level);
        else main.push(level);
    }
    return { main, ecommerce };
}

export function isVirtualCompany(companyId) {
    return getCompanyById(companyId).virtual === true;
}
