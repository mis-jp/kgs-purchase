import { handle, ok, preflight, readJson, HttpError } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { approveTransaction, rejectTransaction } from "../../../_lib/movements";
import { idParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST movements/{id}/approve | movements/{id}/reject { reason } */
export const POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireMember(request);
    const movementId = idParam(id, "movement");
    if (action === "approve") return ok({ movement: await approveTransaction(member, movementId, request) });
    if (action === "reject") {
        const body = await readJson(request);
        return ok({ movement: await rejectTransaction(member, movementId, body.reason, request) });
    }
    throw new HttpError(404, "Use approve or reject.");
});
