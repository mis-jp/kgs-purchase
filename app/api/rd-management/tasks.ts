import { randomUUID } from "crypto";
import { getPool, type RowDataPacket } from "./db";
import { ensureRdReady } from "./schema";
import type { Priority, RdSessionUser, SqlParam, TaskStatus } from "./types";
import { nextTaskKey } from "./users";

type TaskRow = RowDataPacket & Record<string, unknown>;

function mapTask(row: TaskRow, tags: { id: string; name: string; color: string | null }[] = []) {
  return {
    id: String(row.id),
    taskKey: String(row.task_key),
    title: String(row.title),
    description: row.description ?? null,
    status: String(row.status) as TaskStatus,
    priority: String(row.priority) as Priority,
    progress: Number(row.progress || 0),
    assigneeId: row.assignee_id ? String(row.assignee_id) : null,
    createdById: String(row.created_by_id),
    startDate: row.start_date ? new Date(String(row.start_date)).toISOString() : null,
    dueDate: row.due_date ? new Date(String(row.due_date)).toISOString() : null,
    completedAt: row.completed_at
      ? new Date(String(row.completed_at)).toISOString()
      : null,
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : null,
    estimatedMinutes: row.estimated_minutes != null ? Number(row.estimated_minutes) : null,
    actualMinutes: row.actual_minutes != null ? Number(row.actual_minutes) : null,
    isArchived: row.is_archived === 1 || row.is_archived === true,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    assigneeName: row.assignee_name ? String(row.assignee_name) : null,
    createdByName: row.created_by_name ? String(row.created_by_name) : null,
    tags,
  };
}

async function loadTagsForTasks(
  taskIds: string[],
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const map = new Map<string, { id: string; name: string; color: string | null }[]>();
  if (!taskIds.length) return map;
  const pool = getPool();
  const placeholders = taskIds.map(() => "?").join(",");
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT tt.task_id, t.id, t.name, t.color
     FROM rd_task_tags tt
     INNER JOIN rd_tags t ON t.id = tt.tag_id
     WHERE tt.task_id IN (${placeholders})
     ORDER BY t.name ASC`,
    taskIds,
  );
  for (const row of rows) {
    const tid = String(row.task_id);
    const list = map.get(tid) || [];
    list.push({
      id: String(row.id),
      name: String(row.name),
      color: row.color ?? null,
    });
    map.set(tid, list);
  }
  return map;
}

async function writeActivity(input: {
  actorId: string;
  taskId?: string | null;
  subjectUserId?: string | null;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
}): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO rd_activity_logs
      (id, task_id, actor_id, subject_user_id, action, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.taskId ?? null,
      input.actorId,
      input.subjectUserId ?? null,
      input.action,
      input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      input.newValue != null ? JSON.stringify(input.newValue) : null,
    ],
  );
}

async function notify(input: {
  recipientId: string;
  taskId?: string | null;
  type: string;
  message: string;
}): Promise<void> {
  if (!input.recipientId) return;
  const pool = getPool();
  await pool.execute(
    `INSERT INTO rd_notifications (id, recipient_id, task_id, type, message)
     VALUES (?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.recipientId,
      input.taskId ?? null,
      input.type,
      input.message.slice(0, 500),
    ],
  );
}

export async function listTasks(opts: {
  q?: string;
  status?: string;
  assigneeId?: string | null;
  openOnly?: boolean;
  mineUserId?: string;
  includeArchived?: boolean;
  limit?: number;
}): Promise<ReturnType<typeof mapTask>[]> {
  await ensureRdReady();
  const pool = getPool();
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (!opts.includeArchived) where.push("t.is_archived = 0");
  if (opts.status) {
    where.push("t.status = ?");
    params.push(opts.status);
  }
  if (opts.openOnly) {
    where.push("t.assignee_id IS NULL");
    where.push("t.status NOT IN ('COMPLETED','CANCELLED')");
  }
  if (opts.assigneeId) {
    where.push("t.assignee_id = ?");
    params.push(opts.assigneeId);
  }
  if (opts.mineUserId) {
    where.push("t.assignee_id = ?");
    params.push(opts.mineUserId);
  }
  if (opts.q?.trim()) {
    where.push("(t.title LIKE ? OR t.task_key LIKE ? OR t.description LIKE ?)");
    const like = `%${opts.q.trim()}%`;
    params.push(like, like, like);
  }

  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const sql = `
    SELECT t.*,
           a.name AS assignee_name,
           c.name AS created_by_name
    FROM rd_tasks t
    LEFT JOIN rd_users a ON a.id = t.assignee_id
    LEFT JOIN rd_users c ON c.id = t.created_by_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY t.updated_at DESC
    LIMIT ${limit}
  `;
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  const ids = rows.map((r) => String(r.id));
  const tagMap = await loadTagsForTasks(ids);
  return rows.map((r) => mapTask(r, tagMap.get(String(r.id)) || []));
}

export async function getTask(idOrKey: string) {
  await ensureRdReady();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT t.*,
            a.name AS assignee_name,
            c.name AS created_by_name
     FROM rd_tasks t
     LEFT JOIN rd_users a ON a.id = t.assignee_id
     LEFT JOIN rd_users c ON c.id = t.created_by_id
     WHERE t.id = ? OR t.task_key = ?
     LIMIT 1`,
    [idOrKey, idOrKey],
  );
  const row = rows[0];
  if (!row) return null;
  const tagMap = await loadTagsForTasks([String(row.id)]);
  return mapTask(row, tagMap.get(String(row.id)) || []);
}

async function setTaskTags(taskId: string, tagIds: string[]): Promise<void> {
  const pool = getPool();
  await pool.execute(`DELETE FROM rd_task_tags WHERE task_id = ?`, [taskId]);
  for (const tagId of tagIds) {
    if (!tagId) continue;
    await pool.execute(
      `INSERT IGNORE INTO rd_task_tags (tag_id, task_id) VALUES (?, ?)`,
      [tagId, taskId],
    );
  }
}

export async function createTask(
  actor: RdSessionUser,
  input: Record<string, unknown>,
) {
  await ensureRdReady();
  const title = String(input.title || "").trim();
  if (!title) {
    throw Object.assign(new Error("Title is required."), { status: 400 });
  }
  if (actor.role !== "ADMIN" && !input.assigneeId) {
    // employees can create only if claiming for self later; allow open or self
  }

  const id = randomUUID();
  const taskKey = await nextTaskKey();
  const status = (String(input.status || "NOT_STARTED") as TaskStatus) || "NOT_STARTED";
  const priority = (String(input.priority || "NORMAL") as Priority) || "NORMAL";
  let assigneeId =
    typeof input.assigneeId === "string" && input.assigneeId
      ? input.assigneeId
      : null;

  // Non-admins may only assign to themselves or leave open
  if (actor.role !== "ADMIN" && assigneeId && assigneeId !== actor.id) {
    throw Object.assign(new Error("You can only assign tasks to yourself."), {
      status: 403,
    });
  }

  const pool = getPool();
  await pool.execute(
    `INSERT INTO rd_tasks
      (id, task_key, title, description, status, priority, progress,
       assignee_id, created_by_id, start_date, due_date, estimated_minutes, claimed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      taskKey,
      title,
      typeof input.description === "string" ? input.description : null,
      status,
      priority,
      Number(input.progress || 0),
      assigneeId,
      actor.id,
      input.startDate ? new Date(String(input.startDate)) : null,
      input.dueDate ? new Date(String(input.dueDate)) : null,
      input.estimatedMinutes != null ? Number(input.estimatedMinutes) : null,
      assigneeId ? new Date() : null,
    ],
  );

  const tagIds = Array.isArray(input.tagIds)
    ? input.tagIds.map(String)
    : [];
  if (tagIds.length) await setTaskTags(id, tagIds);

  await writeActivity({
    actorId: actor.id,
    taskId: id,
    action: "TASK_CREATED",
    newValue: { taskKey, title, assigneeId },
  });

  if (assigneeId && assigneeId !== actor.id) {
    await notify({
      recipientId: assigneeId,
      taskId: id,
      type: "TASK_ASSIGNED",
      message: `You were assigned to ${taskKey}: ${title}`,
    });
  }

  return getTask(id);
}

export async function updateTask(
  actor: RdSessionUser,
  idOrKey: string,
  input: Record<string, unknown>,
) {
  await ensureRdReady();
  const existing = await getTask(idOrKey);
  if (!existing) {
    throw Object.assign(new Error("Task not found."), { status: 404 });
  }

  const isAdmin = actor.role === "ADMIN";
  const isAssignee = existing.assigneeId === actor.id;
  const isCreator = existing.createdById === actor.id;
  if (!isAdmin && !isAssignee && !isCreator) {
    throw Object.assign(new Error("You cannot edit this task."), {
      status: 403,
    });
  }

  const fields: string[] = [];
  const params: SqlParam[] = [];
  const set = (col: string, val: SqlParam) => {
    fields.push(`${col} = ?`);
    params.push(val);
  };

  if (typeof input.title === "string" && input.title.trim()) {
    set("title", input.title.trim());
  }
  if (typeof input.description === "string" || input.description === null) {
    set("description", input.description);
  }
  if (typeof input.priority === "string") set("priority", input.priority);
  if (input.progress != null) {
    const p = Math.max(0, Math.min(100, Number(input.progress)));
    set("progress", p);
  }
  if (input.startDate !== undefined) {
    set("start_date", input.startDate ? new Date(String(input.startDate)) : null);
  }
  if (input.dueDate !== undefined) {
    set("due_date", input.dueDate ? new Date(String(input.dueDate)) : null);
  }
  if (input.estimatedMinutes !== undefined) {
    set(
      "estimated_minutes",
      input.estimatedMinutes != null ? Number(input.estimatedMinutes) : null,
    );
  }
  if (input.actualMinutes !== undefined) {
    set(
      "actual_minutes",
      input.actualMinutes != null ? Number(input.actualMinutes) : null,
    );
  }
  if (typeof input.isArchived === "boolean" && isAdmin) {
    set("is_archived", input.isArchived ? 1 : 0);
  }

  if (input.assigneeId !== undefined && isAdmin) {
    const nextAssignee =
      typeof input.assigneeId === "string" && input.assigneeId
        ? input.assigneeId
        : null;
    set("assignee_id", nextAssignee);
    if (nextAssignee && !existing.assigneeId) set("claimed_at", new Date());
    if (!nextAssignee) set("claimed_at", null);
  }

  if (!fields.length && !Array.isArray(input.tagIds)) {
    throw Object.assign(new Error("No valid fields to update."), {
      status: 400,
    });
  }

  const pool = getPool();
  if (fields.length) {
    params.push(existing.id);
    await pool.execute(
      `UPDATE rd_tasks SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );
  }

  if (Array.isArray(input.tagIds)) {
    await setTaskTags(existing.id, input.tagIds.map(String));
  }

  await writeActivity({
    actorId: actor.id,
    taskId: existing.id,
    action: "TASK_UPDATED",
    newValue: input,
  });

  if (
    input.assigneeId !== undefined &&
    isAdmin &&
    typeof input.assigneeId === "string" &&
    input.assigneeId &&
    input.assigneeId !== existing.assigneeId
  ) {
    await notify({
      recipientId: input.assigneeId,
      taskId: existing.id,
      type: "TASK_REASSIGNED",
      message: `You were assigned to ${existing.taskKey}: ${existing.title}`,
    });
  }

  return getTask(existing.id);
}

export async function claimTask(actor: RdSessionUser, idOrKey: string) {
  await ensureRdReady();
  const existing = await getTask(idOrKey);
  if (!existing) {
    throw Object.assign(new Error("Task not found."), { status: 404 });
  }
  if (existing.assigneeId) {
    throw Object.assign(new Error("Task is already claimed."), { status: 409 });
  }
  if (existing.isArchived) {
    throw Object.assign(new Error("Archived tasks cannot be claimed."), {
      status: 400,
    });
  }

  const pool = getPool();
  const [result] = await pool.execute(
    `UPDATE rd_tasks
     SET assignee_id = ?, claimed_at = CURRENT_TIMESTAMP(3),
         status = CASE WHEN status = 'NOT_STARTED' THEN 'IN_PROGRESS' ELSE status END
     WHERE id = ? AND assignee_id IS NULL`,
    [actor.id, existing.id],
  );
  const affected = (result as { affectedRows?: number }).affectedRows || 0;
  if (!affected) {
    throw Object.assign(new Error("Task is already claimed."), { status: 409 });
  }

  await writeActivity({
    actorId: actor.id,
    taskId: existing.id,
    action: "TASK_CLAIMED",
    newValue: { assigneeId: actor.id },
  });

  if (existing.createdById !== actor.id) {
    await notify({
      recipientId: existing.createdById,
      taskId: existing.id,
      type: "TASK_CLAIMED",
      message: `${actor.name} claimed ${existing.taskKey}`,
    });
  }

  return getTask(existing.id);
}

export async function updateTaskStatus(
  actor: RdSessionUser,
  idOrKey: string,
  statusRaw: string,
  progress?: number,
) {
  await ensureRdReady();
  const allowed: TaskStatus[] = [
    "NOT_STARTED",
    "IN_PROGRESS",
    "IN_REVIEW",
    "COMPLETED",
    "ON_HOLD",
    "CANCELLED",
  ];
  const status = statusRaw as TaskStatus;
  if (!allowed.includes(status)) {
    throw Object.assign(new Error("Invalid status."), { status: 400 });
  }

  const existing = await getTask(idOrKey);
  if (!existing) {
    throw Object.assign(new Error("Task not found."), { status: 404 });
  }

  const isAdmin = actor.role === "ADMIN";
  const isAssignee = existing.assigneeId === actor.id;
  if (!isAdmin && !isAssignee) {
    throw Object.assign(new Error("You cannot change this task status."), {
      status: 403,
    });
  }

  const pool = getPool();
  const prog =
    progress != null
      ? Math.max(0, Math.min(100, Number(progress)))
      : status === "COMPLETED"
        ? 100
        : existing.progress;

  await pool.execute(
    `UPDATE rd_tasks
     SET status = ?,
         progress = ?,
         completed_at = CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIMESTAMP(3)
                             WHEN status = 'COMPLETED' AND ? <> 'COMPLETED' THEN NULL
                             ELSE completed_at END
     WHERE id = ?`,
    [status, prog, status, status, existing.id],
  );

  await writeActivity({
    actorId: actor.id,
    taskId: existing.id,
    action: status === "COMPLETED" ? "TASK_COMPLETED" : "STATUS_CHANGED",
    oldValue: { status: existing.status },
    newValue: { status, progress: prog },
  });

  return getTask(existing.id);
}
