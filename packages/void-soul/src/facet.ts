import { SoulProfileError, parseSoulDocument, type SoulFrontMatter } from "./profile.js";

export interface AgentFacetState {
  schemaVersion: 1;
  activeFacetId: string | null;
  selectionRevision: number;
  /**
   * 是否已完成首次见面引导（13 节：首次见面状态由这个字段决定）。档案的 front matter
   * 写了 `firstMeeting` 才用得上它：没写完就是 `false`，引导跟着提示词一起装进模型；
   * 标成 `true` 之后引导撤掉，见面这件事就算过去了。
   *
   * 它**不进 `selectionRevision`**：引导状态不是身份、不是角色选择，换一次角色不该让人
   * 重新做一遍自我介绍，反过来说，标了完成也不该让别人正在进行的角色选择撞上冲突。
   */
  firstMeetingDone: boolean;
  /**
   * 这份档案是不是**停用**了（14.1 矩阵与 19.1「停用 + 引用检查 + 预览回收范围」里的停用）。
   *
   * 停用只改这一个布尔值：`SOUL.md`、记忆、聊天记录、会话绑定一个字节都不动，随时能启用回来。
   * 停用之后绑定它的会话进模型会被明确拒绝（理由写进通知栏），军团也不会拿它去派活——
   * 也就是「不删任何东西，但先别用」。
   *
   * 和 `firstMeetingDone` 一样**不进 `selectionRevision`**：停用不是换身份，不该让别人正在
   * 进行的角色选择撞上冲突。老 `state.json` 没有这个字段，缺了就是「启用中」。
   */
  suspended: boolean;
}

export interface FacetCard {
  id: string;
  frontMatter: SoulFrontMatter;
  body: string;
}

export interface PromptSnapshot {
  soul: string;
  facet: string | null;
  facetId: string | null;
  selectionRevision: number;
}

/** 当前已保存的选择，和某一次请求实际采用的版本，分开记。 */
export interface AppliedPrompt {
  saved: PromptSnapshot;
  applied: PromptSnapshot | null;
}

/**
 * 「已保存」和「本次生效」差在哪：换了角色（选择修订变了），还是改了说明书正文。
 * 正文分两层说，面板才知道该写「模组正文已改」还是「底线正文已改」。
 */
export type FacetPendingReason = "selection" | "facet-body" | "soul-body";

/** 界面只显示这两份版本，不从正文猜测当前角色。 */
export interface FacetVersionView {
  kind: "saved" | "applied";
  facetId: string | null;
  name: string | null;
  summary: string | null;
  selectionRevision: number;
  pending: boolean;
  /** 有差异时说明差在哪；没差异是 `null`。 */
  pendingReason: FacetPendingReason | null;
}

/**
 * 一次请求实际装进模型的版本：正文快照 + **当时那张卡片**的显示信息。显示信息在请求那一刻
 * 就抄下来，不回头读现在的卡片——模组后来被改名或删掉，面板照样能说清那次请求用的是谁。
 */
export interface AppliedPromptRecord {
  snapshot: PromptSnapshot;
  facetName: string | null;
  facetSummary: string | null;
}

const EMPTY_STATE: AgentFacetState = { schemaVersion: 1, activeFacetId: null, selectionRevision: 0, firstMeetingDone: false, suspended: false };

/** 选择只存在 state 里。没有选择是显式的空角色，不回退到别的模组。 */
export function parseFacetState(raw: string | undefined): AgentFacetState {
  if (raw === undefined || raw.trim() === "") return { ...EMPTY_STATE };
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new SoulProfileError("角色选择状态版本无法读取");
  }
  if (parsed.activeFacetId !== null && typeof parsed.activeFacetId !== "string") {
    throw new SoulProfileError("角色选择状态损坏");
  }
  if (typeof parsed.selectionRevision !== "number" || parsed.selectionRevision < 0) {
    throw new SoulProfileError("角色选择修订损坏");
  }
  // 老状态文件没有这个字段（写它的版本还没发布过引导），缺了就是「还没引导过」。
  if (parsed.firstMeetingDone !== undefined && typeof parsed.firstMeetingDone !== "boolean") {
    throw new SoulProfileError("首次见面状态损坏");
  }
  // 停用位也是后加的，同一个道理：缺了就是「启用中」，不是「坏文件」。
  if (parsed.suspended !== undefined && typeof parsed.suspended !== "boolean") {
    throw new SoulProfileError("停用状态损坏");
  }
  return {
    schemaVersion: 1,
    activeFacetId: parsed.activeFacetId,
    selectionRevision: parsed.selectionRevision,
    firstMeetingDone: parsed.firstMeetingDone === true,
    suspended: parsed.suspended === true,
  };
}

export function selectFacet(input: {
  state: AgentFacetState;
  cards: ReadonlyMap<string, FacetCard>;
  facetId: string | null;
  expectedRevision: number;
}): AgentFacetState {
  if (input.expectedRevision !== input.state.selectionRevision) {
    throw new SoulProfileError("角色选择已被其他保存更新，请重试");
  }
  if (input.facetId !== null && !input.cards.has(input.facetId)) {
    throw new SoulProfileError(`模组不存在: ${input.facetId}`);
  }
  return {
    schemaVersion: 1,
    activeFacetId: input.facetId,
    selectionRevision: input.state.selectionRevision + 1,
    firstMeetingDone: input.state.firstMeetingDone,
    // 换角色不改变停用位：停用的档案照样能改角色（改完还是停用），启用与否只有那个入口说了算。
    suspended: input.state.suspended,
  };
}

/**
 * 标一次「首次见面引导已完成 / 重来一遍」。只动这一个字段，底线正文与角色选择都不碰——
 * 13 节点名的「不能让引导工具随意改底线」就落在这里：这个入口能改的东西只有这个布尔值。
 */
export function markFirstMeeting(input: { state: AgentFacetState; done: boolean }): AgentFacetState {
  return { ...input.state, firstMeetingDone: input.done };
}

/**
 * 停用或启用一份档案。和 `markFirstMeeting` 一样只动这一个字段：底线、角色选择、选择修订与
 * 引导状态都不碰——**停用不是删除，也不是换身份**，它是「先别用，东西都留在原地」。
 */
export function setSuspended(input: { state: AgentFacetState; suspended: boolean }): AgentFacetState {
  return { ...input.state, suspended: input.suspended };
}

/**
 * 停用档案被拒绝时的理由。两处拒绝（进模型、派活）共用同一句话，是因为**人在通知栏里
 * 看到的说法必须一致**：两条不同的措辞会让人以为是两个毛病，而它其实只有一个开关。
 */
export function suspendedReason(agentId: string, use: "进入模型" | "派活"): string {
  return `档案已停用，拒绝${use}: ${agentId}（在面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）`;
}

/** 用当前已保存的选择组装。调用方保存选择后，下一次再调用才会看到新角色。 */
export function snapshotPrompt(input: {
  soulBody: string;
  state: AgentFacetState;
  cards: ReadonlyMap<string, FacetCard>;
}): PromptSnapshot {
  if (input.state.activeFacetId === null) {
    return { soul: input.soulBody, facet: null, facetId: null, selectionRevision: input.state.selectionRevision };
  }
  const card = input.cards.get(input.state.activeFacetId);
  if (card === undefined) throw new SoulProfileError(`已选模组丢失: ${input.state.activeFacetId}`);
  return {
    soul: input.soulBody,
    facet: card.body,
    facetId: card.id,
    selectionRevision: input.state.selectionRevision,
  };
}

/** 请求开始时冻结快照。请求进行中再次保存，不改这次已经冻结的内容。 */
export function beginPrompt(input: {
  soulBody: string;
  state: AgentFacetState;
  cards: ReadonlyMap<string, FacetCard>;
}): AppliedPrompt {
  const saved = snapshotPrompt(input);
  return { saved, applied: { ...saved } };
}

export function replaceSavedFacet(input: {
  current: AppliedPrompt;
  soulBody: string;
  state: AgentFacetState;
  cards: ReadonlyMap<string, FacetCard>;
}): AppliedPrompt {
  return { saved: snapshotPrompt(input), applied: input.current.applied };
}

export function describeFacetVersions(input: {
  current: AppliedPrompt;
  cards: ReadonlyMap<string, FacetCard>;
}): { saved: FacetVersionView; applied: FacetVersionView | null } {
  const saved = describeOne("saved", input.current.saved, input.cards);
  const applied = input.current.applied === null ? null : describeOne("applied", input.current.applied, input.cards);
  const reason = describePending(input.current.saved, input.current.applied);
  return {
    saved: { ...saved, pending: reason !== null, pendingReason: reason },
    applied,
  };
}

/**
 * 「已保存的这份进过模型了吗」。只比选择修订是不够的：人类改完说明书正文（模组正文或底线正文）
 * 之后选择修订没动，可装进模型的字已经变了——那时候还说「已生效」就是假话。
 */
export function describePending(saved: PromptSnapshot, applied: PromptSnapshot | null): FacetPendingReason | null {
  if (applied === null) return null;
  if (saved.selectionRevision !== applied.selectionRevision) return "selection";
  if (saved.facet !== applied.facet) return "facet-body";
  if (saved.soul !== applied.soul) return "soul-body";
  return null;
}

/** 请求那一刻把「这次装进去的是谁」抄下来：显示信息取自当时的卡片，不回头读现在的盘。 */
export function recordAppliedPrompt(input: { snapshot: PromptSnapshot; cards: ReadonlyMap<string, FacetCard> }): AppliedPromptRecord {
  const card = input.snapshot.facetId === null ? undefined : input.cards.get(input.snapshot.facetId);
  return {
    snapshot: input.snapshot,
    facetName: card?.frontMatter.name ?? null,
    facetSummary: card?.frontMatter.summary ?? null,
  };
}

/** 面板上的「本次生效」：模组后来被改名或删掉，也照实显示那次请求用的那一版。 */
export function describeAppliedRecord(record: AppliedPromptRecord): FacetVersionView {
  return {
    kind: "applied",
    facetId: record.snapshot.facetId,
    name: record.facetName,
    summary: record.facetSummary,
    selectionRevision: record.snapshot.selectionRevision,
    pending: false,
    pendingReason: null,
  };
}

const PENDING_TAIL: Readonly<Record<FacetPendingReason, string>> = {
  selection: "，待下一次请求生效",
  "facet-body": "，模组正文已改，待下一次请求生效",
  "soul-body": "，底线正文已改，待下一次请求生效",
};

export function renderFacetVersionLines(view: { saved: FacetVersionView; applied: FacetVersionView | null }): readonly string[] {
  const saved = view.saved.facetId === null ? "已保存：无模组" : `已保存：${view.saved.name ?? view.saved.facetId}（${view.saved.summary ?? "无简介"}）`;
  const appliedLine = view.applied === null
    ? "本次生效：还没有请求"
    : view.applied.facetId === null ? "本次生效：无模组" : `本次生效：${view.applied.name ?? view.applied.facetId}（${view.applied.summary ?? "无简介"}）`;
  const reason = view.saved.pending ? view.saved.pendingReason ?? "selection" : null;
  if (reason === null) return [saved, appliedLine];
  // 只是换了角色时，下面那行显示的就是上一个角色，不必再加尾巴；正文改了则名字一样，得说清「还是改前那份」。
  const tail = reason === "selection" ? "" : "（还是改前那份）";
  return [saved + PENDING_TAIL[reason], appliedLine + tail];
}

export const FACET_VERSION_WIDGET_ID = "void-soul:facet-version";

export function facetVersionWidget(view: { saved: FacetVersionView; applied: FacetVersionView | null }): { id: string; title: string; order: number; lines: readonly string[] } {
  return { id: FACET_VERSION_WIDGET_ID, title: "当前角色", order: 30, lines: renderFacetVersionLines(view) };
}

function describeOne(kind: FacetVersionView["kind"], snapshot: PromptSnapshot, cards: ReadonlyMap<string, FacetCard>): FacetVersionView {
  const card = snapshot.facetId === null ? undefined : cards.get(snapshot.facetId);
  if (snapshot.facetId !== null && card === undefined) {
    throw new SoulProfileError(`无法显示已丢失的模组: ${snapshot.facetId}`);
  }
  return {
    kind,
    facetId: snapshot.facetId,
    name: card?.frontMatter.name ?? null,
    summary: card?.frontMatter.summary ?? null,
    selectionRevision: snapshot.selectionRevision,
    pending: false,
    pendingReason: null,
  };
}

export function parseFacetCard(markdown: string, cards: ReadonlyMap<string, FacetCard>): FacetCard {
  const parsed = parseSoulDocument(markdown);
  if (cards.has(parsed.frontMatter.id)) {
    throw new SoulProfileError(`模组 id 重复: ${parsed.frontMatter.id}`);
  }
  return { id: parsed.frontMatter.id, frontMatter: parsed.frontMatter, body: parsed.body };
}

/** 只开放这三个已核对变量（13.3）：宿主 agent-loop 只提供它们，别的都不给。 */
export const PROMPT_VARIABLES: ReadonlySet<string> = new Set(["provider", "model", "cwd"]);

/**
 * 宿主到底从哪儿取这三个值（装机的 rc 里核对过：`dsh-agent-loop/lib/index.js` 的
 * `ctx.systemPrompt.variable("provider" | "model" | "cwd", …)`）。宿主只在组装提示词那一刻取值，
 * 取到 `undefined` 就直接抛错、整个 Agent 起不来，所以这里要提前把「有名字但没值」拦下来。
 */
export const PROMPT_VARIABLE_SOURCES: Readonly<Record<string, string>> = {
  provider: "AgentOptions.provider",
  model: "AgentOptions.model",
  cwd: "会话头的 cwd（session.header.cwd）",
};

/** 变量在当前 Agent 上的取值；`undefined` 表示这个名字在宿主那里取不到值。 */
export type PromptVariableValues = Readonly<Record<string, string | undefined>>;

/** 说明书文本的量法：SOUL 正文 + 一个换行 + 选中的模组正文 + 首次见面引导。保存不设上限，装进模型前才量。 */
export interface PromptMeasurement {
  soulCharacters: number;
  facetCharacters: number;
  /** 首次见面引导的字数。没有引导、或引导已完成时是 0。 */
  firstMeetingCharacters: number;
  /** 与实际送进模型的文本长度一致（模组缺席时那个换行仍然算）。 */
  totalCharacters: number;
}

export function measurePromptText(snapshot: PromptSnapshot, firstMeeting?: string | null): PromptMeasurement {
  const soulCharacters = snapshot.soul.length;
  const facetCharacters = (snapshot.facet ?? "").length;
  const firstMeetingCharacters = (firstMeeting ?? "").length;
  return {
    soulCharacters,
    facetCharacters,
    firstMeetingCharacters,
    totalCharacters: soulCharacters + 1 + facetCharacters + firstMeetingCharacters,
  };
}

/**
 * 只允许三个已核对变量。未知变量、在当前 Agent 上取不到值的变量、超预算都拒绝，不截断——
 * 按 13.3，放不下要让人自己缩短 SOUL、换更短的模组或换模型，而不是悄悄把模组截成半张卡。
 * 拒绝信息必须带数字与出处，否则用户只知道「超了」却不知道超多少、该改什么。
 *
 * `values` 给了才检查「有名字但没值」：宿主在组装提示词时才发现取不到值，那时抛的是
 * `prompt variable "{{x}}" has no value for this assembly`，Agent 直接起不来。UI 预览与保存
 * 不传 `values`（保存不设限，也还不知道将来是哪个 Agent 用）。
 */
export function assertPromptRenderable(
  snapshot: PromptSnapshot,
  input: { variables: ReadonlySet<string>; maxCharacters: number; budgetSource?: string; values?: PromptVariableValues; firstMeeting?: string | null },
): void {
  const firstMeeting = input.firstMeeting ?? "";
  const text = `${snapshot.soul}\n${snapshot.facet ?? ""}\n${firstMeeting}`;
  const measured = measurePromptText(snapshot, firstMeeting);
  if (measured.totalCharacters > input.maxCharacters) {
    const source = input.budgetSource === undefined ? "" : `（预算来自 ${input.budgetSource}）`;
    const over = measured.totalCharacters - input.maxCharacters;
    // 引导没写、或已经完成时不进这条信息：报一个恒为 0 的加数只会让人以为自己漏看了什么。
    const guide = measured.firstMeetingCharacters === 0 ? "" : ` + 首次见面 ${measured.firstMeetingCharacters} 字`;
    throw new SoulProfileError(
      `说明书超出本次上下文预算，已拒绝发送${source}：SOUL ${measured.soulCharacters} 字 + 模组 ${measured.facetCharacters} 字${guide} = ` +
        `${measured.totalCharacters} 字，预算 ${input.maxCharacters} 字，超出 ${over} 字。请缩短 SOUL、换更短的模组，或换上下文更大的模型；本插件不会截断内容。`,
    );
  }
  for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = match[1]?.trim() ?? "";
    if (!PROMPT_VARIABLES.has(name) || !input.variables.has(name)) {
      throw new SoulProfileError(`未知说明书变量: ${name}`);
    }
    if (input.values !== undefined && input.values[name] === undefined) {
      const source = PROMPT_VARIABLE_SOURCES[name] ?? "宿主";
      throw new SoulProfileError(
        `说明书变量 {{${name}}} 在当前 Agent 上没有值，已拒绝发送：宿主只从 ${source} 取这个值，取不到就会在组装提示词时报 ` +
          `prompt variable "{{${name}}}" has no value for this assembly，整个 Agent 起不来。请给这个 Agent 设上它，或把 {{${name}}} 从 SOUL 与模组里去掉。`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
