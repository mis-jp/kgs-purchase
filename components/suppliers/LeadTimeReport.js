"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";

const SORTS = {
    typical: { label: "Typical lead time (slowest first)", fn: (a, b) => (b.typicalDays ?? -1) - (a.typicalDays ?? -1) },
    overdue: { label: "Overdue open POs", fn: (a, b) => b.overdueCount - a.overdueCount || b.openCount - a.openCount },
    onTime: { label: "On-time rate (worst first)", fn: (a, b) => (a.onTimePct ?? 101) - (b.onTimePct ?? 101) },
    delivered: { label: "Most deliveries", fn: (a, b) => b.delivered - a.delivered },
};

const TREND_TEXT = { slower: "Getting slower", faster: "Getting faster", steady: "Steady" };

function days(n) {
    return n == null ? "—" : `${n} d`;
}

/** Lead time per supplier from the last 12 months of delivered POs, with open and overdue counts. */
export default function LeadTimeReport() {
    const [state, setState] = useState({ loading: true, error: "", suppliers: [] });
    const [tick, setTick] = useState(0);
    const [query, setQuery] = useState("");
    const [sortKey, setSortKey] = useState("typical");
    const [onlyActive, setOnlyActive] = useState(true);

    useEffect(() => {
        const controller = new AbortController();
        fetchWithAuth("/api/vendors?view=lead-times", { signal: controller.signal })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.message || "Could not load the lead-time report.");
                setState({ loading: false, error: "", suppliers: data.suppliers || [] });
            })
            .catch((err) => {
                if (!controller.signal.aborted) setState({ loading: false, error: err.message, suppliers: [] });
            });
        return () => controller.abort();
    }, [tick]);

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return state.suppliers
            .filter((s) => !onlyActive || s.delivered > 0 || s.openCount > 0)
            .filter((s) => !q || s.vendorId.toLowerCase().includes(q) || s.vendorName.toLowerCase().includes(q))
            .sort(SORTS[sortKey].fn);
    }, [state.suppliers, query, sortKey, onlyActive]);

    const totals = useMemo(() => ({
        suppliers: rows.length,
        overdue: rows.reduce((s, r) => s + r.overdueCount, 0),
        slower: rows.filter((r) => r.trend === "slower").length,
    }), [rows]);

    const exportExcel = async () => {
        const XLSX = await import("xlsx");
        const header = ["Supplier ID", "Supplier Name", "Delivered POs (12 mo)", "Typical Days", "Average Days", "Fastest Days", "Slowest Days", "Last 90 Days Avg", "Trend", "On-Time %", "Avg Days Late (when late)", "Open POs", "Overdue Open POs"];
        const body = rows.map((r) => [r.vendorId, r.vendorName, r.delivered, r.typicalDays, r.avgDays, r.fastestDays, r.slowestDays, r.recentAvgDays, TREND_TEXT[r.trend], r.onTimePct, r.avgDaysLate, r.openCount, r.overdueCount]);
        const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
        sheet["!cols"] = header.map((h, i) => ({ wch: i === 1 ? 36 : Math.max(12, h.length + 2) }));
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, "Supplier Lead Times");
        XLSX.writeFile(book, `Supplier_Lead_Times_${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    return (
        <section className="sup-lt" aria-label="Supplier lead-time report">
            <div className="sup-lt-head">
                <div>
                    <h2>Lead time report</h2>
                    <p>
                        Days from PO date to warehouse receipt for purchase orders delivered in the last 12 months.
                        &quot;Typical&quot; is the middle value, so one very late order does not distort it.
                    </p>
                </div>
                <div className="sup-lt-actions">
                    <button type="button" className="db-action-btn" onClick={exportExcel} disabled={!rows.length}>
                        Export Excel
                    </button>
                    <button type="button" className="db-action-btn" onClick={() => { setState((s) => ({ ...s, loading: true })); setTick((n) => n + 1); }} disabled={state.loading}>
                        {state.loading ? "Loading…" : "Refresh"}
                    </button>
                </div>
            </div>

            <div className="sup-lt-toolbar">
                <input
                    className="db-search sup-lt-search"
                    type="text"
                    placeholder="Filter by supplier ID or name…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Filter suppliers"
                />
                <select className="po-select-box" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort report">
                    {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                </select>
                <label className="sup-lt-check">
                    <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
                    Only suppliers with deliveries or open POs
                </label>
                <span className="sup-lt-summary">
                    {totals.suppliers} suppliers · {totals.overdue} overdue open POs · {totals.slower} getting slower
                </span>
            </div>

            {state.error && <div className="si-error">{state.error}</div>}

            <div className="db-table-wrap sup-lt-table-wrap">
                <table className="db-table sup-lt-table">
                    <thead>
                        <tr>
                            <th>Supplier</th>
                            <th className="num">Delivered</th>
                            <th className="num">Typical</th>
                            <th className="num">Fastest – Slowest</th>
                            <th className="num">Last 90 days</th>
                            <th>Trend</th>
                            <th className="num">On time</th>
                            <th className="num">Avg late</th>
                            <th className="num">Open</th>
                            <th className="num">Overdue</th>
                        </tr>
                    </thead>
                    <tbody>
                        {state.loading && !state.suppliers.length ? (
                            <tr><td colSpan={10} className="sup-lt-empty">Loading lead times…</td></tr>
                        ) : rows.length === 0 ? (
                            <tr><td colSpan={10} className="sup-lt-empty">No suppliers match.</td></tr>
                        ) : rows.map((r) => (
                            <tr key={r.vendorId}>
                                <td>
                                    <span className="sup-lt-name">{r.vendorName}</span>
                                    <span className="sup-lt-id">{r.vendorId}</span>
                                </td>
                                <td className="num">{r.delivered}</td>
                                <td className="num"><strong>{days(r.typicalDays)}</strong></td>
                                <td className="num">{r.fastestDays == null ? "—" : `${r.fastestDays} – ${r.slowestDays} d`}</td>
                                <td className="num">{days(r.recentAvgDays)}</td>
                                <td><span className={`sup-lt-trend is-${r.trend}`}>{TREND_TEXT[r.trend]}</span></td>
                                <td className="num">{r.onTimePct == null ? "—" : `${r.onTimePct}%`}</td>
                                <td className="num">{days(r.avgDaysLate)}</td>
                                <td className="num">{r.openCount}</td>
                                <td className={`num ${r.overdueCount ? "sup-lt-overdue" : ""}`}>{r.overdueCount}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
