import { HttpError, intParam, textParam } from "./http";
import { validateStatus } from "./stock";
import { LINE_FILTERS } from "./counts";

export function branchParam(value) {
    const branch = textParam(value, 100).toUpperCase();
    return branch === "ALL" ? "" : branch;
}

export function stockFilters(searchParams) {
    return {
        branch: branchParam(searchParams.get("branch")),
        search: textParam(searchParams.get("search")),
        category: textParam(searchParams.get("category"), 100),
        status: validateStatus(textParam(searchParams.get("status"), 30)),
    };
}

export function lineFilter(value, allowed = LINE_FILTERS) {
    const filter = textParam(value, 20) || "all";
    if (!allowed.includes(filter)) {
        throw new HttpError(400, `Unknown filter "${filter}". Use ${allowed.join(", ")}.`);
    }
    return filter;
}

export function countId(value) {
    return idParam(value, "count");
}

export function idParam(value, label = "record") {
    const id = parseInt(String(value || ""), 10);
    if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, `Invalid ${label} id.`);
    return id;
}

/** Optional enum query value: "" when absent, 400 when unknown. */
export function oneOf(value, allowed, label) {
    const raw = textParam(value, 40);
    if (!raw) return "";
    if (!allowed.includes(raw)) throw new HttpError(400, `Unknown ${label} "${raw}". Use ${allowed.join(", ")}.`);
    return raw;
}

export function pageParams(searchParams, { pageSize = 30, max = 100 } = {}) {
    return {
        page: intParam(searchParams.get("page"), 1, { min: 1, max: 100000 }),
        pageSize: intParam(searchParams.get("pageSize"), pageSize, { min: 1, max }),
    };
}

export function dateParam(value) {
    const raw = textParam(value, 30);
    if (!raw) return "";
    if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(raw) || Number.isNaN(new Date(raw).getTime())) {
        throw new HttpError(400, `Date "${raw}" must look like 2026-10-21.`);
    }
    return raw;
}

/** Next 16: dynamic route params are a Promise. */
export async function routeParams(context) {
    return (await context?.params) || {};
}
