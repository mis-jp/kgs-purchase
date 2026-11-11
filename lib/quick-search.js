/** Shared helpers for the Ctrl+K quick search. */

export const QUICK_SEARCH_MIN = 2;
export const QUICK_SEARCH_MAX = 60;
export const QUICK_SEARCH_EVENT = "kgs-quick-search";

/** Trimmed, collapsed search text, or "" when too short to search. */
export function normalizeQuickSearchQuery(raw) {
    const q = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, QUICK_SEARCH_MAX);
    return q.length >= QUICK_SEARCH_MIN ? q : "";
}

/** Pages whose name or keywords contain every word typed, best match first. */
export function matchPages(pages, text) {
    const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return pages;
    return pages
        .map((p) => {
            const hay = `${p.name} ${p.keywords || ""}`.toLowerCase();
            if (!words.every((w) => hay.includes(w))) return null;
            const starts = p.name.toLowerCase().startsWith(words[0]) ? 0 : 1;
            return { p, starts };
        })
        .filter(Boolean)
        .sort((a, b) => a.starts - b.starts)
        .map((x) => x.p);
}

/** Path plus ?search= for list pages that accept a starting search. */
export function searchHref(path, text) {
    const q = String(text || "").trim();
    return q ? `${path}?search=${encodeURIComponent(q)}` : path;
}
