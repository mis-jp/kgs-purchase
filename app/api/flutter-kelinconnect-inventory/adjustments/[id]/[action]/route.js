import { handle, ok, preflight, readJson, HttpError } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { approveAdjustment, rejectAdjustment } from "../../../_lib/adjustments";
import { idParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST adjustments/{id}/approve | adjustments/{id}/reject { reason } */
export const POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireMember(request);
    const adjustmentId = idParam(id, "adjustment");
    if (action === "approve") return ok({ adjustment: await approveAdjustment(member, adjustmentId, request) });
    if (action === "reject") {
        const body = await readJson(request);
        return ok({ adjustment: await rejectAdjustment(member, adjustmentId, body.reason, request) });
    }
    throw new HttpError(404, "Use approve or reject.");
});
