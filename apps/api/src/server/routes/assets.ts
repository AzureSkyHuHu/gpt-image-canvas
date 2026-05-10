import type { Hono } from "hono";
import {
  readAssetCloudStatus,
  refreshAssetCloudUrl,
  restoreAssetFromMyTools,
  resyncAssetToMyTools
} from "../../domain/assets/cloud.js";
import { parsePreviewWidth, readStoredAssetPreview } from "../../domain/assets/preview.js";
import { readStoredAsset, readStoredAssetMetadata } from "../../domain/generation/image-generation.js";
import { currentDataOwner } from "../http/access-control.js";
import { downloadFileName, errorResponse, errorToMessage } from "../http/errors.js";

export function registerAssetRoutes(app: Hono): void {
  app.get("/api/assets/:id/cloud", async (c) => {
    const cloud = await readAssetCloudStatus(currentDataOwner(c), c.req.param("id"));
    if (!cloud) {
      return c.json(errorResponse("not_found", "Asset not found."), 404);
    }

    return c.json(cloud);
  });

  app.post("/api/assets/:id/cloud/resync", async (c) => {
    try {
      const result = await resyncAssetToMyTools(currentDataOwner(c), c.req.param("id"));
      if (!result) {
        return c.json(errorResponse("not_found", "Asset not found."), 404);
      }

      return c.json(result);
    } catch (error) {
      return c.json(errorResponse("cloud_resync_failed", errorToMessage(error)), 400);
    }
  });

  app.post("/api/assets/:id/cloud/restore", async (c) => {
    try {
      const result = await restoreAssetFromMyTools(currentDataOwner(c), c.req.param("id"));
      if (!result) {
        return c.json(errorResponse("not_found", "Asset not found."), 404);
      }

      return c.json(result);
    } catch (error) {
      return c.json(errorResponse("cloud_restore_failed", errorToMessage(error)), 400);
    }
  });

  app.post("/api/assets/:id/cloud/refresh-url", async (c) => {
    try {
      const result = await refreshAssetCloudUrl(currentDataOwner(c), c.req.param("id"));
      if (!result) {
        return c.json(errorResponse("not_found", "Asset not found."), 404);
      }

      return c.json(result);
    } catch (error) {
      return c.json(errorResponse("cloud_url_refresh_failed", errorToMessage(error)), 400);
    }
  });

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
