import { randomUUID } from "crypto";
import { getPool, type RowDataPacket } from "./db";
import { ensureRdReady } from "./schema";
import type { RdSessionUser } from "./types";

export async function listTags() {
  await ensureRdReady();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, color, created_at FROM rd_tags ORDER BY name ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    color: r.color ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function upsertTag(
  _actor: RdSessionUser,
  input: { id?: string; name: string; color?: string | null },
) {
  await ensureRdReady();
  const name = String(input.name || "").trim();
  if (!name) {
    throw Object.assign(new Error("Tag name is required."), { status: 400 });
  }
  const pool = getPool();
  if (input.id) {
    await pool.execute(
      `UPDATE rd_tags SET name = ?, color = ? WHERE id = ?`,
      [name, input.color ?? null, input.id],
    );
    return { id: input.id, name, color: input.color ?? null };
  }
  const id = randomUUID();
  try {
    await pool.execute(
      `INSERT INTO rd_tags (id, name, color) VALUES (?, ?, ?)`,
      [id, name, input.color ?? null],
    );
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error("Tag already exists."), { status: 409 });
    }
    throw err;
  }
  return { id, name, color: input.color ?? null };
}

export async function listComments(taskId: string) {
  await ensureRdReady();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.*, u.name AS author_name
     FROM rd_comments c
     INNER JOIN rd_users u ON u.id = c.author_id
     WHERE c.task_id = ?
     ORDER BY c.created_at ASC`,
    [taskId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    authorId: String(r.author_id),
    authorName: String(r.author_name),
    kind: String(r.kind),
    body: String(r.body),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function addComment(
  actor: RdSessionUser,
  input: { taskId: string; body: string; kind?: string },
) {
  await ensureRdReady();
  const taskId = String(input.taskId || "").trim();
  const body = String(input.body || "").trim();
  if (!taskId || !body) {
    throw Object.assign(new Error("taskId and body are required."), {
      status: 400,
    });
  }
  const kind =
    input.kind === "PROGRESS_UPDATE" ? "PROGRESS_UPDATE" : "COMMENT";
  const id = randomUUID();
  const pool = getPool();
  await pool.execute(
    `INSERT INTO rd_comments (id, task_id, author_id, kind, body)
     VALUES (?, ?, ?, ?, ?)`,
    [id, taskId, actor.id, kind, body],
  );
  await pool.execute(
    `INSERT INTO rd_activity_logs (id, task_id, actor_id, action, new_value)
     VALUES (?, ?, ?, 'COMMENT_ADDED', ?)`,
    [randomUUID(), taskId, actor.id, JSON.stringify({ kind })],
  );
  const comments = await listComments(taskId);
  return comments.find((c) => c.id === id) || comments[comments.length - 1];
}

export async function listActivity(opts: {
  taskId?: string;
  limit?: number;
}) {
  await ensureRdReady();
  const pool = getPool();
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const params: unknown[] = [];
  let where = "";
  if (opts.taskId) {
    where = "WHERE a.task_id = ?";
    params.push(opts.taskId);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, u.name AS actor_name, t.task_key
     FROM rd_activity_logs a
     INNER JOIN rd_users u ON u.id = a.actor_id
     LEFT JOIN rd_tasks t ON t.id = a.task_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    taskId: r.task_id ? String(r.task_id) : null,
    taskKey: r.task_key ? String(r.task_key) : null,
    actorId: String(r.actor_id),
    actorName: String(r.actor_name),
    subjectUserId: r.subject_user_id ? String(r.subject_user_id) : null,
    action: String(r.action),
    oldValue: r.old_value,
    newValue: r.new_value,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listNotifications(
  actor: RdSessionUser,
  opts: { unreadOnly?: boolean; limit?: number },
) {
  await ensureRdReady();
  const pool = getPool();
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const where = opts.unreadOnly
    ? "WHERE recipient_id = ? AND is_read = 0"
    : "WHERE recipient_id = ?";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM rd_notifications ${where}
     ORDER BY created_at DESC LIMIT ${limit}`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: String(r.id),
    recipientId: String(r.recipient_id),
    taskId: r.task_id ? String(r.task_id) : null,
    type: String(r.type),
    message: String(r.message),
    isRead: r.is_read === 1 || r.is_read === true,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function markNotificationsRead(
  actor: RdSessionUser,
  ids?: string[],
) {
  await ensureRdReady();
  const pool = getPool();
  if (ids?.length) {
    const placeholders = ids.map(() => "?").join(",");
    await pool.execute(
      `UPDATE rd_notifications SET is_read = 1
       WHERE recipient_id = ? AND id IN (${placeholders})`,
      [actor.id, ...ids],
    );
  } else {
    await pool.execute(
      `UPDATE rd_notifications SET is_read = 1 WHERE recipient_id = ?`,
      [actor.id],
    );
  }
  return { ok: true };
}

export async function metricsSummary(actor: RdSessionUser) {
  await ensureRdReady();
  const pool = getPool();
  const isAdmin = actor.role === "ADMIN";

  const [[totals]] = await pool.query<RowDataPacket[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'COMPLETED') AS completed,
       SUM(status = 'IN_PROGRESS') AS in_progress,
       SUM(status = 'IN_REVIEW') AS in_review,
       SUM(status = 'NOT_STARTED') AS not_started,
       SUM(assignee_id IS NULL AND status NOT IN ('COMPLETED','CANCELLED') AND is_archived = 0) AS open_unassigned,
       SUM(due_date IS NOT NULL AND due_date < NOW() AND status NOT IN ('COMPLETED','CANCELLED') AND is_archived = 0) AS overdue
     FROM rd_tasks
     WHERE is_archived = 0 ${isAdmin ? "" : "AND assignee_id = ?"}`,
    isAdmin ? [] : [actor.id],
  );

  const [byUser] = isAdmin
    ? await pool.query<RowDataPacket[]>(
        `SELECT u.id, u.name,
                COUNT(t.id) AS assigned,
                SUM(t.status = 'COMPLETED') AS completed
         FROM rd_users u
         LEFT JOIN rd_tasks t ON t.assignee_id = u.id AND t.is_archived = 0
         WHERE u.is_active = 1
         GROUP BY u.id, u.name
         ORDER BY assigned DESC, u.name ASC`,
      )
    : [[] as RowDataPacket[]];

  return {
    totals: {
      total: Number(totals?.total || 0),
      completed: Number(totals?.completed || 0),
      inProgress: Number(totals?.in_progress || 0),
      inReview: Number(totals?.in_review || 0),
      notStarted: Number(totals?.not_started || 0),
      openUnassigned: Number(totals?.open_unassigned || 0),
      overdue: Number(totals?.overdue || 0),
    },
    byUser: (byUser as RowDataPacket[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      assigned: Number(r.assigned || 0),
      completed: Number(r.completed || 0),
    })),
  };
}

export async function searchAll(actor: RdSessionUser, qRaw: string, limit = 20) {
  await ensureRdReady();
  const q = String(qRaw || "").trim();
  if (q.length < 2) return { users: [], tasks: [] };
  const pool = getPool();
  const like = `%${q}%`;
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);

  const [users] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, email, role FROM rd_users
     WHERE is_active = 1 AND (name LIKE ? OR email LIKE ?)
     ORDER BY name ASC LIMIT ${lim}`,
    [like, like],
  );

  const taskWhere =
    actor.role === "ADMIN"
      ? `(title LIKE ? OR task_key LIKE ? OR description LIKE ?)`
      : `(title LIKE ? OR task_key LIKE ? OR description LIKE ?) AND (assignee_id = ? OR assignee_id IS NULL OR created_by_id = ?)`;
  const taskParams =
    actor.role === "ADMIN"
      ? [like, like, like]
      : [like, like, like, actor.id, actor.id];

  const [tasks] = await pool.query<RowDataPacket[]>(
    `SELECT id, task_key, title, status, priority
     FROM rd_tasks
     WHERE is_archived = 0 AND ${taskWhere}
     ORDER BY updated_at DESC LIMIT ${lim}`,
    taskParams,
  );

  return {
    users: users.map((u) => ({
      id: String(u.id),
      name: String(u.name),
      email: String(u.email),
      role: String(u.role),
    })),
    tasks: tasks.map((t) => ({
      id: String(t.id),
      taskKey: String(t.task_key),
      title: String(t.title),
      status: String(t.status),
      priority: String(t.priority),
    })),
  };
}
