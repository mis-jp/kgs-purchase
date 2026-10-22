# KelinConnect Inventory — Database & Build Specification

Version 1.1 · 2026-10-21 (§6, §7, §8 now describe what is built; only §5 SQL still has to be run by a person)
Folder: `C:\Kelin HRIS\hris3\acu\KGS-PURCHASE\app\api\flutter-kelinconnect-inventory`
Production API base: `http://190.92.233.232/kgs-purchase/api/flutter-kelinconnect-inventory`

This file is the single source of truth for building the **KelinConnect Inventory** (the "Inventory" card in the KelinConnect Flutter app).
It is written so a person or an AI assistant can create the database and code exactly as intended.

---

## 0. How to use this file (read first)

Do the steps in this order. Do not skip ahead.

| Step | What | Section |
|------|------|---------|
| 1 | Read the boundaries (what must never be touched) | §2 |
| 2 | Create the database `db_kc_inventory` and grant access | §5.1 |
| 3 | Run the table SQL (all tables, in order) | §5.3 |
| 4 | Run the seed SQL (units, reason codes, settings) | §5.4 |
| 5 | Run the import SQL (branches, categories, products) | §5.5 |
| 6 | Add the environment variables on the server | §4.3 |
| 7 | Make yourself admin (env `KC_INVENTORY_ADMIN_LOGIN_IDS`) | §4.2 |
| 8 | Go live one pilot branch (opening balance) | §5.6 |
| 9 | Build / update the API routes | §7 |
| 10 | Build / update the Flutter screens | §8 |
| 11 | Run the verification checklist | §10 |

When asking an AI to do a step, give it this file plus the files listed for that step in **§11 Reference index**.

Assumptions:
- MySQL **8.0.16 or newer** (needed for `CHECK` constraints, `JSON`, `DATETIME(3)`). On 5.7 the `CHECK` lines are ignored — enforce them in code instead.
- The same MySQL server and user that KGS-Purchase already uses (`MYSQL_HOST`, `MYSQL_USER`, …).
- Server code is Next.js 16 JavaScript route handlers (same style as the files already in this folder).

---

## 1. Why this Inventory is different

Three systems now touch "inventory". Each has one job. The KelinConnect Inventory must not copy the other two.

| | KGS-Purchase web (Next.js pages) | KelinConnect CMS (Product Database) | **KelinConnect Inventory (this)** |
|---|---|---|---|
| Who uses it | Purchasing team on desktop | Content / product team | Branch staff, warehouse, managers on phone |
| Purpose | Plan what to buy | Describe products (photos, brochures, specs) | Run the stock on the floor and prove where every unit went |
| Data source | Acumatica sync → `forecast_item_stock`, sales, POs | `product_inventory_*` tables | **Its own ledger** in `db_kc_inventory` |
| Main features | Forecast, replenishment, purchase orders, incoming PO, suppliers, sales analytics, ERP sync | Catalog, media, brochures, documents | Receive, release, branch transfers, physical counts (blind), adjustments with approval, discrepancy cases, bin locations, barcode lookup, alerts, audit trail, ERP comparison |
| Writes stock? | No (Acumatica owns it) | No | **Yes — only to its own tables** |

### Features unique to KelinConnect Inventory

1. **All Branches + branch dropdown** on every screen (dashboard, list, reports).
2. **Live stock ledger**: every unit change is a transaction with who / when / why / before / after.
3. **Receive stock** (supplier delivery, return from customer) with reference number and photo of the delivery receipt.
4. **Release stock** (sale, internal use, damaged, disposal) — cannot go below zero.
5. **Branch-to-branch transfers** with statuses Draft → Pending approval → Approved → In transit → Received, and automatic variance if fewer units arrive.
6. **Physical counts** with progress, quick "Matches / Missing / Enter qty", optional **blind count** (counter does not see the system quantity — real-world best practice), and recount.
7. **Adjustments with manager approval** — no silent overwrites.
8. **Discrepancy cases** (investigation workflow with notes, findings, resolution).
9. **Bin / shelf locations** — "where is this item in this branch?"
10. **Barcode / QR lookup** (scan → item card).
11. **Alerts**: low stock, out of stock, large release, transfer overdue, repeated adjustments, count variance, ERP mismatch.
12. **ERP comparison**: app quantity vs Acumatica quantity per item and branch (read-only from Purchase).
13. **Watchlist** (pin items you monitor) and **activity feed**.
14. **Append-only audit log** that ordinary users cannot edit or delete.
15. **Reports + CSV export**: stock by branch, movements, adjustments, discrepancies, transfers, user activity.

Out of scope (owned elsewhere): purchase orders, forecasting, supplier management, prices / stock valuation, product photos and brochures (CMS).

---

## 2. Hard boundaries (must follow)

1. **Never write** to KelinConnect CMS tables: `product_inventory_items`, `product_inventory_images`, `product_inventory_attachments`, `inventory_brands`, `inventory_models`, or any other CMS catalog table. See `KGS-PURCHASE/docs` handoff and the workspace rule "KelinConnect / CMS boundary".
2. **Never write** to KGS-Purchase tables in `db_purchase` (`forecast_item_stock`, `product_periodic_sales`, POs, …) or to `db_kelin_inventory.branches`. They may only be **read** (`SELECT`) for imports and the ERP comparison.
3. **Never write** to Acumatica. This Inventory is a separate ledger.
4. All new tables live in the new database **`db_kc_inventory`** and start with **`inv_`**.
5. Stock quantities are changed **only by the server**, inside a database transaction (§6.1). The Flutter app never sends a "new balance".
6. Permissions are enforced by the server on every request, not by hiding buttons.
7. Do not store passwords or tokens in any table or log.

---

## 3. Roles and permissions

Sign-in is the user's **KelinConnect account** (no separate password). The server verifies the KelinConnect session token (see `_lib/auth.js`). The Inventory keeps its own role per user in `inv_users`.

| Action | admin | manager | staff | viewer |
|--------|:-----:|:-------:|:-----:|:------:|
| View all branches (read) | ✔ | ✔ | ✔ | ✔ |
| Receive / release stock | ✔ | assigned branches | assigned branches | ✖ |
| Create transfer | ✔ | assigned (from) branch | assigned (from) branch | ✖ |
| Approve transfer | ✔ | from-branch manager | ✖ | ✖ |
| Dispatch / receive transfer | ✔ | assigned branch | assigned branch | ✖ |
| Start / do physical count | ✔ | assigned branches | assigned branches | ✖ |
| Request adjustment | ✔ | ✔ | ✔ (from a count) | ✖ |
| Approve adjustment | ✔ | assigned branches, not own request | ✖ | ✖ |
| Discrepancy cases | ✔ all | assigned branches | view own | ✖ |
| Products / categories / locations | ✔ | locations of assigned branches | ✖ | ✖ |
| Users, roles, branch access, settings | ✔ | ✖ | ✖ | ✖ |
| Audit log | ✔ all | assigned branches | own actions | ✖ |
| Export reports | ✔ | ✔ | ✖ | ✖ |

Rules:
- A first-time KelinConnect user is auto-created in `inv_users` as **viewer**.
- `all_branches = 1` means "assigned to every branch" for write permissions.
- Nobody approves their own request.

---

## 4. Architecture, auth, environment

### 4.1 Where things live

| Part | Path |
|------|------|
| API routes (this folder) | `KGS-PURCHASE/app/api/flutter-kelinconnect-inventory/**/route.js` |
| Shared server helpers | `KGS-PURCHASE/app/api/flutter-kelinconnect-inventory/_lib/*.js` (folders starting with `_` are not routes) |
| Public-path entry (already added) | `KGS-PURCHASE/proxy.js` → `PUBLIC_PATHS` contains `/api/flutter-kelinconnect-inventory` |
| Server tests | `KGS-PURCHASE/tests/kc-inventory-*.test.js` (run with `node --test`) |
| Flutter module | `C:\product directory\hris_backup_v1\lib\branch_inventory\` |
| Flutter module card | `C:\product directory\hris_backup_v1\lib\hris\pages_shared\module_menu_page.dart` (tile "Inventory") |
| Flutter tests | `C:\product directory\hris_backup_v1\test\branch_inventory_test.dart` |

### 4.2 Authentication (already built — reuse)

`_lib/auth.js` → `requireInventoryUser(request)`:
1. Reads `Authorization: Bearer <KelinConnect JWT>`.
2. Rejects missing / malformed / expired tokens.
3. Verifies with `KC_JWT_SECRET` (HS256) if set, else asks KelinConnect (`KC_AUTH_VERIFY_URLS`) and caches the result 5 minutes.
4. Returns `{ user: { loginId, name } }`.

**To add:** after `requireInventoryUser`, load or create the row in `inv_users` and attach `role`, `allBranches`, and assigned branch ids. Bootstrap admins: any login id listed in env `KC_INVENTORY_ADMIN_LOGIN_IDS` (comma separated) is created/kept as `admin`.

### 4.3 Environment variables (server `.env.local`)

| Name | Example | Purpose |
|------|---------|---------|
| `MYSQL_KC_INVENTORY_DATABASE` | `db_kc_inventory` | New database for this Inventory |
| `MYSQL_PURCHASE_DATABASE` | `db_purchase` | Read-only source for imports / ERP comparison (already exists) |
| `MYSQL_INVENTORY_DATABASE` | `db_kelin_inventory` | Read-only source of branch names (already exists) |
| `KC_INVENTORY_ADMIN_LOGIN_IDS` | `KG0751,KG0543` | Bootstrap admins |
| `KC_JWT_SECRET` | *(KelinConnect signing secret)* | Optional, fastest token check |
| `KC_AUTH_VERIFY_URLS` | `/api/auth/session` | Optional override of KelinConnect verify endpoints |
| `KC_INVENTORY_UPLOAD_DIR` | `/var/kc-inventory-uploads` | Folder for photos / attachments (outside the web root) |

---

## 5. Database

### 5.1 Create the database

```sql
CREATE DATABASE IF NOT EXISTS db_kc_inventory
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Replace 'kgs_user'@'%' with the account in MYSQL_USER.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER
  ON db_kc_inventory.* TO 'kgs_user'@'%';
FLUSH PRIVILEGES;
```

The same user only needs `SELECT` on `db_purchase.forecast_item_stock` and `db_kelin_inventory.branches` (it already has it).

### 5.2 Conventions

- Engine InnoDB, charset `utf8mb4_unicode_ci`, all times stored in **UTC** (`DATETIME`), shown in Asia/Manila (+08:00) by the app.
- Quantities `DECIMAL(18,4)` (supports rolls, meters, liters).
- People are stored by KelinConnect **login id** (e.g. `KG0751`) plus a copy of the name at that moment.
- Document numbers: `PREFIX-YYYYMMDD-NNNN` from `inv_sequences` (§6.3).
- Every write request from the app carries a `requestId` (UUID) stored in a `request_id` UNIQUE column → retries never duplicate.

### 5.3 Tables (run in this order)

```sql
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
```

Table count: 23 tables + 4 triggers.

### 5.3.1 Where each table is used

Server files are in `_lib/` of this folder; Flutter files are in `C:\product directory\hris_backup_v1\lib\branch_inventory\`.

| Table | Written by (server) | Read by (server) | Shown in (Flutter) |
|-------|---------------------|------------------|--------------------|
| `inv_users`, `inv_user_branches` | `members.js` (first login), `admin.js` (`saveUser`) | `members.js` on every request | admin page → Users; `me` drives every button |
| `inv_branches` | `admin.js` (import, go-live sets `is_live`) | everywhere (`findBranch`) | home dropdown, Live badge, admin → Branches |
| `inv_locations` | `insights.js` (`addLocation`) | `insights.js`, `ledger-counts.js` (shelf counts) | item settings sheet, count start (shelf) |
| `inv_categories`, `inv_units`, `inv_products` | `admin.js` (import only) | items, counts, movements, scan | stock list, item page, item picker |
| `inv_product_branch_settings` | `insights.js` (`saveItemBranchSettings`) | items, alerts (`min_stock`) | item page → shelf / minimum |
| `inv_balances` | **only** `ledger.js` (quantities, reservations, in transit); `ledger-counts.js` review sets `last_counted_at` only | summary, items, ERP compare, reports | stock numbers everywhere |
| `inv_sequences` | `ledger.js` (`nextNumber`) | – | document numbers (RCV-…, TRF-…) |
| `inv_reason_codes` | seed only (§5.4) | `movements.js`, `transfers.js`, `adjustments.js` | stock form reason list |
| `inv_transactions`, `inv_transaction_lines` | `ledger.js` via movements, transfers, adjustments, go-live | movements list, item history, activity, reports | Movements, item history, Recent activity |
| `inv_transfers`, `inv_transfer_lines` | `transfers.js` | transfers, summary badges | Transfers pages |
| `inv_count_sessions`, `inv_count_lines` | `ledger-counts.js` | counts, summary | Counts pages (live branches) |
| `inv_adjustments`, `inv_adjustment_lines` | `adjustments.js`, `ledger-counts.js` (review) | approvals, reports | correction detail, Approvals |
| `inv_discrepancy_cases`, `inv_case_notes` | `cases.js`, `transfers.js` (short receive), `ledger-counts.js` (review) | cases, summary | Cases pages |
| `inv_attachments` | not built yet | – | – |
| `inv_alerts` | `ledger.js` (`raiseAlert`, called after movements, counts, transfers and the ERP check); `alerts.js` (acknowledge) | alerts, summary | Alerts page, home badge |
| `inv_watchlist` | `insights.js` (`setWatch`) | `insights.js`, item detail | item star, Watchlist page |
| `inv_settings` | seed (§5.4), `admin.js` (`saveSettings`) | `ledger.js` (`getSettings`, cached) | admin → Settings |
| `inv_audit_logs` | `audit.js` (`writeAudit`, append-only) | `insights.js` (`listAuditLogs`, user-activity report) | reports page → Audit log |
| `db_kelin_inventory.product_inventory_items` (KelinConnect CMS, **read-only**) | never | `stock.js` `getSummary` → `catalogProducts` = `COUNT(DISTINCT inventory_id)` of non-deleted rows, all-branches unfiltered view only | home → Total products card |

Notes: `GET /categories` takes the same `branch`, `search` and `status` as `GET /items`, so each category count matches the list it opens. The `catalogProducts` count needs SELECT on `db_kelin_inventory` (or `MYSQL_INVENTORY_DATABASE`) for this API's MySQL user; when it is missing, the field is `null` and the app falls back to the stocked-SKU count.

### 5.4 Seed data (run once)

```sql
USE db_kc_inventory;

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
```

### 5.5 Import master data from KGS-Purchase (read-only sources, re-runnable)

Source rules copied from `_lib/stock.js` → `baseWhere()`: skip `__catalog__` rows, skip DAMAGE / DISCOUNTED, take ecommerce warehouses only from `company_id = 'ecommerce'` and everything else only from `company_id = 'main'`.

```sql
USE db_kc_inventory;

-- 5.5.1 Branches (names from db_kelin_inventory.branches when present)
INSERT INTO inv_branches (code, name, type, erp_warehouse_id, status)
SELECT w.wh,
       COALESCE(MAX(NULLIF(TRIM(b.branch_name), '')), w.wh),
       CASE WHEN w.wh LIKE '%WAREHOUSE%' OR w.wh REGEXP '(^| )WH[0-9]*( |$)' OR w.wh LIKE '%WH1%'
            THEN 'warehouse' ELSE 'branch' END,
       w.wh,
       'active'
FROM (
  SELECT DISTINCT UPPER(TRIM(s.warehouse_id)) AS wh
  FROM db_purchase.forecast_item_stock s
  WHERE s.warehouse_id <> '__catalog__'
    AND TRIM(COALESCE(s.warehouse_id, '')) <> ''
    AND UPPER(s.warehouse_id) NOT LIKE '%DAMAGE%'
    AND UPPER(s.warehouse_id) NOT LIKE '%DISCOUNTED%'
    AND ( (s.company_id = 'ecommerce' AND UPPER(TRIM(s.warehouse_id)) IN ('ECOM','ECOMMERCE','E-COMMERCE','E COMMERCE','ECOM BRANCH'))
       OR (s.company_id = 'main'      AND UPPER(TRIM(s.warehouse_id)) NOT IN ('ECOM','ECOMMERCE','E-COMMERCE','E COMMERCE','ECOM BRANCH')) )
) w
LEFT JOIN db_kelin_inventory.branches b ON UPPER(TRIM(b.branch_id)) = w.wh
GROUP BY w.wh
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- 5.5.2 Categories (Acumatica item classes)
INSERT INTO inv_categories (code, name)
SELECT DISTINCT TRIM(item_class), TRIM(item_class)
FROM db_purchase.forecast_item_stock
WHERE TRIM(COALESCE(item_class, '')) <> ''
ON DUPLICATE KEY UPDATE name = name;

-- 5.5.3 Products (one per Acumatica inventory id)
INSERT INTO inv_products (sku, name, category_id, unit_code, erp_inventory_id, status, created_by)
SELECT s.inv,
       COALESCE(s.item_name, s.inv),
       c.id,
       'PC',
       s.inv,
       CASE WHEN LOWER(COALESCE(s.item_status, '')) = 'inactive' THEN 'inactive' ELSE 'active' END,
       'import'
FROM (
  SELECT TRIM(inventory_id) AS inv,
         MAX(NULLIF(TRIM(item_name), ''))  AS item_name,
         MAX(NULLIF(TRIM(item_class), '')) AS item_class,
         MAX(item_status)                  AS item_status
  FROM db_purchase.forecast_item_stock
  WHERE TRIM(COALESCE(inventory_id, '')) <> ''
  GROUP BY TRIM(inventory_id)
) s
LEFT JOIN inv_categories c ON c.code = s.item_class
ON DUPLICATE KEY UPDATE name = VALUES(name), category_id = VALUES(category_id), status = VALUES(status);
```

Expected result today (2026-10-21): about **48 branches**, **5,117+ products** with stock rows, ~150 categories.
Re-running is safe: it only updates names / categories / status, never balances.

### 5.6 Go live a branch (opening balance)

The ledger starts empty. A branch "goes live" once: its opening balance is copied from Acumatica (`forecast_item_stock.on_hand`) as one `opening` transaction. **After go-live, the app ledger is the branch's floor truth** and Acumatica is shown only for comparison (§1, feature 12). Start with one pilot branch.

Build this as an admin API action (`POST branches/{id}/go-live`) — preferred because it also writes the audit log. The SQL it must run (inside one transaction):

```sql
USE db_kc_inventory;
SET @branch_code = 'CALBAYOG';      -- pilot branch
SET @actor       = 'KG0751';        -- admin login id

START TRANSACTION;

SELECT id, erp_warehouse_id, live_since INTO @branch_id, @erp_wh, @live
FROM inv_branches WHERE code = @branch_code FOR UPDATE;
-- STOP if @live IS NOT NULL (already live) or if inv_balances already has rows for @branch_id.

INSERT INTO inv_transactions (txn_number, type, branch_id, status, reason_code, notes, request_id, created_by, created_by_name)
VALUES (CONCAT('OPN-', DATE_FORMAT(UTC_TIMESTAMP(), '%Y%m%d'), '-', @branch_code), 'opening', @branch_id, 'completed',
        'OPENING_BALANCE', 'Opening balance copied from Acumatica (db_purchase.forecast_item_stock)', UUID(), @actor, @actor);
SET @txn = LAST_INSERT_ID();

INSERT INTO inv_transaction_lines (transaction_id, branch_id, product_id, qty_change, qty_before, qty_after)
SELECT @txn, @branch_id, p.id, s.qty, 0, s.qty
FROM (
  SELECT TRIM(inventory_id) AS inv, SUM(GREATEST(COALESCE(on_hand, 0), 0)) AS qty
  FROM db_purchase.forecast_item_stock
  WHERE UPPER(TRIM(warehouse_id)) = @erp_wh
    AND company_id IN ('main', 'ecommerce')
  GROUP BY TRIM(inventory_id)
) s
JOIN inv_products p ON p.erp_inventory_id = s.inv
WHERE s.qty > 0;

INSERT INTO inv_balances (product_id, branch_id, qty_on_hand, last_movement_at)
SELECT product_id, branch_id, qty_after, UTC_TIMESTAMP()
FROM inv_transaction_lines WHERE transaction_id = @txn;

UPDATE inv_branches SET live_since = UTC_TIMESTAMP() WHERE id = @branch_id;

INSERT INTO inv_audit_logs (actor_login_id, actor_name, actor_role, action, entity_type, entity_id, branch_id, transaction_id, details)
VALUES (@actor, @actor, 'admin', 'branch.go_live', 'branch', @branch_id, @branch_id, @txn,
        JSON_OBJECT('lines', (SELECT COUNT(*) FROM inv_transaction_lines WHERE transaction_id = @txn)));

COMMIT;
```

Branches that are not live yet show Acumatica quantities (read-only, current behaviour) with a "Not live yet" badge.

### 5.7 Old tables from the first version

The first version created `db_purchase.kc_inventory_count_sessions` and `db_purchase.kc_inventory_count_lines` (they are empty — test data was removed). After the new count routes use `inv_count_*`, drop them:

```sql
DROP TABLE IF EXISTS db_purchase.kc_inventory_count_lines;
DROP TABLE IF EXISTS db_purchase.kc_inventory_count_sessions;
```

---

## 6. Business rules (server must implement exactly)

### 6.1 Changing stock (receive, release, transfer, adjustment)

Inside **one** DB transaction:
1. Authenticate (§4.2) and load `inv_users`; reject `inactive`.
2. Check role and branch permission (§3). On failure write `inv_audit_logs` with `outcome='denied'` and return 403.
3. Validate: product active, branch active **and live**, quantity > 0, reason code valid for the type, reference present when `requires_reference = 1`.
4. If `request_id` already exists → return the existing result (idempotent, HTTP 200).
5. `SELECT ... FROM inv_balances WHERE product_id=? AND branch_id=? FOR UPDATE` (insert a 0 row first if missing).
6. For outgoing: `qty_on_hand - qty_reserved >= qty` or return **409 "Only X available"**.
7. Insert header (`inv_transactions`) + lines with `qty_before` / `qty_after`.
8. Update `inv_balances` (`qty_on_hand`, `last_movement_at`, `version = version + 1`).
9. Write `inv_audit_logs` (`details` = before, change, after, reason, reference).
10. Evaluate alerts (§6.6). Commit. Any error → rollback.

If the reason code `requires_approval = 1`, save the header as `pending_approval` **without** touching balances; apply steps 5–9 when a manager approves.

### 6.2 Transfers

| Action | Who | Effect |
|--------|-----|--------|
| create (draft / submit) | staff+ at from-branch | status `pending_approval` |
| approve | manager of from-branch / admin (not the requester) | `approved`; `from.qty_reserved += qty_requested` |
| reject / cancel | approver / requester | `rejected` / `cancelled`; release reservation |
| dispatch | staff+ at from-branch | `transfer_out` txn: `from.qty_on_hand -= qty_sent`, `from.qty_reserved -= qty_requested`, `to.qty_in_transit += qty_sent`; status `in_transit` |
| receive | staff+ at to-branch | `transfer_in` txn: `to.qty_on_hand += qty_received`, `to.qty_in_transit -= qty_sent`; status `received`, or `partially_received` if any line differs → one `inv_discrepancy_cases` row per short line (type `transfer_short`) |

A transfer is never "received" until the destination confirms.

As built: a short arrival opens a **case only** (no automatic adjustment). The missing units already left the from-branch on dispatch and never reached the to-branch, so both balances are already correct; the case is for finding out why. A manager closes it as `resolved` (found / explained) or `written_off`.
Approve / reject / cancel need an approver of the **from**-branch (`canApprove`), and nobody approves their own request.

### 6.3 Document numbers

`UPDATE inv_sequences SET \`last_value\` = LAST_INSERT_ID(\`last_value\` + 1) WHERE name=? AND period=?` (insert the row with 0 first if missing), then format `PREFIX-YYYYMMDD-NNNN` (4 digits, Manila date). Prefixes: `RCV REL TRF ADJ CNT CASE OPN`, plus `TRO` (transfer-out movement on dispatch) and `TRI` (transfer-in movement on receive).
Code: `_lib/ledger.js` → `nextNumber(conn, prefix)`; movement prefixes are mapped in `applyMovement()`.

### 6.4 Physical counts

1. Start: choose branch (live), scope (full / category / location / selected items), blind on/off. Snapshot `system_qty` from `inv_balances` for every item in scope (items with zero stock included only when the user asks).
2. Counting: `Matches` (counted = system), `Missing` (counted = 0, is_missing = 1), or enter a quantity. In blind mode the API **does not return `system_qty`** to non-managers while the count is open.
3. Lines with a difference may get a `recount_qty` (second person). The final value is `recount_qty` when present.
4. Submit → status `submitted`; totals computed.
5. Review (manager): creates one `inv_adjustments` (source `count`, reason `PHYSICAL_COUNT`) containing only lines with a difference, plus one `inv_discrepancy_cases` per line where `|difference| > adjustment_auto_approve_units`. Status `reviewed`. Sets `inv_balances.last_counted_at`.
6. Movements that happen during an open count: the adjustment uses `counted - system_qty_at_snapshot`, applied to the current balance (never overwrite with the counted number).

As built (`_lib/ledger-counts.js`):
- Live branches use `inv_count_sessions` / `inv_count_lines`; branches that are not live yet keep the first-version counts (`_lib/counts.js`, `kc_inventory_count_*`) so counting works before go-live. The API tells them apart with `source: "ledger" | "legacy"`.
- Line filters: `all, pending, counted, matched, short, over, missing`. `counted` is what blind counters see (they cannot know short / over).
- `PUT counts/{id}/lines` while the count is `open` → staff+ save `countedQty` (audit `count.line_save`). While `submitted` → only an approver may save; the value goes to `recount_qty` (audit `count.recount`). `clear` on a submitted line removes the recount.
- `POST counts/{id}/review` (approver, not blocked by being the starter) → returns `{ count, adjustment: { id, number, autoApproved, cases } | null }`. The adjustment follows §6.5 (auto-approved when every difference is within `adjustment_auto_approve_units`).
- Cancel of an open or submitted count needs an approver.

### 6.5 Adjustments

- `|difference| <= adjustment_auto_approve_units` → auto-approved (still recorded).
- Otherwise `pending_approval`; approver must not be the requester.
- Approve → `adjustment` transaction (one line per product, `qty_change = difference`), balances updated per §6.1. If a balance would go negative, reject with 409 and explain.

### 6.6 Alerts (create once per `dedupe_key` while open)

| Type | Rule | Resolves when |
|------|------|---------------|
| low_stock | after a movement, on_hand < min_stock (branch setting → product → `low_stock_default`) and > 0 | on_hand ≥ min |
| out_of_stock | on_hand = 0 | on_hand > 0 |
| large_release | one release line > `large_release_units` | acknowledged |
| transfer_overdue | `in_transit` longer than `transfer_overdue_days` (check on list load or a scheduled job) | received |
| repeated_adjustment | ≥ `repeated_adjustment_count` approved adjustments for the same item+branch in 30 days | acknowledged |
| count_variance | a reviewed count has missing / short lines | case closed |
| erp_mismatch | ERP comparison difference > `erp_mismatch_units` (only when an admin runs the comparison) | acknowledged |

Alerts start a review — they never accuse a person.

### 6.7 ERP comparison (read-only)

For a live branch: join `inv_balances` with `db_purchase.forecast_item_stock` on `inv_products.erp_inventory_id = TRIM(inventory_id)` and `inv_branches.erp_warehouse_id = UPPER(TRIM(warehouse_id))`; show app qty, ERP qty, difference, ERP last sync. Never write either side.

### 6.8 Audit actions (minimum list)

`auth.first_login, user.role_change, user.branch_access_change, branch.create, branch.update, branch.go_live, location.*, product.create, product.update, stock.receive, stock.release, stock.approve, stock.reject, transfer.create, transfer.approve, transfer.reject, transfer.cancel, transfer.dispatch, transfer.receive, count.start, count.line_save (batched: one row per save request), count.recount, count.submit, count.review, count.cancel, adjustment.request, adjustment.approve, adjustment.reject, case.open, case.update, case.note, case.close, alert.acknowledge, report.export, erp.compare, settings.update, admin.import, permission.denied`.

`case.note`: staff+ at the case's branch may add notes (so the people on the floor can report what they found); assigning, editing findings and closing stay with approvers. Notes on a closed case are refused (409).

---

## 7. API to build (all under `/api/flutter-kelinconnect-inventory/`)

Response shape stays `{ success: true, data }` / `{ success: false, message }` (`_lib/http.js`). All write bodies include `requestId` (UUID v4). Paging: `page`, `pageSize` (max 100).

### 7.1 Built routes (source of truth)

Every route below exists as `<path>/route.js` in this folder. "Approver" = manager or admin of that branch (`canApprove`); "staff+" = staff, manager or admin (`canOperate`). When `db_kc_inventory` is missing, ledger routes answer **503** `{ code: "LEDGER_NOT_READY" }` and the app shows a "not set up yet" banner instead of failing.

| Method | Path | Who | Body / query → response | Used in Flutter (`lib/branch_inventory/…`) |
|--------|------|-----|--------------------------|---------------------------------------------|
| GET | `health` | public | → `{ ok }` | – |
| GET | `me` | any | → `{ user:{loginId,name,role,allBranches,branches,permissions}, ledger:{ready,liveBranches,message} }` | `api.me()`; every page that shows buttons by role |
| GET | `branches` | any | → `{ branches:[{id,name,itemCount,inStockCount,onHand,lastSync,live,type}], ledgerReady }` | home branch dropdown, forms |
| GET | `summary?branch&search&category` | any | stock totals + `pendingApprovals, pendingMovements, pendingAdjustments, pendingTransfers, incomingTransfers, transfersToDispatch, openCases, newAlerts, movementsToday, liveBranches, branchLive, ledgerReady` | home cards and quick-action badges |
| GET | `categories?branch` | any | categories | home filter, count start |
| GET | `items?branch&search&category&status&page&pageSize` | any | paged stock list (ledger for live branches, Acumatica for the rest) | home list, item picker |
| GET | `items/{sku}` | any | `{ item:{…, branches[{branch,onHand,available,status,lastSync,source}], ledger:{barcode,unit,minStock,watching,branches[{branch,live,reserved,inTransit,lastCountedAt,location,minStock,maxStock}]}|null } }` | `pages/branch_inventory_item_page.dart` |
| GET | `items/{sku}/history?branch&page` | any | `{ history:[{transactionId,number,type,branch,branchName,reasonLabel,referenceNo,qtyChange,qtyBefore,qtyAfter,note,by,at}], …paging }` | item page → "Stock history" |
| PUT | `items/{sku}/settings` | approver | `{ branch, location, minStock }` → `{ ledger }` | item page → tap a live branch row |
| POST | `items/{sku}/watch` | any | `{ watching }` → `{ inventoryId, watching }` | item page star |
| GET | `watchlist` | any | `{ items }` | home → Watchlist |
| GET | `scan/{code}` | any | barcode or SKU → `{ item:{inventoryId,description,barcode,status} }` | home → Scan, item picker (Enter / handheld scanner) |
| GET | `reason-codes?type=receive\|release\|transfer\|adjustment` | any | `{ reasons:[{code,label,appliesTo,requiresApproval,requiresReference}] }` | stock form |
| POST | `stock/receive` · `stock/release` | staff+ | `{ requestId, branch, reasonCode, referenceNo, notes, lines:[{inventoryId,qty,note}] }` → `{ movement }` | `pages/branch_inventory_stock_form_page.dart` |
| GET | `movements?branch&type&status&search&from&to&page` | any | `{ movements, …paging }` | `pages/branch_inventory_documents_pages.dart` (Movements) |
| GET | `movements/{id}` · POST `movements/{id}/approve` · `/reject {reason}` | approver for actions | `{ movement }` | movement detail, Approvals |
| GET/POST | `transfers` (`status` incl. `active`, `direction=in\|out`) | staff+ at from-branch to create | create body `{ requestId, fromBranch, toBranch, reasonCode, notes, expectedArrival, lines:[{inventoryId,qty,note}] }` → `{ transfer }` | `pages/branch_inventory_transfers_page.dart` |
| GET | `transfers/{id}` | any | `{ transfer }` | transfer detail |
| POST | `transfers/{id}/approve\|reject\|cancel\|dispatch\|receive` | §6.2 | `{ reason }` or `{ lines:[{inventoryId,qty}] }` → `{ transfer }` | transfer detail buttons |
| GET/POST | `adjustments` | list any / create staff+ | `{ requestId, branch, reasonCode, notes (required), lines:[{inventoryId,countedQty,note}] }` → `{ adjustment }` | stock form "Correct stock" |
| GET | `adjustments/{id}` · POST `/approve` · `/reject {reason}` | approver, not own | `{ adjustment }` | correction detail, Approvals |
| GET/POST | `counts` | start staff+ | `{ requestId, branch, category, location, blind, includeZero, note }` → `{ count }` | `pages/branch_inventory_counts_page.dart` |
| GET | `counts/{id}?filter&search&page` | any | `{ count, lines, …paging }` (system qty hidden on open blind counts for staff) | `pages/branch_inventory_count_page.dart` |
| PUT | `counts/{id}/lines` | §6.4 | `{ lines:[{inventoryId,countedQty?,missing?,clear?,note?}] }` → `{ updated, count }` | count checklist, manager recount |
| POST | `counts/{id}/submit` · `/cancel` · `/review {notes}` | §6.4 | `{ count }` / review `{ count, adjustment }` | count page buttons ("Finish review") |
| GET | `cases?branch&status` (`active` = open + investigating) | any | `{ cases, …paging }` | `pages/branch_inventory_cases_page.dart` |
| GET/PUT | `cases/{id}` | PUT approver | PUT `{ assignedTo, findings }` → `{ case }` | case detail |
| POST | `cases/{id}/notes` · `cases/{id}/close` | notes staff+, close approver | `{ note }` / `{ resolution, findings, status: resolved\|written_off }` | case detail |
| GET | `alerts?branch&status` (default `open`) · POST `alerts/{id}/acknowledge` | staff+ to acknowledge | `{ alerts }` / `{ alert }` | Alerts page |
| GET | `activity?branch&limit` | any | `{ activity:[movement summaries] }` | home "Recent activity" |
| GET/POST | `branches/{code}/locations` | POST approver | `{ code, name, zone }` → `{ locations }` | item settings sheet, count start (shelf) |
| GET | `erp-compare?branch&onlyDifferences&search&page` | manager / admin | `{ branch, tolerance, totalItems, differences, rows[{inventoryId,description,appQty,erpQty,difference,erpLastSync}] }` | `pages/branch_inventory_reports_page.dart` (Acumatica check) |
| GET | `reports/{stock\|movements\|adjustments\|discrepancies\|transfers\|user-activity}?branch&from&to` | manager / admin | CSV file (`Content-Disposition` filename) | reports page → shared with `share_plus` |
| GET | `audit-logs?branch&action(prefix)&actor&from&to&page` | staff / viewer see only their own rows | `{ logs, …paging }` | reports page → Audit log |
| GET | `admin/users` · PUT `admin/users/{loginId}` | admin | `{ role, allBranches, branches, status }` → `{ user }` | `pages/branch_inventory_admin_page.dart` (Users) |
| GET/PUT | `admin/settings` | admin | PUT `{ values:{key:value} }` → `{ settings }` | admin page (Settings) |
| GET | `admin/branches` | admin | branches + `itemsInStock`, `locations` | admin page (Branches) |
| POST | `admin/import` | admin | re-runs §5.5 (branches, categories, products; read-only sources) → `{ import }` | admin page → "Import from Acumatica" |
| POST | `admin/branches/{code}/go-live` | admin | §5.6 opening balance → `{ goLive:{branch,openingNumber,items} }` | admin page → "Go live" |

Not built yet (planned): `attachments` (photos / receipts), product create / edit (`products`), `units`. Watch items via `items/{sku}/watch` instead of `POST/DELETE watchlist`.

### 7.2 Original plan (kept for reference)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `health` | public | ping (exists) |
| GET | `me` | any | user, role, branches, permissions flags (update existing) |
| GET | `branches` | any | branches with live status, totals (update: read `inv_branches`) |
| POST | `branches/{id}/go-live` | admin | §5.6 |
| GET/POST/PUT | `branches/{id}/locations` | manager+ | bin locations |
| GET | `categories`, `units`, `reason-codes?type=` | any | lookups |
| GET | `summary?branch&search&category` | any | dashboard (update: balances + open transfers, pending approvals, open cases, alerts) |
| GET | `items?branch&search&category&status&location&page` | any | list from `inv_balances` (live) or ERP (not live) |
| GET | `items/{productId}` | any | detail, per-branch balances, default location, last movements |
| GET | `items/{productId}/history?branch&from&to&page` | any | ledger lines |
| GET | `scan/{code}` | any | find product by barcode or SKU |
| POST/PUT | `products`, `products/{id}` | admin | create / edit / deactivate products |
| POST | `stock/receive` | staff+ | `{ requestId, branchId, reasonCode, referenceNo, notes, lines:[{productId, qty, locationId?}] }` |
| POST | `stock/release` | staff+ | same shape |
| GET | `transactions?branch&type&status&from&to&page` | staff+ | movement list |
| POST | `transactions/{id}/approve` · `/reject` | manager+ | pending receipts / releases |
| GET/POST | `transfers` | staff+ | list / create |
| GET | `transfers/{id}` | staff+ | detail |
| POST | `transfers/{id}/approve` · `/reject` · `/cancel` · `/dispatch` · `/receive` | per §6.2 | workflow |
| GET/POST | `counts` | staff+ | list / start (replace `kc_inventory_count_*` with `inv_count_*`) |
| GET | `counts/{id}` | staff+ | header + lines (hide `system_qty` when blind) |
| PUT | `counts/{id}/lines` | staff+ | batch save (exists — move to new tables) |
| POST | `counts/{id}/submit` · `/review` · `/cancel` | per §6.4 | workflow |
| GET | `adjustments?status&branch` | manager+ | approval queue |
| POST | `adjustments` | staff+ | manual request |
| POST | `adjustments/{id}/approve` · `/reject` | manager+ | §6.5 |
| GET/POST | `cases` · `cases/{id}` · `cases/{id}/notes` · `cases/{id}/close` | manager+ | investigations |
| GET | `alerts?status&branch` · POST `alerts/{id}/acknowledge` | staff+ | alerts |
| GET/POST/DELETE | `watchlist` | any | pin items |
| POST | `attachments` (multipart) · GET `attachments/{id}` | staff+ | photos / receipts (stored in `KC_INVENTORY_UPLOAD_DIR`, max 10 MB, jpg/png/pdf) |
| GET | `erp-compare?branch&onlyDifferences=1` | manager+ | §6.7 |
| GET | `reports/{name}.csv?branch&from&to` | manager+ | `stock`, `movements`, `adjustments`, `discrepancies`, `transfers`, `user-activity` |
| GET | `audit-logs?branch&product&actor&action&from&to&page` | per §3 | audit viewer |
| GET/PUT | `users`, `users/{loginId}` | admin | role, all_branches, branch access, status |
| GET/PUT | `settings` | admin | §5.4 values |

Server file layout as built (`_lib/`, not routable):
```
db.js / ledger-db.js -> getPool() (db_purchase, read-only) and getLedgerPool() / withLedgerTx() (db_kc_inventory)
members.js           -> inv_users load / first login, assertOperate / assertApprove / assertAdmin (denied -> audit + 403)
ledger.js            -> applyMovement() (the ONLY place that updates inv_balances), nextNumber(), settings cache
movements.js         -> stock in / out, approve / reject, movement list, item history
transfers.js, adjustments.js, cases.js, alerts.js, ledger-counts.js (counts on inv_count_*)
insights.js          -> activity, watchlist, scan, item settings, locations, ERP compare, audit viewer, CSV reports
admin.js             -> users, settings, branch list, master-data import, go-live
counts.js / stock.js -> first-version counts and Acumatica stock reads (used for branches that are not live)
rules.js             -> pure helpers covered by tests/kc-inventory-rules.test.js
```

---

## 8. Flutter screens (app: `C:\product directory\hris_backup_v1`)

### 8.1 Built screens (`lib/branch_inventory/`)

| File | Screens | Main API calls |
|------|---------|----------------|
| `api/branch_inventory_api.dart` | HTTP client (KelinConnect token, retries once on 401, `LEDGER_NOT_READY` message, `requestId` on writes) | all of §7.1 |
| `models/branch_inventory_models.dart` + `models/branch_inventory_ledger_models.dart` (part file) | JSON models (`InventoryMe`, movements, transfers, adjustments, cases, alerts, counts with blind / recount fields) | – |
| `pages/branch_inventory_home_page.dart` | Home hub: branch dropdown, "not set up yet" banner, Live / Not live badge, stock cards, quick actions with badges (Stock in, Stock out, Transfer, Count, Scan, Approvals, Cases, Alerts, Movements, Watchlist, Reports, Admin — each shown only when allowed), recent activity, stock list; `BranchInventoryWatchlistPage` | `me`, `summary`, `branches`, `items`, `activity`, `scan`, `watchlist` |
| `pages/branch_inventory_stock_form_page.dart` | One form for Stock in / Stock out / Transfer / Correct stock (reason, reference, lines with item picker and scanner) | `reason-codes`, `stock/*`, `transfers`, `adjustments` |
| `widgets/branch_inventory_item_picker.dart` | Search or scan an item, shows stock at the branch | `items`, `scan` |
| `pages/branch_inventory_documents_pages.dart` | Movements list, movement detail (approve / reject), correction detail, Approvals queue | `movements*`, `adjustments*`, `transfers?status=pending_approval` |
| `pages/branch_inventory_transfers_page.dart` | Transfers (Open / Coming in / Going out / All), detail with step timeline, Send and Receive sheets | `transfers*` |
| `pages/branch_inventory_cases_page.dart` | Cases list + detail (notes, assign, close), Alerts | `cases*`, `alerts*` |
| `pages/branch_inventory_item_page.dart` | Item stock per branch with shelf / min / reserved / on the way / last counted, watch star, quick Stock in / out / Correct, manager settings sheet (shelf, minimum), `BranchInventoryItemHistoryPage` | `items/{sku}`, `history`, `settings`, `watch`, `locations` |
| `pages/branch_inventory_counts_page.dart` | Counts list (In progress / Waiting for review / History), start sheet with shelf and blind options on live branches | `counts`, `locations` |
| `pages/branch_inventory_count_page.dart` | Checklist; blind lines hide system qty; approvers recount and "Finish review" on submitted counts, then open the correction | `counts/{id}`, `lines`, `submit`, `review`, `cancel` |
| `pages/branch_inventory_reports_page.dart` | CSV reports (shared as files), Acumatica check, Audit log | `reports/*`, `erp-compare`, `audit-logs` |
| `pages/branch_inventory_admin_page.dart` | Branches (import, go live), Users (role, branches, active), Settings | `admin/*` |
| `test/branch_inventory_test.dart` | Model parsing, count line rules (blind, recount), permissions, cache | – |

### 8.2 Original screen plan (kept for reference)

Navigation (bottom tabs inside the Inventory module):

| Tab | Screens |
|-----|---------|
| **Home** | Branch dropdown (All Branches first) · dashboard cards (products, units, low, out, pending approvals, in-transit transfers, open cases, alerts) · quick actions (Receive, Release, Transfer, Count, Scan) · recent activity feed · watchlist |
| **Stock** | Search / category / status / location filters · list · item detail (per-branch, shelf, history, ERP qty) |
| **Moves** | Receive form · Release form · Transfers list + create + detail with status timeline (approve / dispatch / receive buttons by role) |
| **Counts** | Count list · start (scope, blind) · checklist (exists) · review screen (manager) |
| **More** | Approvals queue · Discrepancy cases · Alerts · ERP comparison · Reports (CSV share) · Audit log · Admin (users, branches, locations, settings) |

UX rules: big touch targets; every form shows the branch it affects; confirm screens show before → after quantities; success shows the document number (e.g. `REL-20261021-0007`); scan button on search fields (use the existing camera / ML Kit packages in `pubspec.yaml`); offline = read-only cached view with "last updated"; writes require a connection and use `requestId` so a retry is safe.

---

## 9. Build order (suggested phases)

Status 2026-10-21: phases 2–8 are coded (server routes in this folder, Flutter screens in §8.1). Still to do by a person: **phase 1** (run §5.1–5.5 SQL on the server, add the env vars in §4.3), then go live a pilot branch from the app (Admin → Branches → Go live) and run §10. Not built: attachments, product create / edit.

1. DB + seeds + import (§5.1–5.5).
2. `_lib/users.js`, `me`, `branches`, `items`, `summary` reading the new tables (non-live branches fall back to current ERP reads in `_lib/stock.js`).
3. Go-live (§5.6) for one pilot branch.
4. Receive / release + history + audit (§6.1).
5. Counts on new tables + review → adjustments + cases.
6. Transfers.
7. Alerts, watchlist, scan, ERP comparison.
8. Reports, audit viewer, admin screens.

---

## 10. Verification checklist

SQL checks (run after each phase):
```sql
-- Balances equal the sum of completed ledger lines (must return 0 rows)
SELECT b.product_id, b.branch_id, b.qty_on_hand, COALESCE(SUM(l.qty_change), 0) AS ledger
FROM inv_balances b
LEFT JOIN inv_transaction_lines l ON l.product_id = b.product_id AND l.branch_id = b.branch_id
LEFT JOIN inv_transactions t ON t.id = l.transaction_id AND t.status = 'completed'
WHERE l.id IS NULL OR t.id IS NOT NULL
GROUP BY b.product_id, b.branch_id, b.qty_on_hand
HAVING b.qty_on_hand <> ledger;

-- No negative stock (must return 0 rows)
SELECT * FROM inv_balances WHERE qty_on_hand < 0 OR qty_reserved < 0 OR qty_in_transit < 0;

-- Audit log is append-only (must fail with 'append-only')
UPDATE inv_audit_logs SET action = 'x' WHERE id = 1;
```

Functional checks:
- All Branches shows every branch; picking one shows only that branch; dashboard totals change.
- Release more than available → 409 with "Only X available"; balance unchanged.
- Same `requestId` sent twice → one transaction.
- Two releases at the same time on the last units → only one succeeds.
- Transfer: stock leaves on dispatch, arrives only on receive; short arrival creates adjustment + case.
- Blind count hides system qty for staff until submitted.
- Staff cannot approve; manager cannot approve own request; viewer cannot write (403 + audit `denied`).
- Nothing was written to `db_purchase`, `db_kelin_inventory`, or `product_inventory_*` (check row counts / `UPDATE_TIME` before and after).
- Flutter: offline shows cached data with time; writes show a clear "needs connection" message.

---

## 11. Reference index (give these to the AI with the matching step)

| Topic | File (and lines) | Why |
|-------|------------------|-----|
| Original requirements | `KGS-PURCHASE/docs/INVENTORY.md` (§3 roles, §4 features, §5 audit, §6 discrepancies, §8 tables, §13 transaction rules, §18 tests) | Business requirements this spec implements |
| API rules for Flutter | `KGS-PURCHASE/docs/FLUTTER-INVENTORY-API.md` | Error handling (401/429/503), no direct DB from app |
| This spec | `app/api/flutter-kelinconnect-inventory/INVENTORY-DATABASE-SPEC.md` | Source of truth |
| KelinConnect token check | `app/api/flutter-kelinconnect-inventory/_lib/auth.js` | Reuse `requireInventoryUser` |
| Response helpers | `_lib/http.js`, `_lib/errors.js` | `ok`, `fail`, `HttpError`, `preflight` |
| Current DB pool | `_lib/db.js` | Pattern for the new `getInventoryPool()` |
| Current ERP stock reads + filters | `_lib/stock.js` → `baseWhere()`, `listItems()`, `getItem()` | Branch / company / DAMAGE rules; fallback for non-live branches |
| Current counts (to migrate) | `_lib/counts.js` | Line state logic (`LINE_STATE_SQL`), batch save, totals |
| Current routes | `health/`, `me/`, `branches/`, `summary/`, `categories/`, `items/`, `items/[inventoryId]/`, `counts/**` `route.js` | Route style: `runtime="nodejs"`, `await params` (Next 16) |
| Public path | `KGS-PURCHASE/proxy.js` → `PUBLIC_PATHS` | Already contains this API prefix |
| Acumatica stock table | `KGS-PURCHASE/migrations/017_forecast_item_stock.sql`; `services/mysql.js` ≈ line 7330 `ensureForecastItemStockTable` | Columns used by imports and ERP comparison |
| Branch names source | `services/mysql.js` ≈ line 3046 `getMasterBranches` (table `branches` in `MYSQL_INVENTORY_DATABASE`) | Branch name import |
| Branch / company rules | `KGS-PURCHASE/lib/companies.js` lines 25–46 (`ECOM_BRANCH_ALIASES`, `EXCLUDED_BRANCH_KEYWORDS`), `isEcomBranchAlias`, `resolveCompanyIdForBranch` | Same exclusions as the web app |
| Server auth test example | `KGS-PURCHASE/tests/kc-inventory-auth.test.js` | `node --test` style |
| Flutter API client | `hris_backup_v1/lib/branch_inventory/api/branch_inventory_api.dart` | KelinConnect JWT, error messages, base URL `KC_INVENTORY_API_BASE` |
| Flutter models | `hris_backup_v1/lib/branch_inventory/models/branch_inventory_models.dart` | JSON parsing style |
| Flutter pages / widgets | `hris_backup_v1/lib/branch_inventory/pages/*.dart`, `widgets/branch_inventory_widgets.dart` | Existing UI to extend |
| Module card | `hris_backup_v1/lib/hris/pages_shared/module_menu_page.dart` (tile "Inventory", `_openBranchInventory`) | Entry point |
| App design tokens | `hris_backup_v1/lib/hris/theme/hris_design.dart`, `lib/hris/widgets/hris_app_bar.dart`, `lib/shared/l10n/translated_text.dart` | Colors, cards, app bar, translated `Text` (import Flutter with `hide Text`) |
| KelinConnect session in app | `hris_backup_v1/lib/hris/api/api_service.dart` (`resolvedPayrollSessionToken`, `syncPayrollApiSessionToLoginData`) | Token used as Bearer |
| Boundaries | `hris_backup_v1/.cursor/rules/kelinconnect-cms-readonly-boundary.mdc`, `product-directory-api-location.mdc`; `hris_backup_v1/docs/superpowers/specs/KGS-PURCHASE-PRODUCT-INVENTORY-ITEMS-HANDOFF-2026-09-16.md` | What must never be written |
| Previous design note | `hris_backup_v1/docs/superpowers/specs/2026-10-21-branch-inventory-design.md` | Version 1 (read-only ERP view + counts) |

Prompt template for the AI:
> "Use `INVENTORY-DATABASE-SPEC.md` as the source of truth. Do step N (§x). Read these files first: … (from §11). Follow §2 boundaries. Do not change anything outside the listed files. Show me the SQL / code and how to verify it with §10."
