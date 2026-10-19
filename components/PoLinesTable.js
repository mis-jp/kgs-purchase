"use client";

import { calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import { calcLineWeightKg } from "@/lib/po-metrics";

function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * PO item lines (Item ID, Description, Quantity, Total CBM, Weight, Ext. Cost).
 * Same markup the Purchase Orders list used for its inline expanded panel.
 */
export default function PoLinesTable({ lines, lookupDim, onItemClick }) {
    const rows = Array.isArray(lines) ? lines : [];
    return (
        <div className="po-lines-wrap">
            <table className="po-lines-table">
                <thead>
                    <tr>
                        <th style={{ width: 180 }}>Item ID</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'right', width: 120 }}>Quantity</th>
                        <th style={{ textAlign: 'right', width: 110 }}>Total CBM</th>
                        <th style={{ textAlign: 'right', width: 110 }}>Weight</th>
                        <th style={{ textAlign: 'right', width: 150 }}>Ext. Cost</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length > 0 ? rows.map((line, i) => {
                        const dim = lookupDim?.(line.inventoryId) || null;
                        const totalCbm = calcTotalCbm({
                            length_m: dim?.length_m,
                            height_m: dim?.height_m,
                            width_m: dim?.width_m,
                            cbm: dim?.cbm,
                            pcs_per_box: dim?.pcs_per_box,
                            qty: line.qty,
                        });
                        const weight = calcLineWeightKg(dim, line.qty);
                        return (
                            <tr key={i}>
                                <td>
                                    {onItemClick ? (
                                        <span
                                            className="db-inv-id si-clickable-id"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => onItemClick(line.inventoryId)}
                                            onKeyDown={(e) => { if (e.key === "Enter") onItemClick(line.inventoryId); }}
                                        >
                                            {line.inventoryId}
                                        </span>
                                    ) : (
                                        <span className="db-inv-id">{line.inventoryId}</span>
                                    )}
                                </td>
                                <td style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>{line.description}</td>
                                <td style={{ textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>
                                    {Number(line.qty).toLocaleString()} <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{line.uom}</span>
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }} title={dim ? "From L\u00d7H\u00d7W and PCS/BOX" : "Set packaging dimensions on the item"}>
                                    {formatCbm(totalCbm, 4)}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }} title={dim?.weight_kg != null ? "Box KG \u00d7 quantity (same as Stock Items Weight)" : "Set KG on the item"}>
                                    {weight == null ? "\u2014" : `${formatWeightKg(weight)} kg`}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: '700', color: 'var(--accent-primary)' }}>{"\u20b1"}{fmt(line.extCost)}</td>
                            </tr>
                        );
                    }) : (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No line items found for this order.</td></tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
