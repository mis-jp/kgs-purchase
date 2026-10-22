import { randomBytes } from "crypto";
import { getPool, type RowDataPacket } from "./db";
import {
  cmsMediaProductId,
  documentCategoryFromFolder,
  documentCategoryLabel,
  expandMediaUrls,
  flowchartMediaKind,
  applyCmsMediaSortOrder,
  flatCmsFilesFromRows,
  groupCmsMediaBrowse,
  inventoryIdFromFlatCmsFileProductId,
  mediaKindToColumn,
  parseCmsModelFolderId,
  resolveCmsMediaUrl,
  shouldGroupMediaByModel,
  type CmsMediaRow,
} from "./cms-inventory-media";
import type {
  BrowseResult,
  InventoryFolder,
  InventoryProduct,
} from "./types";

export const ROOT_ID = "kg-posting";
export const ROOT_NAME = "KC Posting Class";

function id(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

export async function ensureTables(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS kc_categories (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_active_sort (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS kc_item_classes (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      category_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      source_code VARCHAR(128) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_category (category_id),
      KEY idx_active_sort (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  try {
    await db.query(
      "ALTER TABLE kc_item_classes ADD COLUMN source_code VARCHAR(128) NULL AFTER name",
    );
  } catch {
    /* column may already exist */
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS kc_folders (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      item_class_id VARCHAR(64) NOT NULL,
      parent_id VARCHAR(64) NULL,
      name VARCHAR(255) NOT NULL,
      kind VARCHAR(32) NOT NULL DEFAULT 'folder',
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_item_class (item_class_id),
      KEY idx_parent (parent_id),
      KEY idx_active_sort (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS kc_products (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      folder_id VARCHAR(64) NOT NULL,
      name VARCHAR(512) NOT NULL,
      sku VARCHAR(128) NOT NULL DEFAULT '',
      description TEXT NULL,
      file_url VARCHAR(1024) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_folder (folder_id),
      KEY idx_sku (sku),
      KEY idx_active_sort (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_action_logs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      action VARCHAR(32) NOT NULL,
      actor_id VARCHAR(128) NOT NULL DEFAULT '',
      actor_name VARCHAR(255) NOT NULL DEFAULT '',
      target_id VARCHAR(64) NOT NULL DEFAULT '',
      target_name VARCHAR(512) NOT NULL DEFAULT '',
      detail TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_created (created_at),
      KEY idx_action (action),
      KEY idx_actor (actor_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Product Directory–owned sort ranks (our API only). Never touches CMS
  // product_inventory_* tables. Created/used via KGS product-directory routes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS kc_cms_media_sort (
      item_class_id VARCHAR(64) NOT NULL,
      media_kind VARCHAR(32) NOT NULL,
      product_id VARCHAR(128) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (item_class_id, media_kind, product_id),
      KEY idx_media_sort (item_class_id, media_kind, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Display: Auxiliary, Inks, Machine, Media (id `tools` = Auxiliary).
  for (const [cid, name, sort] of [
    ["tools", "Auxiliary", 1],
    ["inks", "Inks", 2],
    ["machine", "Machine", 3],
    ["media", "Media", 4],
  ] as const) {
    await db.query(
      `INSERT INTO kc_categories (id, name, sort_order, is_active) VALUES (?,?,?,1)
       ON DUPLICATE KEY UPDATE name=VALUES(name), sort_order=VALUES(sort_order), is_active=1`,
      [cid, name, sort],
    );
  }
}

type CatRow = RowDataPacket & { id: string; name: string };
type IcRow = RowDataPacket & {
  id: string;
  category_id: string;
  name: string;
  source_code: string | null;
};
type FolderRow = RowDataPacket & {
  id: string;
  item_class_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
};
type ProductRow = RowDataPacket & {
  id: string;
  folder_id: string;
  name: string;
  sku: string;
  description: string | null;
  file_url: string | null;
};

async function getCategory(id: string): Promise<CatRow | null> {
  const [rows] = await getPool().query<CatRow[]>(
    "SELECT id, name FROM kc_categories WHERE is_active=1 AND id=? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

async function getItemClass(id: string): Promise<IcRow | null> {
  const [rows] = await getPool().query<IcRow[]>(
    "SELECT id, category_id, name, source_code FROM kc_item_classes WHERE is_active=1 AND id=? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

/** CMS uses longer names than Product Directory item-class folders. */
function cmsItemClassNameAliases(itemClassName: string): string[] {
  const name = itemClassName.trim();
  if (!name) return [];
  const key = name.toLowerCase();
  const extra: Record<string, string[]> = {
    "eco solvent": ["Ecosolvent Printer", "Eco-Solvent Printer", "Eco Solvent"],
    solvent: ["Solvent Printer", "Solvent"],
    "heat press": ["Heat Press Machine", "Heat Press"],
    embroidery: ["Embroidery Machine", "Embroidery"],
    laminator: ["Laminating machine", "Laminating Machine", "Laminator"],
    "cnc router": ["Router Machine", "CNC Router"],
    "cutter plotter": ["Digital Cutter Machine", "Cutter Plotter"],
    "flatbed cutter": ["Digital Cutter Machine", "Flatbed Cutter"],
    "uv printer": ["UV Printer"],
    "laser machine": ["Laser Machine"],
    "3d printer": ["3D Printer", "Signmaking machine", "Signmaking Machine"],
    accessories: ["Accessories"],
  };
  const out = new Set<string>([name]);
  for (const alias of extra[key] ?? []) out.add(alias);
  return [...out];
}

/** CMS uses "Auxiliary"; Product Directory folder is "Tools". */
function cmsCategoryAliases(categoryName: string): string[] {
  const name = categoryName.trim();
  const key = name.toLowerCase();
  if (key === "tools" || key === "auxiliary") {
    return ["Tools", "Auxiliary"];
  }
  return name ? [name] : [];
}

/** Collapse tabs/spaces so CMS values like "Solvent\\t Inks" match folder names. */
function sqlNormLabel(expr: string): string {
  // Avoid REGEXP_REPLACE (slow on large scans). Tabs + trim cover CMS quirks.
  return `LOWER(TRIM(REPLACE(CONVERT(IFNULL(${expr},'') USING utf8mb4), CHAR(9), ' '))) COLLATE utf8mb4_unicode_ci`;
}

function sqlUtf8Eq(leftExpr: string): string {
  return `${sqlNormLabel(leftExpr)} = ${sqlNormLabel("?")}`;
}

/** Brochure / Images / Videos only include rows that have that media URL. */
function requireMediaUrl(
  kind: string,
  _categoryId: string | null | undefined,
): boolean {
  return true;
}

async function loadCmsMediaRows(
  itemClassId: string,
  kind: string,
  modelId?: string,
): Promise<CmsMediaRow[]> {
  const column = mediaKindToColumn(kind);
  if (!column) return [];
  const ic = await getItemClass(itemClassId);
  if (!ic) return [];
  const cat = await getCategory(ic.category_id);
  const categoryAliases = cmsCategoryAliases(cat?.name || "");
  const nameAliases = cmsItemClassNameAliases(ic.name);
  const sourceCode = (ic.source_code || "").trim();
  const mustHaveUrl = requireMediaUrl(kind, ic.category_id);
  const isImages = column === "image_url";
  const isBrochure = column === "brochure_url";
  // Photos may live only in product_inventory_images (CMS gallery), not image_url.
  // Brochures may live in product_inventory_attachments (category=brochure) and/or brochure_url.
  const urlClause = !mustHaveUrl
    ? ""
    : isImages
      ? `AND (
           COALESCE(p.image_url, '') <> ''
           OR EXISTS (
             SELECT 1 FROM product_inventory_images g
             WHERE g.inventory_item_id = p.id
           )
         )`
      : isBrochure
        ? `AND (
             COALESCE(p.brochure_url, '') <> ''
             OR EXISTS (
               SELECT 1 FROM product_inventory_attachments a
               WHERE a.inventory_item_id = p.id
                 AND LOWER(TRIM(a.category)) = 'brochure'
             )
           )`
        : `AND COALESCE(p.${column}, '') <> ''`;
  const orderBy = `ORDER BY (COALESCE(p.${column}, '') = '') ASC, m.name, p.inventory_name`;

  const modelClause =
    modelId !== undefined ? " AND p.model_id = ? " : "";
  const modelParam =
    modelId !== undefined ? [Number(modelId)] : [];

  const mapRows = async (rows: RowDataPacket[]): Promise<CmsMediaRow[]> => {
    const out: CmsMediaRow[] = [];
    for (const r of rows) {
      const inventoryId = String(r.inventory_id);
      const inventoryName = String(r.inventory_name || inventoryId);
      const model_id = r.model_id;
      const model_name = r.model_name ? String(r.model_name) : null;
      const cover = String(r.media_url || "");
      if (isImages) {
        const gallery = await loadInventoryGalleryUrls(Number(r.id));
        const urls = gallery.length > 0 ? gallery : expandMediaUrls(cover);
        if (urls.length === 0) continue;
        out.push({
          inventory_id: inventoryId,
          inventory_name: inventoryName,
          model_id,
          model_name,
          // Pipe-join so groupCmsMediaBrowse expands to unique product ids.
          media_url: urls.join("|"),
        });
        continue;
      }
      if (isBrochure) {
        const urls = await mergeBrochureUrls(Number(r.id), cover);
        if (urls.length === 0) continue;
        out.push({
          inventory_id: inventoryId,
          inventory_name: inventoryName,
          model_id,
          model_name,
          media_url: urls.join("|"),
        });
        continue;
      }
      out.push({
        inventory_id: inventoryId,
        inventory_name: inventoryName,
        model_id,
        model_name,
        media_url: cover,
      });
    }
    return out;
  };

  const selectCols = `p.id, p.inventory_id, p.inventory_name, p.model_id, m.name AS model_name,
              p.${column} AS media_url`;

  // 1) Products already linked under this Product Directory item class.
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT ${selectCols}
       FROM product_inventory_items p
       INNER JOIN kc_products kp
         ON p.inventory_id = kp.id COLLATE utf8mb4_unicode_ci
        AND BINARY kp.id = BINARY p.inventory_id AND kp.is_active = 1
       INNER JOIN kc_folders f
         ON f.id = kp.folder_id AND BINARY f.id = BINARY kp.folder_id AND f.is_active = 1
        AND f.item_class_id = ? AND BINARY f.item_class_id = BINARY ?
       LEFT JOIN inventory_models m ON m.id = p.model_id
       WHERE p.deleted_at IS NULL
         AND LOWER(TRIM(p.item_status)) = 'active'
         ${urlClause}
         ${modelClause}
       ${orderBy}`,
      [itemClassId, itemClassId, ...modelParam],
    );
    if (rows.length > 0) return mapRows(rows);
  } catch (err) {
    console.error("[product-directory] CMS media via kc_products failed:", err);
  }

  // 2) Primary: KC Category + KC Item Class (CMS grid), with name aliases.
  if (nameAliases.length > 0 && categoryAliases.length > 0) {
    try {
      const nameIn = nameAliases.map(() => sqlNormLabel("?")).join(", ");
      const catIn = categoryAliases.map(() => sqlNormLabel("?")).join(", ");
      const [byKc] = await getPool().query<RowDataPacket[]>(
        `SELECT ${selectCols}
         FROM product_inventory_items p
         LEFT JOIN inventory_models m ON m.id = p.model_id
         WHERE p.deleted_at IS NULL
           AND LOWER(TRIM(p.item_status)) = 'active'
           ${urlClause}
           AND ${sqlNormLabel("p.kc_item_class")} IN (${nameIn})
           AND ${sqlNormLabel("p.kc_category")} IN (${catIn})
           ${modelClause}
         ${orderBy}`,
        [...nameAliases, ...categoryAliases, ...modelParam],
      );
      if (byKc.length > 0) return mapRows(byKc);
    } catch (err) {
      console.error(
        "[product-directory] CMS media via kc_category/kc_item_class failed:",
        err,
      );
    }
  }

  // 3) Fallback: Acumatica item_class code (source_code) or exact KC name.
  try {
    const [fallback] = await getPool().query<RowDataPacket[]>(
      `SELECT ${selectCols}
       FROM product_inventory_items p
       LEFT JOIN inventory_models m ON m.id = p.model_id
       WHERE p.deleted_at IS NULL
         AND LOWER(TRIM(p.item_status)) = 'active'
         ${urlClause}
         AND (
           (TRIM(IFNULL(p.item_class,'')) <> '' AND ${sqlUtf8Eq("IFNULL(p.item_class,'')")})
           OR (TRIM(IFNULL(p.kc_item_class,'')) <> '' AND ${sqlUtf8Eq("IFNULL(p.kc_item_class,'')")})
         )
         ${modelClause}
       ${orderBy}`,
      [sourceCode || ic.name, ic.name, ...modelParam],
    );
    return mapRows(fallback);
  } catch (err) {
    console.error("[product-directory] CMS media fallback failed:", err);
    return [];
  }
}

async function getFolder(id: string): Promise<FolderRow | null> {
  const [rows] = await getPool().query<FolderRow[]>(
    "SELECT id, item_class_id, parent_id, name, kind FROM kc_folders WHERE is_active=1 AND id=? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

async function folderPath(folder: FolderRow): Promise<string[]> {
  const ic = await getItemClass(folder.item_class_id);
  const cat = ic ? await getCategory(ic.category_id) : null;
  const parts = [ROOT_NAME];
  if (cat) parts.push(cat.name);
  if (ic) parts.push(ic.name);
  const chain: string[] = [];
  let current: FolderRow | null = folder;
  while (current) {
    chain.push(current.name);
    current = current.parent_id ? await getFolder(current.parent_id) : null;
  }
  return [...parts, ...chain.reverse()];
}

async function listCategories(): Promise<InventoryFolder[]> {
  const [rows] = await getPool().query<CatRow[]>(
    "SELECT id, name FROM kc_categories WHERE is_active=1 ORDER BY sort_order, name",
  );
  const out: InventoryFolder[] = [];
  for (const row of rows) {
    const [c] = await getPool().query<RowDataPacket[]>(
      "SELECT COUNT(*) AS c FROM kc_item_classes WHERE is_active=1 AND category_id=?",
      [row.id],
    );
    out.push({
      id: row.id,
      name: row.name,
      parent_id: ROOT_ID,
      kind: "category",
      child_count: Number(c[0]?.c ?? 0),
      path: [ROOT_NAME, row.name],
    });
  }
  return out;
}

async function listItemClasses(
  categoryId: string,
  categoryName: string,
): Promise<InventoryFolder[]> {
  const [rows] = await getPool().query<IcRow[]>(
    "SELECT id, category_id, name FROM kc_item_classes WHERE is_active=1 AND category_id=? ORDER BY sort_order, name",
    [categoryId],
  );
  const out: InventoryFolder[] = [];
  for (const row of rows) {
    const path = [ROOT_NAME, categoryName, row.name];
    const folders = await foldersForItemClass(row.id, path, row.category_id);
    const childCount = folders.length;
    out.push({
      id: row.id,
      name: row.name,
      parent_id: categoryId,
      kind: "subcategory",
      child_count: childCount,
      path,
    });
  }
  return out;
}

async function listFolders(
  itemClassId: string,
  parentId: string | null,
  parentPath: string[],
): Promise<InventoryFolder[]> {
  const [rows] = parentId
    ? await getPool().query<FolderRow[]>(
        `SELECT id, item_class_id, parent_id, name, kind FROM kc_folders
         WHERE is_active=1 AND item_class_id=? AND parent_id=?
         ORDER BY sort_order, name`,
        [itemClassId, parentId],
      )
    : await getPool().query<FolderRow[]>(
        `SELECT id, item_class_id, parent_id, name, kind FROM kc_folders
         WHERE is_active=1 AND item_class_id=? AND parent_id IS NULL
         ORDER BY sort_order, name`,
        [itemClassId],
      );
  const out: InventoryFolder[] = [];
  for (const row of rows) {
    const [c] = await getPool().query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM kc_folders WHERE is_active=1 AND parent_id=?) +
         (SELECT COUNT(*) FROM kc_products WHERE is_active=1 AND folder_id=?) AS c`,
      [row.id, row.id],
    );
    out.push({
      id: row.id,
      name: row.name,
      parent_id: parentId || itemClassId,
      kind: row.kind || "folder",
      child_count: Number(c[0]?.c ?? 0),
      path: [...parentPath, row.name],
    });
  }
  return out;
}

const CMS_PUBLIC_ORIGIN =
  process.env.CMS_PUBLIC_ORIGIN?.trim() || "https://kelinconnect.com";

function normalizeFileUrl(url: string | null | undefined): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  if (value.startsWith("//")) return `http:${value}`;
  if (value.startsWith("/")) return `${CMS_PUBLIC_ORIGIN}${value}`;
  return `${CMS_PUBLIC_ORIGIN}/${value.replace(/^\/+/, "")}`;
}

async function cmsMediaUrlForProduct(productId: string): Promise<string> {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT image_url, brochure_url, youtube_url
       FROM product_inventory_items
       WHERE deleted_at IS NULL AND inventory_id = ? AND BINARY inventory_id = BINARY ?
       LIMIT 1`,
      [productId, productId],
    );
    const row = rows[0];
    if (!row) return "";
    for (const col of ["image_url", "brochure_url", "youtube_url"] as const) {
      const url = normalizeFileUrl(String(row[col] ?? ""));
      if (url) return url;
    }
  } catch (err) {
    console.error("[product-directory] CMS product URL lookup failed:", err);
  }
  return "";
}

async function listProducts(
  folderId: string,
  path: string[],
): Promise<InventoryProduct[]> {
  const [rows] = await getPool().query<ProductRow[]>(
    `SELECT id, folder_id, name, sku, description, file_url FROM kc_products
     WHERE is_active=1 AND folder_id=? ORDER BY sort_order, name`,
    [folderId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku || "",
    description: row.description || "",
    file_url: normalizeFileUrl(row.file_url),
    folder_id: row.folder_id,
    folder_path: path,
  }));
}

function isCatalogFolderId(id: string): boolean {
  return id.startsWith("kc_fld_catalog_");
}

function catalogFolderId(itemClassId: string): string {
  return `kc_fld_catalog_${itemClassId}`;
}

const PRODUCTS_CONTAINER_NAMES = new Set([
  "products",
  "machines",
  "catalog",
  "machine",
]);

async function findChildFolder(
  parentFolderId: string,
  folderName: string,
): Promise<FolderRow | null> {
  const [rows] = await getPool().query<FolderRow[]>(
    `SELECT id, item_class_id, parent_id, name, kind FROM kc_folders
     WHERE is_active=1 AND parent_id=? AND LOWER(TRIM(name))=LOWER(?)
     ORDER BY sort_order, name LIMIT 1`,
    [parentFolderId, folderName],
  );
  return rows[0] ?? null;
}

async function resolveProductsContainer(
  itemClassId: string,
): Promise<{ id: string; exists: boolean; row: FolderRow | null }> {
  const catalogId = catalogFolderId(itemClassId);
  const catalogRow = await getFolder(catalogId);
  if (catalogRow) {
    return { id: catalogId, exists: true, row: catalogRow };
  }

  for (const name of ["Products", "Machines", "Catalog"]) {
    const row = await findFlowchartFolder(itemClassId, name);
    if (row) return { id: row.id, exists: true, row };
  }

  const [rows] = await getPool().query<FolderRow[]>(
    `SELECT id, item_class_id, parent_id, name, kind FROM kc_folders
     WHERE is_active=1 AND item_class_id=? AND parent_id IS NULL
       AND LOWER(TRIM(name)) IN ('products','machines','catalog','machine')
     ORDER BY sort_order, name LIMIT 1`,
    [itemClassId],
  );
  const row = rows[0] ?? null;
  if (row) return { id: row.id, exists: true, row };
  return { id: catalogId, exists: false, row: null };
}

function isProductsContainerName(name: string): boolean {
  return PRODUCTS_CONTAINER_NAMES.has(name.trim().toLowerCase());
}

async function isProductsContainerFolder(folder: FolderRow): Promise<boolean> {
  if (isCatalogFolderId(folder.id)) return true;
  if (isProductsContainerName(folder.name)) return true;
  const container = await resolveProductsContainer(folder.item_class_id);
  return folder.id === container.id;
}

async function isModelFolder(folder: FolderRow): Promise<boolean> {
  if (!folder.parent_id) return false;
  const parent = await getFolder(folder.parent_id);
  if (!parent) return false;
  return isProductsContainerFolder(parent);
}

async function subfolderCount(parentFolderId: string): Promise<number> {
  const [c] = await getPool().query<RowDataPacket[]>(
    "SELECT COUNT(*) AS c FROM kc_folders WHERE is_active=1 AND parent_id=?",
    [parentFolderId],
  );
  return Number(c[0]?.c ?? 0);
}

async function productsContainerChildCount(itemClassId: string): Promise<number> {
  const container = await resolveProductsContainer(itemClassId);
  if (!container.exists) {
    return await productCount(container.id);
  }
  const models = await subfolderCount(container.id);
  if (models > 0) return models;
  return await productCount(container.id);
}

function filterProductsByMediaType(
  products: InventoryProduct[],
  folderLabel: string,
): InventoryProduct[] {
  const key = folderLabel.trim().toLowerCase();
  if (key === "brochure") {
    return products.filter((p) => {
      const url = p.file_url.trim().toLowerCase();
      if (!url) return false;
      // Never treat product photos / YouTube as brochures.
      if (
        url.includes(".png") ||
        url.includes(".jpg") ||
        url.includes(".jpeg") ||
        url.includes(".webp") ||
        url.includes(".gif") ||
        url.includes("youtube.com") ||
        url.includes("youtu.be")
      ) {
        return false;
      }
      return (
        url.includes(".pdf") ||
        url.includes(".doc") ||
        url.includes("brochure")
      );
    });
  }
  if (key === "images") {
    return products.filter((p) => {
      const url = p.file_url.trim().toLowerCase();
      if (!url) return false;
      if (url.includes(".pdf") || url.includes("brochure")) return false;
      return (
        url.includes(".png") ||
        url.includes(".jpg") ||
        url.includes(".jpeg") ||
        url.includes(".webp") ||
        url.includes(".gif") ||
        url.includes("image") ||
        url.includes("/gallery/") ||
        url.includes("upload")
      );
    });
  }
  if (key === "videos") {
    return products.filter((p) => {
      const url = p.file_url.trim().toLowerCase();
      return (
        url.includes("youtube.com") ||
        url.includes("youtu.be") ||
        url.includes("youtube-nocookie.com") ||
        url.includes(".mp4") ||
        url.includes(".mov") ||
        url.includes(".webm") ||
        url.includes("video")
      );
    });
  }
  return products;
}

async function productCount(folderId: string): Promise<number> {
  const [c] = await getPool().query<RowDataPacket[]>(
    "SELECT COUNT(*) AS c FROM kc_products WHERE is_active=1 AND folder_id=?",
    [folderId],
  );
  return Number(c[0]?.c ?? 0);
}

function flowchartFolderAliases(folderLabel: string): string[] {
  const key = folderLabel.trim().toLowerCase();
  if (key === "brochure") {
    return ["brochure", "brochures", "catalogue", "catalog"];
  }
  if (key === "images") {
    return ["images", "image", "photos", "pictures", "gallery"];
  }
  if (key === "videos") {
    return ["videos", "video", "movies", "media"];
  }
  if (key === "products") {
    return ["products", "machines", "machine", "catalog", "models"];
  }
  return [key];
}

async function findFlowchartFolder(
  itemClassId: string,
  folderName: string,
): Promise<FolderRow | null> {
  const aliases = flowchartFolderAliases(folderName);
  const placeholders = aliases.map(() => "?").join(", ");
  const [rows] = await getPool().query<FolderRow[]>(
    `SELECT id, item_class_id, parent_id, name, kind FROM kc_folders
     WHERE is_active=1 AND item_class_id=?
       AND LOWER(TRIM(name)) IN (${placeholders})
     ORDER BY (parent_id IS NULL) DESC, sort_order, name LIMIT 1`,
    [itemClassId, ...aliases],
  );
  return rows[0] ?? null;
}

async function listItemClassMediaProducts(
  itemClassId: string,
  folderLabel: string,
  path: string[],
): Promise<InventoryProduct[]> {
  const aliases = flowchartFolderAliases(folderLabel);
  const placeholders = aliases.map(() => "?").join(", ");
  const [rows] = await getPool().query<ProductRow[]>(
    `SELECT p.id, p.folder_id, p.name, p.sku, p.description, p.file_url
     FROM kc_products p
     INNER JOIN kc_folders f ON f.id = p.folder_id
     WHERE p.is_active=1 AND f.is_active=1 AND f.item_class_id=?
       AND LOWER(TRIM(f.name)) IN (${placeholders})
     ORDER BY p.sort_order, p.name`,
    [itemClassId, ...aliases],
  );
  const mapped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku || "",
    description: row.description || "",
    file_url: row.file_url || "",
    folder_id: row.folder_id,
    folder_path: path,
  }));
  if (mapped.length > 0) {
    return filterProductsByMediaType(mapped, folderLabel);
  }

  const [allRows] = await getPool().query<ProductRow[]>(
    `SELECT p.id, p.folder_id, p.name, p.sku, p.description, p.file_url
     FROM kc_products p
     INNER JOIN kc_folders f ON f.id = p.folder_id
     WHERE p.is_active=1 AND f.is_active=1 AND f.item_class_id=?
       AND COALESCE(p.file_url, '') <> ''
     ORDER BY p.sort_order, p.name`,
    [itemClassId],
  );
  return filterProductsByMediaType(
    allRows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku || "",
      description: row.description || "",
      file_url: row.file_url || "",
      folder_id: row.folder_id,
      folder_path: path,
    })),
    folderLabel,
  );
}

async function folderContentCount(folderId: string): Promise<number> {
  const [c] = await getPool().query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM kc_folders WHERE is_active=1 AND parent_id=?) +
       (SELECT COUNT(*) FROM kc_products WHERE is_active=1 AND folder_id=?) AS c`,
    [folderId, folderId],
  );
  return Number(c[0]?.c ?? 0);
}

async function virtualFlowchartBrowse(
  itemClassId: string,
  folderLabel: string,
  mode: "products" | "folder",
): Promise<BrowseResult> {
  const icRow = await getItemClass(itemClassId);
  if (!icRow) return { folders: [], products: [] };
  const parentCat = await getCategory(icRow.category_id);
  const path = [ROOT_NAME, parentCat?.name || "", icRow.name, folderLabel].filter(
    Boolean,
  );

  if (mode === "products") {
    const container = await resolveProductsContainer(itemClassId);
    if (container.exists) {
      const modelFolders = await listFolders(
        itemClassId,
        container.id,
        path,
      );
      if (modelFolders.length > 0) {
        return { folders: modelFolders, products: [] };
      }
    }
    return {
      folders: [],
      products: await listProducts(container.id, path),
    };
  }

  const kind =
    folderLabel.trim().toLowerCase() === "images"
      ? "images"
      : folderLabel.trim().toLowerCase() === "videos"
        ? "videos"
        : "brochure";
  const rows = await loadCmsMediaRows(itemClassId, kind);
  const ic = await getItemClass(itemClassId);
  const grouped = groupCmsMediaBrowse(rows, kind, itemClassId, path, {
    groupByModel: shouldGroupMediaByModel(ic?.category_id),
    allowEmptyUrl: !requireMediaUrl(kind, ic?.category_id),
  });
  if (grouped.folders.length > 0 || grouped.products.length > 0) {
    return applyBrochureSortIfNeeded(itemClassId, kind, grouped);
  }

  const real = await findFlowchartFolder(itemClassId, folderLabel);
  if (real) {
    return {
      folders: await listFolders(itemClassId, real.id, path),
      products: await listProducts(real.id, path),
    };
  }

  return {
    folders: [],
    products: await listItemClassMediaProducts(itemClassId, folderLabel, path),
  };
}

async function applyBrochureSortIfNeeded(
  itemClassId: string,
  kind: string,
  browse: BrowseResult,
): Promise<BrowseResult> {
  if (kind !== "brochure" || browse.products.length === 0) return browse;
  const ranks = await loadCmsMediaSortRanks(itemClassId, "brochure");
  return {
    folders: browse.folders,
    products: applyCmsMediaSortOrder(browse.products, ranks),
  };
}

async function foldersForModelFolder(
  modelFolder: FolderRow,
  path: string[],
): Promise<InventoryFolder[]> {
  let folders = (await listFolders(modelFolder.item_class_id, modelFolder.id, path))
    .filter((f) => !isCatalogFolderId(f.id));

  const ensure = async (
    name: string,
    suffix: string,
    extraCount: number,
  ): Promise<void> => {
    const found = folders.find(
      (f) => f.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (found) {
      if (extraCount > 0) {
        found.child_count = (found.child_count ?? 0) + extraCount;
      }
      return;
    }
    folders.push({
      id: `kc_fld_m${suffix}_${modelFolder.id}`,
      name,
      parent_id: modelFolder.id,
      kind: "folder",
      child_count: extraCount,
      path: [...path, name],
    });
  };

  const brochureFolder = await findChildFolder(modelFolder.id, "Brochure");
  const imagesFolder = await findChildFolder(modelFolder.id, "Images");
  const videosFolder = await findChildFolder(modelFolder.id, "Videos");

  await ensure(
    "Brochure",
    "brochure",
    brochureFolder
      ? await folderContentCount(brochureFolder.id)
      : await productCount(modelFolder.id),
  );
  await ensure(
    "Images",
    "images",
    imagesFolder ? await folderContentCount(imagesFolder.id) : 0,
  );
  await ensure(
    "Videos",
    "videos",
    videosFolder ? await folderContentCount(videosFolder.id) : 0,
  );

  const rank = (name: string) => {
    const key = name.trim().toLowerCase();
    if (key === "brochure") return 0;
    if (key === "images") return 1;
    if (key === "videos") return 2;
    return 10;
  };
  folders = folders.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
  return folders;
}

async function virtualModelMediaBrowse(
  modelFolderId: string,
  folderLabel: string,
): Promise<BrowseResult> {
  const modelFolder = await getFolder(modelFolderId);
  if (!modelFolder) return { folders: [], products: [] };
  const path = await folderPath(modelFolder);
  const mediaPath = [...path, folderLabel];

  const real = await findChildFolder(modelFolder.id, folderLabel);
  if (real) {
    return {
      folders: await listFolders(modelFolder.item_class_id, real.id, mediaPath),
      products: await listProducts(real.id, mediaPath),
    };
  }

  const direct = await listProducts(modelFolder.id, mediaPath);
  return {
    folders: [],
    products: filterProductsByMediaType(direct, folderLabel),
  };
}

async function loadFlatCmsFilesForItemClass(
  itemClassId: string,
  basePath: string[],
): Promise<InventoryProduct[]> {
  const kinds = ["brochure", "images", "videos"] as const;
  const rowsByKind: { kind: string; rows: CmsMediaRow[] }[] = [];
  for (const kind of kinds) {
    try {
      rowsByKind.push({
        kind,
        rows: await loadCmsMediaRows(itemClassId, kind),
      });
    } catch {
      rowsByKind.push({ kind, rows: [] });
    }
  }
  return flatCmsFilesFromRows(rowsByKind, itemClassId, basePath);
}

async function foldersForItemClass(
  itemClassId: string,
  path: string[],
  categoryId?: string | null,
): Promise<InventoryFolder[]> {
  let folders = (await listFolders(itemClassId, null, path)).filter(
    (f) =>
      !isCatalogFolderId(f.id) &&
      f.name.trim().toLowerCase() !== "catalog" &&
      !isProductsContainerName(f.name.trim().toLowerCase()),
  );

  const ic = categoryId
    ? { category_id: categoryId }
    : await getItemClass(itemClassId);
  // All categories: Brochure / Images / Videos (same path as Machine).
  const groupByModel = shouldGroupMediaByModel(ic?.category_id);

  const ensure = async (
    name: string,
    suffix: string,
    extraCount: number,
  ): Promise<void> => {
    const found = folders.find(
      (f) => f.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (found) {
      if (extraCount > 0) {
        found.child_count = extraCount;
      }
      return;
    }
    folders.push({
      id: `kc_fld_${suffix}_${itemClassId}`,
      name,
      parent_id: itemClassId,
      kind: "folder",
      child_count: extraCount,
      path: [...path, name],
    });
  };

  const cmsCount = async (kind: string) => {
    try {
      const rows = await loadCmsMediaRows(itemClassId, kind);
      const grouped = groupCmsMediaBrowse(rows, kind, itemClassId, path, {
        groupByModel,
        allowEmptyUrl: !requireMediaUrl(kind, ic?.category_id),
      });
      return grouped.folders.length + grouped.products.length;
    } catch {
      return 0;
    }
  };

  await ensure("Brochure", "brochure", await cmsCount("brochure"));
  await ensure("Images", "images", await cmsCount("images"));
  await ensure("Videos", "videos", await cmsCount("videos"));

  const rank = (name: string) => {
    const key = name.trim().toLowerCase();
    if (key === "brochure") return 0;
    if (key === "images") return 1;
    if (key === "videos") return 2;
    return 10;
  };
  folders = folders.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
  return folders;
}

async function productsForFolder(
  folder: FolderRow,
  path: string[],
): Promise<InventoryProduct[]> {
  const own = await listProducts(folder.id, path);
  const name = folder.name.trim().toLowerCase();
  const isProducts =
    name === "products" || folder.id.startsWith("kc_fld_products_");
  if (!isProducts) return own;
  const catalogId = catalogFolderId(folder.item_class_id);
  const catalog = await listProducts(catalogId, path);
  const seen = new Set(own.map((p) => p.id));
  return [...own, ...catalog.filter((p) => !seen.has(p.id))];
}

export async function browse(folderId?: string | null): Promise<BrowseResult> {
  await ensureTables();
  const current =
    !folderId || folderId === "" || folderId === "root" ? ROOT_ID : folderId;

  if (current === ROOT_ID) {
    return { folders: await listCategories(), products: [] };
  }

  // CMS Product Documents folders (Application, Installation Manual, …).
  const docCategory = documentCategoryFromFolder(current);
  if (docCategory) {
    const match = current.match(/^kc_fld_[a-z0-9-]+_(.+)$/i);
    const itemClassId = match?.[1] || "";
    if (itemClassId) {
      return itemClassDocuments(itemClassId, docCategory);
    }
  }

  const cmsModel = parseCmsModelFolderId(current);
  if (cmsModel) {
    const ic = await getItemClass(cmsModel.itemClassId);
    const parentCat = ic ? await getCategory(ic.category_id) : null;
    const label =
      cmsModel.kind === "images"
        ? "Images"
        : cmsModel.kind === "videos"
          ? "Videos"
          : "Brochure";
    const path = [
      ROOT_NAME,
      parentCat?.name || "",
      ic?.name || "",
      label,
    ].filter(Boolean);
    const rows = await loadCmsMediaRows(
      cmsModel.itemClassId,
      cmsModel.kind,
      cmsModel.modelId,
    );
    const products: InventoryProduct[] = [];
    for (const row of rows) {
      const urls = expandMediaUrls(row.media_url);
      urls.forEach((url, index) => {
        products.push({
          id: cmsMediaProductId(row.inventory_id, cmsModel.kind, index),
          name:
            urls.length > 1
              ? `${row.inventory_name} (${index + 1})`
              : row.inventory_name,
          sku: row.inventory_id,
          description: "",
          file_url: url,
          folder_id: current,
          folder_path: [...path, row.model_name || "Model"],
        });
      });
    }
    return { folders: [], products };
  }

  const cat = await getCategory(current);
  if (cat) {
    return {
      folders: await listItemClasses(current, cat.name),
      products: [],
    };
  }

  const ic = await getItemClass(current);
  if (ic) {
    const parentCat = await getCategory(ic.category_id);
    const path = [ROOT_NAME, parentCat?.name || "", ic.name].filter(Boolean);
    // Auxiliary / Inks / Machine / Media: same path → Brochure | Images | Videos
    return {
      folders: await foldersForItemClass(current, path, ic.category_id),
      products: [],
    };
  }

  const folder = await getFolder(current);
  if (folder) {
    const path = await folderPath(folder);
    const cmsKind = flowchartMediaKind(
      folder.id,
      folder.name,
      folder.item_class_id,
    );
    if (cmsKind) {
      const rows = await loadCmsMediaRows(folder.item_class_id, cmsKind);
      const folderIc = await getItemClass(folder.item_class_id);
      const grouped = groupCmsMediaBrowse(
        rows,
        cmsKind,
        folder.item_class_id,
        path,
        {
          groupByModel: shouldGroupMediaByModel(folderIc?.category_id),
          allowEmptyUrl: !requireMediaUrl(cmsKind, folderIc?.category_id),
        },
      );
      if (grouped.folders.length > 0 || grouped.products.length > 0) {
        return applyBrochureSortIfNeeded(
          folder.item_class_id,
          cmsKind,
          grouped,
        );
      }
    }
    if (await isProductsContainerFolder(folder)) {
      const modelFolders = await listFolders(folder.item_class_id, folder.id, path);
      if (modelFolders.length > 0) {
        return { folders: modelFolders, products: [] };
      }
    }
    if (await isModelFolder(folder)) {
      return {
        folders: await foldersForModelFolder(folder, path),
        products: [],
      };
    }
    return {
      folders: (await listFolders(folder.item_class_id, current, path)).filter(
        (f) => !isCatalogFolderId(f.id),
      ),
      products: await productsForFolder(folder, path),
    };
  }

  const virtualModelMedia = current.match(
    /^kc_fld_m(brochure|images|videos)_(.+)$/,
  );
  if (virtualModelMedia) {
    const [, kind, modelFolderId] = virtualModelMedia;
    const labels: Record<string, string> = {
      brochure: "Brochure",
      images: "Images",
      videos: "Videos",
    };
    return virtualModelMediaBrowse(modelFolderId, labels[kind] ?? kind);
  }

  const virtualFlowchart = current.match(
    /^kc_fld_(brochure|images|videos|products)_(.+)$/,
  );
  if (virtualFlowchart) {
    const [, kind, itemClassId] = virtualFlowchart;
    const labels: Record<string, string> = {
      brochure: "Brochure",
      images: "Images",
      videos: "Videos",
      products: "Products",
    };
    const label = labels[kind] ?? kind;
    return virtualFlowchartBrowse(
      itemClassId,
      label,
      kind === "products" ? "products" : "folder",
    );
  }

  return { folders: [], products: [] };
}

export async function search(
  query: string,
  limit = 40,
): Promise<BrowseResult> {
  await ensureTables();
  const q = query.trim();
  if (!q) return { folders: [], products: [] };
  const lim = Math.max(1, Math.min(limit, 200));
  const like = `%${q}%`;
  const folders: InventoryFolder[] = [];
  const products: InventoryProduct[] = [];
  const db = getPool();

  const [cats] = await db.query<CatRow[]>(
    "SELECT id, name FROM kc_categories WHERE is_active=1 AND name LIKE ? ORDER BY sort_order, name LIMIT ?",
    [like, lim],
  );
  for (const row of cats) {
    folders.push({
      id: row.id,
      name: row.name,
      parent_id: ROOT_ID,
      kind: "category",
      child_count: null,
      path: [ROOT_NAME, row.name],
    });
  }

  const [ics] = await db.query<
    (IcRow & { category_name: string })[]
  >(
    `SELECT ic.id, ic.name, ic.category_id, c.name AS category_name
     FROM kc_item_classes ic
     JOIN kc_categories c ON c.id = ic.category_id
     WHERE ic.is_active=1 AND c.is_active=1 AND ic.name LIKE ?
     ORDER BY ic.sort_order, ic.name LIMIT ?`,
    [like, lim],
  );
  for (const row of ics) {
    folders.push({
      id: row.id,
      name: row.name,
      parent_id: row.category_id,
      kind: "subcategory",
      child_count: null,
      path: [ROOT_NAME, row.category_name, row.name],
    });
  }

  const [flds] = await db.query<FolderRow[]>(
    `SELECT id, name, parent_id, item_class_id, kind FROM kc_folders
     WHERE is_active=1 AND name LIKE ? ORDER BY sort_order, name LIMIT ?`,
    [like, lim],
  );
  for (const row of flds) {
    if (isCatalogFolderId(row.id)) continue;
    folders.push({
      id: row.id,
      name: row.name,
      parent_id: row.parent_id || row.item_class_id,
      kind: row.kind || "folder",
      child_count: null,
      path: await folderPath(row),
    });
  }

  const [prods] = await db.query<ProductRow[]>(
    `SELECT id, folder_id, name, sku, description, file_url FROM kc_products
     WHERE is_active=1 AND (name LIKE ? OR sku LIKE ? OR description LIKE ?)
     ORDER BY sort_order, name LIMIT ?`,
    [like, like, like, lim],
  );
  for (const row of prods) {
    const folder = await getFolder(row.folder_id);
    products.push({
      id: row.id,
      name: row.name,
      sku: row.sku || "",
      description: row.description || "",
      file_url: normalizeFileUrl(row.file_url),
      folder_id: row.folder_id,
      folder_path: folder ? await folderPath(folder) : [ROOT_NAME],
    });
  }

  const sliced = folders.slice(0, lim);
  const rem = Math.max(0, lim - sliced.length);
  return { folders: sliced, products: products.slice(0, rem) };
}

export async function getProduct(
  productId: string,
): Promise<InventoryProduct | null> {
  await ensureTables();
  const resolvedId = inventoryIdFromFlatCmsFileProductId(productId);
  const [rows] = await getPool().query<ProductRow[]>(
    `SELECT id, folder_id, name, sku, description, file_url FROM kc_products
     WHERE is_active=1 AND id=? LIMIT 1`,
    [resolvedId],
  );
  const row = rows[0];
  if (!row) {
    // CMS Product Database rows may exist only in product_inventory_items.
    const kindMatch = String(productId).match(
      /__(brochure|images|videos)$/i,
    );
    const kind = kindMatch ? kindMatch[1].toLowerCase() : "images";
    const [cmsRows] = await getPool().query<RowDataPacket[]>(
      `SELECT inventory_id, inventory_name, image_url, brochure_url, youtube_url,
              kc_category, kc_item_class
       FROM product_inventory_items
       WHERE deleted_at IS NULL AND inventory_id=? LIMIT 1`,
      [resolvedId],
    );
    const cms = cmsRows[0];
    if (!cms) return null;
    const rawUrl =
      kind === "videos"
        ? cms.youtube_url
        : kind === "brochure"
          ? cms.brochure_url
          : cms.image_url || cms.brochure_url || cms.youtube_url;
    const fileUrl = resolveCmsMediaUrl(String(rawUrl || ""));
    const cat = String(cms.kc_category || "").trim();
    const ic = String(cms.kc_item_class || "").trim();
    return {
      id: productId,
      name: String(cms.inventory_name || resolvedId),
      sku: resolvedId,
      description: [cat, ic].filter(Boolean).join(" · "),
      file_url: fileUrl,
      folder_id: "",
      folder_path: [ROOT_NAME, cat, ic].filter(Boolean),
    };
  }
  const folder = await getFolder(row.folder_id);
  let fileUrl = normalizeFileUrl(row.file_url);
  if (!fileUrl) {
    fileUrl = (await cmsMediaUrlForProduct(resolvedId)) || "";
  }
  return {
    id: row.id,
    name: row.name,
    sku: row.sku || "",
    description: row.description || "",
    file_url: fileUrl,
    folder_id: row.folder_id,
    folder_path: folder ? await folderPath(folder) : [ROOT_NAME],
  };
}

export async function itemClassMedia(
  itemClassId: string,
  mediaKind: string,
): Promise<BrowseResult> {
  await ensureTables();
  const icRow = await getItemClass(itemClassId);
  if (!icRow) return { folders: [], products: [] };
  const parentCat = await getCategory(icRow.category_id);
  const column = mediaKindToColumn(mediaKind);
  if (!column) return { folders: [], products: [] };
  const kind =
    column === "image_url"
      ? "images"
      : column === "youtube_url"
        ? "videos"
        : "brochure";
  const label =
    kind === "images" ? "Images" : kind === "videos" ? "Videos" : "Brochure";
  const path = [ROOT_NAME, parentCat?.name || "", icRow.name, label].filter(
    Boolean,
  );
  const rows = await loadCmsMediaRows(itemClassId, kind);
  const browse = groupCmsMediaBrowse(rows, kind, itemClassId, path, {
    groupByModel: shouldGroupMediaByModel(icRow.category_id),
    allowEmptyUrl: !requireMediaUrl(kind, icRow.category_id),
  });
  return applyBrochureSortIfNeeded(itemClassId, kind, browse);
}

export async function loadCmsMediaSortRanks(
  itemClassId: string,
  mediaKind: string,
): Promise<Map<string, number>> {
  await ensureTables();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT product_id, sort_order FROM kc_cms_media_sort
     WHERE item_class_id=? AND media_kind=?`,
    [itemClassId, mediaKind],
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(String(row.product_id), Number(row.sort_order) || 0);
  }
  return map;
}

export async function reorderCmsMedia(body: Record<string, unknown>) {
  await ensureTables();
  const itemClassId = String(body.item_class_id ?? "").trim();
  const mediaKind = String(body.media_kind ?? "").trim().toLowerCase();
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (!itemClassId) throw new Error("item_class_id is required");
  if (mediaKind !== "brochure") {
    throw new Error("media_kind must be brochure");
  }
  if (productIds.length === 0) throw new Error("product_ids is required");

  const db = getPool();
  await db.query(
    `DELETE FROM kc_cms_media_sort WHERE item_class_id=? AND media_kind=?`,
    [itemClassId, mediaKind],
  );
  for (let i = 0; i < productIds.length; i++) {
    await db.query(
      `INSERT INTO kc_cms_media_sort
       (item_class_id, media_kind, product_id, sort_order) VALUES (?,?,?,?)`,
      [itemClassId, mediaKind, productIds[i], i],
    );
  }

  try {
    await writeActionLog({
      action: "reordered_media",
      actor_id: String(body.actor_id ?? ""),
      actor_name: String(body.actor_name ?? ""),
      target_id: itemClassId,
      target_name: mediaKind,
      detail: `count=${productIds.length}`,
    });
  } catch {
    /* non-fatal if action not yet allow-listed */
  }

  return { ok: true, count: productIds.length };
}

/**
 * CMS Product Documents for one Product Directory item class + category
 * (Application, Installation Manual, …). Reads shared DB only — no CMS code.
 */
export async function itemClassDocuments(
  itemClassId: string,
  documentCategory: string,
): Promise<BrowseResult> {
  await ensureTables();
  const category =
    documentCategoryFromFolder(documentCategory) ||
    documentCategory.trim().toLowerCase();
  if (!category) return { folders: [], products: [] };

  const icRow = await getItemClass(itemClassId);
  if (!icRow) return { folders: [], products: [] };
  const parentCat = await getCategory(icRow.category_id);
  const label = documentCategoryLabel(category);
  const path = [ROOT_NAME, parentCat?.name || "", icRow.name, label].filter(
    Boolean,
  );
  const categoryAliases = cmsCategoryAliases(parentCat?.name || "");
  const nameAliases = cmsItemClassNameAliases(icRow.name);
  const sourceCode = (icRow.source_code || "").trim();

  type DocRow = {
    attachment_id: number;
    inventory_id: string;
    inventory_name: string;
    file_url: string;
    file_name: string | null;
  };

  const mapProducts = (rows: DocRow[]): InventoryProduct[] => {
    const products: InventoryProduct[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const url = resolveCmsMediaUrl(String(row.file_url || ""));
      if (!url) continue;
      const id = `attachment_${row.inventory_id}_${row.attachment_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      products.push({
        id,
        name:
          String(row.file_name || "").trim() ||
          String(row.inventory_name || row.inventory_id),
        sku: String(row.inventory_id),
        description: label,
        file_url: url,
        folder_id: `kc_fld_${category.replace(/_/g, "-")}_${itemClassId}`,
        folder_path: path,
      });
    }
    return products;
  };

  try {
    const filters: string[] = [
      "p.deleted_at IS NULL",
      "LOWER(TRIM(p.item_status)) = 'active'",
      "a.category = ?",
    ];
    const params: unknown[] = [category];

    if (nameAliases.length > 0 && categoryAliases.length > 0) {
      const nameIn = nameAliases.map(() => sqlNormLabel("?")).join(", ");
      const catIn = categoryAliases.map(() => sqlNormLabel("?")).join(", ");
      filters.push(`${sqlNormLabel("p.kc_item_class")} IN (${nameIn})`);
      filters.push(`${sqlNormLabel("p.kc_category")} IN (${catIn})`);
      params.push(...nameAliases, ...categoryAliases);
    } else {
      filters.push(`(
        (TRIM(IFNULL(p.item_class,'')) <> '' AND ${sqlUtf8Eq("IFNULL(p.item_class,'')")})
        OR (TRIM(IFNULL(p.kc_item_class,'')) <> '' AND ${sqlUtf8Eq("IFNULL(p.kc_item_class,'')")})
      )`);
      params.push(sourceCode || icRow.name, icRow.name);
    }

    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT a.id AS attachment_id, p.inventory_id, p.inventory_name,
              a.file_url, a.file_name
       FROM product_inventory_attachments a
       INNER JOIN product_inventory_items p ON p.id = a.inventory_item_id
       WHERE ${filters.join(" AND ")}
       ORDER BY p.inventory_name, a.id`,
      params,
    );
    return { folders: [], products: mapProducts(rows as unknown as DocRow[]) };
  } catch (err) {
    console.error("[product-directory] itemClassDocuments failed:", err);
    return { folders: [], products: [] };
  }
}

async function loadInventoryGalleryUrls(
  inventoryItemId: number,
): Promise<string[]> {
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    return [];
  }
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT file_url FROM product_inventory_images
       WHERE inventory_item_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [inventoryItemId],
    );
    return rows
      .map((r) => resolveCmsMediaUrl(String(r.file_url ?? "")))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** CMS multi-brochure uploads under Product Documents / attachments (category=brochure). */
async function loadBrochureAttachmentUrls(
  inventoryItemId: number,
): Promise<string[]> {
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    return [];
  }
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT file_url FROM product_inventory_attachments
       WHERE inventory_item_id = ?
         AND LOWER(TRIM(category)) = 'brochure'
       ORDER BY id ASC`,
      [inventoryItemId],
    );
    return rows
      .map((r) => resolveCmsMediaUrl(String(r.file_url ?? "")))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Cover brochure_url + attachment brochures, deduped (stable order). */
async function mergeBrochureUrls(
  inventoryItemId: number,
  brochureUrlColumn: string,
): Promise<string[]> {
  const fromColumn = expandMediaUrls(brochureUrlColumn);
  const fromAttachments = await loadBrochureAttachmentUrls(inventoryItemId);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of [...fromColumn, ...fromAttachments]) {
    const key = url.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/**
 * All CMS media files for one Product Database inventory row
 * (KelinConnect /product-database/inventory/{id} uploads).
 */
export async function getProductMedia(
  productId: string,
  mediaKind?: string,
): Promise<BrowseResult> {
  await ensureTables();
  const lookup = inventoryIdFromFlatCmsFileProductId(productId.trim());
  const kindFilter = mediaKind?.trim().toLowerCase() || "";

  // Prefer inventory_id (SKU). All-digit SKUs like 130101101000030 must NOT be
  // treated as CMS row id — that id is smaller (e.g. gallery/.../172089/...).
  let rows: RowDataPacket[] = [];
  {
    const [bySku] = await getPool().query<RowDataPacket[]>(
      `SELECT id, inventory_id, inventory_name, image_url, brochure_url, youtube_url,
              kc_category, kc_item_class
       FROM product_inventory_items
       WHERE deleted_at IS NULL AND inventory_id = ? AND BINARY inventory_id = BINARY ?
       LIMIT 1`,
      [lookup, lookup],
    );
    rows = bySku;
  }
  if (rows.length === 0 && /^\d+$/.test(lookup)) {
    const [byId] = await getPool().query<RowDataPacket[]>(
      `SELECT id, inventory_id, inventory_name, image_url, brochure_url, youtube_url,
              kc_category, kc_item_class
       FROM product_inventory_items
       WHERE deleted_at IS NULL AND id = ?
       LIMIT 1`,
      [Number(lookup)],
    );
    rows = byId;
  }

  const row = rows[0];
  if (!row) return { folders: [], products: [] };

  const inventoryId = String(row.inventory_id);
  const name = String(row.inventory_name || inventoryId);
  const cat = String(row.kc_category || "").trim();
  const ic = String(row.kc_item_class || "").trim();
  const folderPath = [ROOT_NAME, cat, ic].filter(Boolean);
  const galleryImageUrls = await loadInventoryGalleryUrls(Number(row.id));
  const brochureUrls = await mergeBrochureUrls(
    Number(row.id),
    String(row.brochure_url ?? ""),
  );

  const entries = [
    { kind: "images", column: "image_url" as const, label: "Photo" },
    { kind: "brochure", column: "brochure_url" as const, label: "Brochure" },
    { kind: "videos", column: "youtube_url" as const, label: "Video" },
  ].filter((entry) => !kindFilter || entry.kind === kindFilter);

  const products: InventoryProduct[] = [];
  for (const entry of entries) {
    const urls =
      entry.kind === "images" && galleryImageUrls.length > 0
        ? galleryImageUrls
        : entry.kind === "brochure"
          ? brochureUrls
          : expandMediaUrls(String(row[entry.column] ?? ""));
    urls.forEach((url, index) => {
      products.push({
        id: cmsMediaProductId(inventoryId, entry.kind, index),
        name: urls.length > 1 ? `${name} (${index + 1})` : name,
        sku: inventoryId,
        description: entry.label,
        file_url: url,
        folder_id: "",
        folder_path: [...folderPath, entry.label],
      });
    });
  }

  return { folders: [], products };
}

export async function createFolder(body: Record<string, unknown>) {
  await ensureTables();
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("Folder name is required");
  let parentId = String(body.parent_id ?? ROOT_ID).trim() || ROOT_ID;
  if (parentId === "root") parentId = ROOT_ID;

  if (parentId === ROOT_ID) {
    const folderId = String(body.id || id("kc_cat_"));
    await getPool().query(
      "INSERT INTO kc_categories (id, name, sort_order, is_active) VALUES (?,?,0,1)",
      [folderId, name],
    );
    return {
      id: folderId,
      name,
      parent_id: ROOT_ID,
      kind: "category",
      child_count: 0,
      path: [ROOT_NAME, name],
    } satisfies InventoryFolder;
  }

  if (await getCategory(parentId)) {
    const cat = await getCategory(parentId);
    const folderId = String(body.id || id("kc_ic_"));
    await getPool().query(
      "INSERT INTO kc_item_classes (id, category_id, name, sort_order, is_active) VALUES (?,?,?,0,1)",
      [folderId, parentId, name],
    );
    return {
      id: folderId,
      name,
      parent_id: parentId,
      kind: "subcategory",
      child_count: 0,
      path: [ROOT_NAME, cat!.name, name],
    } satisfies InventoryFolder;
  }

  let itemClassId: string | null = null;
  let parentFolderId: string | null = null;
  if (await getItemClass(parentId)) {
    itemClassId = parentId;
  } else {
    const parentFolder = await getFolder(parentId);
    if (!parentFolder) throw new Error("Invalid parent for folder");
    itemClassId = parentFolder.item_class_id;
    parentFolderId = parentId;
  }

  const folderId = String(body.id || id("kc_fld_"));
  const kind = String(body.kind ?? "folder").trim() || "folder";
  await getPool().query(
    `INSERT INTO kc_folders (id, item_class_id, parent_id, name, kind, sort_order, is_active)
     VALUES (?,?,?,?,?,0,1)`,
    [folderId, itemClassId, parentFolderId, name, kind],
  );
  const folder = await getFolder(folderId);
  return {
    id: folderId,
    name,
    parent_id: parentFolderId || itemClassId,
    kind,
    child_count: 0,
    path: folder ? await folderPath(folder) : [ROOT_NAME, name],
  } satisfies InventoryFolder;
}

export async function createProduct(body: Record<string, unknown>) {
  await ensureTables();
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("Product name is required");
  let folderId = String(body.folder_id ?? "").trim();
  if (!folderId || folderId === ROOT_ID) {
    throw new Error("Select a folder under a KC Item Class");
  }
  if (await getItemClass(folderId)) {
    throw new Error("Upload into a CMS folder under the item class");
  }
  if (!(await getFolder(folderId))) {
    throw new Error("Invalid folder for product");
  }
  const productId = String(body.id || id("kc_prd_"));
  let sku = String(body.sku ?? "").trim();
  if (!sku) sku = productId;
  const description = String(body.description ?? "").trim();
  const fileUrl = String(body.file_url ?? body.fileUrl ?? "").trim();
  await getPool().query(
    `INSERT INTO kc_products (id, folder_id, name, sku, description, file_url, sort_order, is_active)
     VALUES (?,?,?,?,?,?,0,1)`,
    [productId, folderId, name, sku, description, fileUrl || null],
  );
  return getProduct(productId);
}

export async function softDeleteFolder(folderId: string): Promise<void> {
  await ensureTables();
  const db = getPool();
  await db.query("UPDATE kc_categories SET is_active=0 WHERE id=?", [folderId]);
  await db.query("UPDATE kc_item_classes SET is_active=0 WHERE id=? OR category_id=?", [
    folderId,
    folderId,
  ]);
  await db.query("UPDATE kc_folders SET is_active=0 WHERE id=? OR item_class_id=?", [
    folderId,
    folderId,
  ]);
  // cascade children
  let changed = true;
  while (changed) {
    const [res] = await db.query(
      `UPDATE kc_folders child
       JOIN kc_folders parent ON child.parent_id = parent.id
       SET child.is_active = 0
       WHERE parent.is_active = 0 AND child.is_active = 1`,
    );
    changed = (res as { affectedRows?: number }).affectedRows! > 0;
  }
  await db.query(
    `UPDATE kc_products p
     JOIN kc_folders f ON p.folder_id = f.id
     SET p.is_active = 0
     WHERE f.is_active = 0 AND p.is_active = 1`,
  );
  await db.query(
    "UPDATE kc_products SET is_active=0 WHERE folder_id=? AND is_active=1",
    [folderId],
  );
}

export async function softDeleteProduct(productId: string): Promise<void> {
  await ensureTables();
  await getPool().query(
    "UPDATE kc_products SET is_active=0 WHERE id=? AND is_active=1",
    [productId],
  );
}

const ALLOWED_ACTIONS = new Set([
  "opened_product",
  "searched",
  "downloaded",
  "reordered_media",
  "added_folder",
  "added_product",
  "deleted_folder",
  "deleted_product",
]);

function actionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v ?? "").trim()).filter(Boolean))].slice(0, 20);
}

export async function writeActionLog(body: Record<string, unknown>) {
  await ensureTables();
  const action = String(body.action ?? "").trim();
  if (!ALLOWED_ACTIONS.has(action)) throw new Error("Invalid action");
  const logId = String(body.id || id("log_"));
  await getPool().query(
    `INSERT INTO inventory_action_logs
     (id, action, actor_id, actor_name, target_id, target_name, detail)
     VALUES (?,?,?,?,?,?,?)`,
    [
      logId,
      action,
      String(body.actor_id ?? "").slice(0, 128),
      String(body.actor_name ?? "").slice(0, 255),
      String(body.target_id ?? "").slice(0, 64),
      String(body.target_name ?? "").slice(0, 512),
      String(body.detail ?? "").slice(0, 2000),
    ],
  );
  return { id: logId, ok: true };
}

/**
 * Newest logs first. `actions` keeps only those action types; `excludeActions` drops them
 * (the app uses it for its "Others" filter).
 */
export async function listActionLogs(
  limit = 200,
  filter: { actions?: unknown; excludeActions?: unknown } = {},
) {
  await ensureTables();
  const lim = Math.max(1, Math.min(Number(limit) || 200, 500));
  const actions = actionList(filter.actions);
  const excluded = actionList(filter.excludeActions);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (actions.length) {
    clauses.push(`action IN (${actions.map(() => "?").join(",")})`);
    params.push(...actions);
  }
  if (excluded.length) {
    clauses.push(`action NOT IN (${excluded.map(() => "?").join(",")})`);
    params.push(...excluded);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT id, action, actor_id, actor_name, target_id, target_name, detail, created_at
     FROM inventory_action_logs ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, lim],
  );
  return {
    logs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor_id: r.actor_id || "",
      actor_name: r.actor_name || "",
      target_id: r.target_id || "",
      target_name: r.target_name || "",
      detail: r.detail || "",
      created_at: r.created_at
        ? new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19)
        : "",
    })),
  };
}
