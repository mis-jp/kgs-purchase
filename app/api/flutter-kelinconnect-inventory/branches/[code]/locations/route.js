import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { addLocation, listLocations } from "../../../_lib/insights";
import { branchParam, routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    await requireMember(request);
    const { code } = await routeParams(context);
    return ok({ locations: await listLocations(branchParam(decodeURIComponent(String(code || "")))) });
});

/** POST { code, name?, zone? } */
export const POST = handle(async (request, context) => {
    const member = await requireMember(request);
    const { code } = await routeParams(context);
    const branch = branchParam(decodeURIComponent(String(code || "")));
    return ok({ locations: await addLocation(member, branch, await readJson(request), request) }, 201);
});
