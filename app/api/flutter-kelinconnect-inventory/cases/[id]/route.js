import { handle, ok, preflight, readJson } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { getCase, updateCase } from "../../_lib/cases";
import { idParam, routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    await requireMember(request);
    const { id } = await routeParams(context);
    return ok({ case: await getCase(idParam(id, "case")) });
});

/** PUT { assignedTo?, findings? } */
export const PUT = handle(async (request, context) => {
    const member = await requireMember(request);
    const { id } = await routeParams(context);
    return ok({ case: await updateCase(member, idParam(id, "case"), await readJson(request), request) });
});
