import { requireInventoryUser } from "../_lib/auth";
import { handle, ok, preflight, readJson, intParam, textParam } from "../_lib/http";
import { listCounts, startCount } from "../_lib/counts";
import { listLedgerCounts, startLedgerCount } from "../_lib/ledger-counts";
import { optionalMember, requireMember } from "../_lib/members";
import { ledgerStatus } from "../_lib/ledger-db";
import { branchParam, oneOf } from "../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["open", "submitted", "reviewed", "cancelled"];

export function OPTIONS() {
    return preflight();
}

/** Counts run on the ledger once its database exists; before that, on the first-version tables. */
export const GET = handle(async (request) => {
    const searchParams = new URL(request.url).searchParams;
    const filters = {
        branch: branchParam(searchParams.get("branch")),
        status: oneOf(searchParams.get("status"), STATUSES, "status"),
        limit: intParam(searchParams.get("limit"), 50, { min: 1, max: 200 }),
    };
    const member = await optionalMember(request);
    if (member.ledger) return ok({ counts: await listLedgerCounts(member, filters) });
    return ok({ counts: await listCounts(filters) });
});

export const POST = handle(async (request) => {
    const body = await readJson(request);
    if ((await ledgerStatus()).ready) {
        const member = await requireMember(request);
        return ok({ count: await startLedgerCount(member, { ...body, branch: branchParam(body.branch) }, request) }, 201);
    }
    const { user } = await requireInventoryUser(request);
    const count = await startCount({
        branch: branchParam(body.branch),
        category: textParam(body.category, 100),
        note: textParam(body.note, 500),
        includeZero: body.includeZero === true,
        user,
    });
    return ok({ count }, 201);
});
