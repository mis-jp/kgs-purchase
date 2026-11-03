"use client";

import { useMemo, useState } from "react";
import {
    PACKING_COLUMNS,
    packingLineKey,
    packingLineTotals,
    packingSheetRows,
    packingTotals,
    sortPackingLines,
} from "@/lib/packing-list";

function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function num(value, digits = 0) {
    if (value === null || value === undefined) return "—";
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function qtyText(value) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function PackingListTable({
    branch,
    lines,
    selectedCount,
    loading,
    error,
    onRetry,
    manual,
    onManualChange,
    onClearManual,
}) {
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState("");

    const sorted = useMemo(() => sortPackingLines(lines), [lines]);
    const totals = useMemo(() => packingTotals(lines, manual, branch), [lines, manual, branch]);
    const missingSize = Math.max(totals.missingCbm, totals.missingWeight);
    const hasManual = sorted.some((l) => manual[packingLineKey(branch, l.orderNbr, l.lineNbr, l.inventoryId)] !== undefined);

    const exportExcel = async () => {
        setExporting(true);
        setExportError("");
        try {
            const XLSX = await import("xlsx");
            const sheet = XLSX.utils.aoa_to_sheet(
                [PACKING_COLUMNS, ...packingSheetRows(lines, manual, branch)],
                { cellDates: true, dateNF: "yyyy-mm-dd" }
            );
            sheet["!cols"] = [10, 14, 12, 48, 18, 11, 12, 12, 13].map((wch) => ({ wch }));
            const summary = XLSX.utils.aoa_to_sheet([
                ["Branch", branch],
                ["Purchase orders", totals.orderCount],
                ["Lines", totals.lineCount],
                ["Total qty", totals.qty],
                ["Total CBM", totals.cbm],
                ["Total weight (kg)", totals.weightKg],
                ["Lines without size", totals.missingCbm],
                ["Lines without weight", totals.missingWeight],
            ]);
            summary["!cols"] = [{ wch: 22 }, { wch: 16 }];
            const book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(book, sheet, "Packing List");
            XLSX.utils.book_append_sheet(book, summary, "Summary");
            const now = new Date();
            const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
            XLSX.writeFile(book, `PackingList_${branch}_${stamp}.xlsx`);
        } catch (err) {
            console.error("[Packing List] export failed", err);
            setExportError("Could not create the Excel file. Please try again.");
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="pl-panel pl-sheet">
            <div className="pl-panel-head">
                <h3 className="pl-panel-title">Packing List</h3>
                <div className="pl-sheet-actions">
                    {hasManual && (
                        <button type="button" className="pl-link-btn" onClick={onClearManual}>
                            Clear manual qty
                        </button>
                    )}
                    <button
                        type="button"
                        className="db-action-btn db-action-sync"
                        onClick={exportExcel}
                        disabled={exporting || loading || !sorted.length}
                    >
                        {exporting ? "Exporting…" : "Export to Excel"}
                    </button>
                </div>
            </div>
            {exportError && <div className="si-error">{exportError}</div>}

            {selectedCount === 0 ? (
                <div className="pl-empty">Tick one or more PO numbers on the left to build the packing list.</div>
            ) : error ? (
                <div className="pl-empty pl-error">
                    <span>{error}</span>
                    <button type="button" className="db-action-btn" onClick={onRetry}>Retry</button>
                </div>
            ) : (
                <>
                    {loading && <div className="pl-note">Loading items…</div>}
                    {!loading && !sorted.length && (
                        <div className="pl-empty">The selected POs have no items for this branch.</div>
                    )}
                    {sorted.length > 0 && (
                        <div className="db-table-wrap pl-table-wrap">
                            <table className="db-table pl-table">
                                <thead>
                                    <tr>
                                        {PACKING_COLUMNS.map((c) => (
                                            <th key={c} className={c.startsWith("Order Qty") || c.startsWith("Qty") || c.startsWith("Total") ? "pl-num" : undefined}>
                                                {c}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {sorted.map((line, i) => {
                                        const key = packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId);
                                        const value = manual[key] ?? "";
                                        const t = packingLineTotals(line, value);
                                        return (
                                            <tr key={`${key}#${i}`} className={t.overOrdered ? "pl-row-over" : undefined}>
                                                <td>{branch}</td>
                                                <td className="pl-nowrap">{line.orderNbr}</td>
                                                <td className="pl-nowrap">{formatDate(line.orderDate)}</td>
                                                <td className="pl-desc" title={line.description || ""}>{line.description || "—"}</td>
                                                <td className="pl-nowrap">
                                                    {line.inventoryId}
                                                    {!line.dimensions && <span className="pl-tag">No size</span>}
                                                </td>
                                                <td className="pl-num">{qtyText(line.qty)}</td>
                                                <td className="pl-num">
                                                    <input
                                                        className="pl-qty-input"
                                                        type="text"
                                                        inputMode="decimal"
                                                        value={value}
                                                        placeholder={qtyText(line.qty)}
                                                        onChange={(e) => onManualChange(line, e.target.value)}
                                                        aria-label={`Manual qty for ${line.inventoryId} on ${line.orderNbr}`}
                                                        title={t.overOrdered ? "More than the order qty" : "Leave blank to use the order qty"}
                                                    />
                                                </td>
                                                <td className="pl-num">{num(t.cbm, 4)}</td>
                                                <td className="pl-num">{t.weightKg === null ? "—" : `${num(t.weightKg, 2)} kg`}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="pl-total-row">
                                        <td>Total</td>
                                        <td>{totals.orderCount} PO(s)</td>
                                        <td />
                                        <td>{totals.lineCount} line(s)</td>
                                        <td />
                                        <td />
                                        <td className="pl-num">{qtyText(totals.qty)}</td>
                                        <td className="pl-num">{num(totals.cbm, 4)}</td>
                                        <td className="pl-num">{num(totals.weightKg, 2)} kg</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    )}
                    {missingSize > 0 && (
                        <div className="pl-note">
                            {missingSize} line(s) have no size or weight in Stock Items, so they are left out of the totals.
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
