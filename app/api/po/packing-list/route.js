import { NextResponse } from "next/server";
import { getActiveCompanyFromRequest } from "@/lib/session-store";
import {
    constrainBranchParam,
    emptyRestrictedPayload,
    getRequestBranchAccess,
    hasNoBranchAccess,
} from "@/lib/branch-access";
import { getStockWarehouseIdsForBranch } from "@/lib/companies";
import { MySqlService } from "@/services/mysql";
import { normalizeInvKey } from "@/lib/forecast-generator";
import { MAIN_BRANCH } from "@/lib/packing-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const MAX_ORDER_NBRS = 200;

/**
 * Packing List Generator data (read-only, MySQL only).
 *   mode=orders  POs that have lines for the branch (light rows for the pick list)
 *   mode=lines   lines of the chosen POs for that branch, with item dimensions and
 *                available stock in the branch and in MAIN
 */

function branchLineMatcher(branch) {
    const ids = new Set(
        [branch, ...getStockWarehouseIdsForBranch(branch)].map((id) => String(id).trim().toUpperCase()).filter(Boolean)
    );
    return (line) => {
        const wh = String(line.warehouseId || "").trim().toUpperCase();
        const br = String(line.branchId || "").trim().toUpperCase();
        return (wh && ids.has(wh)) || (br && ids.has(br));
    };
}

/** Lines for the branch. Older POs may have no warehouse on the line; the branch filter already matched the PO. */
function branchLines(lines, inBranch) {
    const all = lines || [];
    const mine = all.filter(inBranch);
    return mine.length ? mine : all.filter((l) => !String(l.warehouseId || l.branchId || "").trim());
}

function int(value, fallback, min, max) {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

async function listOrders(sp, branch, companyId) {
    const page = int(sp.get("page"), 1, 1, 10000);
    const pageSize = int(sp.get("pageSize"), 50, 1, 100);
    const result = await MySqlService.getPurchaseOrders({
        page,
        pageSize,
        branch,
        companyId,
        status: (sp.get("status") || "active").trim(),
        startDate: (sp.get("startDate") || "").trim(),
        endDate: (sp.get("endDate") || "").trim(),
        search: (sp.get("search") || "").trim(),
    });
    const inBranch = branchLineMatcher(branch);
    const orders = (result.orders || []).map((o) => {
        const used = branchLines(o.lines, inBranch);
        return {
            orderNbr: o.orderNbr,
            date: o.date,
            vendorId: o.vendorId,
            vendorName: o.vendorName,
            status: o.status,
            lineCount: used.length,
            totalQty: used.reduce((sum, l) => sum + (Number(l.qty) || 0), 0),
        };
    });
    return {
        orders,
        totalCount: result.totalCount ?? orders.length,
        hasMore: typeof result.totalCount === "number" ? page * pageSize < result.totalCount : Boolean(result.hasMore),
        page,
        pageSize,
    };
}

async function listLines(sp, branch, companyId) {
    const orderNbrs = [...new Set(
        String(sp.get("orderNbrs") || "").split(",").map((s) => s.trim()).filter(Boolean)
    )].slice(0, MAX_ORDER_NBRS);
    if (!orderNbrs.length) return { lines: [] };

    const result = await MySqlService.getPurchaseOrders({
        page: 1,
        pageSize: orderNbrs.length,
        orderNbrs,
        branch,
        companyId,
        excludeZeroQty: false,
    });
    const inBranch = branchLineMatcher(branch);
    const lines = [];
    for (const o of result.orders || []) {
        for (const l of branchLines(o.lines, inBranch)) {
            lines.push({
                orderNbr: o.orderNbr,
                orderDate: o.date,
                lineNbr: l.lineNbr ?? null,
                inventoryId: l.inventoryId,
                description: l.description,
                qty: Number(l.qty) || 0,
                uom: l.uom || "",
                warehouseId: l.warehouseId || "",
            });
        }
    }

    const ids = [...new Set(lines.map((l) => String(l.inventoryId || "").trim()).filter(Boolean))];
    const dims = {};
    for (let i = 0; i < ids.length; i += 200) {
        Object.assign(dims, await MySqlService.getItemDimensionsBatch(ids.slice(i, i + 200)));
    }
    const isMain = branch.toUpperCase() === MAIN_BRANCH;
    const [branchStock, mainStock] = await Promise.all([
        MySqlService.getBranchOnHandForItems(ids, { branch, companyId }),
        isMain ? null : MySqlService.getBranchOnHandForItems(ids, { branch: MAIN_BRANCH, companyId: "main" }),
    ]);
    for (const line of lines) {
        const key = String(line.inventoryId || "").trim();
        const stockKey = normalizeInvKey(key);
        line.dimensions = dims[key] || dims[key.toUpperCase()] || null;
        line.branchStock = branchStock.get(stockKey) ?? 0;
        line.mainStock = isMain ? line.branchStock : (mainStock.get(stockKey) ?? 0);
    }
    return { lines };
}

export async function GET(request) {
    try {
        const sp = new URL(request.url).searchParams;
        const mode = sp.get("mode") || "orders";
        if (mode !== "orders" && mode !== "lines") {
            return NextResponse.json({ message: "Unknown mode." }, { status: 400 });
        }

        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json(emptyRestrictedPayload({ lines: [] }), NO_STORE);
        }
        const requested = (sp.get("branch") || "").trim();
        if (!requested && access.allBranches) {
            return NextResponse.json({ message: "Pick a branch first." }, { status: 400 });
        }
        const branch = constrainBranchParam(access, requested);
        const companyId = getActiveCompanyFromRequest(request) || "main";

        const data = mode === "lines"
            ? await listLines(sp, branch, companyId)
            : await listOrders(sp, branch, companyId);
        return NextResponse.json({ ...data, branch }, NO_STORE);
    } catch (err) {
        console.error("[PO Packing List]", err);
        return NextResponse.json({ message: "Could not load the packing list. Please try again." }, { status: 500 });
    }
}
