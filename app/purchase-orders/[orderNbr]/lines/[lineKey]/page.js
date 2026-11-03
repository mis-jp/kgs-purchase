"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import { usePoLiveRefresh } from "@/lib/use-po-live-refresh";
import InventoryDetailModal from "@/components/InventoryDetailModal";
import { Breadcrumb, Card, DASH, DefGrid, Stat, StatusPill } from "@/components/PoDetailParts";
import { calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import {
    PO_LOGISTICS_FIELDS,
    calcPoLineWeightKg,
    pickOrderAnnotation,
    poDetailHref,
    poLogisticsTable,
} from "@/lib/po-metrics";
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
    const [dim, setDim] = useState(null);
    const [annotation, setAnnotation] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showItem, setShowItem] = useState(false);
    const [updatedAt, setUpdatedAt] = useState(null);
    const liveTick = usePoLiveRefresh();
    const loadedKeyRef = useRef("");

    useEffect(() => {
        if (!orderNbr || !lineKey) return;
        let active = true;
        const pageKey = `${orderNbr}|${lineKey}`;
        const silent = loadedKeyRef.current === pageKey;
        (async () => {
            if (!silent) {
                setLoading(true);
                setError(null);
            }
            try {
                const qs = new URLSearchParams({ orderNbr, lineKey });
                const res = await fetchWithAuth(`/api/po/line?${qs}`);
                if (res.status === 404) {
                    if (active && !silent) { setOrder(null); setLine(null); }
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
                setUpdatedAt(new Date());
                loadedKeyRef.current = pageKey;

                try {
                    const aRes = await fetchWithAuth(`/api/annotations?module=po&orderNbr=${encodeURIComponent(orderNbr)}`);
                    if (aRes.ok && active) setAnnotation(pickOrderAnnotation(await aRes.json(), orderNbr));
                } catch (e) {
                    console.error("Failed to load PO annotations", e);
                }

                const id = String(data.line?.inventoryId || "").trim();
                if (id) {
                    const dRes = await fetchWithAuth(`/api/stock-items/dimensions?ids=${encodeURIComponent(id)}`);
                    if (dRes.ok && active) {
                        const d = await dRes.json();
                        setDim(d.dimensions?.[id] || d.dimensions?.[id.toUpperCase()] || null);
                    }
                }
            } catch (err) {
                if (active && !silent && err.message !== "Unauthorized") setError(err.message || "Failed to load PO line.");
            } finally {
                if (active && !silent) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [orderNbr, lineKey, liveTick]);

    useEffect(() => {
        if (orderNbr) document.title = `PO ${orderNbr}${line?.lineNbr != null ? ` \u00b7 Line ${line.lineNbr}` : ""}`;
    }, [orderNbr, line]);

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
    const lineLabel = line?.lineNbr != null ? `Line ${line.lineNbr}` : `Line ${line?.position || lineKey}`;
    const { columns: logistics, rows: logisticsRows } = poLogisticsTable(annotation, order?.receiptDate);

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
                                <h1 className="pod-title">PO {orderNbr}</h1>
                                <div className="pod-subtitle">
                                    {(order?.vendorName || order?.vendorId) && <span>{order.vendorName || order.vendorId}</span>}
                                    {line && <span>{"\u00b7"} {lineLabel}{order?.lineCount ? ` of ${order.lineCount}` : ""}</span>}
                                    {line?.inventoryId && (
                                        <button type="button" className="pod-chip" title="Open item details" onClick={() => setShowItem(true)}>
                                            {line.inventoryId}
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="pod-header-actions">
                                {updatedAt && (
                                    <span className="pod-live" title="Refreshed from Acumatica every 30 seconds while this tab is open">
                                        Live {"\u00b7"} updated {updatedAt.toLocaleTimeString()}
                                    </span>
                                )}
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
                                <Stat label="Ordered" value={fmtNum(line.qty)} unit={line.uom} />
                                <Stat label="Received" value={fmtNum(line.receivedQty) || "0"} unit={line.uom} />
                                <Stat label="Still open" value={fmtNum(line.openQty) || "0"} unit={line.uom} />
                                <Stat label="Total CBM" value={totalCbm == null ? "" : formatCbm(totalCbm, 4)} hint="Set dimensions in Stock Items" />
                                <Stat label="Weight" value={weight == null ? "" : formatWeightKg(weight)} unit="kg" hint="Set KG in Stock Items" />
                                <Stat label="Line cost" value={`\u20b1${fmt(extCost)}`} accent />
                            </div>

                            <div className="pod-grid-2">
                                <Card title="Purchase order">
                                    <DefGrid items={[
                                        { label: "Order #", value: order.orderNbr },
                                        { label: "Status", value: order.status ? <StatusPill status={order.status} /> : "" },
                                        { label: "Vendor ID", value: order.vendorId },
                                        { label: "Vendor name", value: order.vendorName },
                                        { label: "PO date", value: fmtDate(order.date) },
                                        { label: "ETD (Promised On)", value: fmtDate(order.promisedDate || annotation?.etd) },
                                        { label: "Received date", value: fmtDate(order.receiptDate) },
                                        { label: "Origin", value: annotation?.origin },
                                        { label: "Order amount", value: `\u20b1${fmt(order.totalAmount)}` },
                                        { label: "Lines on this PO", value: order.lineCount ? String(order.lineCount) : "" },
                                    ]} />
                                </Card>

                                <Card title="This line">
                                    <DefGrid items={[
                                        { label: "Line", value: `${lineLabel}${order.lineCount ? ` of ${order.lineCount}` : ""}` },
                                        { label: "Item ID", value: line.inventoryId },
                                        { label: "Description", value: line.description },
                                        { label: "Branch / Warehouse", value: line.branchId || line.warehouseId },
                                        { label: "Unit", value: line.uom },
                                        { label: "Unit cost", value: unitCost == null ? "" : `\u20b1${fmt(unitCost)}` },
                                        { label: "Line cost", value: `\u20b1${fmt(extCost)}` },
                                    ]} />
                                </Card>
                            </div>

                            <Card title="Logistics">
                                {logisticsRows === 0 ? (
                                    <p className="pod-state">No container or shipping details recorded yet.</p>
                                ) : (
                                    <div className="pod-table-wrap" style={{ marginTop: 0 }}>
                                        <table className="pod-table">
                                            <thead>
                                                <tr>{PO_LOGISTICS_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr>
                                            </thead>
                                            <tbody>
                                                {Array.from({ length: logisticsRows }, (_, i) => (
                                                    <tr key={i}>
                                                        {PO_LOGISTICS_FIELDS.map(([key], f) => {
                                                            const v = logistics[f][i] || "";
                                                            const isDate = key === "shipOutDate" || key === "eta" || key === "receivedDate";
                                                            return <td key={key}>{v ? (isDate ? fmtDate(v) : v) : <span className="pod-muted">{DASH}</span>}</td>;
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </Card>
                        </>
                    )}
                </div>
            </main>

            {showItem && line?.inventoryId && (
                <InventoryDetailModal
                    inventoryId={line.inventoryId}
                    onClose={() => setShowItem(false)}
                    onDimensionsSaved={(saved) => {
                        if (saved) setDim((prev) => ({ ...(prev || {}), ...saved }));
                    }}
                />
            )}
        </div>
    );
}
