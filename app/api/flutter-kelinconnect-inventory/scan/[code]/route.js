import { requireInventoryUser } from "../../_lib/auth";
import { handle, ok, preflight } from "../../_lib/http";
import { scanLookup } from "../../_lib/insights";
import { routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    await requireInventoryUser(request);
    const { code } = await routeParams(context);
    return ok({ item: await scanLookup(decodeURIComponent(String(code || ""))) });
});
