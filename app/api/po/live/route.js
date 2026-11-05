import { NextResponse } from "next/server";
import { getPoCredentialFromRequest } from "@/lib/session-store";
import { withAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { isAcumaticaUnauthorized } from "@/lib/acumatica-retry";
import { syncChangedPurchaseOrders } from "@/lib/po-live-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
    try {
        const result = await withAcumaticaCredential(
            getPoCredentialFromRequest(request),
            (cookie) => syncChangedPurchaseOrders({ cookie, maxPages: 4 }),
            { label: "PO live" }
        );
        if (!result) {
            return NextResponse.json({ synced: 0, more: false, reason: "no-credential" }, { status: 401 });
        }
        return NextResponse.json(result);
    } catch (err) {
        if (isAcumaticaUnauthorized(err)) {
            console.warn("[PO live] Acumatica rejected every available login.");
            return NextResponse.json({ synced: 0, more: false, reason: "acumatica-unauthorized" }, { status: 401 });
        }
        console.error("[PO live]", err?.message || err);
        return NextResponse.json(
            { synced: 0, more: false, message: "Purchase order refresh failed. It will retry shortly." },
            { status: 500 }
        );
    }
}
