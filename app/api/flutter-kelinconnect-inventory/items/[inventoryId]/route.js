import { requireInventoryUser } from "../../_lib/auth";
import { ok, failFromError, preflight, HttpError } from "../../_lib/http";
import { getItem } from "../../_lib/stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request, { params }) {
    try {
        await requireInventoryUser(request);
        const { inventoryId } = await params;
        const id = decodeURIComponent(String(inventoryId || "")).trim();
        if (!id) throw new HttpError(400, "Missing inventory id.");
        return ok({ item: await getItem(id) });
    } catch (err) {
        return failFromError(err);
    }
}
