import { NextRequest, NextResponse } from "next/server";
import { login, logout, requireAuth, requireAdmin, resolveSession } from "../auth";
import { fail, ok, readJson, getSessionToken, withCors } from "../http";
import { ensureRdReady } from "../schema";
import { rdDatabaseName } from "../db";
import {
  addComment,
  listActivity,
  listComments,
  listNotifications,
  listTags,
  markNotificationsRead,
  metricsSummary,
  searchAll,
  upsertTag,
} from "../support";
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
} from "../tasks";
import { createUser, getUser, listUsers, updateUser } from "../users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ action?: string[] }> };

function normalizeAction(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return value.replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

function statusOf(err: unknown): number {
  const s = (err as { status?: number })?.status;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Request failed";
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params;
  const key = normalizeAction(action);

  try {
    if (key === "health" || key === "") {
      await ensureRdReady();
      return withCors(
        ok({
          ok: true,
          service: "rd-management",
          database: rdDatabaseName(),
          time: new Date().toISOString(),
        }),
      );
    }

    if (key === "auth_me") {
      const user = await resolveSession(getSessionToken(req));
      if (!user) return withCors(fail(401, "Unauthorized."));
      return withCors(ok({ user }));
    }

    const user = await requireAuth(req);

    switch (key) {
      case "users_list":
        return withCors(
          ok(
            await listUsers({
              q: req.nextUrl.searchParams.get("q") || undefined,
              role: req.nextUrl.searchParams.get("role") || undefined,
              activeOnly: req.nextUrl.searchParams.get("active") !== "0",
            }),
          ),
        );
      case "users_get": {
        const id = req.nextUrl.searchParams.get("id") || "";
        const row = await getUser(id);
        if (!row) return withCors(fail(404, "User not found."));
        return withCors(ok(row));
      }
      case "tasks_list":
        return withCors(
          ok(
            await listTasks({
              q: req.nextUrl.searchParams.get("q") || undefined,
              status: req.nextUrl.searchParams.get("status") || undefined,
              assigneeId: req.nextUrl.searchParams.get("assigneeId"),
              openOnly: req.nextUrl.searchParams.get("open") === "1",
              mineUserId:
                req.nextUrl.searchParams.get("mine") === "1" ? user.id : undefined,
              includeArchived: req.nextUrl.searchParams.get("archived") === "1",
              limit: Number(req.nextUrl.searchParams.get("limit") || 100),
            }),
          ),
        );
      case "tasks_get": {
        const id = req.nextUrl.searchParams.get("id") || req.nextUrl.searchParams.get("key") || "";
        const row = await getTask(id);
        if (!row) return withCors(fail(404, "Task not found."));
        return withCors(ok(row));
      }
      case "tags_list":
        return withCors(ok(await listTags()));
      case "comments_list": {
        const taskId = req.nextUrl.searchParams.get("taskId") || "";
        if (!taskId) return withCors(fail(400, "taskId is required."));
        return withCors(ok(await listComments(taskId)));
      }
      case "activity_list":
        return withCors(
          ok(
            await listActivity({
              taskId: req.nextUrl.searchParams.get("taskId") || undefined,
              limit: Number(req.nextUrl.searchParams.get("limit") || 50),
            }),
          ),
        );
      case "notifications_list":
        return withCors(
          ok(
            await listNotifications(user, {
              unreadOnly: req.nextUrl.searchParams.get("unread") === "1",
              limit: Number(req.nextUrl.searchParams.get("limit") || 50),
            }),
          ),
        );
      case "metrics_summary":
        return withCors(ok(await metricsSummary(user)));
      case "search":
        return withCors(
          ok(
            await searchAll(
              user,
              req.nextUrl.searchParams.get("q") || "",
              Number(req.nextUrl.searchParams.get("limit") || 20),
            ),
          ),
        );
      default:
        return withCors(fail(404, `Unknown action: ${action}`));
    }
  } catch (err) {
    console.error("[rd-management GET]", key, err);
    return withCors(fail(statusOf(err), messageOf(err)));
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params;
  const key = normalizeAction(action);
  const body = await readJson(req);

  try {
    if (key === "health") {
      await ensureRdReady();
      return withCors(
        ok({
          ok: true,
          service: "rd-management",
          database: rdDatabaseName(),
          time: new Date().toISOString(),
        }),
      );
    }

    if (key === "auth_login") {
      const result = await login(
        String(body.email || body.username || ""),
        String(body.password || ""),
      );
      return withCors(ok(result));
    }

    if (key === "auth_logout") {
      await logout(getSessionToken(req) || String(body.token || ""));
      return withCors(ok({ ok: true }));
    }

    if (key === "auth_me") {
      const user = await resolveSession(getSessionToken(req));
      if (!user) return withCors(fail(401, "Unauthorized."));
      return withCors(ok({ user }));
    }

    const user = await requireAuth(req);

    switch (key) {
      case "users_list":
        return withCors(
          ok(
            await listUsers({
              q: String(body.q || ""),
              role: body.role ? String(body.role) : undefined,
              activeOnly: body.active !== false && body.active !== 0,
            }),
          ),
        );
      case "users_get": {
        const row = await getUser(String(body.id || ""));
        if (!row) return withCors(fail(404, "User not found."));
        return withCors(ok(row));
      }
      case "users_create":
        await requireAdmin(req);
        return withCors(ok(await createUser(user, {
          name: String(body.name || ""),
          email: String(body.email || ""),
          password: String(body.password || ""),
          role: body.role === "ADMIN" ? "ADMIN" : "EMPLOYEE",
          jobTitle: (body.jobTitle as string) ?? null,
          department: (body.department as string) ?? null,
          phone: (body.phone as string) ?? null,
        }), 201));
      case "users_update":
        return withCors(
          ok(await updateUser(user, String(body.id || ""), body)),
        );
      case "tasks_list":
        return withCors(
          ok(
            await listTasks({
              q: body.q ? String(body.q) : undefined,
              status: body.status ? String(body.status) : undefined,
              assigneeId: body.assigneeId ? String(body.assigneeId) : undefined,
              openOnly: body.open === true || body.open === 1,
              mineUserId: body.mine === true || body.mine === 1 ? user.id : undefined,
              includeArchived: body.archived === true || body.archived === 1,
              limit: Number(body.limit || 100),
            }),
          ),
        );
      case "tasks_get": {
        const row = await getTask(String(body.id || body.key || ""));
        if (!row) return withCors(fail(404, "Task not found."));
        return withCors(ok(row));
      }
      case "tasks_create":
        return withCors(ok(await createTask(user, body), 201));
      case "tasks_update":
        return withCors(
          ok(await updateTask(user, String(body.id || body.key || ""), body)),
        );
      case "tasks_claim":
        return withCors(
          ok(await claimTask(user, String(body.id || body.key || ""))),
        );
      case "tasks_status":
        return withCors(
          ok(
            await updateTaskStatus(
              user,
              String(body.id || body.key || ""),
              String(body.status || ""),
              body.progress != null ? Number(body.progress) : undefined,
            ),
          ),
        );
      case "tags_list":
        return withCors(ok(await listTags()));
      case "tags_upsert":
        await requireAdmin(req);
        return withCors(
          ok(
            await upsertTag(user, {
              id: body.id ? String(body.id) : undefined,
              name: String(body.name || ""),
              color: (body.color as string) ?? null,
            }),
          ),
        );
      case "comments_list":
        return withCors(ok(await listComments(String(body.taskId || ""))));
      case "comments_add":
        return withCors(
          ok(
            await addComment(user, {
              taskId: String(body.taskId || ""),
              body: String(body.body || ""),
              kind: body.kind ? String(body.kind) : undefined,
            }),
            201,
          ),
        );
      case "activity_list":
        return withCors(
          ok(
            await listActivity({
              taskId: body.taskId ? String(body.taskId) : undefined,
              limit: Number(body.limit || 50),
            }),
          ),
        );
      case "notifications_list":
        return withCors(
          ok(
            await listNotifications(user, {
              unreadOnly: body.unread === true || body.unread === 1,
              limit: Number(body.limit || 50),
            }),
          ),
        );
      case "notifications_read":
        return withCors(
          ok(
            await markNotificationsRead(
              user,
              Array.isArray(body.ids) ? body.ids.map(String) : undefined,
            ),
          ),
        );
      case "metrics_summary":
        return withCors(ok(await metricsSummary(user)));
      case "search":
        return withCors(
          ok(
            await searchAll(
              user,
              String(body.q || ""),
              Number(body.limit || 20),
            ),
          ),
        );
      default:
        return withCors(fail(404, `Unknown action: ${action}`));
    }
  } catch (err) {
    console.error("[rd-management POST]", key, err);
    return withCors(fail(statusOf(err), messageOf(err)));
  }
}
