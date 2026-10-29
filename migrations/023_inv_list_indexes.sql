-- List indexes for Inventory screens.
-- The stock list reads db_purchase.forecast_item_stock with UPPER(TRIM(warehouse_id))
-- and TRIM(inventory_id). A plain column index cannot serve those expressions.
-- inv_* tables already have primary keys and most branch/time indexes.
-- This file adds only the list filters that were missing.
-- Applied on 2026-10-29 to db_purchase and db_kc_inventory.
-- Do not run this file again: the index names already exist.
-- MySQL 8.0 has no CREATE INDEX IF NOT EXISTS.
-- The stock index is a functional key, so it was created without ALGORITHM=INPLACE.

-- Branch item lists (not-live stock still comes from this table).
ALTER TABLE db_purchase.forecast_item_stock
  ADD INDEX idx_fis_wh_item_norm ((UPPER(TRIM(warehouse_id))), (TRIM(inventory_id)));

ALTER TABLE db_kc_inventory.inv_transactions
  ADD INDEX idx_inv_txn_status_created (status, created_at, id),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_adjustments
  ADD INDEX idx_inv_adj_status_requested (status, requested_at),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_transfers
  ADD INDEX idx_inv_xfer_status_requested (status, requested_at),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_count_sessions
  ADD INDEX idx_inv_count_status_started (status, started_at, id),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_discrepancy_cases
  ADD INDEX idx_inv_case_status_opened (status, opened_at),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_alerts
  ADD INDEX idx_inv_alerts_status_created (status, created_at),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE db_kc_inventory.inv_audit_logs
  ADD INDEX idx_inv_audit_action_time (action, occurred_at),
  ALGORITHM=INPLACE, LOCK=NONE;
