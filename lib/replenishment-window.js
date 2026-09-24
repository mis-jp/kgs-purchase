/** Replenishment Sells / day window. Default is 3 months (90 days). */
export const DEFAULT_REPLENISHMENT_MONTHS = 3;
export const MIN_REPLENISHMENT_MONTHS = 1;
export const MAX_REPLENISHMENT_MONTHS = 24;
export const DAYS_PER_REPLENISHMENT_MONTH = 30;
export const MIN_REPLENISHMENT_DAYS = 1;
export const MAX_REPLENISHMENT_DAYS = MAX_REPLENISHMENT_MONTHS * DAYS_PER_REPLENISHMENT_MONTH;

export function clampReplenishmentMonths(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REPLENISHMENT_MONTHS;
    return Math.min(MAX_REPLENISHMENT_MONTHS, Math.max(MIN_REPLENISHMENT_MONTHS, parsed));
}

export function replenishmentMonthsToDays(months) {
    return clampReplenishmentMonths(months) * DAYS_PER_REPLENISHMENT_MONTH;
}

export function normalizeReplenishmentWindow({ value, unit, months } = {}) {
    const chosenUnit = String(unit || "").toLowerCase() === "days" ? "days" : "months";
    const raw = value != null && value !== "" ? value : months;
    if (chosenUnit === "days") {
        const parsed = parseInt(raw, 10);
        const days = Number.isFinite(parsed)
            ? Math.min(MAX_REPLENISHMENT_DAYS, Math.max(MIN_REPLENISHMENT_DAYS, parsed))
            : replenishmentMonthsToDays(DEFAULT_REPLENISHMENT_MONTHS);
        return { value: days, unit: "days", days, months: null };
    }
    const monthCount = clampReplenishmentMonths(raw ?? DEFAULT_REPLENISHMENT_MONTHS);
    return {
        value: monthCount,
        unit: "months",
        days: replenishmentMonthsToDays(monthCount),
        months: monthCount,
    };
}
