import { NextResponse } from "next/server";
import {
    getSessionIdFromRequest,
    getSessionMeta,
    getSession,
    getActiveCompanyId,
    setBypassSession,
    setLocalUserSession,
    deleteSession,
} from "@/lib/session-store";
import { SESSION_EXPIRED_MESSAGE } from "@/lib/session-messages";
import { MySqlService } from "@/services/mysql";
import { sanitizeUserWithBranches } from "@/lib/app-users";
import { canSeeSyncAlerts } from "@/lib/sync-alert-access";
import { hydrateSessionFromDb, removePersistedAppSession } from "@/lib/persist-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const expired = (extra = {}) =>
    NextResponse.json(
        {
            authenticated: false,
            source: "local",
            message: SESSION_EXPIRED_MESSAGE,
            ...extra,
        },
        { status: 401 }
    );

function localUserPayload(localUser) {
    const role = localUser.role === "admin" ? "admin" : "user";
    return {
        id: localUser.id,
        username: localUser.username,
        fullName: localUser.fullName || "",
        email: localUser.email || "",
        role,
        active: true,
        branchIds: role === "admin" ? [] : (Array.isArray(localUser.branchIds) ? localUser.branchIds : []),
        allBranches: role === "admin" || localUser.allBranches === true,
        allowedModules: role === "admin" ? [] : (Array.isArray(localUser.allowedModules) ? localUser.allowedModules : []),
        syncAlerts: canSeeSyncAlerts({ ...localUser, role }),
    };
}

/**
 * Session probe — local logins stay signed in until explicit logout
 * (or the account is deactivated). ERP/token issues never force sign-out.
 */
export async function GET(request) {
    try {
        const sessionId = getSessionIdFromRequest(request);
        if (!sessionId) {
            return expired({ reason: "no_local_session" });
        }

        if (!getSessionMeta(sessionId)?.localUser?.id) {
            await hydrateSessionFromDb(sessionId);
        }

        let meta = getSessionMeta(sessionId);
        let cred = getSession(sessionId);

        if (!meta?.localUser?.id) {
            return expired({ reason: "local_session_missing" });
        }

        // Ensure company entries exist (bypass is enough for MySQL-backed UI)
        if (!meta.companies || Object.keys(meta.companies).length === 0 || !cred) {
            setBypassSession(sessionId);
            setLocalUserSession(sessionId, meta.localUser);
            meta = getSessionMeta(sessionId);
            cred = getSession(sessionId);
        }

        const activeCompanyId = getActiveCompanyId(sessionId) || "main";
        const companyEntry = meta.companies?.[activeCompanyId] || meta.companies?.main;

        try {
            const row = await MySqlService.getAppUserById(meta.localUser.id);
            if (!row || !(row.active === 1 || row.active === true)) {
                deleteSession(sessionId);
                await removePersistedAppSession(sessionId);
                return expired({ reason: "local_user_inactive" });
            }
            const freshUser = await sanitizeUserWithBranches(row);
            setLocalUserSession(sessionId, freshUser);
            meta = getSessionMeta(sessionId);
            MySqlService.touchAppSession(sessionId).catch(() => {});
            return NextResponse.json({
                authenticated: true,
                sessionId,
                activeCompanyId,
                isBypass: cred === "__bypass__" || !!companyEntry?.isBypass,
                source: "local",
                authType: "local",
                user: localUserPayload(freshUser),
                degraded: cred === "__bypass__" || !!companyEntry?.isBypass,
            });
        } catch (err) {
            console.warn("[Auth Session] Local user check failed:", err.message);
        }

        const isBypass = cred === "__bypass__" || !!companyEntry?.isBypass;
        return NextResponse.json({
            authenticated: true,
            sessionId,
            activeCompanyId,
            isBypass,
            source: "local",
            authType: "local",
            user: localUserPayload(meta.localUser),
            degraded: isBypass,
        });
    } catch (err) {
        console.error("[Auth Session]", err);
        const sessionId = getSessionIdFromRequest(request);
        const meta = sessionId ? getSessionMeta(sessionId) : null;
        if (meta?.localUser?.id) {
            return NextResponse.json({
                authenticated: true,
                sessionId,
                activeCompanyId: getActiveCompanyId(sessionId) || "main",
                isBypass: true,
                source: "local",
                authType: "local",
                user: localUserPayload(meta.localUser),
                degraded: true,
            });
        }
        return expired({ reason: "error" });
    }
}
