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

    return { value: { name, branch, orderNbrs, manualQty, truckingFee } };
}

/** Owner or admin may overwrite or delete; everyone with branch access may open it. */
export function canEditSavedPackingList(record, user) {
    if (!record || !user) return false;
    if (user.role === "admin") return true;
    return Boolean(record.createdBy) && String(record.createdBy).toLowerCase() === String(user.username || "").toLowerCase();
}
