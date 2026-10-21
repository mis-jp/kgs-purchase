import { handle, ok, preflight } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { acknowledgeAlert } from "../../../_lib/alerts";
import { idParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const POST = handle(async (request, context) => {
    const member = await requireMember(request);
    const { id } = await routeParams(context);
    return ok({ alert: await acknowledgeAlert(member, idParam(id, "alert"), request) });
});
