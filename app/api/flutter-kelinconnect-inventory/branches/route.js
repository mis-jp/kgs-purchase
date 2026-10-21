import { requireInventoryUser } from "../_lib/auth";
import { ok, failFromError, preflight } from "../_lib/http";
import { listBranches } from "../_lib/stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        await requireInventoryUser(request);
        return ok({ branches: await listBranches() });
    } catch (err) {
        return failFromError(err);
    }
}
