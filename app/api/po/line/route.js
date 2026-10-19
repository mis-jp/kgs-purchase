import { NextResponse } from "next/server";
import { getActiveCompanyFromRequest } from "@/lib/session-store";
import { constrainBranchParam, getRequestBranchAccess, hasNoBranchAccess } from "@/lib/branch-access";
import { MySqlService } from "@/services/mysql";
import { findPoLine, poLineKey } from "@/lib/po-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * GET /api/po/line?orderNbr=PO1&lineKey=2
 * One PO line plus its order header (no other lines). Same session (proxy)
 * and branch-access rules as /api/po.
 */
export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const orderNbr = (searchParams.get("orderNbr") || "").trim();
        const lineKey = (searchParams.get("lineKey") || "").trim();
        if (!orderNbr || !lineKey) {
            return NextResponse.json({ message: "orderNbr and lineKey are required" }, { status: 400 });
        }
        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json({ message: "Not found" }, { status: 404 });
        }
        const branch = constrainBranchParam(access, "");
        const companyId = getActiveCompanyFromRequest(request) || "main";
        const result = await MySqlService.getPurchaseOrders({
            page: 1,
            pageSize: 5,
            orderNbrs: [orderNbr],
            branch,
            companyId,
        });
        const order = (result?.orders || []).find((o) => String(o.orderNbr || "").trim() === orderNbr);
        if (!order) return NextResponse.json({ message: "Not found" }, { status: 404 });
        const found = findPoLine(order.lines, lineKey);
        if (!found) return NextResponse.json({ message: "Not found" }, { status: 404 });
        const { lines, ...header } = order;
        return NextResponse.json({
            order: { ...header, lineCount: Array.isArray(lines) ? lines.length : 0 },
            line: { ...found.line, lineKey: poLineKey(found.line, found.index), position: found.index + 1 },
        }, NO_STORE);
    } catch (err) {
        console.error("[PO line API]", err);
        return NextResponse.json({ message: "Internal server error" }, { status: 500 });
    }
}
