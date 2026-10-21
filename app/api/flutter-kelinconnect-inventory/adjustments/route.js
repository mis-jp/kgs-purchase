import { handle, ok, preflight, readJson } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { ADJUSTMENT_STATUSES, listAdjustments, requestAdjustment } from "../_lib/adjustments";
import { branchParam, oneOf, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAdjustments({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), ADJUSTMENT_STATUSES, "status"),
        ...pageParams(sp),
    }));
});

export const POST = handle(async (request) => {
    const member = await requireMember(request);
    const body = await readJson(request);
    return ok({ adjustment: await requestAdjustment(member, { ...body, branch: branchParam(body.branch) }, request) }, 201);
});
