import { NextResponse } from "next/server";
import { getSessionFromRequest, getPoCredentialFromRequest, getActiveCompanyFromRequest } from "@/lib/session-store";
import {
    constrainBranchParam,
    emptyRestrictedPayload,
    getRequestBranchAccess,
    hasNoBranchAccess,
} from "@/lib/branch-access";
import { getSystemAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { kickCached } from "@/lib/server-cache";
import { alignAllOpenPurchaseOrderStatuses } from "@/lib/po-open-status-align";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function mergeLinesFromMap(orders, lineMap) {
    return orders.map(o => {
        if (o.lines?.length) return o;
        const key = String(o.orderNbr || "").trim();
        const lines = lineMap.get(key) || lineMap.get(o.orderNbr);
        return lines?.length ? { ...o, lines } : o;
    });
}

async function persistLinesToMySQL(orders) {
    const lineRows = [];
    for (const o of orders) {
        if (!o.lines?.length) continue;
        o.lines.forEach((line, idx) => {
            const warehouseId = String(line.warehouseId || line.branchId || "").trim();
            lineRows.push({
                order_nbr: o.orderNbr,
                line_nbr: idx + 1,
                inventory_id: line.inventoryId,
                description: line.description,
                qty: line.qty,
                uom: line.uom,
                warehouse_id: warehouseId || null,
                branch_id: warehouseId || null,
                ext_cost: line.extCost,
                last_sync: new Date(),
            });
        });
    }
    if (lineRows.length) {
        try {
            await MySqlService.upsertPurchaseOrderDetails(lineRows);
        } catch (err) {
            console.error("[PO Persist Lines]", err.message);
        }
    }
}

async function resolvePoCredential(request) {
    const poCred = getPoCredentialFromRequest(request);
    if (poCred && poCred !== "__bypass__") return poCred;
    return getSystemAcumaticaCredential();
}

async function fetchLivePurchaseOrders(params, credential) {
    if (!credential || credential === "__bypass__") {
        throw new Error("No valid Acumatica credentials available");
    }
    return AcumaticaService.getPurchaseOrders({ ...params, cookie: credential });
}

async function enrichMissingLines(orders, params, credential) {
    if (!orders.some(o => !o.lines?.length)) return orders;
    if (!credential || credential === "__bypass__") return orders;

    const missing = orders.filter(o => !o.lines?.length).map(o => o.orderNbr);
    if (!missing.length) return orders;

    try {
        const lineMap = await AcumaticaService.getPurchaseOrderLinesByNbrs(missing, credential);
        if (lineMap.size > 0) {
            const merged = mergeLinesFromMap(orders, lineMap);
            await persistLinesToMySQL(merged.filter(o => o.lines?.length));
            return merged;
        }
    } catch (err) {
        console.error("[PO Enrich Error]", err.message);
    }

    return orders;
}

async function enrichVendorNames(orders) {
    if (!orders?.length) return orders;
    const missingIds = [...new Set(
        orders
            .filter((o) => o.vendorId && !String(o.vendorName || "").trim())
            .map((o) => o.vendorId)
    )];
    if (!missingIds.length) return orders;

    const nameMap = await MySqlService.getVendorNamesByIds(missingIds);
    if (!Object.keys(nameMap).length) return orders;

    return orders.map((o) => ({
        ...o,
        vendorName: String(o.vendorName || "").trim() || nameMap[o.vendorId] || o.vendorName,
    }));
}

export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
        const pageSize = Math.min(100, parseInt(searchParams.get("pageSize") || "10"));
        const search = (searchParams.get("search") || "").trim();
        const startDate = searchParams.get("startDate") || "";
        const endDate = searchParams.get("endDate") || "";
        const status = searchParams.get("status") || "";
        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json(emptyRestrictedPayload({ orders: [], totalCount: 0 }), NO_STORE);
        }
        const branch = constrainBranchParam(access, (searchParams.get("branch") || "").trim());
        const vendorId = (searchParams.get("vendorId") || "").trim();
        const orderNbrsParam = searchParams.get("orderNbrs");
        const orderNbrs = orderNbrsParam == null
            ? null
            : orderNbrsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const source = searchParams.get("source") || "mysql";
        const userCred = getSessionFromRequest(request);
        const poCred = await resolvePoCredential(request);
        const companyId = getActiveCompanyFromRequest(request) || "main";

        const fetchParams = { page, pageSize, search, startDate, endDate, status, branch, vendorId, companyId, orderNbrs };

        if (source === "mysql") {
            try {
                // Background only — never block the PO list behind Acumatica align
                // or heavy MySQL repairs (those were causing nginx HTTP 504s).
                kickCached("po:align-open-status-v3-global", 10 * 60_000, async () => {
                    const cred = poCred && poCred !== "__bypass__"
                        ? poCred
                        : await getSystemAcumaticaCredential();
                    return alignAllOpenPurchaseOrderStatuses({
                        cookie: cred,
                        startDate: "2024-01-01",
                        closeStale: true,
                    });
                });

                kickCached("po:repair-data-v2", 15 * 60_000, async () => {
                    const aliases = await MySqlService.normalizePurchaseOrderStatusAliases();
                    const vendors = await MySqlService.backfillPurchaseHistoryVendorNames();
                    const amounts = await MySqlService.repairPurchaseOrderAmounts();
                    return { aliases, vendors, amounts };
                });

                let result = await MySqlService.getPurchaseOrders(fetchParams);

                // Prefer a fast in-memory vendor name enrich over another full-table backfill.
                const needsVendorBackfill = result.orders.some(
                    (o) => o.vendorId && !String(o.vendorName || "").trim()
                );
                if (needsVendorBackfill) {
                    result = {
                        ...result,
                        orders: await enrichVendorNames(result.orders),
                    };
                    kickCached("po:repair-vendors-once", 15 * 60_000, async () =>
                        MySqlService.backfillPurchaseHistoryVendorNames()
                    );
                }

                // Always return MySQL list results (including empty). Do not fall through to
                // live Acumatica — that path ignores Active multi-status and excludeZeroQty.
                const allMissingLines = result.orders.length > 0
                    && result.orders.every((o) => !o.lines?.length);

                if (allMissingLines && poCred) {
                    try {
                        const live = await fetchLivePurchaseOrders(fetchParams, poCred);
                        if (live.orders.length > 0 && live.orders.some((o) => o.lines?.length)) {
                            await persistLinesToMySQL(live.orders);
                            result = await MySqlService.getPurchaseOrders(fetchParams);
                        }
                    } catch (liveErr) {
                        console.error("[PO Live Fallback]", liveErr.message);
                    }
                }

                const enriched = await enrichMissingLines(result.orders, fetchParams, poCred);
                const wasEnriched = enriched.some(
                    (o, i) => (o.lines?.length || 0) > (result.orders[i]?.lines?.length || 0)
                );

                return NextResponse.json({
                    ...result,
                    orders: await enrichVendorNames(enriched),
                    source: wasEnriched ? "mysql+enriched" : "mysql",
                    page,
                    pageSize,
                }, NO_STORE);
            } catch (mError) {
                console.error("[MySQL PO Error]", mError.message);
            }
        }

        if (!userCred) {
            if (!poCred) {
                return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
            }
            const result = await fetchLivePurchaseOrders(fetchParams, poCred);
            return NextResponse.json({
                ...result,
                orders: await enrichVendorNames(result.orders),
                source: "acumatica-system",
                page,
                pageSize,
            }, NO_STORE);
        }

        if (userCred === "__bypass__") {
            if (poCred) {
                try {
                    const result = await fetchLivePurchaseOrders(fetchParams, poCred);
                    if (result.orders.length > 0) {
                        await persistLinesToMySQL(result.orders);
                        return NextResponse.json({
                            ...result,
                            orders: await enrichVendorNames(result.orders),
                            source: "acumatica-system",
                            page,
                            pageSize,
                        }, NO_STORE);
                    }
                } catch (err) {
                    console.error("[PO Bypass Fallback]", err.message);
                }
            }
            return NextResponse.json({
                orders: [],
                hasMore: false,
                source: "mysql-bypass-empty",
                page,
                pageSize,
            }, NO_STORE);
        }

        const result = await fetchLivePurchaseOrders(fetchParams, poCred || userCred);

        return NextResponse.json({
            ...result,
            orders: await enrichVendorNames(result.orders),
            source: "acumatica",
            page,
            pageSize,
        }, NO_STORE);
    } catch (err) {
        console.error("[PO API Error]", err);
        return NextResponse.json({ message: err.message }, { status: 500 });
    }
}
