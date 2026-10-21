import { requireInventoryUser, publicUser } from "../_lib/auth";
import { ok, failFromError, preflight } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        const ctx = await requireInventoryUser(request);
        return ok({ user: publicUser(ctx) });
    } catch (err) {
        return failFromError(err);
    }
}
