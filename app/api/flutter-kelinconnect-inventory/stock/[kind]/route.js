import { handle, ok, preflight, readJson, HttpError } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { postMovement } from "../../_lib/movements";
import { branchParam, routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST stock/receive | stock/release */
export const POST = handle(async (request, context) => {
    const { kind } = await routeParams(context);
    if (kind !== "receive" && kind !== "release") throw new HttpError(404, "Use stock/receive or stock/release.");
    const member = await requireMember(request);
    const body = await readJson(request);
    return ok({ movement: await postMovement(member, kind, { ...body, branch: branchParam(body.branch) }, request) }, 201);
});
