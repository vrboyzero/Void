import type { AppliedPromptRecord } from "./facet.js";

/**
 * 每个档案**最近一次真正装进模型**的那一版。
 *
 * 为什么要有这个东西：`state.json` 只记「选了哪个角色、选择修订是几」，说不出「上一次请求用的是
 * 哪一版正文」。冻结出来的 `AppliedPrompt` 原本只活在 `attachFrozenFacet` 的返回值里，没人接手，
 * 于是面板的「本次生效」永远是「还没有请求」——真机请求跑多少次都不会变。
 *
 * 这份记录**只在内存里**：宿主重启后自然是空的，那时面板照实说「还没有请求」，不猜、不假装。
 */
export class AppliedPromptRegistry {
  private readonly entries = new Map<string, AppliedPromptRecord>();

  /** 记下某个档案刚刚装进模型的那一版（同一个档案后来再请求就覆盖，面板只认最近一次）。 */
  remember(agentId: string, record: AppliedPromptRecord): void {
    this.entries.set(agentId, record);
  }

  /** 档案被删掉时顺手清一份，别把已经不存在的人留在面板上。 */
  forget(agentId: string): void {
    this.entries.delete(agentId);
  }

  get(agentId: string): AppliedPromptRecord | undefined {
    return this.entries.get(agentId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
