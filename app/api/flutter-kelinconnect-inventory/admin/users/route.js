import { handle, ok, preflight, textParam } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { listUsers } from "../../_lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    const search = textParam(new URL(request.url).searchParams.get("search"), 60);
    return ok({ users: await listUsers(member, { search }, request) });
});
