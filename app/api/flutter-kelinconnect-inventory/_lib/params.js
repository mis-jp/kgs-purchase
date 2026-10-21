import { HttpError, textParam } from "./http";
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

export function lineFilter(value) {
    const filter = textParam(value, 20) || "all";
    if (!LINE_FILTERS.includes(filter)) {
        throw new HttpError(400, `Unknown filter "${filter}". Use ${LINE_FILTERS.join(", ")}.`);
    }
    return filter;
}

export function countId(value) {
    const id = parseInt(String(value || ""), 10);
    if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "Invalid count id.");
    return id;
}
