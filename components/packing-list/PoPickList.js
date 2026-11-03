"use client";

function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PoPickList({
    orders,
    totalCount,
    loading,
    loadingMore,
    error,
    hasMore,
    selected,
    maxSelected,
    search,
    onSearch,
    onToggle,
    onSetAll,
    onClearSelection,
    onLoadMore,
    onRetry,
}) {
    const selectedSet = new Set(selected);
    const allLoadedChecked = orders.length > 0 && orders.every((o) => selectedSet.has(o.orderNbr));
    const atLimit = selected.length >= maxSelected;

    return (
        <div className="pl-panel pl-picklist">
            <div className="pl-panel-head">
                <h3 className="pl-panel-title">Purchase Orders</h3>
                <span className="pl-muted">
                    {selected.length} selected{totalCount ? ` · ${totalCount} PO(s)` : ""}
                </span>
            </div>

            <input
                className="pl-search"
                type="search"
                placeholder="Search PO #, vendor or item…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                aria-label="Search purchase orders"
            />

            <div className="pl-pick-actions">
                <label className="pl-check">
                    <input
                        type="checkbox"
                        checked={allLoadedChecked}
                        disabled={!orders.length}
                        onChange={(e) => onSetAll(e.target.checked)}
                    />
                    Select all shown
                </label>
                {selected.length > 0 && (
                    <button type="button" className="pl-link-btn" onClick={onClearSelection}>
                        Clear selection
                    </button>
                )}
            </div>
            {atLimit && <div className="pl-note">You can pick up to {maxSelected} POs at a time.</div>}

            <div className="pl-pick-scroll" role="list">
                {loading && <div className="pl-empty">Loading purchase orders…</div>}
                {!loading && error && (
                    <div className="pl-empty pl-error">
                        <span>{error}</span>
                        <button type="button" className="db-action-btn" onClick={onRetry}>Retry</button>
                    </div>
                )}
                {!loading && !error && orders.length === 0 && (
                    <div className="pl-empty">No purchase orders found for this branch and filter.</div>
                )}
                {!loading && orders.map((o) => {
                    const checked = selectedSet.has(o.orderNbr);
                    return (
                        <label
                            key={o.orderNbr}
                            role="listitem"
                            className={`pl-pick-row ${checked ? "is-checked" : ""}`}
                        >
                            <input
                                type="checkbox"
                                checked={checked}
                                disabled={!checked && atLimit}
                                onChange={() => onToggle(o.orderNbr)}
                            />
                            <span className="pl-pick-main">
                                <span className="pl-pick-nbr">{o.orderNbr}</span>
                                <span className="pl-pick-vendor" title={o.vendorName || o.vendorId || ""}>
                                    {o.vendorName || o.vendorId || "—"}
                                </span>
                            </span>
                            <span className="pl-pick-meta">
                                <span>{formatDate(o.date)}</span>
                                <span>{o.lineCount} line(s){o.status ? ` · ${o.status}` : ""}</span>
                            </span>
                        </label>
                    );
                })}
                {!loading && hasMore && (
                    <button type="button" className="db-action-btn pl-load-more" onClick={onLoadMore} disabled={loadingMore}>
                        {loadingMore ? "Loading…" : "Load more"}
                    </button>
                )}
            </div>
        </div>
    );
}
