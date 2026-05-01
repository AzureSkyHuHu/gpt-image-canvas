import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  GeneratedAsset,
  GalleryImageItem,
  GalleryResponse,
  GenerationRecord as ApiGenerationRecord,
  GenerationStatus,
  ImageMode,
  ImageQuality,
  OutputFormat,
  OutputStatus,
  ProjectState
} from "./contracts.js";
import { db } from "./database.js";
import type { DataOwner } from "./data-owner.js";
import { assets, generationOutputs, generationRecords, projects } from "./schema.js";

export const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "Default Project";
const fallbackWarnings = new Set<string>();

interface ProjectSnapshotInput {
  name?: string;
  snapshotJson: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSnapshot(snapshotJson: string): unknown | null {
  return JSON.parse(snapshotJson) as unknown;
}

export function ensureDefaultProject(owner: DataOwner): void {
  const existing = getDefaultProjectRow(owner);

  if (existing) {
    return;
  }
  if (defaultProjectRowExists(owner)) {
    return;
  }

  const createdAt = nowIso();
  db.insert(projects)
    .values({
      id: projectIdForOwner(owner),
      ownerTokenId: owner.id,
      name: DEFAULT_PROJECT_NAME,
      snapshotJson: "null",
      createdAt,
      updatedAt: createdAt
    })
    .run();
}

export function saveProjectSnapshot(owner: DataOwner, input: ProjectSnapshotInput): ProjectState {
  ensureDefaultProject(owner);

  const updatedAt = nowIso();
  const current = getDefaultProjectRow(owner);
  const projectId = projectIdForOwner(owner);

  db.update(projects)
    .set({
      name: input.name ?? current?.name ?? DEFAULT_PROJECT_NAME,
      snapshotJson: input.snapshotJson,
      updatedAt
    })
    .where(and(eq(projects.id, projectId), eq(projects.ownerTokenId, owner.id)))
    .run();

  return getProjectState(owner);
}

export function getProjectState(owner: DataOwner): ProjectState {
  ensureDefaultProject(owner);

  const project = getDefaultProjectRow(owner);
  const projectId = projectIdForOwner(owner);

  if (!project) {
    return {
      id: projectId,
      name: DEFAULT_PROJECT_NAME,
      snapshot: null,
      history: getGenerationHistory(owner),
      updatedAt: nowIso()
    };
  }

  return {
    id: project.id,
    name: project.name,
    snapshot: parseSnapshot(project.snapshotJson),
    history: getGenerationHistory(owner),
    updatedAt: project.updatedAt
  };
}

export function getGalleryImages(owner: DataOwner): GalleryResponse {
  const rows = db
    .select({
      output: generationOutputs,
      generation: generationRecords,
      asset: assets
    })
    .from(generationOutputs)
    .innerJoin(generationRecords, eq(generationOutputs.generationId, generationRecords.id))
    .innerJoin(assets, eq(generationOutputs.assetId, assets.id))
    .where(
      and(
        eq(generationOutputs.status, "succeeded"),
        eq(generationOutputs.ownerTokenId, owner.id),
        eq(generationRecords.ownerTokenId, owner.id),
        eq(assets.ownerTokenId, owner.id)
      )
    )
    .orderBy(desc(generationOutputs.createdAt))
    .all();

  return {
    items: rows.map(({ output, generation, asset }) => ({
      outputId: output.id,
      generationId: generation.id,
      mode: generation.mode as ImageMode,
      prompt: generation.prompt,
      effectivePrompt: generation.effectivePrompt,
      presetId: generation.presetId,
      size: {
        width: generation.width,
        height: generation.height
      },
      quality: generation.quality as ImageQuality,
      outputFormat: generation.outputFormat as OutputFormat,
      createdAt: output.createdAt,
      asset: toGeneratedAsset(asset)
    })).filter((item): item is GalleryImageItem => Boolean(item.asset))
  };
}

export function deleteGalleryOutput(owner: DataOwner, outputId: string): boolean {
  const result = db
    .delete(generationOutputs)
    .where(and(eq(generationOutputs.id, outputId), eq(generationOutputs.ownerTokenId, owner.id)))
    .run();
  return result.changes > 0;
}

export function getGalleryOutputAssetId(owner: DataOwner, outputId: string): string | undefined {
  return db
    .select({
      assetId: generationOutputs.assetId
    })
    .from(generationOutputs)
    .where(and(eq(generationOutputs.id, outputId), eq(generationOutputs.ownerTokenId, owner.id)))
    .get()?.assetId ?? undefined;
}

export function getGenerationRecordAssetIds(owner: DataOwner, generationId: string): string[] {
  return Array.from(
    new Set(
      db
        .select({
          assetId: generationOutputs.assetId
        })
        .from(generationOutputs)
        .where(and(eq(generationOutputs.generationId, generationId), eq(generationOutputs.ownerTokenId, owner.id)))
        .all()
        .flatMap((row) => (row.assetId ? [row.assetId] : []))
    )
  );
}

export function deleteGenerationRecord(owner: DataOwner, generationId: string): boolean {
  const result = db
    .delete(generationRecords)
    .where(and(eq(generationRecords.id, generationId), eq(generationRecords.ownerTokenId, owner.id)))
    .run();
  return result.changes > 0;
}

function getDefaultProjectRow(owner: DataOwner): (typeof projects.$inferSelect) | undefined {
  try {
    return db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectIdForOwner(owner)), eq(projects.ownerTokenId, owner.id)))
      .get();
  } catch (error) {
    warnOnce(
      "project-read-fallback",
      `Project row could not be read; returning a blank canvas fallback. ${formatErrorSummary(error)}`
    );
    return undefined;
  }
}

function defaultProjectRowExists(owner: DataOwner): boolean {
  try {
    const row = db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectIdForOwner(owner)), eq(projects.ownerTokenId, owner.id)))
      .get();
    return Boolean(row);
  } catch {
    return true;
  }
}

function getGenerationHistory(owner: DataOwner): ApiGenerationRecord[] {
  try {
    return readGenerationHistory(owner);
  } catch (error) {
    warnOnce(
      "history-read-fallback",
      `Generation history could not be read; returning an empty history. ${formatErrorSummary(error)}`
    );
    return [];
  }
}

function warnOnce(key: string, message: string): void {
  if (fallbackWarnings.has(key)) {
    return;
  }

  fallbackWarnings.add(key);
  console.warn(message);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const codeValue = (error as { code?: unknown }).code;
    const code = typeof codeValue === "string" ? `${codeValue}: ` : "";
    return `${code}${error.message}`;
  }

  return String(error);
}

function readGenerationHistory(owner: DataOwner): ApiGenerationRecord[] {
  const records = db
    .select()
    .from(generationRecords)
    .where(eq(generationRecords.ownerTokenId, owner.id))
    .orderBy(desc(generationRecords.createdAt))
    .limit(20)
    .all();
  if (records.length === 0) {
    return [];
  }

  const generationIds = records.map((record) => record.id);
  const outputs = db
    .select()
    .from(generationOutputs)
    .where(and(eq(generationOutputs.ownerTokenId, owner.id), inArray(generationOutputs.generationId, generationIds)))
    .orderBy(generationOutputs.createdAt)
    .all();

  const assetIds = outputs.flatMap((output) => (output.assetId ? [output.assetId] : []));
  const assetRows =
    assetIds.length > 0
      ? db
          .select()
          .from(assets)
          .where(and(eq(assets.ownerTokenId, owner.id), inArray(assets.id, assetIds)))
          .all()
      : [];
  const assetById = new Map(assetRows.map((asset) => [asset.id, asset]));

  const outputsByGenerationId = new Map<string, typeof outputs>();
  for (const output of outputs) {
    const existing = outputsByGenerationId.get(output.generationId) ?? [];
    existing.push(output);
    outputsByGenerationId.set(output.generationId, existing);
  }

  return records.flatMap((record) => {
    const mappedOutputs = (outputsByGenerationId.get(record.id) ?? []).map((output) => ({
      id: output.id,
      status: output.status as OutputStatus,
      asset: output.assetId ? toGeneratedAsset(assetById.get(output.assetId)) : undefined,
      error: output.error ?? undefined
    }));

    if (mappedOutputs.length === 0) {
      return [];
    }

    return [
      {
        id: record.id,
        mode: record.mode as ImageMode,
        prompt: record.prompt,
        effectivePrompt: record.effectivePrompt,
        presetId: record.presetId,
        size: {
          width: record.width,
          height: record.height
        },
        quality: record.quality as ImageQuality,
        outputFormat: record.outputFormat as OutputFormat,
        count: record.count,
        status: record.status as GenerationStatus,
        error: record.error ?? undefined,
        referenceAssetId: record.referenceAssetId ?? undefined,
        createdAt: record.createdAt,
        outputs: mappedOutputs
      }
    ];
  });
}

function projectIdForOwner(owner: DataOwner): string {
  return owner.isLocal ? DEFAULT_PROJECT_ID : `${DEFAULT_PROJECT_ID}:${owner.id}`;
}

function toGeneratedAsset(asset: (typeof assets.$inferSelect) | undefined): GeneratedAsset | undefined {
  if (!asset) {
    return undefined;
  }

  return {
    id: asset.id,
    url: `/api/assets/${asset.id}`,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    cloud:
      asset.cloudProvider === "cos" && (asset.cloudStatus === "uploaded" || asset.cloudStatus === "failed")
        ? {
            provider: asset.cloudProvider,
            status: asset.cloudStatus,
            lastError: asset.cloudError ?? undefined,
            uploadedAt: asset.cloudUploadedAt ?? undefined
          }
        : undefined
  };
}
