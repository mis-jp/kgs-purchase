/** Rows of an Acumatica list reply: a plain array from the REST API, or an OData `{ value: [...] }`. */
export function acumaticaList(data) {
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.value) ? data.value : [];
}

/**
 * Vendors whose name in Acumatica differs from the saved name (case counts).
 * New vendors and blank incoming names are not renames.
 */
export function findVendorRenames(savedRows, incomingRows) {
    const before = new Map(
        (savedRows || []).map((r) => [String(r.vendor_id || "").trim().toUpperCase(), String(r.vendor_name || "").trim()])
    );
    const renamed = [];
    for (const r of incomingRows || []) {
        const vendorId = String(r?.vendor_id || "").trim();
        const next = String(r?.vendor_name || "").trim();
        const prev = before.get(vendorId.toUpperCase());
        if (vendorId && next && prev && prev !== next) renamed.push({ vendorId, from: prev, to: next });
    }
    return renamed;
}
