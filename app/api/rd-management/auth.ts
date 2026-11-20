import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { NextRequest } from "next/server";
import { getPool, type RowDataPacket } from "./db";
import { getSessionToken } from "./http";
import { ensureRdReady } from "./schema";
import type { RdRole, RdSessionUser, RdUser } from "./types";

const SESSION_DAYS = 14;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapUser(row: RowDataPacket): RdUser {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role === "ADMIN" ? "ADMIN" : "EMPLOYEE",
    isActive: row.is_active === 1 || row.is_active === true,
    jobTitle: row.job_title ?? null,
    department: row.department ?? null,
    phone: row.phone ?? null,
    bio: row.bio ?? null,
    avatarColor: row.avatar_color ?? null,
    lastLoginAt: row.last_login_at
      ? new Date(row.last_login_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(String(plain), 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  if (!plain || !hash) return false;
  try {
    return bcrypt.compareSync(String(plain), String(hash));
  } catch {
    return false;
  }
}

export async function login(
  emailRaw: string,
  password: string,
): Promise<{ token: string; user: RdUser; expiresAt: string }> {
  await ensureRdReady();
  const email = String(emailRaw || "").trim().toLowerCase();
  if (!email || !password) {
    throw Object.assign(new Error("Email and password are required."), {
      status: 400,
    });
  }

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM rd_users WHERE email = ? LIMIT 1",
    [email],
  );
  const row = rows[0];
  if (!row || !verifyPassword(password, String(row.password_hash))) {
    throw Object.assign(new Error("Invalid email or password."), {
      status: 401,
    });
  }
  if (!(row.is_active === 1 || row.is_active === true)) {
    throw Object.assign(new Error("This account is deactivated."), {
      status: 401,
    });
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const id = randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await pool.execute(
    `INSERT INTO rd_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [id, row.id, tokenHash, expires],
  );
  await pool.execute(
    `UPDATE rd_users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [row.id],
  );

  const user = mapUser({ ...row, last_login_at: new Date() });
  return { token, user, expiresAt: expires.toISOString() };
}

export async function logout(token: string | null): Promise<void> {
  await ensureRdReady();
  if (!token) return;
  const pool = getPool();
  await pool.execute(`DELETE FROM rd_sessions WHERE token_hash = ?`, [
    hashToken(token),
  ]);
}

export async function resolveSession(
  token: string | null,
): Promise<RdSessionUser | null> {
  await ensureRdReady();
  if (!token) return null;
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.name, u.email, u.role, u.is_active
     FROM rd_sessions s
     INNER JOIN rd_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW()
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (!(row.is_active === 1 || row.is_active === true)) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: (row.role === "ADMIN" ? "ADMIN" : "EMPLOYEE") as RdRole,
    isActive: true,
  };
}

export async function requireAuth(req: NextRequest): Promise<RdSessionUser> {
  const user = await resolveSession(getSessionToken(req));
  if (!user) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  return user;
}

export async function requireAdmin(req: NextRequest): Promise<RdSessionUser> {
  const user = await requireAuth(req);
  if (user.role !== "ADMIN") {
    throw Object.assign(new Error("Admin access required."), { status: 403 });
  }
  return user;
}

export { mapUser };
