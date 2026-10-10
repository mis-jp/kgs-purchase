"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    CONNECTION_KIND,
    CONNECTION_STATUS_EVENT,
    probeAppHealth,
    reportConnectionOk,
    reportInternetDown,
    reportServerDown,
    reportSlowConnection,
} from "@/lib/connection-status";
import "@/styles/connection-warning.css";

const HEALTH_OK_MS = 45_000;
const HEALTH_DOWN_MS = 12_000;

const COPY = {
    internet: {
        title: "No internet connection",
        body: "Your device is offline or cannot reach the internet. Any changes you enter will not be saved. Check your connection and try again, or contact the admin if this continues.",
    },
    slow: {
        title: "Connection is slow",
        body: "The server is up, but your internet connection is too weak for this request to finish. Wait a moment and try again.",
    },
    server: {
        title: "Unable to reach the server",
        body: "The system cannot connect to the server right now. Your input data will not be saved. Try again later, or contact the admin to fix the issue.",
    },
};

const NOTE = {
    internet: "Your input data will not be saved until the connection is restored.",
    slow: "A save may fail while the connection stays this slow.",
    server: "Your input data will not be saved until the connection is restored.",
};

/**
 * App-wide centered warning when internet or server/database is unreachable.
 */
export default function ConnectionWarning() {
    const [kind, setKind] = useState(CONNECTION_KIND.OK);
    const [dismissed, setDismissed] = useState(false);
    const [checking, setChecking] = useState(false);
    const kindRef = useRef(CONNECTION_KIND.OK);

    const applyKind = useCallback((next) => {
        const normalized =
            next === CONNECTION_KIND.INTERNET || next === CONNECTION_KIND.SLOW || next === CONNECTION_KIND.SERVER
                ? next
                : CONNECTION_KIND.OK;
        if (kindRef.current !== normalized) {
            kindRef.current = normalized;
            setKind(normalized);
            if (normalized === CONNECTION_KIND.OK) {
                setDismissed(false);
            }
        } else if (normalized !== CONNECTION_KIND.OK) {
            // Same down state again (e.g. after dismiss + recheck) — keep kind, clear dismiss if user rechecks
            setKind(normalized);
        }
    }, []);

    const runCheck = useCallback(async () => {
        setChecking(true);
        try {
            const result = await probeAppHealth();
            applyKind(result);
            if (result === CONNECTION_KIND.OK) reportConnectionOk();
            else if (result === CONNECTION_KIND.INTERNET) reportInternetDown("health_probe");
            else if (result === CONNECTION_KIND.SLOW) reportSlowConnection("health_probe");
            else reportServerDown("health_probe");
            return result;
        } finally {
            setChecking(false);
        }
    }, [applyKind]);

    useEffect(() => {
        let cancelled = false;
        let timer;

        const schedule = () => {
            const delay = kindRef.current === CONNECTION_KIND.OK ? HEALTH_OK_MS : HEALTH_DOWN_MS;
            timer = setTimeout(tick, delay);
        };

        const tick = async () => {
            if (cancelled) return;
            await runCheck();
            if (!cancelled) schedule();
        };

        // Initial probe shortly after mount
        timer = setTimeout(tick, 1500);

        const onOnline = () => {
            reportConnectionOk();
            runCheck();
        };
        const onOffline = () => {
            applyKind(CONNECTION_KIND.INTERNET);
            reportInternetDown("browser_offline");
            setDismissed(false);
        };

        const onStatusEvent = (e) => {
            const next = e?.detail?.kind;
            if (!next) return;
            const was = kindRef.current;
            applyKind(next);
            if (next !== CONNECTION_KIND.OK && next !== was) setDismissed(false);
        };

        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        window.addEventListener(CONNECTION_STATUS_EVENT, onStatusEvent);

        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            applyKind(CONNECTION_KIND.INTERNET);
        }

        return () => {
            cancelled = true;
            clearTimeout(timer);
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
            window.removeEventListener(CONNECTION_STATUS_EVENT, onStatusEvent);
        };
    }, [applyKind, runCheck]);

    const visible =
        (kind === CONNECTION_KIND.INTERNET || kind === CONNECTION_KIND.SLOW || kind === CONNECTION_KIND.SERVER) && !dismissed;

    if (!visible) return null;

    const copy = COPY[kind] || COPY.server;

    const onTryAgain = async () => {
        setDismissed(false);
        const result = await runCheck();
        if (result === CONNECTION_KIND.OK) setDismissed(false);
    };

    return (
        <div
            className="conn-warn-overlay"
            role="presentation"
        >
            <div
                className="conn-warn-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="conn-warn-title"
                aria-describedby="conn-warn-body"
            >
                <div className={`conn-warn-icon conn-warn-icon--${kind}`} aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {kind === CONNECTION_KIND.INTERNET || kind === CONNECTION_KIND.SLOW ? (
                            <>
                                <path d="M1 1l22 22" />
                                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                                <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                                <line x1="12" y1="20" x2="12.01" y2="20" />
                            </>
                        ) : (
                            <>
                                <ellipse cx="12" cy="5" rx="9" ry="3" />
                                <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                                <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
                            </>
                        )}
                    </svg>
                </div>
                <h2 id="conn-warn-title" className="conn-warn-title">{copy.title}</h2>
                <p id="conn-warn-body" className="conn-warn-body">{copy.body}</p>
                <p className="conn-warn-note">{NOTE[kind] || NOTE.server}</p>
                <div className="conn-warn-actions">
                    <button
                        type="button"
                        className="conn-warn-btn conn-warn-btn--primary"
                        onClick={onTryAgain}
                        disabled={checking}
                    >
                        {checking ? "Checking…" : "Try again"}
                    </button>
                    <button
                        type="button"
                        className="conn-warn-btn conn-warn-btn--ghost"
                        onClick={() => setDismissed(true)}
                    >
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}
