"use client";

import { useEffect, useMemo, useState } from "react";

function IconFirst() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
        </svg>
    );
}

function IconPrev() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    );
}

function IconNext() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
        </svg>
    );
}

function IconLast() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="13 17 18 12 13 7" />
            <polyline points="6 17 11 12 6 7" />
        </svg>
    );
}

/** Build compact page number list with ellipsis markers (null). */
function buildPageList(current, total) {
    if (!total || total < 1) return [];
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages = new Set([1, total, current, current - 1, current + 1]);
    if (current <= 3) {
        pages.add(2);
        pages.add(3);
        pages.add(4);
    }
    if (current >= total - 2) {
        pages.add(total - 1);
        pages.add(total - 2);
        pages.add(total - 3);
    }
    const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const p of sorted) {
        if (prev && p - prev > 1) out.push(null);
        out.push(p);
        prev = p;
    }
    return out;
}

/**
 * Shared pagination bar for list modules.
 *
 * @param {object} props
 * @param {number} props.page
 * @param {(n: number) => void} props.onPageChange
 * @param {number} [props.pageSize=10]
 * @param {number|null} [props.totalCount] — when known, enables page count + first/last
 * @param {boolean} [props.hasMore] — used when totalCount is unknown
 * @param {string} [props.itemLabel="items"]
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 */
export default function PaginationBar({
    page = 1,
    onPageChange,
    pageSize = 10,
    totalCount = null,
    hasMore = false,
    itemLabel = "items",
    disabled = false,
    className = "",
}) {
    const knownTotal = totalCount != null && Number.isFinite(Number(totalCount));
    const total = knownTotal ? Math.max(0, Number(totalCount)) : null;
    const totalPages = knownTotal ? Math.max(1, Math.ceil(total / pageSize)) : null;
    const safePage = Math.max(1, Number(page) || 1);

    const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
    const to = knownTotal ? Math.min(safePage * pageSize, total) : null;

    const canPrev = safePage > 1 && !disabled;
    const canNext = knownTotal
        ? safePage < totalPages && !disabled
        : Boolean(hasMore) && !disabled;
    const canFirst = canPrev;
    const canLast = knownTotal ? safePage < totalPages && !disabled : false;

    const pages = useMemo(
        () => (knownTotal ? buildPageList(safePage, totalPages) : []),
        [knownTotal, safePage, totalPages]
    );

    const [pageDraft, setPageDraft] = useState(String(safePage));
    useEffect(() => {
        setPageDraft(String(safePage));
    }, [safePage]);

    const go = (n) => {
        if (disabled || typeof onPageChange !== "function") return;
        const next = Math.max(1, n);
        if (knownTotal) onPageChange(Math.min(totalPages, next));
        else onPageChange(next);
    };

    const commitPageDraft = () => {
        const n = parseInt(String(pageDraft).trim(), 10);
        if (!Number.isFinite(n) || n < 1) {
            setPageDraft(String(safePage));
            return;
        }
        go(n);
        if (knownTotal) setPageDraft(String(Math.min(totalPages, n)));
    };

    let info;
    if (knownTotal) {
        if (total === 0) {
            info = (
                <>
                    No {itemLabel} to show
                </>
            );
        } else {
            info = (
                <>
                    Showing <strong>{from.toLocaleString()}</strong>
                    {"–"}
                    <strong>{to.toLocaleString()}</strong>
                    {" of "}
                    <strong>{total.toLocaleString()}</strong> {itemLabel}
                </>
            );
        }
    } else {
        info = (
            <>
                Page <strong>{safePage}</strong>
                {hasMore ? " · more available" : safePage > 1 ? " · end of results" : ""}
            </>
        );
    }

    const jumpDisabled = disabled || (knownTotal && total === 0);

    return (
        <nav className={`db-pagination${className ? ` ${className}` : ""}`} aria-label="Pagination">
            <div className="db-page-info-wrap">
                <p className="db-page-info">{info}</p>
                <label className="db-page-jump">
                    <span>Page</span>
                    <input
                        type="number"
                        className="db-page-jump-input"
                        inputMode="numeric"
                        min={1}
                        max={knownTotal ? totalPages : undefined}
                        value={pageDraft}
                        disabled={jumpDisabled}
                        aria-label="Page number to open"
                        onChange={(e) => setPageDraft(e.target.value)}
                        onBlur={commitPageDraft}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                e.currentTarget.blur();
                            }
                        }}
                    />
                    {knownTotal ? <span>of {totalPages.toLocaleString()}</span> : null}
                </label>
            </div>
            <div className="db-page-btns" role="group" aria-label="Page navigation">
                <button
                    type="button"
                    className="db-page-btn db-page-btn-icon"
                    onClick={() => go(1)}
                    disabled={!canFirst}
                    aria-label="First page"
                    title="First page"
                >
                    <IconFirst />
                </button>
                <button
                    type="button"
                    className="db-page-btn db-page-btn-icon"
                    onClick={() => go(safePage - 1)}
                    disabled={!canPrev}
                    aria-label="Previous page"
                    title="Previous page"
                >
                    <IconPrev />
                </button>

                {knownTotal ? (
                    <div className="db-page-numbers">
                        {pages.map((p, i) =>
                            p == null ? (
                                <span key={`e-${i}`} className="db-page-ellipsis" aria-hidden="true">
                                    …
                                </span>
                            ) : (
                                <button
                                    key={p}
                                    type="button"
                                    className={`db-page-btn db-page-num${p === safePage ? " db-page-btn-active" : ""}`}
                                    onClick={() => go(p)}
                                    disabled={disabled}
                                    aria-label={`Page ${p}`}
                                    aria-current={p === safePage ? "page" : undefined}
                                >
                                    {p}
                                </button>
                            )
                        )}
                    </div>
                ) : (
                    <span className="db-page-dots">
                        Page <strong>{safePage}</strong>
                    </span>
                )}

                <button
                    type="button"
                    className="db-page-btn db-page-btn-icon"
                    onClick={() => go(safePage + 1)}
                    disabled={!canNext}
                    aria-label="Next page"
                    title="Next page"
                >
                    <IconNext />
                </button>
                <button
                    type="button"
                    className="db-page-btn db-page-btn-icon"
                    onClick={() => go(totalPages || safePage)}
                    disabled={!canLast}
                    aria-label="Last page"
                    title={knownTotal ? "Last page" : "Last page (total unknown)"}
                >
                    <IconLast />
                </button>
            </div>
        </nav>
    );
}
