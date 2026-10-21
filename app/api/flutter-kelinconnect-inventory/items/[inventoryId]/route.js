import { handle, ok, preflight, HttpError } from "../../_lib/http";
import { getItem } from "../../_lib/stock";
import { optionalMember } from "../../_lib/members";
import { itemLedgerInfo } from "../../_lib/insights";
import { routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    const member = await optionalMember(request);
    const { inventoryId } = await routeParams(context);
    const id = decodeURIComponent(String(inventoryId || "")).trim();
    if (!id) throw new HttpError(400, "Missing inventory id.");
    const [item, ledger] = await Promise.all([
        getItem(id),
        member.ledger ? itemLedgerInfo(member, id) : Promise.resolve(null),
    ]);
    return ok({ item: { ...item, ledger } });
});
