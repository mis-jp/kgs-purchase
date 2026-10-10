import { NextResponse } from "next/server";
import { getSessionIdFromRequest, getSessionMeta } from "@/lib/session-store";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Promised On dates for packing-list containers (ETD Beyond the Container). */
export async function POST(request) {
    try {
        const sessionId = getSessionIdFromRequest(request);
        if (!sessionId || !getSessionMeta(sessionId)) {
            return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
        }
        const body = await request.json().catch(() => ({}));
        const orderNbrs = Array.isArray(body?.orderNbrs) ? body.orderNbrs : [];
        const dates = await MySqlService.getPoScheduleDatesByOrderNbr(orderNbrs);
        return NextResponse.json({ dates }, NO_STORE);
    } catch (err) {
        console.error("[container-etd]", err);
        return NextResponse.json({ message: "Internal server error" }, { status: 500 });
    }
}
