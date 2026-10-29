import { handle, ok, preflight, textParam } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { listAuditLogs } from "../_lib/insights";
import { branchParam, dateParam, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAuditLogs(member, {
        branch: branchParam(sp.get("branch")),
        action: textParam(sp.get("action"), 60),
        actor: textParam(sp.get("actor"), 50),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
        ...pageParams(sp, { pageSize: 50 }),
    }));
});
