import { requireInventoryUser } from "../_lib/auth";
import { handle, ok, preflight } from "../_lib/http";
import { listBranches } from "../_lib/stock";
import { getLedgerPool, ledgerStatus } from "../_lib/ledger-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireInventoryUser(request);
    const [branches, status] = await Promise.all([listBranches(), ledgerStatus()]);
    if (!status.ready) return ok({ branches: branches.map((b) => ({ ...b, live: false })), ledgerReady: false });

    const [rows] = await getLedgerPool().query("SELECT code, name, type, live_since FROM inv_branches WHERE status = 'active'");
    const ledger = new Map(rows.map((r) => [String(r.code).toUpperCase(), r]));
    const merged = branches.map((b) => {
        const row = ledger.get(String(b.id).toUpperCase());
        return { ...b, name: row?.name || b.name, type: row?.type || "branch", live: !!row?.live_since };
    });
    for (const [code, row] of ledger.entries()) {
        if (merged.some((b) => String(b.id).toUpperCase() === code)) continue;
        merged.push({
            id: code, name: row.name || code, type: row.type, live: !!row.live_since,
            itemCount: 0, inStockCount: 0, onHand: 0, lastSync: null,
        });
    }
    return ok({ branches: merged, ledgerReady: true });
});
