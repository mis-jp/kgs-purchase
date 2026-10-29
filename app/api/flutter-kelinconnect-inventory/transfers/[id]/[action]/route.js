import { handle, ok, preflight, readJson, HttpError } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { transferAction } from "../../../_lib/transfers";
import { idParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "reject", "cancel", "dispatch", "receive"];

export function OPTIONS() {
    return preflight();
}

/** POST transfers/{id}/{approve|reject|cancel|dispatch|receive} */
export const POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    if (!ACTIONS.includes(action)) throw new HttpError(404, `Use one of: ${ACTIONS.join(", ")}.`);
    const member = await requireMember(request);
    return ok({ transfer: await transferAction(member, idParam(id, "transfer"), action, await readJson(request), request) });
});
