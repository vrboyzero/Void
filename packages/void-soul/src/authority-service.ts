import type { Context } from "@deepseek-ai/cordis";
import { Service } from "@deepseek-ai/cordis";
import { buildAuthorityProfiles, type AuthoritySnapshot, type AuthoritySource } from "./authority.js";
import { buildMemberPersona } from "./persona.js";
import { dataRootOptions, SoulProfileError, tryResolveVoidDataRoot } from "./profile.js";
import { loadSessionBindings, loadSoulRegistry } from "./registry.js";
import { bindSessionToProfile } from "./soul-library.js";

export interface SoulAuthorityConfig {
  /** 显式数据根（绝对路径）。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  /** 逐子代理身份的字数预算；不给就用 `void-soul` 的默认预算。 */
  maxCharacters?: number | undefined;
}

/**
 * `voidAuthority` 的真服务：把「这个会话是谁」与「整份身份图」交给军团。
 *
 * 三件事必须守住：
 * 1. **身份来自会话绑定，不来自模型说的话**。模型自称是主人、自己在参数里写 `agentId`
 *    都不算凭证（§15.2 第 1 条）；只有 `runtime/session-bindings.json` 里那条记录算。
 * 2. **解析不出就返回 `undefined`，绝不退回默认身份**。退回默认身份等于给所有人开门。
 * 3. **每次调用重读磁盘**。人类改完 `SOUL.md` 下一次派活就生效，不重启、不缓存旧图——
 *    与「改说明书下次生效」同一套时序，也让「组织图与权限检查读同一份记录」成立。
 */
export class SoulAuthority extends Service implements AuthoritySource {
  private readonly dataDir: string | undefined;
  private readonly maxCharacters: number | undefined;

  constructor(ctx: Context, config: SoulAuthorityConfig = {}) {
    super(ctx, "voidAuthority");
    this.maxCharacters = config.maxCharacters;
    this.dataDir = tryResolveVoidDataRoot(dataRootOptions(ctx, config));
  }

  /** 本服务实际使用的数据根；没配好时为 undefined（此时照常加载，用到才报错）。 */
  get dataRoot(): string | undefined {
    return this.dataDir;
  }

  async forSession(sessionId: string): Promise<AuthoritySnapshot | undefined> {
    const dataDir = this.dataDir;
    if (dataDir === undefined) {
      throw new SoulProfileError("权威档案没有数据根，无法解析派活身份：需要配置 dataDir，或同时提供 profile（DSH_PROFILE）与 dshHome（DSH_HOME）");
    }
    const id = sessionId?.trim() ?? "";
    if (id.length === 0) throw new SoulProfileError("解析派活身份缺少会话 id");
    const agentId = (await loadSessionBindings(dataDir)).get(id);
    if (agentId === undefined) return undefined;
    const records = await loadSoulRegistry(dataDir);
    if (!records.has(agentId)) throw new SoulProfileError(`没有这份档案，拒绝进入模型: ${agentId}`);
    return { actorId: agentId, profiles: buildAuthorityProfiles(records) };
  }

  /**
   * 逐成员身份（能力表「子代理继承」行）。与 `forSession` 同一套时序：每次重读磁盘。
   *
   * 这里**不查会话绑定**：要的是 lane 成员的档案，不是派活会话的身份——查绑定就成了
   * 「误把父身份当子身份」。
   */
  async personaFor(agentId: string): Promise<string> {
    const dataDir = this.dataDir;
    if (dataDir === undefined) {
      throw new SoulProfileError("权威档案没有数据根，取不出派活身份：需要配置 dataDir，或同时提供 profile（DSH_PROFILE）与 dshHome（DSH_HOME）");
    }
    const persona = await buildMemberPersona({
      dataDir,
      agentId,
      maxCharacters: this.maxCharacters,
    });
    return persona.text;
  }

  async bindChildSession(sessionId: string, agentId: string): Promise<void> {
    if (this.dataDir === undefined) throw new SoulProfileError("子代理绑定缺少数据根");
    await bindSessionToProfile(this.dataDir, { sessionId, profileId: agentId });
  }
}

export default SoulAuthority;
