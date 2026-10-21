import { requireInventoryUser } from "../../../_lib/auth";
import { ok, failFromError, preflight, readJson } from "../../../_lib/http";
import { saveLines } from "../../../_lib/counts";
import { countId } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function PUT(request, { params }) {
    try {
        const { user } = await requireInventoryUser(request);
        const { id } = await params;
        const body = await readJson(request);
        return ok(await saveLines(countId(id), body.lines, user));
    } catch (err) {
        return failFromError(err);
    }
}
