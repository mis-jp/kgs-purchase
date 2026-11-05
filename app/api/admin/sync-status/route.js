import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";
import { getAcumaticaBusyUntil } from "@/services/acumatica";
import { requireAdmin } from "@/lib/app-users";
import { getBackgroundJobStatus } from "@/lib/background-jobs";
import { describeFreshness, summarizeSyncLogs } from "@/lib/sync-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const LOG_ROWS = 200;

export async function GET(request) {
    try {
        await requireAdmin(request);
    } catch (err) {
        return NextResponse.json({ message: err.message || "Forbidden" }, { status: err.status || 403 });
    }

    try {
        const [inventory, sales, purchaseOrders, logs] = await Promise.all([
            MySqlService.getLastInventorySyncTime(),
            MySqlService.getLastSalesSyncTime(),
            MySqlService.getLastPOSyncTime(),
            MySqlService.getSyncLogs(LOG_ROWS),
        ]);
        const now = Date.now();
        const busyUntil = getAcumaticaBusyUntil();

        return NextResponse.json({
            generatedAt: new Date(now).toISOString(),
            freshness: [
                describeFreshness("inventory", "Inventory stock", inventory, now),
                describeFreshness("sales", "Sales history", sales, now),
                describeFreshness("purchaseOrders", "Purchase orders", purchaseOrders, now),
            ],
            sections: summarizeSyncLogs(logs),
            jobs: getBackgroundJobStatus(),
            acumatica: {
                busy: busyUntil > now,
                busyUntil: busyUntil > now ? new Date(busyUntil).toISOString() : null,
            },
        }, NO_STORE);
    } catch (err) {
        console.error("[Admin sync-status]", err?.message || err);
        return NextResponse.json({ message: "Could not load sync status. Try again shortly." }, { status: 500 });
    }
}
