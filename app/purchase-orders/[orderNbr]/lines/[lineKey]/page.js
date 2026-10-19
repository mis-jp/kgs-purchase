"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import InventoryDetailModal from "@/components/InventoryDetailModal";
import { Breadcrumb, Card, DASH, DefGrid, Stat, StatusPill } from "@/components/PoDetailParts";
import { calcBoxCbm, calcPieceWeightKg, calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import { calcPoLineWeightKg, poDetailHref } from "@/lib/po-metrics";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";
import "@/styles/inventory-detail.css";
import "@/styles/po-detail.css";

function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
    if (n == null || n === "" || !Number.isFinite(Number(n))) return "";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtDate(d) {
    if (!d) return "";
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

export default function PurchaseOrderLinePage() {
    const params = useParams();
    const orderNbr = useMemo(() => decodeParam(params?.orderNbr), [params]);
    const lineKey = useMemo(() => decodeParam(params?.lineKey), [params]);

    const [order, setOrder] = useState(null);
    const [line, setLine] = useState(null);
    const [item, setItem] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showItem, setShowItem] = useState(false);

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
        if (orderNbr && line?.inventoryId) document.title = `${line.inventoryId} \u00b7 PO ${orderNbr}`;
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
    const weight = line ? calcPoLineWeightKg(dim, line.qty) : null;
    const boxCbm = dim ? (calcBoxCbm(dim.length_m, dim.height_m, dim.width_m) ?? dim.cbm) : null;
    const pieceKg = dim ? calcPieceWeightKg(dim.weight_kg, dim.pcs_per_box) : null;
    const branches = Array.isArray(item?.branches) ? item.branches : [];
    const lineLabel = line?.lineNbr != null ? `Line ${line.lineNbr}` : `Line ${line?.position || lineKey}`;

    const crumbs = [
        { label: "\u2190 Purchase Orders", href: "/purchase-orders" },
        { label: `PO ${orderNbr}`, href: poDetailHref(orderNbr) },
        { label: line ? lineLabel : `Line ${lineKey}` },
    ];

    return (
        <div className="po-root">
            <main className="po-main">
                <div className="pod-container">
                    <Card accent>
                        <Breadcrumb crumbs={crumbs} />
                        <div className="pod-header-row">
                            <div className="pod-header-main">
                                <h1 className="pod-title">{line?.description || line?.inventoryId || `PO ${orderNbr}`}</h1>
                                <div className="pod-subtitle">
                                    {line?.inventoryId && (
                                        <button type="button" className="pod-chip" title="Open item details" onClick={() => setShowItem(true)}>
                                            {line.inventoryId}
                                        </button>
                                    )}
                                    <span>PO {orderNbr}</span>
                                    {order?.vendorName && <span>{"\u00b7"} {order.vendorName}</span>}
                                </div>
                            </div>
                            <div className="pod-header-actions">
                                <StatusPill status={order?.status} />
                                {orderNbr && <Link className="pod-btn" href={poDetailHref(orderNbr)}>Open whole PO</Link>}
                            </div>
                        </div>
                    </Card>

                    {loading ? (
                        <Card><p className="pod-state">{"Loading PO line\u2026"}</p></Card>
                    ) : error ? (
                        <Card><p className="pod-state" role="alert">{error}</p></Card>
                    ) : !order || !line ? (
                        <Card><p className="pod-state">Line {lineKey} of purchase order {orderNbr} was not found, or your branch access does not include it.</p></Card>
                    ) : (
                        <>
                            <div className="pod-stats">
                                <Stat label="Quantity" value={fmtNum(line.qty)} unit={line.uom} />
                                <Stat label="Received / Open" value={`${fmtNum(line.receivedQty) || 0} / ${fmtNum(line.openQty) || 0}`} />
                                <Stat label="Total CBM" value={totalCbm == null ? "" : formatCbm(totalCbm, 4)} hint="Set dimensions in Stock Items" />
                                <Stat label="Weight" value={weight == null ? "" : formatWeightKg(weight)} unit="kg" hint="Set KG in Stock Items" />
                                <Stat label="Unit Cost" value={unitCost == null ? "" : `\u20b1${fmt(unitCost)}`} />
                                <Stat label="Ext. Cost" value={`\u20b1${fmt(extCost)}`} accent />
                            </div>

                            <div className="pod-grid-2">
                                <Card title="Purchase order">
                                    <DefGrid items={[
                                        { label: "Order #", value: order.orderNbr },
                                        { label: "Status", value: order.status ? <StatusPill status={order.status} /> : "" },
                                        { label: "Vendor ID", value: order.vendorId },
                                        { label: "Vendor name", value: order.vendorName },
                                        { label: "PO date", value: fmtDate(order.date) },
                                        { label: "ETD (Promised On)", value: fmtDate(order.promisedDate) },
                                        { label: "Branch / Warehouse", value: line.branchId || line.warehouseId },
                                        { label: "Line", value: `${lineLabel} of ${order.lineCount}` },
                                    ]} />
                                </Card>

                                <Card title="Item (Stock Items)">
                                    {!item ? (
                                        <p className="pod-state">No Stock Items data for this item.</p>
                                    ) : (
                                        <>
                                            <DefGrid items={[
                                                { label: "Total on hand", value: fmtNum(item.totalOnHand) },
                                                { label: "Total available", value: fmtNum(item.totalAvailable) },
                                                { label: "KG per box", value: dim?.weight_kg != null ? `${formatWeightKg(dim.weight_kg) ?? DASH} kg` : "" },
                                                { label: "Piece weight", value: pieceKg == null ? "" : `${formatWeightKg(pieceKg)} kg` },
                                                { label: "PCS / box", value: fmtNum(dim?.pcs_per_box) },
                                                { label: "Box size L \u00d7 H \u00d7 W (m)", value: dim && (dim.length_m || dim.height_m || dim.width_m) ? `${fmtNum(dim.length_m) || DASH} \u00d7 ${fmtNum(dim.height_m) || DASH} \u00d7 ${fmtNum(dim.width_m) || DASH}` : "" },
                                                { label: "Box CBM", value: boxCbm == null ? "" : formatCbm(boxCbm, 4) },
                                            ]} />
                                            {branches.length > 0 && (
                                                <div className="pod-table-wrap">
                                                    <table className="pod-table">
                                                        <thead>
                                                            <tr><th>Branch</th><th className="pod-num">On hand</th><th className="pod-num">Available</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            {branches.map((b, i) => (
                                                                <tr key={`${b.branchId}-${i}`}>
                                                                    <td>{b.branchId || DASH}</td>
                                                                    <td className="pod-num">{fmtNum(b.onHand) || 0}</td>
                                                                    <td className="pod-num">{fmtNum(b.available) || 0}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </Card>
                            </div>
                        </>
                    )}
                </div>
            </main>

            {showItem && line?.inventoryId && (
                <InventoryDetailModal
                    inventoryId={line.inventoryId}
                    onClose={() => setShowItem(false)}
                    onDimensionsSaved={(saved) => {
                        if (!saved) return;
                        setItem((prev) => (prev ? { ...prev, dimensions: { ...(prev.dimensions || {}), ...saved } } : prev));
                    }}
                />
            )}
        </div>
    );
}
