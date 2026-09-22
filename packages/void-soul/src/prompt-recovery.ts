/**
 * 把「这次没赶上的段」补进系统提示的装配快照。
 *
 * 宿主发 `agent/created` 时**不等**监听器：`dsh-agent/lib/index.js` 的 `announce()` 只给
 * 监听器返回的 promise 挂一个 `catch`。而按会话绑定冻结角色要读绑定文件、档案与模面，
 * 全是异步的——真机核对里，第一条请求的装配次次都赶在读盘之前，灵魂段就这么没了
 * （2026-09-22，文档 13.1）。GUI 里有人打字才侥幸不发作。
 *
 * 装配瀑布是宿主唯一会 `await` 的钩子（`dsh-system-prompt/lib/index.js:351`：
 * `await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, …)`），
 * 而且它把 `{ agent, scope }` 当上下文交下来，所以这里既等得到那次挂载，也认得出是哪个会话。
 *
 * 一个细节决定了这段代码的形状：宿主的 `assembly.sections` 是在**进瀑布之前**就算好的
 * （`:331-343`），所以光等不够——等完还得把缺的段按顺序插进快照，否则那一次请求照样看不到
 * 底线。插的位置照宿主自己的段顺序：我们的三段是 order 1/2/3，落在
 * `deployment:persona-prefix`（0）之后、`PLAN_POLICY`（500）之前。
 */

/** 一段装进模型的话：名字、顺序、正文。顺序与宿主 `SECTION_ORDERS` 同一套口径。 */
export interface FrozenSection {
  name: string;
  order: number;
  text: string;
}

/** 装配快照里的一段——宿主算好的样子，不带顺序。 */
export interface AssembledSection {
  name: string;
  text: string;
}

/** 宿主交给瀑布的装配结果；除 `sections` 外还有 contexts/tools/variables，原样带回去。 */
export interface PromptAssembly {
  sections: AssembledSection[];
  [key: string]: unknown;
}

/** 一次「按会话冻结角色」的挂载记录。 */
export interface FrozenAttach {
  /** 落定时装进去的段；没装成（没绑定、没数据根、读盘失败）就是空数组。 */
  sections: readonly FrozenSection[];
  /** 还在读盘时是这个 promise；已经落定就是 `undefined`。 */
  pending?: Promise<unknown> | undefined;
  /**
   * 本插件拥有的段名。快照里出现这些名字、而这一轮不打算装了（模组被清掉、引导标成已完成、
   * 会话被解绑）就摘掉；别人的同名段不归我们管。缺省按 `sections` 里出现过的名字算。
   */
  owned?: readonly string[] | undefined;
  /**
   * 每次装配都重新算一遍这一轮要装的段。磁盘上的正文可能刚被人改过，而段一旦注册在 Agent
   * 身上，宿主每轮都会拿那一份旧的来装配——13.3 第 2 条要求每次装配都读同一份内容快照，
   * 所以补段这一步顺便把正文换成当前这一份（同一次请求里不会出现新模组名配旧正文）。
   *
   * 回空数组＝这一轮什么也不装（会话被解绑）。抛错由调用方兜住：沿用上一份，别把装配搞崩。
   */
  refresh?: (() => Promise<readonly FrozenSection[]>) | undefined;
}

/** 会话 → 这次挂载。第一次装配用掉就可以扔。 */
export type FrozenAttachRegistry = Map<string, FrozenAttach>;

/** 瀑布的第三个参数：调用它才会走到链上的下一环（最后是宿主自己的空实现）。 */
export type AssembleNext = () => Promise<PromptAssembly>;

/** 能挂装配瀑布的宿主（根 ctx 就满足；写成结构类型，免得依赖宿主的类型包）。 */
export interface AssembleHookHost {
  on(
    name: "system-prompt/assemble",
    listener: (assembly: PromptAssembly, context: unknown, next: AssembleNext) => Promise<PromptAssembly>,
  ): () => void;
}

/** 宿主自己的人设前缀段；我们的段紧跟其后。 */
const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";

/** 兜底锚点：连人设前缀都没有时，跟在 harness:identity 之后。 */
const HARNESS_IDENTITY_SECTION = "harness:identity";

/** 从瀑布上下文里认会话 id（`context.agent.id` 就是会话 id）。取不到就不插手。 */
export function assembleSessionId(context: unknown): string | undefined {
  const id = (context as { agent?: { id?: unknown } } | undefined)?.agent?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 把缺的段插到宿主自己的人设段之后（找不到人设段就退到 harness:identity 之后）。 */
function insertMissing(out: AssembledSection[], add: readonly FrozenSection[]): AssembledSection[] {
  const anchor = out.findIndex((section) => section.name === PERSONA_PREFIX_SECTION);
  const at = anchor >= 0
    ? anchor + 1
    : out.findIndex((section) => section.name === HARNESS_IDENTITY_SECTION) + 1;
  out.splice(at, 0, ...add.map((section) => ({ name: section.name, text: section.text })));
  return out;
}

/**
 * 让快照里的段与「这一轮该装的那一份」对齐：
 * - 同名的换成正文本（正文刚被改过时，这一次请求就得用新的）；
 * - 我们自己的段现在不该装了（模组被清掉、引导标成已完成、会话被解绑）就摘掉；
 * - 快照里还没有的（第一次装配的竞态）按顺序插进人设段之后；
 * - 别人的段一律不动。
 */
export function syncFrozenSections(
  sections: readonly AssembledSection[],
  current: readonly FrozenSection[],
  owned: readonly string[] = current.map((section) => section.name),
): AssembledSection[] {
  const ours = new Set(owned);
  const wanted = new Map(current.map((section) => [section.name, section]));
  const out: AssembledSection[] = [];
  for (const section of sections) {
    const want = wanted.get(section.name);
    if (want !== undefined) {
      out.push({ name: section.name, text: want.text });
      continue;
    }
    if (!ours.has(section.name)) out.push(section);
  }
  const present = new Set(out.map((section) => section.name));
  const missing = current.filter((section) => !present.has(section.name));
  return missing.length === 0 ? out : insertMissing(out, missing);
}

/**
 * 挂载失败之后留下的「下一轮再试」。
 *
 * 拒绝通知里写着「请把文件另存为 UTF-8 再试」——那就得真的能再试：文件坏了（不是 UTF-8、
 * 太大）时第一次挂载会失败，如果这一条会话就此被判死，人修好文件后还得换会话或重启宿主才
 * 看得到底线，而通知里没这么说。这里把失败的那次挂载记成一条 `refresh`，之后每一轮装配再试
 * 一次；试成了段就补进快照（同一个会话当场自愈），试不成照旧什么也不装。
 *
 * 同一条原因只报一次：文件没修好时每轮都报会把人淹掉；原因变了（坏字节 → 太大）说明人确实
 * 动了那个文件，新的那条得让他看见。
 */
export function createAttachRetry(input: {
  /** 再试一次挂载。失败时它必须自己把半装的段退回去（见 plugin.ts 里的 attempt）。 */
  attempt: () => Promise<void>;
  /** 这一次要装的段；重试成功后就是它。 */
  sections: readonly FrozenSection[];
  onRefused: (error: unknown) => void;
  /** 第一次失败的原因——已经报过了，重试时同样的话不再报。 */
  firstReason: string;
}): () => Promise<readonly FrozenSection[]> {
  let lastReason = input.firstReason;
  return async () => {
    try {
      await input.attempt();
      lastReason = "";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastReason) {
        lastReason = reason;
        input.onRefused(error);
      }
    }
    return input.sections;
  };
}

/**
 * 在装配瀑布上等挂载落定、把段对齐到当前这一份。返回撤销函数（宿主自己也会随 fiber 卸载清掉）。
 *
 * `registry` 由创建 Agent 的那一侧填：`agent/created` 一到就登记一条，落定后写回 `sections`。
 * 带 `refresh` 的记录**会一直留在表里**（每个会话一条），因为每一次装配都要重算；没有
 * `refresh` 的老路径仍然是用掉即删。会话结束由 `registerFrozenAttachDisposal` 收尾。
 */
export function installFrozenSectionRecovery(host: AssembleHookHost, registry: FrozenAttachRegistry): () => void {
  return host.on("system-prompt/assemble", async (assembly, context, next) => {
    // 宿主的瀑布调用一定带 `next`；万一有人拿同名事件去 `emit`（并行、没有链），这里什么也不做，
    // 只把快照原样送回去——补段是我们的活，不该把别人的装配搞崩。
    if (typeof next !== "function") return assembly;
    // 先看链上别人算出来的结果：宿主自己的段、别的插件的段都在里面。
    const result = await next();
    const sessionId = assembleSessionId(context);
    if (sessionId === undefined) return result;
    const attach = registry.get(sessionId);
    if (attach === undefined) return result;
    await attach.pending?.catch(() => undefined);
    let current: readonly FrozenSection[] = attach.sections;
    if (attach.refresh === undefined) {
      // 只在这一次装配用：补过之后段已经登记在 Agent 身上，后面的请求宿主自己会算进去。
      registry.delete(sessionId);
    } else {
      // 读盘失败就沿用上一份（拒绝由 refresh 自己报出去），总比让整个请求挂掉强。
      current = await attach.refresh().catch(() => attach.sections);
    }
    return { ...result, sections: syncFrozenSections(result.sections, current, attach.owned) };
  });
}

/**
 * 会话结束就扔掉那条挂载记录。带 `refresh` 的记录要陪会话跑完，不收尾的话进程里会一直留着
 * 每个跑过的会话一条。宿主 `agent/disposed` 的载荷形状与 `agent/created` 一样是 `{ agent }`。
 */
export function registerFrozenAttachDisposal(
  events: { on(name: "agent/disposed", listener: (payload: { agent: { id: string } }) => void): () => void },
  registry: FrozenAttachRegistry,
): () => void {
  return events.on("agent/disposed", (payload) => {
    const id = payload?.agent?.id;
    if (typeof id === "string" && id.length > 0) registry.delete(id);
  });
}
