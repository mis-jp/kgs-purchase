"use client";

import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchWithAuth } from "@/lib/api-client";
import InventoryDetailModal from "@/components/InventoryDetailModal";
import PaginationBar from "@/components/PaginationBar";
import Link from "next/link";
import { isEtdBeyondContainer, poDetailHref } from "@/lib/po-metrics";
import { formatWeightKg } from "@/lib/item-dimensions";
import PoLinesTable from "@/components/PoLinesTable";
import { loadAllBranchesAccess } from "@/lib/user-access-client";
import { subscribeAutoSyncStatus } from "@/lib/auto-sync-status";
import "@/styles/dashboard.css";
import "@/styles/stock-items.css";
import "@/styles/po.css";
import "@/styles/inventory-detail.css";

const PAGE_SIZE = 10;

/* ── SVG Icons ─────────────────────────────────────────── */
const IconSearch = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);
const IconChevronLeft = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
    </svg>
);
const IconChevronRight = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);
const IconChevronDown = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);
const IconCalendar = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
);
const IconInfo = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
);
const IconActivity = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
);
const IconAlert = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);
const IconDownload = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);
const IconChevronSelect = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);
const IconFilter = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
);

function poStatusClass(status) {
    const s = (status || "").toLowerCase();
    if (s === "open") return "po-status-open";
    if (s === "on hold" || s === "hold") return "po-status-default";
    if (s === "closed") return "po-status-closed";
    if (s === "completed") return "po-status-completed";
    if (s === "cancelled" || s === "canceled") return "po-status-cancelled";
    return "po-status-default";
}

/** PO total weight label ("1,234.5 kg"); empty when no line has KG. */
function poWeightLabel(po) {
    const kg = po?.totalWeightKg;
    if (kg == null || !Number.isFinite(Number(kg))) return "";
    return `${formatWeightKg(kg)} kg`;
}

function fmt(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function supplierNameLabel(po) {
    const id = String(po?.vendorId || "").trim();
    const name = String(po?.vendorName || "").trim();
    if (name && (!id || name.toUpperCase() !== id.toUpperCase())) return name;
    return id ? "Name not on file" : "—";
}

function orderHasNoAcumaticaCost(po) {
    const header = Number(po?.totalAmount);
    const headerEmpty = po?.totalAmount == null || po?.totalAmount === "" || !Number.isFinite(header) || header === 0;
    if (!headerEmpty) return false;
    const lines = Array.isArray(po?.lines) ? po.lines : null;
    if (!lines || lines.length === 0) return false;
    return !lines.some((line) => Number(line?.extCost) > 0);
}

function toDateKey(d) {
    if (!d) return "";
    const raw = String(d).trim();
    // Pure calendar date from MySQL DATE / ISO date-only — keep as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    // Timestamps: use local calendar day (avoid UTC slice turning PH midnight into previous day)
    const date = new Date(raw);
    if (isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** Today's date as ISO yyyy-mm-dd (local) */
function todayIso() {
    return toDateKey(new Date());
}

/** First day of the current calendar year as ISO yyyy-mm-dd */
function yearStartIso() {
    return `${new Date().getFullYear()}-01-01`;
}

/** Display ISO / date value as yyyy/mm/dd */
function isoToYmd(d) {
    const key = toDateKey(d);
    if (!key) return "";
    const [y, m, day] = key.split("-");
    return `${y}/${m}/${day}`;
}

function orderBranchLabel(order) {
    const ids = [];
    const seen = new Set();
    for (const line of order?.lines || []) {
        const id = String(line?.branchId || line?.warehouseId || "").trim();
        if (!id) continue;
        const key = id.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(id);
    }
    return ids.join(", ");
}

function fmtDate(d) {
    if (!d) return "—";
    return isoToYmd(d) || String(d);
}

function isValidYmdParts(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const check = new Date(`${iso}T12:00:00`);
    return !isNaN(check.getTime()) && check.getFullYear() === year && check.getMonth() + 1 === month && check.getDate() === day;
}

/** Parse yyyy/mm/dd (also yyyy-mm-dd / legacy mm/dd/yyyy) into ISO yyyy-mm-dd; null if invalid */
function ymdToIso(text) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

    let match = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        if (!isValidYmdParts(year, month, day)) return null;
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    // Legacy mm/dd/yyyy
    match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!isValidYmdParts(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Inclusive day count between two dates; null if incomplete/invalid */
function inclusiveDayCount(start, end) {
    const a = toDateKey(start);
    const b = toDateKey(end);
    if (!a || !b) return null;
    const startMs = new Date(`${a}T12:00:00`).getTime();
    const endMs = new Date(`${b}T12:00:00`).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs < startMs) return null;
    return Math.floor((endMs - startMs) / 86400000) + 1;
}

function textIncludes(haystack, needle) {
    if (!needle) return true;
    return String(haystack ?? "").toLowerCase().includes(String(needle).toLowerCase().trim());
}

/** Logistics fields stored as JSON arrays (legacy single strings still parse). */
const LOGISTICS_MULTI_FIELDS = ["containerNumber", "shipOutDate", "eta", "receivedDate", "remarks", "userStatus"];

function parseMultiValue(raw) {
    if (raw == null || raw === "") return [""];
    if (Array.isArray(raw)) {
        const arr = raw.map((v) => (v == null ? "" : String(v)));
        return arr.length ? arr : [""];
    }
    const s = String(raw).trim();
    if (!s) return [""];
    if (s.startsWith("[")) {
        try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) {
                const arr = parsed.map((v) => (v == null ? "" : String(v)));
                return arr.length ? arr : [""];
            }
        } catch {
            /* fall through */
        }
    }
    if (s.includes("\n") || s.includes("|")) {
        const parts = s.split(/\n|\|/).map((p) => p.trim());
        return parts.length ? parts : [""];
    }
    return [s];
}

function serializeMultiValue(arr) {
    const cleaned = (Array.isArray(arr) ? arr : [arr]).map((v) => (v == null ? "" : String(v)));
    return JSON.stringify(cleaned.length ? cleaned : [""]);
}

function multiTextIncludes(haystack, needle) {
    if (!needle) return true;
    const n = String(needle).toLowerCase().trim();
    return parseMultiValue(haystack).some((v) => String(v).toLowerCase().includes(n));
}

function multiDateMatches(haystack, filterDate, erpFallback) {
    if (!filterDate) return true;
    const arr = parseMultiValue(haystack);
    if (arr.some((v) => toDateKey(v) === filterDate)) return true;
    if (erpFallback && !arr.some(Boolean) && toDateKey(erpFallback) === filterDate) return true;
    return false;
}

function hasAnyMultiValue(raw) {
    return parseMultiValue(raw).some((v) => String(v).trim());
}

/** Add calendar months, keeping the same day when possible (Jul 22 → Aug 22). */
function addCalendarMonths(iso, months = 1) {
    const key = toDateKey(iso);
    if (!key) return "";
    const [y, m, d] = key.split("-").map(Number);
    const target = new Date(y, m - 1 + months, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(d, lastDay));
    return toDateKey(target);
}

function isOpenArrivalUserStatus(userStatus) {
    const s = String(userStatus || "Pending").trim().toLowerCase();
    return s !== "arrived" && s !== "cancelled" && s !== "canceled";
}

function userStatusList(raw) {
    const list = parseMultiValue(raw).map((v) => String(v || "").trim() || "Pending");
    return list.length ? list : ["Pending"];
}

/**
 * Ship-out slots that reached +1 month and still have no Received date.
 * Example: ship out Jul 22 appears on the dashboard from Aug 22 onward.
 */
function collectOverdueShipOuts(userInputs, asOf = todayIso()) {
    const today = toDateKey(asOf) || todayIso();
    const seen = new Set();
    const orderNbrs = [];
    let shipmentCount = 0;
    for (const refId of Object.keys(userInputs || {})) {
        const nbr = orderNbrFromAnnotationRef(refId) || poAnnotationKey(refId);
        if (!nbr || seen.has(nbr)) continue;
        seen.add(nbr);
        const ui = getPoUserInputs(userInputs, nbr);
        const logistics = getLogisticsEntries(ui);
        let hit = false;
        for (let i = 0; i < logistics.shipOutDate.length; i++) {
            if (!isOpenArrivalUserStatus(logistics.userStatus[i])) continue;
            const ship = toDateKey(logistics.shipOutDate[i]);
            if (!ship) continue;
            if (String(logistics.receivedDate[i] || "").trim()) continue;
            const due = addCalendarMonths(ship, 1);
            if (due && due <= today) {
                shipmentCount += 1;
                hit = true;
            }
        }
        if (hit) orderNbrs.push(nbr);
    }
    return { orderNbrs, shipmentCount };
}

/**
 * Packing list: a container slot whose ETD (Promised On) is today or later (not yet passed)
 * and that slot still has no Received date.
 */
function collectEtdBeyondContainers(userInputs, etdByOrder, receiptByOrder, asOf = todayIso()) {
    const today = toDateKey(asOf) || todayIso();
    const seen = new Set();
    const orderNbrs = [];
    let containerCount = 0;
    for (const refId of Object.keys(userInputs || {})) {
        const nbr = orderNbrFromAnnotationRef(refId) || poAnnotationKey(refId);
        if (!nbr || seen.has(nbr)) continue;
        seen.add(nbr);
        const ui = getPoUserInputs(userInputs, nbr);
        const logistics = getLogisticsEntries(ui, receiptByOrder?.[nbr]);
        const etd = toDateKey(etdByOrder?.[nbr] || ui?.etd);
        if (!etd || !isEtdBeyondContainer(etd, today)) continue;
        let hit = false;
        for (let i = 0; i < logistics.containerNumber.length; i++) {
            if (!isOpenArrivalUserStatus(logistics.userStatus[i])) continue;
            if (!String(logistics.containerNumber[i] || "").trim()) continue;
            if (String(logistics.receivedDate[i] || "").trim()) continue;
            containerCount += 1;
            hit = true;
        }
        if (hit) orderNbrs.push(nbr);
    }
    return { orderNbrs, containerCount };
}

/** Order numbers that have at least one container number (packing list). */
function collectContainerOrderNbrs(userInputs) {
    const seen = new Set();
    const orderNbrs = [];
    for (const refId of Object.keys(userInputs || {})) {
        const nbr = orderNbrFromAnnotationRef(refId) || poAnnotationKey(refId);
        if (!nbr || seen.has(nbr)) continue;
        seen.add(nbr);
        const ui = getPoUserInputs(userInputs, nbr);
        const logistics = getLogisticsEntries(ui);
        if (logistics.containerNumber.some((c) => String(c || "").trim())) orderNbrs.push(nbr);
    }
    orderNbrs.sort();
    return orderNbrs;
}

/** Aligned multi-entry slots for container / ship out / ETA / received / remarks. */
function getLogisticsEntries(ui, receiptDate) {
    const fields = {};
    let maxLen = 1;
    for (const f of LOGISTICS_MULTI_FIELDS) {
        let arr = parseMultiValue(ui?.[f]);
        if (f === "receivedDate" && !arr.some(Boolean) && receiptDate) {
            arr = [toDateKey(receiptDate) || String(receiptDate)];
        }
        fields[f] = arr;
        if (arr.length > maxLen) maxLen = arr.length;
    }
    for (const f of LOGISTICS_MULTI_FIELDS) {
        while (fields[f].length < maxLen) fields[f].push("");
    }
    return fields;
}

function normalizeAnnotationInputs(dbInputs) {
    const out = {};
    for (const [refId, fields] of Object.entries(dbInputs || {})) {
        const next = { ...fields };
        for (const f of LOGISTICS_MULTI_FIELDS) {
            if (f in next) next[f] = parseMultiValue(next[f]);
        }
        out[refId] = next;
        // Also index under bare order # so MySQL rows (orderType always "Normal") still resolve
        const nbr = orderNbrFromAnnotationRef(refId);
        if (nbr && nbr !== refId) {
            if (!out[nbr]) {
                out[nbr] = { ...next };
            } else {
                const merged = { ...out[nbr] };
                for (const [k, v] of Object.entries(next)) {
                    if (v === "" || v == null) continue;
                    if (Array.isArray(v) && !v.some(Boolean)) continue;
                    if (!merged[k] || merged[k] === "" || (Array.isArray(merged[k]) && !merged[k].some(Boolean))) {
                        merged[k] = v;
                    }
                }
                out[nbr] = merged;
            }
        }
    }
    return out;
}

/** Stable annotation key — order number only (legacy keys were `${orderType}-${orderNbr}`). */
function poAnnotationKey(orderNbr) {
    return String(orderNbr || "").trim();
}

function orderNbrFromAnnotationRef(refId) {
    const id = String(refId || "").trim();
    if (!id) return "";
    for (const prefix of ["Normal-", "RO-", "PO-", "RP-", "RN-"]) {
        if (id.startsWith(prefix)) return id.slice(prefix.length);
    }
    const idx = id.indexOf("-");
    if (idx > 0 && idx < id.length - 1) {
        const left = id.slice(0, idx);
        if (/^[A-Za-z]{1,12}$/.test(left)) return id.slice(idx + 1);
    }
    return id;
}

function getPoUserInputs(userInputs, orderNbr, orderType) {
    const nbr = poAnnotationKey(orderNbr);
    if (!nbr) return {};
    if (userInputs[nbr]) return userInputs[nbr];
    const typed = `${orderType || "Normal"}-${nbr}`;
    if (userInputs[typed]) return userInputs[typed];
    for (const [k, v] of Object.entries(userInputs || {})) {
        if (k.endsWith(`-${nbr}`)) return v;
    }
    return {};
}

/** Order numbers that have the given userStatus annotation (for server-side filtering). */
function collectOrderNbrsByUserStatus(userInputs, status) {
    if (!status) return null;
    const nbrs = new Set();
    for (const [refId, fields] of Object.entries(userInputs || {})) {
        const statuses = fields?.userStatus == null || fields.userStatus === ""
            ? ["Pending"]
            : userStatusList(fields.userStatus);
        if (statuses.includes(status)) {
            const nbr = orderNbrFromAnnotationRef(refId);
            if (nbr) nbrs.add(nbr);
        }
    }
    return [...nbrs];
}

const EMPTY_COLUMN_FILTERS = {
    orderNbr: "",
    vendorId: "",
    vendorName: "",
    origin: "",
    status: "",
    branch: "",
    containerNumber: "",
    date: "",
    etd: "",
    shipOutDate: "",
    eta: "",
    receivedDate: "",
    remarks: "",
    userStatus: "",
    totalWeight: "",
    totalAmount: "",
};

const COLUMN_FILTER_META = [
    { key: "branch", label: "Branch" },
    { key: "orderNbr", label: "Order #" },
    { key: "vendorId", label: "Vendor ID" },
    { key: "vendorName", label: "Vendor Name" },
    { key: "origin", label: "Origin" },
    { key: "status", label: "Status" },
    { key: "containerNumber", label: "Container" },
    { key: "date", label: "PO Date" },
    { key: "etd", label: "ETD" },
    { key: "shipOutDate", label: "Ship Out" },
    { key: "eta", label: "ETA" },
    { key: "receivedDate", label: "Received" },
    { key: "remarks", label: "Remarks" },
    { key: "userStatus", label: "User Status" },
    { key: "totalWeight", label: "Weight" },
    { key: "totalAmount", label: "Amount" },
];

const PO_STATUS_FILTER_OPTIONS = [
    "On Hold",
    "Open",
    "Balanced",
    "Pending Approval",
    "Pending Printing",
    "Pending Email",
    "Completed",
    "Cancelled",
    "Closed",
];

function normalizePoStatus(status) {
    const s = String(status || "").trim();
    if (!s) return "";
    if (["hold", "on hold", "onhold", "h"].includes(s.toLowerCase())) return "On Hold";
    if (s.toLowerCase() === "canceled") return "Cancelled";
    return s;
}

function poRowMatchesFilters(o, {
    columnFilters: f,
    userInputs,
    overdueShipOutFilter,
    overdueNbrs,
    etdBeyondFilter,
    etdNbrs,
}) {
    const ui = getPoUserInputs(userInputs, o.orderNbr, o.orderType);
    const etdValue = o.promisedDate || ui.etd;
    if (!textIncludes(o.orderNbr, f.orderNbr)) return false;
    if (!textIncludes(o.vendorId, f.vendorId)) return false;
    if (f.vendorName && !textIncludes(o.vendorName, f.vendorName) && !textIncludes(supplierNameLabel(o), f.vendorName)) return false;
    if (f.origin && (ui.origin || "") !== f.origin) return false;
    if (f.status && normalizePoStatus(o.status).toLowerCase() !== normalizePoStatus(f.status).toLowerCase()) return false;
    if (f.branch && !textIncludes(orderBranchLabel(o), f.branch)) return false;
    if (!multiTextIncludes(ui.containerNumber, f.containerNumber)) return false;
    if (f.date && toDateKey(o.date) !== f.date) return false;
    if (f.etd && toDateKey(etdValue) !== f.etd) return false;
    if (!multiDateMatches(ui.shipOutDate, f.shipOutDate)) return false;
    if (!multiDateMatches(ui.eta, f.eta)) return false;
    if (!multiDateMatches(ui.receivedDate, f.receivedDate, o.receiptDate)) return false;
    if (!multiTextIncludes(ui.remarks, f.remarks)) return false;
    if (f.userStatus && !userStatusList(ui.userStatus).includes(f.userStatus)) return false;
    if (overdueShipOutFilter && !overdueNbrs.includes(poAnnotationKey(o.orderNbr))) return false;
    if (etdBeyondFilter && !etdNbrs.includes(poAnnotationKey(o.orderNbr))) return false;
    if (f.totalWeight && !textIncludes(poWeightLabel(o), f.totalWeight)
        && !textIncludes(String(o.totalWeightKg ?? ""), f.totalWeight)) return false;
    if (f.totalAmount && !textIncludes(String(o.totalAmount ?? ""), f.totalAmount)
        && !textIncludes(fmt(o.totalAmount), f.totalAmount)) return false;
    return true;
}

function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvDate(value) {
    if (!value) return "";
    const key = toDateKey(value);
    return key || String(value).split("T")[0];
}

/** ERP status from Acumatica — display only (not editable). */
function ErpStatusCell({ value }) {
    const current = normalizePoStatus(value);
    if (!current) {
        return <span className="po-erp-status po-status-default">—</span>;
    }
    return (
        <span className={`po-erp-status ${poStatusClass(current)}`} title={current}>
            {current}
        </span>
    );
}

const ORIGIN_OPTIONS = ["Philippines", "China"];

function PoDateInput({ value = "", onChange, className = "", style }) {
    const [text, setText] = useState(() => isoToYmd(value));
    const pickerRef = useRef(null);

    useEffect(() => {
        setText(isoToYmd(value));
    }, [value]);

    const commitText = (raw) => {
        const trimmed = String(raw || "").trim();
        if (!trimmed) {
            onChange?.("");
            setText("");
            return;
        }
        const iso = ymdToIso(trimmed);
        if (iso) {
            onChange?.(iso);
            setText(isoToYmd(iso));
        } else {
            setText(isoToYmd(value));
        }
    };

    return (
        <div className={`po-date-mdy ${className}`.trim()} style={style}>
            <input
                type="text"
                className="po-input-date po-input-date-mdy"
                placeholder="yyyy/mm/dd"
                inputMode="numeric"
                autoComplete="off"
                value={text}
                onChange={(e) => {
                    const next = e.target.value;
                    setText(next);
                    if (!next.trim()) {
                        onChange?.("");
                        return;
                    }
                    const iso = ymdToIso(next);
                    if (iso) onChange?.(iso);
                }}
                onBlur={() => commitText(text)}
            />
            <input
                ref={pickerRef}
                type="date"
                className="po-date-native-picker"
                value={toDateKey(value) || ""}
                onChange={(e) => onChange?.(e.target.value || "")}
                tabIndex={-1}
                aria-hidden="true"
            />
            <button
                type="button"
                className="po-date-picker-btn"
                aria-label="Open calendar"
                onClick={(e) => {
                    e.stopPropagation();
                    const el = pickerRef.current;
                    if (!el) return;
                    if (typeof el.showPicker === "function") el.showPicker();
                    else el.click();
                }}
            >
                <IconCalendar />
            </button>
        </div>
    );
}

/** Stacked multi-value cell (container # / dates) — Excel-style vertical list. */
function PoMultiEntryCell({
    entries,
    onChangeAt,
    onAdd,
    onRemove,
    type = "text",
    placeholder = "",
    showAdd = true,
    showRemove = true,
}) {
    const list = entries?.length ? entries : [""];
    return (
        <div className="po-multi-entry">
            {list.map((value, i) => (
                <div key={i} className="po-multi-entry-row">
                    {type === "date" ? (
                        <PoDateInput
                            className="po-multi-entry-date"
                            value={value}
                            onChange={(val) => onChangeAt(i, val)}
                        />
                    ) : (
                        <input
                            type="text"
                            className="po-input-text po-multi-entry-input"
                            placeholder={placeholder}
                            value={value}
                            onChange={(e) => onChangeAt(i, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                        />
                    )}
                    {showRemove && list.length > 1 && (
                        <button
                            type="button"
                            className="po-multi-entry-remove"
                            aria-label={`Remove entry ${i + 1}`}
                            title="Remove"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(i);
                            }}
                        >
                            ×
                        </button>
                    )}
                </div>
            ))}
            {showAdd && (
                <button
                    type="button"
                    className="po-multi-entry-add"
                    aria-label="Add entry"
                    title="Add container / date row"
                    onClick={(e) => {
                        e.stopPropagation();
                        onAdd();
                    }}
                >
                    + Add
                </button>
            )}
        </div>
    );
}

function PoColHeader({ label, className = "" }) {
    return (
        <th className={className}>
            <span className="po-th-label">{label}</span>
        </th>
    );
}

function ColumnFilterCell({
    filterKey,
    type = "text",
    value,
    options = [],
    onChange,
    className = "",
    placeholder = "Filter…",
}) {
    return (
        <th className={`po-filter-cell ${className}`.trim()}>
            {type === "select" ? (
                <select
                    className="po-inline-filter"
                    value={value || ""}
                    onChange={(e) => onChange(e.target.value)}
                    aria-label={`Filter ${filterKey}`}
                >
                    <option value="">All</option>
                    {options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            ) : type === "date" ? (
                <PoDateInput
                    value={value || ""}
                    onChange={onChange}
                    className="po-inline-filter-date"
                />
            ) : (
                <input
                    type="text"
                    className="po-inline-filter"
                    placeholder={placeholder}
                    value={value || ""}
                    onChange={(e) => onChange(e.target.value)}
                    aria-label={`Filter ${filterKey}`}
                />
            )}
        </th>
    );
}

const USER_STATUS_OPTIONS = ["Pending", "In Transit", "Arrived", "Customs", "Delayed", "Cancelled"];

const USER_STATUS_GUIDE = {
    "": {
        title: "No status selected",
        description: "Choose a user status to track shipment progress. Guidance for the selected status will appear here.",
    },
    Pending: {
        title: "Pending",
        description: "The order is confirmed but has not shipped yet. Verify ETA with the supplier and update the ETA field when a delivery date is available.",
        tips: ["Confirm production or packing status with the vendor.", "Enter Ship Out Date when goods leave the supplier.", "Set ETA once delivery schedule is confirmed."],
    },
    "In Transit": {
        title: "In Transit",
        description: "The shipment has left the supplier and is on the way. Keep container number and ETA up to date for warehouse receiving.",
        tips: ["Record the container or tracking reference.", "Keep Ship Out Date and ETA current if the schedule changes.", "Notify receiving team of the expected arrival window."],
    },
    Arrived: {
        title: "Arrived",
        description: "The shipment has reached the destination port or warehouse area. Prepare for unloading, inspection, or customs processing.",
        tips: ["Confirm actual arrival date against ETA.", "Coordinate with warehouse or logistics for receipt.", "Move to Customs if clearance is still required."],
    },
    Customs: {
        title: "Customs",
        description: "The shipment is undergoing customs clearance. Delays here can push back warehouse availability.",
        tips: ["Track broker or clearance documents.", "Update remarks with any hold reasons.", "Change to Arrived or Delayed if clearance completes or stalls."],
    },
    Delayed: {
        title: "Delayed",
        description: "The shipment is behind schedule versus the planned ETA. Document the reason and revised timeline in Remarks.",
        tips: ["Revise ETA to the new expected date.", "Note the cause of delay for supplier follow-up.", "Alert inventory planning if stock is at risk."],
    },
    Cancelled: {
        title: "Cancelled",
        description: "This order will not be fulfilled or received. Use this when the PO is voided, replaced, or abandoned in transit.",
        tips: ["Add remarks explaining why the order was cancelled.", "Confirm ERP status matches your tracking.", "Create a replacement PO if stock is still needed."],
    },
};

function UserStatusCell({ value, onChange }) {
    const current = value || "Pending";
    return (
        <select
            className="po-input-text po-user-status-select"
            value={current}
            onChange={(e) => onChange(e.target.value)}
        >
            {USER_STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
            ))}
        </select>
    );
}

function UserStatusGuidePanel({ activeTab, onTabChange, onFilterTable, tableFilter }) {
    const guide = USER_STATUS_GUIDE[activeTab] || USER_STATUS_GUIDE.Pending;
    const isFiltering = tableFilter === activeTab;

    return (
        <section className="po-status-guide-panel" aria-labelledby="po-status-guide-title">
            <div className="po-status-guide-panel-head">
                <div className="po-status-guide-panel-icon">
                    <IconInfo />
                </div>
                <div>
                    <h2 id="po-status-guide-title">User Status Guide</h2>
                    <p>Tap a status to see what it means. Use Show in table to filter orders by that status.</p>
                </div>
            </div>

            <div className="po-status-guide-chips" role="tablist" aria-label="User status options">
                {USER_STATUS_OPTIONS.map((opt) => (
                    <button
                        key={opt}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === opt}
                        className={`po-status-guide-chip ${activeTab === opt ? "active" : ""} ${tableFilter === opt ? "filtering" : ""}`}
                        onClick={() => onTabChange(opt)}
                        suppressHydrationWarning
                    >
                        {opt}
                    </button>
                ))}
            </div>

            <div className="po-status-guide-body" role="tabpanel">
                <div className="po-status-guide-body-main">
                    <h3>{guide.title}</h3>
                    <p>{guide.description}</p>
                </div>
                {guide.tips?.length > 0 && (
                    <ul className="po-status-guide-tips">
                        {guide.tips.map((tip) => (
                            <li key={tip}>{tip}</li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="po-status-guide-actions">
                <button
                    type="button"
                    className={`po-status-filter-table-btn ${isFiltering ? "active" : ""}`}
                    onClick={() => onFilterTable?.(isFiltering ? "" : activeTab)}
                    suppressHydrationWarning
                >
                    {isFiltering ? `Clear “${activeTab}” filter` : `Show “${activeTab}” in table`}
                </button>
            </div>
        </section>
    );
}

function ShipOutOverduePanel({ shipmentCount, orderCount, filtering, onToggleFilter }) {
    const hasOverdue = shipmentCount > 0;
    return (
        <section
            className={`po-shipout-overdue-panel ${hasOverdue ? "is-alert" : ""} ${filtering ? "is-filtering" : ""}`}
            aria-labelledby="po-shipout-overdue-title"
        >
            <div className="po-shipout-overdue-head">
                <div className="po-shipout-overdue-icon" aria-hidden="true">
                    <IconAlert />
                </div>
                <div>
                    <h2 id="po-shipout-overdue-title">Overdue Ship Out</h2>
                    <p>Still not arrived 1 month after Ship Out.</p>
                </div>
            </div>
            <div className="po-shipout-overdue-stats">
                <div className="po-shipout-overdue-stat">
                    <span className="po-shipout-overdue-value">{shipmentCount}</span>
                    <span className="po-shipout-overdue-label">Shipments overdue</span>
                </div>
                <div className="po-shipout-overdue-stat">
                    <span className="po-shipout-overdue-value">{orderCount}</span>
                    <span className="po-shipout-overdue-label">Orders with an overdue shipment</span>
                </div>
            </div>
            <p className="po-shipout-overdue-hint">
                Example: Ship Out Jul 22 appears here from Aug 22 if Received is still empty.
            </p>
            <button
                type="button"
                className={`po-status-filter-table-btn ${filtering ? "active" : ""}`}
                onClick={onToggleFilter}
                disabled={!hasOverdue && !filtering}
            >
                {filtering ? "Clear overdue filter" : "Show overdue in table"}
            </button>
        </section>
    );
}

function EtdBeyondContainerPanel({ containerCount, orderCount, filtering, onToggleFilter }) {
    const hasBeyond = containerCount > 0;
    return (
        <section
            className={`po-shipout-overdue-panel po-etd-beyond-panel ${hasBeyond ? "is-alert" : ""} ${filtering ? "is-filtering" : ""}`}
            aria-labelledby="po-etd-beyond-title"
        >
            <div className="po-shipout-overdue-head">
                <div className="po-shipout-overdue-icon" aria-hidden="true">
                    <IconAlert />
                </div>
                <div>
                    <h2 id="po-etd-beyond-title">ETD Beyond the Container</h2>
                    <p>Packing list containers whose ETD has not passed yet.</p>
                </div>
            </div>
            <div className="po-shipout-overdue-stats">
                <div className="po-shipout-overdue-stat">
                    <span className="po-shipout-overdue-value">{containerCount}</span>
                    <span className="po-shipout-overdue-label">Containers with ETD not yet passed</span>
                </div>
                <div className="po-shipout-overdue-stat">
                    <span className="po-shipout-overdue-value">{orderCount}</span>
                    <span className="po-shipout-overdue-label">Orders with a container whose ETD has not passed</span>
                </div>
            </div>
            <p className="po-shipout-overdue-hint">
                A container is counted when it has a container number, the ETD date is today or later (not yet passed), and Received is still empty.
            </p>
            <button
                type="button"
                className={`po-status-filter-table-btn ${filtering ? "active" : ""}`}
                onClick={onToggleFilter}
                disabled={!hasBeyond && !filtering}
                suppressHydrationWarning
            >
                {filtering ? "Clear packing list filter" : "Show in table"}
            </button>
        </section>
    );
}

export default function PurchaseOrdersPage() {
    const [orders, setOrders] = useState([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [totalCount, setTotalCount] = useState(null);
    const [search, setSearch] = useState("");
    const [debSearch, setDebSearch] = useState("");
    const [startDate, setStartDate] = useState(() => yearStartIso());
    const [endDate, setEndDate] = useState(() => todayIso());
    const [status, setStatus] = useState("active");
    const [selectedBranch, setSelectedBranch] = useState("");
    const [allowAllBranches, setAllowAllBranches] = useState(false);
    const [branchOptions, setBranchOptions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState({}); // orderNbr -> bool
    const [selectedId, setSelectedId] = useState(null);
    const [lineDimensions, setLineDimensions] = useState({}); // inventoryId -> dims
    const [userInputs, setUserInputs] = useState({}); // key -> { eta, userStatus }
    const [statusGuideTab, setStatusGuideTab] = useState(USER_STATUS_OPTIONS[0]);
    const [userStatusTableFilter, setUserStatusTableFilter] = useState("");
    const [overdueShipOutFilter, setOverdueShipOutFilter] = useState(false);
    const [etdBeyondFilter, setEtdBeyondFilter] = useState(false);
    const [etdByOrder, setEtdByOrder] = useState({});
    const [receiptByOrder, setReceiptByOrder] = useState({});
    const [columnFilters, setColumnFilters] = useState(EMPTY_COLUMN_FILTERS);
    const [debColumnFilters, setDebColumnFilters] = useState(EMPTY_COLUMN_FILTERS);
    const [exporting, setExporting] = useState(false);

    const setColumnFilter = useCallback((field, value) => {
        const next = value || "";
        setColumnFilters((prev) => ({ ...prev, [field]: next }));
        if (field === "userStatus") {
            setUserStatusTableFilter(next);
            if (next && USER_STATUS_OPTIONS.includes(next)) {
                setStatusGuideTab(next);
            }
        }
    }, []);

    const clearAllColumnFilters = useCallback(() => {
        setColumnFilters(EMPTY_COLUMN_FILTERS);
        setDebColumnFilters(EMPTY_COLUMN_FILTERS);
        setUserStatusTableFilter("");
    }, []);

    const handleUserStatusTableFilter = useCallback((statusValue) => {
        const next = statusValue || "";
        setUserStatusTableFilter(next);
        setColumnFilters((prev) => ({ ...prev, userStatus: next }));
        if (next && USER_STATUS_OPTIONS.includes(next)) {
            setStatusGuideTab(next);
        }
    }, []);

    const activeColumnFilterChips = useMemo(
        () => COLUMN_FILTER_META.filter((col) => columnFilters[col.key]),
        [columnFilters]
    );

    const isInitialMount = useRef(true);
    const saveTimeoutRef = useRef({}); // key -> timeout

    // Initial restoration & Hydration fix
    useEffect(() => {
        const savedPage = localStorage.getItem("po_filter_page");
        const savedSearch = localStorage.getItem("po_filter_search");
        const savedStatus = localStorage.getItem("po_filter_status");
        const savedBranch = localStorage.getItem("po_filter_branch") || "";
        const today = todayIso();
        const yearStart = yearStartIso();

        Promise.resolve().then(async () => {
            // 1. Load filters — From defaults to Jan 1 of current year; To = today
            if (savedPage) setPage(parseInt(savedPage));
            if (savedSearch) setSearch(savedSearch);
            setStartDate(yearStart);
            setEndDate(today);
            // Match Acumatica active PO inquiry (Open + On Hold + Pending Approval).
            // Old default "Open" hid On Hold rows (e.g. EX MNLP260777).
            if (!savedStatus || savedStatus === "Open" || savedStatus === "Hold") {
                setStatus("active");
            } else {
                setStatus(savedStatus === "Hold" ? "On Hold" : savedStatus);
            }
            if (savedBranch) setSelectedBranch(savedBranch);

            // Annotations only — list data always comes live from MySQL via /api/po
            try {
                const res = await fetchWithAuth("/api/annotations?module=po");
                if (res.ok) {
                    const dbInputs = await res.json();
                    setUserInputs(prev => ({ ...prev, ...normalizeAnnotationInputs(dbInputs) }));
                } else {
                    // Fallback to local if DB fails
                    const savedInputs = localStorage.getItem("po_user_inputs");
                    if (savedInputs) setUserInputs(normalizeAnnotationInputs(JSON.parse(savedInputs)));
                }
            } catch (e) {
                console.error("Failed to fetch annotations", e);
                const savedInputs = localStorage.getItem("po_user_inputs");
                if (savedInputs) setUserInputs(normalizeAnnotationInputs(JSON.parse(savedInputs)));
            }

            isInitialMount.current = false;
        });
    }, []);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await fetchWithAuth("/api/branches");
                if (res.ok && active) {
                    const branches = await res.json();
                    const options = branches.map((b) => {
                        const rawName = b.Description?.value || b.Description || b.BranchName?.value || b.branch_name || "";
                        const name = rawName && !String(rawName).startsWith("[object")
                            ? String(rawName)
                            : (b.SiteID || b.branch_id || "");
                        return { id: b.SiteID || b.branch_id || "", name };
                    }).filter((b) => b.id);
                    setBranchOptions(options);
                    const allowAll = await loadAllBranchesAccess(fetchWithAuth);
                    if (active) setAllowAllBranches(allowAll);
                    if (!allowAll && options[0] && !options.some((b) => b.id === selectedBranch)) {
                        setSelectedBranch(options[0].id);
                    }
                }
            } catch (err) {
                console.error("Failed to load branches", err);
            }
        })();
        return () => { active = false; };
    }, []);

    // Backup to localStorage just in case
    useEffect(() => {
        if (!isInitialMount.current) {
            localStorage.setItem("po_user_inputs", JSON.stringify(userInputs));
        }
    }, [userInputs]);

    const handleUserInput = (key, field, value) => {
        // 1. Update UI immediately
        setUserInputs(prev => ({
            ...prev,
            [key]: { ...(prev[key] || {}), [field]: value }
        }));

        // 2. Persist to DB (Debounced)
        const persistValue = Array.isArray(value) ? serializeMultiValue(value) : value;
        if (saveTimeoutRef.current[key + field]) {
            clearTimeout(saveTimeoutRef.current[key + field]);
        }

        saveTimeoutRef.current[key + field] = setTimeout(async () => {
            try {
                await fetchWithAuth("/api/annotations", {
                    method: "POST",
                    body: JSON.stringify({
                        module: "po",
                        refId: key,
                        fieldKey: field,
                        fieldValue: persistValue
                    })
                });
            } catch (e) {
                console.error("Failed to persist annotation", e);
            }
        }, 500);
    };

    const persistLogisticsFields = (key, nextUi) => {
        const debounceKey = `${key}::logistics`;
        if (saveTimeoutRef.current[debounceKey]) {
            clearTimeout(saveTimeoutRef.current[debounceKey]);
        }
        saveTimeoutRef.current[debounceKey] = setTimeout(async () => {
            try {
                await Promise.all(
                    LOGISTICS_MULTI_FIELDS.map((field) =>
                        fetchWithAuth("/api/annotations", {
                            method: "POST",
                            body: JSON.stringify({
                                module: "po",
                                refId: key,
                                fieldKey: field,
                                fieldValue: serializeMultiValue(nextUi[field]),
                            }),
                        })
                    )
                );
            } catch (e) {
                console.error("Failed to persist logistics annotations", e);
            }
        }, 500);
    };

    const updateLogistics = (key, receiptDate, mutator) => {
        setUserInputs((prev) => {
            const ui = prev[key] || {};
            const entries = getLogisticsEntries(ui, receiptDate);
            mutator(entries);
            const nextUi = { ...ui };
            for (const f of LOGISTICS_MULTI_FIELDS) {
                nextUi[f] = entries[f];
            }
            persistLogisticsFields(key, nextUi);
            return { ...prev, [key]: nextUi };
        });
    };

    const handleLogisticsChange = (key, field, index, value, receiptDate) => {
        updateLogistics(key, receiptDate, (entries) => {
            entries[field][index] = value;
        });
    };

    const handleLogisticsAdd = (key, receiptDate) => {
        updateLogistics(key, receiptDate, (entries) => {
            for (const f of LOGISTICS_MULTI_FIELDS) {
                entries[f].push("");
            }
        });
    };

    const handleLogisticsRemove = (key, index, receiptDate) => {
        updateLogistics(key, receiptDate, (entries) => {
            if (entries.containerNumber.length <= 1) {
                for (const f of LOGISTICS_MULTI_FIELDS) entries[f][0] = "";
                return;
            }
            for (const f of LOGISTICS_MULTI_FIELDS) {
                entries[f].splice(index, 1);
            }
        });
    };

    // Save filters to localStorage
    useEffect(() => {
        if (!isInitialMount.current) {
            localStorage.setItem("po_filter_page", page.toString());
            localStorage.setItem("po_filter_search", search);
            localStorage.setItem("po_filter_startDate", startDate);
            localStorage.setItem("po_filter_endDate", endDate);
            localStorage.setItem("po_filter_status", status);
            localStorage.setItem("po_filter_branch", selectedBranch);
        }
    }, [page, search, startDate, endDate, status, selectedBranch]);

    useEffect(() => {
        const t = setTimeout(() => setDebSearch(search), 350);
        return () => clearTimeout(t);
    }, [search]);

    // Debounce column filters so typing Vendor Name / Order # hits the API, not only the current page
    useEffect(() => {
        const t = setTimeout(() => setDebColumnFilters(columnFilters), 350);
        return () => clearTimeout(t);
    }, [columnFilters]);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setPage(1);
    }, [
        debSearch,
        startDate,
        endDate,
        status,
        selectedBranch,
        columnFilters.userStatus,
        overdueShipOutFilter,
        etdBeyondFilter,
        debColumnFilters.orderNbr,
        debColumnFilters.vendorId,
        debColumnFilters.vendorName,
        debColumnFilters.status,
        debColumnFilters.branch,
        debColumnFilters.date,
        debColumnFilters.origin,
        debColumnFilters.containerNumber,
        debColumnFilters.etd,
        debColumnFilters.shipOutDate,
        debColumnFilters.eta,
        debColumnFilters.receivedDate,
        debColumnFilters.remarks,
        debColumnFilters.totalWeight,
        debColumnFilters.totalAmount,
    ]);

    const userStatusOrderNbrs = useMemo(
        () => collectOrderNbrsByUserStatus(userInputs, columnFilters.userStatus),
        [userInputs, columnFilters.userStatus]
    );

    const overdueShipOut = useMemo(
        () => collectOverdueShipOuts(userInputs),
        [userInputs]
    );

    const containerOrderKey = useMemo(
        () => collectContainerOrderNbrs(userInputs).join("|"),
        [userInputs]
    );

    const etdBeyond = useMemo(
        () => collectEtdBeyondContainers(userInputs, etdByOrder, receiptByOrder),
        [userInputs, etdByOrder, receiptByOrder]
    );

    useEffect(() => {
        const orderNbrs = containerOrderKey ? containerOrderKey.split("|") : [];
        if (!orderNbrs.length) return undefined;
        let active = true;
        (async () => {
            try {
                const res = await fetchWithAuth("/api/po/container-etd", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderNbrs }),
                });
                if (!res.ok || !active) return;
                const data = await res.json();
                if (!active) return;
                const nextEtd = {};
                const nextReceipt = {};
                for (const [nbr, raw] of Object.entries(data.dates || {})) {
                    const etd = toDateKey(raw?.etd);
                    const receipt = toDateKey(raw?.receipt);
                    if (etd) nextEtd[nbr] = etd;
                    if (receipt) nextReceipt[nbr] = receipt;
                }
                setEtdByOrder((prev) => ({ ...prev, ...nextEtd }));
                setReceiptByOrder((prev) => ({ ...prev, ...nextReceipt }));
            } catch (err) {
                console.error("Failed to load container ETD dates", err);
            }
        })();
        return () => {
            active = false;
        };
    }, [containerOrderKey]);

    const fetchOrders = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            if (columnFilters.userStatus && Array.isArray(userStatusOrderNbrs) && userStatusOrderNbrs.length === 0) {
                setOrders([]);
                setHasMore(false);
                setTotalCount(0);
                return;
            }

            let dashboardNbrs = null;
            if (overdueShipOutFilter || etdBeyondFilter) {
                const lists = [];
                if (overdueShipOutFilter) lists.push(overdueShipOut.orderNbrs);
                if (etdBeyondFilter) lists.push(etdBeyond.orderNbrs);
                dashboardNbrs = lists.reduce((acc, list) => {
                    if (!acc) return list;
                    const allow = new Set(list);
                    return acc.filter((n) => allow.has(n));
                }, null);
                if (!dashboardNbrs.length) {
                    setOrders([]);
                    setHasMore(false);
                    setTotalCount(0);
                    return;
                }
            }

            const col = debColumnFilters;
            // Annotation / logistics filters still need a wider page so client filter is not stuck on 10 rows
            const hasClientOnlyColumnFilters = !!(
                col.origin
                || col.branch
                || col.containerNumber
                || col.etd
                || col.shipOutDate
                || col.eta
                || col.receivedDate
                || col.remarks
                || col.totalWeight
                || col.totalAmount
            );
            const pageSize = hasClientOnlyColumnFilters ? 100 : PAGE_SIZE;

            const params = new URLSearchParams({
                page: String(hasClientOnlyColumnFilters ? 1 : page),
                pageSize: String(pageSize),
            });

            // PO Date column filter narrows the range; otherwise use toolbar From/To
            if (!overdueShipOutFilter && !etdBeyondFilter) {
                if (col.date) {
                    params.set("startDate", col.date);
                    params.set("endDate", col.date);
                } else {
                    params.set("startDate", startDate);
                    params.set("endDate", endDate);
                }
            }

            // Column Status overrides toolbar Status when set.
            // A vendor-name search must still find that vendor when every matching
            // order is Closed. The Active toolbar would otherwise hide them.
            if (!columnFilters.userStatus && !overdueShipOutFilter && !etdBeyondFilter) {
                const typedVendor = String(col.vendorName || "").trim();
                const toolbarText = String(debSearch || "").trim();
                const toolbarIsOrder = /^[A-Za-z]{1,8}\d{4,}$/.test(toolbarText.replace(/\s+/g, ""));
                const nameSearch = typedVendor || (toolbarText && !toolbarIsOrder ? toolbarText : "");
                const effectiveStatus = String(col.status || (nameSearch ? "" : status) || "").trim();
                if (effectiveStatus) params.set("status", effectiveStatus);
            }

            // Server search: Order # column wins; else Vendor Name column and/or toolbar search
            const orderNbrQ = String(col.orderNbr || "").trim();
            const vendorNameQ = String(col.vendorName || "").trim();
            const toolbarQ = String(debSearch || "").trim();
            let searchQ = toolbarQ;
            if (orderNbrQ) {
                params.set("orderNbr", orderNbrQ);
                searchQ = "";
            } else if (vendorNameQ) {
                // Column Vendor Name must hit the API (not only the current page of 10)
                searchQ = vendorNameQ;
            }
            if (searchQ) params.set("search", searchQ);

            const vendorIdQ = String(col.vendorId || "").trim();
            if (vendorIdQ) params.set("vendorId", vendorIdQ);

            if (selectedBranch) params.set("branch", selectedBranch);

            let nbrs = null;
            if (columnFilters.userStatus && userStatusOrderNbrs?.length) {
                nbrs = userStatusOrderNbrs;
            }
            if (dashboardNbrs) {
                nbrs = nbrs ? nbrs.filter((n) => dashboardNbrs.includes(n)) : dashboardNbrs;
                if (!nbrs.length) {
                    setOrders([]);
                    setHasMore(false);
                    setTotalCount(0);
                    return;
                }
            }
            if (nbrs?.length) params.set("orderNbrs", nbrs.join(","));

            const res = await fetchWithAuth(`/api/po?${params}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setOrders(data.orders ?? []);
            setHasMore(hasClientOnlyColumnFilters ? false : (data.hasMore ?? false));
            setTotalCount(
                typeof data.totalCount === "number" && Number.isFinite(data.totalCount)
                    ? data.totalCount
                    : null
            );
        } catch (err) {
            if (err.message === "Unauthorized") return;
            setError(err.message || "Failed to load purchase orders.");
        } finally {
            setLoading(false);
        }
    }, [
        page,
        debSearch,
        startDate,
        endDate,
        status,
        selectedBranch,
        columnFilters.userStatus,
        userStatusOrderNbrs,
        overdueShipOutFilter,
        overdueShipOut.orderNbrs,
        etdBeyondFilter,
        etdBeyond.orderNbrs,
        debColumnFilters,
    ]);

    useEffect(() => {
        fetchOrders();
    }, [fetchOrders]);

    useEffect(() => {
        let wasRunning = false;
        let timer = null;
        const stop = subscribeAutoSyncStatus((detail) => {
            if (detail?.running) {
                wasRunning = true;
                return;
            }
            if (!wasRunning) return;
            wasRunning = false;
            clearTimeout(timer);
            timer = setTimeout(() => fetchOrders(), 500);
        });
        return () => {
            clearTimeout(timer);
            stop();
        };
    }, [fetchOrders]);

    const fetchOrdersRef = useRef(fetchOrders);
    fetchOrdersRef.current = fetchOrders;

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        const pullFromAcumatica = async () => {
            let more = true;
            let guard = 0;
            while (more && !cancelled && guard < 12) {
                guard += 1;
                try {
                    const res = await fetchWithAuth("/api/po/live", { method: "POST" });
                    if (!res.ok) break;
                    const data = await res.json();
                    if ((data.synced || 0) > 0 && !cancelled) fetchOrdersRef.current();
                    more = Boolean(data.more);
                } catch {
                    break;
                }
            }
            if (!cancelled) timer = setTimeout(pullFromAcumatica, 30000);
        };
        pullFromAcumatica();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    // Load packaging dimensions for line Total CBM
    useEffect(() => {
        const ids = [
            ...new Set(
                orders.flatMap((o) => (o.lines || []).map((l) => String(l.inventoryId || "").trim()).filter(Boolean))
            ),
        ];
        if (!ids.length) return;
        let active = true;
        (async () => {
            try {
                const res = await fetchWithAuth(
                    `/api/stock-items/dimensions?ids=${ids.map(encodeURIComponent).join(",")}`
                );
                if (!res.ok || !active) return;
                const data = await res.json();
                if (active && data.dimensions) {
                    setLineDimensions((prev) => ({ ...prev, ...data.dimensions }));
                }
            } catch (err) {
                console.error("Failed to load item dimensions", err);
            }
        })();
        return () => {
            active = false;
        };
    }, [orders]);

    const toggleExpand = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

    const lookupLineDim = (inventoryId) => {
        if (!inventoryId) return null;
        const id = String(inventoryId).trim();
        return lineDimensions[id] || lineDimensions[id.toUpperCase()] || null;
    };

    const rangeDayCount = useMemo(
        () => inclusiveDayCount(startDate, endDate),
        [startDate, endDate]
    );

    const displayedOrders = useMemo(() => {
        return orders.filter((o) => poRowMatchesFilters(o, {
            columnFilters,
            userInputs,
            overdueShipOutFilter,
            overdueNbrs: overdueShipOut.orderNbrs,
            etdBeyondFilter,
            etdNbrs: etdBeyond.orderNbrs,
        }));
    }, [orders, userInputs, columnFilters, overdueShipOutFilter, overdueShipOut.orderNbrs, etdBeyondFilter, etdBeyond.orderNbrs]);

    const handleExport = useCallback(async () => {
        setExporting(true);
        try {
            const col = debColumnFilters;
            const base = new URLSearchParams();

            if (!overdueShipOutFilter && !etdBeyondFilter) {
                if (col.date) {
                    base.set("startDate", col.date);
                    base.set("endDate", col.date);
                } else {
                    base.set("startDate", startDate);
                    base.set("endDate", endDate);
                }
            }

            if (!columnFilters.userStatus && !overdueShipOutFilter && !etdBeyondFilter) {
                const typedVendor = String(col.vendorName || "").trim();
                const toolbarText = String(debSearch || "").trim();
                const toolbarIsOrder = /^[A-Za-z]{1,8}\d{4,}$/.test(toolbarText.replace(/\s+/g, ""));
                const nameSearch = typedVendor || (toolbarText && !toolbarIsOrder ? toolbarText : "");
                const effectiveStatus = String(col.status || (nameSearch ? "" : status) || "").trim();
                if (effectiveStatus) base.set("status", effectiveStatus);
            }

            const orderNbrQ = String(col.orderNbr || "").trim();
            const vendorNameQ = String(col.vendorName || "").trim();
            const toolbarQ = String(debSearch || "").trim();
            let searchQ = toolbarQ;
            if (orderNbrQ) {
                base.set("orderNbr", orderNbrQ);
                searchQ = "";
            } else if (vendorNameQ) {
                searchQ = vendorNameQ;
            }
            if (searchQ) base.set("search", searchQ);

            const vendorIdQ = String(col.vendorId || "").trim();
            if (vendorIdQ) base.set("vendorId", vendorIdQ);
            if (selectedBranch) base.set("branch", selectedBranch);

            let nbrs = null;
            if (columnFilters.userStatus && userStatusOrderNbrs?.length) {
                nbrs = userStatusOrderNbrs;
            }
            if (overdueShipOutFilter || etdBeyondFilter) {
                const lists = [];
                if (overdueShipOutFilter) lists.push(overdueShipOut.orderNbrs);
                if (etdBeyondFilter) lists.push(etdBeyond.orderNbrs);
                const dashboardNbrs = lists.reduce((acc, list) => {
                    if (!acc) return list;
                    const allow = new Set(list);
                    return acc.filter((n) => allow.has(n));
                }, null);
                nbrs = nbrs ? nbrs.filter((n) => dashboardNbrs.includes(n)) : dashboardNbrs;
            }

            const chunks = nbrs?.length
                ? Array.from({ length: Math.ceil(nbrs.length / 80) }, (_, i) => nbrs.slice(i * 80, (i + 1) * 80))
                : [null];
            if (nbrs && nbrs.length === 0) {
                chunks.length = 0;
            }

            const seen = new Set();
            const all = [];
            for (const chunkIds of chunks) {
                let pageNum = 1;
                let more = true;
                while (more && pageNum <= 80) {
                    const params = new URLSearchParams(base);
                    params.set("page", String(pageNum));
                    params.set("pageSize", "100");
                    if (chunkIds) params.set("orderNbrs", chunkIds.join(","));
                    const res = await fetchWithAuth(`/api/po?${params}`);
                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}));
                        throw new Error(body.message || `HTTP ${res.status}`);
                    }
                    const data = await res.json();
                    for (const order of data.orders || []) {
                        const key = String(order.orderNbr || "");
                        if (!key || seen.has(key)) continue;
                        seen.add(key);
                        all.push(order);
                    }
                    more = Boolean(data.hasMore);
                    pageNum += 1;
                }
            }

            const rows = all.filter((order) => poRowMatchesFilters(order, {
                columnFilters,
                userInputs,
                overdueShipOutFilter,
                overdueNbrs: overdueShipOut.orderNbrs,
                etdBeyondFilter,
                etdNbrs: etdBeyond.orderNbrs,
            }));

            const lines = [
                "Order Nbr,Vendor ID,Vendor Name,Status,PO Date,ETD,Received Date,Total Weight (kg),Total Amount",
                ...rows.map((po) => [
                    csvCell(po.orderNbr),
                    csvCell(po.vendorId),
                    csvCell(po.vendorName),
                    csvCell(po.status),
                    csvDate(po.date),
                    csvDate(po.promisedDate),
                    csvDate(po.receiptDate),
                    po.totalWeightKg == null ? "" : Number(Number(po.totalWeightKg).toFixed(2)),
                    po.totalAmount ?? "",
                ].join(",")),
            ];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `PurchaseOrders_Export_${new Date().toISOString().split("T")[0]}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Export failed", e);
        } finally {
            setExporting(false);
        }
    }, [
        debColumnFilters,
        columnFilters,
        debSearch,
        startDate,
        endDate,
        status,
        selectedBranch,
        userStatusOrderNbrs,
        overdueShipOutFilter,
        overdueShipOut.orderNbrs,
        etdBeyondFilter,
        etdBeyond.orderNbrs,
        userInputs,
    ]);

    const summaryStats = useMemo(() => {
        const totalValue = displayedOrders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);
        const pendingEtaCount = displayedOrders.filter(o => {
            const ui = getPoUserInputs(userInputs, o.orderNbr, o.orderType);
            return !hasAnyMultiValue(ui?.eta);
        }).length;
        const openCount = displayedOrders.filter(o => o.status === 'Open').length;
        return { totalValue, pendingEtaCount, openCount };
    }, [displayedOrders, userInputs]);

    const hasClientOnlyColumnFilters = useMemo(() => {
        const f = columnFilters;
        return !!(
            f.origin
            || f.branch
            || f.containerNumber
            || f.etd
            || f.shipOutDate
            || f.eta
            || f.receivedDate
            || f.remarks
            || f.totalWeight
            || f.totalAmount
        );
    }, [columnFilters]);

    // Footer must match visible rows — never show a count when the table hid every row
    const clientHidEveryRow = orders.length > 0 && displayedOrders.length === 0;
    const paginationTotal = (hasClientOnlyColumnFilters || clientHidEveryRow)
        ? displayedOrders.length
        : (typeof totalCount === "number" ? totalCount : displayedOrders.length);

    return (
        <div className="po-root">
            <main className="po-main">
                <div className="db-page-title po-page-title-row" data-tour="page-title">
                    <div className="po-page-title-text">
                        <h1>Purchase Orders</h1>
                        <p>View and manage all purchase orders live from Acumatica ERP.</p>
                    </div>
                    <EtdBeyondContainerPanel
                        containerCount={etdBeyond.containerCount}
                        orderCount={etdBeyond.orderNbrs.length}
                        filtering={etdBeyondFilter}
                        onToggleFilter={() => setEtdBeyondFilter((v) => !v)}
                    />
                    <ShipOutOverduePanel
                        shipmentCount={overdueShipOut.shipmentCount}
                        orderCount={overdueShipOut.orderNbrs.length}
                        filtering={overdueShipOutFilter}
                        onToggleFilter={() => setOverdueShipOutFilter((v) => !v)}
                    />
                    <UserStatusGuidePanel
                        activeTab={statusGuideTab}
                        onTabChange={setStatusGuideTab}
                        onFilterTable={handleUserStatusTableFilter}
                        tableFilter={userStatusTableFilter}
                    />
                </div>

                <aside className="po-summary-strip" aria-label="Purchase order summary" data-tour="kpi-cards">
                    <div className="po-summary-card">
                        <h3 className="po-summary-title">
                            <IconActivity /> Analytics Summary
                        </h3>

                        <div className="po-summary-grid">
                            <div className="po-summary-item">
                                <span className="po-summary-label">Total Purchase Orders</span>
                                <span className="po-summary-value">
                                    {paginationTotal} Orders
                                </span>
                            </div>

                            <div className="po-summary-item" style={{ color: summaryStats.pendingEtaCount > 0 ? 'var(--status-danger)' : 'inherit' }}>
                                <span className="po-summary-label">Pending ETA (this page)</span>
                                <span className="po-summary-value">{summaryStats.pendingEtaCount}</span>
                            </div>

                            <div className="po-summary-item">
                                <span className="po-summary-label">Open (this page)</span>
                                <span className="po-summary-value">{summaryStats.openCount}</span>
                            </div>

                            <div className="po-summary-item po-summary-total">
                                <span className="po-summary-label">Value (this page)</span>
                                <span className="po-summary-value">₱{fmt(summaryStats.totalValue)}</span>
                            </div>
                        </div>
                    </div>

                    <div className="po-info-box">
                        <h4 className="po-info-title">
                            <IconInfo /> Module Guide
                        </h4>
                        <p className="po-info-text">
                            PO Date, ETD (Promised On), and Received Date come from Acumatica / Purchase Receipts. Update Ship Out Date and ETA here for logistics tracking. ETD Beyond the Container is the packing list view: each container whose ETD is today or later (not yet passed) and still has no Received date. Click an Order # to open that PO alone in a new tab.
                        </p>
                        <p className="po-info-text" style={{ marginTop: '0.75rem' }}>
                            Changes to Ship Out Date, ETA, Container #, Remarks, Origin, and User Status are saved to your account and backed up locally. Use the User Status Guide to review each status and filter the table.
                        </p>
                    </div>
                </aside>

                {activeColumnFilterChips.length > 0 && (
                    <div className="po-column-filter-bar" role="status">
                        <div className="po-column-filter-chips">
                            {activeColumnFilterChips.map((col) => (
                                <button
                                    key={col.key}
                                    type="button"
                                    className="po-column-filter-chip"
                                    onClick={() => setColumnFilter(col.key, "")}
                                    title={`Clear ${col.label} filter`}
                                >
                                    <span>{col.label}:</span>
                                    <strong>{columnFilters[col.key]}</strong>
                                    <span aria-hidden="true">×</span>
                                </button>
                            ))}
                        </div>
                        <button type="button" className="po-column-filter-clear-all" onClick={clearAllColumnFilters}>
                            Clear all filters
                        </button>
                    </div>
                )}

                <div className="po-toolbar" data-tour="toolbar">
                    <div className="po-filter-group">
                        <span className="po-filter-label">From:</span>
                        <PoDateInput
                            value={startDate}
                            onChange={setStartDate}
                            style={{ width: "150px" }}
                        />
                    </div>

                    <div className="po-filter-group">
                        <span className="po-filter-label">To:</span>
                        <PoDateInput
                            value={endDate}
                            onChange={setEndDate}
                            style={{ width: "150px" }}
                        />
                    </div>

                    {rangeDayCount != null && (
                        <div className="po-filter-group po-filter-day-count" title="Inclusive days in selected range">
                            <span className="po-filter-label">Days:</span>
                            <span className="po-day-count-value">{rangeDayCount}</span>
                        </div>
                    )}

                    <div className="po-filter-group">
                        <span className="po-filter-label">Status:</span>
                        <select
                            className="po-select-box"
                            style={{ width: '160px' }}
                            value={status}
                            onChange={(e) => setStatus(e.target.value)}
                        >
                            <option value="active">Active (Open + On Hold + Pending Approval)</option>
                            <option value="">All Statuses</option>
                            <option value="Open">Open</option>
                            <option value="On Hold">On Hold</option>
                            <option value="Pending Approval">Pending Approval</option>
                            <option value="Balanced">Balanced</option>
                            <option value="Completed">Completed</option>
                            <option value="Cancelled">Cancelled</option>
                            <option value="Closed">Closed</option>
                        </select>
                    </div>

                    <div className="po-filter-group">
                        <div className="db-select-wrapper">
                            <IconFilter />
                            <select
                                className="db-select"
                                value={selectedBranch}
                                onChange={(e) => setSelectedBranch(e.target.value)}
                                aria-label="Branch filter"
                            >
                                {allowAllBranches ? <option value="">All Branches</option> : null}
                                {branchOptions.map((b) => (
                                    <option key={b.id} value={b.id}>{b.id}</option>
                                ))}
                            </select>
                            <IconChevronSelect />
                        </div>
                    </div>

                    <div className="db-search-wrapper po-search-container">
                        <IconSearch />
                        <input
                            className="db-search"
                            type="text"
                            placeholder="Search Order #, Vendor, or Item..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        {search && (
                            <button
                                type="button"
                                className="db-search-clear"
                                onClick={() => setSearch("")}
                                aria-label="Clear search"
                            >
                                ×
                            </button>
                        )}
                    </div>

                    <button 
                        className="db-action-btn db-action-sync" 
                        onClick={handleExport}
                        disabled={exporting}
                    >
                        <IconDownload /> {exporting ? "..." : "Export"}
                    </button>
                </div>

                {error && <div className="si-error">{error}</div>}

                <div className="db-table-wrap po-table-wrap" data-tour="main-table">
                    {loading && orders.length > 0 && (
                        <p className="db-list-updating" role="status">Updating the list…</p>
                    )}
                    <table className="db-table po-table">
                        <thead>
                            <tr className="po-head-labels">
                                <th className="po-col-expand"></th>
                                <PoColHeader label="Branch" className="po-col-branch" />
                                <PoColHeader label="Order #" className="po-col-order" />
                                <PoColHeader label="Vendor ID" className="po-col-vendor-id" />
                                <PoColHeader label="Vendor Name" className="po-col-vendor-name" />
                                <PoColHeader label="Origin" className="po-col-origin" />
                                <PoColHeader label="Status" className="po-col-status" />
                                <PoColHeader label="Container" className="po-col-container" />
                                <PoColHeader label="PO Date" className="po-col-date" />
                                <PoColHeader label="ETD" className="po-col-etd" />
                                <PoColHeader label="Ship Out" className="po-col-ship-out" />
                                <PoColHeader label="ETA" className="po-col-eta" />
                                <PoColHeader label="Received" className="po-col-received" />
                                <PoColHeader label="Remarks" className="po-col-remarks" />
                                <PoColHeader label="User Status" className="po-col-user-status" />
                                <PoColHeader label="Weight" className="po-col-weight" />
                                <PoColHeader label="Amount" className="po-col-amount" />
                            </tr>
                            <tr className="po-head-filters">
                                <th className="po-col-expand"></th>
                                <ColumnFilterCell
                                    filterKey="branch"
                                    className="po-col-branch"
                                    value={columnFilters.branch}
                                    onChange={(v) => setColumnFilter("branch", v)}
                                    placeholder="Branch…"
                                />
                                <ColumnFilterCell
                                    filterKey="orderNbr"
                                    className="po-col-order"
                                    value={columnFilters.orderNbr}
                                    onChange={(v) => setColumnFilter("orderNbr", v)}
                                    placeholder="Order #…"
                                />
                                <ColumnFilterCell
                                    filterKey="vendorId"
                                    className="po-col-vendor-id"
                                    value={columnFilters.vendorId}
                                    onChange={(v) => setColumnFilter("vendorId", v)}
                                    placeholder="Vendor ID…"
                                />
                                <ColumnFilterCell
                                    filterKey="vendorName"
                                    className="po-col-vendor-name"
                                    value={columnFilters.vendorName}
                                    onChange={(v) => setColumnFilter("vendorName", v)}
                                    placeholder="Name…"
                                />
                                <ColumnFilterCell
                                    filterKey="origin"
                                    type="select"
                                    options={ORIGIN_OPTIONS}
                                    className="po-col-origin"
                                    value={columnFilters.origin}
                                    onChange={(v) => setColumnFilter("origin", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="status"
                                    type="select"
                                    options={PO_STATUS_FILTER_OPTIONS}
                                    className="po-col-status"
                                    value={columnFilters.status}
                                    onChange={(v) => setColumnFilter("status", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="containerNumber"
                                    className="po-col-container"
                                    value={columnFilters.containerNumber}
                                    onChange={(v) => setColumnFilter("containerNumber", v)}
                                    placeholder="Container…"
                                />
                                <ColumnFilterCell
                                    filterKey="date"
                                    type="date"
                                    className="po-col-date"
                                    value={columnFilters.date}
                                    onChange={(v) => setColumnFilter("date", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="etd"
                                    type="date"
                                    className="po-col-etd"
                                    value={columnFilters.etd}
                                    onChange={(v) => setColumnFilter("etd", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="shipOutDate"
                                    type="date"
                                    className="po-col-ship-out"
                                    value={columnFilters.shipOutDate}
                                    onChange={(v) => setColumnFilter("shipOutDate", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="eta"
                                    type="date"
                                    className="po-col-eta"
                                    value={columnFilters.eta}
                                    onChange={(v) => setColumnFilter("eta", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="receivedDate"
                                    type="date"
                                    className="po-col-received"
                                    value={columnFilters.receivedDate}
                                    onChange={(v) => setColumnFilter("receivedDate", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="remarks"
                                    className="po-col-remarks"
                                    value={columnFilters.remarks}
                                    onChange={(v) => setColumnFilter("remarks", v)}
                                    placeholder="Remarks…"
                                />
                                <ColumnFilterCell
                                    filterKey="userStatus"
                                    type="select"
                                    options={USER_STATUS_OPTIONS}
                                    className="po-col-user-status"
                                    value={columnFilters.userStatus}
                                    onChange={(v) => setColumnFilter("userStatus", v)}
                                />
                                <ColumnFilterCell
                                    filterKey="totalWeight"
                                    className="po-col-weight"
                                    value={columnFilters.totalWeight}
                                    onChange={(v) => setColumnFilter("totalWeight", v)}
                                    placeholder="Weight"
                                />
                                <ColumnFilterCell
                                    filterKey="totalAmount"
                                    className="po-col-amount"
                                    value={columnFilters.totalAmount}
                                    onChange={(v) => setColumnFilter("totalAmount", v)}
                                    placeholder="Amount…"
                                />
                            </tr>
                        </thead>
                        <tbody>
                            {loading && orders.length === 0 ? (
                                <tr><td colSpan={17} className="si-loading-cell">
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '4rem 0' }}>
                                        <div className="db-spinner db-spinner-lg"></div>
                                        <span style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>Fetching orders...</span>
                                    </div>
                                </td></tr>
                            ) : displayedOrders.length === 0 ? (
                                <tr><td colSpan={17} className="si-empty-cell" style={{ padding: '4rem 0' }}>
                                    {etdBeyondFilter && overdueShipOutFilter
                                        ? "No purchase orders match both dashboards."
                                        : etdBeyondFilter
                                        ? "No containers are past their ETD with an empty Received date."
                                        : overdueShipOutFilter
                                        ? "No purchase orders are overdue on Ship Out (1 month with no Received date)."
                                        : columnFilters.userStatus
                                        ? `No orders currently set to User Status “${columnFilters.userStatus}”. Pick that status on a row first, then filter again — or choose All.`
                                        : activeColumnFilterChips.length > 0
                                        ? "No purchase orders match the current column filters."
                                        : "No purchase orders found."}
                                </td></tr>
                            ) : displayedOrders.map(po => {
                                const key = poAnnotationKey(po.orderNbr);
                                const isOpen = !!expanded[key];
                                const ui = getPoUserInputs(userInputs, po.orderNbr, po.orderType);
                                const etdValue = po.promisedDate || ui.etd;
                                const logistics = getLogisticsEntries(ui, po.receiptDate);
                                const onLogisticsAdd = () => handleLogisticsAdd(key, po.receiptDate);
                                const onLogisticsRemove = (i) => handleLogisticsRemove(key, i, po.receiptDate);
                                return (
                                    <Fragment key={key}>
                                        <tr className={isOpen ? "po-row-expanded" : undefined}>
                                            <td>
                                                <button
                                                    type="button"
                                                    className={`po-expand-icon po-expand-btn ${isOpen ? "po-expand-open" : ""}`}
                                                    onClick={() => toggleExpand(key)}
                                                    aria-expanded={isOpen}
                                                    aria-label={isOpen ? `Hide items for ${po.orderNbr}` : `Show items for ${po.orderNbr}`}
                                                    title={isOpen ? "Hide items" : "Show items"}
                                                >
                                                    <IconChevronDown />
                                                </button>
                                            </td>
                                            <td className="po-col-branch">
                                                <span className="po-branch-cell" title={orderBranchLabel(po) || ""}>
                                                    {orderBranchLabel(po) || "—"}
                                                </span>
                                            </td>
                                            <td className="po-col-order">
                                                <span className="db-inv-id" title={po.orderNbr}>{po.orderNbr}</span>
                                            </td>
                                            <td className="po-col-vendor-id">
                                                <span className="po-vendor-id" title={po.vendorId || ""}>{po.vendorId || "—"}</span>
                                            </td>
                                            <td className="po-col-vendor-name">
                                                <span className="po-vendor-name" title={supplierNameLabel(po)}>{supplierNameLabel(po)}</span>
                                            </td>
                                            <td onClick={(e) => e.stopPropagation()}>
                                                <select
                                                    className="po-input-text po-origin-select"
                                                    value={ui.origin || ""}
                                                    onChange={(e) => handleUserInput(key, "origin", e.target.value)}
                                                >
                                                    <option value="">—</option>
                                                    <option value="Philippines">Philippines</option>
                                                    <option value="China">China</option>
                                                </select>
                                            </td>
                                            <td>
                                                <ErpStatusCell value={po.status} />
                                            </td>
                                            <td className="po-multi-entry-td" onClick={(e) => e.stopPropagation()}>
                                                <PoMultiEntryCell
                                                    entries={logistics.containerNumber}
                                                    placeholder="Container"
                                                    onChangeAt={(i, val) => handleLogisticsChange(key, "containerNumber", i, val, po.receiptDate)}
                                                    onAdd={onLogisticsAdd}
                                                    onRemove={onLogisticsRemove}
                                                />
                                            </td>
                                            <td>
                                                <span className="po-readonly-date">{fmtDate(po.date)}</span>
                                            </td>
                                            <td>
                                                <span className="po-readonly-date" title={po.promisedDate ? "From Acumatica Promised On" : (ui.etd ? "Legacy annotation" : "")}>
                                                    {fmtDate(etdValue)}
                                                </span>
                                            </td>
                                            <td className="po-multi-entry-td" onClick={(e) => e.stopPropagation()}>
                                                <PoMultiEntryCell
                                                    type="date"
                                                    entries={logistics.shipOutDate}
                                                    showAdd={false}
                                                    showRemove={false}
                                                    onChangeAt={(i, val) => handleLogisticsChange(key, "shipOutDate", i, val, po.receiptDate)}
                                                    onAdd={onLogisticsAdd}
                                                    onRemove={onLogisticsRemove}
                                                />
                                            </td>
                                            <td className="po-multi-entry-td" onClick={(e) => e.stopPropagation()}>
                                                <PoMultiEntryCell
                                                    type="date"
                                                    entries={logistics.eta}
                                                    showAdd={false}
                                                    showRemove={false}
                                                    onChangeAt={(i, val) => handleLogisticsChange(key, "eta", i, val, po.receiptDate)}
                                                    onAdd={onLogisticsAdd}
                                                    onRemove={onLogisticsRemove}
                                                />
                                            </td>
                                            <td className="po-multi-entry-td" onClick={(e) => e.stopPropagation()}>
                                                <PoMultiEntryCell
                                                    type="date"
                                                    entries={logistics.receivedDate}
                                                    showAdd={false}
                                                    showRemove={false}
                                                    onChangeAt={(i, val) => handleLogisticsChange(key, "receivedDate", i, val, po.receiptDate)}
                                                    onAdd={onLogisticsAdd}
                                                    onRemove={onLogisticsRemove}
                                                />
                                            </td>
                                            <td className="po-multi-entry-td" onClick={(e) => e.stopPropagation()}>
                                                <PoMultiEntryCell
                                                    entries={logistics.remarks}
                                                    placeholder="Remarks"
                                                    showAdd={false}
                                                    showRemove={false}
                                                    onChangeAt={(i, val) => handleLogisticsChange(key, "remarks", i, val, po.receiptDate)}
                                                    onAdd={onLogisticsAdd}
                                                    onRemove={onLogisticsRemove}
                                                />
                                            </td>
                                            <td className="po-multi-entry-td po-user-status-td" onClick={(e) => e.stopPropagation()}>
                                                <div className="po-multi-entry">
                                                    {logistics.userStatus.map((status, i) => (
                                                        <div key={i} className="po-multi-entry-row">
                                                            <UserStatusCell
                                                                value={status || ""}
                                                                onChange={(val) => handleLogisticsChange(key, "userStatus", i, val, po.receiptDate)}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className="po-col-weight po-weight-td" title={po.totalWeightKg == null ? "No line has KG set" : "Sum of line piece weight (box KG / PCS/BOX) \u00d7 quantity"}>
                                                {poWeightLabel(po) || "\u2014"}
                                            </td>
                                            <td className="po-amount-td" onClick={(e) => e.stopPropagation()}>
                                                <div className="po-amount-stack">
                                                    {orderHasNoAcumaticaCost(po) ? (
                                                        <strong className="po-amount-cell po-amount-missing" title="The header amount is empty and no line has an extended cost">No cost in Acumatica</strong>
                                                    ) : (
                                                        <strong className="po-amount-cell">₱{fmt(po.totalAmount)}</strong>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="po-add-row-btn"
                                                        onClick={onLogisticsAdd}
                                                    >
                                                        + Add row
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                        {isOpen && (
                                            <tr className="po-lines-row">
                                                <td colSpan={17}>
                                                    <div className="po-lines-toolbar">
                                                        <span className="po-lines-toolbar-title">Items on {po.orderNbr}</span>
                                                        <Link
                                                            className="po-open-whole-btn"
                                                            href={poDetailHref(po.orderNbr)}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title={`Open ${po.orderNbr} in a new tab`}
                                                        >
                                                            Open whole PO
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                                <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                            </svg>
                                                        </Link>
                                                    </div>
                                                    <PoLinesTable lines={po.lines} lookupDim={lookupLineDim} onItemClick={setSelectedId} orderNbr={po.orderNbr} />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {!loading && (
                    <PaginationBar
                        page={hasClientOnlyColumnFilters ? 1 : page}
                        pageSize={hasClientOnlyColumnFilters ? Math.max(displayedOrders.length, 1) : PAGE_SIZE}
                        totalCount={paginationTotal}
                        hasMore={hasClientOnlyColumnFilters ? false : hasMore}
                        onPageChange={setPage}
                        itemLabel="orders"
                        disabled={loading || hasClientOnlyColumnFilters}
                    />
                )}
            </main>

            {selectedId && (
                <InventoryDetailModal
                    inventoryId={selectedId}
                    onClose={() => setSelectedId(null)}
                    onDimensionsSaved={(dims) => {
                        if (!dims) return;
                        const id = String(dims.inventoryId || selectedId || "").trim();
                        if (!id) return;
                        const entry = {
                            inventoryId: id,
                            pcs_per_box: dims.pcs_per_box ?? null,
                            length_m: dims.length_m ?? null,
                            height_m: dims.height_m ?? null,
                            width_m: dims.width_m ?? null,
                            weight_kg: dims.weight_kg ?? null,
                            cbm: dims.cbm ?? null,
                        };
                        setLineDimensions((prev) => ({
                            ...prev,
                            [id]: entry,
                            [id.toUpperCase()]: entry,
                        }));
                    }}
                />
            )}
        </div>
    );
}
