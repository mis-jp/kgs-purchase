import test from "node:test";
import assert from "node:assert/strict";
import { matchPages, normalizeQuickSearchQuery, searchHref, QUICK_SEARCH_MAX } from "../lib/quick-search.js";

test("normalizeQuickSearchQuery trims, collapses and enforces length", () => {
    assert.equal(normalizeQuickSearchQuery("  ab   cd "), "ab cd");
    assert.equal(normalizeQuickSearchQuery("a"), "");
    assert.equal(normalizeQuickSearchQuery(null), "");
    assert.equal(normalizeQuickSearchQuery("x".repeat(100)).length, QUICK_SEARCH_MAX);
});

test("matchPages needs every word and ranks name prefixes first", () => {
    const pages = [
        { name: "Stock Items", href: "/stock-items", keywords: "sizes" },
        { name: "Purchase Orders", href: "/purchase-orders", keywords: "po overdue" },
        { name: "Incoming PO", href: "/incoming-po", keywords: "arriving" },
    ];
    assert.deepEqual(matchPages(pages, "po").map((p) => p.href), ["/purchase-orders", "/incoming-po"]);
    assert.deepEqual(matchPages(pages, "po overdue").map((p) => p.href), ["/purchase-orders"]);
    assert.deepEqual(matchPages(pages, "sizes").map((p) => p.href), ["/stock-items"]);
    assert.equal(matchPages(pages, "").length, 3);
});

test("searchHref adds an encoded search", () => {
    assert.equal(searchHref("/suppliers", "A & B"), "/suppliers?search=A%20%26%20B");
    assert.equal(searchHref("/suppliers", "  "), "/suppliers");
});
