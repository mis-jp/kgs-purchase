import { handle, preflight, csvResponse } from "../../_lib/http";
import { requireMember } from "../../_lib/members";
import { buildReport } from "../../_lib/insights";
import { branchParam, dateParam, routeParams } from "../../_lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

/** GET reports/{stock|movements|adjustments|discrepancies|transfers|user-activity}?branch&from&to -> CSV */
export const GET = handle(async (request, context) => {
    const member = await requireMember(request);
    const { name } = await routeParams(context);
    const sp = new URL(request.url).searchParams;
    const report = await buildReport(member, String(name || "").replace(/\.csv$/i, ""), {
        branch: branchParam(sp.get("branch")),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
    }, request);
    return csvResponse(report.filename, report.csv);
});
