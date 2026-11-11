/** Purchase orders still open after the supplier's Promised On date (from Acumatica). */

const OPEN_STATUSES = new Set(["open", "on hold", "hold"]);

/** Calendar day as a UTC timestamp; full timestamps are read in local time so +08:00 midnights stay on their day. */
function dayStart(value) {
    if (!value) return null;
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split("-").map(Number);
        return Date.UTC(y, m - 1, d);
    }
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** Whole days past the promised date, or 0 when not overdue / not open / no date. */
export function daysPastPromised(po, today = new Date()) {
    if (!po || !OPEN_STATUSES.has(String(po.status || "").trim().toLowerCase())) return 0;
    const promised = dayStart(po.promisedDate);
    if (promised == null) return 0;
    const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.floor((now - promised) / 86_400_000);
    return days > 0 ? days : 0;
}
