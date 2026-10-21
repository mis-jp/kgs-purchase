import { handle, ok, preflight, readJson, HttpError } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { addCaseNote, closeCase } from "../../../_lib/cases";
import { idParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST cases/{id}/notes { note } | cases/{id}/close { resolution, findings, status? } */
export const POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireMember(request);
    const caseId = idParam(id, "case");
    const body = await readJson(request);
    if (action === "notes") return ok({ case: await addCaseNote(member, caseId, body.note, request) });
    if (action === "close") return ok({ case: await closeCase(member, caseId, body, request) });
    throw new HttpError(404, "Use notes or close.");
});
