import type { Hono } from "hono";
import { Readable } from "node:stream";
import yazl from "yazl";
import { deleteGalleryOutput, getGalleryImages } from "../../domain/project/project-store.js";
import { readStoredAsset } from "../../domain/generation/image-generation.js";
import { currentDataOwner } from "../http/access-control.js";
import { downloadFileName, errorResponse } from "../http/errors.js";

export function registerGalleryRoutes(app: Hono): void {
  app.get("/api/gallery", (c) => c.json(getGalleryImages(currentDataOwner(c))));

  app.get("/api/gallery/export.zip", async (c) => {
    const owner = currentDataOwner(c);
    const gallery = getGalleryImages(owner);
    const zip = new yazl.ZipFile();
    const usedNames = new Set<string>();

    for (const item of gallery.items) {
      const stored = await readStoredAsset(owner, item.asset.id);
      if (!stored) {
        continue;
      }

      zip.addBuffer(stored.bytes, uniqueZipName(usedNames, item));
    }

    zip.end();
    return new Response(Readable.toWeb(zip.outputStream as unknown as Readable) as ReadableStream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${downloadFileName(`gpt-image-canvas-gallery-${new Date().toISOString().slice(0, 10)}.zip`)}"`,
        "Content-Type": "application/zip"
      }
    });
  });

  app.delete("/api/gallery/:outputId", (c) => {
    const deleted = deleteGalleryOutput(currentDataOwner(c), c.req.param("outputId"));
    if (!deleted) {
      return c.json(errorResponse("not_found", "找不到请求的 Gallery 图片记录。"), 404);
    }

    return c.json({
      ok: true
    });
  });
}

function uniqueZipName(usedNames: Set<string>, item: ReturnType<typeof getGalleryImages>["items"][number]): string {
  const extension = item.asset.fileName.split(".").pop() || "png";
  const datePrefix = item.createdAt.slice(0, 10);
  const promptSlug = downloadFileName(item.prompt.replace(/\s+/gu, " ").trim().slice(0, 60)) || "image";
  const baseName = `${datePrefix}-${promptSlug}-${item.outputId.slice(0, 8)}.${extension}`;
  let name = baseName;
  let index = 2;
  while (usedNames.has(name)) {
    name = baseName.replace(new RegExp(`\\.${extension}$`, "u"), `-${index}.${extension}`);
    index += 1;
  }
  usedNames.add(name);
  return name;
}
