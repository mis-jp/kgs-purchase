"use client";

import { useEffect, useState, useCallback, useRef, memo } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { withBasePath } from "@/lib/base-path";
import PaginationBar from "@/components/PaginationBar";
import { loadAllBranchesAccess } from "@/lib/user-access-client";
import "@/styles/dashboard.css";

/* ── SVG Icons ─────────────────────────────────────────────── */
const IconBarChart = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
));
IconBarChart.displayName = "IconBarChart";

const IconLogout = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
));
IconLogout.displayName = "IconLogout";
const IconSearch = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
));
IconSearch.displayName = "IconSearch";
const IconChevron = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
    </svg>
));
IconChevron.displayName = "IconChevron";
const IconBox = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
));
IconBox.displayName = "IconBox";
const IconFilter = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
));
IconFilter.displayName = "IconFilter";
const IconRefresh = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
));
IconRefresh.displayName = "IconRefresh";
const IconDownload = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
));
IconDownload.displayName = "IconDownload";
const IconSync = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
));
IconSync.displayName = "IconSync";
const IconClose = memo(() => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
));
IconClose.displayName = "IconClose";

/* ── Constants ────────────────────────────────────────────── */
const ROWS_PER_PAGE = 10;
const LOW_STOCK_THRESHOLD = 10;
const EMPTY_GLOBAL_STATS = {
    totalStock: 0,
    totalValue: 0,
    lowStock: 0,
    totalLowStock: 0,
    outOfStock: 0,
    deadStock: 0,
    overstock: 0,
    damageStock: 0,
    damageCount: 0,
    lastSync: null,
};
const cellVal = (row, key) => {
    const val = row[key]?.value;
    if (val === null || val === undefined || val === "") return "—";
    if (typeof val === "object") return "—";
    return val;
};

const cellNum = (row, key) => {
    const val = row[key]?.value;
    if (val === null || val === undefined || val === "") return "—";
    const n = Number(val);
    return Number.isFinite(n) ? n.toLocaleString() : String(val);
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function locationErrorMessage(message) {
    const msg = String(message || "");
    if (/429|too many requests|acumatica is busy/i.test(msg)) {
        return "Acumatica is busy right now. Location details will load when the connection quiets down.";
    }
    return msg.replace(/\s*\(from https?:\/\/[^)]+\)/gi, "").trim() || "Failed to load locations";
}

/** Keep location lookups one-at-a-time so opening several rows does not flood Acumatica. */
const locationFetchQueue = [];
let locationFetchPump = null;

function enqueueLocationFetch(task) {
    return new Promise((resolve, reject) => {
        locationFetchQueue.push({ task, resolve, reject });
        if (!locationFetchPump) locationFetchPump = pumpLocationFetches();
    });
}

async function pumpLocationFetches() {
    while (locationFetchQueue.length) {
        const job = locationFetchQueue.shift();
        try {
            job.resolve(await job.task());
        } catch (err) {
            job.reject(err);
        }
        if (locationFetchQueue.length) await sleep(400);
    }
    locationFetchPump = null;
}

/* ── Table Row Component ───────────────────────────────────── */
const InventoryRow = memo(({ row, branch }) => {
    const [open, setOpen] = useState(false);
    const [locs, setLocs] = useState(null);
    const [locLoading, setLocLoading] = useState(false);
    const [locError, setLocError] = useState("");
    const [locNote, setLocNote] = useState("");
    const loadGen = useRef(0);

    useEffect(() => {
        loadGen.current += 1;
        setOpen(false);
        setLocs(null);
        setLocError("");
        setLocNote("");
        setLocLoading(false);
    }, [branch]);

    const onHand = Number(row.OnHand?.value);
    const onHandVal = Number.isFinite(onHand) ? onHand : NaN;
    let available = Number(row.Available?.value);
    if (!Number.isFinite(available) && Number.isFinite(onHandVal)) available = onHandVal;
    const stockClass = !Number.isFinite(onHandVal) || onHandVal <= 0
        ? "db-status-out"
        : onHandVal < LOW_STOCK_THRESHOLD
        ? "db-status-low"
        : "db-badge-green";

    const inventoryId = String(row.InventoryID?.value || "").trim();

    const loadLocations = async (gen, attempt) => {
        setLocLoading(true);
        setLocError("");
        if (attempt === 0) setLocNote("");
        try {
            const res = await enqueueLocationFetch(async () => {
                const params = new URLSearchParams({ inventoryId });
                if (branch) params.set("branch", branch);
                return fetchWithAuth(`/api/inventory/locations?${params}`);
            });
            if (gen !== loadGen.current) return;
            const data = await res.json().catch(() => ({}));
            const busy = res.status === 429 || /429|too many requests|acumatica is busy/i.test(String(data.message || ""));
            if (busy && attempt < 2) {
                setLocNote("Acumatica is busy. Trying again…");
                await sleep(4000 * (attempt + 1));
                if (gen !== loadGen.current) return;
                return loadLocations(gen, attempt + 1);
            }
            if (!res.ok) throw new Error(locationErrorMessage(data.message));
            setLocs(data.locations || []);
            setLocNote("");
            setLocLoading(false);
        } catch (err) {
            if (gen !== loadGen.current) return;
            setLocError(locationErrorMessage(err.message));
            setLocs([]);
            setLocNote("");
            setLocLoading(false);
        }
    };

    const toggle = (e) => {
        e.stopPropagation();
        const next = !open;
        setOpen(next);
        if (!next) {
            loadGen.current += 1;
            setLocLoading(false);
            setLocNote("");
            return;
        }
        if (locs !== null || !inventoryId) return;
        const gen = ++loadGen.current;
        loadLocations(gen, 0);
    };

    const locationSummary = () => {
        if (!open) return "Trace";
        if (locLoading) return "…";
        if (locError) return "Error";
        if (!locs?.length) return "None";
        if (locs.length === 1) return locs[0].locationId || locs[0].warehouseId;
        return `${locs.length} locs`;
    };

    return (
        <>
            <tr className={open ? "db-row-expanded" : undefined}>
                <td>
                    <button
                        type="button"
                        className={`db-expand-btn ${open ? "is-open" : ""}`}
                        onClick={toggle}
                        aria-expanded={open}
                        aria-label={`Locations for ${inventoryId || "item"}`}
                        title="Show warehouse locations"
                    >
                        <IconChevron />
                    </button>
                </td>
                <td><span className="db-inv-id">{cellVal(row, "InventoryID")}</span></td>
                <td className="db-desc">{cellVal(row, "Description")}</td>
                <td><span className="db-class-tag">{cellVal(row, "ItemClass") || cellVal(row, "Category")}</span></td>
                <td>
                    {cellVal(row, "Branch") !== "—" ? (
                        <span className="db-branch-tag">{cellVal(row, "Branch")}</span>
                    ) : (
                        "—"
                    )}
                </td>
                <td>
                    <button type="button" className="db-location-chip" onClick={toggle}>
                        {locationSummary()}
                    </button>
                </td>
                <td className="db-num">
                    {Number.isFinite(onHandVal) ? (
                        <span className={`db-badge ${stockClass}`}>{onHandVal.toLocaleString()}</span>
                    ) : (
                        cellNum(row, "OnHand")
                    )}
                </td>
                <td className="db-num">
                    {Number.isFinite(available) ? available.toLocaleString() : cellNum(row, "Available")}
                </td>
                <td className="db-num">{cellNum(row, "SafetyStock")}</td>
                <td className="db-num">{cellNum(row, "MOQ")}</td>
                <td>{cellVal(row, "VendorID")}</td>
            </tr>
            {open && (
                <tr className="db-location-detail-row">
                    <td colSpan={11}>
                        <div className="db-location-panel">
                            <div className="db-location-panel-head">
                                <strong>Locations</strong>
                                <span>Warehouse / bin on-hand from Acumatica Inventory Summary</span>
                            </div>
                            {locLoading ? (
                                <div className="db-location-empty">{locNote || "Loading locations…"}</div>
                            ) : locError ? (
                                <div className="db-location-empty db-location-error">{locError}</div>
                            ) : !locs?.length ? (
                                <div className="db-location-empty">No location rows returned for this item.</div>
                            ) : (
                                <table className="db-location-table">
                                    <thead>
                                        <tr>
                                            <th>Warehouse</th>
                                            <th>Location</th>
                                            <th className="db-num">On Hand</th>
                                            <th className="db-num">Available</th>
                                            <th>Type</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {locs.map((loc, idx) => (
                                            <tr key={`${loc.warehouseId}-${loc.locationId}-${idx}`}>
                                                <td>{loc.warehouseId}</td>
                                                <td>{loc.locationId}</td>
                                                <td className="db-num">{Number(loc.onHand || 0).toLocaleString()}</td>
                                                <td className="db-num">{Number(loc.available || 0).toLocaleString()}</td>
                                                <td>
                                                    {loc.isDamage ? (
                                                        <span className="db-badge db-status-low">Damage</span>
                                                    ) : (
                                                        <span className="db-badge db-badge-green">Stock</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
});
InventoryRow.displayName = "InventoryRow";

export default function DashboardPage() {
    /* ── State ────────────────────────────────────────────── */
    const [selectedBranch, setSelectedBranch] = useState("");
    const [allowAllBranches, setAllowAllBranches] = useState(false);
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [userName, setUserName] = useState("User");

    const [allInventory, setAllInventory] = useState([]);
    const [dataSource, setDataSource] = useState("mysql");
    const [totalCount, setTotalCount] = useState(0);
    const [globalStats, setGlobalStats] = useState({
        ...EMPTY_GLOBAL_STATS,
        count: 0,
    });
    const [activeFilter, setActiveFilter] = useState(null);
    const [hasMore, setHasMore] = useState(false);

    const [branchOptions, setBranchOptions] = useState([]);
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [companyLabel, setCompanyLabel] = useState("KGSC");
    const [filtersReady, setFiltersReady] = useState(false);

    const searchTimer = useRef(null);
    const statsAbortRef = useRef(null);
    const tableAbortRef = useRef(null);
    useEffect(() => {
        Promise.resolve().then(() => {
            const b = localStorage.getItem("db_filter_branch") || "";
            const s = localStorage.getItem("db_filter_search") || "";
            const p = parseInt(localStorage.getItem("db_filter_page") || "1");
            const u = localStorage.getItem("userName") || "User";

            if (b) setSelectedBranch(b);
            if (s) setSearch(s);
            if (p > 1) setPage(p);
            if (u !== "User") setUserName(u);
            setFiltersReady(true);
        });
    }, []);

    useEffect(() => {
        const loadCompany = () => {
            fetchWithAuth("/api/company")
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (!data) return;
                    const active = data.companies?.find((c) => c.id === data.activeCompanyId);
                    setCompanyLabel(active?.label || "KGSC");
                })
                .catch(() => {});
        };
        loadCompany();
        const onCompanyChange = () => {
            setPage(1);
            setAllInventory([]);
            loadCompany();
            setSelectedBranch("");
        };
        window.addEventListener("company-changed", onCompanyChange);
        return () => window.removeEventListener("company-changed", onCompanyChange);
    }, []);

    // Save filters to localStorage
    useEffect(() => {
        localStorage.setItem("db_filter_branch", selectedBranch);
        localStorage.setItem("db_filter_search", search);
        localStorage.setItem("db_filter_page", page.toString());
    }, [selectedBranch, search, page]);

    const handleBranchChange = (branchId) => {
        setSelectedBranch(branchId);
        setPage(1);
        setGlobalStats({ ...EMPTY_GLOBAL_STATS, count: 0 });
        setAllInventory([]);
        setTotalCount(0);
    };

    const handleExport = () => {
        setExporting(true);
        try {
            const params = new URLSearchParams({
                type: "inventory-levels",
                branch: selectedBranch || "",
                search: debouncedSearch || "",
            });
            window.location.href = withBasePath(`/api/export?${params}`);
        } catch (e) {
            console.error("Export failed", e);
        } finally {
            setTimeout(() => setExporting(false), 2000);
        }
    };

    /* ── Init Data ────────────────────────────────────────── */
    useEffect(() => {
        const fetchBranches = async () => {
            try {
                const res = await fetchWithAuth("/api/branches");
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (data?.value || []);
                    const options = list
                        .map(b => {
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

                    if (!selectedBranch || !options.some((b) => b.id === selectedBranch)) {
                        if (!allowAll) {
                            if (options[0]) setSelectedBranch(options[0].id);
                        } else {
                            const main = options.find(b => b.id.toUpperCase() === "MAIN") || options.find(b => b.id.toUpperCase().includes("MAIN"));
                            if (main) setSelectedBranch(main.id);
                        }
                    }
                }
            } catch (err) { console.error("Branch fetch error", err); }
        };
        fetchBranches();

        const onCompanyChange = () => fetchBranches();
        window.addEventListener("company-changed", onCompanyChange);
        return () => window.removeEventListener("company-changed", onCompanyChange);
    }, []);

    /* ── Fetch Data ───────────────────────────────────────── */
    const fetchInventoryTable = useCallback(async () => {
        if (tableAbortRef.current) tableAbortRef.current.abort();
        const ac = new AbortController();
        tableAbortRef.current = ac;
        setLoading(true);
        try {
            const dataParams = new URLSearchParams({
                page: String(page),
                pageSize: String(ROWS_PER_PAGE),
                search: debouncedSearch,
                branch: selectedBranch,
                count: "true",
                stats: "false",
                enrich: "false",
                source: "mysql",
            });

            const res = await fetchWithAuth(`/api/inventory?${dataParams.toString()}`, {
                signal: ac.signal,
            });
            if (ac.signal.aborted) return;
            if (res.ok) {
                const result = await res.json();
                if (ac.signal.aborted) return;
                setAllInventory(result.data || []);
                setDataSource(result.source || "mysql");
                setTotalCount(result.totalCount || 0);
                setHasMore(!!result.hasMore);
            }
        } catch (e) {
            if (e?.name === "AbortError") return;
            if (e.message !== "Unauthorized") console.error("Fetch error", e);
        }
        if (!ac.signal.aborted) setLoading(false);
    }, [page, debouncedSearch, selectedBranch]);

    const fetchInventoryStats = useCallback(async () => {
        if (statsAbortRef.current) statsAbortRef.current.abort();
        const ac = new AbortController();
        statsAbortRef.current = ac;
        setStatsLoading(true);
        try {
            const statsParams = new URLSearchParams({
                search: debouncedSearch,
                branch: selectedBranch,
                statsOnly: "true",
                source: "mysql",
            });

            const res = await fetchWithAuth(`/api/inventory?${statsParams.toString()}`, {
                signal: ac.signal,
            });
            if (ac.signal.aborted) return;
            if (res.ok) {
                const result = await res.json();
                if (ac.signal.aborted) return;
                if (result.globalStats) {
                    setGlobalStats(result.globalStats);
                    // Backfill DAMAGE / DISCOUNTED qty once when the card is still empty
                    if (
                        !result.globalStats.damageStock &&
                        typeof window !== "undefined" &&
                        !window.__kgsDamageSyncStarted
                    ) {
                        window.__kgsDamageSyncStarted = true;
                        fetchWithAuth("/api/inventory/damage-sync", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ limit: 120 }),
                        })
                            .then((r) => (r.ok ? r.json() : null))
                            .then((data) => {
                                if (!data || !(Number(data.damageStock) > 0)) return;
                                return fetchWithAuth(`/api/inventory?${statsParams.toString()}`);
                            })
                            .then((r) => (r && r.ok ? r.json() : null))
                            .then((fresh) => {
                                if (fresh?.globalStats && !ac.signal.aborted) {
                                    setGlobalStats(fresh.globalStats);
                                }
                            })
                            .catch(() => {});
                    }
                }
            }
        } catch (e) {
            if (e?.name === "AbortError") return;
            if (e.message !== "Unauthorized") console.error("Stats fetch error", e);
        }
        if (!ac.signal.aborted) setStatsLoading(false);
    }, [debouncedSearch, selectedBranch]);

    useEffect(() => {
        clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1);
        }, 300);
        return () => clearTimeout(searchTimer.current);
    }, [search]);

    useEffect(() => {
        if (!filtersReady) return;
        fetchInventoryTable();
    }, [filtersReady, page, debouncedSearch, selectedBranch, fetchInventoryTable]);

    useEffect(() => {
        if (!filtersReady) return;
        fetchInventoryStats();
    }, [filtersReady, debouncedSearch, selectedBranch, fetchInventoryStats]);

    const isStale = globalStats.lastSync && (new Date() - new Date(globalStats.lastSync)) > 86400000;

    /* ── Render ───────────────────────────────────────────── */
    return (
        <div className="db-root">
            <main className="db-main">
                <div className="db-page-title" data-tour="page-title">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <h1>Inventory</h1>
                        <span className="db-company-badge">{companyLabel}</span>
                        <span className={`db-data-source ${dataSource === "mysql" || dataSource === "mysql-catalog" ? "db-data-source-live" : "db-data-source-fallback"}`} suppressHydrationWarning>
                            {dataSource === "mysql"
                                ? "Live from MySQL"
                                : dataSource === "mysql-catalog"
                                ? "Product catalog"
                                : dataSource === "acumatica-live"
                                ? "Live from ERP"
                                : dataSource === "acumatica-fallback"
                                ? "Fallback: Live ERP"
                                : "Live from ERP"}
                        </span>
                    </div>
                    <p>View stock on hand, availability, and safety levels by item and branch.</p>
                    {globalStats.dataMode === "warehouse-missing" && (
                        <p className="db-catalog-hint">
                            Showing the product catalog from MySQL. Branch stock quantities are not loaded yet — run a full Inventory sync from Sync Center to populate on-hand and available totals.
                        </p>
                    )}
                </div>

                <div className="db-stats" data-tour="kpi-cards">
                <div className="db-stat-card">
                    <span className="db-stat-label">Total Stocks</span>
                    <span className="db-stat-value">{statsLoading ? "..." : (globalStats.totalStock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">{(globalStats.count ?? totalCount).toLocaleString()} products in {selectedBranch || "all branches"}</span>
                </div>
                <div className="db-stat-card">
                    <span className="db-stat-label">Total Value</span>
                    <span className="db-stat-value">{statsLoading ? "..." : `₱${(globalStats.totalValue || 0).toLocaleString("en-PH", { minimumFractionDigits: 0 })}`}</span>
                    <span className="db-stat-sub">Estimated inventory value</span>
                </div>
                <div className="db-stat-card db-stat-warn db-stat-clickable" onClick={() => setActiveFilter("low_stock")}>
                    <span className="db-stat-label">Low Stock (Units)</span>
                    <span className="db-stat-value">{(globalStats.totalLowStock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">{(globalStats.lowStock || 0)} products under {LOW_STOCK_THRESHOLD} units</span>
                </div>
                <div className="db-stat-card db-stat-danger db-stat-clickable" onClick={() => setActiveFilter("out_of_stock")}>
                    <span className="db-stat-label">Out of Stock</span>
                    <span className="db-stat-value">{(globalStats.outOfStock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">Zero units on hand</span>
                </div>
                <div className="db-stat-card db-stat-warn db-stat-clickable" onClick={() => setActiveFilter("dead_stock")}>
                    <span className="db-stat-label">Dead Stock</span>
                    <span className="db-stat-value">{(globalStats.deadStock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">Zero sales in 90 days</span>
                </div>
                <div className="db-stat-card db-stat-info db-stat-clickable" onClick={() => setActiveFilter("overstock")}>
                    <span className="db-stat-label">Overstock</span>
                    <span className="db-stat-value">{(globalStats.overstock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">{">"}180 days of supply</span>
                </div>
                <div className="db-stat-card db-stat-danger db-stat-clickable" onClick={() => setActiveFilter("damage")}>
                    <span className="db-stat-label">Damage</span>
                    <span className="db-stat-value">{statsLoading ? "..." : (globalStats.damageStock || 0).toLocaleString()}</span>
                    <span className="db-stat-sub">
                        {(globalStats.damageCount || 0).toLocaleString()} products in DAMAGE / DISCOUNTED
                        {" "}(excluded from other totals)
                    </span>
                </div>
                <div className={`db-stat-card ${isStale ? "db-stat-danger db-stat-stale" : "db-stat-info"}`}>
                    <span className="db-stat-label">Data Freshness</span>
                    <span className="db-stat-value db-stat-value-sm">
                        {globalStats.lastSync ? new Date(globalStats.lastSync).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Never"}
                    </span>
                    <span className="db-stat-sub">{isStale ? "Warning: Data is stale (>24h)" : "Last successful sync"}</span>
                </div>
                </div>

                <div className="db-toolbar db-toolbar--flat">
                    <div className="db-toolbar-left">
                        <div className="db-select-wrapper" data-tour="branch-filter">
                            <IconFilter />
                            <select className="db-select" value={selectedBranch} onChange={(e) => handleBranchChange(e.target.value)} aria-label="Branch filter">
                                {allowAllBranches ? <option value="">All Branches</option> : null}
                                {branchOptions.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}
                            </select>
                            <IconChevron />
                        </div>
                        <div className="db-search-wrapper">
                            <IconSearch />
                            <input className="db-search" type="search" placeholder="Search ID or description..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search inventory" />
                        </div>
                    </div>
                    <div className="db-toolbar-right">
                        <button
                            className="db-export-btn"
                            type="button"
                            onClick={handleExport}
                            disabled={exporting}
                        >
                            <IconDownload /> <span>{exporting ? "Exporting…" : "Export CSV"}</span>
                        </button>
                        <button className="db-refresh-btn" type="button" onClick={() => { fetchInventoryTable(); fetchInventoryStats(); }}><IconRefresh /> <span>Refresh</span></button>
                    </div>
                </div>

                <div className="db-table-section" data-tour="inventory-table">
                    <div className="db-table-section-header">
                        <h2>Inventory</h2>
                        <p>
                            {loading && allInventory.length > 0
                                ? "Updating the list…"
                                : "Stock records by inventory ID, branch, and quantity on hand."}
                        </p>
                    </div>
                    <div className="db-table-wrap">
                    {loading && allInventory.length === 0 ? (
                        <div className="db-loading"><div className="db-spinner" /><span>Loading inventory...</span></div>
                    ) : (
                        <table className="db-table db-table--inventory db-table--fit">
                            <thead>
                                <tr>
                                    <th className="db-col-expand" aria-label="Expand" />
                                    <th>Inventory ID</th>
                                    <th>Description</th>
                                    <th>Item Class</th>
                                    <th>Branch</th>
                                    <th>Location</th>
                                    <th className="db-num">On Hand</th>
                                    <th className="db-num">Available</th>
                                    <th className="db-num">Safety Stock</th>
                                    <th className="db-num">MOQ</th>
                                    <th>Supplier</th>
                                </tr>
                            </thead>
                            <tbody>
                                {allInventory.length === 0 ? (
                                    <tr>
                                        <td colSpan={11} className="db-empty-cell">
                                            No inventory records found. Try another branch or run a full Inventory sync.
                                        </td>
                                    </tr>
                                ) : allInventory.map((row, i) => (
                                    <InventoryRow
                                        key={`${row.InventoryID?.value ?? "row"}-${row.Branch?.value ?? ""}-${i}`}
                                        row={row}
                                        branch={selectedBranch}
                                    />
                                ))}
                            </tbody>
                        </table>
                    )}
                    </div>
                </div>

                {(!loading || allInventory.length > 0) && (
                    <PaginationBar
                        page={page}
                        pageSize={ROWS_PER_PAGE}
                        totalCount={totalCount}
                        hasMore={hasMore}
                        onPageChange={setPage}
                        itemLabel="items"
                    />
                )}

            </main>

            {activeFilter && (
                <FilteredStockModal
                    filter={activeFilter}
                    branch={selectedBranch}
                    onClose={() => setActiveFilter(null)}
                />
            )}
        </div>
    );
}

function FilteredStockModal({ filter, branch, onClose }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const title = filter === "low_stock" ? "Low Stock Items"
        : filter === "out_of_stock" ? "Out of Stock Items"
        : filter === "dead_stock" ? "Dead Stock (No sales in 90 days)"
        : filter === "overstock" ? "Overstock Items (Excessive Supply)"
        : filter === "damage" ? "Damage / Discounted Stock"
        : "Filtered Items";

    useEffect(() => {
        const fetchFiltered = async () => {
            setLoading(true);
            try {
                const params = new URLSearchParams({
                    page: "1",
                    pageSize: "100",
                    branch,
                    filter,
                    source: "mysql",
                });
                const res = await fetchWithAuth(`/api/inventory?${params}`);
                if (!res.ok) throw new Error("Failed to fetch filtered list");
                const result = await res.json();
                setItems(result.data || []);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };
        fetchFiltered();
    }, [filter, branch]);

    return (
        <div className="db-modal-overlay" onClick={onClose}>
            <div className="db-modal" style={{ maxWidth: "800px" }} onClick={(e) => e.stopPropagation()}>
                <div className="db-modal-header">
                    <h2 className="db-modal-title">{title}</h2>
                    <button className="db-modal-close" onClick={onClose}><IconClose /></button>
                </div>
                <div className="db-modal-body" style={{ padding: 0 }}>
                    {loading ? (
                        <div style={{ padding: "3rem", textAlign: "center" }}>
                            <div className="db-spinner" style={{ margin: "0 auto 1rem" }} />
                            <p style={{ fontWeight: "600", color: "var(--text-secondary)" }}>Loading items...</p>
                        </div>
                    ) : error ? (
                        <div style={{ padding: "3rem", textAlign: "center", color: "var(--status-danger)" }}>{error}</div>
                    ) : items.length === 0 ? (
                        <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>No items found for this filter.</div>
                    ) : (
                        <table className="db-table db-table--fit" style={{ fontSize: "0.85rem" }}>
                            <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                                <tr>
                                    <th style={{ padding: "1rem" }}>ID</th>
                                    <th>Description</th>
                                    <th className="db-num">On Hand</th>
                                    <th>Branch</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item, i) => (
                                    <tr key={i}>
                                        <td style={{ padding: "0.75rem 1rem" }}><span className="db-inv-id">{cellVal(item, "InventoryID")}</span></td>
                                        <td>{cellVal(item, "Description")}</td>
                                        <td className="db-num" style={{ fontWeight: "700" }}>
                                            <span className={Number(item.OnHand?.value) > 0 ? "db-badge db-badge-green" : "db-badge db-status-out"}>
                                                {Number(item.OnHand?.value).toLocaleString()}
                                            </span>
                                        </td>
                                        <td>{cellVal(item, "Branch")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
                <div className="db-modal-footer">
                    <button className="db-action-btn" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
