import { handle, ok, preflight } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { importMasterData } from "../../_lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** POST: copy branches, categories and products from Purchase (read-only sources). Safe to repeat. */
export const POST = handle(async (request) => {
    const member = await requireMember(request);
    return ok({ import: await importMasterData(member, request) });
});
