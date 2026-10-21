import { handle, ok, preflight, readJson } from "../../_lib/http";
import { assertAdmin, requireMember } from "../../_lib/members";
import { listSettings, saveSettings } from "../../_lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export const GET = handle(async (request) => {
    const member = await requireMember(request);
    assertAdmin(member, request, "settings.view");
    return ok({ settings: await listSettings() });
});

/** PUT { values: { setting_key: number } } */
export const PUT = handle(async (request) => {
    const member = await requireMember(request);
    const body = await readJson(request);
    return ok({ settings: await saveSettings(member, body.values, request) });
});
