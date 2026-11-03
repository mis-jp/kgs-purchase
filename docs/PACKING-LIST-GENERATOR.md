# Packing List Generator (Purchase Orders module)

A new tab inside **Purchase Orders**. The user picks a branch, ticks the PO numbers they want to ship, and gets one packing list of those POs' items, with **Total CBM** and **Total Weight** calculated automatically. They can override the quantity per line (**Qty (Manual)**) and export the list to Excel.

The existing Purchase Orders table, filters, summary cards and export **stay exactly as they are**. The generator lives in its own tab and its own files.

---

## 1. What the user sees

```
Purchase Orders
[ Purchase Orders ]  [ Packing List Generator ]          ← new tab bar under the page title

Branch: [ TARLAC ▾ ]  Status: [ Open ▾ ]  From [..] To [..]  Search PO: [______]

┌ PO numbers for TARLAC ───────────────┐  ┌ Packing list (3 POs selected) ───────────────────────────────────────────┐
│ [x] Select all (12)                  │  │ Branch | Order Nbr | Order Date | Description | Inventory ID | Order Qty │
│ [x] TARP260091  10/29/2026  9 items  │  │        | Qty (Manual) | Total CBM | Total Weight                         │
│ [x] TARP260090  10/22/2026  4 items  │  │ TARLAC | TARP260091 | 10/29/2026 | Omega Tarpaulin II B1 ... | 50 | [  ] │
│ [ ] TARP260089  10/21/2026  1 item   │  │ ...                                                                      │
│ [x] TARP260088  10/21/2026 13 items  │  │ Totals: 3 POs · 26 lines · Qty 812 · CBM 14.2381 · 2,340.50 kg           │
│ ...                                  │  │ [ Export to Excel ]   [ Clear manual qty ]                                │
└──────────────────────────────────────┘  └──────────────────────────────────────────────────────────────────────────┘
```

1. **Branch first.** The PO list shows only POs that have lines for the selected branch, using the same branch rules as the main table (`purchase_order_dest` / line warehouse). Users without all-branch access only see their own branches, just like the main table.
2. **Tick POs.** Each PO row has a checkbox. A "Select all" checkbox ticks every PO in the current filtered list. The selection count shows in the panel header.
3. **Items appear only for ticked POs.** Unticking a PO removes its lines right away. With nothing ticked, the table shows "Tick one or more PO numbers to build the packing list."
4. **Only the selected branch's lines.** If a PO also has lines for other branches, only the lines for the selected branch are listed.
5. **Changing branch** clears the ticked POs, so lines from two branches never mix by accident.

### Columns (same order as the sample sheet)

| Column | Source |
|---|---|
| Branch | Selected branch id (e.g. `TARLAC`) |
| Order Nbr | PO number |
| Order Date | PO date (`purchase_history.order_date`), shown as `MM/DD/YYYY` |
| Description | PO line description |
| Inventory ID | PO line inventory id |
| Order Qty | PO line quantity (`purchase_order_details.qty`) |
| Qty (Manual) | Editable number. Empty = use Order Qty |
| Total CBM | Automatic, see section 2 |
| Total Weight | Automatic, see section 2 |

Lines are sorted by Order Date (newest first), then Order Nbr, then line number, the same as the sample.

---

## 2. Automatic calculations

**Packing qty** = Qty (Manual) when filled in, otherwise Order Qty.

Both totals reuse the helpers the PO lines table already uses, so numbers match everywhere:

- **Total CBM** = `calcTotalCbm({ length_m, height_m, width_m, cbm, pcs_per_box, qty: packingQty })` from the item-dimensions library:
  - box CBM = L × H × W in meters (or the saved CBM when a side is missing);
  - with PCS/BOX set: (qty ÷ PCS/BOX) × box CBM;
  - without PCS/BOX: qty × box CBM.
- **Total Weight** = `calcPoLineWeightKg(dimensions, packingQty)` from the PO metrics library (same as the Weight column in the PO lines table), shown as `1,234.5 kg`.

Dimensions come from `db_kelin_inventory.item_dimensions`, the existing table managed in Stock Items. If an item has no dimensions or KG:

- the cell shows "—" with a small "No size" tag and the tooltip "Set packaging dimensions on the item in Stock Items";
- the item is left out of the totals, and the footer says "3 lines have no size or weight". The totals are not silently wrong.

**Totals footer:** number of POs selected, number of lines, total packing qty, total CBM (4 decimals), total weight (2 decimals). Optionally show a subtotal per PO (collapsed by default).

**Qty (Manual) rules:** a number ≥ 0 with up to 4 decimals. A value above Order Qty is allowed (some shipments combine stock) but highlighted in amber with the tooltip "More than ordered". Clearing the box goes back to Order Qty.

---

## 3. Where Qty (Manual) is kept

**Phase 1 (this task):** kept in the browser (`localStorage` key `po_packing_manual_qty`, keyed by `branch|orderNbr|lineNbr`), so a refresh does not lose it. "Clear manual qty" resets the current list. No database writes.

**Phase 2 (optional, later):** save packing lists to the server so others can open them. This needs a **new** table only (for example `db_purchase.po_packing_lists` plus `po_packing_list_lines`). No existing table changes. Not part of this task.

---

## 4. Export

"Export to Excel" uses the `xlsx` package that is already installed and downloads `PackingList_<BRANCH>_<YYYY-MM-DD>.xlsx`:

- Sheet "Packing List" has the same 9 columns as the table, in the same order as the sample sheet. Dates are real Excel dates, quantities and CBM are numbers, and a **totals row** sits at the bottom.
- Optional second sheet "Summary": one row per selected PO with Order Nbr, Order Date, vendor, line count, qty, CBM and weight.

---

## 5. Implementation plan

### 5.1 New files

```
components/packing-list/PackingListGenerator.js   # tab content (client component)
components/packing-list/PoPickList.js             # branch PO list with checkboxes
components/packing-list/PackingListTable.js       # items table + totals + export
lib/packing-list.js                               # pure helpers: packing qty, line totals, grand totals, sheet rows
app/api/po/packing-list/route.js                  # read-only data for the tab
styles/packing-list.css                           # vanilla CSS, `pl-` prefix, theme variables
tests/packing-list.test.js                        # node --test for lib/packing-list.js
```

### 5.2 API: `GET /api/po/packing-list` (read-only, MySQL only)

Same auth and branch-access rules as `/api/po` (`getRequestBranchAccess`, `constrainBranchParam`, `hasNoBranchAccess`). It **never** calls Acumatica and **never** runs the background repair or align jobs that `/api/po` starts.

| Mode | Query | Returns |
|---|---|---|
| `mode=orders` | `branch` (required), `status` (default `active`), `startDate`, `endDate`, `search`, `page`, `pageSize` (≤ 100) | `{ orders: [{ orderNbr, date, vendorId, vendorName, status, lineCount, totalQty }], totalCount, hasMore }` |
| `mode=lines` | `branch` (required), `orderNbrs` (comma list, max 200) | `{ lines: [{ orderNbr, orderDate, lineNbr, inventoryId, description, qty, uom, warehouseId, dimensions }] }` |

- `mode=orders` reuses `MySqlService.getPurchaseOrders({ branch, status, startDate, endDate, search, page, pageSize })`, then maps each order to the light shape (line count and qty for the branch's lines only).
- `mode=lines` reuses `MySqlService.getPurchaseOrders({ orderNbrs, branch, pageSize: 200, excludeZeroQty: false })`. It keeps only lines whose `branchId` / `warehouseId` belongs to the branch, using the same `getStockWarehouseIdsForBranch(branch)` mapping the SQL filter uses. It then attaches `dimensions` from `MySqlService.getItemDimensionsBatch(ids)`, in chunks of 200.
- Response `Cache-Control: no-store`; errors return `{ message }` with status 4xx/5xx.

### 5.3 Purchase Orders page: tab only

Edits to the existing page are limited to:

1. A tab bar under the page title: **Purchase Orders** (default) and **Packing List Generator**, using `role="tablist"` and buttons with `aria-selected`.
2. The tab is stored in the URL (`?view=packing`), so it can be linked and survives a refresh.
3. The existing content (summary strip, toolbar, table, pagination) is wrapped in `<div hidden={view !== "orders"}>`. It stays mounted, so its filters, page and expanded rows are kept when switching tabs. Nothing inside it changes.
4. `<PackingListGenerator branchOptions={branchOptions} allowAllBranches={allowAllBranches} defaultBranch={selectedBranch} />` renders when `view === "packing"` and receives the branch list the page already loads. No second `/api/branches` call.

The page's own data effects (PO list, annotations, ETD) keep running only for the main tab, as they do today. The generator loads its own data only while its tab is open.

### 5.4 Generator behaviour

- On open: branch = the main table's selected branch (or the first allowed branch); status = `active` (Open, On Hold, Pending Approval); date range = this year, same as the main table.
- PO list: debounced search (300 ms), paged 50 at a time with "Load more", a checkbox per row and "Select all" for the loaded rows.
- Lines load whenever the ticked set changes (debounced 250 ms). Requests are cancelled with `AbortController` when the selection changes again, and loaded POs are cached in memory so ticking a PO back on is instant.
- Large selections: chunks of 50 PO numbers per `mode=lines` call.
- Empty, loading and error states are shown inside the panel, with a Retry button.

### 5.5 Styling

Vanilla CSS in `styles/packing-list.css` (`pl-` prefix) using the existing theme variables (`--bg-surface`, `--border-light`, `--accent-primary`, `--status-warning`, …). It reuses the PO page's `po-` toolbar and table look where possible. On wide screens it uses two columns: the PO list at about 320 px with its own scroll, and the items table filling the rest with a sticky header and sticky totals row. On narrow screens the panels stack. No utility frameworks.

---

## 6. Rules and limits

- Read-only: no writes to `db_purchase`, `db_kelin_inventory` or Acumatica in phase 1.
- Branch access is enforced on the server (the API), not only in the UI.
- The existing Purchase Orders table, columns, filters, CSV export, summary cards and status panels are not changed.
- Dimensions are read from Stock Items. Fixing a missing size there updates the packing list on the next load.

---

## 7. Tests and checks

- `tests/packing-list.test.js` (`node --test`):
  - packing qty uses manual over order qty, and blank manual falls back;
  - CBM with and without PCS/BOX, and with only a saved CBM;
  - weight;
  - missing dimensions are left out of totals and counted;
  - totals rounding;
  - sheet rows keep the sample column order.
- API: unauthenticated request gets 401; branch outside the user's access gets an empty or restricted result; `mode=lines` drops other-branch lines.
- Manual check on the dev server with branch TARLAC:
  - ticking TARP260091 lists its 9 lines with CBM and weight;
  - unticking removes them;
  - switching branch clears the selection;
  - the main Purchase Orders tab still shows the same table and filters as before.
- Lint (`eslint`) on the new and edited files. No production build.

---

## 8. Open questions (defaults used if no answer)

1. **Status filter default:** active POs only (Open, On Hold, Pending Approval). Should Closed and Completed POs be listable too? The filter makes them available either way.
2. **Order Qty vs open qty:** the sample uses Order Qty. Should Qty (Manual) default to the **open** qty (ordered minus received) for partly received POs? Default: Order Qty, as in the sample.
3. **Saving packing lists to the server (phase 2):** needed now, or is browser storage enough for the first version?
