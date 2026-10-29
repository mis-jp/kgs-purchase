import { handle, ok, preflight } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { productHistory } from "../../../_lib/movements";
import { branchParam, pageParams, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    await requireMember(request);
    const { inventoryId } = await routeParams(context);
    const sp = new URL(request.url).searchParams;
    return ok(await productHistory(decodeURIComponent(String(inventoryId || "")), {
        branch: branchParam(sp.get("branch")),
        ...pageParams(sp, { pageSize: 30 }),
    }));
});
