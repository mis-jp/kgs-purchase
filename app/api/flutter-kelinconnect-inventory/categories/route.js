import { requireInventoryUser } from "../_lib/auth";
import { ok, failFromError, preflight } from "../_lib/http";
import { listCategories } from "../_lib/stock";
import { branchParam } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        await requireInventoryUser(request);
        const branch = branchParam(new URL(request.url).searchParams.get("branch"));
        return ok({ categories: await listCategories({ branch }) });
    } catch (err) {
        return failFromError(err);
    }
}
