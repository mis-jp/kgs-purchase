import { NextResponse } from "next/server";
import { getPoCredentialFromRequest } from "@/lib/session-store";
import { getSystemAcumaticaCredential } from "@/lib/acumatica-system-auth";
import { isAcumaticaAuthError, syncChangedPurchaseOrders } from "@/lib/po-live-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPIRED_USER_TTL_MS = 30 * 60 * 1000;
/** User Acumatica credentials Acumatica has rejected; skip them until the user signs in again. */
const expiredUserCredentials = new Map();

function isKnownExpired(cookie) {
    const until = expiredUserCredentials.get(cookie);
    if (!until) return false;
    if (Date.now() < until) return true;
    expiredUserCredentials.delete(cookie);
    return false;
}

function markExpired(cookie) {
    expiredUserCredentials.set(cookie, Date.now() + EXPIRED_USER_TTL_MS);
    if (expiredUserCredentials.size > 500) {
        const now = Date.now();
        for (const [key, until] of expiredUserCredentials) {
            if (until <= now) expiredUserCredentials.delete(key);
        }
    }
}

async function systemCredential({ forceRefresh = false } = {}) {
    if (forceRefresh) {
        const { systemLoginForCompany } = await import("@/lib/sync-acumatica-auth");
        const { getAcumaticaCompany } = await import("@/lib/acumatica-env");
        return systemLoginForCompany(getAcumaticaCompany(), { forceRefresh: true });
    }
    return getSystemAcumaticaCredential();
}

const usable = (cookie) => Boolean(cookie) && cookie !== "__bypass__";

export async function POST(request) {
    try {
        const userCookie = getPoCredentialFromRequest(request);
        const attempts = [];
        if (usable(userCookie) && !isKnownExpired(userCookie)) attempts.push({ user: true });
        attempts.push({ user: false, forceRefresh: false }, { user: false, forceRefresh: true });

        let tried = null;
        for (const attempt of attempts) {
            const cookie = attempt.user ? userCookie : await systemCredential(attempt);
            if (!usable(cookie)) {
                return NextResponse.json({ synced: 0, more: false, reason: "no-credential" }, { status: 401 });
            }
            if (cookie === tried) continue;
            tried = cookie;
            try {
                return NextResponse.json(await syncChangedPurchaseOrders({ cookie, maxPages: 4 }));
            } catch (err) {
                if (!isAcumaticaAuthError(err)) throw err;
                if (attempt.user) markExpired(cookie);
            }
        }
        console.warn("[PO live] Acumatica rejected the system login as well.");
        return NextResponse.json({ synced: 0, more: false, reason: "acumatica-unauthorized" }, { status: 401 });
    } catch (err) {
        console.error("[PO live]", err?.message || err);
        return NextResponse.json(
            { synced: 0, more: false, message: err?.message || "Purchase order refresh failed" },
            { status: 500 }
        );
    }
}
