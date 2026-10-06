import { getLocalUserFromRequest } from "@/lib/app-users";
import { MySqlService } from "@/services/mysql";

export function normalizeBranchId(id) {
    return String(id || "").trim().toUpperCase();
}

export function normalizeBranchIds(ids) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(ids) ? ids : []) {
        const id = normalizeBranchId(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Resolve branch access for the signed-in local user.
 * Admins (and requests with no local user) can see all branches.
 */
export async function getRequestBranchAccess(request) {
    try {
        const user = await getLocalUserFromRequest(request);
        if (!user) return { allBranches: true, branchIds: [], user: null };
        if (user.role === "admin" || user.allBranches) return { allBranches: true, branchIds: [], user };
        const stored = Array.isArray(user.branchIds) && user.branchIds.length
            ? user.branchIds
            : await MySqlService.getAppUserBranchIds(user.id);
        return {
            allBranches: false,
            branchIds: normalizeBranchIds(stored),
            user,
        };
    } catch {
        return { allBranches: true, branchIds: [], user: null };
    }
}

export function hasNoBranchAccess(access) {
    return !access?.allBranches && !(access?.branchIds || []).length;
}

/** Coerce a requested branch to one the user is allowed to see. */
export function constrainBranchParam(access, requested) {
    const req = String(requested || "").trim();
    if (access?.allBranches) return req;
    const allowed = access?.branchIds || [];
    if (!allowed.length) return "";
    if (!req) return allowed[0];
    const match = allowed.find((b) => b === req || b === req.toUpperCase());
    return match || allowed[0];
}

export function filterBranchesForAccess(branches, access) {
    if (!Array.isArray(branches)) return [];
    if (access?.allBranches) return branches;
    const allowed = new Set((access?.branchIds || []).map((b) => String(b).toUpperCase()));
    return branches.filter((b) => {
        const id = String(b?.SiteID || b?.branch_id || b?.id || "").toUpperCase();
        return allowed.has(id);
    });
}

export function emptyRestrictedPayload(extra = {}) {
    return {
        data: [],
        items: [],
        orders: [],
        recommendations: [],
        totalCount: 0,
        hasMore: false,
        restricted: true,
        message: "This account has no branch access. Ask an admin to assign branches.",
        ...extra,
    };
}
