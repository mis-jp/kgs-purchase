import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { saveItemBranchSettings } from "../../../_lib/insights";
import { branchParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** PUT { branch, location?, minStock? } — shelf and minimum stock for one branch. */
export const PUT = handle(async (request, context) => {
    const member = await requireMember(request);
    const { inventoryId } = await routeParams(context);
    const body = await readJson(request);
    return ok({
        ledger: await saveItemBranchSettings(member, decodeURIComponent(String(inventoryId || "")),
            { ...body, branch: branchParam(body.branch) }, request),
    });
});
