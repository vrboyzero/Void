import fs from "node:fs";
import path from "node:path";

export type MemoryVacuumObservability = {
  chunkCount: number;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
  journalMode: string;
  dbFileBytes: number;
  walFileBytes: number;
  shmFileBytes: number;
  totalFileBytes: number;
  estimatedReclaimableBytes: number;
  freelistRatio: number;
  reclaimableRatio: number;
};

export type MemoryVacuumPreviewReport = {
  mode: "dry_run";
  requiresConfirmed: true;
  recommended: boolean;
  observability: MemoryVacuumObservability;
  warnings: string[];
};

export type MemoryVacuumApplyOptions = {
  backupRootDir: string;
  runId?: string;
};

export type MemoryVacuumApplyResult = {
  mode: "apply";
  runId: string;
  backupPath: string;
  changed: boolean;
  before: MemoryVacuumObservability;
  after: MemoryVacuumObservability;
  reclaimedBytes: number;
  warnings: string[];
};

export function ensureMemoryVacuumBackupFile(input: {
  dbPath: string;
  backupRootDir: string;
  runId?: string;
}): {
  runId: string;
  backupPath: string;
} {
  const sourcePath = path.resolve(input.dbPath);
  const backupDir = path.resolve(input.backupRootDir);
  fs.mkdirSync(backupDir, { recursive: true });
  const runId = normalizeVacuumRunId(input.runId);
  const backupPath = path.join(backupDir, `memory-vacuum-${runId}.sqlite`);
  fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
  return {
    runId,
    backupPath,
  };
}

export function buildMemoryVacuumWarnings(observability: MemoryVacuumObservability): string[] {
  const warnings = [
    "VACUUM 会重写 memory.sqlite；请优先在低写入窗口执行，并保留执行前备份。",
  ];
  if (observability.walFileBytes > 0) {
    warnings.push("当前存在 WAL 文件；执行前会尝试 checkpoint，但仍应避免与活跃写入并发。");
  }
  if (observability.estimatedReclaimableBytes <= 0) {
    warnings.push("当前 freelist 接近 0，缩库收益可能有限；更像是一次整理性重写而不是显著回收体积。");
  }
  return warnings;
}

function normalizeVacuumRunId(runId?: string): string {
  if (typeof runId === "string" && runId.trim()) {
    return runId.trim();
  }
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
