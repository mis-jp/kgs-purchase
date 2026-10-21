-- 021: KelinConnect Inventory ledger database (db_kc_inventory, tables inv_*)
-- Source of truth: app/api/flutter-kelinconnect-inventory/INVENTORY-DATABASE-SPEC.md §5.1, §5.3, §5.4.
-- New database only. Nothing in db_purchase, db_kelin_inventory or Acumatica is written.
-- Run with the mysql client (uses DELIMITER for the append-only triggers). Run once.

CREATE DATABASE IF NOT EXISTS db_kc_inventory
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE db_kc_inventory;

-- 1. Users of the Inventory (KelinConnect accounts) -----------------------
CREATE TABLE inv_users (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  login_id         VARCHAR(50)  NOT NULL,
  full_name        VARCHAR(160) NULL,
  email            VARCHAR(190) NULL,
  role             ENUM('admin','manager','staff','viewer') NOT NULL DEFAULT 'viewer',
  all_branches     TINYINT(1)   NOT NULL DEFAULT 0,
  status           ENUM('active','inactive') NOT NULL DEFAULT 'active',
  last_seen_at     DATETIME     NULL,
  created_by       VARCHAR(50)  NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_users_login (login_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Branches / warehouses ---------------------------------------------------
CREATE TABLE inv_branches (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code              VARCHAR(50)  NOT NULL,
  name              VARCHAR(150) NOT NULL,
  type              ENUM('branch','warehouse','office','other') NOT NULL DEFAULT 'branch',
  address           VARCHAR(255) NULL,
  contact           VARCHAR(100) NULL,
  manager_login_id  VARCHAR(50)  NULL,
  erp_warehouse_id  VARCHAR(100) NULL,
  live_since        DATETIME     NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_branches_code (code),
  UNIQUE KEY uq_inv_branches_erp (erp_warehouse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Which branches a user may write to ------------------------------------
CREATE TABLE inv_user_branches (
  user_id    INT UNSIGNED NOT NULL,
  branch_id  INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, branch_id),
  CONSTRAINT fk_iub_user   FOREIGN KEY (user_id)   REFERENCES inv_users(id),
  CONSTRAINT fk_iub_branch FOREIGN KEY (branch_id) REFERENCES inv_branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Bin / shelf locations inside a branch ---------------------------------
CREATE TABLE inv_locations (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  branch_id   INT UNSIGNED NOT NULL,
  code        VARCHAR(50)  NOT NULL,          -- e.g. A-01-03 (zone-rack-shelf)
  name        VARCHAR(120) NULL,
  zone        VARCHAR(50)  NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_locations (branch_id, code),
  CONSTRAINT fk_il_branch FOREIGN KEY (branch_id) REFERENCES inv_branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Categories ---------------------------------------------------------------
CREATE TABLE inv_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(100) NOT NULL,          -- = Acumatica item class on import
  name        VARCHAR(150) NOT NULL,
  parent_id   INT UNSIGNED NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_categories_code (code),
  CONSTRAINT fk_ic_parent FOREIGN KEY (parent_id) REFERENCES inv_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Units of measure -------------------------------------------------------
CREATE TABLE inv_units (
  code            VARCHAR(20) NOT NULL,
  name            VARCHAR(60) NOT NULL,
  allows_decimal  TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Products -----------------------------------------------------------------
CREATE TABLE inv_products (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  sku               VARCHAR(100)  NOT NULL,
  barcode           VARCHAR(100)  NULL,
  name              VARCHAR(255)  NOT NULL,
  description       TEXT          NULL,
  category_id       INT UNSIGNED  NULL,
  unit_code         VARCHAR(20)   NOT NULL DEFAULT 'PC',
  min_stock         DECIMAL(18,4) NOT NULL DEFAULT 0,
  reorder_qty       DECIMAL(18,4) NULL,
  erp_inventory_id  VARCHAR(100)  NULL,
  photo_url         VARCHAR(500)  NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by        VARCHAR(50)   NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_products_sku (sku),
  UNIQUE KEY uq_inv_products_barcode (barcode),
  UNIQUE KEY uq_inv_products_erp (erp_inventory_id),
  KEY idx_inv_products_category (category_id),
  KEY idx_inv_products_name (name),
  CONSTRAINT fk_ip_category FOREIGN KEY (category_id) REFERENCES inv_categories(id),
  CONSTRAINT fk_ip_unit     FOREIGN KEY (unit_code)   REFERENCES inv_units(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Per-branch product settings (thresholds, default shelf) ---------------
CREATE TABLE inv_product_branch_settings (
  product_id           INT UNSIGNED  NOT NULL,
  branch_id            INT UNSIGNED  NOT NULL,
  min_stock            DECIMAL(18,4) NULL,     -- overrides inv_products.min_stock
  max_stock            DECIMAL(18,4) NULL,
  default_location_id  INT UNSIGNED  NULL,
  updated_by           VARCHAR(50)   NULL,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, branch_id),
  CONSTRAINT fk_ipbs_product  FOREIGN KEY (product_id)          REFERENCES inv_products(id),
  CONSTRAINT fk_ipbs_branch   FOREIGN KEY (branch_id)           REFERENCES inv_branches(id),
  CONSTRAINT fk_ipbs_location FOREIGN KEY (default_location_id) REFERENCES inv_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Current balance: ONE row per product per branch ----------------------
CREATE TABLE inv_balances (
  product_id        INT UNSIGNED  NOT NULL,
  branch_id         INT UNSIGNED  NOT NULL,
  qty_on_hand       DECIMAL(18,4) NOT NULL DEFAULT 0,
  qty_reserved      DECIMAL(18,4) NOT NULL DEFAULT 0,  -- approved transfers not yet dispatched
  qty_in_transit    DECIMAL(18,4) NOT NULL DEFAULT 0,  -- dispatched TO this branch, not yet received
  last_movement_at  DATETIME      NULL,
  last_counted_at   DATETIME      NULL,
  version           INT UNSIGNED  NOT NULL DEFAULT 0,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, branch_id),
  KEY idx_inv_balances_branch (branch_id),
  CONSTRAINT fk_ib_product FOREIGN KEY (product_id) REFERENCES inv_products(id),
  CONSTRAINT fk_ib_branch  FOREIGN KEY (branch_id)  REFERENCES inv_branches(id),
  CONSTRAINT ck_ib_nonneg  CHECK (qty_on_hand >= 0 AND qty_reserved >= 0 AND qty_in_transit >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Document number counters ---------------------------------------------
CREATE TABLE inv_sequences (
  name        VARCHAR(10) NOT NULL,    -- RCV, REL, TRF, ADJ, CNT, CASE, OPN
  period      CHAR(8)     NOT NULL,    -- YYYYMMDD
  `last_value` INT UNSIGNED NOT NULL DEFAULT 0,  -- LAST_VALUE is a reserved word in MySQL 8: always quote
  PRIMARY KEY (name, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Reason codes ------------------------------------------------------------
CREATE TABLE inv_reason_codes (
  code               VARCHAR(40)  NOT NULL,
  applies_to         ENUM('receive','release','transfer','adjustment','opening') NOT NULL,
  label              VARCHAR(120) NOT NULL,
  requires_approval  TINYINT(1)   NOT NULL DEFAULT 0,
  requires_reference TINYINT(1)   NOT NULL DEFAULT 0,
  active             TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order         INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Transfers between branches -------------------------------------------
CREATE TABLE inv_transfers (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_number   VARCHAR(30)  NOT NULL,
  from_branch_id    INT UNSIGNED NOT NULL,
  to_branch_id      INT UNSIGNED NOT NULL,
  status            ENUM('draft','pending_approval','approved','in_transit','received','partially_received','rejected','cancelled') NOT NULL DEFAULT 'draft',
  reason_code       VARCHAR(40)  NULL,
  notes             VARCHAR(1000) NULL,
  expected_arrival  DATE         NULL,
  request_id        CHAR(36)     NOT NULL,
  requested_by      VARCHAR(50)  NOT NULL,
  requested_by_name VARCHAR(160) NULL,
  approved_by       VARCHAR(50)  NULL,
  dispatched_by     VARCHAR(50)  NULL,
  received_by       VARCHAR(50)  NULL,
  rejection_reason  VARCHAR(500) NULL,
  requested_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME     NULL,
  dispatched_at     DATETIME     NULL,
  received_at       DATETIME     NULL,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_transfers_number (transfer_number),
  UNIQUE KEY uq_inv_transfers_request (request_id),
  KEY idx_inv_transfers_from (from_branch_id, status),
  KEY idx_inv_transfers_to (to_branch_id, status),
  CONSTRAINT fk_it_from   FOREIGN KEY (from_branch_id) REFERENCES inv_branches(id),
  CONSTRAINT fk_it_to     FOREIGN KEY (to_branch_id)   REFERENCES inv_branches(id),
  CONSTRAINT fk_it_reason FOREIGN KEY (reason_code)    REFERENCES inv_reason_codes(code),
  CONSTRAINT ck_it_branches CHECK (from_branch_id <> to_branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inv_transfer_lines (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  transfer_id    INT UNSIGNED  NOT NULL,
  product_id     INT UNSIGNED  NOT NULL,
  qty_requested  DECIMAL(18,4) NOT NULL,
  qty_sent       DECIMAL(18,4) NULL,
  qty_received   DECIMAL(18,4) NULL,
  note           VARCHAR(500)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_transfer_lines (transfer_id, product_id),
  CONSTRAINT fk_itl_transfer FOREIGN KEY (transfer_id) REFERENCES inv_transfers(id),
  CONSTRAINT fk_itl_product  FOREIGN KEY (product_id)  REFERENCES inv_products(id),
  CONSTRAINT ck_itl_qty CHECK (qty_requested > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Physical counts --------------------------------------------------------
CREATE TABLE inv_count_sessions (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  count_number       VARCHAR(30)  NOT NULL,
  branch_id          INT UNSIGNED NOT NULL,
  scope              ENUM('full','category','location','selected') NOT NULL DEFAULT 'full',
  category_id        INT UNSIGNED NULL,
  location_id        INT UNSIGNED NULL,
  blind              TINYINT(1)   NOT NULL DEFAULT 0,  -- hide system qty from counters
  status             ENUM('open','submitted','reviewed','cancelled') NOT NULL DEFAULT 'open',
  note               VARCHAR(500) NULL,
  assigned_to        VARCHAR(50)  NULL,
  started_by         VARCHAR(50)  NOT NULL,
  started_by_name    VARCHAR(160) NULL,
  submitted_by       VARCHAR(50)  NULL,
  reviewed_by        VARCHAR(50)  NULL,
  item_count         INT NOT NULL DEFAULT 0,
  counted_count      INT NOT NULL DEFAULT 0,
  matched_count      INT NOT NULL DEFAULT 0,
  short_count        INT NOT NULL DEFAULT 0,
  over_count         INT NOT NULL DEFAULT 0,
  missing_count      INT NOT NULL DEFAULT 0,
  request_id         CHAR(36)     NOT NULL,
  started_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at       DATETIME     NULL,
  reviewed_at        DATETIME     NULL,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_count_number (count_number),
  UNIQUE KEY uq_inv_count_request (request_id),
  KEY idx_inv_count_branch (branch_id, status),
  CONSTRAINT fk_ics_branch   FOREIGN KEY (branch_id)   REFERENCES inv_branches(id),
  CONSTRAINT fk_ics_category FOREIGN KEY (category_id) REFERENCES inv_categories(id),
  CONSTRAINT fk_ics_location FOREIGN KEY (location_id) REFERENCES inv_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inv_count_lines (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  count_id      INT UNSIGNED  NOT NULL,
  product_id    INT UNSIGNED  NOT NULL,
  location_id   INT UNSIGNED  NULL,
  system_qty    DECIMAL(18,4) NOT NULL DEFAULT 0,   -- snapshot when the count started
  counted_qty   DECIMAL(18,4) NULL,
  recount_qty   DECIMAL(18,4) NULL,                 -- optional second count
  is_missing    TINYINT(1)    NOT NULL DEFAULT 0,
  note          VARCHAR(500)  NULL,
  counted_by    VARCHAR(50)   NULL,
  counted_by_name VARCHAR(160) NULL,
  counted_at    DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_count_lines (count_id, product_id),
  CONSTRAINT fk_icl_count    FOREIGN KEY (count_id)    REFERENCES inv_count_sessions(id),
  CONSTRAINT fk_icl_product  FOREIGN KEY (product_id)  REFERENCES inv_products(id),
  CONSTRAINT fk_icl_location FOREIGN KEY (location_id) REFERENCES inv_locations(id),
  CONSTRAINT ck_icl_qty CHECK (counted_qty IS NULL OR counted_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Adjustments (corrections that need approval) -------------------------
CREATE TABLE inv_adjustments (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  adjustment_number  VARCHAR(30)  NOT NULL,
  branch_id          INT UNSIGNED NOT NULL,
  source             ENUM('count','manual','transfer_variance') NOT NULL,
  count_id           INT UNSIGNED NULL,
  transfer_id        INT UNSIGNED NULL,
  status             ENUM('pending_approval','approved','rejected','cancelled') NOT NULL DEFAULT 'pending_approval',
  reason_code        VARCHAR(40)  NOT NULL,
  notes              VARCHAR(1000) NULL,
  request_id         CHAR(36)     NOT NULL,
  requested_by       VARCHAR(50)  NOT NULL,
  requested_by_name  VARCHAR(160) NULL,
  approved_by        VARCHAR(50)  NULL,
  rejection_reason   VARCHAR(500) NULL,
  transaction_id     BIGINT UNSIGNED NULL,          -- set when approved
  requested_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at         DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_adj_number (adjustment_number),
  UNIQUE KEY uq_inv_adj_request (request_id),
  KEY idx_inv_adj_branch (branch_id, status),
  CONSTRAINT fk_ia_branch   FOREIGN KEY (branch_id)   REFERENCES inv_branches(id),
  CONSTRAINT fk_ia_count    FOREIGN KEY (count_id)    REFERENCES inv_count_sessions(id),
  CONSTRAINT fk_ia_transfer FOREIGN KEY (transfer_id) REFERENCES inv_transfers(id),
  CONSTRAINT fk_ia_reason   FOREIGN KEY (reason_code) REFERENCES inv_reason_codes(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inv_adjustment_lines (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  adjustment_id  INT UNSIGNED  NOT NULL,
  product_id     INT UNSIGNED  NOT NULL,
  system_qty     DECIMAL(18,4) NOT NULL,
  counted_qty    DECIMAL(18,4) NOT NULL,
  difference     DECIMAL(18,4) NOT NULL,            -- counted - system
  note           VARCHAR(500)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_adj_lines (adjustment_id, product_id),
  CONSTRAINT fk_ial_adj     FOREIGN KEY (adjustment_id) REFERENCES inv_adjustments(id),
  CONSTRAINT fk_ial_product FOREIGN KEY (product_id)    REFERENCES inv_products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Stock ledger (every unit change) -------------------------------------
CREATE TABLE inv_transactions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  txn_number        VARCHAR(30)  NOT NULL,
  type              ENUM('opening','receive','release','transfer_out','transfer_in','adjustment') NOT NULL,
  branch_id         INT UNSIGNED NOT NULL,
  status            ENUM('completed','pending_approval','rejected','cancelled') NOT NULL DEFAULT 'completed',
  reason_code       VARCHAR(40)  NULL,
  reference_no      VARCHAR(100) NULL,               -- DR / invoice / PO number
  notes             VARCHAR(1000) NULL,
  transfer_id       INT UNSIGNED NULL,
  adjustment_id     INT UNSIGNED NULL,
  request_id        CHAR(36)     NOT NULL,
  created_by        VARCHAR(50)  NOT NULL,
  created_by_name   VARCHAR(160) NULL,
  approved_by       VARCHAR(50)  NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_txn_number (txn_number),
  UNIQUE KEY uq_inv_txn_request (request_id),
  KEY idx_inv_txn_branch_time (branch_id, created_at),
  KEY idx_inv_txn_type_time (type, created_at),
  CONSTRAINT fk_itx_branch   FOREIGN KEY (branch_id)     REFERENCES inv_branches(id),
  CONSTRAINT fk_itx_reason   FOREIGN KEY (reason_code)   REFERENCES inv_reason_codes(code),
  CONSTRAINT fk_itx_transfer FOREIGN KEY (transfer_id)   REFERENCES inv_transfers(id),
  CONSTRAINT fk_itx_adj      FOREIGN KEY (adjustment_id) REFERENCES inv_adjustments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inv_transaction_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_id  BIGINT UNSIGNED NOT NULL,
  branch_id       INT UNSIGNED    NOT NULL,          -- copy of header, for fast history
  product_id      INT UNSIGNED    NOT NULL,
  location_id     INT UNSIGNED    NULL,
  qty_change      DECIMAL(18,4)   NOT NULL,          -- + in, - out
  qty_before      DECIMAL(18,4)   NULL,              -- filled when completed
  qty_after       DECIMAL(18,4)   NULL,
  note            VARCHAR(500)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_txl_product (product_id, branch_id, created_at),
  KEY idx_inv_txl_txn (transaction_id),
  CONSTRAINT fk_itl2_txn      FOREIGN KEY (transaction_id) REFERENCES inv_transactions(id),
  CONSTRAINT fk_itl2_branch   FOREIGN KEY (branch_id)      REFERENCES inv_branches(id),
  CONSTRAINT fk_itl2_product  FOREIGN KEY (product_id)     REFERENCES inv_products(id),
  CONSTRAINT fk_itl2_location FOREIGN KEY (location_id)    REFERENCES inv_locations(id),
  CONSTRAINT ck_itl2_nonzero  CHECK (qty_change <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE inv_adjustments
  ADD CONSTRAINT fk_ia_txn FOREIGN KEY (transaction_id) REFERENCES inv_transactions(id);

-- 16. Discrepancy cases (investigations) -----------------------------------
CREATE TABLE inv_discrepancy_cases (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  case_number    VARCHAR(30)   NOT NULL,
  branch_id      INT UNSIGNED  NOT NULL,
  product_id     INT UNSIGNED  NOT NULL,
  source         ENUM('count','transfer','alert','manual') NOT NULL,
  source_id      INT UNSIGNED  NULL,
  expected_qty   DECIMAL(18,4) NOT NULL,
  physical_qty   DECIMAL(18,4) NOT NULL,
  difference     DECIMAL(18,4) NOT NULL,
  status         ENUM('open','investigating','resolved','written_off','closed') NOT NULL DEFAULT 'open',
  resolution     ENUM('found','miscount','damaged','supplier_short','data_error','theft_suspected','other') NULL,
  findings       TEXT          NULL,
  assigned_to    VARCHAR(50)   NULL,
  opened_by      VARCHAR(50)   NOT NULL,
  closed_by      VARCHAR(50)   NULL,
  opened_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at      DATETIME      NULL,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_case_number (case_number),
  KEY idx_inv_case_branch (branch_id, status),
  KEY idx_inv_case_product (product_id),
  CONSTRAINT fk_idc_branch  FOREIGN KEY (branch_id)  REFERENCES inv_branches(id),
  CONSTRAINT fk_idc_product FOREIGN KEY (product_id) REFERENCES inv_products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inv_case_notes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id     INT UNSIGNED NOT NULL,
  author      VARCHAR(50)  NOT NULL,
  author_name VARCHAR(160) NULL,
  note        TEXT         NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_case_notes (case_id),
  CONSTRAINT fk_icn_case FOREIGN KEY (case_id) REFERENCES inv_discrepancy_cases(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. Attachments (delivery receipts, damage photos) -----------------------
CREATE TABLE inv_attachments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type  ENUM('transaction','transfer','count','adjustment','case','product') NOT NULL,
  entity_id    BIGINT UNSIGNED NOT NULL,
  file_path    VARCHAR(500) NOT NULL,       -- relative to KC_INVENTORY_UPLOAD_DIR
  file_name    VARCHAR(255) NOT NULL,
  mime_type    VARCHAR(100) NOT NULL,
  size_bytes   INT UNSIGNED NOT NULL,
  uploaded_by  VARCHAR(50)  NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_attach_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. Alerts ------------------------------------------------------------------
CREATE TABLE inv_alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type            ENUM('low_stock','out_of_stock','large_release','transfer_overdue','repeated_adjustment','count_variance','erp_mismatch') NOT NULL,
  severity        ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  branch_id       INT UNSIGNED NULL,
  product_id      INT UNSIGNED NULL,
  entity_type     VARCHAR(30)  NULL,
  entity_id       BIGINT UNSIGNED NULL,
  message         VARCHAR(500) NOT NULL,
  dedupe_key      VARCHAR(190) NOT NULL,   -- e.g. low_stock:12:345 ; one open alert per key
  status          ENUM('new','acknowledged','resolved') NOT NULL DEFAULT 'new',
  acknowledged_by VARCHAR(50)  NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at DATETIME     NULL,
  resolved_at     DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_inv_alerts_open (status, branch_id, created_at),
  KEY idx_inv_alerts_dedupe (dedupe_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. Watchlist (items a user monitors) ------------------------------------
CREATE TABLE inv_watchlist (
  login_id    VARCHAR(50)  NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (login_id, product_id),
  CONSTRAINT fk_iw_product FOREIGN KEY (product_id) REFERENCES inv_products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. Settings ------------------------------------------------------------------
CREATE TABLE inv_settings (
  setting_key   VARCHAR(80)  NOT NULL,
  setting_value VARCHAR(500) NOT NULL,
  description   VARCHAR(255) NULL,
  updated_by    VARCHAR(50)  NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 21. Audit log (append-only) ----------------------------------------------
CREATE TABLE inv_audit_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_login_id  VARCHAR(50)  NOT NULL,
  actor_name      VARCHAR(160) NULL,
  actor_role      VARCHAR(20)  NULL,
  action          VARCHAR(60)  NOT NULL,      -- e.g. stock.receive, transfer.approve, user.role_change
  outcome         ENUM('success','denied','failed') NOT NULL DEFAULT 'success',
  entity_type     VARCHAR(30)  NULL,
  entity_id       VARCHAR(64)  NULL,
  branch_id       INT UNSIGNED NULL,
  product_id      INT UNSIGNED NULL,
  transaction_id  BIGINT UNSIGNED NULL,
  details         JSON         NULL,          -- before/after values, quantities, reason
  request_id      CHAR(36)     NULL,
  ip_address      VARCHAR(45)  NULL,
  user_agent      VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_inv_audit_time (occurred_at),
  KEY idx_inv_audit_actor (actor_login_id, occurred_at),
  KEY idx_inv_audit_branch (branch_id, occurred_at),
  KEY idx_inv_audit_product (product_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$
CREATE TRIGGER trg_inv_audit_no_update BEFORE UPDATE ON inv_audit_logs
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inv_audit_logs is append-only';
END$$
CREATE TRIGGER trg_inv_audit_no_delete BEFORE DELETE ON inv_audit_logs
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inv_audit_logs is append-only';
END$$
CREATE TRIGGER trg_inv_case_notes_no_update BEFORE UPDATE ON inv_case_notes
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inv_case_notes is append-only';
END$$
CREATE TRIGGER trg_inv_case_notes_no_delete BEFORE DELETE ON inv_case_notes
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inv_case_notes is append-only';
END$$
DELIMITER ;

-- Seed data (re-runnable)
INSERT INTO inv_units (code, name, allows_decimal) VALUES
  ('PC','Piece',0), ('BOX','Box',0), ('PACK','Pack',0), ('SET','Set',0),
  ('ROLL','Roll',0), ('SHEET','Sheet',0), ('M','Meter',1), ('L','Liter',1), ('KG','Kilogram',1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO inv_reason_codes (code, applies_to, label, requires_approval, requires_reference, sort_order) VALUES
  ('OPENING_BALANCE',   'opening',    'Opening balance (go-live)',        0, 0, 1),
  ('SUPPLIER_DELIVERY', 'receive',    'Supplier delivery',                0, 1, 10),
  ('CUSTOMER_RETURN',   'receive',    'Customer return',                  0, 1, 11),
  ('FOUND_STOCK',       'receive',    'Found stock (not in system)',      1, 0, 12),
  ('CUSTOMER_SALE',     'release',    'Customer sale',                    0, 1, 20),
  ('INTERNAL_USE',      'release',    'Internal use',                     0, 0, 21),
  ('DAMAGED',           'release',    'Damaged / defective',              1, 0, 22),
  ('SUPPLIER_RETURN',   'release',    'Return to supplier',               0, 1, 23),
  ('DISPOSAL',          'release',    'Approved disposal',                1, 0, 24),
  ('SAMPLE_DEMO',       'release',    'Sample / demo unit',               0, 0, 25),
  ('REPLENISHMENT',     'transfer',   'Replenish other branch',           0, 0, 30),
  ('CUSTOMER_ORDER',    'transfer',   'Customer order at other branch',   0, 1, 31),
  ('REBALANCE',         'transfer',   'Rebalance overstock',              0, 0, 32),
  ('PHYSICAL_COUNT',    'adjustment', 'Physical count correction',        1, 0, 40),
  ('DATA_ENTRY_ERROR',  'adjustment', 'Correct a wrong entry',            1, 0, 41),
  ('TRANSFER_VARIANCE', 'adjustment', 'Transfer arrived short / over',    1, 0, 42)
ON DUPLICATE KEY UPDATE label = VALUES(label);

INSERT INTO inv_settings (setting_key, setting_value, description) VALUES
  ('low_stock_default',              '10',  'Low stock below this many units when no min_stock is set'),
  ('adjustment_auto_approve_units',  '0',   'Adjustments with |difference| <= this are auto-approved (0 = always need approval)'),
  ('large_release_units',            '50',  'Alert when one release line is above this'),
  ('transfer_overdue_days',          '3',   'Alert when a transfer is in transit longer than this'),
  ('repeated_adjustment_count',      '3',   'Alert when an item is adjusted this many times in 30 days'),
  ('count_blind_default',            '0',   '1 = new counts hide the system quantity by default'),
  ('erp_mismatch_units',             '1',   'ERP comparison flags differences larger than this')
ON DUPLICATE KEY UPDATE description = VALUES(description);
