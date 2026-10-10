import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * GET /api/health
 * Public lightweight check: app process + purchase database (where input is saved).
 * A slow inventory database is reported, but it does not by itself mean the server is down.
 */
export async function GET() {
    const db = await MySqlService.pingDatabases(5000);
    if (!db.ok && db.timedOut) {
        return NextResponse.json(
            {
                ok: true,
                app: true,
                database: true,
                purchase: false,
                inventory: !!db.inventory,
                slow: true,
                reason: "slow",
                message: "The database answered too slowly. The connection looks weak.",
                ms: db.ms,
            },
            { status: 200, ...NO_STORE }
        );
    }
    if (!db.ok) {
        return NextResponse.json(
            {
                ok: false,
                app: true,
                database: false,
                purchase: false,
                inventory: !!db.inventory,
                slow: false,
                reason: "server",
                message: "Unable to reach the database server.",
                ms: db.ms,
            },
            { status: 503, ...NO_STORE }
        );
    }

    return NextResponse.json(
        {
            ok: true,
            app: true,
            database: true,
            purchase: true,
            inventory: db.inventory !== false,
            reason: null,
            ms: db.ms,
        },
        { status: 200, ...NO_STORE }
    );
}
