import { NextRequest, NextResponse } from "next/server";
import type { ApiErr, ApiOk } from "./types";

export function ok<T>(data: T, status = 200) {
  const body: ApiOk<T> = { status: "success", success: true, data };
  return NextResponse.json(body, { status });
}

export function fail(status: number, message: string) {
  const body: ApiErr = { status: "error", success: false, message };
  return NextResponse.json(body, { status });
}

export async function readJson(
  req: NextRequest,
): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getSessionToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const custom = req.headers.get("x-rd-session")?.trim();
  if (custom) return custom;
  const q = req.nextUrl.searchParams.get("token")?.trim();
  return q || null;
}

export function withCors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-RD-Session, Cookie",
  );
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Cache-Control", "no-store");
  return res;
}
