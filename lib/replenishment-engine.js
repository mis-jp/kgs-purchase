import { filterReplenishmentBranchList, isExcludedBranchAlias, resolveCompanyIdForBranch, isEcomBranchAlias } from "@/lib/companies";
import { MySqlService } from "@/services/mysql";
import {
    buildReplenishmentInsight,
    buildBranchBrief,
    TARGET_DAYS_OF_COVER,
    SAFETY_BUFFER_DAYS,
} from "@/lib/replenishment-insights";
import { SALES_LOOKBACK_DAYS, averageDailySales } from "@/lib/sales-velocity";
import { normalizeInvKey } from "@/lib/forecast-generator";

/** Bump when sales velocity / order-qty logic changes so stale replenishment_cache rows are recomputed. */
export const REPLENISHMENT_SALES_LOGIC_VERSION = 21;

/**
 * Order Qty (e) from the business formula:
 *   a = inventory on hand (branch or MAIN)
 *   b = Coming PO
 *   c = a + b
 *   d = Sells / day
 *   e = d − c   (negative = surplus)
 * Always whole units (ceil need, floor surplus).
 */
export function computeOrderQtyFromSellsPerDay(inventoryOnHand, comingPoQty, sellsPerDay) {
    const a = Number(inventoryOnHand) || 0;
    const b = Number(comingPoQty) || 0;
    const d = Number(sellsPerDay) || 0;
    const e = d - (a + b);
    if (!Number.isFinite(e) || e === 0) return 0;
    // Positive need → round up so fractional demand still orders a full unit
    if (e > 0) return Math.ceil(e);
    // Surplus → whole number (e.g. -438.1 → -439)
    return Math.floor(e);
}

/**
 * MAIN vendor PO quantity: ship branch transfers from on-hand MAIN stock first,
 * then order enough so MAIN still reaches its own 60-day shelf target.
 * Example: target 836, on-hand 636, branches need 517 → 836 − (636 − 517) = 717.
 */
export function computeMainVendorOrderQty(mainInventory, totalBranchReplenishment, mainTargetStock) {
    const mainInv = Number(mainInventory) || 0;
    const branchRepl = Number(totalBranchReplenishment) || 0;
    const mainTarget = Number(mainTargetStock) || 0;
    if (mainTarget <= 0) {
        return Math.max(0, branchRepl - mainInv);
    }
    const branchShortfall = Math.max(0, branchRepl - mainInv);
    const stockAfterBranches = mainInv - branchRepl;
    const mainShelfGap = Math.max(0, mainTarget - stockAfterBranches);
    return Math.max(branchShortfall, mainShelfGap);
}

/**
 * MAIN Order qty column uses the same a+b=c, d−c=e formula as branches:
 * Sells/day − (MAIN inventory + Coming PO). Negative = surplus.
 * (Vendor PO planning still uses computeMainVendorOrderQty / TBR separately.)
 */
export function resolveMainOrderQty(
    mainInventory,
    _totalBranchReplenishment,
    _mainTargetStock,
    comingPoQty = 0,
    sellsPerDay = 0
) {
    return computeOrderQtyFromSellsPerDay(mainInventory, comingPoQty, sellsPerDay);
}

/** Single source of truth for MAIN row metrics (cache build + live overlay). */
export function computeMainRowMetrics({
    mainInventory,
    totalBranchReplenishment,
    mainQtySold90,
    lookbackDays = SALES_LOOKBACK_DAYS,
    comingPoQty = 0,
    leadTimeDays = 0,
}) {
    const mainInv = Number(mainInventory) || 0;
    const branchRepl = Number(totalBranchReplenishment) || 0;
    const qty90 = Number(mainQtySold90) || 0;
    const mainAds = qty90 > 0 ? averageDailySales(qty90, lookbackDays) : 0;
    const mainTargetStock = mainAds > 0 ? Math.ceil(mainAds * TARGET_DAYS_OF_COVER) : 0;
    const vendorShortfall = Math.max(0, branchRepl - mainInv);
    const vendorOrderQty = computeMainVendorOrderQty(mainInv, branchRepl, mainTargetStock);
    const mainShelfGap = computeMainVendorOrderQty(mainInv, 0, mainTargetStock);
    const suggestedQty = resolveMainOrderQty(mainInv, branchRepl, mainTargetStock, comingPoQty, mainAds);
    const daysRemaining = mainAds > 0 ? Math.floor((mainInv + comingPoQty) / mainAds) : null;
    const isCritical = suggestedQty > 0 && (
        vendorOrderQty > 0 ||
        (mainAds > 0 && daysRemaining !== null && daysRemaining <= (leadTimeDays + SAFETY_BUFFER_DAYS))
    );
    const priority = isCritical
        ? "High"
        : suggestedQty > 0
            ? "Medium"
            : "Low";

    return {
        mainAds,
        mainTargetStock,
        vendorShortfall,
        vendorOrderQty,
        mainShelfGap,
        suggestedQty,
        daysRemaining,
        priority,
        hasSalesHistory: mainAds > 0,
        qtySold90: qty90,
    };
}

export function buildRecommendation(item, branch, vendorMap, leadTimeMap, recId, lookbackDays = SALES_LOOKBACK_DAYS, comingPO = 0) {
    const itemId = (item.inventoryId || "").toUpperCase().trim();
    const currentStock = Number(item.totalOnHand) || 0;
    const comingPoQty = Number(comingPO) || 0;
    const available = currentStock + comingPoQty;
    const qtySold = Number(item.totalQtySold) || 0;
    const ads = averageDailySales(qtySold, lookbackDays);
    const vendorId = vendorMap.get(itemId) || null;
    const leadTime = vendorId ? (leadTimeMap[vendorId]?.days || 0) : 0;
    const hasSalesHistory = ads > 0;

    let daysRemaining = null;
    let targetStock = 0;
    let suggestedQty = 0;
    let priority = "Low";

    if (hasSalesHistory) {
        daysRemaining = Math.floor(available / ads);
        targetStock = Math.ceil(ads * TARGET_DAYS_OF_COVER);
        // a + b = c; e = d − c  (Sells/day − (stock + Coming PO)); negative = surplus
        suggestedQty = computeOrderQtyFromSellsPerDay(currentStock, comingPoQty, ads);
        const isCritical = suggestedQty > 0 && daysRemaining <= (leadTime + SAFETY_BUFFER_DAYS);
        priority = suggestedQty <= 0
            ? "Low"
            : isCritical
                ? "High"
                : daysRemaining < 30
                    ? "Medium"
                    : "Low";
    } else {
        // No sales: Order qty = 0 − (stock + Coming PO) → surplus / no transfer
        suggestedQty = computeOrderQtyFromSellsPerDay(currentStock, comingPoQty, 0);
        priority = "Low";
    }

    const aiInsights = buildReplenishmentInsight({
        itemId: item.inventoryId,
        description: item.description,
        currentStock,
        suggestedQty,
        priorityLevel: priority,
        branchId: branch,
        ads,
        daysRemaining: daysRemaining ?? 0,
        leadTimeDays: leadTime,
        vendorId,
        hasSalesHistory,
        qtySold90: qtySold,
        targetStock,
        salesScope: item.salesScope,
        lookbackDays,
        comingPoQty,
    });

    return {
        recommendationId: `REC-${recId}`,
        itemId: item.inventoryId,
        description: item.description,
        itemClass: item.itemClass || item.ItemClass || "",
        currentStock,
        comingPO: comingPoQty,
        suggestedQty,
        priorityLevel: priority,
        branchId: branch,
        restockSource: aiInsights.restockSource,
        generatedDate: new Date().toISOString(),
        aiInsights,
        stockSource: item.stockSource || "mysql",
        leadTimeDays: leadTime,
        vendorId,
        qtySold90: qtySold,
        lookbackDays,
        salesLogicVersion: REPLENISHMENT_SALES_LOGIC_VERSION,
    };
}

export function buildMainRecommendation({
    item,
    branchOrderQty,
    comingPO,
    vendorMap,
    leadTimeMap,
    recId,
    lookbackDays = SALES_LOOKBACK_DAYS,
    branchesNeeding = 0,
}) {
    const itemId = (item.inventoryId || "").toUpperCase().trim();
    const mainInventory = Number(item.totalOnHand) || 0;
    const qtySold = Number(item.totalQtySold) || 0;
    const vendorId = vendorMap.get(itemId) || null;
    const leadTime = vendorId ? (leadTimeMap[vendorId]?.days || 0) : 0;
    const totalBranchReplenishment = Number(branchOrderQty) || 0;
    const comingPoQty = Number(comingPO) || 0;
    const branchCount = Number(branchesNeeding) || 0;

    const metrics = computeMainRowMetrics({
        mainInventory,
        totalBranchReplenishment,
        mainQtySold90: qtySold,
        lookbackDays,
        comingPoQty,
        leadTimeDays: leadTime,
    });
    const { mainAds, mainTargetStock, vendorShortfall, vendorOrderQty, mainShelfGap, suggestedQty: orderQty, daysRemaining, priority } = metrics;

    const aiInsights = buildReplenishmentInsight({
        itemId: item.inventoryId,
        description: item.description,
        currentStock: mainInventory,
        suggestedQty: orderQty,
        priorityLevel: priority,
        branchId: "MAIN",
        ads: mainAds,
        daysRemaining: daysRemaining ?? 0,
        leadTimeDays: leadTime,
        vendorId,
        hasSalesHistory: metrics.hasSalesHistory,
        qtySold90: qtySold,
        targetStock: mainTargetStock,
        salesScope: item.salesScope || "network",
        lookbackDays,
            mainWarehouseContext: {
                branchOrderQty: totalBranchReplenishment,
                comingPO: comingPoQty,
                totalBranchReplenishment,
                branchesNeeding: branchCount,
                vendorShortfall,
                vendorOrderQty,
                mainTargetStock,
                mainShelfGap,
            },
    });

    return {
        recommendationId: `REC-${recId}`,
        itemId: item.inventoryId,
        description: item.description,
        itemClass: item.itemClass || item.ItemClass || "",
        currentStock: mainInventory,
        mainInventory,
        branchOrderQty: totalBranchReplenishment,
        branchesNeeding: branchCount,
        comingPO: comingPoQty,
        totalBranchReplenishment,
        suggestedQty: orderQty,
        priorityLevel: priority,
        branchId: "MAIN",
        restockSource: aiInsights.restockSource,
        generatedDate: new Date().toISOString(),
        aiInsights,
        stockSource: item.stockSource || "mysql",
        leadTimeDays: leadTime,
        vendorId,
        qtySold90: qtySold,
        lookbackDays,
        isMainWarehouseView: true,
        salesLogicVersion: REPLENISHMENT_SALES_LOGIC_VERSION,
    };
}

/**
 * Overlay live Qty On Hand + Coming PO onto recommendations.
 * Cache rows can be stale; stock must match Acumatica-synced forecast_item_stock.
 *
 * Inventory IDs are normalized (spaces stripped) so cache keys like 2000SBMHR8002
 * match forecast rows like "2000SBMHR800 2".
 */
/**
 * Resolve MAIN Total Branch Repl demand maps.
 * Always merge live SQL + replenishment_cache rollups (max per item) so a
 * partial/empty live map cannot zero out items that still have branch gaps.
 */
async function resolveMainBranchDemand(companyId) {
    return MySqlService.getAccurateRetailBranchDemandRollup(companyId);
}

function slimBranchAiPatch(rec, { currentStock, comingPoQty, suggestedQty, ads, daysRemaining, priority, lookbackDays }) {
    const preview = ads > 0
        ? `${currentStock} on hand · ${ads.toFixed(2)}/day · ${daysRemaining ?? "—"} days left`
        : `${currentStock} on hand · no recent sales`;
    let whatToDo = rec.aiInsights?.whatToDo || "";
    if (suggestedQty > 0 && priority === "High") {
        whatToDo = `Transfer ${suggestedQty} from MAIN today.`;
    } else if (suggestedQty > 0) {
        whatToDo = `Transfer ${suggestedQty} from MAIN within 1–2 weeks.`;
    } else if (!whatToDo) {
        whatToDo = "No transfer needed — stock is sufficient for now.";
    }
    return {
        ...(rec.aiInsights || {}),
        salesVelocity: ads > 0 ? ads.toFixed(2) : String(rec.aiInsights?.salesVelocity || "0"),
        daysRemaining: daysRemaining ?? rec.aiInsights?.daysRemaining,
        whatToDo,
        howItWorks: { preview, steps: [] },
        lookbackDays,
    };
}

function slimMainAiPatch(rec, metrics, ctx) {
    const { mainInventory, comingPoQty, totalBranchReplenishment, leadTime } = ctx;
    const totalAvailable = mainInventory + comingPoQty;
    const preview = totalBranchReplenishment > 0
        ? `Branches need ${totalBranchReplenishment} units; MAIN has ${mainInventory} + ${comingPoQty} incoming (${totalAvailable} total).`
        : (rec.aiInsights?.howItWorks?.preview || `${mainInventory} on hand`);
    let whatToDo;
    if (metrics.suggestedQty > 0) {
        whatToDo = `Order or transfer ${metrics.suggestedQty} units — branch need exceeds MAIN on-hand + Coming PO.`;
    } else if (metrics.suggestedQty < 0) {
        whatToDo = `Surplus of ${Math.abs(metrics.suggestedQty)} units at MAIN (including Coming PO) — no additional order needed.`;
    } else {
        whatToDo = "Branch need matches MAIN availability — no order needed.";
    }
    return {
        ...(rec.aiInsights || {}),
        salesVelocity: metrics.mainAds > 0 ? metrics.mainAds.toFixed(2) : String(rec.aiInsights?.salesVelocity || "0"),
        daysRemaining: metrics.daysRemaining ?? rec.aiInsights?.daysRemaining,
        leadTimeDays: leadTime,
        whatToDo,
        howItWorks: { preview, steps: [] },
    };
}

async function applyLiveComingPoFast(recommendations, branch, { slim = false } = {}) {
    const dest = String(branch || "MAIN").trim().toUpperCase() || "MAIN";
    const isMain = dest === "MAIN";
    const companyId = resolveCompanyIdForBranch("main", dest);
    const recs = recommendations || [];
    if (!recs.length) return recs;

    const itemIds = recs.map((r) => r.itemId).filter(Boolean);

    if (!isMain) {
        const [comingPoMap, onHandMap] = await Promise.all([
            MySqlService.getOpenPoQtyForItems(itemIds, { warehouseId: dest }),
            MySqlService.getBranchOnHandForItems(itemIds, { branch: dest, companyId }),
        ]);

        return recs.map((rec) => {
            const key = normalizeInvKey(rec.itemId);
            const comingPoQty = Number(comingPoMap.get(key)) || 0;
            const currentStock = Number(onHandMap.get(key)) || 0;
            const lookbackDays = Number(rec.lookbackDays) || SALES_LOOKBACK_DAYS;
            const qtySold90 = Number(rec.qtySold90) || 0;
            const adsFromQty = qtySold90 > 0 ? averageDailySales(qtySold90, lookbackDays) : 0;
            const ads = Number(rec.aiInsights?.salesVelocity) || adsFromQty || 0;
            const leadTime = Number(rec.leadTimeDays ?? rec.aiInsights?.leadTimeDays) || 0;
            const vendorId = rec.vendorId || null;
            const targetStock = ads > 0 ? Math.ceil(ads * TARGET_DAYS_OF_COVER) : 0;
            const available = currentStock + comingPoQty;
            // a + b = c; e = d − c
            const suggestedQty = computeOrderQtyFromSellsPerDay(currentStock, comingPoQty, ads);
            const daysRemaining = ads > 0 ? Math.floor(available / ads) : null;
            const hasSalesHistory = ads > 0;
            let priority = "Low";
            if (hasSalesHistory && suggestedQty > 0) {
                const isCritical = daysRemaining !== null && daysRemaining <= (leadTime + SAFETY_BUFFER_DAYS);
                priority = isCritical ? "High" : daysRemaining < 30 ? "Medium" : "Low";
            }

            const aiInsightsFinal = slim
                ? slimBranchAiPatch(rec, {
                    currentStock,
                    comingPoQty,
                    suggestedQty,
                    ads,
                    daysRemaining,
                    priority,
                    lookbackDays,
                })
                : buildReplenishmentInsight({
                    itemId: rec.itemId,
                    description: rec.description,
                    currentStock,
                    suggestedQty,
                    priorityLevel: priority,
                    branchId: dest,
                    ads,
                    daysRemaining: daysRemaining ?? 0,
                    leadTimeDays: leadTime,
                    vendorId,
                    hasSalesHistory,
                    qtySold90,
                    targetStock,
                    salesScope: rec.salesScope || rec.aiInsights?.salesScope || "branch",
                    lookbackDays,
                });

            return {
                ...rec,
                currentStock,
                comingPO: comingPoQty,
                suggestedQty,
                priorityLevel: priority,
                restockSource: aiInsightsFinal.restockSource || rec.restockSource,
                stockSource: "forecast_item_stock",
                aiInsights: slim
                    ? aiInsightsFinal
                    : {
                        ...aiInsightsFinal,
                        salesVelocity: ads,
                        daysRemaining: daysRemaining ?? aiInsightsFinal.daysRemaining,
                        leadTimeDays: leadTime,
                    },
            };
        });
    }

    const [comingPoMap, onHandMap] = await Promise.all([
        MySqlService.getOpenPoQtyForItems(itemIds, { warehouseId: dest }),
        MySqlService.getBranchOnHandForItems(itemIds, { branch: dest, companyId }),
    ]);

    return recs.map((rec) => {
        const key = normalizeInvKey(rec.itemId);
        const comingPoQty = Number(comingPoMap.get(key)) || 0;
        const mainInventory = Number(onHandMap.get(key)) || 0;
        const totalBranchReplenishment = Math.max(
            Number(rec.totalBranchReplenishment) || 0,
            Number(rec.branchOrderQty) || 0
        );
        const lookbackDays = Number(rec.lookbackDays) || SALES_LOOKBACK_DAYS;
        const mainQtySold90 = Number(rec.qtySold90) || 0;
        const leadTime = Number(rec.leadTimeDays ?? rec.aiInsights?.leadTimeDays) || 0;
        const vendorId = rec.vendorId || null;

        const metrics = computeMainRowMetrics({
            mainInventory,
            totalBranchReplenishment,
            mainQtySold90,
            lookbackDays,
            comingPoQty,
            leadTimeDays: leadTime,
        });

        const aiInsightsFinal = slim
            ? slimMainAiPatch(rec, metrics, {
                mainInventory,
                comingPoQty,
                totalBranchReplenishment,
                leadTime,
            })
            : buildReplenishmentInsight({
                itemId: rec.itemId,
                description: rec.description,
                currentStock: mainInventory,
                suggestedQty: metrics.suggestedQty,
                priorityLevel: metrics.priority,
                branchId: "MAIN",
                ads: metrics.mainAds,
                daysRemaining: metrics.daysRemaining ?? 0,
                leadTimeDays: leadTime,
                vendorId,
                hasSalesHistory: metrics.hasSalesHistory,
                qtySold90: metrics.qtySold90,
                targetStock: metrics.mainTargetStock,
                salesScope: rec.salesScope || rec.aiInsights?.salesScope || "network",
                lookbackDays,
                mainWarehouseContext: {
                    branchOrderQty: totalBranchReplenishment,
                    comingPO: comingPoQty,
                    totalBranchReplenishment,
                    vendorShortfall: metrics.vendorShortfall,
                    vendorOrderQty: metrics.vendorOrderQty,
                    mainTargetStock: metrics.mainTargetStock,
                    mainShelfGap: metrics.mainShelfGap,
                },
            });

        return {
            ...rec,
            comingPO: comingPoQty,
            suggestedQty: metrics.suggestedQty,
            currentStock: mainInventory,
            mainInventory,
            totalBranchReplenishment,
            branchOrderQty: totalBranchReplenishment,
            priorityLevel: metrics.priority,
            restockSource: aiInsightsFinal.restockSource || rec.restockSource,
            stockSource: "forecast_item_stock",
            aiInsights: slim
                ? aiInsightsFinal
                : {
                    ...aiInsightsFinal,
                    salesVelocity: metrics.mainAds,
                    daysRemaining: metrics.daysRemaining ?? aiInsightsFinal.daysRemaining,
                    leadTimeDays: leadTime,
                },
        };
    });
}

export async function applyLiveComingPo(recommendations, branch, { slim = false, fast = false } = {}) {
    if (fast) {
        return applyLiveComingPoFast(recommendations, branch, { slim });
    }
    const dest = String(branch || "MAIN").trim().toUpperCase() || "MAIN";
    const isMain = dest === "MAIN";
    const companyId = resolveCompanyIdForBranch("main", dest);

    if (!isMain) {
        const [comingPoMap, onHandMap] = await Promise.all([
            MySqlService.getOpenPoQtyByItem({ warehouseId: dest }),
            MySqlService.getBranchOnHandMap({ branch: dest, companyId }),
        ]);

        return (recommendations || []).map((rec) => {
            const key = normalizeInvKey(rec.itemId);
            // Live forecast map is authoritative — do not fall back to stale cache stock.
            const comingPoQty = Number(comingPoMap.get(key)) || 0;
            const currentStock = Number(onHandMap.get(key)) || 0;
            const lookbackDays = Number(rec.lookbackDays) || SALES_LOOKBACK_DAYS;
            const qtySold90 = Number(rec.qtySold90) || 0;
            const adsFromQty = qtySold90 > 0 ? averageDailySales(qtySold90, lookbackDays) : 0;
            const ads = Number(rec.aiInsights?.salesVelocity) || adsFromQty || 0;
            const leadTime = Number(rec.leadTimeDays ?? rec.aiInsights?.leadTimeDays) || 0;
            const vendorId = rec.vendorId || null;
            const targetStock = ads > 0 ? Math.ceil(ads * TARGET_DAYS_OF_COVER) : 0;
            const available = currentStock + comingPoQty;
            // a + b = c; e = d − c
            const suggestedQty = computeOrderQtyFromSellsPerDay(currentStock, comingPoQty, ads);
            const daysRemaining = ads > 0 ? Math.floor(available / ads) : null;
            const hasSalesHistory = ads > 0;
            let priority = "Low";
            if (hasSalesHistory && suggestedQty > 0) {
                const isCritical = daysRemaining !== null && daysRemaining <= (leadTime + SAFETY_BUFFER_DAYS);
                priority = isCritical ? "High" : daysRemaining < 30 ? "Medium" : "Low";
            }

            const aiInsightsFinal = slim
                ? slimBranchAiPatch(rec, {
                    currentStock,
                    comingPoQty,
                    suggestedQty,
                    ads,
                    daysRemaining,
                    priority,
                    lookbackDays,
                })
                : buildReplenishmentInsight({
                    itemId: rec.itemId,
                    description: rec.description,
                    currentStock,
                    suggestedQty,
                    priorityLevel: priority,
                    branchId: dest,
                    ads,
                    daysRemaining: daysRemaining ?? 0,
                    leadTimeDays: leadTime,
                    vendorId,
                    hasSalesHistory,
                    qtySold90,
                    targetStock,
                    salesScope: rec.salesScope || rec.aiInsights?.salesScope || "branch",
                    lookbackDays,
                });

            return {
                ...rec,
                currentStock,
                comingPO: comingPoQty,
                suggestedQty,
                priorityLevel: priority,
                restockSource: aiInsightsFinal.restockSource || rec.restockSource,
                stockSource: "forecast_item_stock",
                aiInsights: slim
                    ? aiInsightsFinal
                    : {
                        ...aiInsightsFinal,
                        salesVelocity: ads,
                        daysRemaining: daysRemaining ?? aiInsightsFinal.daysRemaining,
                        leadTimeDays: leadTime,
                    },
            };
        });
    }

    // Accurate retail demand via bulk SQL (not stale cache ads). Avoids N-branch sales maps.
    const [comingPoMap, onHandMap, demand] = await Promise.all([
        MySqlService.getOpenPoQtyByItem({ warehouseId: dest }),
        MySqlService.getBranchOnHandMap({ branch: dest, companyId }),
        resolveMainBranchDemand(companyId),
    ]);

    return (recommendations || []).map((rec) => {
        const key = normalizeInvKey(rec.itemId);
        const comingPoQty = Number(comingPoMap.get(key)) || 0;
        const mainInventory = Number(onHandMap.get(key)) || 0;
        const rolledDemand = Number(demand.qtyByItem.get(key)) || 0;
        const cachedDemand = Math.max(
            Number(rec.totalBranchReplenishment) || 0,
            Number(rec.branchOrderQty) || 0
        );
        const totalBranchReplenishment = Math.max(rolledDemand, cachedDemand);
        const branchesNeeding = Number(demand.branchesNeedingByItem.get(key)) || 0;
        const lookbackDays = Number(rec.lookbackDays) || demand.lookbackDays || SALES_LOOKBACK_DAYS;
        // MAIN shelf target uses summed retail-branch sales (same basis as branch repl),
        // NOT company-wide network invoices which inflate vendor PO (e.g. M15 717 vs 1187).
        const retailSales = demand.salesByItem.get(key);
        const mainQtySold90 =
            Number(retailSales?.qty_sold) ||
            Number(rec.qtySold90) ||
            0;
        const leadTime = Number(rec.leadTimeDays ?? rec.aiInsights?.leadTimeDays) || 0;
        const vendorId = rec.vendorId || null;

        const metrics = computeMainRowMetrics({
            mainInventory,
            totalBranchReplenishment,
            mainQtySold90,
            lookbackDays,
            comingPoQty,
            leadTimeDays: leadTime,
        });

        const aiInsightsFinal = slim
            ? slimMainAiPatch(rec, metrics, {
                mainInventory,
                comingPoQty,
                totalBranchReplenishment,
                leadTime,
            })
            : buildReplenishmentInsight({
                itemId: rec.itemId,
                description: rec.description,
                currentStock: mainInventory,
                suggestedQty: metrics.suggestedQty,
                priorityLevel: metrics.priority,
                branchId: "MAIN",
                ads: metrics.mainAds,
                daysRemaining: metrics.daysRemaining ?? 0,
                leadTimeDays: leadTime,
                vendorId,
                hasSalesHistory: metrics.hasSalesHistory,
                qtySold90: metrics.qtySold90,
                targetStock: metrics.mainTargetStock,
                salesScope: rec.salesScope || rec.aiInsights?.salesScope || "network",
                lookbackDays,
                mainWarehouseContext: {
                    branchOrderQty: totalBranchReplenishment,
                    comingPO: comingPoQty,
                    totalBranchReplenishment,
                    branchesNeeding,
                    vendorShortfall: metrics.vendorShortfall,
                    vendorOrderQty: metrics.vendorOrderQty,
                    mainTargetStock: metrics.mainTargetStock,
                    mainShelfGap: metrics.mainShelfGap,
                },
            });

        return {
            ...rec,
            comingPO: comingPoQty,
            suggestedQty: metrics.suggestedQty,
            currentStock: mainInventory,
            mainInventory,
            totalBranchReplenishment,
            branchOrderQty: totalBranchReplenishment,
            branchesNeeding,
            priorityLevel: metrics.priority,
            stockSource: "forecast_item_stock",
            isMainWarehouseView: true,
            qtySold90: metrics.qtySold90,
            vendorOrderQty: metrics.vendorOrderQty,
            mainTargetStock: metrics.mainTargetStock,
            aiInsights: slim
                ? aiInsightsFinal
                : {
                    ...aiInsightsFinal,
                    salesVelocity: metrics.mainAds,
                    daysRemaining: metrics.daysRemaining ?? aiInsightsFinal.daysRemaining,
                    leadTimeDays: leadTime,
                },
        };
    });
}

async function fetchBranchSalesMap(branch, companyId, lookbackDays) {
    const result = await MySqlService.getAccurateReplenishmentSalesMap({ branch, companyId, lookbackDays });
    return {
        map: result.map,
        salesScope: result.salesScope || (branch ? "branch" : "network"),
        lookbackDays: result.lookbackDays || SALES_LOOKBACK_DAYS,
        salesMode: result.salesMode || "gross",
    };
}

async function computeBranchRecommendations(branchId, companyId, vendorMap, leadTimeMap, startRecId = 2000) {
    const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branchId);
    const [{ map: salesMap, salesScope, lookbackDays }, comingPoMap] = await Promise.all([
        fetchBranchSalesMap(branchId, effectiveCompanyId),
        MySqlService.getOpenPoQtyByItem({ warehouseId: branchId }),
    ]);
    const items = await MySqlService.getReplenishmentItems({
        branch: branchId,
        companyId: effectiveCompanyId,
        salesMap,
    });

    const recommendations = [];
    let recId = startRecId;
    for (const item of items) {
        item.salesScope = salesScope;
        const key = (item.inventoryId || "").toUpperCase().trim();
        const rec = buildRecommendation(
            item,
            branchId,
            vendorMap,
            leadTimeMap,
            recId++,
            lookbackDays,
            comingPoMap.get(key) || 0
        );
        rec.salesScope = item.salesScope || salesScope;
        recommendations.push(rec);
    }
    return recommendations;
}

async function aggregateBranchOrderQty(companyId) {
    const branchList = filterReplenishmentBranchList(
        await MySqlService.getReplenishmentBranches(companyId)
    );
    const retailBranches = branchList
        .map((b) => b.SiteID || b.branch_id || "")
        .filter((id) => id && String(id).trim().toUpperCase() !== "MAIN" && !isExcludedBranchAlias(id));

    const demand = await resolveMainBranchDemand(companyId);
    return {
        qtyByItem: demand.qtyByItem,
        salesByItem: demand.salesByItem,
        branchesNeedingByItem: demand.branchesNeedingByItem,
        retailBranches,
    };
}

export async function computeReplenishmentForBranch(branch, companyId = "main") {
    const isMainWarehouse = String(branch).trim().toUpperCase() === "MAIN";
    const effectiveCompanyId = resolveCompanyIdForBranch(companyId, branch);
    const salesWindow = await MySqlService.getReplenishmentSalesWindow();

    // Parallelize independent lookups for cold starts
    const [vendorMap, leadTimeMap, salesBundle] = await Promise.all([
        MySqlService.getItemVendorMap(),
        MySqlService.getEffectiveVendorLeadTimes(),
        fetchBranchSalesMap(isMainWarehouse ? "" : branch, effectiveCompanyId, salesWindow.days),
    ]);

    let recommendations = [];
    let salesScope = salesBundle.salesScope || (isMainWarehouse ? "network" : "branch");
    let lookbackDays = salesBundle.lookbackDays || SALES_LOOKBACK_DAYS;
    let salesMode = salesBundle.salesMode || "gross";
    const salesMap = salesBundle.map;

    if (isMainWarehouse) {
        // MAIN Sells / day = sum of retail-branch velocities (same branches as Total Branch Repl),
        // not a separate network invoice rollup that can disagree with branch planning.
        const [{ qtyByItem: branchQtyMap, salesByItem, branchesNeedingByItem }, comingPoMap, items] = await Promise.all([
            aggregateBranchOrderQty(companyId),
            MySqlService.getOpenPoQtyByItem({ warehouseId: "MAIN" }),
            MySqlService.getReplenishmentItems({ branch, companyId: effectiveCompanyId, salesMap }),
        ]);

        lookbackDays = salesWindow.days;
        salesScope = "network";
        salesMode = "live-branch-demand";

        const withMainSales = (item) => {
            const key = (item.inventoryId || "").toUpperCase().replace(/\s+/g, "").trim();
            const rolled = salesByItem.get(key);
            const qtySold =
                Number(rolled?.qty_sold) ||
                Number(item.totalQtySold) ||
                0;
            return {
                ...item,
                totalQtySold: qtySold,
                salesScope: "network",
            };
        };

        let recId = 2000;
        for (const item of items) {
            const key = (item.inventoryId || "").toUpperCase().replace(/\s+/g, "").trim();
            const branchOrderQty = branchQtyMap.get(key) || 0;
            const rec = buildMainRecommendation({
                item: withMainSales(item),
                branchOrderQty,
                comingPO: comingPoMap.get(key) || 0,
                vendorMap,
                leadTimeMap,
                recId: recId++,
                lookbackDays,
                branchesNeeding: branchesNeedingByItem.get(key) || 0,
            });
            if (rec) recommendations.push(rec);
        }

        const missingKeys = [...branchQtyMap.keys()].filter(
            (key) => !recommendations.some((r) => (r.itemId || "").toUpperCase().replace(/\s+/g, "").trim() === key)
        );
        if (missingKeys.length > 0) {
            const catalogRows = await MySqlService.getCatalogItemsByIds(missingKeys, companyId);
            const catalogByKey = new Map(
                catalogRows.map((c) => [(c.inventoryId || "").toUpperCase().replace(/\s+/g, "").trim(), c])
            );
            for (const key of missingKeys) {
                const branchOrderQty = branchQtyMap.get(key) || 0;
                if (branchOrderQty <= 0) continue;
                const cat = catalogByKey.get(key);
                const rolled = salesByItem.get(key);
                const qtySold =
                    Number(rolled?.qty_sold) ||
                    Number(salesMap.get(key)?.qty_sold) ||
                    0;
                const rec = buildMainRecommendation({
                    item: {
                        inventoryId: cat?.inventoryId || key,
                        description: cat?.description || "",
                        itemClass: cat?.itemClass || "",
                        totalOnHand: 0,
                        totalQtySold: qtySold,
                        salesScope: "network",
                    },
                    branchOrderQty,
                    comingPO: comingPoMap.get(key) || 0,
                    vendorMap,
                    leadTimeMap,
                    recId: recId++,
                    lookbackDays,
                    branchesNeeding: branchesNeedingByItem.get(key) || 0,
                });
                if (rec) recommendations.push(rec);
            }
        }
    } else {
        // Branch view: Coming PO = open POs destined for this branch only
        const [items, comingPoMap] = await Promise.all([
            MySqlService.getReplenishmentItems({
                branch,
                companyId: effectiveCompanyId,
                salesMap,
            }),
            MySqlService.getOpenPoQtyByItem({ warehouseId: branch }),
        ]);
        let recId = 2000;
        for (const item of items) {
            item.salesScope = salesScope;
            const key = (item.inventoryId || "").toUpperCase().trim();
            const rec = buildRecommendation(
                item,
                branch,
                vendorMap,
                leadTimeMap,
                recId++,
                lookbackDays,
                comingPoMap.get(key) || 0
            );
            rec.salesScope = item.salesScope || salesScope;
            recommendations.push(rec);
        }
    }

    const sorted = recommendations.sort((a, b) => {
        const pMap = { High: 3, Medium: 2, Low: 1 };
        if (pMap[b.priorityLevel] !== pMap[a.priorityLevel]) {
            return pMap[b.priorityLevel] - pMap[a.priorityLevel];
        }
        return b.suggestedQty - a.suggestedQty;
    });

    return {
        recommendations: sorted,
        brief: buildBranchBrief(sorted, branch),
        meta: {
            branch,
            generatedAt: new Date().toISOString(),
            itemCount: sorted.length,
            targetDaysOfCover: TARGET_DAYS_OF_COVER,
            stockSource: "mysql",
            salesSource: "mysql",
            salesMode,
            salesScope,
            salesLookbackDays: lookbackDays,
            isMainWarehouseView: isMainWarehouse,
            salesLogicVersion: REPLENISHMENT_SALES_LOGIC_VERSION,
        },
    };
}

export async function rebuildAllReplenishmentCache(companyId = "main") {
    const branchList = filterReplenishmentBranchList(
        await MySqlService.getReplenishmentBranches(companyId)
    );
    const branches = branchList
        .map((b) => b.SiteID || b.branch_id || "")
        .filter((id) => id && String(id).trim().toUpperCase() !== "MAIN" && !isExcludedBranchAlias(id));

    const uniqueBranches = [...new Set(branches), "MAIN"];
    let totalRows = 0;

    for (const branchId of uniqueBranches) {
        const payload = await computeReplenishmentForBranch(branchId, companyId);
        const cacheCompanyId = resolveCompanyIdForBranch(companyId, branchId);
        const count = await MySqlService.upsertReplenishmentCache(cacheCompanyId, branchId, payload.recommendations);
        totalRows += count;
    }

    return { branches: uniqueBranches.length, totalRows };
}

export { TARGET_DAYS_OF_COVER, SALES_LOOKBACK_DAYS };
