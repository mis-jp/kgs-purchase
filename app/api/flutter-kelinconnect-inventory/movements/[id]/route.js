import { handle, ok, preflight } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { getTransaction } from "../../_lib/movements";
import { idParam, routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    await requireMember(request);
    const { id } = await routeParams(context);
    return ok({ movement: await getTransaction(idParam(id, "movement")) });
});
