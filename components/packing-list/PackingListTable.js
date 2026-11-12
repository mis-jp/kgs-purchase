"use client";

import { useEffect, useMemo, useState } from "react";
import {
    CONTAINER_TYPES,
    CUSTOM_CONTAINER_ID,
    PACKING_COLUMNS,
    containerLimitError,
    containerLimitsText,
    containerMixText,
    containerOptions,
    containerTypesChanged,
    loadContainerLimits,
    resolveContainerTypes,
    saveContainerLimits,
    freightRatePerCbm,
    packingLineFreight,
    parseManualQty,
    recommendContainerMix,
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

function FillBar({ label, pct }) {
    const width = Math.min(100, Math.max(0, pct));
    return (
        <div className="pl-fill">
            <span className="pl-fill-label">{label} {pct}%</span>
            <span className="pl-fill-track" aria-hidden="true">
                <span className={`pl-fill-bar${pct > 95 ? " pl-fill-bar--full" : ""}`} style={{ width: `${width}%` }} />
            </span>
        </div>
    );
}

function qtyText(value) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function LimitInput({ value, kind, placeholder, label, onChange }) {
    const error = containerLimitError(value, kind);
    return (
        <span className="pl-limit-cell">
            <input
                className={`pl-qty-input pl-limit-input${error ? " is-invalid" : ""}`}
                type="text"
                inputMode="decimal"
                value={value ?? ""}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                aria-label={label}
                aria-invalid={error ? "true" : undefined}
            />
            {error && <span className="pl-limit-error">{error}</span>}
        </span>
    );
}

function ContainerLimitsEditor({ limits, onChange, onReset }) {
    const set = (id, field, value) => onChange({ ...limits, [id]: { ...(limits[id] || {}), [field]: value } });
    const custom = limits[CUSTOM_CONTAINER_ID] || {};
    const customIncomplete = custom.enabled && (
        String(custom.cbm ?? "").trim() === "" || String(custom.kg ?? "").trim() === ""
        || containerLimitError(custom.cbm, "cbm") || containerLimitError(custom.kg, "kg")
    );
    return (
        <div className="pl-limits">
            <table className="pl-limits-table">
                <thead>
                    <tr>
                        <th>Container</th>
                        <th>Usable volume (m³)</th>
                        <th>Max weight (kg)</th>
                    </tr>
                </thead>
                <tbody>
                    {CONTAINER_TYPES.map((c) => (
                        <tr key={c.id}>
                            <td>{c.label}</td>
                            <td>
                                <LimitInput
                                    kind="cbm"
                                    value={limits[c.id]?.cbm}
                                    placeholder={String(c.usableCbm)}
                                    label={`${c.label} usable volume`}
                                    onChange={(v) => set(c.id, "cbm", v)}
                                />
                            </td>
                            <td>
                                <LimitInput
                                    kind="kg"
                                    value={limits[c.id]?.kg}
                                    placeholder={c.maxKg.toLocaleString()}
                                    label={`${c.label} max weight`}
                                    onChange={(v) => set(c.id, "kg", v)}
                                />
                            </td>
                        </tr>
                    ))}
                    <tr className="pl-limits-custom">
                        <td>
                            <label className="pl-limits-check">
                                <input
                                    type="checkbox"
                                    checked={!!custom.enabled}
                                    onChange={(e) => set(CUSTOM_CONTAINER_ID, "enabled", e.target.checked)}
                                />
                                <input
                                    className="pl-qty-input pl-limit-name"
                                    type="text"
                                    maxLength={40}
                                    value={custom.label ?? ""}
                                    placeholder="Custom container, e.g. 10-wheeler truck"
                                    onChange={(e) => set(CUSTOM_CONTAINER_ID, "label", e.target.value)}
                                    disabled={!custom.enabled}
                                    aria-label="Custom container name"
                                />
                            </label>
                        </td>
                        <td>
                            <LimitInput
                                kind="cbm"
                                value={custom.cbm}
                                placeholder="m³"
                                label="Custom container usable volume"
                                onChange={(v) => set(CUSTOM_CONTAINER_ID, "cbm", v)}
                            />
                        </td>
                        <td>
                            <LimitInput
                                kind="kg"
                                value={custom.kg}
                                placeholder="kg"
                                label="Custom container max weight"
                                onChange={(v) => set(CUSTOM_CONTAINER_ID, "kg", v)}
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
            <div className="pl-limits-foot">
                <span>
                    {customIncomplete
                        ? "Enter a volume and a weight to include the custom container."
                        : "Leave a box blank to use the standard limit. Changes apply right away and are saved on this computer."}
                </span>
                <button type="button" className="pl-link-btn" onClick={onReset}>Reset to standard</button>
            </div>
        </div>
    );
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
    truckingFee = "",
    onTruckingFeeChange,
}) {
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState("");
    const [limits, setLimits] = useState({});
    const [editingLimits, setEditingLimits] = useState(false);

    useEffect(() => {
        Promise.resolve().then(() => setLimits(loadContainerLimits()));
    }, []);

    const updateLimits = (next) => {
        setLimits(next);
        saveContainerLimits(next);
    };

    const sorted = useMemo(() => sortPackingLines(lines), [lines]);
    const totals = useMemo(() => packingTotals(lines, manual, branch), [lines, manual, branch]);
    const missingSize = Math.max(totals.missingCbm, totals.missingWeight);
    const types = useMemo(() => resolveContainerTypes(limits), [limits]);
    const customLimits = containerTypesChanged(types);
    const containers = useMemo(() => containerOptions(totals.cbm, totals.weightKg, types), [totals.cbm, totals.weightKg, types]);
    const mix = useMemo(() => recommendContainerMix(totals.cbm, totals.weightKg, types), [totals.cbm, totals.weightKg, types]);
    const hasManual = sorted.some((l) => manual[packingLineKey(branch, l.orderNbr, l.lineNbr, l.inventoryId)] !== undefined);
    const fee = parseManualQty(truckingFee);
    const feeInvalid = String(truckingFee).trim() !== "" && fee === null;
    const rate = freightRatePerCbm(truckingFee, totals.cbm);
    const freightTotal = useMemo(() => {
        if (rate === null) return null;
        return sorted.reduce((sum, line) => {
            const t = packingLineTotals(line, manual[packingLineKey(branch, line.orderNbr, line.lineNbr, line.inventoryId)]);
            return sum + (packingLineFreight(t, rate).freight || 0);
        }, 0);
    }, [sorted, manual, branch, rate]);

    const exportExcel = async () => {
        setExporting(true);
        setExportError("");
        try {
            const XLSX = await import("xlsx");
            const sheet = XLSX.utils.aoa_to_sheet(
                [
                    [null, "Trucking Fee", fee],
                    [null, "Rate per cbm", rate === null ? null : Math.round(rate * 100) / 100],
                    [],
                    PACKING_COLUMNS,
                    ...packingSheetRows(lines, manual, branch, truckingFee),
                ],
                { cellDates: true, dateNF: "yyyy-mm-dd" }
            );
            sheet["!cols"] = [10, 14, 12, 48, 18, 11, 12, 12, 13, 18, 11].map((wch) => ({ wch }));
            const summary = XLSX.utils.aoa_to_sheet([
                ["Branch", branch],
                ["Purchase orders", totals.orderCount],
                ["Lines", totals.lineCount],
                ["Total qty", totals.qty],
                ["Total CBM", totals.cbm],
                ["Total weight (kg)", totals.weightKg],
                ["Lines without size", totals.missingCbm],
                ["Lines without weight", totals.missingWeight],
                ["Trucking fee", fee],
                ["Rate per CBM", rate === null ? null : Math.round(rate * 100) / 100],
                ["Total freight", freightTotal === null ? null : Math.round(freightTotal * 100) / 100],
                [],
                ["Suggested containers", containerMixText(mix) || "—"],
                ...containers.map((c) => [
                    c.label,
                    `${c.count} container(s), ${c.cbmFillPct}% volume, ${c.weightFillPct}% weight`,
                ]),
                [],
                [customLimits ? "Loading limits (custom)" : "Loading limits (standard)", containerLimitsText(types)],
            ]);
            summary["!cols"] = [{ wch: 22 }, { wch: 48 }];
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

            {selectedCount > 0 && !error && (
                <div className="pl-freight-bar">
                    <label className="pl-freight-field">
                        <span>Trucking Fee</span>
                        <input
                            className={`pl-qty-input pl-freight-input${feeInvalid ? " is-invalid" : ""}`}
                            type="text"
                            inputMode="decimal"
                            value={truckingFee}
                            placeholder="0.00"
                            onChange={(e) => onTruckingFeeChange?.(e.target.value)}
                            aria-label="Trucking fee"
                            title="Total trucking cost. It is shared across lines by CBM."
                        />
                    </label>
                    <div className="pl-freight-field">
                        <span>Rate per CBM</span>
                        <strong>{rate === null ? "—" : num(rate, 2)}</strong>
                    </div>
                    <span className="pl-freight-hint">
                        {feeInvalid
                            ? "Enter the trucking fee as a number, e.g. 44000."
                            : fee !== null && rate === null
                                ? "No CBM yet: add sizes in Stock Items to share the fee."
                                : "Freight per line = line CBM × rate. Freight/Pc = line freight ÷ qty."}
                    </span>
                </div>
            )}

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
                                            <th key={c} className={/^(Order Qty|Qty|Total|Freight)/.test(c) ? "pl-num" : undefined}>
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
                                        const f = packingLineFreight(t, rate);
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
                                                <td className="pl-num">{num(f.freight, 2)}</td>
                                                <td className="pl-num">{num(f.freightPerPc, 2)}</td>
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
                                        <td className="pl-num pl-freight-total">{num(freightTotal, 2)}</td>
                                        <td />
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
                    {!loading && containers.length > 0 && (
                        <div className="pl-containers" aria-label="Container planning">
                            <div className="pl-containers-head">
                                <h4>Container planning</h4>
                                <span className="pl-containers-mix">
                                    Suggested: <strong>{containerMixText(mix)}</strong>
                                </span>
                                <button
                                    type="button"
                                    className="pl-link-btn"
                                    onClick={() => setEditingLimits((v) => !v)}
                                    aria-expanded={editingLimits}
                                >
                                    {editingLimits ? "Done" : "Edit limits"}
                                </button>
                            </div>
                            {editingLimits && (
                                <ContainerLimitsEditor
                                    limits={limits}
                                    onChange={updateLimits}
                                    onReset={() => updateLimits({})}
                                />
                            )}
                            <div className="pl-containers-grid">
                                {containers.map((c) => (
                                    <div key={c.id} className="pl-container-card">
                                        <span className="pl-container-label">{c.label}</span>
                                        <span className="pl-container-limit">
                                            {c.usableCbm.toLocaleString()} m³ / {c.maxKg.toLocaleString()} kg
                                        </span>
                                        <strong className="pl-container-count">{c.count} needed</strong>
                                        <FillBar label="Volume" pct={c.cbmFillPct} />
                                        <FillBar label="Weight" pct={c.weightFillPct} />
                                        {c.limitedBy === "weight" && (
                                            <span className="pl-container-hint">Weight sets the count</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <p className="pl-note">
                                {customLimits ? "Uses your loading limits" : "Uses practical loading limits"}: {containerLimitsText(types)}.
                                {" "}Containers needed = the larger of total volume ÷ volume limit and total weight ÷ weight limit, rounded up.
                                {missingSize > 0 ? " Lines without size or weight are not counted." : ""}
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
