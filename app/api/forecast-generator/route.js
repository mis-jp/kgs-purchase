import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";
import { getActiveCompanyFromRequest, getSessionFromRequest } from "@/lib/session-store";
import {
    constrainBranchParam,
    getRequestBranchAccess,
    hasNoBranchAccess,
    emptyRestrictedPayload,
} from "@/lib/branch-access";
import { isExcludedBranchAlias } from "@/lib/companies";
import {
    computeForecastFields,
    forecastBranchKey,
    formatMonthRangeLabel,
    getDefaultForecastPeriods,
    isValidYmd,
    rangeFromMonthInputs,
} from "@/lib/forecast-generator";
import { logUserActivity, summarizeActivityDetail } from "@/lib/activity-log";
import { getCached } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function resolvePeriodRange(fromMonth, toMonth, fallbackStart, fallbackEnd) {
    const fromInputs = rangeFromMonthInputs(fromMonth, toMonth);
    if (fromInputs) return fromInputs;
    if (isValidYmd(fallbackStart) && isValidYmd(fallbackEnd)) {
        return { start: fallbackStart, end: fallbackEnd };
    }
    return null;
}

function mapRow(raw) {
    const computed = computeForecastFields({
        inventoryQty: raw.inventoryQty,
        comingPo: raw.comingPo,
        last3MonthsQty: raw.last3MonthsQty,
        lastYearQty: raw.lastYearQty,
        srp: raw.srp,
        estimateSales: raw.estimateSales,
        bufferInventory: raw.bufferInventory,
        targetSales: raw.targetSales,
    });
    return {
        inventoryId: raw.inventoryId,
        itemClass: raw.itemClass || "",
        itemName: raw.itemName || "—",
        srp: Number(raw.srp) || 0,
        inventoryQty: Math.abs(Number(raw.inventoryQty) || 0),
        comingPo: Math.max(0, Number(raw.comingPo) || 0),
        last3MonthsQty: Math.max(0, Number(raw.last3MonthsQty) || 0),
        lastYearQty: Math.max(0, Number(raw.lastYearQty) || 0),
        ...computed,
    };
}

function forecastQueryKey({ companyId, branch, search, itemClass, last3Start, last3End, lastYearStart, lastYearEnd, page, pageSize }) {
    return JSON.stringify({
        companyId,
        branch: branch || "",
        search: search || "",
        itemClass: itemClass || "",
        last3Start: last3Start || "",
        last3End: last3End || "",
        lastYearStart: lastYearStart || "",
        lastYearEnd: lastYearEnd || "",
        page: page || 1,
        pageSize: pageSize || 10,
    });
}

export async function GET(request) {
    try {
        const cookie = getSessionFromRequest(request);
        if (!cookie) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json(emptyRestrictedPayload({ months: [], itemClasses: [] }), NO_STORE);
        }

        const { searchParams } = new URL(request.url);
        const defaults = getDefaultForecastPeriods();
        const branch = constrainBranchParam(access, searchParams.get("branch") || "");
        if (branch && isExcludedBranchAlias(branch)) {
            return NextResponse.json({
                data: [],
                metrics: emptyMetrics(),
                periods: periodsPayload(defaults),
                itemClasses: [],
                pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
            }, NO_STORE);
        }

        const last3 = resolvePeriodRange(
            searchParams.get("last3From"),
            searchParams.get("last3To"),
            searchParams.get("last3Start"),
            searchParams.get("last3End"),
        ) || { start: defaults.last3Start, end: defaults.last3End };

        const lastYear = resolvePeriodRange(
            searchParams.get("lyFrom"),
            searchParams.get("lyTo"),
            searchParams.get("lyStart"),
            searchParams.get("lyEnd"),
        ) || { start: defaults.lastYearStart, end: defaults.lastYearEnd };

        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
        // UI list stays small; CSV export needs the full filtered set (USER + admin).
        const isExport = searchParams.get("export") === "1";
        const isManualRefresh = searchParams.get("refresh") === "1";
        const pageSizeRaw = Math.max(1, parseInt(searchParams.get("pageSize") || "10", 10) || 10);
        const pageSize = isExport
            ? Math.min(50_000, pageSizeRaw)
            : Math.min(100, pageSizeRaw);
        const search = searchParams.get("search") || "";
        const itemClass = searchParams.get("itemClass") || "";
        const companyId = getActiveCompanyFromRequest(request) || "main";

        // Forecast page reads from MySQL only. Acumatica-to-MySQL sync happens in the
        // background via the application-level sync API so page loads stay fast.
        const salesGaps = await getCached(
            `forecast:salesGaps:${JSON.stringify({ last3Start: last3.start, last3End: last3.end, lastYearStart: lastYear.start, lastYearEnd: lastYear.end })}`,
            30_000,
            () => MySqlService.listMissingSalesInvoiceMonths({
                ranges: [
                    { start: last3.start, end: last3.end },
                    { start: lastYear.start, end: lastYear.end },
                ],
                branch: "",
            }).catch(() => [])
        );

        const queryKey = forecastQueryKey({
            companyId,
            branch,
            search,
            itemClass,
            last3Start: last3.start,
            last3End: last3.end,
            lastYearStart: lastYear.start,
            lastYearEnd: lastYear.end,
            page,
            pageSize,
        });
        const result = await getCached(
            `forecast:rows:${queryKey}`,
            15_000,
            () => MySqlService.getForecastGenerator({
                companyId,
                branch,
                search,
                itemClass,
                last3Start: last3.start,
                last3End: last3.end,
                lastYearStart: lastYear.start,
                lastYearEnd: lastYear.end,
                page,
                pageSize,
            })
        );

        const data = (result.rows || []).map(mapRow);
        const totalItems = result.totalItems || 0;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

        return NextResponse.json({
            data,
            metrics: result.metrics || emptyMetrics(),
            itemClasses: result.itemClasses || [],
            classSummary: result.classSummary || [],
            periods: {
                last3Start: last3.start,
                last3End: last3.end,
                lastYearStart: lastYear.start,
                lastYearEnd: lastYear.end,
                last3Label: formatMonthRangeLabel(last3.start, last3.end),
                lastYearLabel: formatMonthRangeLabel(lastYear.start, lastYear.end),
                forecastQuarterLabel: defaults.forecastQuarterLabel,
            },
            pagination: {
                page: Math.min(page, totalPages),
                pageSize,
                totalItems,
                totalPages,
            },
            source: "mysql",
            salesGaps,
        }, NO_STORE);
    } catch (err) {
        console.error("[Forecast Generator GET]", err);
        return NextResponse.json({ message: err.message || "Failed to load forecast" }, { status: 500 });
    }
}

export async function POST(request) {
    try {
        const cookie = getSessionFromRequest(request);
        if (!cookie) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json({ message: "No branch access" }, { status: 403 });
        }

        const body = await request.json().catch(() => ({}));
        const inventoryId = String(body.inventoryId || "").trim();
        if (!inventoryId) {
            return NextResponse.json({ message: "Inventory ID is required" }, { status: 400 });
        }

        const branch = constrainBranchParam(access, body.branch || "");
        const companyId = getActiveCompanyFromRequest(request) || "main";
        const branchKey = forecastBranchKey(branch);

        const estimateSales = body.estimateSales === "" || body.estimateSales == null
            ? null
            : Number(body.estimateSales);
        const bufferInventory = body.bufferInventory === "" || body.bufferInventory == null
            ? null
            : Number(body.bufferInventory);
        const targetSales = body.targetSales === "" || body.targetSales == null
            ? null
            : Number(body.targetSales);

        if (estimateSales != null && (!Number.isFinite(estimateSales) || estimateSales < 0)) {
            return NextResponse.json({ message: "Estimate Sales must be a positive number" }, { status: 400 });
        }
        if (bufferInventory != null && (!Number.isFinite(bufferInventory) || bufferInventory < 0)) {
            return NextResponse.json({ message: "Buffer Inventory must be a positive number" }, { status: 400 });
        }
        if (targetSales != null && (!Number.isFinite(targetSales) || targetSales < 0)) {
            return NextResponse.json({ message: "Target Sales must be a positive number" }, { status: 400 });
        }

        const saved = await MySqlService.upsertForecastGeneratorInput({
            companyId,
            branchId: branchKey,
            inventoryId,
            estimateSales,
            bufferInventory,
            targetSales,
            updatedBy: access?.user?.id || null,
        });

        if (!saved) {
            return NextResponse.json({ message: "Failed to save forecast input" }, { status: 500 });
        }

        await logUserActivity(request, {
            action: "forecast_input_save",
            moduleName: "forecast-generator",
            refId: `${branchKey}|${inventoryId}`,
            fieldKey: targetSales != null ? "targetSales" : (estimateSales != null ? "estimateSales" : "bufferInventory"),
            detail: summarizeActivityDetail({
                estimateSales,
                bufferInventory,
                targetSales,
            }),
        });

        return NextResponse.json({
            ok: true,
            inventoryId,
            branchId: branchKey,
            estimateSales,
            bufferInventory,
            targetSales,
        }, NO_STORE);
    } catch (err) {
        console.error("[Forecast Generator POST]", err);
        return NextResponse.json({ message: err.message || "Failed to save" }, { status: 500 });
    }
}

function emptyMetrics() {
    return {
        productCount: 0,
        inventoryQty: 0,
        last3MonthsQty: 0,
        lastYearQty: 0,
        comingPo: 0,
        bufferAmount: 0,
        needPoCount: 0,
        estimatedSalesAmount: 0,
    };
}

function periodsPayload(defaults) {
    return {
        last3Start: defaults.last3Start,
        last3End: defaults.last3End,
        lastYearStart: defaults.lastYearStart,
        lastYearEnd: defaults.lastYearEnd,
        last3Label: defaults.last3Label,
        lastYearLabel: defaults.lastYearLabel,
        forecastQuarterLabel: defaults.forecastQuarterLabel,
    };
}
