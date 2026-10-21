import { requireInventoryUser } from "../_lib/auth";
import { handle, ok, preflight } from "../_lib/http";
import { getSummary, listBranches } from "../_lib/stock";
import { countActivity } from "../_lib/counts";
import { stockFilters } from "../_lib/params";
import { ledgerStatus } from "../_lib/ledger-db";
import { dashboardActivity } from "../_lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireInventoryUser(request);
    const { branch, search, category } = stockFilters(new URL(request.url).searchParams);
    const status = await ledgerStatus();
    const [summary, branches, activity] = await Promise.all([
        getSummary({ branch, search, category }),
        listBranches(),
        status.ready ? dashboardActivity({ branch }) : countActivity(),
    ]);
    return ok({
        ...summary,
        branch: branch || "ALL",
        branchCount: branch ? 1 : branches.length,
        ledgerReady: status.ready,
        ...activity,
    });
});
