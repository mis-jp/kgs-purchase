import { requireInventoryUser } from "../_lib/auth";
import { ok, failFromError, preflight } from "../_lib/http";
import { getSummary, listBranches } from "../_lib/stock";
import { countActivity } from "../_lib/counts";
import { stockFilters } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        await requireInventoryUser(request);
        const { branch, search, category } = stockFilters(new URL(request.url).searchParams);
        const [summary, branches, activity] = await Promise.all([
            getSummary({ branch, search, category }),
            listBranches(),
            countActivity(),
        ]);
        return ok({
            ...summary,
            branch: branch || "ALL",
            branchCount: branch ? 1 : branches.length,
            ...activity,
        });
    } catch (err) {
        return failFromError(err);
    }
}
