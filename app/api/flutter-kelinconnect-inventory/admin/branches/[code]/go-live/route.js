import { handle, ok, preflight } from "../../../../_lib/http";
import { requireMember } from "../../../../_lib/members";
import { goLive } from "../../../../_lib/admin";
import { branchParam, routeParams } from "../../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST: opening balance from Acumatica, then the branch runs on the ledger. Once per branch. */
export const POST = handle(async (request, context) => {
    const member = await requireMember(request);
    const { code } = await routeParams(context);
    return ok({ goLive: await goLive(member, branchParam(decodeURIComponent(String(code || ""))), request) });
});
