import { NextResponse } from "next/server";
import { constrainBranchParam, getRequestBranchAccess, hasNoBranchAccess } from "@/lib/branch-access";
import { getActiveCompanyFromRequest } from "@/lib/session-store";
import { userCanAccessModule } from "@/lib/module-access";
import { normalizeQuickSearchQuery } from "@/lib/quick-search";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const PER_SECTION = 6;
const SECTION_TIMEOUT_MS = 4000;

function withTimeout(promise) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), SECTION_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
}

async function safe(label, fn) {
    try {
        return await withTimeout(fn());
    } catch (err) {
        console.error(`[Quick search] ${label}`, err?.message || err);
        return null;
    }
}

/** Items, purchase orders and suppliers matching the text, limited to what this user may open. */
export async function GET(request) {
    const q = normalizeQuickSearchQuery(new URL(request.url).searchParams.get("q"));
    if (!q) return NextResponse.json({ q: "", items: [], orders: [], suppliers: [] }, NO_STORE);

    try {
        const access = await getRequestBranchAccess(request);
        const user = access.user;
        const can = (moduleId) => !user || userCanAccessModule(user, moduleId);
        const companyId = getActiveCompanyFromRequest(request) || "main";
        const noBranches = hasNoBranchAccess(access);

        const [items, orders, suppliers] = await Promise.all([
            can("stock-items")
                ? safe("items", () => MySqlService.getStockItems({ page: 1, pageSize: PER_SECTION, search: q, companyId }))
                : null,
            can("purchase-orders") && !noBranches
                ? safe("orders", () => MySqlService.getPurchaseOrders({
                    page: 1,
                    pageSize: PER_SECTION,
                    search: q,
                    branch: access.allBranches ? "" : constrainBranchParam(access, ""),
                    excludeZeroQty: false,
                }))
                : null,
            can("suppliers")
                ? safe("suppliers", () => MySqlService.getVendors({ page: 1, pageSize: PER_SECTION, search: q }))
                : null,
        ]);

        return NextResponse.json({
            q,
            items: (items?.items || []).slice(0, PER_SECTION).map((i) => ({
                inventoryId: i.inventoryId,
                description: i.description || "",
            })),
            orders: (orders?.orders || []).slice(0, PER_SECTION).map((o) => ({
                orderNbr: o.orderNbr,
                vendorName: o.vendorName || o.vendorId || "",
                status: o.status || "",
                date: o.date || null,
            })),
            suppliers: (suppliers?.data || []).slice(0, PER_SECTION).map((v) => ({
                vendorId: v.VendorID?.value,
                vendorName: v.VendorName?.value || "",
            })),
        }, NO_STORE);
    } catch (err) {
        console.error("[Quick search]", err?.message || err);
        return NextResponse.json({ message: "Search is not available right now." }, { status: 500 });
    }
}
