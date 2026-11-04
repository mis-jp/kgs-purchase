import { NextResponse } from "next/server";
import {
    constrainBranchParam,
    emptyRestrictedPayload,
    getRequestBranchAccess,
    hasNoBranchAccess,
} from "@/lib/branch-access";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Items on open purchase orders with no size or weight in Stock Items (read-only). */
export async function GET(request) {
    try {
        const sp = new URL(request.url).searchParams;
        const access = await getRequestBranchAccess(request);
        if (hasNoBranchAccess(access)) {
            return NextResponse.json(emptyRestrictedPayload({ items: [], totalCount: 0 }), NO_STORE);
        }
        const branch = constrainBranchParam(access, (sp.get("branch") || "").trim());
        const items = await MySqlService.getOpenPoItemsMissingDimensions({ branch });
        return NextResponse.json({ items, totalCount: items.length, branch: branch || null }, NO_STORE);
    } catch (err) {
        console.error("[Missing dimensions]", err);
        return NextResponse.json(
            { message: "Could not load items missing sizes. Please try again." },
            { status: 500 }
        );
    }
}
