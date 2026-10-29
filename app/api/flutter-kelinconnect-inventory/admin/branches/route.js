import { handle, ok, preflight } from "../../_lib/http";
import { assertAdmin, requireMember } from "../../_lib/members";
import { adminBranches } from "../../_lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    assertAdmin(member, request, "branch.list");
    return ok({ branches: await adminBranches() });
});
