import { NextResponse } from "next/server";
import { getSessionFromRequest, getActiveCompanyFromRequest } from "@/lib/session-store";
import { getStockWarehouseIdsForBranch } from "@/lib/companies";
import { getSystemAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { AcumaticaService, mapSummaryLocations } from "@/services/acumatica";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const SUMMARY_CACHE_MS = 5 * 60 * 1000;
const SUMMARY_GAP_MS = 700;
const RATE_LIMIT_WAITS_MS = [0, 2500, 6000];

const summaryCache = new Map();
const summaryInflight = new Map();
let summaryQueue = Promise.resolve();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
    return /429|too many requests/i.test(String(err?.message || ""));
}

/** One Inventory Summary call at a time, with a short pause and a few waits on HTTP 429. */
function loadSummaryResults(inventoryId, credential) {
    const key = String(inventoryId || "").trim().toUpperCase();
    const cached = summaryCache.get(key);
    if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) {
        return Promise.resolve(cached.results);
    }
    const pending = summaryInflight.get(key);
    if (pending) return pending;

    const job = summaryQueue.then(async () => {
        const again = summaryCache.get(key);
        if (again && Date.now() - again.at < SUMMARY_CACHE_MS) return again.results;

        let lastErr = null;
        for (let i = 0; i < RATE_LIMIT_WAITS_MS.length; i++) {
            if (RATE_LIMIT_WAITS_MS[i]) await sleep(RATE_LIMIT_WAITS_MS[i]);
            try {
                const results = await AcumaticaService.getInventorySummaryResults(inventoryId, credential);
                summaryCache.set(key, { at: Date.now(), results });
                return results;
            } catch (err) {
                lastErr = err;
                if (!isRateLimitError(err)) throw err;
            }
        }
        const busy = new Error("Acumatica is busy right now. Location details will load when the connection quiets down.");
        busy.status = 429;
        busy.cause = lastErr;
        throw busy;
    }).finally(() => sleep(SUMMARY_GAP_MS));

    summaryQueue = job.then(() => {}, () => {});
    const tracked = job.finally(() => summaryInflight.delete(key));
    summaryInflight.set(key, tracked);
    return tracked;
}

/**
 * GET /api/inventory/locations?inventoryId=XXX
 * Location-level on-hand from Acumatica Inventory Summary (IN401000).
 */
export async function GET(request) {
    try {
        const cookie = getSessionFromRequest(request);
        if (!cookie) {
            return NextResponse.json({ message: "Unauthorized" }, { status: 401, ...NO_STORE });
        }

        const { searchParams } = new URL(request.url);
        const inventoryId = String(searchParams.get("inventoryId") || "").trim();
        const branch = String(searchParams.get("branch") || "").trim();
        if (!inventoryId) {
            return NextResponse.json({ message: "inventoryId is required." }, { status: 400, ...NO_STORE });
        }

        let credential = await getSystemAcumaticaCredential();
        if (!credential || credential === "__bypass__") {
            // Fall back to session cookie only if it is a real Acumatica ASP.NET_SessionId
            if (cookie && cookie !== "__bypass__" && cookie.length > 20 && !cookie.includes("-")) {
                credential = cookie;
            }
        }
        if (!credential || credential === "__bypass__") {
            return NextResponse.json(
                { message: "Acumatica credentials unavailable for location lookup.", locations: [] },
                { status: 503, ...NO_STORE }
            );
        }

        const results = await loadSummaryResults(inventoryId, credential);
        let locations = mapSummaryLocations(results);

        if (branch) {
            const allowed = new Set(
                getStockWarehouseIdsForBranch(branch).map((id) => String(id).trim().toUpperCase())
            );
            locations = locations.filter((loc) =>
                allowed.has(String(loc.warehouseId || "").trim().toUpperCase())
            );
        }

        const companyId = getActiveCompanyFromRequest(request) || "main";

        return NextResponse.json(
            {
                inventoryId,
                branch: branch || null,
                companyId,
                locations,
                source: "acumatica-summary",
            },
            NO_STORE
        );
    } catch (err) {
        const status = err.status === 429 ? 429 : 500;
        if (status !== 429) console.error("[Inventory Locations]", err.message);
        else console.warn("[Inventory Locations] Acumatica rate limit:", err.cause?.message || err.message);
        return NextResponse.json(
            {
                message: status === 429
                    ? "Acumatica is busy right now. Location details will load when the connection quiets down."
                    : (err.message || "Failed to load locations"),
                locations: [],
            },
            { status, ...NO_STORE }
        );
    }
}
