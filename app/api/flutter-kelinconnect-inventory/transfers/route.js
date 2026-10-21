import { handle, ok, preflight, readJson } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { createTransfer, listTransfers, TRANSFER_STATUSES } from "../_lib/transfers";
import { branchParam, oneOf, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listTransfers({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), [...TRANSFER_STATUSES, "active"], "status"),
        direction: oneOf(sp.get("direction"), ["in", "out"], "direction"),
        ...pageParams(sp),
    }));
});

export const POST = handle(async (request) => {
    const member = await requireMember(request);
    const body = await readJson(request);
    return ok({
        transfer: await createTransfer(member, {
            ...body, fromBranch: branchParam(body.fromBranch), toBranch: branchParam(body.toBranch),
        }, request),
    }, 201);
});
