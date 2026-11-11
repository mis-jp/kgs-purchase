"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import { poDetailHref } from "@/lib/po-metrics";
import { QUICK_SEARCH_EVENT, matchPages, normalizeQuickSearchQuery, searchHref } from "@/lib/quick-search";

const EMPTY = { q: "", items: [], orders: [], suppliers: [], error: "" };

/** Ctrl+K search: jump to a page, or find items, purchase orders and suppliers. */
export default function QuickSearch({ pages, collapsed }) {
    const router = useRouter();
    const pathname = usePathname();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const [result, setResult] = useState(EMPTY);
    const [active, setActive] = useState(0);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    useEffect(() => {
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setOpen((v) => !v);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        const t = setTimeout(() => inputRef.current?.focus(), 0);
        return () => clearTimeout(t);
    }, [open]);

    const q = normalizeQuickSearchQuery(text);
    useEffect(() => {
        if (!open || !q) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            fetchWithAuth(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(res.status === 403 ? "" : data.message || "Search is not available right now.");
                    setResult({ ...EMPTY, ...data, q, error: "" });
                })
                .catch((err) => {
                    if (!controller.signal.aborted) setResult({ ...EMPTY, q, error: err.message });
                });
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [open, q]);

    const current = result.q === q ? result : EMPTY;
    const searching = Boolean(q) && result.q !== q;

    const entries = useMemo(() => {
        const list = matchPages(pages, text).slice(0, q ? 4 : 12).map((p) => ({
            key: `page:${p.href}`, group: "Pages", title: p.name, sub: "", href: p.href,
        }));
        for (const i of current.items) {
            list.push({ key: `item:${i.inventoryId}`, group: "Stock items", title: i.inventoryId, sub: i.description, href: searchHref("/stock-items", i.inventoryId) });
        }
        for (const o of current.orders) {
            list.push({ key: `po:${o.orderNbr}`, group: "Purchase orders", title: o.orderNbr, sub: [o.vendorName, o.status].filter(Boolean).join(" · "), href: poDetailHref(o.orderNbr) });
        }
        for (const s of current.suppliers) {
            list.push({ key: `sup:${s.vendorId}`, group: "Suppliers", title: s.vendorName || s.vendorId, sub: s.vendorId, href: searchHref("/suppliers", s.vendorName || s.vendorId) });
        }
        return list.map((entry, i) => ({ ...entry, header: i === 0 || list[i - 1].group !== entry.group ? entry.group : "" }));
    }, [pages, text, q, current]);

    const activeIndex = Math.min(active, Math.max(0, entries.length - 1));

    const close = () => {
        setOpen(false);
        setText("");
        setActive(0);
    };

    const go = (entry) => {
        if (!entry) return;
        close();
        const [path, query] = entry.href.split("?");
        router.push(entry.href);
        if (path === pathname && query) {
            const search = new URLSearchParams(query).get("search") || "";
            window.dispatchEvent(new CustomEvent(QUICK_SEARCH_EVENT, { detail: { path, search } }));
        }
    };

    const onKeyDown = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(entries.length - 1, activeIndex + 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(0, activeIndex - 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            go(entries[activeIndex]);
        }
    };

    useEffect(() => {
        listRef.current?.querySelector(".qs-item.is-active")?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    return (
        <>
            <button
                type="button"
                className="sidebar-quick-search"
                onClick={() => setOpen(true)}
                title="Quick search (Ctrl+K)"
                aria-label="Quick search"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                {!collapsed && (
                    <>
                        <span>Search</span>
                        <kbd>Ctrl K</kbd>
                    </>
                )}
            </button>

            {open && (
                <div className="qs-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
                    <div className="qs-dialog" role="dialog" aria-modal="true" aria-label="Quick search">
                        <div className="qs-input-row">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                            <input
                                ref={inputRef}
                                className="qs-input"
                                type="text"
                                value={text}
                                onChange={(e) => { setText(e.target.value); setActive(0); }}
                                onKeyDown={onKeyDown}
                                placeholder="Search pages, item IDs, PO numbers, suppliers…"
                                aria-label="Search"
                                aria-controls="qs-results"
                                aria-activedescendant={entries[activeIndex] ? `qs-${activeIndex}` : undefined}
                            />
                            <kbd className="qs-esc">Esc</kbd>
                        </div>

                        <div className="qs-results" id="qs-results" role="listbox" ref={listRef}>
                            {entries.map((entry, idx) => (
                                <div key={entry.key}>
                                    {entry.header && <div className="qs-group">{entry.header}</div>}
                                    <button
                                        type="button"
                                        id={`qs-${idx}`}
                                        role="option"
                                        aria-selected={idx === activeIndex}
                                        className={`qs-item ${idx === activeIndex ? "is-active" : ""}`}
                                        onMouseEnter={() => setActive(idx)}
                                        onClick={() => go(entry)}
                                    >
                                        <span className="qs-item-title">{entry.title}</span>
                                        {entry.sub && <span className="qs-item-sub">{entry.sub}</span>}
                                    </button>
                                </div>
                            ))}
                            {searching && <div className="qs-note">Searching…</div>}
                            {!searching && q && current.error && <div className="qs-note is-error">{current.error}</div>}
                            {!searching && q && !current.error && entries.length === 0 && <div className="qs-note">No matches for “{q}”.</div>}
                            {!q && text.trim().length === 1 && <div className="qs-note">Type one more character to search items, POs and suppliers.</div>}
                        </div>

                        <div className="qs-footer">
                            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                            <span><kbd>Enter</kbd> open</span>
                            <span><kbd>Esc</kbd> close</span>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
