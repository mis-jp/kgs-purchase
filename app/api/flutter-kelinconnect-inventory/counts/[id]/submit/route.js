import { requireInventoryUser } from "../../../_lib/auth";
import { handle, ok, preflight } from "../../../_lib/http";
import { submitCount } from "../../../_lib/counts";
import { submitLedgerCount } from "../../../_lib/ledger-counts";
import { requireMember } from "../../../_lib/members";
import { ledgerStatus } from "../../../_lib/ledger-db";
import { countId, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const POST = handle(async (request, context) => {
    const { id } = await routeParams(context);
    if ((await ledgerStatus()).ready) {
        const member = await requireMember(request);
        return ok({ count: await submitLedgerCount(member, countId(id), request) });
    }
    const { user } = await requireInventoryUser(request);
    return ok({ count: await submitCount(countId(id), user) });
});
