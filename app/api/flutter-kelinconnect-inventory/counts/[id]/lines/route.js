import { requireInventoryUser } from "../../../_lib/auth";
import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { saveLines } from "../../../_lib/counts";
import { saveLedgerLines } from "../../../_lib/ledger-counts";
import { requireMember } from "../../../_lib/members";
import { ledgerStatus } from "../../../_lib/ledger-db";
import { countId, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const PUT = handle(async (request, context) => {
    const { id } = await routeParams(context);
    const body = await readJson(request);
    if ((await ledgerStatus()).ready) {
        const member = await requireMember(request);
        return ok(await saveLedgerLines(member, countId(id), body.lines, request));
    }
    const { user } = await requireInventoryUser(request);
    return ok(await saveLines(countId(id), body.lines, user));
});
