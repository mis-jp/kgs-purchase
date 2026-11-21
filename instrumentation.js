/**
 * Next.js server bootstrap — start Acumatica keep-alive so inactivity logout
 * does not break headless / background auto-sync.
 *
 * Only load keep-alive on the Node.js server runtime. Never pull it into Edge
 * or the browser webpack graph.
 */
export async function register() {
    // NEXT_RUNTIME is "nodejs" | "edge" in Next; unset in some local boot paths.
    if (process.env.NEXT_RUNTIME === "edge") {
        return;
    }
    if (typeof window !== "undefined") {
        return;
    }

    try {
        // Dynamic import keeps Node-only deps out of static client analysis.
        const { ensureAcumaticaKeepAlive } = await import(
            /* webpackIgnore: true */
            "./lib/acumatica-keepalive.js"
        );
        ensureAcumaticaKeepAlive();
    } catch (err) {
        console.warn("[instrumentation] Acumatica keep-alive failed to start:", err?.message || err);
    }
}
