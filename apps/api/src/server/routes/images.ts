import type { Hono } from "hono";
import { runReferenceImageGeneration, runTextToImageGeneration } from "../../domain/generation/image-generation.js";
import { createRequestImageProvider } from "../../domain/providers/image-provider-selection.js";
import { currentDataOwner, requestAuth } from "../http/access-control.js";
import { ProviderError } from "../../infrastructure/providers/image-provider.js";
import { providerErrorJson } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseEditPayload, parseGeneratePayload } from "../http/validation.js";

export function registerImageRoutes(app: Hono): void {
  app.post("/api/images/generate", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseGeneratePayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      const owner = currentDataOwner(c);
      const provider = await createRequestImageProvider({ owner, auth: requestAuth(c) }, c.req.raw.signal);
      return c.json(await runTextToImageGeneration(owner, parsed.value, provider, c.req.raw.signal));
    } catch (error) {
      if (error instanceof ProviderError) {
        return providerErrorJson(c, error);
      }

      throw error;
    }
  });

  app.post("/api/images/edit", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseEditPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      const owner = currentDataOwner(c);
      const provider = await createRequestImageProvider({ owner, auth: requestAuth(c) }, c.req.raw.signal);
      return c.json(await runReferenceImageGeneration(owner, parsed.value, provider, c.req.raw.signal));
    } catch (error) {
      if (error instanceof ProviderError) {
        return providerErrorJson(c, error);
      }

      throw error;
    }
  });
}
