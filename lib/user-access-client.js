/** Client helper: local admin accounts are not branch-restricted. */
export function isLocalAdminUser() {
    if (typeof window === "undefined") return true;
    try {
        return localStorage.getItem("userRole") === "admin";
    } catch {
        return true;
    }
}

export function storeAllBranchesAccess(allBranches) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem("userAllBranches", allBranches ? "1" : "0");
    } catch {
        /* ignore */
    }
}

/** Admins, and user accounts granted every branch, may pick All branches. */
export function canChooseAllBranches() {
    if (typeof window === "undefined") return true;
    if (isLocalAdminUser()) return true;
    try {
        return localStorage.getItem("userAllBranches") === "1";
    } catch {
        return false;
    }
}

export async function loadAllBranchesAccess(fetcher) {
    try {
        const res = await fetcher("/api/auth/session");
        if (!res?.ok) return canChooseAllBranches();
        const data = await res.json();
        const allow = data?.user?.role === "admin" || data?.user?.allBranches === true;
        storeAllBranchesAccess(allow);
        return allow;
    } catch {
        return canChooseAllBranches();
    }
}

export function readAllowedModules() {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(localStorage.getItem("userModules") || "[]");
        return Array.isArray(parsed) ? parsed.map((m) => String(m || "").trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export function storeAllowedModules(modules) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem("userModules", JSON.stringify(Array.isArray(modules) ? modules : []));
    } catch {
        /* ignore */
    }
}

export function clientCanAccessModule(moduleId) {
    if (!moduleId || moduleId === "account") return true;
    if (isLocalAdminUser()) return true;
    const allowed = readAllowedModules();
    if (!allowed.length) return true;
    return allowed.includes(moduleId);
}
