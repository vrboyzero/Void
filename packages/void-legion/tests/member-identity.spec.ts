import type { AuthoritySource } from "@void/void-soul";
import { describe, expect, it } from "vitest";
import { loadMemberPersonas, personaOf } from "../src/member-identity.js";
import type { DelegationTeamMember } from "../src/team.js";

function member(laneId: string, agentId?: string): DelegationTeamMember {
  return { laneId, ...(agentId === undefined ? {} : { agentId }) };
}

/** 假权威来源：`withPersonaFor: false` 演一个不提供逐成员身份的旧来源。 */
function source(input: { personas?: Record<string, string>; error?: string; withPersonaFor?: boolean } = {}): AuthoritySource {
  const base = { forSession: async () => undefined };
  if (input.withPersonaFor === false) return base as unknown as AuthoritySource;
  return {
    ...base,
    personaFor: async (agentId: string) => {
      if (input.error !== undefined) throw new Error(input.error);
      const text = input.personas?.[agentId];
      if (text === undefined) throw new Error(`没有这份档案，取不出派活身份: ${agentId}`);
      return text;
    },
  } as unknown as AuthoritySource;
}

describe("逐成员身份表（loadMemberPersonas）", () => {
  it("按 lane 把每个成员的身份取全", async () => {
    const personas = await loadMemberPersonas({
      authority: source({ personas: { xiaoma: "小马的底线", xiaohong: "小红的底线" } }),
      members: [member("lane_a", "xiaoma"), member("lane_b", "xiaohong")],
    });
    expect([...personas]).toEqual([["lane_a", "小马的底线"], ["lane_b", "小红的底线"]]);
  });

  it("成员没有档案 id 就拒绝：没有 id 就没有身份可取", async () => {
    await expect(loadMemberPersonas({
      authority: source({ personas: { xiaoma: "小马的底线" } }),
      members: [member("lane_a")],
    })).rejects.toThrow(/派活目标缺少档案 id: lane_a/);
  });

  it("来源不提供 personaFor 就拒绝，不悄悄派一支没有名分的队伍", async () => {
    await expect(loadMemberPersonas({
      authority: source({ withPersonaFor: false }),
      members: [member("lane_a", "xiaoma")],
    })).rejects.toThrow(/派活缺少逐成员身份：这个权威档案来源不提供 personaFor/);
  });

  it("一个成员取不出身份就整次拒绝，错误里带上 lane 与档案 id", async () => {
    await expect(loadMemberPersonas({
      authority: source({ personas: {} }),
      members: [member("lane_a", "ghost")],
    })).rejects.toThrow(
      /整队不派：1 个成员取不出派活身份——lane lane_a 的派活身份取不出来（ghost）：没有这份档案，取不出派活身份: ghost/,
    );
  });

  it("空身份也算取不出来：空字符串在宿主那边等于没带 persona", async () => {
    await expect(loadMemberPersonas({
      authority: source({ personas: { xiaoma: "   " } }),
      members: [member("lane_a", "xiaoma")],
    })).rejects.toThrow(/整队不派：1 个成员取不出派活身份——lane lane_a 的派活身份是空的（xiaoma）/);
  });

  it("有几个取不出来就一次报全：停用的成员被点名，不用改一个再撞下一个", async () => {
    // 「已停用」是灵魂侧抛出来的原话（`suspendedReason`），军团只负责带出来、不吞掉。
    const suspended = "档案已停用，拒绝派活: ajia（在面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）";
    const authority = {
      forSession: async () => undefined,
      personaFor: async (agentId: string) => {
        if (agentId === "xiaoma") return "小马的底线";
        throw new Error(agentId === "ajia" ? suspended : `没有这份档案，取不出派活身份: ${agentId}`);
      },
    } as unknown as AuthoritySource;
    const error = await loadMemberPersonas({
      authority,
      members: [member("lane_plan", "xiaoma"), member("lane_front", "ajia"), member("lane_check", "ayi")],
    }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toMatch(/整队不派：2 个成员取不出派活身份/);
    expect(error.message).toContain("lane lane_front 的派活身份取不出来（ajia）：档案已停用，拒绝派活: ajia");
    expect(error.message).toContain("lane lane_check 的派活身份取不出来（ayi）：没有这份档案");
    // 好的那个照样取到了，但整队还是不派——表里没有半个成员被漏掉。
    expect(error.message).not.toContain("lane_plan");
  });

  it("personaOf 查不到这个 lane 就抛，绝不返回 undefined（那等于不带身份）", () => {
    const personas = new Map([["lane_a", "小马的底线"]]);
    expect(personaOf(personas, "lane_a")).toBe("小马的底线");
    expect(() => personaOf(personas, "lane_b")).toThrow(/lane "lane_b" 没有取到派活身份，拒绝按无名分派出去/);
  });
});
