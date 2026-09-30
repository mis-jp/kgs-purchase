/**
 * Global Purchase Order Open-status alignment (all vendors / branches).
 * Softie is only one example — never filter by vendor here.
 */
import { AcumaticaService } from "@/services/acumatica";
import { MySqlService } from "@/services/mysql";
import { normalizeErpPoStatus } from "@/lib/open-po-match";

const DEFAULT_SINCE = "2024-01-01";
const ALIGN_INTERVAL_MS = 10 * 60_000;

let alignInflight = null;
let alignFinishedAt = 0;

/**
 * Pull every Acumatica Open PO and force local status to match.
 * @param {{ cookie: string, startDate?: string, closeStale?: boolean }} opts
 */
export async function alignAllOpenPurchaseOrderStatuses({
    cookie,
    startDate = DEFAULT_SINCE,
    closeStale = true,
} = {}) {
    if (!cookie || cookie === "__bypass__") {
        return { skipped: true, opened: 0, closed: 0, openSet: 0 };
    }

    const since = String(startDate || DEFAULT_SINCE).slice(0, 10);
    let updated = 0;
    // One status at a time. Acumatica rejects a long "or" of order numbers, so that
    // lookup never wrote Completed orders back and they stayed Open here.
    const terminal = await AcumaticaService.fetchPurchaseOrdersByStatuses({
        cookie,
        statuses: ["Completed", "Closed", "Cancelled"],
        startDate: since,
        onPage: async (rows) => {
            const normalized = rows.map((row) => ({
                orderNbr: row.orderNbr,
                status: normalizeErpPoStatus(row.status),
            })).filter((row) => row.orderNbr && row.status && row.status !== "Open");
            const applied = await MySqlService.applyAcumaticaPoStatusMap(normalized);
            updated += applied.updated || 0;
        },
    });
    console.log(
        `[PO status align] Acumatica finished orders ${terminal.length}; local rows set to Closed ${updated}.`
    );

    return {
        skipped: false,
        opened: 0,
        closed: updated,
        statusUpdated: updated,
        openSet: updated,
        liveCount: terminal.length,
        terminalSet: terminal.length,
        since,
        closeStale,
    };
}

/** Refresh ERP statuses without blocking the Purchase Orders list. */
export function schedulePurchaseOrderStatusAlign(cookie) {
    if (!cookie || cookie === "__bypass__") return;
    if (alignInflight) return;
    if (Date.now() - alignFinishedAt < ALIGN_INTERVAL_MS) return;

    alignInflight = alignAllOpenPurchaseOrderStatuses({
        cookie,
        startDate: DEFAULT_SINCE,
        closeStale: true,
    }).then((result) => {
        if (result && !result.skipped && result.liveCount > 0) {
            alignFinishedAt = Date.now();
        }
        return result;
    }).catch((err) => {
        console.warn("[PO status align]", err?.message || err);
    }).finally(() => {
        alignInflight = null;
    });
}
