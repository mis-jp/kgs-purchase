import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";

/** IDs Acumatica did not return, so a name search does not retry them on every keystroke. */
const unavailableUntil = new Map();
const MISS_TTL_MS = 10 * 60 * 1000;

function rememberMiss(id) {
    unavailableUntil.set(String(id).trim().toUpperCase(), Date.now() + MISS_TTL_MS);
}

function isRememberedMiss(id) {
    const until = unavailableUntil.get(String(id).trim().toUpperCase());
    if (!until) return false;
    if (Date.now() > until) {
        unavailableUntil.delete(String(id).trim().toUpperCase());
        return false;
    }
    return true;
}

function dedupeVendorRows(rows) {
    const byId = new Map();
    for (const row of rows || []) {
        const id = String(row?.vendor_id || "").trim();
        const name = String(row?.vendor_name || "").trim();
        if (!id || !name) continue;
        byId.set(id.toUpperCase(), { ...row, vendor_id: id, vendor_name: name });
    }
    return [...byId.values()];
}

/**
 * Copy vendor names from Acumatica into the local directory so Purchase Order
 * name search can match them. Newer vendors never land in `vendors` during a
 * PO-only sync, and those orders then have a blank vendor name.
 */
export async function ensurePurchaseVendorNames({ search = "", cookie, fillMissing = true } = {}) {
    if (!cookie || cookie === "__bypass__") return { upserted: 0, skipped: true };

    const q = String(search || "").trim();
    const missing = fillMissing
        ? (await MySqlService.listPurchaseVendorIdsMissingFromDirectory(40))
            .filter((id) => !isRememberedMiss(id))
        : [];
    const localHits = q.length >= 2 ? await MySqlService.findVendorIdsByName(q) : [];
    // Order-number searches share the same query param. Do not ask Acumatica
    // for a vendor name when the text is an order number.
    const looksLikeOrderNbr = /^[A-Za-z]{1,8}\d{4,}$/.test(q.replace(/\s+/g, ""));
    const needNameLookup = q.length >= 2 && localHits.length === 0 && !looksLikeOrderNbr;
    if (!missing.length && !needNameLookup) return { upserted: 0 };

    const fetched = [];
    if (missing.length) {
        const page = await AcumaticaService.lookupVendorDirectory(cookie);
        fetched.push(...page);
    }
    if (needNameLookup) {
        fetched.push(...await AcumaticaService.lookupVendorsByName(q, cookie));
    }

    const rows = dedupeVendorRows(fetched);
    if (!rows.length) return null;
    await MySqlService.upsertVendors(rows);
    await MySqlService.backfillPurchaseHistoryVendorNames();
    const covered = new Set(rows.map((r) => r.vendor_id.toUpperCase()));
    const stillMissing = missing.filter((id) => !covered.has(id.toUpperCase()));
    if (stillMissing.length) return null;
    return { upserted: rows.length };
}

export function withVendorNameTimeout(promise, ms = 8000) {
    return Promise.race([
        promise.catch((err) => {
            console.warn("[PO vendor names]", err?.message || err);
            return { upserted: 0, error: true };
        }),
        new Promise((resolve) => {
            setTimeout(() => resolve({ upserted: 0, timedOut: true }), ms);
        }),
    ]);
}
