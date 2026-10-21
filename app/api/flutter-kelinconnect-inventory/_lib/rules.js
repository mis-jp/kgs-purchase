import { HttpError } from "./errors.js";

/** Pure business rules for the KelinConnect Inventory ledger (no database access). */

export const ROLES = ["admin", "manager", "staff", "viewer"];

export function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

export function iso(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function person(loginId, name) {
    return loginId ? { loginId, name: name || loginId } : null;
}

/** YYYYMMDD in Asia/Manila (+08:00), used for document numbers. */
export function manilaDay(date = new Date()) {
    const shifted = new Date(date.getTime() + 8 * 60 * 60_000);
    return shifted.toISOString().slice(0, 10).replace(/-/g, "");
}

export function formatDocNumber(prefix, day, value) {
    return `${prefix}-${day}-${String(value).padStart(4, "0")}`;
}

/** Parse "KG0751, kg0543" into a Set of upper-case login ids. */
export function adminLoginIds(raw = process.env.KC_INVENTORY_ADMIN_LOGIN_IDS) {
    return new Set(String(raw || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

function assigned(member, branchId) {
    return member.allBranches || member.branchIds.has(Number(branchId));
}

/** Receive, release, start counts, create transfers from, dispatch/receive at the branch. */
export function canOperate(member, branchId) {
    if (member.role === "admin") return true;
    if (member.role !== "manager" && member.role !== "staff") return false;
    return assigned(member, branchId);
}

/** Approve adjustments / pending movements / transfers for the branch. */
export function canApprove(member, branchId) {
    if (member.role === "admin") return true;
    return member.role === "manager" && assigned(member, branchId);
}

export function isAdmin(member) {
    return member.role === "admin";
}

export function isManagerOrAdmin(member) {
    return member.role === "admin" || member.role === "manager";
}

/** Nobody approves their own request. */
export function assertNotOwnRequest(member, requestedBy) {
    if (String(requestedBy || "").toUpperCase() === String(member.loginId || "").toUpperCase()) {
        throw new HttpError(403, "You cannot approve your own request. Ask another manager.");
    }
}

export function permissionFlags(member) {
    const operator = member.role === "admin" || member.role === "manager" || member.role === "staff";
    return {
        canOperate: operator,
        canApprove: isManagerOrAdmin(member),
        canAdmin: isAdmin(member),
        canExport: isManagerOrAdmin(member),
        canViewAudit: operator,
    };
}

/** Result of a counted line. `final` is the recount when present. */
export function countLineState({ systemQty, countedQty, recountQty, missing }) {
    if (missing) return "missing";
    const final = recountQty ?? countedQty;
    if (final === null || final === undefined) return "pending";
    if (num(final) === num(systemQty)) return "matched";
    return num(final) < num(systemQty) ? "short" : "over";
}

export function countLineDifference({ systemQty, countedQty, recountQty, missing }) {
    if (missing) return -num(systemQty);
    const final = recountQty ?? countedQty;
    if (final === null || final === undefined) return null;
    return num(final) - num(systemQty);
}

/** Allowed transfer actions per status. */
export const TRANSFER_FLOW = {
    pending_approval: ["approve", "reject", "cancel"],
    approved: ["dispatch", "cancel"],
    in_transit: ["receive"],
    draft: ["cancel"],
    received: [],
    partially_received: [],
    rejected: [],
    cancelled: [],
};

export function assertTransferAction(status, action) {
    const allowed = TRANSFER_FLOW[status] || [];
    if (!allowed.includes(action)) {
        throw new HttpError(409, `This transfer is ${String(status).replace(/_/g, " ")}; it cannot be ${pastTense(action)} now.`);
    }
}

function pastTense(action) {
    return { approve: "approved", reject: "rejected", cancel: "cancelled", dispatch: "dispatched", receive: "received" }[action] || action;
}

export function stockStatusFor(onHand, minStock) {
    const qty = num(onHand);
    if (qty <= 0) return "out_of_stock";
    if (qty < num(minStock)) return "low_stock";
    return "healthy";
}

/** Validate and normalize movement lines: [{ inventoryId|productId, qty, note }]. */
export function normalizeLines(raw, { allowZero = false, max = 200 } = {}) {
    if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, "Add at least one item.");
    if (raw.length > max) throw new HttpError(400, `Use at most ${max} items per document.`);
    const seen = new Set();
    return raw.map((line, index) => {
        const ref = String(line?.inventoryId ?? line?.sku ?? line?.productId ?? "").trim();
        if (!ref) throw new HttpError(400, `Line ${index + 1} has no item.`);
        const key = ref.toUpperCase();
        if (seen.has(key)) throw new HttpError(400, `${ref} is listed twice. Combine it into one line.`);
        seen.add(key);
        const qty = Number(line?.qty ?? line?.quantity);
        if (!Number.isFinite(qty) || qty < 0 || (!allowZero && qty === 0)) {
            throw new HttpError(400, `Quantity for ${ref} must be more than zero.`);
        }
        return {
            ref,
            qty: Math.round(qty * 10000) / 10000,
            note: String(line?.note || "").trim().slice(0, 500) || null,
        };
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireRequestId(value) {
    const id = String(value || "").trim();
    if (!UUID_RE.test(id)) throw new HttpError(400, "Missing requestId (UUID). Update the app and try again.");
    return id.toLowerCase();
}

/** CSV cell escaping (Excel-safe: neutralize formulas). */
export function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(",")];
    for (const row of rows) lines.push(row.map(csvCell).join(","));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}
