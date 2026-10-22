import { NextRequest, NextResponse } from "next/server";
import {
  browse,
  createFolder,
  createProduct,
  getProduct,
  getProductMedia,
  itemClassDocuments,
  itemClassMedia,
  listActionLogs,
  reorderCmsMedia,
  search,
  softDeleteFolder,
  softDeleteProduct,
  writeActionLog,
} from "../kc-cms";
import {
  fail,
  ok,
  readJson,
  requireAdmin,
  withCors,
} from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ action?: string[] }> };

function normalizeAction(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return value.replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function GET(
  req: NextRequest,
  ctx: Ctx,
) {
  const { action } = await ctx.params;
  const key = normalizeAction(action);
  if (key === "health" || key === "inventory_health") {
    return withCors(ok({ ok: true }));
  }
  if (key === "browse" || key === "inventory_browse") {
    const folderId = req.nextUrl.searchParams.get("folder_id") ?? "";
    return withCors(ok(await browse(folderId)));
  }
  return withCors(fail(404, `Unknown action: ${action}`));
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params;
  const key = normalizeAction(action);
  const body = await readJson(req);

  try {
    switch (key) {
      case "browse":
      case "inventory_browse": {
        const folderId = String(body.folder_id ?? "");
        return withCors(ok(await browse(folderId)));
      }
      case "search":
      case "inventory_search": {
        const query = String(body.query ?? "");
        const limit = Number(body.limit ?? 40);
        return withCors(ok(await search(query, limit)));
      }
      case "product":
      case "inventory_product": {
        const productId = String(body.product_id ?? "").trim();
        if (!productId) return withCors(fail(400, "product_id is required"));
        const product = await getProduct(productId);
        if (!product) return withCors(fail(404, "Product not found"));
        return withCors(ok(product));
      }
      case "product_media":
      case "inventory_product_media":
      case "cms_product_media": {
        const productId = String(body.product_id ?? "").trim();
        if (!productId) return withCors(fail(400, "product_id is required"));
        const mediaKind = String(body.media_kind ?? "").trim();
        return withCors(ok(await getProductMedia(productId, mediaKind)));
      }
      case "cms_media":
      case "inventory_cms_media":
      case "item_class_media":
      case "inventory_item_class_media": {
        const itemClassId = String(body.item_class_id ?? "").trim();
        const mediaKind = String(body.media_kind ?? "").trim();
        if (!itemClassId) {
          return withCors(fail(400, "item_class_id is required"));
        }
        if (!mediaKind) {
          return withCors(fail(400, "media_kind is required"));
        }
        return withCors(ok(await itemClassMedia(itemClassId, mediaKind)));
      }
      case "cms_documents":
      case "inventory_cms_documents":
      case "item_class_documents":
      case "inventory_item_class_documents": {
        const itemClassId = String(body.item_class_id ?? "").trim();
        const documentCategory = String(
          body.document_category ?? body.category ?? "",
        ).trim();
        if (!itemClassId) {
          return withCors(fail(400, "item_class_id is required"));
        }
        if (!documentCategory) {
          return withCors(fail(400, "document_category is required"));
        }
        return withCors(
          ok(await itemClassDocuments(itemClassId, documentCategory)),
        );
      }
      case "folder_create":
      case "inventory_folder_create": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        return withCors(ok(await createFolder(body)));
      }
      case "product_create":
      case "inventory_product_create": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        return withCors(ok(await createProduct(body)));
      }
      case "folder_delete":
      case "inventory_folder_delete": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        const folderId = String(body.folder_id ?? "").trim();
        if (!folderId) return withCors(fail(400, "folder_id is required"));
        await softDeleteFolder(folderId);
        return withCors(ok({ deleted: true }));
      }
      case "product_delete":
      case "inventory_product_delete": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        const productId = String(body.product_id ?? "").trim();
        if (!productId) return withCors(fail(400, "product_id is required"));
        await softDeleteProduct(productId);
        return withCors(ok({ deleted: true }));
      }
      case "media_reorder":
      case "inventory_media_reorder": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        return withCors(ok(await reorderCmsMedia(body)));
      }
      case "action_log":
      case "inventory_action_log": {
        return withCors(ok(await writeActionLog(body)));
      }
      case "action_logs":
      case "inventory_action_logs": {
        if (!requireAdmin(req)) {
          return withCors(fail(403, "Admin token required"));
        }
        return withCors(
          ok(
            await listActionLogs(Number(body.limit ?? 200), {
              actions: body.actions,
              excludeActions: body.exclude_actions,
            }),
          ),
        );
      }
      case "health":
      case "inventory_health": {
        return withCors(ok({ ok: true }));
      }
      default:
        return withCors(
          fail(
            404,
            "Unknown action. Example: /api/product-directory/inventory_browse",
          ),
        );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status =
      message.includes("required") ||
      message.includes("Invalid") ||
      message.includes("Select a folder")
        ? 400
        : 500;
    return withCors(fail(status, message));
  }
}
