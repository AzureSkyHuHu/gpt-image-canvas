import type { Hono } from "hono";
import { getProjectState, saveProjectSnapshot } from "../../domain/project/project-store.js";
import { currentDataOwner } from "../http/access-control.js";
import { readJson } from "../http/json.js";
import { logProjectSaveRejected, parseProjectPayload } from "../http/validation.js";

export function registerProjectRoutes(app: Hono): void {
  app.get("/api/project", (c) => c.json(getProjectState(currentDataOwner(c))));

  app.put("/api/project", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      logProjectSaveRejected(payload.error, c.req.raw);
      return c.json(payload.error, 400);
    }

    const parsed = parseProjectPayload(payload.value);
    if (!parsed.ok) {
      logProjectSaveRejected(parsed.error, c.req.raw);
      return c.json(parsed.error, 400);
    }

    return c.json(saveProjectSnapshot(currentDataOwner(c), parsed.value));
  });
}
