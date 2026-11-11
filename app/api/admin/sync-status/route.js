import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";
import { getAcumaticaBusyUntil } from "@/services/acumatica";
import { requireAdmin } from "@/lib/app-users";
import { canSeeSyncAlerts } from "@/lib/sync-alert-access";
import { getBackgroundJobStatus } from "@/lib/background-jobs";
import { buildSyncAlerts, describeFreshness, summarizeSyncLogs } from "@/lib/sync-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const LOG_ROWS = 200;

export async function GET(request) {
    let admin;
    try {
        admin = await requireAdmin(request);
    } catch (err) {
        return NextResponse.json({ message: err.message || "Forbidden" }, { status: err.status || 403 });
    }
    const showAlerts = canSeeSyncAlerts(admin);
    const alertsOnly = new URL(request.url).searchParams.get("view") === "alerts";
    if (alertsOnly && !showAlerts) {
        return NextResponse.json({ message: "Forbidden" }, { status: 403 });
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
        const freshness = [
            describeFreshness("inventory", "Inventory stock", inventory, now),
            describeFreshness("sales", "Sales history", sales, now),
            describeFreshness("purchaseOrders", "Purchase orders", purchaseOrders, now),
        ];
        const sections = summarizeSyncLogs(logs);
        const jobs = getBackgroundJobStatus();
        const alerts = showAlerts ? buildSyncAlerts({ sections, jobs: jobs.jobs, freshness }) : [];

        if (alertsOnly) {
            return NextResponse.json({ generatedAt: new Date(now).toISOString(), alerts }, NO_STORE);
        }

        return NextResponse.json({
            generatedAt: new Date(now).toISOString(),
            alerts,
            freshness,
            sections,
            jobs,
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
