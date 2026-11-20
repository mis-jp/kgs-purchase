/**
 * Next.js server bootstrap — start Acumatica keep-alive so inactivity logout
 * does not break headless / background auto-sync.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
        return;
    }

    try {
        const { ensureAcumaticaKeepAlive } = await import("./lib/acumatica-keepalive.js");
        ensureAcumaticaKeepAlive();
    } catch (err) {
        console.warn("[instrumentation] Acumatica keep-alive failed to start:", err?.message || err);
    }
}
