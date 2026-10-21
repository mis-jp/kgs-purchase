import { requireInventoryUser } from "../../../_lib/auth";
import { ok, failFromError, preflight } from "../../../_lib/http";
import { cancelCount } from "../../../_lib/counts";
import { countId } from "../../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function POST(request, { params }) {
    try {
        const { user } = await requireInventoryUser(request);
        const { id } = await params;
        return ok({ count: await cancelCount(countId(id), user) });
    } catch (err) {
        return failFromError(err);
    }
}
