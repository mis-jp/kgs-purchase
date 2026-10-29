import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { setWatch } from "../../../_lib/insights";
import { routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST { watching: true|false } */
export const POST = handle(async (request, context) => {
    const member = await requireMember(request);
    const { inventoryId } = await routeParams(context);
    const body = await readJson(request);
    return ok(await setWatch(member, decodeURIComponent(String(inventoryId || "")), body.watching !== false));
});
