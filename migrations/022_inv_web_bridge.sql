-- Web Inventory bridge clients. New tables only. Do not ALTER existing inv_* tables.
-- Do not run this file until you mean to. It is not applied by the app.
-- Apps allowed to call /api/kc-web-inventory. The secret itself lives in server env
-- (INV_WEB_BRIDGE_SECRET). This table stores only the SHA-256 fingerprint.

CREATE TABLE IF NOT EXISTS inv_web_clients (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id        VARCHAR(40)  NOT NULL,
  name             VARCHAR(120) NOT NULL,
  status           ENUM('active','disabled') NOT NULL DEFAULT 'active',
  secret_sha256    CHAR(64)     NOT NULL,
  allowed_ips      VARCHAR(500) NULL,
  identity_mode    ENUM('employee_id','linked') NOT NULL DEFAULT 'employee_id',
  created_by       VARCHAR(50)  NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at     DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_web_clients_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only for apps whose accounts are NOT employee ids. kc-web uses identity_mode employee_id
-- and does not need a row here.
CREATE TABLE IF NOT EXISTS inv_web_identity_links (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id        VARCHAR(40)  NOT NULL,
  external_user    VARCHAR(100) NOT NULL,
  login_id         VARCHAR(50)  NOT NULL,
  status           ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_by       VARCHAR(50)  NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_web_links (client_id, external_user),
  KEY ix_inv_web_links_login (login_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed kc-web once, on the Inventory database (db_kc_inventory), after the env secret is set.
-- Replace <the secret> with INV_WEB_BRIDGE_SECRET. Do not commit the real secret.
-- allowed_ips is the production server. Add a caller IP, or use NULL, if you call the public host from a laptop.
--
-- INSERT INTO inv_web_clients (client_id, name, secret_sha256, allowed_ips, created_by)
-- VALUES ('kc-web', 'KelinConnect web', SHA2('<the secret>', 256), '127.0.0.1,190.92.233.232', 'KG0751');
