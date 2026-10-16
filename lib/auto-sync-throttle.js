export const QUICK_SYNC_MIN_GAP_MS = 2 * 60 * 1000;

export function readLastQuickSyncAt(storage, key = "acu_last_quick_sync") {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts ?? parsed);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

export function writeLastQuickSyncAt(storage, key = "acu_last_quick_sync", now = Date.now()) {
  if (!storage || typeof storage.setItem !== "function") return;
  try {
    storage.setItem(key, JSON.stringify({ ts: now }));
  } catch {
    // ignore storage quota or private mode issues
  }
}

export function shouldSkipQuickSync(now = Date.now(), lastSyncAt = null, minGapMs = QUICK_SYNC_MIN_GAP_MS) {
  if (!Number.isFinite(lastSyncAt)) return false;
  return now - Number(lastSyncAt) < minGapMs;
}
