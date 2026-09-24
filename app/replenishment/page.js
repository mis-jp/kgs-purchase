"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { buildReplenishmentInsight, TARGET_DAYS_OF_COVER } from "@/lib/replenishment-insights";
import PaginationBar from "@/components/PaginationBar";
import { isLocalAdminUser } from "@/lib/user-access-client";
import "@/styles/dashboard.css";
import "@/styles/inventory-detail.css";
import "@/styles/replenishment.css";

const PAGE_SIZE = 10;

const IconSearch = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);
const IconFilter = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
);
const IconChevronRight = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);
const IconChevronLeft = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
    </svg>
);
const IconChevron = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);
const IconSparkles = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
);
const IconInfo = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
);
const IconDownload = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);
const IconClose = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

function ColumnInfoHeader({ label, title, panelId, openId, setOpenId, align = "left", children }) {
    const open = openId === panelId;
    const wrapRef = useRef(null);
    const btnRef = useRef(null);
    const [panelPos, setPanelPos] = useState(null);
    const accessibleName = title || (typeof label === "string" ? label : panelId);

    const updatePanelPos = useCallback(() => {
        if (!btnRef.current) return;
        const rect = btnRef.current.getBoundingClientRect();
        const panelWidth = Math.min(360, window.innerWidth - 24);
        let left = align === "right" ? rect.right - panelWidth : rect.left;
        left = Math.max(12, Math.min(left, window.innerWidth - panelWidth - 12));
        setPanelPos({
            top: rect.bottom + 6,
            left,
            width: panelWidth,
        });
    }, [align]);

    useEffect(() => {
        if (!open) {
            setPanelPos(null);
            return;
        }
        updatePanelPos();
        window.addEventListener("resize", updatePanelPos);
        window.addEventListener("scroll", updatePanelPos, true);
        return () => {
            window.removeEventListener("resize", updatePanelPos);
            window.removeEventListener("scroll", updatePanelPos, true);
        };
    }, [open, updatePanelPos]);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (ev) => {
            if (wrapRef.current && !wrapRef.current.contains(ev.target)) {
                setOpenId(null);
            }
        };
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
    }, [open, setOpenId]);

    return (
        <span className={`repl-col-head ${align === "right" ? "repl-col-head-right" : ""}`}>
            <span className="repl-col-head-label">{label}</span>
            <span className="repl-col-info-wrap" ref={wrapRef}>
                <button
                    ref={btnRef}
                    type="button"
                    className="repl-col-info-btn"
                    aria-label={`How ${accessibleName} is calculated`}
                    aria-expanded={open}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpenId(open ? null : panelId);
                    }}
                >
                    <IconInfo />
                </button>
                {open && panelPos && (
                    <div
                        className="repl-col-info-panel repl-col-info-panel-fixed"
                        role="dialog"
                        style={{
                            top: panelPos.top,
                            left: panelPos.left,
                            width: panelPos.width,
                        }}
                    >
                        {children}
                    </div>
                )}
            </span>
        </span>
    );
}

function priorityLabel(level, suggestedQty = null) {
    if (level === "High") return "Urgent";
    if (level === "Medium") return "Soon";
    // "Low" was read as "low stock" when Order qty is 0 — use OK when no order is needed.
    if (suggestedQty != null && Number(suggestedQty) <= 0) return "OK";
    return "Low";
}

function priorityClass(level) {
    if (level === "High") return "repl-status-urgent";
    if (level === "Medium") return "repl-status-soon";
    return "repl-status-low";
}

function fmtNum(n) {
    const val = Number(n);
    if (Number.isNaN(val)) return "—";
    return val % 1 === 0 ? val.toLocaleString() : val.toFixed(1);
}

/** Order qty is always whole units (ceil need, floor surplus). */
function toWholeOrderQty(n) {
    const e = Number(n);
    if (!Number.isFinite(e) || e === 0) return 0;
    if (e > 0) return Math.ceil(e);
    return Math.floor(e);
}

function fmtWhole(n) {
    return toWholeOrderQty(n).toLocaleString();
}

/** Cache often serves slim rows without howItWorks.steps — rebuild so Explain always has content. */
function resolveAiInsights(rec) {
    const existing = rec?.aiInsights || {};
    if (existing.howItWorks?.steps?.length && existing.headline && existing.summary) {
        return existing;
    }

    const ads = Number(existing.salesVelocity) || 0;
    const rawDays = existing.daysRemaining;
    const hasSalesHistory = rawDays !== "N/A" && rawDays != null && ads > 0;
    const daysRemaining = hasSalesHistory ? Number(rawDays) || 0 : 0;
    const currentStock = Number(rec.currentStock ?? rec.mainInventory) || 0;
    const suggestedQty = Number(rec.suggestedQty) || 0;
    const comingPoQty = Number(rec.comingPO) || 0;
    const branchId = rec.branchId || (rec.isMainWarehouseView ? "MAIN" : "");
    const rebuilt = buildReplenishmentInsight({
        itemId: rec.itemId,
        description: rec.description,
        currentStock,
        suggestedQty,
        priorityLevel: rec.priorityLevel || "Low",
        branchId,
        ads,
        daysRemaining,
        leadTimeDays: rec.leadTimeDays ?? existing.leadTimeDays ?? 0,
        vendorId: rec.vendorId || existing.vendorId || null,
        hasSalesHistory,
        qtySold90: Number(rec.qtySold90) || 0,
        targetStock: ads * TARGET_DAYS_OF_COVER,
        salesScope: rec.salesScope || existing.salesScope || "branch",
        comingPoQty,
        mainWarehouseContext: rec.isMainWarehouseView
            ? {
                branchOrderQty: Number(rec.branchOrderQty ?? rec.totalBranchReplenishment) || 0,
                comingPO: Number(rec.comingPO) || 0,
                totalBranchReplenishment: Number(rec.totalBranchReplenishment ?? rec.branchOrderQty) || 0,
                vendorOrderQty: Number(rec.vendorOrderQty ?? rec.aiInsights?.mainWarehouseContext?.vendorOrderQty) || 0,
                mainTargetStock: Number(rec.mainTargetStock ?? rec.aiInsights?.mainWarehouseContext?.mainTargetStock) || 0,
                vendorShortfall: Math.max(
                    0,
                    (Number(rec.totalBranchReplenishment ?? rec.branchOrderQty) || 0)
                        - (Number(rec.mainInventory ?? rec.currentStock) || 0)
                ),
            }
            : null,
    });

    return {
        ...rebuilt,
        ...existing,
        headline: existing.headline || rebuilt.headline,
        summary: existing.summary || rebuilt.summary,
        whatToDo: existing.whatToDo || rebuilt.whatToDo,
        formula: existing.formula || rebuilt.formula,
        metrics: existing.metrics?.length ? existing.metrics : rebuilt.metrics,
        howItWorks: {
            preview: existing.howItWorks?.preview || rebuilt.howItWorks.preview,
            steps: existing.howItWorks?.steps?.length
                ? existing.howItWorks.steps
                : rebuilt.howItWorks.steps,
        },
    };
}

function AiExplainLightbox({ rec, onClose }) {
    useEffect(() => {
        if (!rec) return undefined;
        const onKey = (e) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [rec, onClose]);

    if (!rec) return null;

    const ai = resolveAiInsights(rec);
    const how = ai.howItWorks || {};
    const steps = how.steps || [];
    const explanation = [ai.headline, ai.summary].filter(Boolean).join(" — ")
        || how.preview
        || ai.message
        || "";

    return (
        <div className="idm-overlay" onClick={onClose} role="presentation">
            <div
                className="idm-modal repl-ai-lightbox"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="repl-ai-lightbox-title"
            >
                <button type="button" className="idm-close-btn" onClick={onClose} aria-label="Close">
                    <IconClose />
                </button>

                <div className="idm-content repl-ai-lightbox-content">
                    <div className="repl-ai-lightbox-header">
                        <div className="repl-ai-lightbox-icon">
                            <IconSparkles />
                        </div>
                        <div>
                            <h2 id="repl-ai-lightbox-title">AI Explanation</h2>
                            <p>
                                <span className="repl-product-id">{rec.itemId}</span>
                                {rec.description ? ` · ${rec.description}` : ""}
                            </p>
                        </div>
                    </div>

                    {explanation && (
                        <section className="repl-ai-lightbox-section">
                            <h3>Explanation</h3>
                            <p className="repl-ai-lightbox-preview">{explanation}</p>
                        </section>
                    )}

                    {(ai.whatToDo || rec.restockSource) && (
                        <section className="repl-ai-lightbox-section">
                            <h3>Recommended action</h3>
                            <p>{ai.whatToDo || rec.restockSource}</p>
                        </section>
                    )}

                    {ai.formula && (
                        <section className="repl-ai-lightbox-section">
                            <h3>Formula</h3>
                            <p className="repl-ai-lightbox-formula">{ai.formula}</p>
                        </section>
                    )}

                    {ai.metrics?.length > 0 && (
                        <section className="repl-ai-lightbox-section">
                            <h3>Key figures</h3>
                            <ul className="repl-ai-metrics">
                                {ai.metrics.map((m) => (
                                    <li key={m.label}>
                                        <strong>{m.label}</strong>
                                        <span>{m.value}</span>
                                        {m.hint ? <em>{m.hint}</em> : null}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <section className="repl-ai-lightbox-section">
                        <h3>How it was calculated</h3>
                        {steps.length > 0 ? (
                            <ol className="repl-ai-steps">
                                {steps.map((step) => (
                                    <li key={step.title}>
                                        <strong>{step.title}</strong>
                                        <p>{step.text}</p>
                                    </li>
                                ))}
                            </ol>
                        ) : (
                            <p className="repl-ai-lightbox-empty">
                                No detailed steps for this row — stock is sufficient or no order is suggested.
                            </p>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}

function orderQtyRefId(branchId, itemId) {
    return `${String(branchId || "").trim().toUpperCase()}|${String(itemId || "").trim().toUpperCase()}`;
}

function ReplenishmentRows({ recs, onExplain, explainId, isMain, drafts, onOrderQtyChange }) {
    return recs.map((rec) => {
        const ai = rec.aiInsights || {};
        const how = ai.howItWorks || {};
        const days = ai.daysRemaining;
        const ads = ai.salesVelocity;
        const hasSales = days !== "N/A" && days != null;
        const isOpen = explainId === rec.recommendationId;
        const leadTime = rec.leadTimeDays ?? ai.leadTimeDays;
        const orderQty = drafts[rec.itemId] !== undefined
            ? toWholeOrderQty(drafts[rec.itemId])
            : toWholeOrderQty(rec.suggestedQty);
        const ltNum = Number(leadTime) || 0;
        const orderQtyWithLeadTime = ltNum > 0 && orderQty > 0 ? Math.round(ltNum * orderQty) : 0;
        const branchReplTotal = Number(rec.totalBranchReplenishment ?? rec.branchOrderQty ?? 0) || 0;
        const mainStock = Number(rec.mainInventory ?? rec.currentStock ?? 0) || 0;
        const comingPo = Number(rec.comingPO ?? 0) || 0;
        const aiPreview = isMain && branchReplTotal > 0
            ? `Branches need ${fmtNum(branchReplTotal)} units; MAIN has ${fmtNum(mainStock)} + ${fmtNum(comingPo)} incoming.`
            : (how.preview || (hasSales && ads
                ? `${fmtNum(mainStock || rec.currentStock)} on hand · ${fmtNum(ads)}/day`
                : null));

        return (
            <tr key={rec.recommendationId} className={`repl-row ${priorityClass(rec.priorityLevel)}`}>
                <td>
                    <span className={`repl-badge ${priorityClass(rec.priorityLevel)} ${Number(rec.suggestedQty) <= 0 ? "repl-badge-ok" : ""}`}>
                        {priorityLabel(rec.priorityLevel, rec.suggestedQty)}
                    </span>
                </td>
                <td>
                    <div className="repl-product-id">{rec.itemId}</div>
                    <div className="repl-product-desc">{rec.description || "—"}</div>
                </td>
                {isMain ? (
                    <>
                        <td className="repl-num">{fmtNum(rec.mainInventory ?? rec.currentStock)}</td>
                        <td className="repl-num">{fmtNum(rec.comingPO ?? 0)}</td>
                        <td className="repl-num">{fmtNum(rec.totalBranchReplenishment ?? rec.branchOrderQty ?? 0)}</td>
                    </>
                ) : (
                    <>
                        <td className="repl-num">{fmtNum(rec.currentStock)}</td>
                        <td className="repl-num">{fmtNum(rec.comingPO ?? 0)}</td>
                    </>
                )}
                {!isMain ? (
                    <td className="repl-num">{hasSales ? fmtNum(ads) : "—"}</td>
                ) : null}
                <td className="repl-num">{hasSales ? `${fmtNum(days)} days` : "—"}</td>
                <td className="repl-num">{ltNum > 0 ? `${fmtNum(ltNum)} days` : "—"}</td>
                <td className="repl-num repl-order-qty">
                    <input
                        className="repl-qty-input"
                        type="number"
                        step="1"
                        value={
                            drafts[rec.itemId] !== undefined
                                ? drafts[rec.itemId]
                                : toWholeOrderQty(rec.suggestedQty)
                        }
                        onChange={(e) => onOrderQtyChange(rec, e.target.value)}
                        aria-label={`Order qty for ${rec.itemId}`}
                    />
                    {toWholeOrderQty(rec.suggestedQty) !== 0 ? (
                        <span className={`repl-qty-suggested ${toWholeOrderQty(rec.suggestedQty) < 0 ? "repl-qty-surplus" : ""}`}>
                            Suggested {fmtWhole(rec.suggestedQty)}
                        </span>
                    ) : null}
                </td>
                <td className="repl-num">
                    {orderQtyWithLeadTime > 0 ? fmtWhole(orderQtyWithLeadTime) : "—"}
                </td>
                <td className="repl-action">{ai.whatToDo || rec.restockSource}</td>
                <td className="repl-ai-cell">
                    <p className="repl-ai-preview">{aiPreview || "Tap Explain to see how this was calculated."}</p>
                    <button
                        type="button"
                        className={`repl-ai-btn ${isOpen ? "open" : ""}`}
                        onClick={() => onExplain(rec)}
                        aria-haspopup="dialog"
                        aria-expanded={isOpen}
                    >
                        <IconSparkles />
                        Explain
                    </button>
                </td>
            </tr>
        );
    });
}

export default function ReplenishmentPage() {
    const [recs, setRecs] = useState([]);
    const [brief, setBrief] = useState(null);
    const [meta, setMeta] = useState(null);
    const [branches, setBranches] = useState([]);
    const [viewMode, setViewMode] = useState("main");
    const [selectedBranch, setSelectedBranch] = useState("");
    const [priorityFilter, setPriorityFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [itemClassFilter, setItemClassFilter] = useState("");
    const [loading, setLoading] = useState(true);
    const [pageLoading, setPageLoading] = useState(false);
    const [error, setError] = useState(null);
    const [itemClasses, setItemClasses] = useState([]);
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [aiExplainRec, setAiExplainRec] = useState(null);
    const [openColumnInfo, setOpenColumnInfo] = useState(null);
    const [page, setPage] = useState(1);
    const [orderQtyDrafts, setOrderQtyDrafts] = useState({});
    const [qtySaveHint, setQtySaveHint] = useState("");
    const [salesMonths, setSalesMonths] = useState("3");
    const [salesUnit, setSalesUnit] = useState("months");
    const [savingWindow, setSavingWindow] = useState(false);
    const [windowNotice, setWindowNotice] = useState("");
    const isAdmin = isLocalAdminUser();
    const fetchGenRef = useRef(0);
    const listKeyRef = useRef("");
    const saveTimers = useRef({});
    const pendingSaves = useRef({});
    const closeAiExplain = useCallback(() => setAiExplainRec(null), []);

    const retailBranches = useMemo(
        () => branches.filter((b) => {
            const id = String(b.SiteID || b.branch_id || "").trim();
            return id && id !== "MAIN" && id !== "__catalog__";
        }),
        [branches]
    );
    const canAccessMain = useMemo(() => {
        if (isLocalAdminUser()) return true;
        return branches.some((b) => String(b.SiteID || b.branch_id || "").toUpperCase() === "MAIN");
    }, [branches]);

    const activeBranch = viewMode === "main" ? "MAIN" : selectedBranch;
    const isMain = viewMode === "main";

    const applyPayload = useCallback((data) => {
        const list = Array.isArray(data) ? data : (data?.recommendations ?? []);
        setRecs(list);
        setBrief(data?.brief ?? null);
        setMeta(data?.meta ?? null);
        if (Array.isArray(data?.meta?.itemClasses)) {
            setItemClasses(data.meta.itemClasses);
        }
    }, []);

    const buildQueryString = useCallback(({
        pageNum = 1,
        searchText = "",
        priority = "all",
        itemClass = "",
        forceRefresh = false,
        pageSize = PAGE_SIZE,
    } = {}) => {
        const qs = new URLSearchParams();
        qs.set("page", String(pageNum));
        qs.set("pageSize", String(pageSize));
        const q = String(searchText || "").trim();
        if (q) qs.set("search", q);
        if (priority && priority !== "all") qs.set("priority", priority);
        if (itemClass) qs.set("itemClass", itemClass);
        if (forceRefresh) qs.set("refresh", "1");
        return `&${qs.toString()}`;
    }, []);

    const fetchRecommendations = useCallback(async ({
        branchToFetch = activeBranch,
        pageNum = 1,
        searchText = debouncedSearch,
        priority = priorityFilter,
        itemClass = itemClassFilter,
        forceRefresh = false,
        isInitial = false,
    } = {}) => {
        if (!branchToFetch) return;
        const gen = ++fetchGenRef.current;
        if (isInitial) {
            setLoading(true);
            setRecs([]);
            setBrief(null);
            setMeta(null);
        } else {
            setPageLoading(true);
        }
        setError(null);

        try {
            const qs = buildQueryString({
                pageNum,
                searchText,
                priority,
                itemClass,
                forceRefresh,
            });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);
            const res = await fetchWithAuth(
                `/api/replenishment?branch=${encodeURIComponent(branchToFetch)}${qs}`,
                { signal: controller.signal }
            );
            clearTimeout(timeout);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || `HTTP ${res.status}`);
            }
            const data = await res.json();
            if (gen !== fetchGenRef.current) return;
            applyPayload(data);
        } catch (err) {
            if (err.message === "Unauthorized") return;
            if (err.name === "AbortError") {
                setError("Request timed out. Try Refresh, or run Full Daily Refresh in Sync Center.");
            } else {
                setError(err.message || "Failed to load recommendations.");
            }
        } finally {
            if (gen === fetchGenRef.current) {
                setLoading(false);
                setPageLoading(false);
            }
        }
    }, [
        activeBranch,
        applyPayload,
        buildQueryString,
        debouncedSearch,
        priorityFilter,
        itemClassFilter,
    ]);

    useEffect(() => {
        const savedView = localStorage.getItem("repl_view_mode");
        const savedBranch = localStorage.getItem("repl_selected_branch") || "";
        const savedSearch = localStorage.getItem("repl_search");
        const savedClass = localStorage.getItem("repl_item_class");
        const savedPriority = localStorage.getItem("repl_priority");
        if (savedView === "main" || savedView === "branch") {
            setViewMode(savedView);
        } else if (savedBranch === "MAIN") {
            setViewMode("main");
        } else if (savedBranch) {
            setViewMode("branch");
            setSelectedBranch(savedBranch);
        }
        if (savedSearch) setSearch(savedSearch);
        if (savedClass) setItemClassFilter(savedClass);
        if (savedPriority === "all" || savedPriority === "soon" || savedPriority === "urgent") {
            setPriorityFilter(savedPriority);
        }
    }, []);

    useEffect(() => {
        localStorage.setItem("repl_view_mode", viewMode);
        if (viewMode === "branch" && selectedBranch) {
            localStorage.setItem("repl_selected_branch", selectedBranch);
        }
        localStorage.setItem("repl_search", search);
        localStorage.setItem("repl_item_class", itemClassFilter);
        localStorage.setItem("repl_priority", priorityFilter);
    }, [viewMode, selectedBranch, search, itemClassFilter, priorityFilter]);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await fetchWithAuth("/api/admin/replenishment-window");
                if (!res.ok || !active) return;
                const data = await res.json();
                if (data?.value || data?.months) {
                    setSalesMonths(String(data.value ?? data.months));
                    setSalesUnit(data.unit === "days" ? "days" : "months");
                }
            } catch {
                /* keep the 3-month default */
            }
        })();
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let active = true;

        (async () => {
            try {
                const res = await fetchWithAuth("/api/branches");
                if (res.ok && active) {
                    const list = await res.json();
                    setBranches(list);
                    const hasMain = (list || []).some(
                        (b) => String(b.SiteID || b.branch_id || "").toUpperCase() === "MAIN"
                    );
                    if (!isLocalAdminUser() && !hasMain) {
                        setViewMode("branch");
                    }
                }
            } catch (err) {
                console.error("Failed to load branches", err);
            }
        })();
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (viewMode !== "branch" || selectedBranch || retailBranches.length === 0) return;
        setSelectedBranch(retailBranches[0].SiteID || retailBranches[0].branch_id || "");
    }, [viewMode, selectedBranch, retailBranches]);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        setPage(1);
        closeAiExplain();
    }, [viewMode, selectedBranch, debouncedSearch, priorityFilter, itemClassFilter, closeAiExplain]);

    const listKey = `${activeBranch}|${debouncedSearch}|${priorityFilter}|${itemClassFilter}`;

    useEffect(() => {
        if (!activeBranch) return undefined;
        const filterChanged = listKeyRef.current !== listKey;
        listKeyRef.current = listKey;
        const pageNum = filterChanged ? 1 : page;
        if (filterChanged && page !== 1) {
            setPage(1);
        }
        fetchRecommendations({
            branchToFetch: activeBranch,
            pageNum,
            searchText: debouncedSearch,
            isInitial: loading && recs.length === 0,
        });
    }, [activeBranch, page, listKey, debouncedSearch, fetchRecommendations]);

    useEffect(() => {
        const onCompanyChange = () => {
            if (activeBranch) {
                setPage(1);
                fetchRecommendations({
                    branchToFetch: activeBranch,
                    pageNum: 1,
                    isInitial: true,
                });
            }
        };
        window.addEventListener("company-changed", onCompanyChange);
        return () => window.removeEventListener("company-changed", onCompanyChange);
    }, [fetchRecommendations, activeBranch]);

    useEffect(() => {
        if (!activeBranch) return undefined;
        let cancelled = false;
        setOrderQtyDrafts({});
        (async () => {
            try {
                const res = await fetchWithAuth("/api/annotations?module=replenishment");
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                const branchKey = String(activeBranch).trim().toUpperCase();
                const next = {};
                for (const [refId, fields] of Object.entries(data || {})) {
                    if (!refId.startsWith(`${branchKey}|`)) continue;
                    const itemId = refId.slice(branchKey.length + 1);
                    if (!itemId) continue;
                    if (fields.orderQty === undefined || fields.orderQty === null || fields.orderQty === "") continue;
                    next[itemId] = String(fields.orderQty);
                }
                setOrderQtyDrafts(next);
            } catch {
                /* ignore */
            }
        })();
        return () => { cancelled = true; };
    }, [activeBranch]);

    const persistOrderQty = useCallback((rec, value) => {
        const itemId = rec.itemId;
        const branchId = rec.branchId || activeBranch;
        const refId = orderQtyRefId(branchId, itemId);
        if (saveTimers.current[refId]) clearTimeout(saveTimers.current[refId]);
        pendingSaves.current[refId] = { refId, fieldValue: value };
        setQtySaveHint("Saving…");
        saveTimers.current[refId] = setTimeout(async () => {
            try {
                await fetchWithAuth("/api/annotations", {
                    method: "POST",
                    body: JSON.stringify({
                        module: "replenishment",
                        refId,
                        fieldKey: "orderQty",
                        fieldValue: value,
                    }),
                });
                delete pendingSaves.current[refId];
                setQtySaveHint("Saved");
            } catch (err) {
                console.error("Failed to save replenishment order qty", err);
                setQtySaveHint("Save failed");
            }
        }, 500);
    }, [activeBranch]);

    const handleOrderQtyChange = useCallback((rec, value) => {
        setOrderQtyDrafts((prev) => ({ ...prev, [rec.itemId]: value }));
        persistOrderQty(rec, value);
    }, [persistOrderQty]);

    useEffect(() => () => {
        Object.values(saveTimers.current).forEach((t) => clearTimeout(t));
        Object.values(pendingSaves.current).forEach(({ refId, fieldValue }) => {
            fetchWithAuth("/api/annotations", {
                method: "POST",
                body: JSON.stringify({
                    module: "replenishment",
                    refId,
                    fieldKey: "orderQty",
                    fieldValue,
                }),
            }).catch(() => {});
        });
    }, []);

    const stats = useMemo(() => {
        const metaStats = meta?.stats;
        const urgent = metaStats?.urgent ?? 0;
        const soon = metaStats?.soon ?? 0;
        const totalSuggested = metaStats?.totalSuggested ?? 0;
        const totalItems = meta?.pagination?.totalItems ?? meta?.itemCount ?? recs.length;
        return { urgent, soon, totalSuggested, totalItems };
    }, [meta, recs.length]);

    const itemClassOptions = useMemo(
        () => [...itemClasses].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        [itemClasses]
    );

    const totalPages = meta?.pagination?.totalPages ?? 1;
    const totalCount = meta?.pagination?.totalItems ?? meta?.itemCount ?? recs.length;

    const isSearchLoading = useMemo(() => {
        const typed = search.trim();
        const applied = debouncedSearch.trim();
        const debouncePending = typed !== applied;
        const fetchPending = pageLoading && (typed.length > 0 || applied.length > 0);
        return debouncePending || fetchPending;
    }, [search, debouncedSearch, pageLoading]);

    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [page, totalPages]);

    const branchKey = String(selectedBranch || "").trim().toUpperCase();
    const isWarehouseSite = ["MNL-MRILAO", "MNL CAL WH", "WH1", "MAIN WH11", "MAIN2"].includes(branchKey)
        || branchKey.includes(" WH")
        || /\bWH\d+\b/.test(branchKey);
    const branchHint = isMain
        ? "MAIN warehouse: Coming PO counts open (non–On Hold) purchase orders destined for MAIN only. Order qty = Sells/day − (stock + Coming PO)."
        : selectedBranch
            ? branchKey === "MANILA"
                ? "For MANILA: stock and Coming PO include related Manila warehouses (MANILA, WH1, MNL CAL WH, MNL-MRILAO). Sales stay on the MANILA POS branch. Order qty = Sells/day − (stock + Coming PO)."
                : isWarehouseSite
                    ? `For ${selectedBranch}: Sells/day uses invoices posted to this warehouse site only (not full parent POS). Prefer parent branch (e.g. MANILA) for metro demand. Order qty = Sells/day − (stock + Coming PO).`
                    : `For ${selectedBranch}: Coming PO counts open (non–On Hold) POs for this branch. Order qty = Sells/day − (stock + Coming PO). Request transfers from MAIN when Order qty is positive.`
            : "Select a branch to view replenishment needs.";

    const scopeLabel = isMain ? "MAIN Warehouse" : (selectedBranch || "Branch");

    const exportCSV = useCallback(async () => {
        if (!activeBranch) return;
        try {
            const qs = buildQueryString({
                pageNum: 1,
                searchText: debouncedSearch,
                priority: priorityFilter,
                itemClass: itemClassFilter,
                pageSize: 5000,
            });
            const res = await fetchWithAuth(
                `/api/replenishment?branch=${encodeURIComponent(activeBranch)}${qs}`
            );
            if (!res.ok) return;
            const data = await res.json();
            const rows = data.recommendations || [];
            if (!rows.length) return;

        const headers = isMain
            ? ["Status", "Product ID", "Description", "Item Class", "Main Inventory", "Coming PO", "Total Branch Replenishment", "Days Left", "Avg Lead Time", "Order Qty", "Order Qty with Lead Time", "What To Do"]
            : ["Status", "Product ID", "Description", "Item Class", "Branch Stock", "Coming PO", "Sells Per Day", "Days Left", "Avg Lead Time", "Order Qty", "Order Qty with Lead Time", "What To Do"];

        const csvRows = rows.map((rec) => {
            const ai = rec.aiInsights || {};
            const leadTime = Number(rec.leadTimeDays ?? ai.leadTimeDays) || 0;
            const orderQty = orderQtyDrafts[rec.itemId] !== undefined
                ? toWholeOrderQty(orderQtyDrafts[rec.itemId])
                : toWholeOrderQty(rec.suggestedQty);
            const orderQtyWithLeadTime = leadTime > 0 && orderQty > 0 ? Math.round(leadTime * orderQty) : "";
            const base = [
                priorityLabel(rec.priorityLevel, rec.suggestedQty),
                rec.itemId,
                rec.description || "",
                rec.itemClass || "",
            ];
            if (isMain) {
                base.push(
                    rec.mainInventory ?? rec.currentStock ?? 0,
                    rec.comingPO ?? 0,
                    rec.totalBranchReplenishment ?? rec.branchOrderQty ?? 0
                );
            } else {
                base.push(rec.currentStock ?? 0, rec.comingPO ?? 0);
            }
            if (!isMain) {
                base.push(ai.salesVelocity ?? "");
            }
            base.push(
                ai.daysRemaining ?? "",
                leadTime || "",
                orderQty,
                orderQtyWithLeadTime,
                ai.whatToDo || rec.restockSource || ""
            );
            return base.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
        });

        const csv = [headers.join(","), ...csvRows].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `replenishment-${isMain ? "MAIN" : selectedBranch}-${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Export failed", err);
        }
    }, [
        activeBranch,
        buildQueryString,
        debouncedSearch,
        priorityFilter,
        itemClassFilter,
        isMain,
        selectedBranch,
        orderQtyDrafts,
    ]);

    return (
        <div className="db-root">
            <main className="db-main repl-main">
                <div className="db-page-title" data-tour="page-title">
                    <h1>Replenishment</h1>
                    <p>
                        {isMain
                            ? "MAIN warehouse planning — vendor orders to supply all retail branches."
                            : "Branch replenishment — stock transfers needed from MAIN warehouse."}
                        {" "}Order qty autosaves as you type.
                    </p>
                </div>

                {brief && (
                    <div className={`repl-summary ${stats.urgent > 0 ? "repl-summary-alert" : "repl-summary-ok"}`}>
                        <strong>{brief.title}</strong>
                        <span>{brief.action}</span>
                    </div>
                )}

                <div className="db-stats" data-tour="kpi-cards">
                    <div className="db-stat-card repl-stat-urgent">
                        <span className="db-stat-label">Urgent</span>
                        <span className="db-stat-value">{loading && recs.length === 0 ? "..." : stats.urgent}</span>
                        <span className="db-stat-sub">May run out within a week</span>
                    </div>
                    <div className="db-stat-card repl-stat-soon">
                        <span className="db-stat-label">Order soon</span>
                        <span className="db-stat-value">{loading && recs.length === 0 ? "..." : stats.soon}</span>
                        <span className="db-stat-sub">Plan restock in the next few weeks</span>
                    </div>
                    <div className="db-stat-card">
                        <span className="db-stat-label">Total units to order</span>
                        <span className="db-stat-value">{loading && recs.length === 0 ? "..." : stats.totalSuggested.toLocaleString()}</span>
                        <span className="db-stat-sub">{scopeLabel}</span>
                    </div>
                    <form
                        className="db-stat-card repl-stat-window"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!isAdmin || savingWindow) return;
                            setSavingWindow(true);
                            setWindowNotice("");
                            setError(null);
                            try {
                                const res = await fetchWithAuth("/api/admin/replenishment-window", {
                                    method: "PUT",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ value: Number(salesMonths), unit: salesUnit }),
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) throw new Error(data.message || "Could not update the sales window");
                                setSalesMonths(String(data.value ?? data.months ?? salesMonths));
                                setSalesUnit(data.unit === "days" ? "days" : "months");
                                setWindowNotice(data.message || "Updating every branch.");
                                fetchRecommendations({
                                    branchToFetch: activeBranch,
                                    pageNum: 1,
                                    forceRefresh: true,
                                    isInitial: true,
                                });
                            } catch (err) {
                                setError(err.message || "Could not update the sales window");
                            } finally {
                                setSavingWindow(false);
                            }
                        }}
                    >
                        <span className="db-stat-label">Sales window</span>
                        <label className="repl-window-field">
                            <input
                                type="number"
                                min={1}
                                max={salesUnit === "days" ? 720 : 24}
                                step={1}
                                value={salesMonths}
                                disabled={!isAdmin || savingWindow}
                                onChange={(e) => setSalesMonths(e.target.value)}
                                aria-label="Sales window amount"
                            />
                            <select
                                className="repl-window-unit"
                                value={salesUnit}
                                disabled={!isAdmin || savingWindow}
                                aria-label="Sales window unit"
                                onChange={(e) => {
                                    const next = e.target.value === "days" ? "days" : "months";
                                    if (next === salesUnit) return;
                                    const amount = Number(salesMonths) || 0;
                                    setSalesMonths(String(next === "days"
                                        ? Math.max(1, amount * 30)
                                        : Math.max(1, Math.round(amount / 30))));
                                    setSalesUnit(next);
                                }}
                            >
                                <option value="months">Months</option>
                                <option value="days">Days</option>
                            </select>
                        </label>
                        <span className="db-stat-sub">
                            {windowNotice || (isAdmin ? "Default is 3 months. Applies to every branch." : "Set by an admin. Default is 3 months.")}
                        </span>
                        {isAdmin ? (
                            <button type="submit" className="repl-window-save" disabled={savingWindow}>
                                {savingWindow ? "Updating…" : "Update"}
                            </button>
                        ) : null}
                    </form>
                </div>

                <div className="repl-filter-tabs" data-tour="toolbar">
                    <button
                        type="button"
                        className={`repl-filter-tab ${priorityFilter === "all" ? "active" : ""}`}
                        onClick={() => setPriorityFilter("all")}
                    >
                        All items
                        <span className="repl-filter-tab-count">{stats.totalItems}</span>
                    </button>
                    <button
                        type="button"
                        className={`repl-filter-tab ${priorityFilter === "soon" ? "active" : ""}`}
                        onClick={() => setPriorityFilter("soon")}
                    >
                        Order soon
                        <span className="repl-filter-tab-count">{stats.soon}</span>
                    </button>
                    <button
                        type="button"
                        className={`repl-filter-tab ${priorityFilter === "urgent" ? "active" : ""}`}
                        onClick={() => setPriorityFilter("urgent")}
                    >
                        Urgent
                        <span className="repl-filter-tab-count">{stats.urgent}</span>
                    </button>
                </div>

                <div className="db-toolbar">
                    <div className="db-toolbar-left">
                        <div className="repl-view-field">
                            <label>View</label>
                            <div className="repl-view-switch">
                                {canAccessMain ? (
                                    <button
                                        type="button"
                                        className={`repl-view-btn ${viewMode === "main" ? "active" : ""}`}
                                        onClick={() => setViewMode("main")}
                                    >
                                        MAIN Warehouse
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    className={`repl-view-btn ${viewMode === "branch" ? "active" : ""}`}
                                    onClick={() => setViewMode("branch")}
                                >
                                    Branches
                                </button>
                            </div>
                        </div>

                        {viewMode === "branch" && (
                            <div className="db-select-wrapper repl-branch-select" data-tour="branch-filter">
                                <IconFilter />
                                <select
                                    id="repl-branch"
                                    className="db-select"
                                    value={selectedBranch}
                                    onChange={(e) => setSelectedBranch(e.target.value)}
                                    disabled={retailBranches.length === 0}
                                    aria-label="Branch filter"
                                >
                                    {retailBranches.length === 0 ? (
                                        <option value="">No branches</option>
                                    ) : retailBranches.map((b) => (
                                        <option key={b.SiteID} value={b.SiteID}>{b.SiteID}</option>
                                    ))}
                                </select>
                                <IconChevron />
                            </div>
                        )}

                        <div className={`db-search-wrapper repl-search ${isSearchLoading ? "is-search-loading" : ""}`}>
                            {isSearchLoading ? (
                                <span
                                    className="repl-search-spinner"
                                    role="status"
                                    aria-label="Searching..."
                                />
                            ) : (
                                <IconSearch />
                            )}
                            <input
                                className="db-search"
                                type="text"
                                placeholder="Search product..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                aria-busy={isSearchLoading}
                            />
                            {search && (
                                <button
                                    type="button"
                                    className="db-search-clear"
                                    onClick={() => setSearch("")}
                                    aria-label="Clear search"
                                >
                                    ×
                                </button>
                            )}
                        </div>

                        <div className="repl-item-class-field">
                            <label htmlFor="repl-item-class">Item Class</label>
                            <div className="db-select-wrapper">
                                <select
                                    id="repl-item-class"
                                    className="db-select"
                                    value={itemClassFilter}
                                    onChange={(e) => setItemClassFilter(e.target.value)}
                                >
                                    <option value="">All Item Classes</option>
                                    {itemClassOptions.map((cls) => (
                                        <option key={cls} value={cls}>{cls}</option>
                                    ))}
                                </select>
                                <IconChevron />
                            </div>
                        </div>
                    </div>

                    <div className="db-toolbar-right">
                        <button
                            className="db-action-btn"
                            onClick={exportCSV}
                            disabled={loading || totalCount === 0}
                        >
                            <IconDownload /> Export CSV
                        </button>
                        <button
                            className="db-refresh-btn"
                            onClick={() => {
                                if (!activeBranch) return;
                                fetchRecommendations({
                                    branchToFetch: activeBranch,
                                    pageNum: page,
                                    forceRefresh: true,
                                    isInitial: true,
                                });
                            }}
                            disabled={loading || !activeBranch}
                        >
                            {loading ? "Loading..." : "Refresh"}
                        </button>
                    </div>
                </div>

                <p className="repl-branch-hint">{branchHint}</p>

                {error && <div className="si-error">{error}</div>}

                <div className={`db-table-wrap repl-table-wrap ${pageLoading ? "is-page-loading" : ""}`} data-tour="main-table">
                    {pageLoading && recs.length > 0 && (
                        <div className="repl-table-overlay" role="status" aria-live="polite" aria-busy="true">
                            <div className="repl-table-spinner repl-table-spinner-lg" aria-hidden="true" />
                            <span className="repl-table-overlay-text">Updating results…</span>
                        </div>
                    )}
                    <table className="db-table db-table--fit repl-table">
                        <thead>
                            <tr>
                                <th style={{ width: "72px" }}>Status</th>
                                <th style={{ width: "160px" }}>Product</th>
                                {isMain ? (
                                    <>
                                        <th style={{ width: "88px", textAlign: "right" }}>Main inventory</th>
                                        <th style={{ width: "88px", textAlign: "right" }}>Coming PO</th>
                                        <th className="repl-col-th" style={{ width: "112px", textAlign: "right" }}>
                                            <ColumnInfoHeader
                                                label={<>Total branch<br />repl.</>}
                                                title="Total branch repl."
                                                panelId="total-branch-repl"
                                                openId={openColumnInfo}
                                                setOpenId={setOpenColumnInfo}
                                                align="right"
                                            >
                                                <strong>How &quot;Total branch repl.&quot; is calculated</strong>
                                                <p>
                                                    Sum of what each <strong>retail</strong> branch still needs from MAIN
                                                    for this product, using that branch&apos;s own sales rate (not company-wide sales).
                                                </p>
                                                <p className="repl-col-info-formula">
                                                    Per retail branch: max(0, ceil(branch Sells/day × 60) − live stock), then sum
                                                </p>
                                                <p className="repl-col-info-note">
                                                    TECH / Office sites are excluded. Vendor Order qty = this total − MAIN inventory.
                                                    Coming PO is shown separately and is not subtracted.
                                                </p>
                                            </ColumnInfoHeader>
                                        </th>
                                    </>
                                ) : (
                                    <>
                                        <th style={{ width: "88px", textAlign: "right" }}>Branch stock</th>
                                        <th style={{ width: "88px", textAlign: "right" }}>Coming PO</th>
                                    </>
                                )}
                                {!isMain ? (
                                    <th className="repl-col-th" style={{ width: "100px", textAlign: "right" }}>
                                        <ColumnInfoHeader
                                            label="Sells / day"
                                            panelId="sells-per-day"
                                            openId={openColumnInfo}
                                            setOpenId={setOpenColumnInfo}
                                            align="right"
                                        >
                                            <strong>How &quot;Sells / day&quot; is calculated</strong>
                                            <p>
                                                This is the <strong>average number of units sold per day</strong> for each product
                                                at branch <strong>{selectedBranch}</strong> — not today&apos;s sales alone.
                                            </p>
                                            <p className="repl-col-info-formula">
                                                Sells / day = Net units sold in the last {Number(meta?.salesLookbackDays) || 90} days at {selectedBranch} ÷ {Number(meta?.salesLookbackDays) || 90}
                                            </p>
                                            <p>
                                                Uses this branch’s invoice sales first (credit memos subtracted). Network-wide
                                                invoice totals are only used when this branch has no sales for a product.
                                                Stock on hand comes from synced inventory.
                                            </p>
                                            <p className="repl-col-info-note">
                                                <strong>Days left</strong> uses this rate: Branch stock (+ Coming PO) ÷ Sells / day
                                                (e.g. 462 ÷ 70.9 ≈ 6 days).
                                                Tap <strong>Explain</strong> on any row for that product&apos;s exact numbers.
                                            </p>
                                        </ColumnInfoHeader>
                                    </th>
                                ) : null}
                                <th style={{ width: "88px", textAlign: "right" }}>Days left</th>
                                <th style={{ width: "88px", textAlign: "right" }}>Avg. lead time</th>
                                <th className="repl-col-th" style={{ width: "108px", textAlign: "right" }}>
                                    <ColumnInfoHeader
                                        label="Order qty"
                                        panelId="order-qty"
                                        openId={openColumnInfo}
                                        setOpenId={setOpenColumnInfo}
                                        align="right"
                                    >
                                        <strong>How &quot;Order qty&quot; is calculated</strong>
                                        {isMain ? (
                                            <>
                                                <p>
                                                    Same global formula as branches. Positive = shortfall vs one day of sales;
                                                    negative = surplus (stock + Coming PO already cover Sells/day).
                                                </p>
                                                <p className="repl-col-info-formula">
                                                    a = Main inventory<br />
                                                    b = Coming PO<br />
                                                    c = a + b<br />
                                                    d = Sells/day<br />
                                                    e = d − c → Order qty
                                                </p>
                                                <p className="repl-col-info-note">
                                                    Example: a=47, b=399 → c=446; d=7.9 → e = 7.9 − 446 = <strong>−438.1</strong> (surplus).
                                                </p>
                                            </>
                                        ) : (
                                            <>
                                                <p>
                                                    Units to transfer from MAIN to <strong>{selectedBranch || "this branch"}</strong>.
                                                    Positive = need more; negative = surplus.
                                                </p>
                                                <p className="repl-col-info-formula">
                                                    a = Branch stock<br />
                                                    b = Coming PO<br />
                                                    c = a + b<br />
                                                    d = Sells/day<br />
                                                    e = d − c → Order qty
                                                </p>
                                                <p className="repl-col-info-note">
                                                    Example: a=47, b=399 → c=446; d=7.9 → e = 7.9 − 446 = <strong>−438.1</strong> (surplus).
                                                    Coming PO is included in c so open POs reduce Order qty.
                                                </p>
                                            </>
                                        )}
                                    </ColumnInfoHeader>
                                </th>
                                <th className="repl-col-th" style={{ width: "112px", textAlign: "right" }}>
                                    <ColumnInfoHeader
                                        label={<>Order ×<br />lead time</>}
                                        title="Order qty with lead time"
                                        panelId="order-qty-lead-time"
                                        openId={openColumnInfo}
                                        setOpenId={setOpenColumnInfo}
                                        align="right"
                                    >
                                        <strong>How &quot;Order qty with lead time&quot; is calculated</strong>
                                        <p>
                                            Multiplies the current <strong>Order qty</strong> by the vendor&apos;s
                                            <strong> Avg. lead time</strong> (days).
                                        </p>
                                        <p className="repl-col-info-formula">
                                            Order qty with lead time = Avg. lead time × Order qty
                                        </p>
                                    </ColumnInfoHeader>
                                </th>
                                <th style={{ width: "140px" }}>What to do</th>
                                <th style={{ width: "168px" }}>
                                    <span className="repl-ai-col-head">
                                        <IconSparkles /> AI Explanation
                                    </span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading && recs.length === 0 ? (
                                <tr>
                                    <td colSpan={11} className="repl-table-empty">
                                        <div className="repl-table-loading" role="status" aria-live="polite" aria-busy="true">
                                            <div className="repl-table-spinner" aria-hidden="true" />
                                            <p className="repl-table-loading-text">
                                                Loading recommendations for {scopeLabel}
                                                <span className="repl-table-loading-dots" aria-hidden="true">
                                                    <span>.</span><span>.</span><span>.</span>
                                                </span>
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : recs.length === 0 ? (
                                <tr>
                                    <td colSpan={11} className="repl-table-empty">
                                        {priorityFilter === "urgent"
                                            ? "No urgent items right now."
                                            : priorityFilter === "soon"
                                                ? "No items need ordering soon."
                                            : totalCount === 0
                                                ? isMain
                                                    ? "No items found for MAIN warehouse planning."
                                                    : `No items found for ${selectedBranch}.`
                                                : "No items match your filters."}
                                    </td>
                                </tr>
                            ) : (
                                <ReplenishmentRows
                                    recs={recs}
                                    onExplain={setAiExplainRec}
                                    explainId={aiExplainRec?.recommendationId}
                                    isMain={isMain}
                                    drafts={orderQtyDrafts}
                                    onOrderQtyChange={handleOrderQtyChange}
                                />
                            )}
                        </tbody>
                    </table>
                </div>

                {totalCount > 0 && (
                    <PaginationBar
                        page={page}
                        pageSize={PAGE_SIZE}
                        totalCount={totalCount}
                        onPageChange={setPage}
                        itemLabel="recommendations"
                    />
                )}

                {meta?.generatedAt && (
                    <p className="repl-footer">
                        Updated {new Date(meta.generatedAt).toLocaleString("en-PH")}
                        {meta.salesSource === "acumatica" && " · Sales from Acumatica (live)"}
                        {meta.servedFrom === "cache" && " · Loaded from replenishment cache"}
                        {meta.salesScope === "network" && " · Branch demand from live stock + velocity"}
                        {meta.salesScope === "catalog-network" &&
                            " · Sales velocity from network invoices for this branch's catalog"}
                        {meta.servedFrom === "cache-refreshing" && " · Refresh running in background — reload in a minute for updated totals"}
                        {meta.servedFrom === "cache-stale-rebuilding" && " · Updating branch demand in background"}
                        {meta.salesMode === "live-branch-demand" && " · Total Branch Repl. from retail branch demand"}
                        {qtySaveHint ? ` · ${qtySaveHint}` : ""}
                    </p>
                )}
            </main>

            <AiExplainLightbox rec={aiExplainRec} onClose={closeAiExplain} />
        </div>
    );
}
