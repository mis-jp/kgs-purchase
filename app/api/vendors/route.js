import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session-store";
import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { summarizeSupplierLeadTimes } from "@/lib/supplier-lead-times";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
        const pageSize = Math.min(100, parseInt(searchParams.get("pageSize") || "10"));
        const search = (searchParams.get("search") || "").trim();
        const source = searchParams.get("source") || "mysql";

        if (searchParams.get("view") === "lead-times") {
            try {
                const { delivered, open } = await MySqlService.getSupplierLeadTimeData();
                return NextResponse.json({
                    generatedAt: new Date().toISOString(),
                    suppliers: summarizeSupplierLeadTimes(delivered, open),
                }, NO_STORE);
            } catch (err) {
                console.error("[Vendors lead-times]", err?.message || err);
                return NextResponse.json({ message: "Could not build the lead-time report. Please try again." }, { status: 500 });
            }
        }

        if (source === "mysql") {
            try {
                const [result, performance, leadTimes] = await Promise.all([
                    MySqlService.getVendors({ page, pageSize, search }),
                    MySqlService.getSupplierPerformance(),
                    MySqlService.getVendorLeadTimes(),
                ]);
                
                if (result.data.length > 0) {
                    return NextResponse.json({ 
                        vendors: result.data.map(v => {
                            const vid = v.VendorID.value;
                            const perf = performance[vid];
                            const lead = leadTimes[vid];
                            return {
                                vendorId: vid,
                                vendorName: v.VendorName.value,
                                status: v.Status?.value || "Active",
                                reliabilityScore: perf?.score ?? null,
                                totalOrders: perf?.totalOrders ?? 0,
                                onTimeOrders: perf?.onTimeOrders ?? 0,
                                avgLeadTime: lead?.days ?? Number(v.AvgLeadTime?.value ?? 0)
                            };
                        }),
                        totalCount: result.totalCount,
                        hasMore: result.totalCount > (page * pageSize),
                        source: "mysql", 
                        page, 
                        pageSize 
                    }, NO_STORE);
                }
            } catch (mError) {
                console.error("[MySQL Vendors Error]", mError);
            }
        }

        const cookie = getSessionFromRequest(request);
        if (!cookie) {
            return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
        }

        if (cookie === "__bypass__") {
            return NextResponse.json({ 
                vendors: [], 
                hasMore: false, 
                source: "mysql-bypass-empty",
                page, 
                pageSize 
            }, NO_STORE);
        }

        const result = await AcumaticaService.getVendors({
            page,
            pageSize,
            search,
            cookie
        });

        return NextResponse.json({ 
            ...result, 
            source: "acumatica",
            page, 
            pageSize 
        }, NO_STORE);
    } catch (err) {
        console.error("[Vendors API Error]", err);
        return NextResponse.json({ message: err.message }, { status: 500 });
    }
}

