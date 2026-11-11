const EXTRA_SYNC_ALERT_USERS = ["johnpaul"];

/** Usernames allowed to see sync failure alerts: the built-in System Administrator account plus the extra list. */
export function syncAlertUsernames(env = process.env) {
    const builtInAdmin = String(env.APP_ADMIN_USERNAME || "admin").trim().toLowerCase();
    const fromEnv = String(env.SYNC_ALERT_USERS || "")
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);
    return new Set([builtInAdmin, ...EXTRA_SYNC_ALERT_USERS, ...fromEnv]);
}

export function canSeeSyncAlerts(user, env = process.env) {
    if (!user || user.role !== "admin") return false;
    const username = String(user.username || "").trim().toLowerCase();
    return !!username && syncAlertUsernames(env).has(username);
}
