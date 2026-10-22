import { NextResponse } from "next/server";
import { HttpError } from "./errors.js";

export { HttpError };

const NO_STORE = "no-store";

export function withCors(res) {
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-KC-User-Name, X-KC-Login-Id");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.headers.set("Cache-Control", NO_STORE);
    return res;
}

export function ok(data, status = 200) {
    return withCors(NextResponse.json({ success: true, data }, { status }));
}

export function fail(status, message, extra = {}) {
    return withCors(NextResponse.json({ success: false, message, ...extra }, { status }));
}

export function csvResponse(filename, text) {
    const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
    return withCors(new NextResponse(text, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${safe}"`,
        },
    }));
}

export function failFromError(err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.extra);
    if (err?.code === "ER_NO_SUCH_TABLE" || err?.code === "ER_BAD_DB_ERROR") {
        return fail(503, "The new Inventory database is not set up yet. Ask the admin to follow INVENTORY-DATABASE-SPEC.md.", {
            code: "LEDGER_NOT_READY",
            details: err.sqlMessage || err.message,
        });
    }
    if (err?.code === "ER_CHECK_CONSTRAINT_VIOLATED") {
        return fail(409, "That change would make the stock numbers invalid (for example below zero). Refresh and try again.");
    }
    if (err?.sqlState === "45000") return fail(409, err.sqlMessage || "This record cannot be changed.");
    if (err?.code === "ER_LOCK_DEADLOCK" || err?.code === "ER_LOCK_WAIT_TIMEOUT") {
        return fail(409, "Someone else is changing the same stock right now. Please try again.");
    }
    console.error("[KC Inventory API]", err);
    return fail(500, "Something went wrong on the server. Please try again.", {
        details: err?.message || String(err),
    });
}

export function preflight() {
    return withCors(new NextResponse(null, { status: 204 }));
}

/** Wrap a route handler: errors become JSON `{ success: false, message }`. */
export function handle(fn) {
    return async (request, context) => {
        try {
            return await fn(request, context);
        } catch (err) {
            return failFromError(err);
        }
    };
}

export async function readJson(request) {
    try {
        const body = await request.json();
        return body && typeof body === "object" && !Array.isArray(body) ? body : {};
    } catch {
        return {};
    }
}

export function intParam(value, fallback, { min = 1, max = 500 } = {}) {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export function textParam(value, max = 120) {
    return String(value ?? "").trim().slice(0, max);
}
