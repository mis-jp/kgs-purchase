"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import { DIMENSION_FIELDS, calcBoxCbm, calcPieceWeightKg, calcStockWeightKg, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import "@/styles/inventory-detail.css";

const IconClose = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const IconInfo = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
);

function stockStatus(onHand) {
    if (onHand <= 0) return { label: "Out of Stock", cls: "status-out" };
    if (onHand <= 10) return { label: "Low Stock", cls: "status-low" };
    return { label: "In Stock", cls: "status-in" };
}

function fmtDate(d) {
    if (!d) return "—";
    const raw = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const [y, m, day] = raw.slice(0, 10).split("-");
        return `${y}/${m}/${day}`;
    }
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
}

function dimObjectFromApi(dim) {
    if (!dim) {
        return { pcs_per_box: "", length_m: "", height_m: "", width_m: "", weight_kg: "", cbm: "" };
    }
    const out = {};
    for (const { key } of DIMENSION_FIELDS) {
        out[key] = dim[key] != null && dim[key] !== "" ? String(dim[key]) : "";
    }
    return out;
}

function dimPayloadFromForm(form) {
    const out = {};
    for (const { key } of DIMENSION_FIELDS) {
        const v = form[key];
        out[key] = v === "" || v === null || v === undefined ? null : Number(v);
    }
    return out;
}

export default function InventoryDetailModal({ inventoryId, onClose, onDimensionsSaved }) {
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notes, setNotes] = useState("");
    const [savingNotes, setSavingNotes] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const [dimensions, setDimensions] = useState({});
    const [savingDims, setSavingDims] = useState(false);
    const [dimSaved, setDimSaved] = useState(false);
    const notesTimer = useRef(null);
    const dimsTimer = useRef(null);
    const notesRef = useRef("");
    const dimsRef = useRef({});
    const notesDirty = useRef(false);
    const dimsDirty = useRef(false);
    const persistNotesRef = useRef(async () => {});
    const persistDimsRef = useRef(async () => {});

    useEffect(() => {
        if (!inventoryId) return;

        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        setDetail(null);
        setError(null);
        notesDirty.current = false;
        dimsDirty.current = false;
        setDimSaved(false);
        setNotesSaved(false);

        (async () => {
            try {
                const r = await fetchWithAuth(`/api/stock-items/${encodeURIComponent(inventoryId)}`, {
                    signal: controller.signal,
                });
                if (cancelled) return;
                const d = await r.json();
                if (!r.ok) {
                    throw new Error(d.error || d.message || "Failed to load details");
                }
                setDetail(d);
                const loadedNotes = d.annotations?.internal_notes || "";
                setNotes(loadedNotes);
                notesRef.current = loadedNotes;
                const loaded = dimObjectFromApi(d.dimensions);
                const boxCbm = calcBoxCbm(loaded.length_m, loaded.height_m, loaded.width_m);
                if (boxCbm != null) loaded.cbm = formatCbm(boxCbm, 4);
                setDimensions(loaded);
                dimsRef.current = loaded;
                setError(null);
            } catch (err) {
                if (cancelled) return;
                const aborted =
                    err.name === "AbortError" ||
                    String(err.message || "").toLowerCase().includes("abort");
                if (!aborted) {
                    setError(err.message || "Failed to load details.");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            if (notesTimer.current) clearTimeout(notesTimer.current);
            if (dimsTimer.current) clearTimeout(dimsTimer.current);
            if (notesDirty.current) persistNotesRef.current(notesRef.current);
            if (dimsDirty.current) persistDimsRef.current(dimsRef.current);
        };
    }, [inventoryId]);

    const persistNotes = async (value) => {
        if (!inventoryId) return;
        setSavingNotes(true);
        setNotesSaved(false);
        try {
            await fetchWithAuth("/api/annotations", {
                method: "POST",
                body: JSON.stringify({
                    module: "inventory",
                    refId: inventoryId,
                    fieldKey: "internal_notes",
                    fieldValue: value,
                }),
            });
            setDetail((prev) => prev ? {
                ...prev,
                annotations: { ...(prev.annotations || {}), internal_notes: value },
            } : prev);
            setNotesSaved(true);
            notesDirty.current = false;
        } catch (err) {
            console.error("Failed to save notes", err);
        } finally {
            setSavingNotes(false);
        }
    };
    persistNotesRef.current = persistNotes;

    const persistDimensions = async (formState) => {
        if (!inventoryId) return;
        setSavingDims(true);
        setDimSaved(false);
        try {
            const boxCbm = calcBoxCbm(formState.length_m, formState.height_m, formState.width_m);
            const form = {
                ...formState,
                cbm: boxCbm != null ? String(boxCbm) : formState.cbm,
            };
            const res = await fetchWithAuth(`/api/stock-items/${encodeURIComponent(inventoryId)}/dimensions`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(dimPayloadFromForm(form)),
            });
            if (!res.ok) throw new Error("Save failed");
            const data = await res.json();
            const saved = dimObjectFromApi(data.dimensions);
            const recalc = calcBoxCbm(saved.length_m, saved.height_m, saved.width_m);
            if (recalc != null) saved.cbm = formatCbm(recalc, 4);
            setDimensions(saved);
            dimsRef.current = saved;
            dimsDirty.current = false;
            setDimSaved(true);
            setDetail((prev) => prev ? { ...prev, dimensions: data.dimensions } : prev);
            onDimensionsSaved?.(data.dimensions || {
                inventoryId,
                ...dimPayloadFromForm(saved),
            });
        } catch (err) {
            console.error("Failed to save dimensions", err);
        } finally {
            setSavingDims(false);
        }
    };
    persistDimsRef.current = persistDimensions;

    const handleNotesChange = (value) => {
        notesDirty.current = true;
        notesRef.current = value;
        setNotesSaved(false);
        setNotes(value);
        if (notesTimer.current) clearTimeout(notesTimer.current);
        notesTimer.current = setTimeout(() => persistNotes(value), 500);
    };

    const handleDimChange = (key, value) => {
        dimsDirty.current = true;
        setDimSaved(false);
        setDimensions((prev) => {
            const next = { ...prev, [key]: value };
            if (key === "length_m" || key === "height_m" || key === "width_m") {
                const boxCbm = calcBoxCbm(next.length_m, next.height_m, next.width_m);
                next.cbm = boxCbm != null ? formatCbm(boxCbm, 4) : "";
            }
            dimsRef.current = next;
            if (dimsTimer.current) clearTimeout(dimsTimer.current);
            dimsTimer.current = setTimeout(() => persistDimensions(next), 500);
            return next;
        });
    };

    const autoCbm = useMemo(
        () => calcBoxCbm(dimensions.length_m, dimensions.height_m, dimensions.width_m),
        [dimensions.length_m, dimensions.height_m, dimensions.width_m]
    );
    const pieceKg = useMemo(
        () => calcPieceWeightKg(dimensions.weight_kg, dimensions.pcs_per_box),
        [dimensions.weight_kg, dimensions.pcs_per_box]
    );
    const onHandKg = useMemo(
        () => calcStockWeightKg({
            weight_kg: dimensions.weight_kg,
            pcs_per_box: dimensions.pcs_per_box,
            qty: detail?.totalOnHand,
        }),
        [dimensions.weight_kg, dimensions.pcs_per_box, detail?.totalOnHand]
    );

    if (!inventoryId) return null;

    const totalStatus = detail ? stockStatus(detail.totalOnHand) : null;

    return (
        <div className="idm-overlay" onClick={onClose}>
            <div className="idm-modal" onClick={e => e.stopPropagation()}>
                <button className="idm-close-btn" onClick={onClose} aria-label="Close">
                    <IconClose />
                </button>

                {loading && (
                    <div className="idm-loading">
                        <div className="idm-spinner"></div>
                        <p>Fetching item details...</p>
                    </div>
                )}

                {error && (
                    <div className="idm-error">
                        <p>{error}</p>
                        <button onClick={() => window.location.reload()}>Retry</button>
                    </div>
                )}

                {detail && !loading && (
                    <div className="idm-content">
                        {/* Header Section */}
                        <header className="idm-header">
                            <div className="idm-top-row">
                                <span className="idm-badge-id">{inventoryId}</span>
                                <span className="idm-badge-class">{detail.itemClass}</span>
                            </div>
                            <h2 className="idm-title">{detail.description}</h2>
                            
                            <div className="idm-source-row">
                                {detail.source === "acumatica" && (
                                    <span className="idm-source idm-source-live">● Live from Acumatica</span>
                                )}
                                {detail.source === "mysql" && (
                                    <span className="idm-source idm-source-live">● Live from MySQL</span>
                                )}
                                {detail.source === "supabase" && (
                                    <span className="idm-source idm-source-cache">● From local database</span>
                                )}
                                {detail.notice && (
                                    <span className="idm-source idm-source-warn">● {detail.notice}</span>
                                )}
                            </div>
                        </header>

                        {/* Summary Cards */}
                        <div className="idm-grid">
                            <div className="idm-card">
                                <span className="idm-card-label">Total On Hand</span>
                                <div className="idm-card-value-group">
                                    <span className="idm-card-value">{(Number(detail.totalOnHand) || 0).toLocaleString()}</span>
                                    {totalStatus && (
                                        <span className={`idm-status-pill ${totalStatus.cls}`}>{totalStatus.label}</span>
                                    )}
                                </div>
                            </div>
                            <div className="idm-card">
                                <span className="idm-card-label">Total Available</span>
                                <div className="idm-card-value-group">
                                    <span className="idm-card-value">{(Number(detail.totalAvailable) || 0).toLocaleString()}</span>
                                    <span className="idm-card-label" style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>Units</span>
                                </div>
                            </div>
                            <div className="idm-card">
                                <span className="idm-card-label">Unit Price</span>
                                <div className="idm-card-value-group">
                                    <span className="idm-card-value">₱{(Number(detail.unitPrice) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                            </div>
                            <div className="idm-card">
                                <span className="idm-card-label">Base Unit</span>
                                <div className="idm-card-value-group">
                                    <span className="idm-card-value" style={{ fontSize: '1.25rem' }}>{detail.baseUnit || "—"}</span>
                                </div>
                            </div>
                        </div>

                        {/* Metadata row */}
                        <div className="idm-meta-bar">
                            <div className="idm-meta-item">
                                <span className="idm-meta-label">Status:</span>
                                <span className="idm-meta-value" style={{ fontWeight: '700' }}>{detail.itemStatus}</span>
                            </div>
                            <div className="idm-meta-item">
                                <span className="idm-meta-label">Class:</span>
                                <span className="idm-meta-value">{detail.itemClass}</span>
                            </div>
                            <div className="idm-meta-item">
                                <span className="idm-meta-label">Type:</span>
                                <span className="idm-meta-value">{detail.type || "—"}</span>
                            </div>
                            <div className="idm-meta-item">
                                <span className="idm-meta-label">Posting Class:</span>
                                <span className="idm-meta-value">{detail.postingClass || "—"}</span>
                            </div>
                            <div className="idm-meta-item">
                                <span className="idm-meta-label">Def. Warehouse:</span>
                                <span className="idm-meta-value">{detail.defaultWarehouse || "—"}</span>
                            </div>
                            {detail.lastSync && (
                                <div className="idm-meta-item">
                                    <span className="idm-meta-label">Last Sync:</span>
                                    <span className="idm-meta-value">{fmtDate(detail.lastSync)}</span>
                                </div>
                            )}
                        </div>

                        {/* Packaging dimensions */}
                        <div className="idm-section">
                            <h3 className="idm-section-title">Packaging Dimensions</h3>
                            <p className="idm-dim-hint">
                                Per-box measurements for this item (stored in this app only).
                                CBM is L × H × W. On-hand weight is Box KG × the quantity on hand.
                            </p>
                            <div className="idm-dim-grid">
                                {DIMENSION_FIELDS.map(({ key, label, step }) => {
                                    const isCbm = key === "cbm";
                                    const displayValue = isCbm
                                        ? (autoCbm != null ? formatCbm(autoCbm, 4) : (dimensions[key] ?? ""))
                                        : (dimensions[key] ?? "");
                                    const fieldLabel = key === "weight_kg" ? "Box KG" : label;
                                    return (
                                        <label key={key} className={`idm-dim-field${isCbm ? " idm-dim-field-calc" : ""}`}>
                                            <span className="idm-dim-label">
                                                {fieldLabel}
                                                {isCbm ? " (auto)" : ""}
                                            </span>
                                            <input
                                                type="number"
                                                step={step}
                                                min="0"
                                                className="idm-dim-input"
                                                value={displayValue}
                                                onChange={(e) => !isCbm && handleDimChange(key, e.target.value)}
                                                placeholder="—"
                                                readOnly={isCbm}
                                                tabIndex={isCbm ? -1 : undefined}
                                                title={
                                                    isCbm
                                                        ? "Calculated from L × H × W"
                                                        : key === "weight_kg"
                                                            ? "Weight of one carton"
                                                            : undefined
                                                }
                                            />
                                        </label>
                                    );
                                })}
                                <label className="idm-dim-field idm-dim-field-calc">
                                    <span className="idm-dim-label">Piece KG (auto)</span>
                                    <input
                                        type="text"
                                        className="idm-dim-input"
                                        value={pieceKg == null ? "" : formatWeightKg(pieceKg)}
                                        readOnly
                                        tabIndex={-1}
                                        placeholder="—"
                                        title="Box KG divided by pieces per box"
                                    />
                                </label>
                                <label className="idm-dim-field idm-dim-field-calc">
                                    <span className="idm-dim-label">On-hand KG (auto)</span>
                                    <input
                                        type="text"
                                        className="idm-dim-input"
                                        value={onHandKg == null ? "" : formatWeightKg(onHandKg)}
                                        readOnly
                                        tabIndex={-1}
                                        placeholder="—"
                                        title="Box KG multiplied by the quantity on hand"
                                    />
                                </label>
                            </div>
                            <div className="idm-dim-actions">
                                <span className="idm-dim-saved" aria-live="polite">
                                    {savingDims ? "Saving…" : dimSaved ? "Saved" : "Autosaves as you type"}
                                </span>
                            </div>
                        </div>

                        {/* Internal Notes Section */}
                        <div className="idm-section">
                            <h3 className="idm-section-title">Internal Notes & Annotations</h3>
                            <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--border-light)' }}>
                                <textarea
                                    className="idm-notes-area"
                                    placeholder="Add internal notes about this item (e.g., replacement info, quality notes)..."
                                    value={notes}
                                    onChange={(e) => handleNotesChange(e.target.value)}
                                    style={{ 
                                        width: '100%', 
                                        minHeight: '80px', 
                                        background: 'transparent', 
                                        border: 'none', 
                                        color: 'var(--text-primary)',
                                        fontSize: '0.9rem',
                                        resize: 'vertical',
                                        outline: 'none'
                                    }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                                    <span className="idm-dim-saved" aria-live="polite">
                                        {savingNotes ? "Saving…" : notesSaved ? "Saved" : "Autosaves as you type"}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Warehouse Breakdown */}
                        <div className="idm-section">
                            <h3 className="idm-section-title">Stock by Warehouse / Branch</h3>
                            <div className="idm-table-container">
                                <table className="idm-table">
                                    <thead>
                                        <tr>
                                            <th>Warehouse</th>
                                            <th className="idm-txt-right">On Hand</th>
                                            <th className="idm-txt-right">Available</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {detail.branches && detail.branches.length === 0 ? (
                                            <tr><td colSpan={4} className="idm-empty">No warehouse data available.</td></tr>
                                        ) : (
                                            (detail.branches || []).map(b => {
                                                const s = stockStatus(b.onHand);
                                                return (
                                                    <tr key={b.branchId || b.siteId}>
                                                        <td><strong>{b.branchId || b.siteId}</strong></td>
                                                        <td className="idm-txt-right idm-txt-bold">{Number(b.onHand).toLocaleString()}</td>
                                                        <td className="idm-txt-right">{Number(b.available).toLocaleString()}</td>
                                                        <td><span className={`idm-status-pill idm-status-pill-sm ${s.cls}`}>{s.label}</span></td>
                                                    </tr>
                                                );
                                            })
                                        )}
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            <td>TOTAL</td>
                                            <td className="idm-txt-right">{Number(detail.totalOnHand).toLocaleString()}</td>
                                            <td className="idm-txt-right">{Number(detail.totalAvailable).toLocaleString()}</td>
                                            <td></td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
