import { getLedgerPool } from "./ledger-db.js";

/** Append one row to `inv_audit_logs` (append-only; the table blocks UPDATE / DELETE). */
export async function writeAudit(conn, member, entry) {
    const request = entry.request;
    const ip = request?.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim()
        || request?.headers?.get?.("x-real-ip") || null;
    const agent = request?.headers?.get?.("user-agent") || null;
    await (conn || getLedgerPool()).query(
        `INSERT INTO inv_audit_logs
            (actor_login_id, actor_name, actor_role, action, outcome, entity_type, entity_id,
             branch_id, product_id, transaction_id, details, request_id, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            member.loginId,
            member.name || null,
            member.role || null,
            entry.action,
            entry.outcome || "success",
            entry.entityType || null,
            entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
            entry.branchId || null,
            entry.productId || null,
            entry.transactionId || null,
            entry.details ? JSON.stringify(entry.details) : null,
            entry.requestId || null,
            ip ? String(ip).slice(0, 45) : null,
            agent ? String(agent).slice(0, 255) : null,
        ]
    );
}

/** Best-effort audit outside a transaction (used for denied attempts). */
export function auditLater(member, entry) {
    writeAudit(null, member, entry).catch((err) => console.warn("[KC Inventory audit]", err?.message || err));
}
