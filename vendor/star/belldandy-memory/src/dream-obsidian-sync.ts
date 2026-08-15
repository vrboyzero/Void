import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveDreamObsidianMirrorPaths } from "./obsidian-sync-paths.js";
import type {
  DreamObsidianMirrorOptions,
  DreamObsidianSyncStatus,
  DreamRecord,
  DreamRuntimeLogger,
} from "./dream-types.js";

function normalizeText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return normalizeText(error.message, 240) ?? error.name;
  }
  return normalizeText(String(error), 240) ?? "Unknown Obsidian sync error";
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

export async function syncDreamToObsidian(input: {
  mirror?: DreamObsidianMirrorOptions;
  agentId: string;
  record: DreamRecord;
  markdown: string;
  indexMarkdown: string;
  now?: () => Date;
  logger?: DreamRuntimeLogger;
}): Promise<DreamObsidianSyncStatus> {
  const attemptAt = (input.now ?? (() => new Date()))().toISOString();
  const mirror = input.mirror;
  if (mirror?.enabled !== true) {
    return {
      enabled: false,
      stage: "skipped",
      lastAttemptAt: attemptAt,
    };
  }

  try {
    const dreamBasename = path.basename(input.record.dreamPath ?? `${input.record.id}.md`);
    const resolvedPaths = resolveDreamObsidianMirrorPaths({
      mirror,
      agentId: input.agentId,
      dreamBasename,
      occurredAt: input.record.finishedAt ?? input.record.startedAt ?? input.record.requestedAt,
    });
    await atomicWriteText(resolvedPaths.dreamPath, input.markdown);
    await atomicWriteText(resolvedPaths.indexPath, input.indexMarkdown);
    const successAt = (input.now ?? (() => new Date()))().toISOString();
    return {
      enabled: true,
      stage: "synced",
      targetPath: resolvedPaths.dreamPath,
      lastAttemptAt: attemptAt,
      lastSuccessAt: successAt,
    };
  } catch (error) {
    const message = serializeError(error);
    input.logger?.warn?.("dream obsidian sync failed", {
      agentId: input.agentId,
      runId: input.record.id,
      error: message,
    });
    return {
      enabled: true,
      stage: "failed",
      lastAttemptAt: attemptAt,
      error: message,
    };
  }
}
