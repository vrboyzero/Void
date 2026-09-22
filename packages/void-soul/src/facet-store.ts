import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import {
  describeAppliedRecord,
  describePending,
  facetVersionWidget,
  markFirstMeeting,
  parseFacetCard,
  parseFacetState,
  selectFacet,
  setSuspended,
  snapshotPrompt,
  type AgentFacetState,
  type AppliedPromptRecord,
  type FacetCard,
  type FacetVersionView,
} from "./facet.js";
import { FACET_DIRECTORY_NAME, SoulProfileError, resolveVoidDataDir } from "./profile.js";
import { assertRealPathInsideRoots } from "./path-guard.js";
import { loadSoulRegistry, type SoulRecord } from "./registry.js";
import { readUtf8TextFile } from "./text-file.js";

export interface StoredFacetView {
  agentId: string;
  saved: FacetVersionView;
  /** 最近一次真装进模型的那一版；本进程还没发过请求时是 `null`。 */
  applied: FacetVersionView | null;
  /** 这份档案的首次见面引导是否已经做完（13 节）。档案没写 `firstMeeting` 时它恒为 `false`。 */
  firstMeetingDone: boolean;
  /**
   * 这份档案是不是停用了（14.1 / 19.1 的「停用」）。停用只改 `state.json` 这一个标志，
   * 装段与派活两条路都据此拒绝，别处一个字节都不动。
   */
  suspended: boolean;
}

/** 首次见面引导在界面上的样子：档案写了什么、做完了没有。 */
export interface FirstMeetingView {
  agentId: string;
  name: string;
  /** 档案里有没有写引导。没写就没什么可做的，界面照实说。 */
  required: boolean;
  done: boolean;
  /** 引导正文（档案里怎么写就怎么显示），没写时为 `null`。 */
  guidance: string | null;
}

export interface FacetWidgetRegistration {
  id: string;
  title: string;
  order: number;
  lines: readonly string[];
  component: readonly string[];
  agentId: string;
  selectionRevision: number;
}

/** 按档案 id 保存角色。当前已冻结的请求不在这里改写，调用方仍要等到下一次请求。 */
export async function saveProfileFacetSelection(input: {
  dshHome: string;
  profile: string;
  agentId: string;
  facetId: string | null;
  expectedRevision: number;
  override?: string;
}): Promise<StoredFacetView> {
  const dataDir = resolveVoidDataDir(input);
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(input.agentId);
  if (!record) throw new SoulProfileError(`没有这份档案，不能保存角色: ${input.agentId}`);
  return saveFacetSelection({ dataDir, record, facetId: input.facetId, expectedRevision: input.expectedRevision, soulBody: record.body });
}

/** 按已定的数据根解析规则读取全部只读行。数据根不存在时返回空列表，不创建目录。 */
export async function loadProfileFacetRegistrations(input: {
  dshHome: string;
  profile: string;
  override?: string;
  loadRegistry?: typeof loadSoulRegistry;
  /** 取「最近一次真装进模型的那一版」。本进程还没发过请求时返回 undefined，面板照实说「还没有请求」。 */
  appliedFor?: (agentId: string) => AppliedPromptRecord | undefined;
}): Promise<FacetWidgetRegistration[]> {
  const dataDir = resolveVoidDataDir(input);
  try {
    const registry = await (input.loadRegistry ?? loadSoulRegistry)(dataDir);
    return await loadFacetRegistrations(dataDir, registry, input.appliedFor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 一个数据根里每个档案一行只读登记。重复 id 在扫描时已经拒绝。 */
export async function loadFacetRegistrations(
  dataDir: string,
  records: ReadonlyMap<string, SoulRecord>,
  appliedFor?: (agentId: string) => AppliedPromptRecord | undefined,
): Promise<FacetWidgetRegistration[]> {
  const registrations: FacetWidgetRegistration[] = [];
  for (const record of records.values()) {
    const view = await loadSavedFacetView(dataDir, record, appliedFor?.(record.id));
    const registration = facetViewRegistration(view);
    registrations.push({ ...registration, id: `${registration.id}:${record.id}`, title: `${record.frontMatter.name}的当前角色` });
  }
  return registrations.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

/** 页面只登记这两行。没有进行中的请求时，本次生效明确写「还没有请求」。 */
export function facetViewRegistration(view: StoredFacetView): FacetWidgetRegistration {
  const widget = facetVersionWidget({
    saved: view.saved,
    applied: view.applied === null
      ? { kind: "applied", facetId: null, name: null, summary: null, selectionRevision: view.saved.selectionRevision, pending: false, pendingReason: null }
      : view.applied,
  });
  const lines = view.applied === null ? [widget.lines[0] ?? "", "本次生效：还没有请求"] : widget.lines;
  return { ...widget, lines, component: lines, agentId: view.agentId, selectionRevision: view.saved.selectionRevision };
}

/** 从共用模组库和该 Agent 的 state.json 读出已保存版本。没有请求时，本次生效为空。 */
export async function loadFacetLibrary(dataDir: string): Promise<Map<string, FacetCard>> {
  return loadFacetCards(dataDir);
}

/**
 * 从共用模组库和该 Agent 的 state.json 读出已保存版本。`applied` 是内存里那份「上一次请求装进去的」，
 * 由调用方给：本进程还没发过请求就传 undefined，面板照实说「还没有请求」。
 */
export async function loadSavedFacetView(dataDir: string, record: SoulRecord, applied?: AppliedPromptRecord): Promise<StoredFacetView> {
  const cards = await loadFacetCards(dataDir);
  const state = await loadFacetState(path.dirname(record.soulPath));
  const saved = snapshotPrompt({ soulBody: record.body, state, cards });
  const card = saved.facetId === null ? undefined : cards.get(saved.facetId);
  const reason = applied === undefined ? null : describePending(saved, applied.snapshot);
  return {
    agentId: record.id,
    saved: {
      kind: "saved",
      facetId: saved.facetId,
      name: card?.frontMatter.name ?? null,
      summary: card?.frontMatter.summary ?? null,
      selectionRevision: saved.selectionRevision,
      pending: reason !== null,
      pendingReason: reason,
    },
    applied: applied === undefined ? null : describeAppliedRecord(applied),
    firstMeetingDone: state.firstMeetingDone,
    suspended: state.suspended,
  };
}

async function loadFacetCards(dataDir: string): Promise<Map<string, FacetCard>> {
  const files = await loadFacetFiles(dataDir);
  return new Map([...files].map(([id, entry]) => [id, entry.card]));
}

/** 一个模组文件：id、路径、原文与解析结果。人类入口改正文时要按原文算修订，所以原文也带上。 */
export interface FacetFile {
  id: string;
  file: string;
  raw: string;
  card: FacetCard;
}

/** 扫一遍共用模组库。id 重复在解析时已经拒绝，这里只负责把文件和 id 对上。 */
export async function loadFacetFiles(dataDir: string): Promise<Map<string, FacetFile>> {
  const root = path.resolve(dataDir);
  const dir = path.resolve(root, "agents", FACET_DIRECTORY_NAME);
  // 模组库整层都可能是链接（Windows 上 junction 在 readdir 里跟普通目录看不出区别），
  // 所以落盘前先看穿真实位置：越界就报错，目录还不存在时按空库处理（首次运行不该报错）。
  const safeDir = await assertRealPathInsideRoots(dir, { roots: [root] });
  const entries = await readdir(safeDir).catch(() => []);
  const cards = new Map<string, FacetCard>();
  const files = new Map<string, FacetFile>();
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = await assertRealPathInsideRoots(path.join(safeDir, name), { roots: [root] });
    const raw = await readUtf8TextFile(file, `模组文件 ${name}`);
    const card = parseFacetCard(raw, cards);
    cards.set(card.id, card);
    files.set(card.id, { id: card.id, file, raw, card });
  }
  return files;
}

/** 只原子替换 state.json。调用方传入的底线正文只用于校验，不写回。 */
export async function saveFacetSelection(input: {
  dataDir: string;
  record: SoulRecord;
  facetId: string | null;
  expectedRevision: number;
  soulBody: string;
}): Promise<StoredFacetView> {
  if (input.soulBody !== input.record.body) throw new SoulProfileError("保存角色不能修改底线");
  const cards = await loadFacetCards(input.dataDir);
  const agentDir = path.dirname(input.record.soulPath);
  const current = await loadFacetState(agentDir);
  const next = selectFacet({ state: current, cards, facetId: input.facetId, expectedRevision: input.expectedRevision });
  await writeFacetState(agentDir, next);
  return loadSavedFacetView(input.dataDir, input.record);
}

/**
 * 读这份档案的首次见面引导（13 节）。档案里没写就没有引导可做——这里不编默认引导，
 * 也不替人决定「第一次见面该说什么」。
 */
export async function loadFirstMeetingView(dataDir: string, record: SoulRecord): Promise<FirstMeetingView> {
  const state = await loadFacetState(path.dirname(record.soulPath));
  const guidance = record.frontMatter.firstMeeting ?? null;
  return {
    agentId: record.id,
    name: record.frontMatter.name,
    required: guidance !== null,
    done: state.firstMeetingDone,
    guidance,
  };
}

/**
 * 标一次「引导做完了」或「再来一遍」。和保存角色一样只原子替换 `state.json`：
 * 传进来的底线正文只用来核对没被改过，一个字节都不写回（13 节：引导入口不能改底线）。
 *
 * 档案没写 `firstMeeting` 时拒绝标完成：没有引导可完成，放过去只会让界面显示一个
 * 「已完成」而实际上什么都没发生。重来一遍（`done: false`）任何时候都允许。
 */
export async function saveFirstMeetingState(input: {
  dataDir: string;
  record: SoulRecord;
  done: boolean;
  soulBody: string;
}): Promise<FirstMeetingView> {
  if (input.soulBody !== input.record.body) throw new SoulProfileError("首次见面状态不能修改底线");
  if (input.done && input.record.frontMatter.firstMeeting === undefined) {
    throw new SoulProfileError(`这份档案没有写首次见面引导，不用标完成: ${input.record.id}`);
  }
  const agentDir = path.dirname(input.record.soulPath);
  const next = markFirstMeeting({ state: await loadFacetState(agentDir), done: input.done });
  await writeFacetState(agentDir, next);
  return loadFirstMeetingView(input.dataDir, input.record);
}

/**
 * 停用或启用一份档案（14.1 / 19.1 的「停用」）。和保存角色、标引导一样**只原子替换
 * `state.json` 里的一个字段**：`SOUL.md`、记忆、聊天记录、会话绑定一个字节都不动。
 *
 * 这里不校验底线正文：这个入口根本不接收正文，也就没有「顺着它改底线」的路径。
 */
export async function saveProfileSuspension(input: {
  dataDir: string;
  record: SoulRecord;
  suspended: boolean;
}): Promise<StoredFacetView> {
  const agentDir = path.dirname(input.record.soulPath);
  const next = setSuspended({ state: await loadFacetState(agentDir), suspended: input.suspended });
  await writeFacetState(agentDir, next);
  return loadSavedFacetView(input.dataDir, input.record);
}

/** 只原子替换 `state.json`：先写同目录临时文件再改名，读的人不会看到半份状态。 */
async function writeFacetState(agentDir: string, state: AgentFacetState): Promise<void> {
  await writeFileAtomic(path.join(agentDir, "state.json"), JSON.stringify(state));
}

async function loadFacetState(agentDir: string): Promise<AgentFacetState> {
  try {
    return parseFacetState(await readFile(path.join(agentDir, "state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseFacetState(undefined);
    if (error instanceof SoulProfileError) throw error;
    throw new SoulProfileError(`角色选择状态无法读取: ${agentDir}`);
  }
}
