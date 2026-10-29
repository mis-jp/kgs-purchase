import { handle, ok, preflight } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { listWatchlist } from "../_lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    return ok({ items: await listWatchlist(member) });
});
