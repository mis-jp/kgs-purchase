import { NextResponse } from "next/server";
import { MySqlService } from "@/services/mysql";
import { requireAdmin, sanitizeUser } from "@/lib/app-users";
import { reviewUserAccess } from "@/lib/access-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** GET — admin: every account with last activity and reasons it may be unused or too broad. */
export async function GET(request) {
    let admin;
    try {
        admin = await requireAdmin(request);
    } catch (err) {
        return NextResponse.json({ message: err.message || "Forbidden" }, { status: err.status || 403 });
    }
    try {
        const [users, presence] = await Promise.all([
            MySqlService.listAppUsers(),
            MySqlService.listUserPresence(),
        ]);
        const lastSeenById = Object.fromEntries(
            presence.filter((p) => p.last_seen_at).map((p) => [Number(p.id), p.last_seen_at])
        );
        const review = reviewUserAccess(users.map(sanitizeUser), lastSeenById);
        return NextResponse.json({ ...review, selfId: Number(admin.id) }, NO_STORE);
    } catch (err) {
        console.error("[Admin access-review]", err?.message || err);
        return NextResponse.json({ message: "Could not load the access review. Try again shortly." }, { status: 500 });
    }
}
