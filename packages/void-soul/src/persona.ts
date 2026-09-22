import { PROMPT_VARIABLES, assertPromptRenderable, snapshotPrompt, suspendedReason, type PromptSnapshot } from "./facet.js";
import { loadFacetLibrary, loadSavedFacetView } from "./facet-store.js";
import { resolvePromptBudget } from "./plugin.js";
import { SoulProfileError } from "./profile.js";
import { loadSoulRegistry } from "./registry.js";

/**
 * 逐子代理身份（能力表「子代理继承」行：**必须显式绑定子成员身份，不能误把父身份当子身份**）。
 *
 * 军团派活时把每个 lane 成员**自己的**底线 + 当前角色装进子代理的 `persona` 段，宿主
 * （`dsh-subagent`）把它当子代理的系统段 `deployment:persona-prefix` 用——子代理自己那份
 * 顶掉继承来的那份，所以子代理一开口就是成员的身份，而不是派活会话的。
 *
 * 与「父会话进模型」那条路（`plugin.ts` 的 `attachFrozenFacet`）刻意分开三点：
 * - 取的是**成员自己的**档案（按 lane 的 `agentId` 现读磁盘），不是派活会话绑定的那份；
 * - **不含首次见面引导**：引导是跟主人见面时的开场白，不是干活的说明书；
 * - 变量**只查名字、不预检取值**：子代理的 provider/model 由宿主在它自己组装那一刻决定
 *   （还可能被 lane 的 `modelRef` 换掉），这里拿不到，也就不假装检过。名字不在白名单里照样拒。
 */
export interface MemberPersona {
  agentId: string;
  /** 交给宿主当子代理 persona 的正文：底线与当前角色用一个换行接起来。 */
  text: string;
  characters: number;
  budgetSource: string;
}

/**
 * 底线与当前角色之间的分隔只用一个换行：`measurePromptText` 就是按 `soul + 1 + facet`
 * 量的，用两个换行会让预算报出来的字数比真正交出去的文本多一个——拒绝信息里的数字
 * 必须与事实一致。空白先掐掉，量的时候偏保守（按没掐的量）。
 */
export function personaTextOf(snapshot: PromptSnapshot): string {
  const soul = snapshot.soul.trim();
  const facet = snapshot.facet?.trim() ?? "";
  if (facet.length === 0) return soul;
  if (soul.length === 0) return facet;
  return `${soul}\n${facet}`;
}

/**
 * 取一份档案的派活身份。**每次调用重读磁盘**（与 `SoulAuthority.forSession` 同一套时序：
 * 人类改完 `SOUL.md` 下一次派活就生效，不重启、不缓存旧身份）。
 *
 * 取不出来一律抛错，**不退回派活者的身份、也不退回一个空身份**：文档要的就是「不能误把
 * 父身份当子身份」，静默降级等于给子代理一个假名分。
 */
export async function buildMemberPersona(input: {
  dataDir: string;
  agentId: string;
  maxCharacters?: number | undefined;
}): Promise<MemberPersona> {
  const agentId = input.agentId?.trim() ?? "";
  if (agentId.length === 0) throw new SoulProfileError("取派活身份缺少档案 id");
  const records = await loadSoulRegistry(input.dataDir);
  const record = records.get(agentId);
  if (!record) throw new SoulProfileError(`没有这份档案，取不出派活身份: ${agentId}`);
  // 状态只认 facet-store 那一个读法（连首次见面位一起读出来，虽然身份用不到它）。
  const view = await loadSavedFacetView(input.dataDir, record);
  // 停用的档案不发派活身份：不然「先别用」只挡住了直接进模型，军团照样能把它派出去。
  if (view.suspended) throw new SoulProfileError(suspendedReason(agentId, "派活"));
  const cards = await loadFacetLibrary(input.dataDir);
  const snapshot = snapshotPrompt({
    soulBody: record.body,
    state: {
      schemaVersion: 1,
      activeFacetId: view.saved.facetId,
      selectionRevision: view.saved.selectionRevision,
      firstMeetingDone: view.firstMeetingDone,
      suspended: view.suspended,
    },
    cards,
  });
  const budget = resolvePromptBudget({ maxCharacters: input.maxCharacters });
  assertPromptRenderable(snapshot, {
    variables: PROMPT_VARIABLES,
    maxCharacters: budget.maxCharacters,
    budgetSource: budget.source,
  });
  const text = personaTextOf(snapshot);
  if (text.length === 0) throw new SoulProfileError(`档案 ${agentId} 没有底线正文，取不出派活身份`);
  return { agentId, text, characters: text.length, budgetSource: budget.source };
}
