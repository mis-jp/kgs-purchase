"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";

const REFRESH_MS = 60_000;

const LEVEL_TEXT = { ok: "Up to date", warn: "Getting old", alert: "Stale", unknown: "Never synced" };
const JOB_TEXT = {
    "job:po-align-open-status-v5-hold": "Match open PO statuses with Acumatica",
    "job:po-repair-data-v2": "Repair PO statuses, suppliers and amounts",
    "job:po-fill-vendor-names-v4": "Fill supplier names from Acumatica",
    "job:po-repair-vendors-once": "Fill blank supplier names",
};

function formatWhen(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function formatAge(ms) {
    if (ms == null) return "";
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

function formatDuration(ms) {
    if (ms == null) return "—";
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function statusClass(status) {
    if (status === "completed" || status === "idle" || status === "ok") return "sync-health-pill--ok";
    if (status === "error" || status === "failed" || status === "alert") return "sync-health-pill--bad";
    if (status === "warn" || status === "queued" || status === "running" || status === "started") return "sync-health-pill--warn";
    return "sync-health-pill--muted";
}

export default function SyncHealthPanel() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetchWithAuth("/api/admin/sync-status");
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || "Could not load sync status");
            setData(body);
            setError("");
        } catch (err) {
            setError(err.message || "Could not load sync status");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let active = true;
        const tick = () => { if (active) load(); };
        Promise.resolve().then(tick);
        const timer = setInterval(tick, REFRESH_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [load]);

    const jobs = data?.jobs?.jobs || [];

    return (
        <section className="admin-card sync-health" id="sync-health">
            <div className="admin-card-head">
                <h2>Sync health</h2>
                <button type="button" className="admin-btn admin-btn--ghost" onClick={load} disabled={loading}>
                    {loading ? "Checking…" : "Refresh"}
                </button>
            </div>
            <p className="admin-header-hint">
                How fresh the data from Acumatica is, the latest result of each sync step, and the
                background repair jobs. Refreshes every minute.
            </p>

            {error && <div className="admin-alert admin-alert--error" role="alert">{error}</div>}

            {data && (
                <>
                    {data.acumatica?.busy && (
                        <div className="admin-alert admin-alert--error" role="status">
                            Acumatica asked us to slow down. Requests resume at {formatWhen(data.acumatica.busyUntil)}.
                        </div>
                    )}

                    {data.alerts?.length > 0 && (
                        <div className="sync-health-alerts" role="alert">
                            <strong>
                                {data.alerts.length === 1 ? "1 sync problem needs attention" : `${data.alerts.length} sync problems need attention`}
                            </strong>
                            <ul>
                                {data.alerts.map((a) => (
                                    <li key={a.key}>
                                        <span className="sync-health-alert-title">
                                            {a.kind === "background-job" ? `${JOB_TEXT[a.job] || a.job}: ${a.title.toLowerCase()}` : a.title}
                                        </span>
                                        <span className="sync-health-alert-detail">
                                            {a.detail}
                                            {a.kind === "sync-step" && ` Last worked: ${a.since ? formatWhen(a.since) : "not in recent history"}.`}
                                            {a.kind === "stale-data" && a.since && ` Last sync: ${formatWhen(a.since)}.`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="sync-health-tiles">
                        {data.freshness.map((f) => (
                            <div key={f.key} className={`sync-health-tile sync-health-tile--${f.level}`}>
                                <span className="sync-health-tile-label">{f.label}</span>
                                <strong>{LEVEL_TEXT[f.level] || f.level}</strong>
                                <span className="sync-health-tile-when">
                                    {f.lastSync ? `${formatAge(f.ageMs)} · ${formatWhen(f.lastSync)}` : "No sync recorded"}
                                </span>
                            </div>
                        ))}
                    </div>

                    <h3 className="sync-health-subhead">Sync steps</h3>
                    <div className="admin-table-wrap">
                        <table className="admin-table">
                            <thead>
                                <tr>
                                    <th>Step</th>
                                    <th>Latest</th>
                                    <th>Last run</th>
                                    <th>Last success</th>
                                    <th>Last error</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.sections.length === 0 && (
                                    <tr><td colSpan={5} className="admin-empty">No sync runs recorded yet.</td></tr>
                                )}
                                {data.sections.map((s) => (
                                    <tr key={s.section}>
                                        <td>{s.section}</td>
                                        <td><span className={`sync-health-pill ${statusClass(s.lastStatus)}`}>{s.lastStatus}</span></td>
                                        <td>{formatWhen(s.lastRunAt)}{s.lastRecords ? ` · ${s.lastRecords} rows` : ""}</td>
                                        <td>{formatWhen(s.lastSuccessAt)}</td>
                                        <td className="sync-health-error">
                                            {s.lastError ? `${formatWhen(s.lastErrorAt)} — ${s.lastError}` : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <h3 className="sync-health-subhead">
                        Background jobs{data.jobs?.pending ? ` (${data.jobs.pending} waiting or running)` : ""}
                    </h3>
                    <div className="admin-table-wrap">
                        <table className="admin-table">
                            <thead>
                                <tr>
                                    <th>Job</th>
                                    <th>State</th>
                                    <th>Last finished</th>
                                    <th>Took</th>
                                    <th>Runs / failures</th>
                                    <th>Last error</th>
                                </tr>
                            </thead>
                            <tbody>
                                {jobs.length === 0 && (
                                    <tr><td colSpan={6} className="admin-empty">No background jobs have run since the server started.</td></tr>
                                )}
                                {jobs.map((j) => (
                                    <tr key={j.name}>
                                        <td>{JOB_TEXT[j.name] || j.name}</td>
                                        <td><span className={`sync-health-pill ${statusClass(j.state)}`}>{j.state}</span></td>
                                        <td>{formatWhen(j.finishedAt ? new Date(j.finishedAt).toISOString() : null)}</td>
                                        <td>{formatDuration(j.durationMs)}</td>
                                        <td>{j.runs} / {j.failures}</td>
                                        <td className="sync-health-error">{j.lastError || "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </section>
    );
}
