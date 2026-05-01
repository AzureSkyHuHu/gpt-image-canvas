import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, "..");
const repoRoot = resolve(packageRoot, "../..");

for (const envPath of [resolve(repoRoot, ".env"), resolve(packageRoot, ".env"), resolve(process.cwd(), ".env")]) {
  loadDotEnv({ path: envPath, quiet: true });
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8787", 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return 8787;
  }
  return parsed;
}

function resolveFromRepo(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

const sqliteJournalModes = ["DELETE", "TRUNCATE", "PERSIST", "MEMORY", "WAL", "OFF"] as const;
type SqliteJournalMode = (typeof sqliteJournalModes)[number];

const sqliteLockingModes = ["NORMAL", "EXCLUSIVE"] as const;
type SqliteLockingMode = (typeof sqliteLockingModes)[number];

function parseSqliteJournalMode(value: string | undefined): SqliteJournalMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return "WAL";
  }

  return sqliteJournalModes.includes(normalized as SqliteJournalMode) ? (normalized as SqliteJournalMode) : "WAL";
}

function parseSqliteLockingMode(value: string | undefined): SqliteLockingMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return "NORMAL";
  }

  return sqliteLockingModes.includes(normalized as SqliteLockingMode) ? (normalized as SqliteLockingMode) : "NORMAL";
}

const dataDir = resolveFromRepo(process.env.DATA_DIR ?? "./data");

export const runtimePaths = {
  repoRoot,
  packageRoot,
  dataDir,
  assetsDir: resolve(dataDir, "assets"),
  assetPreviewsDir: resolve(dataDir, "asset-previews"),
  databaseFile: resolve(dataDir, "gpt-image-canvas.sqlite"),
  webDistDir: resolve(repoRoot, "apps/web/dist")
};

export const serverConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: parsePort(process.env.PORT)
};

export const sqliteConfig = {
  journalMode: parseSqliteJournalMode(process.env.SQLITE_JOURNAL_MODE),
  lockingMode: parseSqliteLockingMode(process.env.SQLITE_LOCKING_MODE)
};

export const accessControlConfig = {
  enabled: parseBoolean(process.env.APP_AUTH_ENABLED),
  adminPassword: process.env.APP_ADMIN_PASSWORD?.trim() || "",
  sessionSecret: process.env.APP_SESSION_SECRET?.trim() || "",
  sessionDays: parsePositiveInteger(process.env.APP_SESSION_DAYS, 30),
  bootstrapAccessToken: process.env.APP_BOOTSTRAP_ACCESS_TOKEN?.trim() || "",
  bootstrapAccessLabel: process.env.APP_BOOTSTRAP_ACCESS_LABEL?.trim() || "Test access",
  bootstrapUpstreamApiKey: process.env.APP_BOOTSTRAP_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "",
  bootstrapUpstreamBaseURL: process.env.APP_BOOTSTRAP_OPENAI_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || "",
  bootstrapUpstreamModel:
    process.env.APP_BOOTSTRAP_OPENAI_IMAGE_MODEL?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || ""
};

export function ensureRuntimeStorage(): void {
  mkdirSync(runtimePaths.dataDir, { recursive: true });
  mkdirSync(runtimePaths.assetsDir, { recursive: true });
  mkdirSync(runtimePaths.assetPreviewsDir, { recursive: true });
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
