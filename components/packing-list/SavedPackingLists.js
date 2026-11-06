"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";

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

/** Save the current packing list to the database, or open one a teammate saved. */
export default function SavedPackingLists({ branch, selected, manual, truckingFee, onLoad }) {
    const [result, setResult] = useState({ branch: "", lists: [], error: "" });
    const [tick, setTick] = useState(0);
    const [activeId, setActiveId] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState({ type: "", text: "" });

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

    const lists = result.branch === branch ? result.lists : [];
    const active = lists.find((l) => String(l.id) === String(activeId)) || null;

    const payload = useCallback(() => {
        const prefix = `${String(branch).toUpperCase()}|`;
        const manualQty = Object.fromEntries(
            Object.entries(manual || {}).filter(([k]) => k.toUpperCase().startsWith(prefix))
        );
        return { name: name.trim() || active?.name || "", branch, orderNbrs: selected, manualQty, truckingFee };
    }, [branch, manual, selected, truckingFee, name, active]);

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
            setTick((n) => n + 1);
        }, "Packing list deleted.");
    };

    const open = (id) => {
        setActiveId(id);
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
                        {lists.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.name} · {l.orderNbrs.length} PO(s) · {l.updatedBy || l.createdBy || "—"} · {formatWhen(l.updatedAt)}
                            </option>
                        ))}
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
                    {active && (
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
                        <button type="button" className="pl-link-btn pl-link-danger" onClick={remove} disabled={busy}>
                            Delete
                        </button>
                    )}
                </div>
            </div>
            {result.error && result.branch === branch && <div className="pl-saved-msg is-error">{result.error}</div>}
            {message.text && <div className={`pl-saved-msg ${message.type === "error" ? "is-error" : "is-ok"}`}>{message.text}</div>}
        </div>
    );
}
