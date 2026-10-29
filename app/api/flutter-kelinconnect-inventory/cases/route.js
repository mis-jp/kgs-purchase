import { handle, ok, preflight } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { CASE_STATUSES, listCases } from "../_lib/cases";
import { branchParam, oneOf, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listCases({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), [...CASE_STATUSES, "active"], "status"),
        ...pageParams(sp),
    }));
});
