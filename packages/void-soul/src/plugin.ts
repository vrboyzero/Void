import type { Context } from "@deepseek-ai/cordis";
import { assertPromptRenderable, beginPrompt, PROMPT_VARIABLES, recordAppliedPrompt, suspendedReason, type AppliedPrompt, type AppliedPromptRecord, type FacetCard } from "./facet.js";
import { AppliedPromptRegistry } from "./applied-prompts.js";
import { loadFacetLibrary, loadProfileFacetRegistrations, loadSavedFacetView, saveProfileFacetSelection, type StoredFacetView } from "./facet-store.js";
import { loadSessionBindings, loadSoulRegistry, resolveBinding, type SoulRecord } from "./registry.js";
import { readProfileDirectory, tryResolveVoidDataRoot } from "./profile.js";
import { createAttachRetry, installFrozenSectionRecovery, registerFrozenAttachDisposal, type FrozenAttach, type FrozenAttachRegistry, type FrozenSection } from "./prompt-recovery.js";
import { createRefusalNotifications, SoulRefusalLog, type SoulRefusalSource } from "./refusals.js";
import { installShellReadGuard, type GuardedShell } from "./shell-guard.js";
import type { ExecutionIsolation } from "./execution-policy.js";
import { installToolEntryGuard, type GuardedToolRegistry } from "./tool-entry-guard.js";

interface FacetVersionHost {
  registerFacetVersions(source: {
    load(input: { home: string; name: string }): Promise<unknown>;
    save(input: { home: string; name: string; agentId: string; facetId: string | null; expectedRevision: number }): Promise<unknown>;
  }): () => void;
}

/** 入口那侧的能力。两个都按可选看：老版本入口可能只认其中一类（§16.1）。 */
interface SoulSuiteHost extends Partial<FacetVersionHost> {
  registerNotificationSource?(source: SoulRefusalSource): () => void;
}

export interface AgentPromptTarget {
  id: string;
  ctx: { systemPrompt: { section(input: { name: string; order: number; text: string }): () => void } };
  /**
   * 宿主 agent 对象上真实存在的选项（`dsh-agent-loop` 里 `this.options = options`）。宿主注册的
   * `{{provider}}`/`{{model}}` 变量取的就是这里的值——走 `agent/request` 瀑布给的值不在其中，
   * 那种情况下写了这两个变量的说明书会在组装提示词时直接抛错，所以要能读出来提前拦。
   */
  options?: { provider?: string | undefined; model?: string | undefined } | undefined;
  /**
   * 宿主 agent 对象上真实存在的会话（`dsh-agent-loop` 里 `this.session = session`），
   * 但**没有写进 `Agent` 接口**，所以这里按可选的结构化类型取，取不到就不猜窗口。
   */
  session?: { requestContext?(): { contextWindow?: number } | undefined; header?: { cwd?: string } | undefined } | undefined;
}

/** 没配预算时的字符上限：够大，只兜住明显失控的文件。 */
export const DEFAULT_PROMPT_MAX_CHARACTERS = 100_000;
/** 把字符数当作 token 数的上界估计（1 字符最多 1 token），宁可早拒绝也不冒溢出风险。 */
export const PROMPT_CHARACTERS_PER_TOKEN = 1;
/** 说明书最多占模型窗口的这个比例，其余留给对话、工具与输出。 */
export const PROMPT_WINDOW_SHARE = 0.5;

/** 本次装进模型的字符预算，以及它是从哪儿来的（进拒绝信息，方便定位）。 */
export interface PromptBudget {
  maxCharacters: number;
  source: "configured" | "context-window" | "default";
}

/**
 * 定预算：显式配置是硬上限，模型窗口（能读到的话）只收紧不放大。首次请求之前宿主
 * 给不出 `requestContext()`，那时只能按配置或默认值来——窗口未知不等于窗口无限，
 * 默认值就是给这种情况兜底的。
 */
export function resolvePromptBudget(input: { maxCharacters?: number; contextWindow?: number }): PromptBudget {
  const configured = input.maxCharacters;
  const window = input.contextWindow;
  const fromWindow =
    window === undefined || !Number.isFinite(window) || window <= 0
      ? undefined
      : Math.floor(window * PROMPT_WINDOW_SHARE * PROMPT_CHARACTERS_PER_TOKEN);
  if (configured !== undefined && fromWindow !== undefined) {
    return fromWindow < configured
      ? { maxCharacters: fromWindow, source: "context-window" }
      : { maxCharacters: configured, source: "configured" };
  }
  if (configured !== undefined) return { maxCharacters: configured, source: "configured" };
  if (fromWindow !== undefined) return { maxCharacters: fromWindow, source: "context-window" };
  return { maxCharacters: DEFAULT_PROMPT_MAX_CHARACTERS, source: "default" };
}

/** 从 Agent 身上读模型窗口。宿主没暴露或还没请求过就返回 undefined，不猜。 */
export function readContextWindow(agent: AgentPromptTarget): number | undefined {
  const window = agent.session?.requestContext?.()?.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}

/**
 * 读三个变量在当前 Agent 上的取值，取值口径与宿主完全一致（`dsh-agent-loop/lib/index.js`：
 * `context.agent?.options.provider`、`context.agent?.options.model`、`context.agent?.session.header.cwd`）。
 * 取不到就是 `undefined`——不编默认值，因为宿主那边同样是取不到就抛错。
 */
export function readPromptValues(agent: AgentPromptTarget): Record<string, string | undefined> {
  return {
    provider: agent.options?.provider,
    model: agent.options?.model,
    cwd: agent.session?.header?.cwd,
  };
}

/** 本插件注册的三个段名，顺序固定。装配时按这份名单认出「哪些段是我们自己的」。 */
export const FROZEN_SECTION_NAMES = ["void:soul", "void:facet", "void:first-meeting"] as const;

/** 一轮装配要装进去的段，以及这一轮真的生效的那份快照。纯计算：不碰 Agent、不读盘。 */
export interface PlannedPrompt {
  sections: FrozenSection[];
  frozen: AppliedPrompt;
}

/**
 * 按一份内容快照算出这一轮该装哪几段。冻结（第一次请求）与热更新（之后的每一次装配）走的是
 * 同一个函数——两处各写一遍的话，「面板说生效了、模型那边没变」这种偏差迟早会出现。
 */
export function planFrozenSections(input: {
  record: SoulRecord;
  view: StoredFacetView;
  cards: ReadonlyMap<string, FacetCard>;
  agent: AgentPromptTarget;
  budget: PromptBudget;
}): PlannedPrompt {
  const frozen = beginPrompt({
    soulBody: input.record.body,
    state: {
      schemaVersion: 1,
      activeFacetId: input.view.saved.facetId,
      selectionRevision: input.view.saved.selectionRevision,
      firstMeetingDone: input.view.firstMeetingDone,
      // 停用位只影响「装不装」，不影响这一轮算出什么快照：停用的档案压根走不到这里。
      suspended: input.view.suspended,
    },
    cards: input.cards,
  });
  // 首次见面引导（13 节）：档案里写了、并且这份档案还没标过「已完成」时才装。
  const firstMeeting = input.view.firstMeetingDone ? null : input.record.frontMatter.firstMeeting ?? null;
  assertPromptRenderable(frozen.applied ?? frozen.saved, {
    variables: PROMPT_VARIABLES,
    maxCharacters: input.budget.maxCharacters,
    budgetSource: input.budget.source,
    values: readPromptValues(input.agent),
    firstMeeting,
  });
  // 段名与顺序固定：`void:soul`(1) / `void:facet`(2) / `void:first-meeting`(3) 落在宿主的
  // `deployment:persona-prefix`(0) 之后、`PLAN_POLICY`(500) 之前——说明书紧跟人设。
  const sections: FrozenSection[] = [
    { name: "void:soul", order: 1, text: frozen.applied?.soul ?? input.record.body },
  ];
  if (frozen.applied?.facet) sections.push({ name: "void:facet", order: 2, text: frozen.applied.facet });
  if (firstMeeting !== null) sections.push({ name: "void:first-meeting", order: 3, text: firstMeeting });
  return { sections, frozen };
}

/** 请求开始时按会话绑定冻结角色。保存发生在之后时，只更新已保存版本。 */
export async function attachFrozenFacet(input: {
  agent: AgentPromptTarget;
  sessionId: string;
  bindings: ReadonlyMap<string, string>;
  records: ReadonlyMap<string, SoulRecord>;
  cards: ReadonlyMap<string, FacetCard>;
  loadView: (record: SoulRecord) => Promise<StoredFacetView>;
  budget?: PromptBudget;
  /** 兼容旧调用：等价于 `budget: { maxCharacters, source: "configured" }`。 */
  maxCharacters?: number;
  /**
   * 这一轮装进去的段按顺序收在这里。宿主不等 `agent/created` 的监听器，第一条请求可能赶在
   * 读盘之前，装配瀑布就靠这份记录把缺的段补进快照（见 prompt-recovery.ts）。
   */
  sections?: FrozenSection[] | undefined;
}): Promise<AppliedPrompt> {
  const agentId = resolveBinding(input.bindings, input.sessionId);
  const record = input.records.get(agentId);
  if (!record) throw new Error(`没有这份档案，拒绝进入模型: ${agentId}`);
  const view = await input.loadView(record);
  // 停用（19.1 的「停用 + 引用检查 + 预览回收范围」）：段一个都不装，理由照实报出去。
  if (view.suspended) throw new Error(suspendedReason(agentId, "进入模型"));
  const budget = input.budget ?? resolvePromptBudget({ maxCharacters: input.maxCharacters });
  const planned = planFrozenSections({ record, view, cards: input.cards, agent: input.agent, budget });
  for (const section of planned.sections) {
    input.agent.ctx.systemPrompt.section(section);
    input.sections?.push(section);
  }
  return planned.frozen;
}

/** 热更新要用的东西：会话、Agent、数据根，以及失败时怎么报、退回哪一份。 */
export interface FrozenRefreshOptions {
  sessionId: string;
  agent: AgentPromptTarget;
  dataDir: string;
  /** 每次装配都重算一次预算：模型窗口要第一次请求之后才读得到（13.3 第 3 条）。 */
  budget: () => PromptBudget;
  onApplied?: ((agentId: string, record: AppliedPromptRecord) => void) | undefined;
  onRefused?: ((error: unknown) => void) | undefined;
  /**
   * 这一轮因为档案被停用而摘掉了段。**与 `onRefused` 分开**：停用不是「读盘失败」，它不该
   * 沿用上一份，而是要把已经装进去的段摘掉；同一条理由只报一次（装配每轮都跑，不去的
   * 话通知栏会被同一句话刷满）。
   */
  onSuspended?: ((reason: string) => void) | undefined;
  /** 这一轮算不出来时沿用的那一份（就是上一次装进去的段）。 */
  fallback: () => readonly FrozenSection[];
}

/**
 * 每次装配都重新读一遍磁盘再算这三段。
 *
 * 13.3 第 2 条要求「每次 assembly 开始时读取并验证同一份内容快照」，第 5/7 条要求正文改动在
 * **下一次模型请求**就生效。段一旦用 `systemPrompt.section` 注册在 Agent 身上，宿主每轮都拿
 * 那一份旧的来装配，所以热更新只能在装配瀑布上做：读当前快照 → 重算段 → 换掉快照里的正文。
 *
 * 四种结果分得很清楚：会话被解绑回空数组（人类显式解绑，下一次请求就不该再装）；**档案被停用
 * 也回空数组**（人在面板上按的开关，下一轮就该摘掉，而且不能走下面的 `fallback`——那会把旧段
 * 留在提示词里，等于「说停用了其实还在用」）；读盘或校验失败报出去并沿用上一份（宁可这次还用
 * 旧说明书，也不能让整个请求挂掉）；成功就换新的。停用之后再启用，下一轮装配自己就把段装回来。
 */
export function createFrozenRefresh(options: FrozenRefreshOptions): () => Promise<readonly FrozenSection[]> {
  // 同一条停用理由只报一次；中途启用过再停用，会重新报（变量在这里被清回 undefined）。
  let reportedSuspension: string | undefined;
  return async () => {
    try {
      const bindings = await loadSessionBindings(options.dataDir);
      if (!bindings.has(options.sessionId)) return [];
      const agentId = resolveBinding(bindings, options.sessionId);
      const records = await loadSoulRegistry(options.dataDir);
      const record = records.get(agentId);
      if (!record) throw new Error(`没有这份档案，拒绝进入模型: ${agentId}`);
      const cards = await loadFacetLibrary(options.dataDir);
      const view = await loadSavedFacetView(options.dataDir, record);
      if (view.suspended) {
        const reason = suspendedReason(agentId, "进入模型");
        if (reportedSuspension !== reason) {
          reportedSuspension = reason;
          options.onSuspended?.(reason);
        }
        return [];
      }
      reportedSuspension = undefined;
      const planned = planFrozenSections({ record, view, cards, agent: options.agent, budget: options.budget() });
      options.onApplied?.(agentId, recordAppliedPrompt({ snapshot: planned.frozen.applied ?? planned.frozen.saved, cards }));
      return planned.sections;
    } catch (error) {
      options.onRefused?.(error);
      return options.fallback();
    }
  };
}

/**
 * 只处理已绑定档案的新 Agent。没有绑定、或认不出数据根就跳过，不登记默认灵魂。
 *
 * 数据根优先认宿主给的档案目录（`baseUrl`）：宿主从不设 `DSH_PROFILE`，只靠环境变量的话
 * 灵魂段会**静默不装**（2026-09-22 真机核对，见文档 13.1）。
 */
export async function freezeCreatedAgent(
  agent: AgentPromptTarget,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    maxCharacters?: number;
    baseUrl?: string | undefined;
    sections?: FrozenSection[] | undefined;
    /**
     * 这一版真的装进模型了。面板的「本次生效」就靠这个回调记下来：冻结的那份只活在返回值里，
     * 不交给别人，面板永远只能显示「还没有请求」。
     */
    onApplied?: ((agentId: string, record: AppliedPromptRecord) => void) | undefined;
    /**
     * 挂载成功、数据根也认出来了。装配瀑布要靠这个数据根在**每一次**装配时重读当前快照
     * （13.3 第 2 条），所以只在这一刻之后才装得上热更新。
     */
    onAttached?: ((dataDir: string) => void) | undefined;
  } = {},
): Promise<boolean> {
  const dataDir = tryResolveVoidDataRoot({ env, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) });
  if (dataDir === undefined) return false;
  const bindings = await loadSessionBindings(dataDir);
  if (!bindings.has(agent.id)) return false;
  const records = await loadSoulRegistry(dataDir);
  const cards = await loadFacetLibrary(dataDir);
  const budget = resolvePromptBudget({ maxCharacters: options.maxCharacters, contextWindow: readContextWindow(agent) });
  const frozen = await attachFrozenFacet({
    agent,
    sessionId: agent.id,
    bindings,
    records,
    cards,
    loadView: (record) => loadSavedFacetView(dataDir, record),
    budget,
    ...(options.sections === undefined ? {} : { sections: options.sections }),
  });
  options.onAttached?.(dataDir);
  options.onApplied?.(resolveBinding(bindings, agent.id), recordAppliedPrompt({ snapshot: frozen.applied ?? frozen.saved, cards }));
  return true;
}

/**
 * 会话 → 档案：只为了让拒绝通知写得像人话。查不到就回 `undefined`（通知照发，只报会话），
 * 也不抛错——诊断面自己出问题不该把原始拒绝盖掉。
 */
export async function describeRefusal(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { baseUrl?: string | undefined } = {},
): Promise<{ profileId?: string } | undefined> {
  try {
    const dataDir = tryResolveVoidDataRoot({ env, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) });
    if (dataDir === undefined) return undefined;
    const bindings = await loadSessionBindings(dataDir);
    return { profileId: resolveBinding(bindings, sessionId) };
  } catch {
    return undefined;
  }
}

/**
 * 宿主给插件的档案目录。根树插件的 `ctx.baseUrl` 就是档案目录（cordis 把 include 根锚在
 * 那里），取不到就返回 `undefined`——不猜。
 */
export { readProfileDirectory };

/**
 * 监听新 Agent。装不进模型（超预算、缺档案、变量不认）时必须说出来：既不静默截断，
 * 也不能只丢一个未处理的 rejection——所以给了 `onRejected` 就交给它报，没给就照旧抛出去。
 *
 * **宿主不等这个监听器**（`dsh-agent/lib/index.js` 的 `announce()` 只挂 `catch`），所以
 * 光在这里 `await` 挡不住第一条请求；补段的活由 `installFrozenSectionRecovery` 在装配
 * 瀑布上做。这里返回的 promise 仍然要接住，否则拒绝没人报。
 */
export function registerFrozenFacetListener(
  events: { on(name: "agent/created", listener: (payload: { agent: AgentPromptTarget }) => void): () => void },
  attach: (agent: AgentPromptTarget) => Promise<unknown>,
  onRejected?: (error: unknown, agent: AgentPromptTarget) => void,
): () => void {
  return events.on("agent/created", (payload) => {
    void attach(payload.agent).catch((error: unknown) => {
      if (onRejected === undefined) throw error;
      onRejected(error, payload.agent);
    });
  });
}

/** `void-soul` 的插件配置。缺省即最保守：只装读隔离门禁，不装工具入口门禁。 */
export interface VoidSoulConfig {
  /**
   * 模型工具入口门禁（P2）。默认**不装**：本机没有读隔离执行环境，装上去会让该
   * profile 的写/执行工具全部失效（风险见文档 19.1）。读隔离落地后在隔离 profile
   * 里显式打开，或先用 `allowUnisolated` 在受控环境里放行。
   *
   * 打开之后，这里声明的 `isolation` 与 `allowUnisolated` 同时管住底层 shell 服务
   * （`installShellReadGuard`）——两道门禁共用一个判定，见 `execution-policy.ts`。
   */
  entryPolicy?:
    | {
        enabled?: boolean;
        isolation?: ExecutionIsolation;
        allowUnisolated?: boolean;
        allowed?: readonly string[];
      }
    | undefined;
  /**
   * 装进模型前的字符预算（13.3 第 3 条）。不配就是默认 `100000` 字；Agent 身上能读到
   * 模型上下文窗口时（宿主首次请求之后才有）再收紧到 `min(配置, 窗口 × 0.5)`，因为
   * 说明书只占请求的一部分，其余要留给对话、工具与输出。超预算一律拒绝并报出实际
   * 字数与预算，**不截断**；保存侧不受这个值影响。
   */
  prompt?: { maxCharacters?: number } | undefined;
}

/** 等入口出现后登记只读来源。入口不在时什么都不做，卸载时撤掉登记。 */
export function apply(ctx: Context, config: VoidSoulConfig = {}): void {
  // 门禁没打开时按最保守处理（`{}`＝完全没有隔离，照旧拒绝）；打开时把同一份隔离声明与
  // `allowUnisolated` 一并交给 shell 门禁——两道门禁必须对同一份配置给同一个答案，否则会
  // 出现「工具门禁放行 pwsh、底层 shell 仍以缺少读隔离拒绝」的分叉（见 execution-policy.ts）。
  const executionPolicy = config.entryPolicy?.enabled === true ? config.entryPolicy : {};
  ctx.inject(["shell"], (shellCtx) => {
    const shell = shellCtx.get("shell") as GuardedShell | undefined;
    if (!shell?.run) return;
    const restore = installShellReadGuard(shell, executionPolicy);
    shellCtx.effect(() => restore, "void-soul: shell read guard");
  });
  if (config.entryPolicy?.enabled === true) {
    const policy = config.entryPolicy;
    ctx.inject(["tools"], (toolsCtx) => {
      const registry = toolsCtx.get("tools") as GuardedToolRegistry | undefined;
      if (!registry?.register) return;
      const guard = installToolEntryGuard(registry, {
        isolation: policy.isolation,
        allowUnisolated: policy.allowUnisolated,
        allowed: policy.allowed,
      });
      toolsCtx.effect(() => guard.restore, "void-soul: tool entry guard");
    });
  }
  const log = ctx.logger("void-soul");
  const refusals = new SoulRefusalLog();
  // 宿主从不设 DSH_PROFILE，认档案就靠它给的档案目录（见 readProfileDirectory）。
  const profileDirectory = readProfileDirectory(ctx);
  const rootOptions = {
    ...(config.prompt?.maxCharacters === undefined ? {} : { maxCharacters: config.prompt.maxCharacters }),
    ...(profileDirectory === undefined ? {} : { baseUrl: profileDirectory }),
  };
  // 会话 → 这次挂载。宿主不等 `agent/created` 的监听器，所以第一条请求的装配可能赶在
  // 读盘之前；装配瀑布上靠这份记录等它落定并把缺的段补进快照（见 prompt-recovery.ts）。
  const attaching: FrozenAttachRegistry = new Map();
  // 每个档案最近一次真装进模型的那一版。只活在内存里：面板的「本次生效」靠它，宿主重启后为空。
  const applied = new AppliedPromptRegistry();
  const reportRefusal = (error: unknown, sessionId: string): void => {
    const message = error instanceof Error ? error.message : String(error);
    log.error("拒绝把说明书装进模型（会话 %s）：%s", sessionId, message);
    // 同一条拒绝进两个地方：宿主日志（留档、可按 void-soul 查）与通知条（人在面板上看得到）。
    refusals.record({ sessionId, reason: message });
  };
  registerFrozenFacetListener(
    ctx as never,
    (agent) => {
      const sections: FrozenSection[] = [];
      const record: FrozenAttach = { sections, owned: FROZEN_SECTION_NAMES };
      attaching.set(agent.id, record);
      // 每次装配都重算一次：模型窗口要第一次请求之后才读得到，预算也得跟着变。
      const budget = (): PromptBudget =>
        resolvePromptBudget({ maxCharacters: config.prompt?.maxCharacters, contextWindow: readContextWindow(agent) });
      // 失败可能只装了一半（超预算那类），退回去：半装的段不许进模型。
      const attempt = async (): Promise<void> => {
        const before = sections.slice();
        sections.length = 0;
        try {
          await freezeCreatedAgent(agent, process.env, {
            ...rootOptions,
            sections,
            onApplied: (agentId, entry) => applied.remember(agentId, entry),
            onAttached: (dataDir) => {
              // 从下一次装配起，每一轮都按磁盘上的当前内容重算这三段（13.3 第 2 条热更新）。
              record.refresh = createFrozenRefresh({
                sessionId: agent.id,
                agent,
                dataDir,
                budget,
                onApplied: (agentId, entry) => applied.remember(agentId, entry),
                onRefused: (error) => reportRefusal(error, agent.id),
                // 停用之后热更新会摘掉段；理由照样进日志与通知栏，人不用猜「怎么突然不生效了」。
                onSuspended: (reason) => reportRefusal(new Error(reason), agent.id),
                fallback: () => sections,
              });
            },
          });
        } catch (error) {
          sections.length = 0;
          sections.push(...before);
          throw error;
        }
      };
      const task = attempt()
        .then(() => undefined, (error: unknown) => {
          // 没装成：补段补不出东西，但留一条「下一轮再试」——文件修好之后同一个会话照样自愈，
          // 不必逼人换会话或重启宿主（见 prompt-recovery.ts 的 createAttachRetry）。
          record.refresh = createAttachRetry({
            attempt,
            sections,
            onRefused: (retryError) => reportRefusal(retryError, agent.id),
            firstReason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        })
        .finally(() => { record.pending = undefined; });
      record.pending = task;
      return task;
    },
    (error, agent) => reportRefusal(error, agent.id),
  );
  // 会话跑完就扔掉那条记录：带热更新的记录要陪会话跑到底，不收尾会一直留在进程里。
  registerFrozenAttachDisposal(ctx as never, attaching);
  installFrozenSectionRecovery(ctx as never, attaching);
  ctx.inject(["voidSuite"], (suiteCtx) => {
    const suite = suiteCtx.get("voidSuite") as SoulSuiteHost | undefined;
    if (!suite) return;
    if (typeof suite.registerFacetVersions === "function") {
      const register = suite.registerFacetVersions.bind(suite);
      suiteCtx.effect(
        () => register({
          load: (input) => loadProfileFacetRegistrations({
            dshHome: input.home,
            profile: input.name,
            appliedFor: (agentId) => applied.get(agentId),
          }),
          save: (input) => saveProfileFacetSelection({ dshHome: input.home, profile: input.name, agentId: input.agentId, facetId: input.facetId, expectedRevision: input.expectedRevision }),
        }),
        "void-soul: facet versions",
      );
    }
    if (typeof suite.registerNotificationSource === "function") {
      const register = suite.registerNotificationSource.bind(suite);
      const source = createRefusalNotifications(refusals, (sessionId) => describeRefusal(sessionId, process.env, profileDirectory === undefined ? {} : { baseUrl: profileDirectory }));
      suiteCtx.effect(() => register(source), "void-soul: refusal notifications");
    }
  });
}

export const name = "void-soul";
