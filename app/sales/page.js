"use client";

import { useState, useCallback, useEffect, memo, Fragment, useMemo } from "react";
import { useRouter } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import PaginationBar from "@/components/PaginationBar";
import { loadAllBranchesAccess } from "@/lib/user-access-client";
import "@/styles/dashboard.css";
import "@/styles/sales.css";

/* ── SVG Icons ───────────────────────────────────── */
const CalendarIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
);
const DownloadIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);
const BranchIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
);
const IconChevronLeft = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
    </svg>
);
const IconChevronRight = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

const currentYearNum = new Date().getFullYear();
const years = Array.from({ length: 6 }, (_, i) => currentYearNum - i);

function fmtDateYmd(d) {
    if (!d) return "—";
    const raw = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const [y, m, day] = raw.slice(0, 10).split("-");
        return `${y}/${m}/${day}`;
    }
    const date = new Date(d);
    if (isNaN(date.getTime())) return "—";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
}

export default function SalesPeriodicPage() {
    const router = useRouter();
    const [mounted, setMounted] = useState(false);

    /* ── State ────────────────────────────────────────────── */
    const [selectedBranch, setSelectedBranch] = useState("");
    const [allowAllBranches, setAllowAllBranches] = useState(false);
    const [targetDate, setTargetDate] = useState(new Date().toISOString().split('T')[0]);
    const [branchOptions, setBranchOptions] = useState([]);
    const [allSalesData, setAllSalesData] = useState([]);
    const [periods, setPeriods] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize] = useState(10);
    const [pagination, setPagination] = useState({ totalItems: 0, totalPages: 0 });
    const [metrics, setMetrics] = useState({ overallStocks: 0, totalRevenue: 0, uniqueProducts: 0, totalQtySold: 0 });

    // Initial restoration & Hydration fix
    useEffect(() => {
        Promise.resolve().then(() => {
            setMounted(true);
            const b = localStorage.getItem("sales_filter_branch") || "";
            const d = localStorage.getItem("sales_filter_date") || new Date().toISOString().split('T')[0];

            if (b) setSelectedBranch(b);
            if (d) setTargetDate(d);
        });
    }, []);

    // Server returns one page; no client-side slice needed
    const salesData = allSalesData;

    // Save filters to localStorage when they change
    useEffect(() => {
        if (!mounted) return;
        localStorage.setItem("sales_filter_branch", selectedBranch);
        localStorage.setItem("sales_filter_date", targetDate);
    }, [selectedBranch, targetDate, mounted]);

    /* ── Fetch branches ─────────────────────────────────── */
    useEffect(() => {
        const fetchBranches = async () => {
            try {
                const res = await fetch("/api/branches");
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (data?.value || []);
                    
                    const options = list.map(b => {
                        const rawName = b.Description?.value || b.Description || b.BranchName?.value || b.branch_name || "";
                        const name = rawName && !String(rawName).startsWith("[object") ? String(rawName) : (b.SiteID || b.branch_id || "");
                        return { id: b.SiteID || b.branch_id || "", name };
                    })
                    .filter(b => b.id)
                    .filter((b, i, arr) => arr.findIndex(x => x.id === b.id) === i)
                    .sort((a, z) => a.name.localeCompare(z.name));

                    setBranchOptions(options);
                    const allowAll = await loadAllBranchesAccess(fetchWithAuth);
                    setAllowAllBranches(allowAll);
                    if (!allowAll && options[0] && !options.some((b) => b.id === selectedBranch)) {
                        setSelectedBranch(options[0].id);
                    }
                }
            } catch { }
        };
        fetchBranches();
    }, []);

    /* ── Fetch sales analysis ───────────────────────────── */
    const fetchSales = useCallback(async (isBackground = false, pageOverride = currentPage) => {
        if (!isBackground && allSalesData.length === 0) {
            setLoading(true);
        }
        setRefreshing(true);
        if (!isBackground) {
            setError("");
            if (typeof window !== "undefined") {
                window.scrollTo({ top: 0, behavior: "smooth" });
            }
        }
        try {
            const params = new URLSearchParams({
                branch: selectedBranch,
                asOfDate: targetDate,
                page: String(pageOverride),
                pageSize: String(pageSize),
            });
            const res = await fetchWithAuth(`/api/sales-periodic?${params.toString()}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                if (!isBackground) setError(body.message || "Failed to load sales history.");
                return;
            }
            const result = await res.json();
            setAllSalesData(result.data || []);
            setPeriods(result.months || []);
            setPagination(result.pagination || { totalItems: 0, totalPages: 0 });
            setMetrics(result.metrics || { overallStocks: 0, totalRevenue: 0, uniqueProducts: 0, totalQtySold: 0 });
        } catch (err) {
            if (err.message === "Unauthorized") return;
            if (!isBackground) setError("Unable to connect to the server.");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [selectedBranch, targetDate, currentPage, pageSize, allSalesData.length]);

    useEffect(() => {
        if (!mounted) return;
        setCurrentPage(1);
    }, [selectedBranch, targetDate, mounted]);

    useEffect(() => {
        if (!mounted) return;
        fetchSales(false, currentPage);
    }, [fetchSales, selectedBranch, targetDate, currentPage, mounted, pageSize]);

    /* ── Export CSV ─────────────────────────────────────── */
    const exportCSV = useCallback(async () => {
        try {
            const params = new URLSearchParams({
                branch: selectedBranch,
                asOfDate: targetDate,
                page: "1",
                pageSize: "50000",
            });
            const res = await fetchWithAuth(`/api/sales-periodic?${params.toString()}`);
            if (!res.ok) return;
            const result = await res.json();
            const rows = result.data || [];
            const exportPeriods = result.months || periods;
            if (!rows.length) return;

            const headers = ["Inventory ID", "Branch Name", "Description"];
            exportPeriods.forEach(p => {
                headers.push(`${p.label} Qty`);
                headers.push(`${p.label} Sales`);
            });
            headers.push("90-Day Total Qty");
            headers.push("90-Day Total Sales");

            const csvRows = rows.map((r) => {
                const row = [r.inventoryId, r.branchName, r.description];
                exportPeriods.forEach(p => {
                    row.push(r.monthlyData[p.key]?.qty || 0);
                    row.push(r.monthlyData[p.key]?.sales || 0);
                });
                row.push(r.totalQty);
                row.push(r.totalSales);
                return row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
            });

            const csv = [headers.join(","), ...csvRows].join("\n");
            const blob = new Blob([csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `sales-90days-${selectedBranch || "all"}-${targetDate}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            /* ignore export errors */
        }
    }, [selectedBranch, targetDate, periods]);

    return (
        <div className="db-root">
            <main className="db-main">
                <div className="db-page-title" data-tour="page-title">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                            <h1>90-Day Sales Analysis</h1>
                            <p>Comparative sales performance over the last 90 days, divided into three 30-day blocks.</p>
                        </div>
                        <button className="db-action-btn" onClick={exportCSV} disabled={pagination.totalItems === 0}>
                            <DownloadIcon /> Export CSV
                        </button>
                    </div>
                </div>

                <div className="db-stats" data-tour="kpi-cards">
                    <div className="db-stat-card db-stat-blue">
                        <span className="db-stat-label">90-Day Total Volume</span>
                        <span className="db-stat-value">{allSalesData.length > 0 ? metrics.totalQtySold.toLocaleString() : "—"}</span>
                        <span className="db-stat-sub">Units Sold</span>
                    </div>
                    <div className="db-stat-card">
                        <span className="db-stat-label">90-Day Total Revenue</span>
                        <span className="db-stat-value">{allSalesData.length > 0 ? `₱${metrics.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0 })}` : "—"}</span>
                        <span className="db-stat-sub">Gross Sales</span>
                    </div>
                    <div className="db-stat-card">
                        <span className="db-stat-label">Reporting As Of</span>
                        <span className="db-stat-value" style={{ fontSize: '1.25rem' }}>{fmtDateYmd(targetDate)}</span>
                        <span className="db-stat-sub">End Date</span>
                    </div>
                    <div className="db-stat-card">
                        <span className="db-stat-label">Scope</span>
                        <span className="db-stat-value" style={{ fontSize: '1.1rem' }}>{selectedBranch || "All Branches"}</span>
                        <span className="db-stat-sub">Branch Selection</span>
                    </div>
                </div>

                <section className="db-toolbar sales-toolbar" data-tour="toolbar">
                    <div className="db-toolbar-left" style={{ flexWrap: "wrap", gap: "1.5rem" }}>
                        <div className="sales-filter-group">
                            <label><CalendarIcon /> As of Date</label>
                            <div className="sales-date-wrap">
                                <input
                                    type="date"
                                    className="sales-date-input"
                                    value={targetDate}
                                    onChange={(e) => setTargetDate(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="sales-filter-group">
                            <label><BranchIcon /> Branch / Warehouse</label>
                            <div className="sales-select-wrap">
                                <select className="sales-select" value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)}>
                                    {allowAllBranches ? <option value="">All Branches</option> : null}
                                    {branchOptions.map((b) => (
                                        <option key={b.id || b} value={b.id || b}>{b.name || b}</option>
                                    ))}
                                </select>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-9" /></svg>
                            </div>
                        </div>
                    </div>

                    <div className="db-toolbar-right">
                        <button
                            type="button"
                            className="sales-run-btn"
                            onClick={() => fetchSales(false, currentPage)}
                            disabled={loading || refreshing}
                        >
                            {refreshing && <div className="db-spinner" style={{ width: "16px", height: "16px", borderWidth: "2.5px" }} />}
                            <span>{refreshing ? "Analyzing..." : "Run Analysis"}</span>
                        </button>
                    </div>
                </section>

                {error && <div className="sales-error">{error}</div>}

                {loading && allSalesData.length === 0 ? (
                    <div className="sales-loading">
                        <div className="db-spinner db-spinner-lg"></div>
                        <p>Aggregating 90-day data from database...</p>
                    </div>
                ) : (
                    <>
                        <div className={`db-table-wrap ${refreshing ? "sales-table-loading" : ""}`} data-tour="main-table">
                            <table className="db-table db-table--fit">
                                <thead>
                                    <tr>
                                        <th rowSpan={2} style={{ verticalAlign: 'middle' }}>Inventory ID</th>
                                        <th rowSpan={2} style={{ verticalAlign: 'middle' }}>Branch</th>
                                        <th rowSpan={2} style={{ verticalAlign: 'middle', width: '300px' }}>Description</th>
                                        {periods.map(p => (
                                            <th key={p.key} colSpan={2} className="sales-centered-header">
                                                <div style={{ fontSize: "0.85rem" }}>{p.label}</div>
                                                <div style={{ fontSize: "0.65rem", fontWeight: "500", color: "var(--text-secondary)", marginTop: "2px" }}>{p.range}</div>
                                            </th>
                                        ))}
                                        <th rowSpan={2} className="db-num" style={{ verticalAlign: 'middle', fontWeight: '800' }}>90-DAY QTY</th>
                                        <th rowSpan={2} className="db-num" style={{ verticalAlign: 'middle', fontWeight: '800' }}>90-DAY SALES</th>
                                    </tr>
                                    <tr>
                                        {periods.map(p => (
                                            <Fragment key={`${p.key}-sub`}>
                                                <th className="db-num" style={{ background: 'var(--bg-main)', fontSize: '0.65rem' }}>QTY</th>
                                                <th className="db-num" style={{ background: 'var(--bg-surface)', fontSize: '0.65rem', borderLeft: '1px solid var(--border-light)' }}>SALES</th>
                                            </Fragment>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {salesData.length === 0 ? (
                                        <tr>
                                            <td colSpan={5 + (periods.length * 2)} className="sales-empty">
                                                <p>No data found for the 90-day period ending on {targetDate}.</p>
                                                <span>Try syncing more history or selecting a different date.</span>
                                            </td>
                                        </tr>
                                    ) : (
                                        salesData.map((row) => (
                                            <tr key={`${row.inventoryId}-${row.branchName}`}>
                                                <td><code className="db-inv-id">{row.inventoryId}</code></td>
                                                <td><span className="db-branch-tag">{row.branchName}</span></td>
                                                <td className="db-desc" style={{ fontSize: '0.8rem' }}>{row.description}</td>
                                                {periods.map(p => (
                                                    <Fragment key={p.key}>
                                                        <td className="db-num">{(row.monthlyData[p.key]?.qty || 0).toLocaleString()}</td>
                                                        <td className="db-num">₱{(row.monthlyData[p.key]?.sales || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}</td>
                                                    </Fragment>
                                                ))}
                                                <td className="db-num" style={{ fontWeight: '700' }}>
                                                    {row.totalQty.toLocaleString()}
                                                </td>
                                                <td className="db-num" style={{ fontWeight: '700' }}>
                                                    ₱{row.totalSales.toLocaleString(undefined, { minimumFractionDigits: 0 })}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {pagination.totalItems > 0 && (
                            <PaginationBar
                                page={currentPage}
                                pageSize={pageSize}
                                totalCount={pagination.totalItems}
                                onPageChange={setCurrentPage}
                                itemLabel="unique items"
                                disabled={refreshing}
                            />
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
