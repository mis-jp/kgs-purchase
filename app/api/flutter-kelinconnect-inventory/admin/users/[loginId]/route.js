import { handle, ok, preflight, readJson } from "../../../_lib/http";
import { requireMember } from "../../../_lib/members";
import { saveUser } from "../../../_lib/admin";
import { routeParams } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** PUT { role?, allBranches?, branches?: string[], status?, name? } */
export const PUT = handle(async (request, context) => {
    const member = await requireMember(request);
    const { loginId } = await routeParams(context);
    return ok({ user: await saveUser(member, decodeURIComponent(String(loginId || "")), await readJson(request), request) });
});
