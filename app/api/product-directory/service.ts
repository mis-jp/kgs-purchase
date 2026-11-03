import {
    ROOT_ID,
    ROOT_NAME,
    browse,
    createFolder,
    createProduct,
    ensureTables,
    getProduct,
    getProductMedia,
    itemClassMedia,
    listActionLogs,
    search,
    softDeleteFolder,
    softDeleteProduct,
    writeActionLog,
} from "./kc-cms";

type JsonBody = Record<string, unknown>;

function httpError(message: string, status: number): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
}

function requireAdmin(request?: Request): true {
    const token = (process.env.INVENTORY_ADMIN_TOKEN || "").trim();
    if (!token) return true;
    const header = request?.headers?.get?.("x-inventory-admin-token") || "";
    if (header !== token) throw httpError("Admin token required", 403);
    return true;
}

export const ProductDirectoryService = {
    ROOT_ID,
    ROOT_NAME,

    async health() {
        return { ok: true };
    },

    async browse(body: JsonBody = {}) {
        await ensureTables();
        return browse(String(body.folder_id || "").trim() || undefined);
    },

    async search(body: JsonBody = {}) {
        await ensureTables();
        let limit = parseInt(String(body.limit ?? 40), 10);
        if (!Number.isFinite(limit) || limit < 1) limit = 40;
        if (limit > 200) limit = 200;
        return search(String(body.query || "").trim(), limit);
    },

    async product(body: JsonBody = {}) {
        await ensureTables();
        const productId = String(body.product_id || "").trim();
        if (!productId) throw httpError("product_id is required", 400);
        const product = await getProduct(productId);
        if (!product) throw httpError("Product not found", 404);
        return product;
    },

    async productMedia(body: JsonBody = {}) {
        await ensureTables();
        const productId = String(body.product_id || "").trim();
        if (!productId) throw httpError("product_id is required", 400);
        const mediaKind = String(body.media_kind || body.mediaKind || "").trim();
        return getProductMedia(productId, mediaKind);
    },

    async itemClassMedia(body: JsonBody = {}) {
        await ensureTables();
        const itemClassId = String(body.item_class_id || "").trim();
        const mediaKind = String(body.media_kind || body.mediaKind || "").trim();
        if (!itemClassId) throw httpError("item_class_id is required", 400);
        if (!mediaKind) throw httpError("media_kind is required", 400);
        return itemClassMedia(itemClassId, mediaKind);
    },

    async folderCreate(body: JsonBody = {}, request?: Request) {
        requireAdmin(request);
        await ensureTables();
        return createFolder(body);
    },

    async productCreate(body: JsonBody = {}, request?: Request) {
        requireAdmin(request);
        await ensureTables();
        return createProduct(body);
    },

    async folderDelete(body: JsonBody = {}, request?: Request) {
        requireAdmin(request);
        await ensureTables();
        const folderId = String(body.folder_id || "").trim();
        if (!folderId) throw httpError("folder_id is required", 400);
        await softDeleteFolder(folderId);
        return { deleted: true };
    },

    async productDelete(body: JsonBody = {}, request?: Request) {
        requireAdmin(request);
        await ensureTables();
        const productId = String(body.product_id || "").trim();
        if (!productId) throw httpError("product_id is required", 400);
        await softDeleteProduct(productId);
        return { deleted: true };
    },

    async actionLogWrite(body: JsonBody = {}) {
        await ensureTables();
        return writeActionLog(body);
    },

    async actionLogsList(body: JsonBody = {}, request?: Request) {
        requireAdmin(request);
        await ensureTables();
        const limit = Number(body.limit);
        return listActionLogs(Number.isFinite(limit) ? limit : undefined, {
            actions: body.actions,
            excludeActions: body.exclude_actions,
        });
    },
};

export const PRODUCT_DIRECTORY_ACTIONS: Record<string, keyof typeof ProductDirectoryService> = {
    health: "health",
    inventory_health: "health",
    browse: "browse",
    inventory_browse: "browse",
    search: "search",
    inventory_search: "search",
    product: "product",
    inventory_product: "product",
    product_media: "productMedia",
    inventory_product_media: "productMedia",
    cms_product_media: "productMedia",
    item_class_media: "itemClassMedia",
    inventory_item_class_media: "itemClassMedia",
    cms_media: "itemClassMedia",
    inventory_cms_media: "itemClassMedia",
    folder_create: "folderCreate",
    inventory_folder_create: "folderCreate",
    product_create: "productCreate",
    inventory_product_create: "productCreate",
    folder_delete: "folderDelete",
    inventory_folder_delete: "folderDelete",
    product_delete: "productDelete",
    inventory_product_delete: "productDelete",
    action_log: "actionLogWrite",
    inventory_action_log: "actionLogWrite",
    action_logs: "actionLogsList",
    inventory_action_logs: "actionLogsList",
};
