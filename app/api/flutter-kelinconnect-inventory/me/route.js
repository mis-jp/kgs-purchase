import { handle, ok, preflight } from "../_lib/http";
import { optionalMember, publicMember } from "../_lib/members";
import { ledgerStatus } from "../_lib/ledger-db";
import { getSettings } from "../_lib/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

async function blindCountDefault(ready) {
    if (!ready) return false;
    try {
        return Number((await getSettings()).count_blind_default) === 1;
    } catch {
        return false;
    }
}

export const GET = handle(async (request) => {
    const member = await optionalMember(request);
    const status = await ledgerStatus();
    return ok({
        user: publicMember(member),
        ledger: {
            ready: status.ready,
            liveBranches: status.liveBranches.map((b) => b.code),
            blindCountDefault: await blindCountDefault(status.ready),
            message: status.ready ? "" : "The new Inventory database is not set up yet. Stock is read from Acumatica.",
        },
    });
});
