#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const envPath = new URL("../.env", import.meta.url);
const defaultLabels = ["Test access - otokapi", "Test access - freeapi", "Test access - new"];

async function main() {
  const envText = await readFile(envPath, "utf8");
  const envEntries = parseEnvEntries(envText);
  const env = Object.fromEntries(envEntries);
  const upstreams = collectOpenAIUpstreams(envEntries);
  const adminPassword = env.APP_ADMIN_PASSWORD?.trim();
  const port = env.PORT?.trim() || "8787";
  const origin = (process.env.APP_ORIGIN || env.APP_ORIGIN?.trim() || `http://localhost:${port}`).replace(/\/+$/u, "");
  const model = env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";

  if (!adminPassword) {
    throw new Error("APP_ADMIN_PASSWORD is required in .env.");
  }
  if (upstreams.length === 0) {
    throw new Error("No OPENAI_API_KEY / OPENAI_BASE_URL pairs were found in .env.");
  }

  const cookieJar = new CookieJar();
  await requestJson(`${origin}/api/admin/login`, {
    method: "POST",
    cookieJar,
    body: {
      password: adminPassword
    }
  });

  const existing = await requestJson(`${origin}/api/admin/tokens`, {
    cookieJar
  });
  const items = Array.isArray(existing.items) ? existing.items : [];

  const results = [];
  for (const [index, upstream] of upstreams.entries()) {
    const label = defaultLabels[index] ?? `Test access - ${index + 1}`;
    const payload = {
      label,
      upstreamApiKey: upstream.apiKey,
      upstreamBaseURL: upstream.baseURL,
      upstreamModel: model,
      enabled: true
    };
    const existingItem = items.find((item) => item.label === label);
    if (existingItem) {
      const updated = await requestJson(`${origin}/api/admin/tokens/${encodeURIComponent(existingItem.id)}`, {
        method: "PATCH",
        cookieJar,
        body: payload
      });
      results.push({
        action: "updated",
        label: updated.label,
        tokenPreview: updated.tokenPreview,
        upstreamBaseURL: updated.upstreamBaseURL,
        upstreamModel: updated.upstreamModel,
        enabled: updated.enabled
      });
      continue;
    }

    const created = await requestJson(`${origin}/api/admin/tokens`, {
      method: "POST",
      cookieJar,
      body: payload
    });
    results.push({
      action: "created",
      label: created.item.label,
      accessToken: created.accessToken,
      upstreamBaseURL: created.item.upstreamBaseURL,
      upstreamModel: created.item.upstreamModel,
      enabled: created.item.enabled
    });
  }

  console.log(JSON.stringify({ ok: true, origin, items: results }, null, 2));
}

function parseEnvEntries(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    entries.push([match[1], unquoteEnvValue(match[2])]);
  }
  return entries;
}

function collectOpenAIUpstreams(entries) {
  const upstreams = [];
  let pendingApiKey;

  for (const [key, value] of entries) {
    if (key === "OPENAI_API_KEY") {
      pendingApiKey = value.trim();
      continue;
    }

    if (key === "OPENAI_BASE_URL" && pendingApiKey) {
      const baseURL = value.trim();
      if (baseURL) {
        upstreams.push({
          apiKey: pendingApiKey,
          baseURL
        });
      }
      pendingApiKey = undefined;
    }
  }

  return upstreams;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function requestJson(url, { method = "GET", cookieJar, body } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const cookie = cookieJar?.header();
  if (cookie) {
    headers.Cookie = cookie;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  cookieJar?.store(response.headers);

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error?.message || `${method} ${url} failed with ${response.status}`);
  }
  return data;
}

class CookieJar {
  #cookies = new Map();

  store(headers) {
    for (const header of getSetCookieHeaders(headers)) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) {
        continue;
      }
      this.#cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  header() {
    return Array.from(this.#cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const header = headers.get("set-cookie");
  return header ? [header] : [];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
