import { handle, ok, preflight, textParam } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { listTransactions, MOVEMENT_STATUSES, MOVEMENT_TYPES } from "../_lib/movements";
import { branchParam, dateParam, oneOf, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listTransactions({
        branch: branchParam(sp.get("branch")),
        type: oneOf(sp.get("type"), MOVEMENT_TYPES, "type"),
        status: oneOf(sp.get("status"), MOVEMENT_STATUSES, "status"),
        search: textParam(sp.get("search")),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
        ...pageParams(sp),
    }));
});
