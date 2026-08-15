import type { MemorySourceInventoryItem } from "./memory-source-inventory.js";
import type { MemorySourceSearchPolicy } from "./memory-source-registry.js";

export type MemorySourceCoveragePolicyExplanation = {
  searchPolicy: MemorySourceSearchPolicy;
  meaning: string;
  currentState: string;
  whyThisBucket: string;
};

export function buildMemorySourceCoveragePolicyExplanations(): MemorySourceCoveragePolicyExplanation[] {
  return [
    {
      searchPolicy: "searchable",
      meaning: "可直接进入当前运行时检索面，普通 recall / search 都可能命中。",
      currentState: "适合原文或高价值整理材料，是当前统一检索面的直接供给层。",
      whyThisBucket: "这类来源被放进 searchable，是因为它们承担的是直接回答问题的责任，而不是只做辅助整理。",
    },
    {
      searchPolicy: "summary-input-only",
      meaning: "不直接作为普通搜索结果返回，但可以作为摘要、树层或高层整理输入。",
      currentState: "适合 digest / session-memory / 经验归纳这类派生材料，避免和原文抢同一检索位。",
      whyThisBucket: "这类来源被放进 summary-input-only，是因为它更像整理后的输入材料，应该优先服务高层总结，而不是和原文抢召回位。",
    },
    {
      searchPolicy: "inventory-only",
      meaning: "目前只进入盘点与治理视图，不直接参与当前检索。",
      currentState: "适合 runtime 状态、meta 或暂不该直接召回的材料，用来回答“系统知道它存在，但不会直接拿来回答”。",
      whyThisBucket: "这类来源被放进 inventory-only，是因为它更适合被看见、被治理，而不是被直接当作回答证据。",
    },
  ];
}

export function describeMemorySourceCoverageItem(item: Pick<
  MemorySourceInventoryItem,
  "label" | "sourceKind" | "sourceClass" | "admission" | "duplicateRisk" | "notes"
>): string {
  const sourceClassLabel = describeSourceClass(item.sourceClass);
  const kindLabel = item.sourceKind ? ` ${item.sourceKind}` : "";
  const noteLabel = normalizeOptionalString(item.notes[0]);
  if (item.admission.searchPolicy === "searchable") {
    return `${item.label}${kindLabel} 属于${sourceClassLabel}直供检索层${noteLabel ? `；${noteLabel}` : ""}。`;
  }
  if (item.admission.searchPolicy === "summary-input-only") {
    return `${item.label}${kindLabel} 属于${sourceClassLabel}整理输入层，更适合做摘要/树层输入，不直接占用普通搜索位${noteLabel ? `；${noteLabel}` : ""}。`;
  }
  return `${item.label}${kindLabel} 属于治理盘点层，当前先保留为可见资产，不直接参与检索${noteLabel ? `；${noteLabel}` : ""}。`;
}

function describeSourceClass(sourceClass: MemorySourceInventoryItem["sourceClass"]): string {
  switch (sourceClass) {
    case "raw":
      return "原文";
    case "derived":
      return "派生";
    case "curated":
      return "整理";
    default:
      return "未知";
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
