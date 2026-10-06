import { NextResponse } from "next/server";
import { getPoCredentialFromRequest } from "@/lib/session-store";
import { getSystemAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { syncChangedPurchaseOrders } from "@/lib/po-live-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
    try {
        let cookie = getPoCredentialFromRequest(request);
        if (!cookie || cookie === "__bypass__") {
            cookie = await getSystemAcumaticaCredential();
        }
        if (!cookie || cookie === "__bypass__") {
            return NextResponse.json({ synced: 0, more: false, reason: "no-credential" }, { status: 401 });
        }
        const result = await syncChangedPurchaseOrders({ cookie, maxPages: 4 });
        return NextResponse.json(result);
    } catch (err) {
        console.error("[PO live]", err?.message || err);
        return NextResponse.json(
            { synced: 0, more: false, message: err?.message || "Purchase order refresh failed" },
            { status: 500 }
        );
    }
}
