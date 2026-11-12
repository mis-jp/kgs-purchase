"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import {
    CONTAINER_LIMITS_EVENT,
    containerFillSummary,
    loadContainerLimits,
    resolveContainerTypes,
} from "@/lib/packing-list";

async function readJson(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Something went wrong. Please try again.");
    return data;
}

function formatWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fillLabel(snapshot, types) {
    if (!snapshot) return "";
    const fill = containerFillSummary(snapshot.cbm, snapshot.weightKg, types);
    return fill ? `${fill.text}, ${fill.fillPct}% full` : "";
}

function fillClass(pct) {
    if (pct >= 85) return "is-good";
    if (pct >= 60) return "is-fair";
    return "is-low";
}

const ACTION_LABELS = { created: "Saved", updated: "Changed", deleted: "Deleted" };

/** Save the current packing list to the database, or open one a teammate saved. */
export default function SavedPackingLists({ branch, selected, manual, truckingFee, snapshot, onLoad }) {
    const [result, setResult] = useState({ branch: "", lists: [], error: "" });
    const [tick, setTick] = useState(0);
    const [activeId, setActiveId] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState({ type: "", text: "" });
    const [detail, setDetail] = useState({ key: "", activity: [], canEdit: true, error: "" });
    const [showHistory, setShowHistory] = useState(false);
    const [types, setTypes] = useState(() => resolveContainerTypes({}));

    useEffect(() => {
        const refresh = () => setTypes(resolveContainerTypes(loadContainerLimits()));
        Promise.resolve().then(refresh);
        window.addEventListener(CONTAINER_LIMITS_EVENT, refresh);
        return () => window.removeEventListener(CONTAINER_LIMITS_EVENT, refresh);
    }, []);

    useEffect(() => {
        if (!branch) return undefined;
        const controller = new AbortController();
        fetchWithAuth(`/api/po/packing-list/saved?branch=${encodeURIComponent(branch)}`, { signal: controller.signal })
            .then(readJson)
            .then((data) => setResult({ branch, lists: data.lists || [], error: "" }))
            .catch((err) => {
                if (!controller.signal.aborted) setResult({ branch, lists: [], error: err.message });
            });
        return () => controller.abort();
    }, [branch, tick]);

    const detailKey = activeId ? `${activeId}#${tick}` : "";
    useEffect(() => {
        if (!activeId) return undefined;
        const controller = new AbortController();
        const key = `${activeId}#${tick}`;
        fetchWithAuth(`/api/po/packing-list/saved/${encodeURIComponent(activeId)}`, { signal: controller.signal })
            .then(readJson)
            .then((data) => setDetail({ key, activity: data.activity || [], canEdit: data.canEdit !== false, error: "" }))
            .catch((err) => {
                if (!controller.signal.aborted) setDetail({ key, activity: [], canEdit: true, error: err.message });
            });
        return () => controller.abort();
    }, [activeId, tick]);

    const lists = result.branch === branch ? result.lists : [];
    const active = lists.find((l) => String(l.id) === String(activeId)) || null;
    const detailReady = detail.key === detailKey;
    const canEdit = !detailReady || detail.canEdit;
    const activeFill = active?.snapshot ? containerFillSummary(active.snapshot.cbm, active.snapshot.weightKg, types) : null;

    const payload = () => {
        const prefix = `${String(branch).toUpperCase()}|`;
        const manualQty = Object.fromEntries(
            Object.entries(manual || {}).filter(([k, v]) => k.toUpperCase().startsWith(prefix) && String(v ?? "").trim() !== "")
        );
        return { name: name.trim() || active?.name || "", branch, orderNbrs: selected, manualQty, truckingFee, snapshot };
    };

    const run = async (task, okText) => {
        setBusy(true);
        setMessage({ type: "", text: "" });
        try {
            await task();
            if (okText) setMessage({ type: "ok", text: okText });
        } catch (err) {
            setMessage({ type: "error", text: err.message });
        } finally {
            setBusy(false);
        }
    };

    const saveNew = () => run(async () => {
        const data = await readJson(await fetchWithAuth("/api/po/packing-list/saved", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload()),
        }));
        setActiveId(String(data.list.id));
        setName(data.list.name);
        setTick((n) => n + 1);
    }, "Packing list saved. Teammates with access to this branch can open it.");

    const overwrite = () => run(async () => {
        if (!active) return;
        await readJson(await fetchWithAuth(`/api/po/packing-list/saved/${active.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload()),
        }));
        setTick((n) => n + 1);
    }, "Changes saved.");

    const remove = () => {
        if (!active) return;
        if (!window.confirm(`Delete the saved packing list "${active.name}"? This cannot be undone.`)) return;
        run(async () => {
            await readJson(await fetchWithAuth(`/api/po/packing-list/saved/${active.id}`, { method: "DELETE" }));
            setActiveId("");
            setName("");
            setShowHistory(false);
            setTick((n) => n + 1);
        }, "Packing list deleted.");
    };

    const open = (id) => {
        setActiveId(id);
        setShowHistory(false);
        setMessage({ type: "", text: "" });
        const list = lists.find((l) => String(l.id) === String(id));
        if (!list) {
            setName("");
            return;
        }
        setName(list.name);
        onLoad(list);
    };

    if (!branch) return null;

    return (
        <div className="pl-saved" aria-label="Saved packing lists">
            <div className="pl-saved-row">
                <label className="pl-saved-field">
                    <span>Saved packing lists</span>
                    <select
                        className="po-select-box"
                        value={activeId}
                        onChange={(e) => open(e.target.value)}
                        disabled={busy}
                        aria-label="Open a saved packing list"
                    >
                        <option value="">{lists.length ? "Open a saved list…" : "No saved lists for this branch"}</option>
                        {lists.map((l) => {
                            const fill = fillLabel(l.snapshot, types);
                            return (
                                <option key={l.id} value={l.id}>
                                    {l.name} · {l.orderNbrs.length} PO(s){fill ? ` · ${fill}` : ""} · {l.updatedBy || l.createdBy || "—"} · {formatWhen(l.updatedAt)}
                                </option>
                            );
                        })}
                    </select>
                </label>
                <label className="pl-saved-field pl-saved-name">
                    <span>Name</span>
                    <input
                        className="po-select-box"
                        type="text"
                        maxLength={150}
                        value={name}
                        placeholder="e.g. CDO November container"
                        onChange={(e) => setName(e.target.value)}
                        aria-label="Packing list name"
                    />
                </label>
                <div className="pl-saved-actions">
                    {active && canEdit && (
                        <button type="button" className="db-action-btn" onClick={overwrite} disabled={busy || !selected.length}>
                            Save changes
                        </button>
                    )}
                    <button
                        type="button"
                        className="db-action-btn db-action-sync"
                        onClick={saveNew}
                        disabled={busy || !selected.length || !(name.trim() || active)}
                        title={!selected.length ? "Tick at least one PO first" : undefined}
                    >
                        {active ? "Save as new" : "Save packing list"}
                    </button>
                    {active && (
                        <button type="button" className="pl-link-btn" onClick={() => setShowHistory((v) => !v)}>
                            {showHistory ? "Hide history" : "History"}
                        </button>
                    )}
                    {active && canEdit && (
                        <button type="button" className="pl-link-btn pl-link-danger" onClick={remove} disabled={busy}>
                            Delete
                        </button>
                    )}
                </div>
            </div>

            {active && activeFill && (
                <div className={`pl-saved-fill ${fillClass(activeFill.fillPct)}`}>
                    <span>When last saved: {activeFill.text}</span>
                    <span className="pl-saved-fill-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, activeFill.fillPct)}%` }} />
                    </span>
                    <span>
                        {activeFill.volumePct}% by volume, {activeFill.weightPct}% by weight
                    </span>
                </div>
            )}
            {active && !canEdit && (
                <div className="pl-saved-msg">
                    Saved by {active.createdBy || "another user"}. You can open it and use Save as new to keep your own copy.
                </div>
            )}

            {active && showHistory && (
                <div className="pl-saved-history" aria-label="Packing list history">
                    {!detailReady && <div className="pl-saved-msg">Loading history…</div>}
                    {detailReady && detail.error && <div className="pl-saved-msg is-error">{detail.error}</div>}
                    {detailReady && !detail.error && !detail.activity.length && (
                        <div className="pl-saved-msg">No history yet. Changes are recorded from now on.</div>
                    )}
                    {detailReady && detail.activity.length > 0 && (
                        <ol className="pl-history-list">
                            {detail.activity.map((a) => (
                                <li key={a.id}>
                                    <span className="pl-history-when">{formatWhen(a.at)}</span>
                                    <span className="pl-history-who">{a.username || "Unknown user"}</span>
                                    <span className="pl-history-what">
                                        <strong>{ACTION_LABELS[a.action] || a.action}</strong>
                                        {a.summary ? ` — ${a.summary}` : ""}
                                        {a.cbm != null ? ` (${a.cbm.toLocaleString()} cbm, ${(a.weightKg || 0).toLocaleString()} kg)` : ""}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            )}

            {result.error && result.branch === branch && <div className="pl-saved-msg is-error">{result.error}</div>}
            {message.text && <div className={`pl-saved-msg ${message.type === "error" ? "is-error" : "is-ok"}`}>{message.text}</div>}
        </div>
    );
}
