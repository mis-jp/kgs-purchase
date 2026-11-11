"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";

function formatWhen(iso) {
    if (!iso) return "Never";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Accounts that look unused (never signed in, idle, deactivated) or broader than needed. */
export default function AccessReviewPanel({ onChanged }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [tick, setTick] = useState(0);
    const [onlyReview, setOnlyReview] = useState(true);
    const [busyId, setBusyId] = useState(null);
    const [message, setMessage] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        fetchWithAuth("/api/admin/access-review", { signal: controller.signal })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.message || "Could not load the access review.");
                setData(body);
                setError("");
            })
            .catch((err) => {
                if (!controller.signal.aborted) setError(err.message);
            });
        return () => controller.abort();
    }, [tick]);

    const rows = useMemo(() => {
        const all = data?.rows || [];
        return onlyReview ? all.filter((r) => r.needsReview || r.flags.length) : all;
    }, [data, onlyReview]);

    const setActive = async (row, active) => {
        const verb = active ? "Reactivate" : "Deactivate";
        const note = active ? "They will be able to sign in again." : "They will no longer be able to sign in. You can reactivate the account later.";
        if (!window.confirm(`${verb} ${row.username}? ${note}`)) return;
        setBusyId(row.id);
        setMessage("");
        try {
            const res = await fetchWithAuth(`/api/admin/users/${row.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || `Could not ${verb.toLowerCase()} the account.`);
            setMessage(`${row.username} ${active ? "reactivated" : "deactivated"}.`);
            setTick((n) => n + 1);
            onChanged?.();
        } catch (err) {
            setMessage(err.message);
        } finally {
            setBusyId(null);
        }
    };

    const s = data?.summary;

    return (
        <section className="admin-card access-review" id="access-review">
            <div className="admin-card-head">
                <h2>Access review</h2>
                <button type="button" className="admin-btn admin-btn--ghost" onClick={() => setTick((n) => n + 1)}>
                    Refresh
                </button>
            </div>
            <p className="admin-header-hint">
                Accounts that have never signed in, have not been used for {s?.staleDays ?? 60} days or more, are already
                deactivated, or have every module and every branch. Deactivating is reversible. Nothing is deleted from here.
            </p>

            {error && <div className="admin-alert admin-alert--error" role="alert">{error}</div>}
            {message && <div className="admin-alert" role="status">{message}</div>}

            {s && (
                <div className="access-review-stats">
                    <span><strong>{s.needsReview}</strong> to review</span>
                    <span><strong>{s.neverSignedIn}</strong> never signed in</span>
                    <span><strong>{s.stale}</strong> idle {s.staleDays}+ days</span>
                    <span><strong>{s.deactivated}</strong> deactivated</span>
                    <span><strong>{s.broad}</strong> with full access</span>
                    <span><strong>{s.activeAdmins}</strong> active admins</span>
                    <label className="access-review-toggle">
                        <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
                        Only accounts with a note
                    </label>
                </div>
            )}

            {data && (
                <div className="admin-table-wrap">
                    <table className="admin-table">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Role</th>
                                <th>Modules</th>
                                <th>Branches</th>
                                <th>Last active</th>
                                <th>Notes</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 && (
                                <tr><td colSpan={7} className="admin-empty">No accounts need attention.</td></tr>
                            )}
                            {rows.map((r) => (
                                <tr key={r.id} className={r.active ? "" : "access-review-inactive"}>
                                    <td>
                                        <strong>{r.username}</strong>
                                        {r.fullName && <div className="access-review-sub">{r.fullName}</div>}
                                    </td>
                                    <td>{r.role}</td>
                                    <td>{r.modules}</td>
                                    <td className="access-review-branches">{r.branches}</td>
                                    <td>{formatWhen(r.lastSeenAt)}</td>
                                    <td>
                                        {r.flags.length === 0 ? "—" : r.flags.map((f) => (
                                            <span key={f.key} className={`access-review-flag is-${f.key}`}>{f.text}</span>
                                        ))}
                                    </td>
                                    <td>
                                        {r.id === data.selfId ? (
                                            <span className="access-review-sub">You</span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="admin-btn admin-btn--ghost"
                                                disabled={busyId === r.id}
                                                onClick={() => setActive(r, !r.active)}
                                            >
                                                {busyId === r.id ? "Saving…" : r.active ? "Deactivate" : "Reactivate"}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
