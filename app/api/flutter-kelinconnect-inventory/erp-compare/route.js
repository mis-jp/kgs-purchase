import { handle, ok, preflight, textParam } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { erpCompare } from "../_lib/insights";
import { branchParam, pageParams } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await erpCompare(member, {
        branch: branchParam(sp.get("branch")),
        onlyDifferences: sp.get("onlyDifferences") !== "0",
        search: textParam(sp.get("search")),
        ...pageParams(sp, { pageSize: 50, max: 200 }),
    }, request));
});
