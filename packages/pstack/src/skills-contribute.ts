/**
 * 把加载好的技能贡献给 `ctx.skills`。
 *
 * 注册的是**运行期技能**（`SkillRegistration`），不是提供方：rank 250，落在项目级（100/200）
 * 之下、用户级（400/500）之上。这个位置正是我们要的——项目里显式放的技能仍然赢，而本包自带的
 * 技能不会被用户目录里同名的一份顶掉。
 */
import type { ResolvedPstackConfig } from "./config.js";
import { loadPstackSkills, type LoadedPstackSkill } from "./skill-loader.js";

/** 宿主 `SkillResourceBase` 的目录分支——本包只用这一种。 */
export interface SkillDirectoryResourceBase {
  readonly kind: "directory"
  readonly path: string
}

/** 注册表接受的一条运行期技能；只列本包会写的字段。 */
export interface PstackSkillRegistration {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly path?: string
  readonly resourceBase?: SkillDirectoryResourceBase
  readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  /**
   * 来源标签。必填是有原因的：注册表校验器要求它是字符串，漏掉之后 `skills.get()` 会在
   * 加载阶段抛 `source must be a string`，而错误现场离注册点很远。
   */
  readonly source: string
}

/** 本包用到的注册表面；用结构类型而不是引宿主包，避免把 `@deepseek-ai/dsh-skill` 拖进依赖图。 */
export interface PstackSkillRegistry {
  register(skill: PstackSkillRegistration): () => void
}

/** 一次贡献的结果，供日志与测试断言。 */
export interface SkillContribution {
  /** 按注册名排序的已注册技能。 */
  readonly registered: readonly string[]
  /** 原名 -> 注册名，只含真的改过名的。 */
  readonly renamed: readonly (readonly [string, string])[]
  /** 被 `skipSkills` 跳过的原名。 */
  readonly skipped: readonly string[]
}

/**
 * 注册全部技能。
 *
 * 调用必须发生在 `apply()` 的**同步段**里：注册表把它记进调用方上下文对应的层，并且在
 * fiber 被释放时自动摘掉——延迟到微任务之后注册在 fiber 生命周期上没有额外好处，只会给
 * 「插件已就绪但技能还没到」留一个窗口。
 */
export function contributeSkills(
  registry: PstackSkillRegistry,
  config: ResolvedPstackConfig,
  skills: readonly LoadedPstackSkill[] = loadPstackSkills(),
): SkillContribution {
  const registered: string[] = [];
  const renamed: [string, string][] = [];
  const skipped: string[] = [];
  const pending = new Map<string, LoadedPstackSkill>();

  for (const skill of skills) {
    if (config.skipSkills.has(skill.name)) {
      skipped.push(skill.name);
      continue;
    }
    const target = config.renameSkills.get(skill.name) ?? skill.name;
    const clash = pending.get(target);
    if (clash !== undefined) {
      throw new Error(`pstack: 技能改名后重名 "${target}"（来自 "${clash.name}" 与 "${skill.name}"）`);
    }
    pending.set(target, skill);
    if (target !== skill.name) renamed.push([skill.name, target]);
  }

  for (const [name, skill] of pending) {
    registry.register({
      name,
      description: skill.description,
      content: skill.content,
      path: skill.skillFile,
      resourceBase: { kind: "directory", path: skill.directory },
      invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
      source: "runtime",
    });
    registered.push(name);
  }

  registered.sort();
  renamed.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  skipped.sort();
  return { registered, renamed, skipped };
}
