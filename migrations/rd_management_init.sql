-- R&D Management — dedicated database bootstrap
-- Safe: creates ONLY db_rd_management and its own tables. Does not touch existing DBs.
-- Run on the MySQL server (e.g. as alecdb if granted CREATE, or as a DBA).

CREATE DATABASE IF NOT EXISTS `db_rd_management`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `db_rd_management`;

CREATE TABLE IF NOT EXISTS rd_users (
  id VARCHAR(191) NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN','EMPLOYEE') NOT NULL DEFAULT 'EMPLOYEE',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  job_title VARCHAR(120) NULL,
  department VARCHAR(120) NULL,
  phone VARCHAR(40) NULL,
  bio TEXT NULL,
  avatar_color VARCHAR(20) NULL,
  session_version INT NOT NULL DEFAULT 0,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY rd_users_email_uq (email),
  KEY rd_users_role_active_idx (role, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_sessions (
  id VARCHAR(191) NOT NULL,
  user_id VARCHAR(191) NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY rd_sessions_token_uq (token_hash),
  KEY rd_sessions_user_idx (user_id),
  KEY rd_sessions_expires_idx (expires_at),
  CONSTRAINT rd_sessions_user_fk FOREIGN KEY (user_id) REFERENCES rd_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_tasks (
  id VARCHAR(191) NOT NULL,
  task_key VARCHAR(20) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  status ENUM('NOT_STARTED','IN_PROGRESS','IN_REVIEW','COMPLETED','ON_HOLD','CANCELLED') NOT NULL DEFAULT 'NOT_STARTED',
  priority ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
  progress INT NOT NULL DEFAULT 0,
  assignee_id VARCHAR(191) NULL,
  created_by_id VARCHAR(191) NOT NULL,
  start_date DATETIME(3) NULL,
  due_date DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  claimed_at DATETIME(3) NULL,
  estimated_minutes INT NULL,
  actual_minutes INT NULL,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY rd_tasks_key_uq (task_key),
  KEY rd_tasks_status_idx (status),
  KEY rd_tasks_assignee_idx (assignee_id),
  KEY rd_tasks_due_idx (due_date),
  KEY rd_tasks_archived_idx (is_archived),
  CONSTRAINT rd_tasks_assignee_fk FOREIGN KEY (assignee_id) REFERENCES rd_users(id) ON DELETE SET NULL,
  CONSTRAINT rd_tasks_creator_fk FOREIGN KEY (created_by_id) REFERENCES rd_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_tags (
  id VARCHAR(191) NOT NULL,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(20) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY rd_tags_name_uq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_task_tags (
  tag_id VARCHAR(191) NOT NULL,
  task_id VARCHAR(191) NOT NULL,
  PRIMARY KEY (tag_id, task_id),
  KEY rd_task_tags_task_idx (task_id),
  CONSTRAINT rd_task_tags_tag_fk FOREIGN KEY (tag_id) REFERENCES rd_tags(id) ON DELETE CASCADE,
  CONSTRAINT rd_task_tags_task_fk FOREIGN KEY (task_id) REFERENCES rd_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_comments (
  id VARCHAR(191) NOT NULL,
  task_id VARCHAR(191) NOT NULL,
  author_id VARCHAR(191) NOT NULL,
  kind ENUM('COMMENT','PROGRESS_UPDATE') NOT NULL DEFAULT 'COMMENT',
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY rd_comments_task_idx (task_id, created_at),
  CONSTRAINT rd_comments_task_fk FOREIGN KEY (task_id) REFERENCES rd_tasks(id) ON DELETE CASCADE,
  CONSTRAINT rd_comments_author_fk FOREIGN KEY (author_id) REFERENCES rd_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_activity_logs (
  id VARCHAR(191) NOT NULL,
  task_id VARCHAR(191) NULL,
  actor_id VARCHAR(191) NOT NULL,
  subject_user_id VARCHAR(191) NULL,
  action VARCHAR(64) NOT NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY rd_activity_task_idx (task_id, created_at),
  KEY rd_activity_actor_idx (actor_id),
  KEY rd_activity_created_idx (created_at),
  CONSTRAINT rd_activity_task_fk FOREIGN KEY (task_id) REFERENCES rd_tasks(id) ON DELETE CASCADE,
  CONSTRAINT rd_activity_actor_fk FOREIGN KEY (actor_id) REFERENCES rd_users(id) ON DELETE RESTRICT,
  CONSTRAINT rd_activity_subject_fk FOREIGN KEY (subject_user_id) REFERENCES rd_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_notifications (
  id VARCHAR(191) NOT NULL,
  recipient_id VARCHAR(191) NOT NULL,
  task_id VARCHAR(191) NULL,
  type VARCHAR(64) NOT NULL,
  message VARCHAR(500) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY rd_notif_recipient_read_idx (recipient_id, is_read),
  KEY rd_notif_recipient_created_idx (recipient_id, created_at),
  CONSTRAINT rd_notif_recipient_fk FOREIGN KEY (recipient_id) REFERENCES rd_users(id) ON DELETE CASCADE,
  CONSTRAINT rd_notif_task_fk FOREIGN KEY (task_id) REFERENCES rd_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_attachments (
  id VARCHAR(191) NOT NULL,
  task_id VARCHAR(191) NOT NULL,
  uploaded_by_id VARCHAR(191) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY rd_attachments_storage_uq (storage_key),
  KEY rd_attachments_task_idx (task_id),
  CONSTRAINT rd_attachments_task_fk FOREIGN KEY (task_id) REFERENCES rd_tasks(id) ON DELETE CASCADE,
  CONSTRAINT rd_attachments_user_fk FOREIGN KEY (uploaded_by_id) REFERENCES rd_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rd_sequences (
  name VARCHAR(50) NOT NULL,
  value INT NOT NULL DEFAULT 0,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin user is seeded by the API / bootstrap script (bcrypt hash), not raw SQL.
