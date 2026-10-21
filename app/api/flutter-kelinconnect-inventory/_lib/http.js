import { NextResponse } from "next/server";
import { HttpError } from "./errors.js";

export { HttpError };

const NO_STORE = "no-store";

export function withCors(res) {
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-KC-User-Name");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.headers.set("Cache-Control", NO_STORE);
    return res;
}

export function ok(data, status = 200) {
    return withCors(NextResponse.json({ success: true, data }, { status }));
}

export function fail(status, message, extra = {}) {
    return withCors(NextResponse.json({ success: false, message, ...extra }, { status }));
}

export function failFromError(err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.extra);
    console.error("[KC Inventory API]", err);
    return fail(500, "Something went wrong on the server. Please try again.", {
        details: err?.message || String(err),
    });
}

export function preflight() {
    return withCors(new NextResponse(null, { status: 204 }));
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
