/**
 * `@void/pstack` 的配置面。
 *
 * 全部字段都可从 profile 的 `cordis.patch.yml` 覆盖（宿主约定：部署期变化的取值一律是受校验的
 * `Config` 字段，不是代码里的常量）。默认值的选择标准是「装上去不改变任何既有行为」——因此
 * `renameSkills` 默认空表，本仓库自己的组合才显式填那两条已知重名。
 */
export interface PstackConfig {
  /**
   * 是否把 vendored 的 55 个技能注册进 `ctx.skills`。
   *
   * 关掉它之后插件只剩常驻提示词段与两个子代理工具，适合「只想要 poteto-mode 的行为约束、
   * 不想让 `/` 菜单多出 54 个条目」的场景。
   * @default true
   */
  readonly skills?: boolean
  /**
   * 注册时的改名表：`原名 -> 注册名`。
   *
   * **为什么需要它**：运行期技能的 rank 是 250，高于用户级根目录（`<dshHome>/skills` 400、
   * `<agentsHome>/skills` 500）。同名注册会**静默顶掉**用户自己装的那一个——用户只会看到
   * 技能内容换了一份，没有任何提示。哪些名字会撞取决于本机已装了什么，所以这张表必须由
   * 部署方显式给出，不能由库猜（猜错就是替别人做主）。
   * @default {}
   */
  readonly renameSkills?: Readonly<Record<string, string>>
  /**
   * 不注册的技能名（按改名**前**的原名匹配）。
   * @default []
   */
  readonly skipSkills?: readonly string[]
  /**
   * poteto-mode 常驻段：`off` 不装；`always` 给每个新 Agent 装一段。
   *
   * 默认 `off` 与 pstack 自身的设计一致——它所有技能都标了 `disable-model-invocation`，
   * 由用户显式 `/poteto-mode` 触发。改了默认值等于替每个会话做主，且每轮都要付这段的 token。
   * 会话内可用 `/pstack-mode on|off` 单独切换。
   * @default 'off'
   */
  readonly potetoMode?: "off" | "always"
  /**
   * 是否提供两个子代理委派工具（`pstack_agent`、`pstack_comment_sicko`）。
   * @default true
   */
  readonly subagents?: boolean
  /**
   * 子代理走哪个提供方。宿主的进程内提供方默认叫 `spawn`（全新子代理）与 `fork`（继承对话前缀）。
   *
   * pstack 的 `poteto-agent` 是「每个新任务开一个新鲜的」，所以默认 `spawn`；给 `fork` 会让子代理
   * 继承父对话的已完成轮次前缀，只在确实需要那份上下文时才划算。
   * @default 'spawn'
   */
  readonly subagentProvider?: string
  /**
   * `pstack_comment_sicko` 要挂的组合 preset id；空表示不挂。
   *
   * **默认空是有原因的**。0.2.0-rc.2 的子代理请求带 `toolFilter`，本包那时可以直接把写工具摘掉；
   * 本机装的 **0.2.1-rc.2 把这个字段删了**，换人设与换工具面只剩 `agentPreset` 一条路，而那条路
   * 需要部署方自己提供一个 preset（宿主的 `tools.restrict()` 没有现成的 row 插件）。
   *
   * 所以这里只做透传：把 preset 搭起来了就填 id，没有就留空。留空时 `comment-sicko` 的只读性
   * 只是提示词里的要求——**这一点在工具描述和 README 里都写明了**，不会让调用方以为它有强制力。
   */
  readonly commentSickoPreset?: string
}

/** 解析后的配置；插件内部只读这一份。 */
export interface ResolvedPstackConfig {
  readonly skills: boolean
  readonly renameSkills: ReadonlyMap<string, string>
  readonly skipSkills: ReadonlySet<string>
  readonly potetoMode: "off" | "always"
  readonly subagents: boolean
  readonly subagentProvider: string
  readonly commentSickoPreset: string | undefined
}

/**
 * 校验并补全配置。
 *
 * 配置错误在这里就抛——插件加载期失败好过一次运行到一半的怪行为。三处校验都不是形式主义：
 * 改名目标必须是宿主接受的 kebab-case，两个原名不能改成同一个名字（会静默少一个技能），
 * 子代理提供方名不能是空串（会变成「服务里查不到这个提供方」这种离现场很远的报错）。
 */
export function resolvePstackConfig(config: PstackConfig = {}): ResolvedPstackConfig {
  const renameSkills = new Map<string, string>();
  for (const [from, to] of Object.entries(config.renameSkills ?? {})) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to)) {
      throw new Error(`pstack: renameSkills["${from}"] 的目标名不是 kebab-case: ${JSON.stringify(to)}`);
    }
    renameSkills.set(from, to);
  }
  const skipSkills = new Set(config.skipSkills ?? []);
  const targets = new Map<string, string>();
  for (const from of renameSkills.keys()) {
    const to = renameSkills.get(from) as string;
    const previous = targets.get(to);
    if (previous !== undefined) {
      throw new Error(`pstack: renameSkills 把 "${previous}" 和 "${from}" 改成了同一个名字 "${to}"`);
    }
    targets.set(to, from);
  }
  const subagentProvider = config.subagentProvider ?? "spawn";
  if (subagentProvider.trim().length === 0) {
    throw new Error("pstack: subagentProvider 不能是空字符串");
  }
  const commentSickoPreset = config.commentSickoPreset?.trim();
  return {
    skills: config.skills ?? true,
    renameSkills,
    skipSkills,
    potetoMode: config.potetoMode ?? "off",
    subagents: config.subagents ?? true,
    subagentProvider,
    commentSickoPreset: commentSickoPreset === undefined || commentSickoPreset.length === 0 ? undefined : commentSickoPreset,
  };
}
