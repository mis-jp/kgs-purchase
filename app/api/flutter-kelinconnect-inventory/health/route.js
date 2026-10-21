import { ok, preflight } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
    return preflight();
}

export function GET() {
    return ok({ service: "flutter-kelinconnect-inventory", time: new Date().toISOString() });
}
