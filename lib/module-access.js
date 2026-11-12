/**
 * Per-account module access.
 * Empty allowedModules = all modules (default). Admins always have all modules.
 */

export const FORECAST_MODULE = "forecast-generator";

/** Modules a User account can be limited to, with the pages and APIs each one needs. */
export const APP_MODULES = [
    {
        id: "inventory",
        label: "Inventory",
        home: "/dashboard",
        paths: ["/dashboard", "/inventory", "/api/inventory", "/api/export", "/api/stock-items", "/api/annotations"],
    },
    {
        id: "stock-items",
        label: "Stock Items",
        home: "/stock-items",
        paths: ["/stock-items", "/api/stock-items", "/api/export"],
    },
    {
        id: "purchase-orders",
        label: "Purchase Orders",
        home: "/purchase-orders",
        paths: ["/purchase-orders", "/api/po", "/api/stock-items/dimensions", "/api/annotations"],
    },
    {
        id: "incoming-po",
        label: "Incoming PO",
        home: "/incoming-po",
        paths: ["/incoming-po", "/api/po"],
    },
    {
        id: "suppliers",
        label: "Suppliers",
        home: "/suppliers",
        paths: ["/suppliers", "/api/vendors", "/api/po", "/api/annotations"],
    },
    {
        id: "replenishment",
        label: "Replenishment",
        home: "/replenishment",
        paths: ["/replenishment", "/api/replenishment", "/api/admin/replenishment-window", "/api/annotations"],
    },
    {
        id: "packing-list",
        label: "Packing List Generator",
        home: "/packing-list",
        paths: ["/packing-list", "/api/po/packing-list"],
    },
    {
        id: FORECAST_MODULE,
        label: "Forecast Generator",
        home: "/forecast-generator",
        paths: ["/forecast-generator", "/api/forecast-generator"],
    },
    {
        id: "sales",
        label: "Last 3 Months Sales",
        home: "/sales",
        paths: ["/sales", "/api/sales-periodic", "/api/sales-history"],
    },
    {
        id: "syncing",
        label: "Syncing Center",
        home: "/syncing",
        paths: ["/syncing", "/api/sync"],
    },
];

const MODULE_BY_ID = new Map(APP_MODULES.map((m) => [m.id, m]));

export const MODULE_ACCESS_OPTIONS = [
    { id: "all", label: "All modules" },
    ...APP_MODULES.map((m) => ({ id: m.id, label: m.label })),
];

const ALWAYS_ALLOWED_PREFIXES = [
    "/account",
    "/api/auth",
    "/api/branches",
    "/api/company",
];

function cleanList(list) {
    return [...new Set(list.map((m) => String(m || "").trim()).filter(Boolean))];
}

export function parseAllowedModules(raw) {
    if (raw == null || raw === "") return [];
    if (Array.isArray(raw)) return cleanList(raw);
    const text = String(raw).trim();
    if (!text || text === "all" || text === "[]") return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return cleanList(parsed);
    } catch {
        /* plain string */
    }
    if (MODULE_BY_ID.has(text)) return [text];
    return [];
}

export function serializeAllowedModules(modules) {
    const list = parseAllowedModules(modules);
    if (!list.length || list.includes("all")) return null;
    return JSON.stringify(list);
}

/** Admin form input (an "all" string, one module id, or a list) → known module ids; [] = all modules. */
export function normalizeModuleAccessInput(value) {
    const list = Array.isArray(value) ? cleanList(value) : parseAllowedModules(String(value ?? "all").trim());
    if (!list.length || list.includes("all")) return [];
    const known = list.filter((id) => MODULE_BY_ID.has(id));
    if (!known.length) {
        const err = new Error("Choose at least one module, or All modules.");
        err.status = 400;
        throw err;
    }
    if (known.length === MODULE_BY_ID.size) return [];
    return known;
}

export function userHasAllModules(user) {
    if (!user || user.role === "admin") return true;
    return parseAllowedModules(user.allowedModules).length === 0;
}

export function userCanAccessModule(user, moduleId) {
    if (!moduleId) return true;
    if (userHasAllModules(user)) return true;
    return parseAllowedModules(user.allowedModules).includes(moduleId);
}

export function homePathForUser(user) {
    if (userHasAllModules(user)) return "/dashboard";
    const mods = parseAllowedModules(user?.allowedModules);
    const first = APP_MODULES.find((m) => mods.includes(m.id));
    return first ? first.home : "/account";
}

function matchesPrefix(pathname, prefix) {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function pathAllowedForUser(user, pathname) {
    const path = String(pathname || "").split("?")[0] || "/";
    if (userHasAllModules(user)) return true;
    if (ALWAYS_ALLOWED_PREFIXES.some((p) => matchesPrefix(path, p))) return true;
    const mods = parseAllowedModules(user?.allowedModules);
    return mods.some((id) => (MODULE_BY_ID.get(id)?.paths || []).some((p) => matchesPrefix(path, p)));
}

export function moduleAccessLabel(modules) {
    const list = parseAllowedModules(modules);
    if (!list.length) return "All modules";
    return list.map((id) => MODULE_BY_ID.get(id)?.label || id).join(", ");
}

export function navItemAllowed(user, moduleId) {
    if (!moduleId) return userHasAllModules(user);
    return userCanAccessModule(user, moduleId);
}
