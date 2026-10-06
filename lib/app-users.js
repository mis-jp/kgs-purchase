import bcrypt from "bcryptjs";
import { getSessionIdFromRequest, getSessionMeta } from "@/lib/session-store";
import { MySqlService } from "@/services/mysql";
import { parseAllowedModules } from "@/lib/module-access";

function coversEveryBranch(branchIds, knownIds) {
    const have = new Set((branchIds || []).map((id) => String(id || "").trim().toUpperCase()).filter(Boolean));
    const known = [...new Set((knownIds || []).map((id) => String(id || "").trim().toUpperCase()).filter(Boolean))];
    if (!have.size || !known.length) return false;
    return known.every((id) => have.has(id));
}

let masterBranchIdsTask = null;
function loadMasterBranchIds() {
    if (!masterBranchIdsTask) {
        masterBranchIdsTask = MySqlService.getMasterBranches()
            .then((rows) => (Array.isArray(rows) ? rows : []).map((b) => b.branch_id || b.SiteID || ""))
            .catch(() => [])
            .then((ids) => {
                if (!ids.length) masterBranchIdsTask = null;
                return ids;
            });
    }
    return masterBranchIdsTask;
}

const BCRYPT_ROUNDS = 10;

export const APP_USER_ROLES = ["admin", "user"];

export function hashPassword(plain) {
    return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
    if (!plain || !hash) return false;
    try {
        return bcrypt.compareSync(String(plain), String(hash));
    } catch {
        return false;
    }
}

export function sanitizeUser(row) {
    if (!row) return null;
    const role = row.role === "admin" ? "admin" : "user";
    const flagged = row.all_branches === 1 || row.all_branches === true || row.allBranches === true;
    const grantAll = role === "admin" || flagged;
    const branchIds = Array.isArray(row.branchIds)
        ? row.branchIds.map((b) => String(b || "").trim()).filter(Boolean)
        : [];
    const allowedModules = role === "admin"
        ? []
        : parseAllowedModules(row.allowedModules ?? row.allowed_modules);
    return {
        id: Number(row.id),
        username: row.username,
        fullName: row.full_name || "",
        email: row.email || "",
        role,
        active: row.active === 1 || row.active === true,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        branchIds: grantAll ? [] : branchIds,
        allBranches: grantAll,
        allowedModules,
    };
}

export async function sanitizeUserWithBranches(row) {
    const user = sanitizeUser(row);
    if (!user) return null;
    if (user.role === "admin" || user.allBranches) {
        user.branchIds = [];
        user.allBranches = true;
        if (user.role === "admin") user.allowedModules = [];
        return user;
    }
    if (!user.branchIds.length && user.id) {
        user.branchIds = await MySqlService.getAppUserBranchIds(user.id);
    }
    user.allBranches = coversEveryBranch(user.branchIds, await loadMasterBranchIds());
    return user;
}

export async function getLocalUserFromRequest(request) {
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) return null;
    const meta = getSessionMeta(sessionId);
    const local = meta?.localUser;
    if (!local?.id) return null;

    // Refresh from DB so deactivated users lose access
    const fresh = await MySqlService.getAppUserById(local.id);
    if (!fresh || !(fresh.active === 1 || fresh.active === true)) return null;
    return sanitizeUserWithBranches(fresh);
}

export async function requireLocalUser(request) {
    const user = await getLocalUserFromRequest(request);
    if (!user) {
        const err = new Error("Unauthorized");
        err.status = 401;
        throw err;
    }
    return user;
}

export async function requireAdmin(request) {
    const user = await requireLocalUser(request);
    if (user.role !== "admin") {
        const err = new Error("Forbidden — admin only");
        err.status = 403;
        throw err;
    }
    return user;
}

export function validateUsername(username) {
    const u = String(username || "").trim();
    if (u.length < 3 || u.length > 64) return "Username must be 3–64 characters.";
    if (!/^[a-zA-Z0-9._-]+$/.test(u)) return "Username may only contain letters, numbers, . _ -";
    return null;
}

export function validatePassword(password, { allowEmpty = false } = {}) {
    if (allowEmpty && (password === undefined || password === null || password === "")) return null;
    const p = String(password || "");
    if (p.length < 8) return "Password must be at least 8 characters.";
    if (p.length > 128) return "Password is too long.";
    return null;
}
