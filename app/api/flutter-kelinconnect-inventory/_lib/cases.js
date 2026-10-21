import { HttpError } from "./errors.js";
import { getLedgerPool, withLedgerTx } from "./ledger-db.js";
import { writeAudit } from "./audit.js";
import { assertApprove, assertOperate } from "./members.js";
import { findBranch, nextNumber, resolveAlerts } from "./ledger.js";
import { iso, num, person } from "./rules.js";

/** Discrepancy investigations: something did not add up; find out why. */

export const CASE_STATUSES = ["open", "investigating", "resolved", "written_off", "closed"];
export const CASE_RESOLUTIONS = ["found", "miscount", "damaged", "supplier_short", "data_error", "theft_suspected", "other"];
const CLOSED = ["resolved", "written_off", "closed"];

export async function createCase(conn, member, c) {
    const number = await nextNumber(conn, "CASE");
    const [res] = await conn.query(
        `INSERT INTO inv_discrepancy_cases
            (case_number, branch_id, product_id, source, source_id, expected_qty, physical_qty, difference, opened_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [number, c.branchId, c.productId, c.source, c.sourceId || null, c.expectedQty, c.physicalQty,
            num(c.physicalQty) - num(c.expectedQty), member.loginId]
    );
    if (c.note) {
        await conn.query("INSERT INTO inv_case_notes (case_id, author, author_name, note) VALUES (?, ?, ?, ?)",
            [res.insertId, member.loginId, member.name, c.note]);
    }
    await writeAudit(conn, member, {
        action: "case.open", entityType: "case", entityId: res.insertId, branchId: c.branchId, productId: c.productId,
        details: { number, source: c.source, sourceId: c.sourceId, expected: c.expectedQty, physical: c.physicalQty },
    });
    return { id: res.insertId, number };
}

const CASE_SELECT = `
    SELECT c.*, b.code AS branch_code, b.name AS branch_name, p.sku, p.name AS product_name,
           (SELECT COUNT(*) FROM inv_case_notes n WHERE n.case_id = c.id) AS note_count
      FROM inv_discrepancy_cases c
      JOIN inv_branches b ON b.id = c.branch_id
      JOIN inv_products p ON p.id = c.product_id`;

function mapCase(r) {
    return {
        id: Number(r.id),
        number: r.case_number,
        branch: r.branch_code,
        branchName: r.branch_name,
        inventoryId: r.sku,
        description: r.product_name,
        source: r.source,
        sourceId: r.source_id ? Number(r.source_id) : null,
        expectedQty: num(r.expected_qty),
        physicalQty: num(r.physical_qty),
        difference: num(r.difference),
        status: r.status,
        resolution: r.resolution || "",
        findings: r.findings || "",
        assignedTo: r.assigned_to || "",
        openedBy: person(r.opened_by, r.opened_by),
        closedBy: person(r.closed_by, r.closed_by),
        openedAt: iso(r.opened_at),
        closedAt: iso(r.closed_at),
        noteCount: num(r.note_count),
    };
}

export async function listCases({ branch, status, page, pageSize }) {
    const where = [];
    const params = [];
    if (branch) {
        where.push("b.code = ?");
        params.push(branch.toUpperCase());
    }
    if (status === "active") where.push("c.status IN ('open', 'investigating')");
    else if (status) {
        where.push("c.status = ?");
        params.push(status);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;
    const pool = getLedgerPool();
    const [rows] = await pool.query(
        `${CASE_SELECT} ${sqlWhere}
          ORDER BY (c.status IN ('open', 'investigating')) DESC, c.opened_at DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
    );
    const [[count]] = await pool.query(
        `SELECT COUNT(*) AS total FROM inv_discrepancy_cases c JOIN inv_branches b ON b.id = c.branch_id ${sqlWhere}`,
        params
    );
    const total = num(count?.total);
    return { cases: rows.map(mapCase), page, pageSize, totalCount: total, hasMore: offset + rows.length < total };
}

export async function getCase(id, conn = getLedgerPool()) {
    const [[row]] = await conn.query(`${CASE_SELECT} WHERE c.id = ?`, [id]);
    if (!row) throw new HttpError(404, `Case #${id} was not found.`);
    const [notes] = await conn.query(
        "SELECT * FROM inv_case_notes WHERE case_id = ? ORDER BY created_at ASC, id ASC",
        [id]
    );
    return {
        ...mapCase(row),
        notes: notes.map((n) => ({ id: Number(n.id), by: person(n.author, n.author_name), note: n.note, at: iso(n.created_at) })),
    };
}

async function lockCase(conn, member, id, request, action, { staffMay = false } = {}) {
    const [[row]] = await conn.query("SELECT * FROM inv_discrepancy_cases WHERE id = ? FOR UPDATE", [id]);
    if (!row) throw new HttpError(404, `Case #${id} was not found.`);
    const branch = await findBranch(conn, row.branch_id);
    if (staffMay) assertOperate(member, branch, request, action);
    else assertApprove(member, branch, request, action);
    return { row, branch };
}

/** Staff at the branch may add findings notes; assigning and closing stay with managers. */
export async function addCaseNote(member, id, note, request) {
    const text = String(note || "").trim().slice(0, 4000);
    if (!text) throw new HttpError(400, "Write a note first.");
    await withLedgerTx(async (conn) => {
        const { row, branch } = await lockCase(conn, member, id, request, "case.note", { staffMay: true });
        if (CLOSED.includes(row.status)) throw new HttpError(409, `${row.case_number} is already closed.`);
        await conn.query("INSERT INTO inv_case_notes (case_id, author, author_name, note) VALUES (?, ?, ?, ?)",
            [id, member.loginId, member.name, text]);
        if (row.status === "open") {
            await conn.query("UPDATE inv_discrepancy_cases SET status = 'investigating' WHERE id = ?", [id]);
        }
        await writeAudit(conn, member, {
            action: "case.note", entityType: "case", entityId: id, branchId: branch.id, request,
            details: { note: text.slice(0, 200) },
        });
    });
    return getCase(id);
}

export async function updateCase(member, id, body, request) {
    await withLedgerTx(async (conn) => {
        const { row, branch } = await lockCase(conn, member, id, request, "case.update");
        if (CLOSED.includes(row.status)) throw new HttpError(409, `${row.case_number} is already closed.`);
        const assignedTo = body.assignedTo === undefined ? row.assigned_to : String(body.assignedTo || "").trim().toUpperCase().slice(0, 50) || null;
        const findings = body.findings === undefined ? row.findings : String(body.findings || "").trim().slice(0, 4000) || null;
        await conn.query(
            "UPDATE inv_discrepancy_cases SET status = 'investigating', assigned_to = ?, findings = ? WHERE id = ?",
            [assignedTo, findings, id]
        );
        await writeAudit(conn, member, {
            action: "case.update", entityType: "case", entityId: id, branchId: branch.id, request,
            details: { assignedTo, findings: findings ? String(findings).slice(0, 200) : null },
        });
    });
    return getCase(id);
}

export async function closeCase(member, id, body, request) {
    const resolution = String(body.resolution || "").trim();
    if (!CASE_RESOLUTIONS.includes(resolution)) {
        throw new HttpError(400, `Pick what happened: ${CASE_RESOLUTIONS.join(", ")}.`);
    }
    const status = body.status === "written_off" ? "written_off" : "resolved";
    const findings = String(body.findings || "").trim().slice(0, 4000);
    if (!findings) throw new HttpError(400, "Write the findings before closing the case.");
    await withLedgerTx(async (conn) => {
        const { row, branch } = await lockCase(conn, member, id, request, "case.close");
        if (CLOSED.includes(row.status)) throw new HttpError(409, `${row.case_number} is already closed.`);
        await conn.query(
            `UPDATE inv_discrepancy_cases
                SET status = ?, resolution = ?, findings = ?, closed_by = ?, closed_at = UTC_TIMESTAMP()
              WHERE id = ?`,
            [status, resolution, findings, member.loginId, id]
        );
        await conn.query("INSERT INTO inv_case_notes (case_id, author, author_name, note) VALUES (?, ?, ?, ?)",
            [id, member.loginId, member.name, `Closed as ${status.replace("_", " ")} (${resolution.replace("_", " ")}): ${findings}`]);
        await resolveAlerts(conn, `case:${id}`);
        await writeAudit(conn, member, {
            action: "case.close", entityType: "case", entityId: id, branchId: branch.id, productId: row.product_id,
            request, details: { status, resolution },
        });
    });
    return getCase(id);
}
