import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/session-store";
import { buildAppRedirectUrl, getBasePath, clearAllCookies } from "@/lib/base-path";
import { hydrateSessionFromDb } from "@/lib/persist-session";
import { homePathForUser, pathAllowedForUser } from "@/lib/module-access";

const PUBLIC_PATHS = [
    "/signin",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/api/health",
    "/api/product-directory",
    "/api/flutter-kelinconnect-inventory",
    "/sitemap.xml",
    "/robots.txt",
];

function normalizePath(pathname) {
    const base = getBasePath();
    if (base && pathname.startsWith(base)) {
        return pathname.slice(base.length) || "/";
    }
    return pathname;
}

function redirectTo(request, pathname) {
    return NextResponse.redirect(buildAppRedirectUrl(request, pathname));
}

function clearSessionCookie(request, response) {
    clearAllCookies(request, response);
    return response;
}

function isKnownSession(sessionId) {
    if (!sessionId) return false;
    const meta = getSessionMeta(sessionId);
    if (!meta) return false;
    if (meta.localUser?.id) return true;
    if (!meta?.companies) return false;
    return Object.keys(meta.companies).length > 0;
}

export async function proxy(request) {
    const { pathname: rawPathname } = request.nextUrl;
    const pathname = normalizePath(rawPathname);

    const isStatic =
        pathname.startsWith("/_next") ||
        pathname.startsWith("/favicon");

    if (isStatic) return NextResponse.next();

    const session = request.cookies.get("acu_session");
    const sessionId = session?.value ?? null;
    console.log(`[Middleware] ${request.method} ${pathname} | acu_session=${sessionId ?? "(none)"}`);

    const forceSignIn =
        request.nextUrl.searchParams.get("expired") === "1" ||
        request.nextUrl.searchParams.get("force") === "1";

    // Rebuild in-memory session from MySQL after server restart
    if (sessionId && !isKnownSession(sessionId)) {
        try {
            await hydrateSessionFromDb(sessionId);
        } catch (err) {
            console.warn("[Middleware] Session hydrate failed:", err.message);
        }
    }

    if (sessionId && pathname.startsWith("/signin")) {
        if (forceSignIn) {
            return NextResponse.next();
        }
        if (!isKnownSession(sessionId)) {
            // Cookie without a recoverable session — allow sign-in page, clear stale cookie
            console.log("[Middleware] Stale session cookie on /signin — clearing cookie");
            return clearSessionCookie(request, NextResponse.next());
        }
        const signedInUser = getSessionMeta(sessionId)?.localUser;
        const home = homePathForUser(signedInUser);
        console.log(`[Middleware] Already authenticated — redirecting /signin → ${home}`);
        return redirectTo(request, home);
    }

    const isAuthApi = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
    if (isAuthApi) {
        console.log(`[Middleware] Public API path — allowing through`);
        return NextResponse.next();
    }

    if (!sessionId) {
        console.log(`[Middleware] No session — redirecting ${pathname} → /signin`);
        return redirectTo(request, "/signin");
    }

    if (!isKnownSession(sessionId)) {
        // Still unknown after hydrate — require login (no silent auto-logout loop with banner)
        console.log(`[Middleware] Unknown session — redirecting to /signin`);
        if (pathname.startsWith("/api/")) {
            return clearSessionCookie(
                request,
                NextResponse.json({ message: "Unauthorized" }, { status: 401 })
            );
        }
        return clearSessionCookie(request, redirectTo(request, "/signin"));
    }

    const localUser = getSessionMeta(sessionId)?.localUser;
    if (localUser && !pathAllowedForUser(localUser, pathname)) {
        if (pathname.startsWith("/api/")) {
            console.log(`[Middleware] Module blocked for user — ${pathname}`);
            return NextResponse.json(
                { message: "This account does not have access to that module." },
                { status: 403 }
            );
        }
        const home = homePathForUser(localUser);
        console.log(`[Middleware] Module blocked — redirecting ${pathname} → ${home}`);
        return redirectTo(request, home);
    }

    console.log(`[Middleware] Session valid — allowing ${pathname}`);
    return NextResponse.next();
}

export const config = {
    matcher: [
        "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)",
    ],
};
