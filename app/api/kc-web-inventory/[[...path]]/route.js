import { NextRequest } from "next/server";
import { authenticateBridge, canonicalPath } from "../_lib/bridge-auth.js";
import { runWithBridgeUser, requireBridgeMember, optionalBridgeMember, requireBridgeIdentity, blockTransferAlter } from "../_lib/bridge-member.js";
import { ADJUSTMENT_STATUSES, approveAdjustment, getAdjustment, listAdjustments, rejectAdjustment, requestAdjustment } from "../../flutter-kelinconnect-inventory/_lib/adjustments.js";
import { adminBranches, goLive, importMasterData, listSettings, listUsers, saveSettings, saveUser } from "../../flutter-kelinconnect-inventory/_lib/admin.js";
import { acknowledgeAlert, ALERT_STATUSES, listAlerts } from "../../flutter-kelinconnect-inventory/_lib/alerts.js";
import { addCaseNote, CASE_STATUSES, closeCase, getCase, listCases, updateCase } from "../../flutter-kelinconnect-inventory/_lib/cases.js";
import { cancelCount, countActivity, getCount, listCounts, saveLines, startCount, submitCount } from "../../flutter-kelinconnect-inventory/_lib/counts.js";
import { csvResponse, fail, failFromError, handle, HttpError, intParam, ok, readJson, textParam } from "../../flutter-kelinconnect-inventory/_lib/http.js";
import { addLocation, buildReport, dashboardActivity, erpCompare, itemLedgerInfo, listAuditLogs, listLocations, listWatchlist, recentActivity, saveItemBranchSettings, scanLookup, setWatch } from "../../flutter-kelinconnect-inventory/_lib/insights.js";
import { getSettings } from "../../flutter-kelinconnect-inventory/_lib/ledger.js";
import { cancelLedgerCount, getLedgerCount, LEDGER_LINE_FILTERS, listLedgerCounts, reviewLedgerCount, saveLedgerLines, startLedgerCount, submitLedgerCount } from "../../flutter-kelinconnect-inventory/_lib/ledger-counts.js";
import { getLedgerPool, ledgerStatus } from "../../flutter-kelinconnect-inventory/_lib/ledger-db.js";
import { assertAdmin, publicMember } from "../../flutter-kelinconnect-inventory/_lib/members.js";
import { approveTransaction, getTransaction, listReasonCodes, listTransactions, MOVEMENT_STATUSES, MOVEMENT_TYPES, postMovement, productHistory, rejectTransaction } from "../../flutter-kelinconnect-inventory/_lib/movements.js";
import { branchParam, countId, dateParam, idParam, lineFilter, oneOf, pageParams, routeParams, stockFilters } from "../../flutter-kelinconnect-inventory/_lib/params.js";
import { getItem, getSummary, listBranches, listCategories, listItems } from "../../flutter-kelinconnect-inventory/_lib/stock.js";
import { createTransfer, getTransfer, listTransfers, TRANSFER_STATUSES, transferAction } from "../../flutter-kelinconnect-inventory/_lib/transfers.js";

/**
 * Signed bridge for the KelinConnect web Inventory page.
 * Handler bodies are the Flutter route handlers with requireMember / optionalMember /
 * requireInventoryUser swapped for the bridge loaders. Flutter route files are not edited.
 * Responses keep { success, data } / { success:false, message } and drop CORS.
 */

// activity
const h_activity_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok({
        activity: await recentActivity({
            branch: branchParam(sp.get("branch")),
            limit: intParam(sp.get("limit"), 15, { min: 1, max: 50 }),
        }),
    });
});

// adjustments/[id]/[action]
/** POST adjustments/{id}/approve | adjustments/{id}/reject { reason } */
const h_adjustments_id_action_POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireBridgeMember(request);
    const adjustmentId = idParam(id, "adjustment");
    if (action === "approve") return ok({ adjustment: await approveAdjustment(member, adjustmentId, request) });
    if (action === "reject") {
        const body = await readJson(request);
        return ok({ adjustment: await rejectAdjustment(member, adjustmentId, body.reason, request) });
    }
    throw new HttpError(404, "Use approve or reject.");
});

// adjustments/[id]
const h_adjustments_id_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ adjustment: await getAdjustment(idParam(id, "adjustment")) });
});

// adjustments
const h_adjustments_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAdjustments({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), ADJUSTMENT_STATUSES, "status"),
        ...pageParams(sp),
    }));
});

const h_adjustments_POST = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const body = await readJson(request);
    return ok({ adjustment: await requestAdjustment(member, { ...body, branch: branchParam(body.branch) }, request) }, 201);
});

// admin/branches/[code]/go-live
/** POST: opening balance from Acumatica, then the branch runs on the ledger. Once per branch. */
const h_admin_branches_code_go_live_POST = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { code } = await routeParams(context);
    return ok({ goLive: await goLive(member, branchParam(decodeURIComponent(String(code || ""))), request) });
});

// admin/branches
const h_admin_branches_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    assertAdmin(member, request, "branch.list");
    return ok({ branches: await adminBranches() });
});

// admin/import
/** POST: copy branches, categories and products from Purchase (read-only sources). Safe to repeat. */
const h_admin_import_POST = handle(async (request) => {
    const member = await requireBridgeMember(request);
    return ok({ import: await importMasterData(member, request) });
});

// admin/settings
const h_admin_settings_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    assertAdmin(member, request, "settings.view");
    return ok({ settings: await listSettings() });
});

/** PUT { values: { setting_key: number } } */
const h_admin_settings_PUT = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const body = await readJson(request);
    return ok({ settings: await saveSettings(member, body.values, request) });
});

// admin/users/[loginId]
/** PUT { role?, allBranches?, branches?: string[], status?, name? } */
const h_admin_users_loginId_PUT = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { loginId } = await routeParams(context);
    return ok({ user: await saveUser(member, decodeURIComponent(String(loginId || "")), await readJson(request), request) });
});

// admin/users
const h_admin_users_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const search = textParam(new URL(request.url).searchParams.get("search"), 60);
    return ok({ users: await listUsers(member, { search }, request) });
});

// alerts/[id]/acknowledge
const h_alerts_id_acknowledge_POST = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ alert: await acknowledgeAlert(member, idParam(id, "alert"), request) });
});

// alerts
const h_alerts_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAlerts({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), ALERT_STATUSES, "status"),
        type: textParam(sp.get("type"), 40),
        ...pageParams(sp),
    }));
});

// audit-logs
const h_audit_logs_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listAuditLogs(member, {
        branch: branchParam(sp.get("branch")),
        action: textParam(sp.get("action"), 60),
        actor: textParam(sp.get("actor"), 50),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
        ...pageParams(sp, { pageSize: 50 }),
    }));
});

// branches/[code]/locations
const h_branches_code_locations_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { code } = await routeParams(context);
    return ok({ locations: await listLocations(branchParam(decodeURIComponent(String(code || "")))) });
});

/** POST { code, name?, zone? } */
const h_branches_code_locations_POST = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { code } = await routeParams(context);
    const branch = branchParam(decodeURIComponent(String(code || "")));
    return ok({ locations: await addLocation(member, branch, await readJson(request), request) }, 201);
});

// branches
const h_branches_GET = handle(async (request) => {
    await requireBridgeIdentity();
    const [branches, status] = await Promise.all([listBranches(), ledgerStatus()]);
    if (!status.ready) return ok({ branches: branches.map((b) => ({ ...b, live: false })), ledgerReady: false });

    const [rows] = await getLedgerPool().query("SELECT code, name, type, live_since FROM inv_branches WHERE status = 'active'");
    const ledger = new Map(rows.map((r) => [String(r.code).toUpperCase(), r]));
    const merged = branches.map((b) => {
        const row = ledger.get(String(b.id).toUpperCase());
        return { ...b, name: row?.name || b.name, type: row?.type || "branch", live: !!row?.live_since };
    });
    for (const [code, row] of ledger.entries()) {
        if (merged.some((b) => String(b.id).toUpperCase() === code)) continue;
        merged.push({
            id: code, name: row.name || code, type: row.type, live: !!row.live_since,
            itemCount: 0, inStockCount: 0, onHand: 0, lastSync: null,
        });
    }
    return ok({ branches: merged, ledgerReady: true });
});

// cases/[id]/[action]
/** POST cases/{id}/notes { note } | cases/{id}/close { resolution, findings, status? } */
const h_cases_id_action_POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireBridgeMember(request);
    const caseId = idParam(id, "case");
    const body = await readJson(request);
    if (action === "notes") return ok({ case: await addCaseNote(member, caseId, body.note, request) });
    if (action === "close") return ok({ case: await closeCase(member, caseId, body, request) });
    throw new HttpError(404, "Use notes or close.");
});

// cases/[id]
const h_cases_id_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ case: await getCase(idParam(id, "case")) });
});

/** PUT { assignedTo?, findings? } */
const h_cases_id_PUT = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ case: await updateCase(member, idParam(id, "case"), await readJson(request), request) });
});

// cases
const h_cases_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listCases({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), [...CASE_STATUSES, "active"], "status"),
        ...pageParams(sp),
    }));
});

// categories
async function h_categories_GET(request) {
    try {
        await requireBridgeIdentity();
        const { branch, search, status } = stockFilters(new URL(request.url).searchParams);
        return ok({ categories: await listCategories({ branch, search, status }) });
    } catch (err) {
        return failFromError(err);
    }
}

// counts/[id]/cancel
const h_counts_id_cancel_POST = handle(async (request, context) => {
    const { id } = await routeParams(context);
    if ((await ledgerStatus()).ready) {
        const member = await requireBridgeMember(request);
        return ok({ count: await cancelLedgerCount(member, countId(id), request) });
    }
    const { user } = await requireBridgeIdentity();
    return ok({ count: await cancelCount(countId(id), user) });
});

// counts/[id]/lines
const h_counts_id_lines_PUT = handle(async (request, context) => {
    const { id } = await routeParams(context);
    const body = await readJson(request);
    if ((await ledgerStatus()).ready) {
        const member = await requireBridgeMember(request);
        return ok(await saveLedgerLines(member, countId(id), body.lines, request));
    }
    const { user } = await requireBridgeIdentity();
    return ok(await saveLines(countId(id), body.lines, user));
});

// counts/[id]/review
const h_counts_id_review_POST = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok(await reviewLedgerCount(member, countId(id), await readJson(request), request));
});

// counts/[id]
const h_counts_id_GET = handle(async (request, context) => {
    const member = await optionalBridgeMember(request);
    const { id } = await routeParams(context);
    const searchParams = new URL(request.url).searchParams;
    const options = {
        search: textParam(searchParams.get("search")),
        page: intParam(searchParams.get("page"), 1, { min: 1, max: 100000 }),
        pageSize: intParam(searchParams.get("pageSize"), 50, { min: 1, max: 200 }),
    };
    if (member.ledger) {
        return ok(await getLedgerCount(member, countId(id), {
            ...options, filter: lineFilter(searchParams.get("filter"), LEDGER_LINE_FILTERS),
        }));
    }
    return ok(await getCount(countId(id), { ...options, filter: lineFilter(searchParams.get("filter")) }));
});

// counts/[id]/submit
const h_counts_id_submit_POST = handle(async (request, context) => {
    const { id } = await routeParams(context);
    if ((await ledgerStatus()).ready) {
        const member = await requireBridgeMember(request);
        return ok({ count: await submitLedgerCount(member, countId(id), request) });
    }
    const { user } = await requireBridgeIdentity();
    return ok({ count: await submitCount(countId(id), user) });
});

// counts
const STATUSES = ["open", "submitted", "reviewed", "cancelled"];



/** Counts run on the ledger once its database exists; before that, on the first-version tables. */
const h_counts_GET = handle(async (request) => {
    const searchParams = new URL(request.url).searchParams;
    const filters = {
        branch: branchParam(searchParams.get("branch")),
        status: oneOf(searchParams.get("status"), STATUSES, "status"),
        limit: intParam(searchParams.get("limit"), 50, { min: 1, max: 200 }),
    };
    const member = await optionalBridgeMember(request);
    if (member.ledger) return ok({ counts: await listLedgerCounts(member, filters) });
    return ok({ counts: await listCounts(filters) });
});

const h_counts_POST = handle(async (request) => {
    const body = await readJson(request);
    if ((await ledgerStatus()).ready) {
        const member = await requireBridgeMember(request);
        return ok({ count: await startLedgerCount(member, { ...body, branch: branchParam(body.branch) }, request) }, 201);
    }
    const { user } = await requireBridgeIdentity();
    const count = await startCount({
        branch: branchParam(body.branch),
        category: textParam(body.category, 100),
        note: textParam(body.note, 500),
        includeZero: body.includeZero === true,
        user,
    });
    return ok({ count }, 201);
});

// erp-compare
const h_erp_compare_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await erpCompare(member, {
        branch: branchParam(sp.get("branch")),
        onlyDifferences: sp.get("onlyDifferences") !== "0",
        search: textParam(sp.get("search")),
        ...pageParams(sp, { pageSize: 50, max: 200 }),
    }, request));
});

// health
function h_health_GET() {
    return ok({ service: "flutter-kelinconnect-inventory", time: new Date().toISOString() });
}

// items/[inventoryId]/history
const h_items_inventoryId_history_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { inventoryId } = await routeParams(context);
    const sp = new URL(request.url).searchParams;
    return ok(await productHistory(decodeURIComponent(String(inventoryId || "")), {
        branch: branchParam(sp.get("branch")),
        ...pageParams(sp, { pageSize: 30 }),
    }));
});

// items/[inventoryId]
const h_items_inventoryId_GET = handle(async (request, context) => {
    const member = await optionalBridgeMember(request);
    const { inventoryId } = await routeParams(context);
    const id = decodeURIComponent(String(inventoryId || "")).trim();
    if (!id) throw new HttpError(400, "Missing inventory id.");
    const [item, ledger] = await Promise.all([
        getItem(id),
        member.ledger ? itemLedgerInfo(member, id) : Promise.resolve(null),
    ]);
    return ok({ item: { ...item, ledger } });
});

// items/[inventoryId]/settings
/** PUT { branch, location?, minStock? } — shelf and minimum stock for one branch. */
const h_items_inventoryId_settings_PUT = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { inventoryId } = await routeParams(context);
    const body = await readJson(request);
    return ok({
        ledger: await saveItemBranchSettings(member, decodeURIComponent(String(inventoryId || "")),
            { ...body, branch: branchParam(body.branch) }, request),
    });
});

// items/[inventoryId]/watch
/** POST { watching: true|false } */
const h_items_inventoryId_watch_POST = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { inventoryId } = await routeParams(context);
    const body = await readJson(request);
    return ok(await setWatch(member, decodeURIComponent(String(inventoryId || "")), body.watching !== false));
});

// items
async function h_items_GET(request) {
    try {
        await requireBridgeIdentity();
        const searchParams = new URL(request.url).searchParams;
        const filters = stockFilters(searchParams);
        const page = intParam(searchParams.get("page"), 1, { min: 1, max: 100000 });
        const pageSize = intParam(searchParams.get("pageSize"), 30, { min: 1, max: 100 });
        return ok(await listItems({ ...filters, page, pageSize }));
    } catch (err) {
        return failFromError(err);
    }
}

// me
async function blindCountDefault(ready) {
    if (!ready) return false;
    try {
        return Number((await getSettings()).count_blind_default) === 1;
    } catch {
        return false;
    }
}

const h_me_GET = handle(async (request) => {
    const member = await optionalBridgeMember(request);
    const status = await ledgerStatus();
    return ok({
        user: publicMember(member),
        ledger: {
            ready: status.ready,
            liveBranches: status.liveBranches.map((b) => b.code),
            blindCountDefault: await blindCountDefault(status.ready),
            message: status.ready ? "" : "The new Inventory database is not set up yet. Stock is read from Acumatica.",
        },
    });
});

// movements/[id]/[action]
/** POST movements/{id}/approve | movements/{id}/reject { reason } */
const h_movements_id_action_POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    const member = await requireBridgeMember(request);
    const movementId = idParam(id, "movement");
    if (action === "approve") return ok({ movement: await approveTransaction(member, movementId, request) });
    if (action === "reject") {
        const body = await readJson(request);
        return ok({ movement: await rejectTransaction(member, movementId, body.reason, request) });
    }
    throw new HttpError(404, "Use approve or reject.");
});

// movements/[id]
const h_movements_id_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ movement: await getTransaction(idParam(id, "movement")) });
});

// movements
const h_movements_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listTransactions({
        branch: branchParam(sp.get("branch")),
        type: oneOf(sp.get("type"), MOVEMENT_TYPES, "type"),
        status: oneOf(sp.get("status"), MOVEMENT_STATUSES, "status"),
        search: textParam(sp.get("search")),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
        ...pageParams(sp),
    }));
});

// reason-codes
const h_reason_codes_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const type = oneOf(new URL(request.url).searchParams.get("type"),
        ["receive", "release", "transfer", "adjustment", "opening"], "type");
    return ok({ reasons: await listReasonCodes(type) });
});

// reports/[name]
/** GET reports/{stock|movements|adjustments|discrepancies|transfers|user-activity}?branch&from&to -> CSV */
const h_reports_name_GET = handle(async (request, context) => {
    const member = await requireBridgeMember(request);
    const { name } = await routeParams(context);
    const sp = new URL(request.url).searchParams;
    const report = await buildReport(member, String(name || "").replace(/\.csv$/i, ""), {
        branch: branchParam(sp.get("branch")),
        from: dateParam(sp.get("from")),
        to: dateParam(sp.get("to")),
    }, request);
    return csvResponse(report.filename, report.csv);
});

// scan/[code]
const h_scan_code_GET = handle(async (request, context) => {
    await requireBridgeIdentity();
    const { code } = await routeParams(context);
    return ok({ item: await scanLookup(decodeURIComponent(String(code || ""))) });
});

// stock/[kind]
/** POST stock/receive | stock/release */
const h_stock_kind_POST = handle(async (request, context) => {
    const { kind } = await routeParams(context);
    if (kind !== "receive" && kind !== "release") throw new HttpError(404, "Use stock/receive or stock/release.");
    const member = await requireBridgeMember(request);
    const body = await readJson(request);
    return ok({ movement: await postMovement(member, kind, { ...body, branch: branchParam(body.branch) }, request) }, 201);
});

// summary
const h_summary_GET = handle(async (request) => {
    await requireBridgeIdentity();
    const { branch, search, category } = stockFilters(new URL(request.url).searchParams);
    const status = await ledgerStatus();
    const [summary, branches, activity] = await Promise.all([
        getSummary({ branch, search, category }),
        listBranches(),
        status.ready ? dashboardActivity({ branch }) : countActivity(),
    ]);
    return ok({
        ...summary,
        branch: branch || "ALL",
        branchCount: branch ? 1 : branches.length,
        ledgerReady: status.ready,
        ...activity,
    });
});

// transfers/[id]/[action]
const ACTIONS = ["approve", "reject", "cancel", "dispatch", "receive"];



/** POST transfers/{id}/{approve|reject|cancel|dispatch|receive} */
const h_transfers_id_action_POST = handle(async (request, context) => {
    const { id, action } = await routeParams(context);
    if (!ACTIONS.includes(action)) throw new HttpError(404, `Use one of: ${ACTIONS.join(", ")}.`);
    const member = await requireBridgeMember(request);
    return ok({ transfer: await transferAction(member, idParam(id, "transfer"), action, await readJson(request), request) });
});

// transfers/[id]
const h_transfers_id_GET = handle(async (request, context) => {
    await requireBridgeMember(request);
    const { id } = await routeParams(context);
    return ok({ transfer: await getTransfer(idParam(id, "transfer")) });
});

// transfers
const h_transfers_GET = handle(async (request) => {
    await requireBridgeMember(request);
    const sp = new URL(request.url).searchParams;
    return ok(await listTransfers({
        branch: branchParam(sp.get("branch")),
        status: oneOf(sp.get("status"), [...TRANSFER_STATUSES, "active"], "status"),
        direction: oneOf(sp.get("direction"), ["in", "out"], "direction"),
        ...pageParams(sp),
    }));
});

const h_transfers_POST = handle(async (request) => {
    const member = await requireBridgeMember(request);
    const body = await readJson(request);
    return ok({
        transfer: await (await blockTransferAlter(), createTransfer)(member, {
            ...body, fromBranch: branchParam(body.fromBranch), toBranch: branchParam(body.toBranch),
        }, request),
    }, 201);
});

// watchlist
const h_watchlist_GET = handle(async (request) => {
    const member = await requireBridgeMember(request);
    return ok({ items: await listWatchlist(member) });
});

const ROUTES = [
    { method: "POST", pattern: ["admin","branches",":code","go-live"], fn: h_admin_branches_code_go_live_POST },
    { method: "PUT", pattern: ["admin","users",":loginId"], fn: h_admin_users_loginId_PUT },
    { method: "POST", pattern: ["alerts",":id","acknowledge"], fn: h_alerts_id_acknowledge_POST },
    { method: "GET", pattern: ["branches",":code","locations"], fn: h_branches_code_locations_GET },
    { method: "POST", pattern: ["branches",":code","locations"], fn: h_branches_code_locations_POST },
    { method: "POST", pattern: ["counts",":id","cancel"], fn: h_counts_id_cancel_POST },
    { method: "PUT", pattern: ["counts",":id","lines"], fn: h_counts_id_lines_PUT },
    { method: "POST", pattern: ["counts",":id","review"], fn: h_counts_id_review_POST },
    { method: "POST", pattern: ["counts",":id","submit"], fn: h_counts_id_submit_POST },
    { method: "GET", pattern: ["items",":inventoryId","history"], fn: h_items_inventoryId_history_GET },
    { method: "PUT", pattern: ["items",":inventoryId","settings"], fn: h_items_inventoryId_settings_PUT },
    { method: "POST", pattern: ["items",":inventoryId","watch"], fn: h_items_inventoryId_watch_POST },
    { method: "POST", pattern: ["adjustments",":id",":action"], fn: h_adjustments_id_action_POST },
    { method: "POST", pattern: ["cases",":id",":action"], fn: h_cases_id_action_POST },
    { method: "POST", pattern: ["movements",":id",":action"], fn: h_movements_id_action_POST },
    { method: "POST", pattern: ["transfers",":id",":action"], fn: h_transfers_id_action_POST },
    { method: "GET", pattern: ["admin","branches"], fn: h_admin_branches_GET },
    { method: "POST", pattern: ["admin","import"], fn: h_admin_import_POST },
    { method: "GET", pattern: ["admin","settings"], fn: h_admin_settings_GET },
    { method: "PUT", pattern: ["admin","settings"], fn: h_admin_settings_PUT },
    { method: "GET", pattern: ["admin","users"], fn: h_admin_users_GET },
    { method: "GET", pattern: ["adjustments",":id"], fn: h_adjustments_id_GET },
    { method: "GET", pattern: ["cases",":id"], fn: h_cases_id_GET },
    { method: "PUT", pattern: ["cases",":id"], fn: h_cases_id_PUT },
    { method: "GET", pattern: ["counts",":id"], fn: h_counts_id_GET },
    { method: "GET", pattern: ["items",":inventoryId"], fn: h_items_inventoryId_GET },
    { method: "GET", pattern: ["movements",":id"], fn: h_movements_id_GET },
    { method: "GET", pattern: ["reports",":name"], fn: h_reports_name_GET },
    { method: "GET", pattern: ["scan",":code"], fn: h_scan_code_GET },
    { method: "POST", pattern: ["stock",":kind"], fn: h_stock_kind_POST },
    { method: "GET", pattern: ["transfers",":id"], fn: h_transfers_id_GET },
    { method: "GET", pattern: ["activity"], fn: h_activity_GET },
    { method: "GET", pattern: ["adjustments"], fn: h_adjustments_GET },
    { method: "POST", pattern: ["adjustments"], fn: h_adjustments_POST },
    { method: "GET", pattern: ["alerts"], fn: h_alerts_GET },
    { method: "GET", pattern: ["audit-logs"], fn: h_audit_logs_GET },
    { method: "GET", pattern: ["branches"], fn: h_branches_GET },
    { method: "GET", pattern: ["cases"], fn: h_cases_GET },
    { method: "GET", pattern: ["categories"], fn: h_categories_GET },
    { method: "GET", pattern: ["counts"], fn: h_counts_GET },
    { method: "POST", pattern: ["counts"], fn: h_counts_POST },
    { method: "GET", pattern: ["erp-compare"], fn: h_erp_compare_GET },
    { method: "GET", pattern: ["health"], fn: h_health_GET },
    { method: "GET", pattern: ["items"], fn: h_items_GET },
    { method: "GET", pattern: ["me"], fn: h_me_GET },
    { method: "GET", pattern: ["movements"], fn: h_movements_GET },
    { method: "GET", pattern: ["reason-codes"], fn: h_reason_codes_GET },
    { method: "GET", pattern: ["summary"], fn: h_summary_GET },
    { method: "GET", pattern: ["transfers"], fn: h_transfers_GET },
    { method: "POST", pattern: ["transfers"], fn: h_transfers_POST },
    { method: "GET", pattern: ["watchlist"], fn: h_watchlist_GET },
];

function matchPattern(pattern, segments) {
    if (pattern.length !== segments.length) return null;
    const params = {};
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = segments[i];
        else if (pattern[i] !== segments[i]) return null;
    }
    return params;
}

function stripCors(res) {
    if (!res?.headers) return res;
    res.headers.delete("Access-Control-Allow-Origin");
    res.headers.delete("Access-Control-Allow-Headers");
    res.headers.delete("Access-Control-Allow-Methods");
    res.headers.set("Cache-Control", "no-store");
    return res;
}

async function dispatch(request, context, method) {
    const params = (await context?.params) || {};
    const segments = Array.isArray(params.path) ? params.path : [];
    const pathWithQuery = canonicalPath(segments, request.nextUrl.searchParams);
    const hasBody = method !== "GET" && method !== "HEAD";
    const rawBody = hasBody ? await request.text() : "";
    const auth = await authenticateBridge(request, rawBody, pathWithQuery);
    if (!auth.ok) return stripCors(fail(auth.status, auth.message));

    const matches = [];
    for (const route of ROUTES) {
        const named = matchPattern(route.pattern, segments);
        if (named) matches.push({ route, named });
    }
    const hit = matches.find((item) => item.route.method === method);
    if (!hit) {
        const status = matches.length ? 405 : 404;
        const message = matches.length ? "Method not allowed." : "Unknown inventory path.";
        return stripCors(fail(status, message));
    }

    const replay = new NextRequest(request.url, {
        method,
        headers: request.headers,
        body: hasBody ? rawBody : undefined,
    });
    const res = await runWithBridgeUser(auth.user, () => hit.route.fn(replay, { params: Promise.resolve(hit.named) }));
    return stripCors(res);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request, context) {
    return dispatch(request, context, "GET");
}

export function POST(request, context) {
    return dispatch(request, context, "POST");
}

export function PUT(request, context) {
    return dispatch(request, context, "PUT");
}

export function DELETE(request, context) {
    return dispatch(request, context, "DELETE");
}
