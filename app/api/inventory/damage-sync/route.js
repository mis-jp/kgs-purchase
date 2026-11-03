import { NextResponse } from "next/server";
import { getSessionFromRequest, getActiveCompanyFromRequest } from "@/lib/session-store";
import { getSystemAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { AcumaticaService, extractDamageLevelsFromSummary } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * POST /api/inventory/damage-sync
 * Backfill DAMAGE / DISCOUNTED qty via Inventory Summary.
 * Does not change MAIN / branch sellable totals.
 */
export async function POST(request) {
    try {
        const session = getSessionFromRequest(request);
        if (!session) {
            return NextResponse.json({ message: "Unauthorized" }, { status: 401, ...NO_STORE });
        }

        const credential = await getSystemAcumaticaCredential();
        if (!credential || credential === "__bypass__") {
            return NextResponse.json(
                { message: "Acumatica system credentials required to refresh damage stock." },
                { status: 503, ...NO_STORE }
            );
        }

        const companyId = getActiveCompanyFromRequest(request) || "main";
        const body = await request.json().catch(() => ({}));
        const limit = Math.min(400, Math.max(20, parseInt(body.limit || "120", 10) || 120));
        const concurrency = 6;

        const ids = await MySqlService.listStockedInventoryIds({ companyId, limit });
        const damageLevels = [];

        for (let i = 0; i < ids.length; i += concurrency) {
            const slice = ids.slice(i, i + concurrency);
            const batch = await Promise.all(
                slice.map(async (inventoryId) => {
                    try {
                        const results = await AcumaticaService.getInventorySummaryResults(
                            inventoryId,
                            credential
                        );
                        return extractDamageLevelsFromSummary(inventoryId, results, {
                            inventory_id: inventoryId,
                        });
                    } catch (err) {
                        console.warn(`[damage-sync] ${inventoryId}:`, err.message);
                        return [];
                    }
                })
            );
            for (const part of batch) damageLevels.push(...part);
        }

        const withQty = damageLevels.filter(
            (l) => (Number(l.on_hand) || 0) > 0 || (Number(l.available) || 0) > 0
        );

        if (withQty.length) {
            // upsertInventoryLevels clears the current stats / branch / count caches
            // after it writes. (The old "global-stats-v5:" prefix here matched no key.)
            await MySqlService.upsertInventoryLevels(withQty, companyId);
        }

        const damageStock = withQty.reduce((s, l) => s + (Number(l.on_hand) || 0), 0);
        const damageCount = new Set(withQty.map((l) => l.inventory_id)).size;

        return NextResponse.json(
            {
                scanned: ids.length,
                damageRows: withQty.length,
                damageStock,
                damageCount,
                source: "acumatica-summary",
            },
            NO_STORE
        );
    } catch (err) {
        console.error("[damage-sync]", err);
        return NextResponse.json(
            { message: err.message || "Damage sync failed" },
            { status: 500, ...NO_STORE }
        );
    }
}
