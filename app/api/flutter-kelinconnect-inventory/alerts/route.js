import { handle, ok, preflight, textParam } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { ALERT_STATUSES, listAlerts } from "../_lib/alerts";
import { branchParam, oneOf, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAlerts({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), ALERT_STATUSES, "status"),
        type: textParam(sp.get("type"), 40),
        ...pageParams(sp),
    }));
});
