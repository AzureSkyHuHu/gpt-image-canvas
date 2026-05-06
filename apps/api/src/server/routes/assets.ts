import type { Hono } from "hono";
import { parsePreviewWidth, readStoredAssetPreview } from "../../domain/assets/preview.js";
import { readStoredAsset, readStoredAssetMetadata } from "../../domain/generation/image-generation.js";
import { currentDataOwner } from "../http/access-control.js";
import { downloadFileName, errorResponse } from "../http/errors.js";

export function registerAssetRoutes(app: Hono): void {
  app.get("/api/assets/:id/preview", async (c) => {
    const parsedWidth = parsePreviewWidth(c.req.query("width"));
    if (!parsedWidth.ok) {
      return c.json(errorResponse(parsedWidth.code, parsedWidth.message), 400);
    }

    const preview = await readStoredAssetPreview(currentDataOwner(c), c.req.param("id"), parsedWidth.width);
    if (!preview) {
      return c.json(errorResponse("not_found", "Asset not found."), 404);
    }

    return new Response(new Uint8Array(preview.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="${downloadFileName(c.req.param("id"))}-${preview.width}.webp"`,
        "Content-Type": "image/webp"
      }
    });
  });

  app.get("/api/assets/:id/metadata", async (c) => {
    const metadata = await readStoredAssetMetadata(currentDataOwner(c), c.req.param("id"));
    if (!metadata) {
      return c.json(errorResponse("not_found", "Asset not found."), 404);
    }

    return c.json(metadata);
  });

  app.get("/api/assets/:id/download", async (c) => {
    const asset = await readStoredAsset(currentDataOwner(c), c.req.param("id"));
    if (!asset) {
      return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
    }

    return new Response(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `attachment; filename="${downloadFileName(asset.file.fileName)}"`,
        "Content-Type": asset.file.mimeType
      }
    });
  });

  app.get("/api/assets/:id", async (c) => {
    const asset = await readStoredAsset(currentDataOwner(c), c.req.param("id"));
    if (!asset) {
      return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
    }

    return new Response(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="${asset.file.fileName}"`,
        "Content-Type": asset.file.mimeType
      }
    });
  });
}
