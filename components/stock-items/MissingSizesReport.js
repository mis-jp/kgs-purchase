"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { missingBySupplier, missingLabel } from "@/lib/missing-dimensions";

const FILTERS = {
    all: { label: "Everything missing", test: () => true },
    both: { label: "Size and weight", test: (i) => i.missingSize && i.missingWeight },
    size: { label: "Size only", test: (i) => i.missingSize && !i.missingWeight },
    weight: { label: "Weight only", test: (i) => !i.missingSize && i.missingWeight },
};

function fmtDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** On-screen list of items on open POs that have no size or weight, by item or by supplier. */
export default function MissingSizesReport({ onDownloadTemplate, downloading }) {
    const [state, setState] = useState({ loading: true, error: "", items: [] });
    const [tick, setTick] = useState(0);
    const [view, setView] = useState("items");
    const [filter, setFilter] = useState("all");
    const [query, setQuery] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        fetchWithAuth("/api/stock-items/dimensions/missing", { signal: controller.signal })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.message || "Could not load items missing sizes.");
                setState({ loading: false, error: "", items: data.items || [] });
            })
            .catch((err) => {
                if (!controller.signal.aborted) setState({ loading: false, error: err.message, items: [] });
            });
        return () => controller.abort();
    }, [tick]);

    const counts = useMemo(() => ({
        all: state.items.length,
        both: state.items.filter(FILTERS.both.test).length,
        size: state.items.filter(FILTERS.size.test).length,
        weight: state.items.filter(FILTERS.weight.test).length,
    }), [state.items]);

    const items = useMemo(() => {
        const q = query.trim().toLowerCase();
        return state.items
            .filter(FILTERS[filter].test)
            .filter((i) => !q
                || i.inventoryId.toLowerCase().includes(q)
                || String(i.description || "").toLowerCase().includes(q)
                || (i.suppliers || []).some((s) => s.toLowerCase().includes(q)));
    }, [state.items, filter, query]);

    const suppliers = useMemo(() => missingBySupplier(items), [items]);

    return (
        <section className="si-missing" aria-label="Missing sizes report">
            <div className="si-missing-head">
                <div>
                    <h2>Missing sizes report</h2>
                    <p>
                        Items on open purchase orders with no size or weight. Packing lists leave these out of CBM,
                        weight and freight until they are filled in.
                    </p>
                </div>
                <div className="si-missing-actions">
                    <button type="button" className="si-btn si-btn-ghost" onClick={onDownloadTemplate} disabled={downloading}>
                        {downloading ? "Preparing…" : "Download to fill in"}
                    </button>
                    <button
                        type="button"
                        className="si-btn si-btn-ghost"
                        onClick={() => { setState((s) => ({ ...s, loading: true })); setTick((n) => n + 1); }}
                        disabled={state.loading}
                    >
                        {state.loading ? "Loading…" : "Refresh"}
                    </button>
                </div>
            </div>

            <div className="si-missing-tiles">
                {Object.entries(FILTERS).map(([key, f]) => (
                    <button
                        key={key}
                        type="button"
                        className={`si-missing-tile ${filter === key ? "is-active" : ""}`}
                        onClick={() => setFilter(key)}
                        aria-pressed={filter === key}
                    >
                        <strong>{state.loading ? "…" : counts[key].toLocaleString()}</strong>
                        <span>{f.label}</span>
                    </button>
                ))}
            </div>

            <div className="si-missing-toolbar">
                <div className="si-missing-tabs" role="tablist" aria-label="Report view">
                    <button type="button" role="tab" aria-selected={view === "items"} className={view === "items" ? "is-active" : ""} onClick={() => setView("items")}>
                        By item
                    </button>
                    <button type="button" role="tab" aria-selected={view === "suppliers"} className={view === "suppliers" ? "is-active" : ""} onClick={() => setView("suppliers")}>
                        By supplier
                    </button>
                </div>
                <input
                    className="db-search si-missing-search"
                    type="text"
                    placeholder="Filter by item, description or supplier…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Filter missing sizes"
                />
            </div>

            {state.error && <div className="si-error">{state.error}</div>}

            <div className="db-table-wrap si-missing-table-wrap">
                {view === "items" ? (
                    <table className="db-table si-missing-table">
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th>Missing</th>
                                <th className="num">Open qty</th>
                                <th className="num">POs</th>
                                <th>Suppliers</th>
                                <th>Latest PO</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.loading && !state.items.length ? (
                                <tr><td colSpan={6} className="si-missing-empty">Loading…</td></tr>
                            ) : items.length === 0 ? (
                                <tr><td colSpan={6} className="si-missing-empty">
                                    {state.items.length ? "No items match." : "Every item on an open purchase order has its size and weight."}
                                </td></tr>
                            ) : items.map((i) => (
                                <tr key={i.inventoryId}>
                                    <td>
                                        <span className="si-missing-id">{i.inventoryId}</span>
                                        <span className="si-missing-desc">{i.description || ""}</span>
                                    </td>
                                    <td><span className={`si-missing-pill ${i.missingSize && i.missingWeight ? "is-both" : ""}`}>{missingLabel(i)}</span></td>
                                    <td className="num">{Number(i.openQty).toLocaleString()}</td>
                                    <td className="num">{i.poCount}</td>
                                    <td className="si-missing-suppliers">{(i.suppliers || []).join(", ") || "—"}</td>
                                    <td>{fmtDate(i.latestOrderDate)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <table className="db-table si-missing-table">
                        <thead>
                            <tr>
                                <th>Supplier</th>
                                <th className="num">Items missing</th>
                                <th className="num">Missing size and weight</th>
                                <th className="num">Open qty</th>
                            </tr>
                        </thead>
                        <tbody>
                            {suppliers.length === 0 ? (
                                <tr><td colSpan={4} className="si-missing-empty">{state.loading ? "Loading…" : "No suppliers match."}</td></tr>
                            ) : suppliers.map((s) => (
                                <tr key={s.supplier}>
                                    <td>
                                        <button type="button" className="si-missing-link" onClick={() => { setQuery(s.supplier.startsWith("(") ? "" : s.supplier); setView("items"); }}>
                                            {s.supplier}
                                        </button>
                                    </td>
                                    <td className="num"><strong>{s.itemCount}</strong></td>
                                    <td className="num">{s.missingBoth}</td>
                                    <td className="num">{s.openQty.toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </section>
    );
}
