import { SALES_LOOKBACK_DAYS } from "@/lib/sales-velocity";

const TARGET_DAYS_OF_COVER = 60;
const SAFETY_BUFFER_DAYS = 7;

function urgencyFromPriority(priority) {
    if (priority === "High") return "critical";
    if (priority === "Medium") return "warning";
    return "normal";
}

function formatUnits(n) {
    const val = Number(n);
    if (Number.isNaN(val)) return String(n);
    return val % 1 === 0 ? val.toLocaleString() : val.toFixed(1);
}

/**
 * Build plain-language AI insights for one replenishment row.
 */
export function buildReplenishmentInsight({
    itemId,
    description,
    currentStock,
    suggestedQty,
    priorityLevel,
    branchId,
    ads = 0,
    daysRemaining = null,
    leadTimeDays = 0,
    vendorId = null,
    hasSalesHistory = true,
    qtySold90 = 0,
    targetStock = 0,
    salesScope = "branch",
    lookbackDays = SALES_LOOKBACK_DAYS,
    mainWarehouseContext = null,
    comingPoQty = 0,
}) {
    const isMain = branchId === "MAIN";
    const restockSource = isMain ? "External Vendor (Purchase Order)" : "MAIN Warehouse (Stock Transfer)";
    const urgency = urgencyFromPriority(priorityLevel);
    const comingPo = Number(comingPoQty) || Number(mainWarehouseContext?.comingPO) || 0;

    let headline;
    let summary;
    let whatToDo;
    let stockoutRisk;

    if (!hasSalesHistory) {
        headline = "Low stock, no recent sales";
        summary = `Only ${formatUnits(currentStock)} on hand and no sales in the last ${lookbackDays} days.`;
        whatToDo = isMain
            ? `Optional: order ${formatUnits(suggestedQty)} from vendor if you want to keep this on the shelf.`
            : `Optional: transfer ${formatUnits(suggestedQty)} from MAIN if this branch should carry it.`;
        stockoutRisk = "Low";
    } else if (suggestedQty < 0) {
        headline = isMain ? "Surplus at MAIN" : "Surplus at branch";
        summary = isMain
            ? `Sells ${formatUnits(ads)}/day. MAIN has ${formatUnits(currentStock)} on hand plus ${formatUnits(comingPo)} incoming — ${formatUnits(Math.abs(suggestedQty))} above Sells/day.`
            : `Sells ${formatUnits(ads)}/day. Stock ${formatUnits(currentStock)} + Coming PO ${formatUnits(comingPo)} exceed Sells/day by ${formatUnits(Math.abs(suggestedQty))}.`;
        whatToDo = isMain
            ? `Surplus of ${formatUnits(Math.abs(suggestedQty))} vs Sells/day — no vendor order needed from MAIN.`
            : "No transfer needed — stock + Coming PO exceed Sells/day (surplus).";
        stockoutRisk = "Low";
    } else if (priorityLevel === "High" && suggestedQty > 0) {
        headline = `About ${daysRemaining} days of stock left`;
        summary = `Sells ${formatUnits(ads)}/day. Only ${formatUnits(currentStock)} left — may run out soon.`;
        whatToDo = isMain
            ? `Order ${formatUnits(suggestedQty)} from vendor${vendorId ? ` ${vendorId}` : ""} today.`
            : `Transfer ${formatUnits(suggestedQty)} from MAIN to ${branchId} today.`;
        stockoutRisk = "Critical";
    } else if (priorityLevel === "Medium" && suggestedQty > 0) {
        headline = `About ${daysRemaining} days of stock left`;
        summary = `Sells ${formatUnits(ads)}/day. Stock lasts ~${daysRemaining} days — order before it gets low.`;
        whatToDo = isMain
            ? `Order ${formatUnits(suggestedQty)} from vendor within 1–2 weeks.`
            : `Transfer ${formatUnits(suggestedQty)} from MAIN within 1–2 weeks.`;
        stockoutRisk = "High";
    } else if (
        isMain &&
        Number(mainWarehouseContext?.vendorOrderQty) === 0 &&
        Number(mainWarehouseContext?.totalBranchReplenishment) > 0 &&
        suggestedQty > 0
    ) {
        headline = `${daysRemaining} days of stock left at MAIN`;
        summary = `Branches still need ${formatUnits(mainWarehouseContext.totalBranchReplenishment)} units; MAIN has ${formatUnits(currentStock)} on hand — cover with transfers, not a vendor PO.`;
        whatToDo = `Plan transfers totaling ${formatUnits(suggestedQty)} from MAIN to branches — no vendor order needed.`;
        stockoutRisk = "Low";
    } else if (suggestedQty === 0) {
        headline = hasSalesHistory ? `${daysRemaining} days of stock left` : "No order needed";
        summary = hasSalesHistory
            ? `Sells ${formatUnits(ads)}/day with ${formatUnits(currentStock)} on hand — stock is sufficient.`
            : `Only ${formatUnits(currentStock)} on hand and no recent sales.`;
        whatToDo = isMain
            ? (mainWarehouseContext?.branchOrderQty > 0
                ? "No vendor order needed — MAIN stock and incoming PO cover branch demand."
                : "No vendor order needed — stock levels are sufficient.")
            : "No transfer needed — stock is sufficient for now.";
        stockoutRisk = "Low";
    } else {
        headline = `${daysRemaining} days of stock left`;
        summary = `Sells ${formatUnits(ads)}/day with ${formatUnits(currentStock)} on hand.`;
        whatToDo = isMain
            ? `Add ${formatUnits(suggestedQty)} to your next vendor order.`
            : `Add ${formatUnits(suggestedQty)} to your next transfer from MAIN.`;
        stockoutRisk = "Moderate";
    }

    const metrics = hasSalesHistory
        ? [
              { label: "On hand", value: `${formatUnits(currentStock)} units`, hint: "Current branch stock" },
              { label: "Daily sales", value: `${formatUnits(ads)} / day`, hint: `${lookbackDays}-day average` },
              { label: "Days left", value: `${daysRemaining} days`, hint: "At current sales rate" },
              { label: "Order qty", value: `${suggestedQty < 0 ? "" : "+"}${formatUnits(suggestedQty)}`, hint: "Sells/day − (stock + Coming PO)" },
          ]
        : [
              { label: "On hand", value: `${formatUnits(currentStock)} units`, hint: "Current branch stock" },
              { label: "90-day sales", value: "0 units", hint: "No recorded movement" },
              { label: "Order qty", value: `+${formatUnits(suggestedQty)}`, hint: "Minimum shelf buffer" },
          ];

    if (leadTimeDays > 0 && hasSalesHistory) {
        metrics.push({ label: "Lead time", value: `${leadTimeDays} days`, hint: "Vendor delivery estimate" });
    }

    // Skip heavy step narratives for zero-order rows (major compute win)
    const needsFullSteps =
        priorityLevel === "High" ||
        priorityLevel === "Medium" ||
        suggestedQty > 0 ||
        suggestedQty < 0;
    const howItWorks = needsFullSteps
        ? buildHowItWorks({
            branchId,
            hasSalesHistory,
            currentStock,
            qtySold90,
            ads,
            daysRemaining,
            targetStock,
            suggestedQty,
            priorityLevel,
            leadTimeDays,
            vendorId,
            salesScope,
            lookbackDays,
            mainWarehouseContext,
            comingPoQty: comingPo,
        })
        : {
            preview: hasSalesHistory
                ? `${formatUnits(currentStock)} on hand · ${formatUnits(ads)}/day · no order needed`
                : `${formatUnits(currentStock)} on hand · no recent sales · no order needed`,
            steps: [],
        };

    return {
        headline,
        summary,
        whatToDo,
        stockoutRisk,
        restockSource,
        urgency,
        metrics: needsFullSteps ? metrics : metrics.slice(0, 3),
        howItWorks,
        salesVelocity: ads.toFixed(2),
        daysRemaining: hasSalesHistory ? daysRemaining : "N/A",
        leadTimeDays,
        vendorId,
        targetDays: TARGET_DAYS_OF_COVER,
        formula: hasSalesHistory
            ? (isMain
                ? `Order qty = Total branch repl. − (Main inventory + Coming PO)`
                : `Order qty = Sells/day − (Branch stock + Coming PO)`)
            : "Minimum restock for active items with no recent sales",
        message: summary,
    };
}

/**
 * Plain-language AI explanation of how each number was produced.
 */
function buildHowItWorks({
    branchId,
    hasSalesHistory,
    currentStock,
    qtySold90,
    ads,
    daysRemaining,
    targetStock,
    suggestedQty,
    priorityLevel,
    leadTimeDays,
    vendorId,
    salesScope = "branch",
    lookbackDays = SALES_LOOKBACK_DAYS,
    mainWarehouseContext = null,
    comingPoQty = 0,
}) {
    const isMain = branchId === "MAIN";
    const isMainWarehouseView = isMain && mainWarehouseContext;
    const comingPo = Number(comingPoQty) || Number(mainWarehouseContext?.comingPO) || 0;
    const salesScopeLabel =
        salesScope === "network"
            ? `all retail replenishment branches combined (sum of branch Sells / day, last ${lookbackDays} days)`
            : salesScope === "catalog-network"
            ? `network invoices for items stocked at ${branchId} (last ${lookbackDays} days; branch had no sales)`
            : salesScope === "parent-pos"
            ? `parent POS branch invoices for warehouse ${branchId} (last ${lookbackDays} days; matches Acumatica sales posting)`
            : salesScope === "warehouse"
            ? `invoices posted to warehouse site ${branchId} only (last ${lookbackDays} days; not full parent POS)`
            : `branch ${branchId} (last ${lookbackDays} days)`;

    const steps = [];

    steps.push({
        title: "Why this item appears",
        text: isMainWarehouseView
            ? `Branches (excluding MAIN) need ${formatUnits(mainWarehouseContext.totalBranchReplenishment)} units combined. MAIN has ${formatUnits(currentStock)} on hand and ${formatUnits(mainWarehouseContext.comingPO)} on open purchase orders.`
            : hasSalesHistory
            ? isMain
                ? `This product sells across the network and MAIN warehouse stock is below the ${TARGET_DAYS_OF_COVER}-day target based on company-wide demand.`
                : `This product has sales at ${branchId} and needs restocking to keep about ${TARGET_DAYS_OF_COVER} days of supply on hand.`
            : `This is an active item with low stock (${formatUnits(currentStock)} units) and no sales in the last ${lookbackDays} days. It is shown as an optional minimum shelf buffer.`,
    });

    steps.push({
        title: "Data sources",
        text: `Stock on hand is the quantity at branch ${branchId} (synced inventory). Sales velocity uses ${salesScopeLabel} from the database (credit memos subtracted).${vendorId ? ` Vendor ${vendorId} is linked to this item for lead-time checks.` : ""}`,
    });

    if (hasSalesHistory) {
        steps.push({
            title: "Sells per day",
            text: `${formatUnits(qtySold90)} net units sold in ${lookbackDays} days ÷ ${lookbackDays} = ${ads.toFixed(2)} units per day (average daily sales).`,
        });
        steps.push({
            title: "Days left",
            text: `${formatUnits(currentStock)} in stock ÷ ${ads.toFixed(2)} per day ≈ ${daysRemaining} day(s) before stock may run out at the current sales rate.`,
        });
        steps.push({
            title: "Order quantity",
            text: isMainWarehouseView
                ? `A = Main inventory ${formatUnits(currentStock)} + Coming PO ${formatUnits(mainWarehouseContext.comingPO)} = ${formatUnits(currentStock + (Number(mainWarehouseContext.comingPO) || 0))}. Order qty = Sells/day ${formatUnits(ads)} − A = ${formatUnits(suggestedQty)} units.`
                : `A = stock ${formatUnits(currentStock)} + Coming PO ${formatUnits(comingPo)} = ${formatUnits(currentStock + comingPo)}. Order qty = Sells/day ${formatUnits(ads)} − A = ${formatUnits(suggestedQty)} units (a+b=c, d−c=e).`,
        });

        let statusText;
        if (suggestedQty < 0) {
            statusText = "Marked OK because stock + Coming PO already cover / exceed Sells/day (surplus — no transfer needed).";
        } else if (priorityLevel === "High") {
            statusText = `Marked Urgent because ${daysRemaining} day(s) left is within the reorder window (vendor lead time ${leadTimeDays} day(s) + ${SAFETY_BUFFER_DAYS}-day safety buffer). Order before stock runs out.`;
        } else if (priorityLevel === "Medium") {
            statusText = `Marked "Soon" because Order qty is positive and stock lasts less than 30 days.`;
        } else if (suggestedQty > 0) {
            statusText = `Marked "Low" because Order qty is positive but stock lasts 30+ days.`;
        } else {
            statusText = "Marked OK because Order qty is 0 — no transfer needed.";
        }
        steps.push({ title: "Status meaning", text: statusText });
    } else {
        steps.push({
            title: "Order quantity",
            text: `No sales trend to calculate from, so a fixed buffer of ${formatUnits(suggestedQty)} units is suggested to keep the item available on the shelf.`,
        });
        steps.push({
            title: "Status meaning",
            text: `Marked "Low" — optional restock only. Review if this branch should still carry the item.`,
        });
    }

    steps.push({
        title: "How to fulfill",
        text: isMain
            ? "At MAIN, restock by creating a Purchase Order to your vendor."
            : `At ${branchId}, restock by requesting a stock transfer from the MAIN warehouse (not directly from vendors).`,
    });

    const preview = isMainWarehouseView
        ? `Branches need ${formatUnits(mainWarehouseContext.totalBranchReplenishment)} units; MAIN has ${formatUnits(currentStock)} + ${formatUnits(mainWarehouseContext.comingPO)} incoming.`
        : hasSalesHistory
        ? salesScope === "network"
            ? `Based on ${formatUnits(qtySold90)} units sold across retail branches in ${lookbackDays} days (sum of branch Sells / day × ${lookbackDays}); stock checked at MAIN.`
            : salesScope === "catalog-network"
            ? `Based on ${formatUnits(qtySold90)} sold network-wide for this branch catalog in ${lookbackDays} days.`
            : salesScope === "parent-pos"
            ? `Based on ${formatUnits(qtySold90)} net sold in ${lookbackDays} days at the parent POS branch for warehouse ${branchId}.`
            : salesScope === "warehouse"
            ? `Based on ${formatUnits(qtySold90)} net sold in ${lookbackDays} days at warehouse ${branchId} (site invoices only).`
            : `Based on ${formatUnits(qtySold90)} net sold in ${lookbackDays} days at ${branchId}.`
        : `Low stock, no recent sales at ${branchId}.`;

    return { preview, steps };
}

/**
 * Build a branch-level briefing for employees.
 */
export function buildBranchBrief(recommendations, branchId) {
    const isMain = branchId === "MAIN";
    const urgent = recommendations.filter((r) => r.priorityLevel === "High");
    const medium = recommendations.filter((r) => r.priorityLevel === "Medium");
    const totalUnits = recommendations.reduce((s, r) => s + (r.suggestedQty || 0), 0);

    if (recommendations.length === 0) {
        return {
            title: "All good — nothing to order",
            body: "",
            action: isMain
                ? "MAIN can cover all branch replenishment needs right now."
                : "No transfers from MAIN needed right now.",
        };
    }

    if (urgent.length > 0) {
        return {
            title: `${urgent.length} urgent item(s) at ${branchId}`,
            body: "",
            action: isMain
                ? `Order the urgent items first (${totalUnits.toLocaleString()} units needed for branch replenishment).`
                : `Transfer urgent items from MAIN first (${totalUnits.toLocaleString()} units total suggested).`,
        };
    }

    return {
        title: `${recommendations.length} item(s) to restock at ${branchId}`,
        body: "",
        action: isMain
            ? `Add these to your next vendor order (${totalUnits.toLocaleString()} units for branch replenishment).`
            : `Add these to your next transfer from MAIN (${totalUnits.toLocaleString()} units total).`,
    };
}

export { TARGET_DAYS_OF_COVER, SAFETY_BUFFER_DAYS, SALES_LOOKBACK_DAYS };
