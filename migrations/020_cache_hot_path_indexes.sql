-- Migration 020: Indexes for the hot reads that refill caches after a write
-- (Product Directory browse, Stock Items KPIs, inventory row counts).
-- Compatible with existing data. Safe to re-run: every ALTER checks
-- information_schema first and skips tables that do not exist yet.
-- Uses online DDL (ALGORITHM=INPLACE, LOCK=NONE) so reads and writes continue.
-- Run with a short lock_wait_timeout so an ALTER that cannot get its metadata
-- lock gives up instead of queueing every other query behind it.
SET SESSION lock_wait_timeout = 5;

-- Inventory DB: Product Directory (KC CMS) browse tree
USE `db_kelin_inventory`;

-- listItemClasses: WHERE is_active=1 AND category_id=? ORDER BY sort_order, name
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_item_classes');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_item_classes' AND INDEX_NAME = 'idx_kcic_category_active_sort');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE kc_item_classes ADD INDEX idx_kcic_category_active_sort (category_id, is_active, sort_order), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- listFolders: WHERE is_active=1 AND item_class_id=? AND parent_id <=> ? ORDER BY sort_order, name
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_folders');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_folders' AND INDEX_NAME = 'idx_kcf_class_parent_active_sort');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE kc_folders ADD INDEX idx_kcf_class_parent_active_sort (item_class_id, parent_id, is_active, sort_order), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- per-folder child count: SELECT COUNT(*) FROM kc_folders WHERE is_active=1 AND parent_id=?
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_folders' AND INDEX_NAME = 'idx_kcf_parent_active');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE kc_folders ADD INDEX idx_kcf_parent_active (parent_id, is_active), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- listProducts + per-folder child count:
--   WHERE is_active=1 AND folder_id=? ORDER BY sort_order, name
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_products');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kc_products' AND INDEX_NAME = 'idx_kcp_folder_active_sort');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE kc_products ADD INDEX idx_kcp_folder_active_sort (folder_id, is_active, sort_order), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Purchase DB: forecast_item_stock (Stock Items / Inventory counts and KPIs)
USE `db_purchase`;

-- countWarehouseRows / countCatalogRows:
--   WHERE company_id = ? AND warehouse_id != '__catalog__'   (and = '__catalog__')
-- Stock Items KPI: SUM(on_hand) WHERE company_id = ? AND warehouse_id != '__catalog__'
--   [AND UPPER(TRIM(warehouse_id)) IN (...)]
-- Stock Items / Inventory catalog page:
--   WHERE company_id = ? AND warehouse_id = '__catalog__' ORDER BY inventory_id LIMIT ...
-- The PK (company_id, inventory_id, warehouse_id) cannot seek on warehouse_id, so
-- these read every clustered row for the company. This index seeks straight to the
-- catalog or warehouse rows, returns them already sorted by inventory_id, and
-- answers the counts and the on-hand sum without touching the table rows.
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'forecast_item_stock');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'forecast_item_stock' AND INDEX_NAME = 'idx_fis_company_wh_inv');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE forecast_item_stock ADD INDEX idx_fis_company_wh_inv (company_id, warehouse_id, inventory_id, on_hand), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Syncing Center history: SELECT ... FROM sync_logs ORDER BY timestamp DESC LIMIT ?
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_logs');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_logs' AND INDEX_NAME = 'idx_sync_logs_timestamp');
SET @sql := IF(@tbl = 1 AND @idx = 0,
  'ALTER TABLE sync_logs ADD INDEX idx_sync_logs_timestamp (`timestamp`), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
