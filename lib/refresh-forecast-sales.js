import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { getAcumaticaCompanyName } from "@/lib/companies";
import { getCachedSystemCredential } from "@/lib/acumatica-system-auth";
import { obtainSyncCredential, systemLoginForCompany } from "@/lib/sync-acumatica-auth";

const REFRESH_TTL_MS = 5 * 60 * 1000;
const lastRefreshByKey = new Map();

function salesRefreshKey({ last3Start, last3End, lastYearStart, lastYearEnd, months }) {
    const forced = Array.isArray(months) ? months.join(",") : "";
    return ["__GLOBAL__", last3Start || "", last3End || "", lastYearStart || "", lastYearEnd || "", forced].join("|");
}

function monthRange(ym) {
    const [y, m] = String(ym || "").split("-").map(Number);
    if (!y || !m) return null;
    const lastDay = new Date(y, m, 0).getDate();
    return {
        start: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`,
        end: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
}

async function resolveCookie(cookie) {
    if (cookie && cookie !== "__bypass__") return cookie;
    const cached = getCachedSystemCredential();
    if (cached) return cached;
    return obtainSyncCredential({
        companyName: getAcumaticaCompanyName("main"),
        sessionCookie: cookie && cookie !== "__bypass__" ? cookie : null,
    });
}

async function runRefresh({
    last3Start,
    last3End,
    lastYearStart,
    lastYearEnd,
    cookie = null,
    months = null,
} = {}) {
    let credential = await resolveCookie(cookie);
    if (!credential || credential === "__bypass__") {
        return { ok: false, reason: "no-credential", lines: 0, documents: 0, months: [] };
    }

    const ranges = [
        { start: last3Start, end: last3End },
        { start: lastYearStart, end: lastYearEnd },
    ].filter((r) => r.start && r.end);

    // Coverage-aware: partial months (e.g. Jul 1–14) stay "missing".
    let missing = Array.isArray(months) && months.length
        ? [...new Set(months.map((m) => String(m || "").trim()).filter(Boolean))]
        : await MySqlService.listMissingSalesInvoiceMonths({ ranges, branch: "" });
    if (!missing.length) {
        return { ok: true, reason: "complete", months: [], documents: 0, lines: 0 };
    }

    let lines = 0;
    const failed = [];
    for (const ym of missing) {
        const range = monthRange(ym);
        if (!range) continue;
        try {
            console.log(`[Forecast sales refresh] Fetching ${ym} ${range.start}→${range.end}`);
            const before = lines;
            const rows = await AcumaticaService.fetchPeriodicSalesForSync({
                cookie: credential,
                startDate: range.start,
                endDate: range.end,
                lastModifiedAfter: null,
                chunkDays: 2,
                onBatch: async (batch) => {
                    if (!batch?.length) return;
                    await MySqlService.upsertPeriodicSales(batch);
                    lines += batch.length;
                },
            });
            if (Array.isArray(rows) && rows.length && lines === before) {
                await MySqlService.upsertPeriodicSales(rows);
                lines += rows.length;
            }
        } catch (err) {
            console.error(`[Forecast sales refresh] ${ym} failed:`, err.message);
            // Session often expires mid-month — refresh cookie and retry once.
            if (/401|unauthorized|not logged in/i.test(String(err.message || ""))) {
                try {
                    credential = await systemLoginForCompany(getAcumaticaCompanyName("main"), {
                        forceRefresh: true,
                    });
                    console.log(`[Forecast sales refresh] Re-login ok — retrying ${ym}`);
                    const before = lines;
                    const rows = await AcumaticaService.fetchPeriodicSalesForSync({
                        cookie: credential,
                        startDate: range.start,
                        endDate: range.end,
                        lastModifiedAfter: null,
                        chunkDays: 2,
                        onBatch: async (batch) => {
                            if (!batch?.length) return;
                            await MySqlService.upsertPeriodicSales(batch);
                            lines += batch.length;
                        },
                    });
                    if (Array.isArray(rows) && rows.length && lines === before) {
                        await MySqlService.upsertPeriodicSales(rows);
                        lines += rows.length;
                    }
                    continue;
                } catch (retryErr) {
                    console.error(`[Forecast sales refresh] ${ym} retry failed:`, retryErr.message);
                    failed.push(ym);
                    continue;
                }
            }
            failed.push(ym);
        }
    }

    return {
        ok: failed.length === 0,
        reason: failed.length ? "partial-months" : "missing-months",
        months: missing,
        failed,
        documents: 0,
        lines,
    };
}

/**
 * Backfill Forecast date windows that incremental sync never stored (often Jun/Jul).
 */
let salesInflight = null;

export async function refreshForecastSales({
    last3Start,
    last3End,
    lastYearStart,
    lastYearEnd,
    cookie = null,
    force = false,
    months = null,
} = {}) {
    if (salesInflight) return salesInflight;

    const key = salesRefreshKey({ last3Start, last3End, lastYearStart, lastYearEnd, months });
    const prev = lastRefreshByKey.get(key);
    if (!force && prev?.at && Date.now() - prev.at < REFRESH_TTL_MS) {
        return { ok: true, skipped: true, reason: "throttled", lines: 0, documents: 0, months: [] };
    }

    const inflight = Promise.resolve().then(() =>
        runRefresh({
            last3Start,
            last3End,
            lastYearStart,
            lastYearEnd,
            cookie,
            months,
        }).catch((err) => {
            console.error("[Forecast sales refresh]", err);
            return { ok: false, reason: "error", error: err.message, lines: 0, documents: 0, months: [] };
        })
    ).finally(() => {
        salesInflight = null;
    });

    salesInflight = inflight;
    lastRefreshByKey.set(key, { at: prev?.at || 0, inflight });
    const result = await inflight;
    lastRefreshByKey.set(key, {
        at: result.ok && !result.skipped ? Date.now() : 0,
        inflight: null,
    });
    return result;
}
