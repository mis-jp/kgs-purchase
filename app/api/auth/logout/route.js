import { NextResponse } from "next/server";
import { AuthService } from "@/services/auth";
import { getSessionFromRequest, deleteSession, getSessionIdFromRequest } from "@/lib/session-store";
import { buildAppRedirectUrl, clearAllCookies } from "@/lib/base-path";
import { removePersistedAppSession } from "@/lib/persist-session";

export async function GET(request) {
    console.log("[Logout] Clearing session and redirecting to /signin");
    const sessionId = getSessionIdFromRequest(request);
    const cookie = getSessionFromRequest(request);

    // End the user's Acumatica cookie only — never clear the shared system
    // sync session (that must stay logged in across user logouts / restarts).
    if (cookie && cookie !== "__bypass__") {
        await AuthService.logout(cookie).catch(() => {});
    }
    if (sessionId) {
        deleteSession(sessionId);
        await removePersistedAppSession(sessionId);
    }

    const expired = request.nextUrl.searchParams.get("expired") === "1";
    const signInUrl = buildAppRedirectUrl(
        request,
        expired ? "/signin?expired=1" : "/signin"
    );
    const response = NextResponse.redirect(signInUrl);
    clearAllCookies(request, response);
    return response;
}
