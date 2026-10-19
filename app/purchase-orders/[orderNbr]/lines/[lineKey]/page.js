"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import { calcBoxCbm, calcPieceWeightKg, calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import { calcLineWeightKg, poDetailHref } from "@/lib/po-metrics";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";

const DASH = "\u2014";

function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
    if (n == null || n === "" || !Number.isFinite(Number(n))) return DASH;
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtDate(d) {
    if (!d) return DASH;
    const raw = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10).replace(/-/g, "/");
    const date = new Date(raw);
    if (isNaN(date.getTime())) return raw;
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}/${m}/${day}`;
}

function decodeParam(v) {
    const raw = Array.isArray(v) ? v[0] : v;
    try {
        return decodeURIComponent(String(raw || "")).trim();
    } catch {
        return String(raw || "").trim();
    }
}

function Row({ label, children }) {
    return (
        <tr>
            <th style={{ width: 220 }}>{label}</th>
            <td>{children}</td>
        </tr>
    );
}

export default function PurchaseOrderLinePage() {
    const params = useParams();
    const orderNbr = useMemo(() => decodeParam(params?.orderNbr), [params]);
    const lineKey = useMemo(() => decodeParam(params?.lineKey), [params]);

    const [order, setOrder] = useState(null);
    const [line, setLine] = useState(null);
    const [item, setItem] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!orderNbr || !lineKey) return;
        let active = true;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const qs = new URLSearchParams({ orderNbr, lineKey });
                const res = await fetchWithAuth(`/api/po/line?${qs}`);
                if (res.status === 404) {
                    if (active) { setOrder(null); setLine(null); }
                    return;
                }
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.message || `HTTP ${res.status}`);
                }
                const data = await res.json();
                if (!active) return;
                setOrder(data.order || null);
                setLine(data.line || null);
                const id = String(data.line?.inventoryId || "").trim();
                if (id) {
                    // Same Stock Items detail API the item popup uses (dimensions, KG, on hand).
                    const iRes = await fetchWithAuth(`/api/stock-items/${encodeURIComponent(id)}`);
                    if (iRes.ok && active) setItem(await iRes.json());
                }
            } catch (err) {
                if (active && err.message !== "Unauthorized") setError(err.message || "Failed to load PO line.");
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [orderNbr, lineKey]);

    useEffect(() => {
        if (orderNbr && line?.inventoryId) document.title = `PO ${orderNbr} \u00b7 ${line.inventoryId}`;
    }, [orderNbr, line]);

    const dim = item?.dimensions || null;
    const qty = Number(line?.qty) || 0;
    const extCost = Number(line?.extCost) || 0;
    const unitCost = qty > 0 ? extCost / qty : null;
    const totalCbm = line ? calcTotalCbm({
        length_m: dim?.length_m,
        height_m: dim?.height_m,
        width_m: dim?.width_m,
        cbm: dim?.cbm,
        pcs_per_box: dim?.pcs_per_box,
        qty: line.qty,
    }) : null;
    const weight = line ? calcLineWeightKg(dim, line.qty) : null;
    const boxCbm = dim ? (calcBoxCbm(dim.length_m, dim.height_m, dim.width_m) ?? dim.cbm) : null;
    const pieceKg = dim ? calcPieceWeightKg(dim.weight_kg, dim.pcs_per_box) : null;
    const branches = Array.isArray(item?.branches) ? item.branches : [];

    return (
        <div className="po-root">
            <main className="po-main">
                <p style={{ marginBottom: "1rem", display: "flex", gap: "1rem" }}>
                    <Link href="/purchase-orders">{"\u2190 Purchase Orders"}</Link>
                    {orderNbr && <Link href={poDetailHref(orderNbr)}>Whole PO {orderNbr}</Link>}
                </p>
                <div className="db-page-title">
                    <h1>{line?.inventoryId ? `${line.inventoryId} \u00b7 PO ${orderNbr}` : `PO ${orderNbr} line ${lineKey}`}</h1>
                </div>

                {loading ? (
                    <p className="si-loading-cell">{"Loading PO line\u2026"}</p>
                ) : error ? (
                    <p className="si-empty-cell" role="alert">{error}</p>
                ) : !order || !line ? (
                    <p className="si-empty-cell">Line {lineKey} of purchase order {orderNbr} was not found, or your branch access does not include it.</p>
                ) : (
                    <>
                        <h2 style={{ margin: "0 0 0.5rem" }}>Purchase order</h2>
                        <div className="db-table-wrap po-table-wrap" style={{ marginBottom: "1.5rem" }}>
                            <table className="db-table po-table">
                                <tbody>
                                    <Row label="Order #">{order.orderNbr}</Row>
                                    <Row label="Vendor">{[order.vendorId, order.vendorName].filter(Boolean).join(" \u00b7 ") || DASH}</Row>
                                    <Row label="Status">{order.status || DASH}</Row>
                                    <Row label="PO Date">{fmtDate(order.date)}</Row>
                                    <Row label="ETD (Promised On)">{fmtDate(order.promisedDate)}</Row>
                                    <Row label="Branch / Warehouse">{line.branchId || line.warehouseId || DASH}</Row>
                                </tbody>
                            </table>
                        </div>

                        <h2 style={{ margin: "0 0 0.5rem" }}>This line</h2>
                        <div className="db-table-wrap po-table-wrap" style={{ marginBottom: "1.5rem" }}>
                            <table className="db-table po-table">
                                <tbody>
                                    <Row label="Line">{line.lineNbr != null ? `#${line.lineNbr}` : `Position ${line.position}`} of {order.lineCount}</Row>
                                    <Row label="Item ID"><span className="db-inv-id">{line.inventoryId || DASH}</span></Row>
                                    <Row label="Description">{line.description || DASH}</Row>
                                    <Row label="Quantity">{fmtNum(line.qty)} {line.uom || ""}</Row>
                                    <Row label="Received / Open">{fmtNum(line.receivedQty)} / {fmtNum(line.openQty)}</Row>
                                    <Row label="Total CBM">{formatCbm(totalCbm, 4)}</Row>
                                    <Row label="Weight">{weight == null ? DASH : `${formatWeightKg(weight)} kg`}</Row>
                                    <Row label="Unit Cost">{unitCost == null ? DASH : `\u20b1${fmt(unitCost)}`}</Row>
                                    <Row label="Ext. Cost">{`\u20b1${fmt(extCost)}`}</Row>
                                </tbody>
                            </table>
                        </div>

                        <h2 style={{ margin: "0 0 0.5rem" }}>Item (Stock Items)</h2>
                        {!item ? (
                            <p className="si-empty-cell">No Stock Items data for this item.</p>
                        ) : (
                            <>
                                <div className="db-table-wrap po-table-wrap" style={{ marginBottom: "1.5rem" }}>
                                    <table className="db-table po-table">
                                        <tbody>
                                            <Row label="Total on hand">{fmtNum(item.totalOnHand)}</Row>
                                            <Row label="Total available">{fmtNum(item.totalAvailable)}</Row>
                                            <Row label="KG (per box)">{dim?.weight_kg != null ? `${formatWeightKg(dim.weight_kg) ?? DASH} kg` : DASH}</Row>
                                            <Row label="Piece weight">{pieceKg == null ? DASH : `${formatWeightKg(pieceKg)} kg`}</Row>
                                            <Row label="PCS/BOX">{fmtNum(dim?.pcs_per_box)}</Row>
                                            <Row label={"Box size L \u00d7 H \u00d7 W (m)"}>{dim ? `${fmtNum(dim.length_m)} \u00d7 ${fmtNum(dim.height_m)} \u00d7 ${fmtNum(dim.width_m)}` : DASH}</Row>
                                            <Row label="Box CBM">{boxCbm == null ? DASH : formatCbm(boxCbm, 4)}</Row>
                                        </tbody>
                                    </table>
                                </div>
                                {branches.length > 0 && (
                                    <div className="db-table-wrap po-table-wrap">
                                        <table className="db-table po-table">
                                            <thead>
                                                <tr><th>Branch</th><th style={{ textAlign: "right" }}>On hand</th><th style={{ textAlign: "right" }}>Available</th></tr>
                                            </thead>
                                            <tbody>
                                                {branches.map((b, i) => (
                                                    <tr key={`${b.branchId}-${i}`}>
                                                        <td>{b.branchId || DASH}</td>
                                                        <td style={{ textAlign: "right" }}>{fmtNum(b.onHand)}</td>
                                                        <td style={{ textAlign: "right" }}>{fmtNum(b.available)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
