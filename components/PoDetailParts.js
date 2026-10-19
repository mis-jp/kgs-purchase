import Link from "next/link";

export const DASH = "\u2014";

/** Same status classes as the Purchase Orders list (po-erp-status + po-status-*). */
export function poStatusPillClass(status) {
    const s = String(status || "").trim().toLowerCase();
    if (s === "open") return "po-status-open";
    if (s === "closed") return "po-status-closed";
    if (s === "completed") return "po-status-completed";
    if (s === "cancelled" || s === "canceled") return "po-status-cancelled";
    return "po-status-default";
}

export function StatusPill({ status }) {
    const label = String(status || "").trim();
    if (!label) return null;
    return <span className={`po-erp-status ${poStatusPillClass(label)}`} title={`ERP status: ${label}`}>{label}</span>;
}

/** crumbs: [{ label, href? }] - last one is the current page. */
export function Breadcrumb({ crumbs }) {
    return (
        <nav className="pod-breadcrumb" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
                <span key={`${c.label}-${i}`} style={{ display: "contents" }}>
                    {i > 0 && <span className="pod-breadcrumb-sep" aria-hidden="true">/</span>}
                    {c.href ? <Link href={c.href}>{c.label}</Link> : <span className="pod-breadcrumb-current">{c.label}</span>}
                </span>
            ))}
        </nav>
    );
}

export function Card({ title, accent = false, children }) {
    return (
        <section className={`pod-card${accent ? " pod-card-accent" : ""}`}>
            {title && <h2 className="pod-card-title">{title}</h2>}
            {children}
        </section>
    );
}

/** One KPI tile. When value is empty, shows a dash with an optional hint. */
export function Stat({ label, value, unit, hint, accent = false }) {
    const empty = value == null || value === "";
    return (
        <div className={`pod-stat${accent ? " pod-stat-accent" : ""}`}>
            <span className="pod-stat-label">{label}</span>
            <span className="pod-stat-value">
                {empty ? DASH : value}
                {!empty && unit ? <span className="pod-stat-unit">{unit}</span> : null}
            </span>
            {empty && hint ? <span className="pod-stat-hint">{hint}</span> : null}
        </div>
    );
}

/** items: [{ label, value }] rendered as a responsive label-above-value grid. */
export function DefGrid({ items }) {
    return (
        <dl className="pod-dl">
            {items.map((it) => (
                <div key={it.label}>
                    <dt>{it.label}</dt>
                    <dd>{it.value == null || it.value === "" ? <span className="pod-muted">{DASH}</span> : it.value}</dd>
                </div>
            ))}
        </dl>
    );
}
