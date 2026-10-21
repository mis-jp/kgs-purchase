import { requireInventoryUser } from "../_lib/auth";
import { ok, failFromError, preflight, intParam } from "../_lib/http";
import { listItems } from "../_lib/stock";
import { stockFilters } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        await requireInventoryUser(request);
        const searchParams = new URL(request.url).searchParams;
        const filters = stockFilters(searchParams);
        const page = intParam(searchParams.get("page"), 1, { min: 1, max: 100000 });
        const pageSize = intParam(searchParams.get("pageSize"), 30, { min: 1, max: 100 });
        return ok(await listItems({ ...filters, page, pageSize }));
    } catch (err) {
        return failFromError(err);
    }
}
