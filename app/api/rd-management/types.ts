export type ApiOk<T> = { status: "success"; success: true; data: T };
export type ApiErr = { status: "error"; success: false; message: string };

export type RdRole = "ADMIN" | "EMPLOYEE";

export type RdUser = {
  id: string;
  name: string;
  email: string;
  role: RdRole;
  isActive: boolean;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  bio: string | null;
  avatarColor: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RdSessionUser = Pick<
  RdUser,
  "id" | "name" | "email" | "role" | "isActive"
>;

export type TaskStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "COMPLETED"
  | "ON_HOLD"
  | "CANCELLED";

export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

/** Values accepted by mysql2 pool.execute bindings. */
export type SqlParam = string | number | boolean | Date | Buffer | null;
