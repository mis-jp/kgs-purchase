import { handle, ok, preflight, intParam, textParam } from "../../_lib/http";
import { getCount } from "../../_lib/counts";
import { getLedgerCount, LEDGER_LINE_FILTERS } from "../../_lib/ledger-counts";
import { optionalMember } from "../../_lib/members";
import { countId, lineFilter, routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request, context) => {
    const member = await optionalMember(request);
    const { id } = await routeParams(context);
    const searchParams = new URL(request.url).searchParams;
    const options = {
        search: textParam(searchParams.get("search")),
        page: intParam(searchParams.get("page"), 1, { min: 1, max: 100000 }),
        pageSize: intParam(searchParams.get("pageSize"), 50, { min: 1, max: 200 }),
    };
    if (member.ledger) {
        return ok(await getLedgerCount(member, countId(id), {
            ...options, filter: lineFilter(searchParams.get("filter"), LEDGER_LINE_FILTERS),
        }));
    }
    return ok(await getCount(countId(id), { ...options, filter: lineFilter(searchParams.get("filter")) }));
});
