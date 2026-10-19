"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/api-client";
import { calcTotalCbm, formatCbm, formatWeightKg } from "@/lib/item-dimensions";
import { calcLineWeightKg, calcOrderWeightKg } from "@/lib/po-metrics";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";

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
    if (!d) return "\u2014";
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

/** Annotation for this PO only (keys are the bare order # or `${type}-${orderNbr}`). */
function pickAnnotation(all, orderNbr) {
    if (!all || !orderNbr) return {};
    if (all[orderNbr]) return all[orderNbr];
    for (const [k, v] of Object.entries(all)) {
        if (k.endsWith(`-${orderNbr}`)) return v;
    }
    return {};
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
                    const aRes = await fetchWithAuth("/api/annotations?module=po");
                    if (aRes.ok && active) setAnnotation(pickAnnotation(await aRes.json(), orderNbr));
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
    const logisticsRows = Math.max(0, ...logistics.map((l) => l.length));
    const totalWeight = calcOrderWeightKg(lines, lookupDim);

    return (
        <div className="po-root">
            <main className="po-main">
                <p style={{ marginBottom: "1rem" }}>
                    <Link href="/purchase-orders">{"\u2190 Purchase Orders"}</Link>
                </p>
                <div className="db-page-title">
                    <h1>Purchase Order {orderNbr || ""}</h1>
                </div>

                {loading ? (
                    <p className="si-loading-cell">{"Loading purchase order\u2026"}</p>
                ) : error ? (
                    <p className="si-empty-cell" role="alert">{error}</p>
                ) : !po ? (
                    <p className="si-empty-cell">Purchase order {orderNbr} was not found, or your branch access does not include it.</p>
                ) : (
                    <>
                        <div className="db-table-wrap po-table-wrap" style={{ marginBottom: "1.5rem" }}>
                            <table className="db-table po-table">
                                <tbody>
                                    <tr><th>Order #</th><td>{po.orderNbr}</td><th>Status</th><td>{po.status || "\u2014"}</td></tr>
                                    <tr><th>Vendor ID</th><td>{po.vendorId || "\u2014"}</td><th>Vendor Name</th><td>{po.vendorName || "\u2014"}</td></tr>
                                    <tr><th>PO Date</th><td>{fmtDate(po.date)}</td><th>ETD (Promised On)</th><td>{fmtDate(po.promisedDate || annotation?.etd)}</td></tr>
                                    <tr><th>Origin</th><td>{annotation?.origin || "\u2014"}</td><th>Amount</th><td>{"\u20b1"}{fmt(po.totalAmount)}</td></tr>
                                    <tr><th>Total Weight</th><td colSpan={3}>{totalWeight == null ? "\u2014" : `${formatWeightKg(totalWeight)} kg`}</td></tr>
                                </tbody>
                            </table>
                        </div>

                        {logisticsRows > 0 && (
                            <div className="db-table-wrap po-table-wrap" style={{ marginBottom: "1.5rem" }}>
                                <table className="db-table po-table">
                                    <thead>
                                        <tr>{LOGISTICS_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr>
                                    </thead>
                                    <tbody>
                                        {Array.from({ length: logisticsRows }, (_, i) => (
                                            <tr key={i}>
                                                {LOGISTICS_FIELDS.map(([key], f) => {
                                                    const v = logistics[f][i] || "";
                                                    const isDate = key === "shipOutDate" || key === "eta" || key === "receivedDate";
                                                    return <td key={key}>{v ? (isDate ? fmtDate(v) : v) : "\u2014"}</td>;
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="po-lines-wrap">
                            <table className="po-lines-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: 180 }}>Item ID</th>
                                        <th>Description</th>
                                        <th style={{ textAlign: "right", width: 120 }}>Quantity</th>
                                        <th style={{ textAlign: "right", width: 110 }}>Total CBM</th>
                                        <th style={{ textAlign: "right", width: 110 }}>Weight</th>
                                        <th style={{ textAlign: "right", width: 150 }}>Ext. Cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lines.length > 0 ? lines.map((line, i) => {
                                        const dim = lookupDim(line.inventoryId);
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
                                                <td><span className="db-inv-id">{line.inventoryId}</span></td>
                                                <td>{line.description}</td>
                                                <td style={{ textAlign: "right" }}>{Number(line.qty).toLocaleString()} {line.uom}</td>
                                                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCbm(totalCbm, 4)}</td>
                                                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{weight == null ? "\u2014" : `${formatWeightKg(weight)} kg`}</td>
                                                <td style={{ textAlign: "right" }}>{"\u20b1"}{fmt(line.extCost)}</td>
                                            </tr>
                                        );
                                    }) : (
                                        <tr><td colSpan={6} style={{ textAlign: "center", padding: "2rem" }}>No line items found for this order.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
