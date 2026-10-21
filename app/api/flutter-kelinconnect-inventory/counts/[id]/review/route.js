import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { reviewLedgerCount } from "../../../_lib/ledger-counts";
import { requireMember } from "../../../_lib/members";
import { countId, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const POST = handle(async (request, context) => {
    const member = await requireMember(request);
    const { id } = await routeParams(context);
    return ok(await reviewLedgerCount(member, countId(id), await readJson(request), request));
});
