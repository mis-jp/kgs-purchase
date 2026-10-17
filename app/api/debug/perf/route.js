import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session-store";
import { getCacheStats } from "@/lib/server-cache";
import { getInvalidationFailures } from "@/lib/cache-invalidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight perf snapshot for operators (cache hit rate / size).
 * Does not expose secrets.
 */
export async function GET(request) {
    const cookie = getSessionFromRequest(request);
    if (!cookie) {
        return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const mem = process.memoryUsage();
    return NextResponse.json(
        {
            cache: getCacheStats(),
            // Invalidations that still failed after retries (entries then expire on TTL).
            invalidationFailures: getInvalidationFailures(),
            memory: {
                rssMb: Math.round(mem.rss / 1024 / 1024),
                heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            },
            uptimeSec: Math.round(process.uptime()),
        },
        { headers: { "Cache-Control": "no-store" } }
    );
}
