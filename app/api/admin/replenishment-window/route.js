import { NextResponse } from "next/server";
import { requireAdmin, requireLocalUser } from "@/lib/app-users";
import { MySqlService } from "@/services/mysql";
import { invalidateCache } from "@/lib/server-cache";
import { rebuildAllReplenishmentCache } from "@/lib/replenishment-engine";
import {
    MAX_REPLENISHMENT_DAYS,
    MAX_REPLENISHMENT_MONTHS,
    MIN_REPLENISHMENT_DAYS,
    MIN_REPLENISHMENT_MONTHS,
} from "@/lib/replenishment-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
    try {
        await requireLocalUser(request);
        const window = await MySqlService.getReplenishmentSalesWindow();
        return NextResponse.json(window);
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to load sales window" }, { status });
    }
}

export async function PUT(request) {
    try {
        await requireAdmin(request);
        const body = await request.json().catch(() => ({}));
        const unit = String(body.unit || "months").toLowerCase() === "days" ? "days" : "months";
        const amount = parseInt(body.value ?? body.months, 10);
        const min = unit === "days" ? MIN_REPLENISHMENT_DAYS : MIN_REPLENISHMENT_MONTHS;
        const max = unit === "days" ? MAX_REPLENISHMENT_DAYS : MAX_REPLENISHMENT_MONTHS;
        if (!Number.isFinite(amount) || amount < min || amount > max) {
            return NextResponse.json(
                { message: `Enter a whole number from ${min} to ${max} ${unit}.` },
                { status: 400 }
            );
        }

        const saved = await MySqlService.setReplenishmentSalesWindow({ value: amount, unit });
        invalidateCache("replSalesMap:");
        invalidateCache("accurateRetailDemand:");
        invalidateCache("replenishment:");
        invalidateCache("salesSummary:");

        rebuildAllReplenishmentCache("main").catch((err) => {
            console.error("[Replenishment window rebuild]", err);
        });

        return NextResponse.json({
            ...saved,
            updating: true,
            message: `Sales window set to ${saved.value} ${saved.unit} (${saved.days} days). Replenishment is updating for every branch.`,
        });
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ message: err.message || "Failed to update sales window" }, { status });
    }
}
