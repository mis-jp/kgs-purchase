import { randomUUID } from "crypto";
import { hashPassword, mapUser } from "./auth";
import { getPool, type RowDataPacket } from "./db";
import { ensureRdReady } from "./schema";
import type { RdRole, RdSessionUser, RdUser } from "./types";

export async function listUsers(opts: {
  q?: string;
  role?: string;
  activeOnly?: boolean;
}): Promise<RdUser[]> {
  await ensureRdReady();
  const pool = getPool();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.activeOnly) where.push("is_active = 1");
  if (opts.role === "ADMIN" || opts.role === "EMPLOYEE") {
    where.push("role = ?");
    params.push(opts.role);
  }
  if (opts.q?.trim()) {
    where.push("(name LIKE ? OR email LIKE ?)");
    const like = `%${opts.q.trim()}%`;
    params.push(like, like);
  }

  const sql = `SELECT * FROM rd_users ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY name ASC`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows.map(mapUser);
}

export async function getUser(id: string): Promise<RdUser | null> {
  await ensureRdReady();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM rd_users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function createUser(
  actor: RdSessionUser,
  input: {
    name: string;
    email: string;
    password: string;
    role?: RdRole;
    jobTitle?: string | null;
    department?: string | null;
    phone?: string | null;
  },
): Promise<RdUser> {
  await ensureRdReady();
  if (actor.role !== "ADMIN") {
    throw Object.assign(new Error("Admin access required."), { status: 403 });
  }
  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  if (!name || !email || password.length < 8) {
    throw Object.assign(
      new Error("Name, email, and password (8+ chars) are required."),
      { status: 400 },
    );
  }
  const role: RdRole = input.role === "ADMIN" ? "ADMIN" : "EMPLOYEE";
  const id = randomUUID();
  const pool = getPool();
  try {
    await pool.execute(
      `INSERT INTO rd_users
        (id, name, email, password_hash, role, is_active, job_title, department, phone)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        name,
        email,
        hashPassword(password),
        role,
        input.jobTitle ?? null,
        input.department ?? null,
        input.phone ?? null,
      ],
    );
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error("Email already exists."), { status: 409 });
    }
    throw err;
  }

  await logActivity({
    actorId: actor.id,
    subjectUserId: id,
    action: "USER_CREATED",
    newValue: { email, role },
  });

  const user = await getUser(id);
  if (!user) throw new Error("Failed to load created user.");
  return user;
}

export async function updateUser(
  actor: RdSessionUser,
  id: string,
  input: Record<string, unknown>,
): Promise<RdUser> {
  await ensureRdReady();
  const isSelf = actor.id === id;
  if (!isSelf && actor.role !== "ADMIN") {
    throw Object.assign(new Error("Admin access required."), { status: 403 });
  }

  const existing = await getUser(id);
  if (!existing) {
    throw Object.assign(new Error("User not found."), { status: 404 });
  }

  const fields: string[] = [];
  const params: unknown[] = [];

  const setStr = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    params.push(val);
  };

  if (typeof input.name === "string" && input.name.trim()) {
    setStr("name", input.name.trim());
  }
  if (typeof input.jobTitle === "string" || input.jobTitle === null) {
    setStr("job_title", input.jobTitle);
  }
  if (typeof input.department === "string" || input.department === null) {
    setStr("department", input.department);
  }
  if (typeof input.phone === "string" || input.phone === null) {
    setStr("phone", input.phone);
  }
  if (typeof input.bio === "string" || input.bio === null) {
    setStr("bio", input.bio);
  }
  if (typeof input.avatarColor === "string" || input.avatarColor === null) {
    setStr("avatar_color", input.avatarColor);
  }

  if (actor.role === "ADMIN") {
    if (input.role === "ADMIN" || input.role === "EMPLOYEE") {
      setStr("role", input.role);
    }
    if (typeof input.isActive === "boolean") {
      setStr("is_active", input.isActive ? 1 : 0);
    }
    if (typeof input.email === "string" && input.email.trim()) {
      setStr("email", input.email.trim().toLowerCase());
    }
  }

  if (typeof input.password === "string" && input.password.length >= 8) {
    if (!isSelf && actor.role !== "ADMIN") {
      throw Object.assign(new Error("Cannot reset this password."), {
        status: 403,
      });
    }
    setStr("password_hash", hashPassword(input.password));
    fields.push("session_version = session_version + 1");
  }

  if (!fields.length) {
    throw Object.assign(new Error("No valid fields to update."), {
      status: 400,
    });
  }

  params.push(id);
  const pool = getPool();
  try {
    await pool.execute(
      `UPDATE rd_users SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error("Email already exists."), { status: 409 });
    }
    throw err;
  }

  await logActivity({
    actorId: actor.id,
    subjectUserId: id,
    action: isSelf ? "PROFILE_UPDATED" : "USER_UPDATED",
    newValue: { fields: fields.map((f) => f.split(" ")[0]) },
  });

  const user = await getUser(id);
  if (!user) throw new Error("Failed to load updated user.");
  return user;
}

async function logActivity(input: {
  actorId: string;
  subjectUserId?: string | null;
  taskId?: string | null;
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

export async function nextTaskKey(): Promise<string> {
  await ensureRdReady();
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO rd_sequences (name, value) VALUES ('task', 0)
       ON DUPLICATE KEY UPDATE name = name`,
    );
    await conn.execute(
      `UPDATE rd_sequences SET value = value + 1 WHERE name = 'task'`,
    );
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT value FROM rd_sequences WHERE name = 'task' LIMIT 1`,
    );
    await conn.commit();
    const n = Number(rows[0]?.value || 1);
    return `RD-${String(n).padStart(4, "0")}`;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
