import { MySqlService } from "@/services/mysql";
import { AcumaticaService } from "@/services/acumatica";
import { NextResponse } from "next/server";
import { getSessionFromRequest, getActiveCompanyFromRequest } from "@/lib/session-store";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "10", 10)));
    const search = searchParams.get("search") || "";
    const itemClass = String(searchParams.get("itemClass") || "").trim();
    const dimsStatusRaw = String(searchParams.get("dimsStatus") || "").trim().toLowerCase();
    const dimsStatus = dimsStatusRaw === "set" || dimsStatusRaw === "unset" ? dimsStatusRaw : "";
    const cursor = searchParams.get("cursor") || "";
    const companyId = getActiveCompanyFromRequest(request) || "main";

    try {
        const cookie = getSessionFromRequest(request);
        if (!cookie) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

        console.log(
            `[Stock Items API] MySQL — company: ${companyId}, page: ${page}${itemClass ? `, itemClass: ${itemClass}` : ""}${dimsStatus ? `, dimsStatus: ${dimsStatus}` : ""}${cursor ? `, cursor: ${cursor}` : ""}`
        );
        const result = await MySqlService.getStockItems({
            page,
            pageSize,
            search,
            itemClass,
            dimsStatus,
            companyId,
            cursor,
        });
        console.log(
            `[Stock Items API] mode=${result.dataMode || "warehouse"} totalCount=${result.totalCount} totalStock=${result.totalStock}`
        );

        if (result.items.length === 0 && (search || itemClass || dimsStatus)) {
            return NextResponse.json({ ...result, source: "mysql", companyId }, NO_STORE);
        }

        if (result.items.length === 0) {
            if (cookie === "__bypass__") {
                return NextResponse.json({ items: [], totalCount: 0, source: "mysql-bypass-empty" }, NO_STORE);
            }
            console.log("[Stock Items API] MySQL returned 0 items for this query, falling back to Acumatica...");
            throw new Error("EMPTY_MYSQL");
        }

        const source = result.dataMode === "catalog" ? "mysql-catalog" : "mysql";
        return NextResponse.json({ ...result, source, companyId }, NO_STORE);
    } catch (err) {
        console.error("[Stock Items API MySQL Error]", err.message);
        const dbDown = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|EHOSTUNREACH|ENOTFOUND/i.test(
            `${err?.code || ""} ${err?.message || ""}`
        );
        if (dbDown) {
            return NextResponse.json({
                message: "The product list is in MySQL, but the inventory database is not answering right now. Refresh again in a moment.",
            }, { status: 503, ...NO_STORE });
        }

        const cookie = getSessionFromRequest(request);
        if (cookie === "__bypass__") {
            return NextResponse.json({ items: [], totalCount: 0, source: "mysql-bypass-error", message: err.message }, NO_STORE);
        }

        console.log("[Stock Items API] Falling back to Acumatica...");

        try {
            const cookie = getSessionFromRequest(request);
            if (!cookie) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

            const acuResult = await AcumaticaService.getStockItems({
                page,
                pageSize,
                search,
                cookie
            });

            // Transform and aggregate Acumatica BFF format
            const itemMap = new Map();
            for (const item of acuResult.data) {
                const invId = item.InventoryID?.value;
                if (!invId) continue;

                if (!itemMap.has(invId)) {
                    itemMap.set(invId, {
                        inventoryId: invId,
                        description: item.Description?.value,
                        itemClass: item.ItemClass?.value,
                        itemStatus: item.ItemStatus?.value || "Active",
                        baseUnit: item.BaseUnit?.value || "PCS",
                        price: item.DefaultPrice?.value || 0,
                        totalOnHand: 0,
                        totalQtySold: 0,
                        totalSales: 0
                    });
                }
                const entry = itemMap.get(invId);
                entry.totalOnHand += (item.OnHand?.value || 0);
            }

            return NextResponse.json({
                items: Array.from(itemMap.values()),
                totalCount: acuResult.totalCount,
                source: "acumatica-fallback"
            }, NO_STORE);
        } catch (acuErr) {
            console.error("[Stock Items API Fallback Error]", acuErr);
            return NextResponse.json({ error: acuErr.message || "Failed to fetch stock items" }, { status: 500 });
        }
    }
}

