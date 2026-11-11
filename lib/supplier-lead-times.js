/** Per-supplier lead-time statistics from delivered PO history plus open / overdue counts. */

const RECENT_DAYS = 90;

function round1(n) {
    return Math.round(n * 10) / 10;
}

function median(sorted) {
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * delivered: [{ vendorId, vendorName, leadDays, lateDays, receivedOn }]
 * open:      [{ vendorId, vendorName, openCount, overdueCount }]
 * Returns one row per supplier, slowest typical lead time first.
 */
export function summarizeSupplierLeadTimes(delivered = [], open = [], today = new Date()) {
    const recentCutoff = new Date(today.getTime() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const byVendor = new Map();
    const entry = (vendorId, vendorName) => {
        const id = String(vendorId || "").trim();
        if (!id) return null;
        let e = byVendor.get(id);
        if (!e) {
            e = { vendorId: id, vendorName: "", leads: [], recentLeads: [], late: [], openCount: 0, overdueCount: 0 };
            byVendor.set(id, e);
        }
        if (!e.vendorName && vendorName && String(vendorName).trim() !== id) e.vendorName = String(vendorName).trim();
        return e;
    };

    for (const row of delivered) {
        const e = entry(row.vendorId, row.vendorName);
        const lead = Number(row.leadDays);
        if (!e || !Number.isFinite(lead) || lead < 0) continue;
        e.leads.push(lead);
        if (row.receivedOn && String(row.receivedOn) >= recentCutoff) e.recentLeads.push(lead);
        if (row.lateDays != null && Number.isFinite(Number(row.lateDays))) e.late.push(Number(row.lateDays));
    }
    for (const row of open) {
        const e = entry(row.vendorId, row.vendorName);
        if (!e) continue;
        e.openCount += Number(row.openCount) || 0;
        e.overdueCount += Number(row.overdueCount) || 0;
    }

    const rows = [...byVendor.values()].map((e) => {
        const leads = [...e.leads].sort((a, b) => a - b);
        const avg = leads.length ? leads.reduce((s, n) => s + n, 0) / leads.length : null;
        const recentAvg = e.recentLeads.length ? e.recentLeads.reduce((s, n) => s + n, 0) / e.recentLeads.length : null;
        const onTime = e.late.filter((d) => d <= 0).length;
        const lateOnly = e.late.filter((d) => d > 0);
        let trend = "steady";
        if (avg != null && recentAvg != null && e.recentLeads.length >= 2 && leads.length >= 4) {
            if (recentAvg >= avg * 1.15 && recentAvg - avg >= 3) trend = "slower";
            else if (recentAvg <= avg * 0.85 && avg - recentAvg >= 3) trend = "faster";
        }
        return {
            vendorId: e.vendorId,
            vendorName: e.vendorName || e.vendorId,
            delivered: leads.length,
            avgDays: avg == null ? null : round1(avg),
            typicalDays: median(leads),
            fastestDays: leads.length ? leads[0] : null,
            slowestDays: leads.length ? leads[leads.length - 1] : null,
            recentAvgDays: recentAvg == null ? null : round1(recentAvg),
            trend,
            onTimePct: e.late.length ? round1((onTime / e.late.length) * 100) : null,
            avgDaysLate: lateOnly.length ? round1(lateOnly.reduce((s, n) => s + n, 0) / lateOnly.length) : null,
            openCount: e.openCount,
            overdueCount: e.overdueCount,
        };
    });

    return rows.sort((a, b) => {
        if (a.typicalDays == null && b.typicalDays != null) return 1;
        if (b.typicalDays == null && a.typicalDays != null) return -1;
        if ((b.typicalDays ?? 0) !== (a.typicalDays ?? 0)) return (b.typicalDays ?? 0) - (a.typicalDays ?? 0);
        return a.vendorName.localeCompare(b.vendorName);
    });
}
