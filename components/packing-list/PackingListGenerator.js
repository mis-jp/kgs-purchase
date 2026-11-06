"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { packingLineKey } from "@/lib/packing-list";
import PoPickList from "./PoPickList";
import PackingListTable from "./PackingListTable";
import SavedPackingLists from "./SavedPackingLists";

const MANUAL_STORAGE_KEY = "po_packing_manual_qty";
const TRUCKING_FEE_STORAGE_KEY = "po_packing_trucking_fee";
const PAGE_SIZE = 50;
const LINES_CHUNK = 50;
const MAX_SELECTED = 200;

function localDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readManual() {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(localStorage.getItem(MANUAL_STORAGE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeManual(map) {
    try {
        localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(map));
    } catch {
        /* storage full or blocked: manual qty stays for this visit only */
    }
}

function readTruckingFee() {
    if (typeof window === "undefined") return "";
    try {
        return localStorage.getItem(TRUCKING_FEE_STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

async function readJson(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Could not load the packing list. Please try again.");
    return data;
}

function ordersUrl(query, page) {
    const sp = new URLSearchParams({
        mode: "orders",
        branch: query.branch,
        status: query.status,
        page: String(page),
        pageSize: String(PAGE_SIZE),
    });
    if (query.startDate) sp.set("startDate", query.startDate);
    if (query.endDate) sp.set("endDate", query.endDate);
    if (query.search) sp.set("search", query.search);
    return `/api/po/packing-list?${sp.toString()}`;
}

export default function PackingListGenerator({ branchOptions = [], allowAllBranches = false, defaultBranch = "" }) {
    const [branchPick, setBranchPick] = useState(defaultBranch || "");
    const [status, setStatus] = useState("active");
    const [startDate, setStartDate] = useState(() => localDate(new Date(new Date().getFullYear(), 0, 1)));
    const [endDate, setEndDate] = useState(() => localDate(new Date()));
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [reloadTick, setReloadTick] = useState(0);

    const [ordersResult, setOrdersResult] = useState({ key: "", orders: [], page: 1, hasMore: false, totalCount: 0, error: "" });
    const [loadingMore, setLoadingMore] = useState(false);

    const [selected, setSelected] = useState([]);
    const [linesCache, setLinesCache] = useState({});
    const [linesError, setLinesError] = useState({ key: "", message: "" });
    const [linesTick, setLinesTick] = useState(0);

    const [manual, setManual] = useState(readManual);
    const [truckingFee, setTruckingFee] = useState(readTruckingFee);

    const changeTruckingFee = (value) => {
        setTruckingFee(value);
        try {
            if (String(value).trim() === "") localStorage.removeItem(TRUCKING_FEE_STORAGE_KEY);
            else localStorage.setItem(TRUCKING_FEE_STORAGE_KEY, value);
        } catch {
            /* storage blocked: fee stays for this visit only */
        }
    };

    const branch = useMemo(() => {
        if (allowAllBranches) return branchPick;
        if (branchOptions.some((b) => b.id === branchPick)) return branchPick;
        return branchOptions[0]?.id || "";
    }, [allowAllBranches, branchOptions, branchPick]);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(t);
    }, [search]);

    const query = useMemo(
        () => ({ branch, status, startDate, endDate, search: debouncedSearch }),
        [branch, status, startDate, endDate, debouncedSearch]
    );
    const ordersKey = `${JSON.stringify(query)}#${reloadTick}`;

    useEffect(() => {
        if (!query.branch) return undefined;
        const controller = new AbortController();
        fetchWithAuth(ordersUrl(query, 1), { signal: controller.signal })
            .then(readJson)
            .then((data) => {
                setOrdersResult({
                    key: ordersKey,
                    orders: data.orders || [],
                    page: 1,
                    hasMore: Boolean(data.hasMore),
                    totalCount: data.totalCount ?? (data.orders || []).length,
                    error: "",
                });
            })
            .catch((err) => {
                if (controller.signal.aborted) return;
                setOrdersResult({ key: ordersKey, orders: [], page: 1, hasMore: false, totalCount: 0, error: err.message });
            });
        return () => controller.abort();
    }, [query, ordersKey]);

    const ordersCurrent = ordersResult.key === ordersKey;
    const ordersLoading = Boolean(branch) && !ordersCurrent;
    const orders = ordersCurrent ? ordersResult.orders : [];

    const loadMore = useCallback(async () => {
        if (!ordersCurrent || !ordersResult.hasMore || loadingMore) return;
        const nextPage = ordersResult.page + 1;
        setLoadingMore(true);
        try {
            const data = await readJson(await fetchWithAuth(ordersUrl(query, nextPage)));
            setOrdersResult((prev) => {
                if (prev.key !== ordersKey) return prev;
                const seen = new Set(prev.orders.map((o) => o.orderNbr));
                const more = (data.orders || []).filter((o) => !seen.has(o.orderNbr));
                return { ...prev, orders: [...prev.orders, ...more], page: nextPage, hasMore: Boolean(data.hasMore) };
            });
        } catch (err) {
            setOrdersResult((prev) => (prev.key === ordersKey ? { ...prev, error: err.message } : prev));
        } finally {
            setLoadingMore(false);
        }
    }, [ordersCurrent, ordersResult.hasMore, ordersResult.page, loadingMore, query, ordersKey]);

    const cacheKey = useCallback((orderNbr) => `${branch}|${orderNbr}`, [branch]);
    const missing = useMemo(
        () => selected.filter((nbr) => !linesCache[cacheKey(nbr)]),
        [selected, linesCache, cacheKey]
    );
    const missingKey = `${branch}|${missing.join(",")}#${linesTick}`;

    useEffect(() => {
        if (!branch || !missing.length) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                for (let i = 0; i < missing.length; i += LINES_CHUNK) {
                    const chunk = missing.slice(i, i + LINES_CHUNK);
                    const sp = new URLSearchParams({ mode: "lines", branch, orderNbrs: chunk.join(",") });
                    const data = await readJson(
                        await fetchWithAuth(`/api/po/packing-list?${sp.toString()}`, { signal: controller.signal })
                    );
                    const byOrder = Object.fromEntries(chunk.map((nbr) => [`${branch}|${nbr}`, []]));
                    for (const line of data.lines || []) {
                        const k = `${branch}|${line.orderNbr}`;
                        if (byOrder[k]) byOrder[k].push(line);
                    }
                    if (controller.signal.aborted) return;
                    setLinesCache((prev) => ({ ...prev, ...byOrder }));
                }
            } catch (err) {
                if (controller.signal.aborted) return;
                setLinesError({ key: missingKey, message: err.message });
            }
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [branch, missing, missingKey]);

    const linesFailed = linesError.key === missingKey ? linesError.message : "";
    const linesLoading = missing.length > 0 && !linesFailed;
    const lines = useMemo(
        () => selected.flatMap((nbr) => linesCache[cacheKey(nbr)] || []),
        [selected, linesCache, cacheKey]
    );

    const changeBranch = (value) => {
        setBranchPick(value);
        setSelected([]);
    };

    const toggleOrder = (orderNbr) => {
        setSelected((prev) => {
            if (prev.includes(orderNbr)) return prev.filter((n) => n !== orderNbr);
            if (prev.length >= MAX_SELECTED) return prev;
            return [...prev, orderNbr];
        });
    };

    const setAllLoaded = (checked) => {
        const loaded = orders.map((o) => o.orderNbr);
        setSelected((prev) => {
            if (!checked) return prev.filter((n) => !loaded.includes(n));
            const next = [...prev];
            for (const nbr of loaded) {
                if (next.length >= MAX_SELECTED) break;
                if (!next.includes(nbr)) next.push(nbr);
            }
            return next;
        });
    };

    const changeManual = (line, value) => {
        const key = packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId);
        setManual((prev) => {
            const next = { ...prev };
            if (String(value).trim() === "") delete next[key];
            else next[key] = value;
            writeManual(next);
            return next;
        });
    };

    const loadSaved = (list) => {
        const orders = (list.orderNbrs || []).slice(0, MAX_SELECTED);
        const prefixes = orders.map((nbr) => `${branch}|${nbr}|`);
        setSelected(orders);
        setManual((prev) => {
            const kept = Object.fromEntries(
                Object.entries(prev).filter(([k]) => !prefixes.some((p) => k.startsWith(p)))
            );
            const next = { ...kept, ...(list.manualQty || {}) };
            writeManual(next);
            return next;
        });
        changeTruckingFee(list.truckingFee == null ? "" : String(list.truckingFee));
    };

    const clearManual = () => {
        const keys = new Set(lines.map((l) => packingLineKey(branch, l.orderNbr, l.lineNbr, l.inventoryId)));
        setManual((prev) => {
            const next = Object.fromEntries(Object.entries(prev).filter(([k]) => !keys.has(k)));
            writeManual(next);
            return next;
        });
    };

    return (
        <section className="pl-root" aria-label="Packing List Generator">
            <div className="po-toolbar pl-toolbar">
                <div className="po-filter-group">
                    <span className="po-filter-label">Branch:</span>
                    <select
                        className="po-select-box"
                        value={branch}
                        onChange={(e) => changeBranch(e.target.value)}
                        aria-label="Packing list branch"
                    >
                        {allowAllBranches ? <option value="">Select a branch…</option> : null}
                        {branchOptions.map((b) => (
                            <option key={b.id} value={b.id}>
                                {b.name && b.name !== b.id ? `${b.id} — ${b.name}` : b.id}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="po-filter-group">
                    <span className="po-filter-label">Status:</span>
                    <select
                        className="po-select-box"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                        aria-label="Packing list PO status"
                    >
                        <option value="active">Active (Open + On Hold + Pending Approval)</option>
                        <option value="">All Statuses</option>
                        <option value="Open">Open</option>
                        <option value="On Hold">On Hold</option>
                        <option value="Pending Approval">Pending Approval</option>
                        <option value="Completed">Completed</option>
                        <option value="Closed">Closed</option>
                    </select>
                </div>
                <div className="po-filter-group">
                    <span className="po-filter-label">From:</span>
                    <input
                        type="date"
                        className="po-select-box pl-date"
                        value={startDate}
                        max={endDate || undefined}
                        onChange={(e) => setStartDate(e.target.value)}
                        aria-label="Order date from"
                    />
                </div>
                <div className="po-filter-group">
                    <span className="po-filter-label">To:</span>
                    <input
                        type="date"
                        className="po-select-box pl-date"
                        value={endDate}
                        min={startDate || undefined}
                        onChange={(e) => setEndDate(e.target.value)}
                        aria-label="Order date to"
                    />
                </div>
            </div>

            <SavedPackingLists
                branch={branch}
                selected={selected}
                manual={manual}
                truckingFee={truckingFee}
                onLoad={loadSaved}
            />

            {!branch ? (
                <div className="pl-empty pl-empty-wide">Pick a branch to see its purchase orders.</div>
            ) : (
                <div className="pl-layout">
                    <PoPickList
                        orders={orders}
                        totalCount={ordersCurrent ? ordersResult.totalCount : 0}
                        loading={ordersLoading}
                        loadingMore={loadingMore}
                        error={ordersCurrent ? ordersResult.error : ""}
                        hasMore={ordersCurrent && ordersResult.hasMore}
                        selected={selected}
                        maxSelected={MAX_SELECTED}
                        search={search}
                        onSearch={setSearch}
                        onToggle={toggleOrder}
                        onSetAll={setAllLoaded}
                        onClearSelection={() => setSelected([])}
                        onLoadMore={loadMore}
                        onRetry={() => setReloadTick((n) => n + 1)}
                    />
                    <PackingListTable
                        branch={branch}
                        lines={lines}
                        selectedCount={selected.length}
                        loading={linesLoading}
                        error={linesFailed}
                        onRetry={() => setLinesTick((n) => n + 1)}
                        manual={manual}
                        onManualChange={changeManual}
                        onClearManual={clearManual}
                        truckingFee={truckingFee}
                        onTruckingFeeChange={changeTruckingFee}
                    />
                </div>
            )}
        </section>
    );
}
