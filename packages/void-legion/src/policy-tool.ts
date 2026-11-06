import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { AuthoritySource } from "@void/void-soul";
import { activePolicyGrants, type DispatchPolicySnapshot } from "./dispatch-policy.js";
import type { VoidTeam } from "./service.js";

export const name = "void-legion-policy-tool";
export const inject = ["tools", "voidTeam"];

/**
 * 模型可见的 `legion_policy` 工具：Agent 改派活名单的**唯一**通道。
 *
 * 这不是「代主人伸手」：授权生效后，Agent 在自己的范围内真的能改（§22.10 第 2 条）。
 * 但三道边界一条都不能省：
 *
 * 1. **只有主人能授权**：这个工具没有 grant/revoke/mode 动作，Agent 不能给自己
 *    授权，也不能把授权转授给别人（§22.10 硬要求 4）。
 * 2. **范围之外没有权限**：仓库里按 `source/lists` 与到期时间逐次判，不信任工具参数。
 * 3. **留痕写动作来源**：每次改动记 `agent:<id>` + `grantId`，不伪装成主人自己改的。
 *
 * 名单本身仍是**收窄器**：在名单里不等于能派活，身份许可 ∩ 队伍许可照旧判。
 */
export function apply(ctx: Context): void {
  const team = ctx.get("voidTeam") as VoidTeam;

  ctx.tools.register(defineTool({
    name: "legion_policy",
    description:
      "Read or edit the legion dispatch allowlist (who may launch legions). Reading is available to any bound agent. Editing requires the owner to have granted this agent policy-edit permission in the Void panel; this tool cannot grant, revoke, or transfer permissions. The allowlist only narrows dispatch: identity permission and team mayDirect still apply.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "add", "remove"],
        description: "list reads the allowlist; add/remove edit it (requires a valid policy-edit grant).",
      },
      agentId: {
        type: "string",
        description: "The SOUL profile id to add or remove. Required for add/remove; ignored for list.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true },
          changed: { type: "boolean", required: true },
          configured: { type: "boolean", required: true },
          mode: { type: "string", required: true },
          allowlist: { type: "array", required: true, items: { type: "string" } },
          revision: { type: "integer", required: true },
          /** 本会话的 Agent 现在能不能改名单（开关 + 有效授权同时满足）。 */
          youCanEdit: { type: "boolean", required: true },
          summary: { type: "string", required: true },
          yourGrants: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                grantId: { type: "string", required: true },
                scope: { type: "string", required: true },
                expiresAt: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { action, agentId } = args as { action: string; agentId?: string };
      if (action !== "list" && action !== "add" && action !== "remove") {
        throw new Error(`legion_policy 不认识这个动作: ${action}（只认 list / add / remove）`);
      }
      const sessionId = exec.agent?.id;
      if (sessionId === undefined) throw new Error("legion_policy 需要一个绑定了灵魂档案的会话");
      const authority = ctx.get("voidAuthority") as AuthoritySource | undefined;
      if (typeof authority?.forSession !== "function") throw new Error("改派活名单缺少权威档案");
      const snapshot = await authority.forSession(sessionId);
      if (snapshot === undefined) throw new Error(`改派活名单缺少权威档案：会话 ${sessionId} 没有绑定灵魂档案`);
      const actorId = snapshot.actorId;

      if (action === "list") {
        const policy = await team.readDispatchPolicy();
        return render(policy, actorId, "list", false);
      }

      const target = typeof agentId === "string" ? agentId.trim() : "";
      if (target === "") throw new Error(`legion_policy ${action} 需要 agentId（SOUL 档案 id，不是显示名）`);
      const result = await team.mutateDispatchPolicyAsAgent({ actorId, action, agentId: target });
      return render(result.snapshot, actorId, action, result.changed);
    },
  }));
}

function render(
  policy: DispatchPolicySnapshot,
  actorId: string,
  action: "list" | "add" | "remove",
  changed: boolean,
) {
  const yourGrants = activePolicyGrants(policy)
    .filter((grant) => grant.agentId === actorId)
    .map((grant) => ({
      grantId: grant.grantId,
      scope: `${grant.scope.source}/${grant.scope.lists.join(",")}`,
      ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
    }));
  const count = policy.allowlist.length;
  const state = policy.configured
    ? count === 0
      ? "名单为空：当前没人能派活"
      : `${count} 个档案可以派活`
    : "名单还没配置：当前没人能派活";
  const summary =
    action === "list"
      ? `${state}（修订 ${policy.revision}）`
      : changed
        ? `已${action === "add" ? "加入" : "移出"}派活名单；${state}（修订 ${policy.revision}）`
        : `${action === "add" ? "档案已经在名单里" : "档案不在名单里"}；${state}（修订 ${policy.revision}）`;
  return {
    action,
    changed,
    configured: policy.configured,
    mode: policy.mode,
    allowlist: [...policy.allowlist],
    revision: policy.revision,
    youCanEdit: policy.mode === "agent" && yourGrants.length > 0,
    summary,
    yourGrants,
  };
}
