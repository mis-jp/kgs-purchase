import { requireInventoryUser } from "../_lib/auth";
import { ok, failFromError, preflight, readJson, intParam, textParam, HttpError } from "../_lib/http";
import { listCounts, startCount } from "../_lib/counts";
import { branchParam } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["open", "submitted", "cancelled"];

export function OPTIONS() {
    return preflight();
}

export async function GET(request) {
    try {
        await requireInventoryUser(request);
        const searchParams = new URL(request.url).searchParams;
        const status = textParam(searchParams.get("status"), 20);
        if (status && !STATUSES.includes(status)) {
            throw new HttpError(400, `Unknown status "${status}". Use ${STATUSES.join(", ")}.`);
        }
        const counts = await listCounts({
            branch: branchParam(searchParams.get("branch")),
            status,
            limit: intParam(searchParams.get("limit"), 50, { min: 1, max: 200 }),
        });
        return ok({ counts });
    } catch (err) {
        return failFromError(err);
    }
}

export async function POST(request) {
    try {
        const { user } = await requireInventoryUser(request);
        const body = await readJson(request);
        const count = await startCount({
            branch: branchParam(body.branch),
            category: textParam(body.category, 100),
            note: textParam(body.note, 500),
            includeZero: body.includeZero === true,
            user,
        });
        return ok({ count }, 201);
    } catch (err) {
        return failFromError(err);
    }
}
