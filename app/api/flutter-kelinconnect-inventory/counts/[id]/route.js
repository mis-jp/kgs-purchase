import { requireInventoryUser } from "../../_lib/auth";
import { ok, failFromError, preflight, intParam, textParam } from "../../_lib/http";
import { getCount } from "../../_lib/counts";
import { countId, lineFilter } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request, { params }) {
    try {
        await requireInventoryUser(request);
        const { id } = await params;
        const searchParams = new URL(request.url).searchParams;
        return ok(await getCount(countId(id), {
            filter: lineFilter(searchParams.get("filter")),
            search: textParam(searchParams.get("search")),
            page: intParam(searchParams.get("page"), 1, { min: 1, max: 100000 }),
            pageSize: intParam(searchParams.get("pageSize"), 50, { min: 1, max: 200 }),
        }));
    } catch (err) {
        return failFromError(err);
    }
}
