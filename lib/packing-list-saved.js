import { parseManualQty } from "./packing-list.js";

/** Validation and shaping for packing lists saved to the database (shared across users). */

export const MAX_SAVED_ORDERS = 200;
export const MAX_NAME_LENGTH = 150;
const ORDER_NBR_RE = /^[A-Za-z0-9._\-/ ]{1,50}$/;

function cleanText(value, max) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Returns { value } with a clean record, or { error } with a message for the user.
 * Manual quantities are kept only for the chosen branch and selected POs.
 */
export function normalizeSavedPackingList(input) {
    const name = cleanText(input?.name, MAX_NAME_LENGTH);
    if (!name) return { error: "Give the packing list a name." };

    const branch = cleanText(input?.branch, 100).toUpperCase();
    if (!branch) return { error: "Pick a branch before saving." };

    const orderNbrs = [...new Set(
        (Array.isArray(input?.orderNbrs) ? input.orderNbrs : [])
            .map((n) => cleanText(n, 50))
            .filter((n) => ORDER_NBR_RE.test(n))
    )];
    if (!orderNbrs.length) return { error: "Tick at least one purchase order before saving." };
    if (orderNbrs.length > MAX_SAVED_ORDERS) {
        return { error: `A packing list can hold up to ${MAX_SAVED_ORDERS} purchase orders.` };
    }

    const orderSet = new Set(orderNbrs);
    const manualQty = {};
    const rawManual = input?.manualQty && typeof input.manualQty === "object" ? input.manualQty : {};
    for (const [key, raw] of Object.entries(rawManual)) {
        const [keyBranch, keyOrder, ...rest] = String(key).split("|");
        if (String(keyBranch).toUpperCase() !== branch || !orderSet.has(keyOrder) || !rest.length) continue;
        const qty = parseManualQty(raw);
        if (qty !== null) manualQty[`${branch}|${keyOrder}|${rest.join("|")}`] = qty;
    }

    let truckingFee = null;
    if (input?.truckingFee !== undefined && String(input.truckingFee).trim() !== "") {
        truckingFee = parseManualQty(input.truckingFee);
        if (truckingFee === null) return { error: "Enter the trucking fee as a number, e.g. 44000." };
    }

    return { value: { name, branch, orderNbrs, manualQty, truckingFee, snapshot: normalizeSnapshot(input?.snapshot) } };
}

const MAX_SNAPSHOT_CBM = 100000;
const MAX_SNAPSHOT_KG = 100000000;

/** Shipment size the browser measured when saving; null when it was still loading or nonsense. */
function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== "object") return null;
    const cbm = Number(raw.cbm);
    const weightKg = Number(raw.weightKg);
    if (!Number.isFinite(cbm) || !Number.isFinite(weightKg)) return null;
    if (cbm < 0 || weightKg < 0 || cbm > MAX_SNAPSHOT_CBM || weightKg > MAX_SNAPSHOT_KG) return null;
    return { cbm: Math.round(cbm * 10000) / 10000, weightKg: Math.round(weightKg * 100) / 100 };
}

function money(n) {
    return n == null ? "none" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Plain-language summary of what changed between two saved versions, for the activity history. */
export function describePackingListChange(before, after) {
    if (!before) return `Saved with ${after.orderNbrs.length} PO(s)`;
    const parts = [];
    if (before.name !== after.name) parts.push(`renamed to "${after.name}"`);
    const was = new Set(before.orderNbrs);
    const now = new Set(after.orderNbrs);
    const added = after.orderNbrs.filter((n) => !was.has(n));
    const removed = before.orderNbrs.filter((n) => !now.has(n));
    const list = (arr) => (arr.length > 3 ? `${arr.slice(0, 3).join(", ")} and ${arr.length - 3} more` : arr.join(", "));
    if (added.length) parts.push(`added ${list(added)}`);
    if (removed.length) parts.push(`removed ${list(removed)}`);
    if ((before.truckingFee ?? null) !== (after.truckingFee ?? null)) {
        parts.push(`trucking fee ${money(before.truckingFee)} → ${money(after.truckingFee)}`);
    }
    if (JSON.stringify(sortKeys(before.manualQty)) !== JSON.stringify(sortKeys(after.manualQty))) {
        parts.push("manual quantities updated");
    }
    if (!parts.length) return "Saved again with no changes";
    const text = parts.join("; ");
    return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 255);
}

function sortKeys(obj) {
    return Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** Owner or admin may overwrite or delete; everyone with branch access may open it. */
export function canEditSavedPackingList(record, user) {
    if (!record || !user) return false;
    if (user.role === "admin") return true;
    return Boolean(record.createdBy) && String(record.createdBy).toLowerCase() === String(user.username || "").toLowerCase();
}
