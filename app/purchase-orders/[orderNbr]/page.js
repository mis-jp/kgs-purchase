"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import InventoryDetailModal from "@/components/InventoryDetailModal";
import PoLinesTable from "@/components/PoLinesTable";
import { Breadcrumb, Card, DASH, DefGrid, Stat, StatusPill } from "@/components/PoDetailParts";
import { calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import { calcOrderWeightKg, pickOrderAnnotation } from "@/lib/po-metrics";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";
import "@/styles/inventory-detail.css";
import "@/styles/po-detail.css";

const LOGISTICS_FIELDS = [
    ["containerNumber", "Container"],
    ["shipOutDate", "Ship Out"],
    ["eta", "ETA"],
    ["receivedDate", "Received"],
    ["remarks", "Remarks"],
    ["userStatus", "User Status"],
];

function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function toList(raw) {
    if (raw == null || raw === "") return [];
    if (Array.isArray(raw)) return raw.map((v) => (v == null ? "" : String(v)));
    const s = String(raw).trim();
    if (s.startsWith("[")) {
        try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed.map((v) => (v == null ? "" : String(v)));
        } catch {
            /* plain text */
        }
    }
    return s ? [s] : [];
}

function branchesOf(lines) {
    const seen = new Set();
    const out = [];
    for (const l of lines || []) {
        const id = String(l?.branchId || l?.warehouseId || "").trim();
        if (!id || seen.has(id.toUpperCase())) continue;
        seen.add(id.toUpperCase());
        out.push(id);
    }
    return out.join(", ");
}

export default function PurchaseOrderDetailPage() {
    const params = useParams();
    const orderNbr = useMemo(() => {
        const raw = Array.isArray(params?.orderNbr) ? params.orderNbr[0] : params?.orderNbr;
        try {
            return decodeURIComponent(String(raw || "")).trim();
        } catch {
            return String(raw || "").trim();
        }
    }, [params]);

    const [po, setPo] = useState(null);
    const [annotation, setAnnotation] = useState({});
    const [dims, setDims] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedId, setSelectedId] = useState(null);

    useEffect(() => {
        if (!orderNbr) return;
        let active = true;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                // Scoped to exactly this order number (IN (?) on the server; branch access still applies).
                const qs = new URLSearchParams({ orderNbrs: orderNbr, page: "1", pageSize: "5" });
                const res = await fetchWithAuth(`/api/po?${qs}`);
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.message || `HTTP ${res.status}`);
                }
                const data = await res.json();
                const match = (data.orders || []).find(
                    (o) => String(o.orderNbr || "").trim() === orderNbr
                ) || null;
                if (!active) return;
                setPo(match);

                try {
                    // Server returns only this PO's annotation entry.
                    const aRes = await fetchWithAuth(`/api/annotations?module=po&orderNbr=${encodeURIComponent(orderNbr)}`);
                    if (aRes.ok && active) setAnnotation(pickOrderAnnotation(await aRes.json(), orderNbr));
                } catch (e) {
                    console.error("Failed to load PO annotations", e);
                }

                const ids = [...new Set((match?.lines || []).map((l) => String(l.inventoryId || "").trim()).filter(Boolean))];
                if (ids.length) {
                    const dRes = await fetchWithAuth(`/api/stock-items/dimensions?ids=${ids.map(encodeURIComponent).join(",")}`);
                    if (dRes.ok && active) {
                        const d = await dRes.json();
                        setDims(d.dimensions || {});
                    }
                }
            } catch (err) {
                if (active && err.message !== "Unauthorized") setError(err.message || "Failed to load purchase order.");
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [orderNbr]);

    useEffect(() => {
        if (orderNbr) document.title = `PO ${orderNbr}`;
    }, [orderNbr]);

    const lookupDim = (inventoryId) => {
        const id = String(inventoryId || "").trim();
        if (!id) return null;
        return dims[id] || dims[id.toUpperCase()] || null;
    };

    const lines = po?.lines || [];
    const logistics = LOGISTICS_FIELDS.map(([key]) => toList(annotation?.[key]));
    if (!logistics[3].some(Boolean) && po?.receiptDate) logistics[3] = [String(po.receiptDate)];
    const logisticsRows = Math.max(0, ...logistics.map((l) => l.filter(Boolean).length ? l.length : 0));
    const totalWeight = calcOrderWeightKg(lines, lookupDim);
    let totalCbm = null;
    for (const l of lines) {
        const d = lookupDim(l.inventoryId);
        const c = calcTotalCbm({
            length_m: d?.length_m, height_m: d?.height_m, width_m: d?.width_m,
            cbm: d?.cbm, pcs_per_box: d?.pcs_per_box, qty: l.qty,
        });
        if (c != null && Number.isFinite(Number(c))) totalCbm = (totalCbm ?? 0) + Number(c);
    }
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

    return (
        <div className="po-root">
            <main className="po-main">
                <div className="pod-container">
                    <Card accent>
                        <Breadcrumb crumbs={[
                            { label: "\u2190 Purchase Orders", href: "/purchase-orders" },
                            { label: `PO ${orderNbr}` },
                        ]} />
                        <div className="pod-header-row">
                            <div className="pod-header-main">
                                <h1 className="pod-title">{po?.vendorName || po?.vendorId || `PO ${orderNbr}`}</h1>
                                <div className="pod-subtitle">
                                    <span className="pod-chip">PO {orderNbr}</span>
                                    {po?.vendorId && <span>{po.vendorId}</span>}
                                    {po?.date && <span>{"\u00b7"} {fmtDate(po.date)}</span>}
                                </div>
                            </div>
                            <div className="pod-header-actions">
                                <StatusPill status={po?.status} />
                            </div>
                        </div>
                    </Card>

                    {loading ? (
                        <Card><p className="pod-state">{"Loading purchase order\u2026"}</p></Card>
                    ) : error ? (
                        <Card><p className="pod-state" role="alert">{error}</p></Card>
                    ) : !po ? (
                        <Card><p className="pod-state">Purchase order {orderNbr} was not found, or your branch access does not include it.</p></Card>
                    ) : (
                        <>
                            <div className="pod-stats">
                                <Stat label="Lines" value={String(lines.length)} />
                                <Stat label="Total quantity" value={totalQty.toLocaleString()} />
                                <Stat label="Total CBM" value={totalCbm == null ? "" : formatCbm(totalCbm, 4)} hint="Set dimensions in Stock Items" />
                                <Stat label="Total weight" value={totalWeight == null ? "" : formatWeightKg(totalWeight)} unit="kg" hint="Set KG in Stock Items" />
                                <Stat label="ETD" value={fmtDate(po.promisedDate || annotation?.etd)} />
                                <Stat label="Amount" value={`\u20b1${fmt(po.totalAmount)}`} accent />
                            </div>

                            <div className="pod-grid-2">
                                <Card title="Purchase order">
                                    <DefGrid items={[
                                        { label: "Order #", value: po.orderNbr },
                                        { label: "Status", value: po.status ? <StatusPill status={po.status} /> : "" },
                                        { label: "Vendor ID", value: po.vendorId },
                                        { label: "Vendor name", value: po.vendorName },
                                        { label: "PO date", value: fmtDate(po.date) },
                                        { label: "ETD (Promised On)", value: fmtDate(po.promisedDate || annotation?.etd) },
                                        { label: "Origin", value: annotation?.origin },
                                        { label: "Branch / Warehouse", value: branchesOf(lines) },
                                    ]} />
                                </Card>

                                <Card title="Logistics">
                                    {logisticsRows === 0 ? (
                                        <p className="pod-state">No container or shipping details recorded yet.</p>
                                    ) : (
                                        <div className="pod-table-wrap" style={{ marginTop: 0 }}>
                                            <table className="pod-table">
                                                <thead>
                                                    <tr>{LOGISTICS_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr>
                                                </thead>
                                                <tbody>
                                                    {Array.from({ length: logisticsRows }, (_, i) => (
                                                        <tr key={i}>
                                                            {LOGISTICS_FIELDS.map(([key], f) => {
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
                            </div>

                            <Card title={`Items (${lines.length})`}>
                                <PoLinesTable lines={lines} lookupDim={lookupDim} onItemClick={setSelectedId} orderNbr={po.orderNbr} />
                            </Card>
                        </>
                    )}
                </div>
            </main>

            {selectedId && (
                <InventoryDetailModal
                    inventoryId={selectedId}
                    onClose={() => setSelectedId(null)}
                    onDimensionsSaved={(saved) => {
                        if (!saved) return;
                        const id = String(saved.inventoryId || selectedId || "").trim();
                        if (!id) return;
                        setDims((prev) => ({ ...prev, [id]: saved, [id.toUpperCase()]: saved }));
                    }}
                />
            )}
        </div>
    );
}
