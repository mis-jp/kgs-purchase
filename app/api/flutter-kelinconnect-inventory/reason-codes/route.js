import { handle, ok, preflight } from "../_lib/http";
import { requireMember } from "../_lib/members";
import { listReasonCodes } from "../_lib/movements";
import { oneOf } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    await requireMember(request);
    const type = oneOf(new URL(request.url).searchParams.get("type"),
        ["receive", "release", "transfer", "adjustment", "opening"], "type");
    return ok({ reasons: await listReasonCodes(type) });
});
