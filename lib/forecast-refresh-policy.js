export function shouldWaitForForecastRefresh({
    isExport = false,
    isManualRefresh = false,
} = {}) {
    if (isExport) return false;
    return Boolean(isManualRefresh);
}
