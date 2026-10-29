import { handle, ok, preflight, intParam } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { recentActivity } from "../_lib/insights";
import { branchParam } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const sp = new URL(request.url).searchParams;
    return ok({
        activity: await recentActivity({
            branch: branchParam(sp.get("branch")),
            limit: intParam(sp.get("limit"), 15, { min: 1, max: 50 }),
        }),
    });
});
