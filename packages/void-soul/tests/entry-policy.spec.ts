import { describe, expect, it } from "vitest";
import { assertToolEntryAllowed, classifyToolEntry, EntryPolicyError, type ToolEntryKind } from "../src/entry-policy.js";

const NO_ISOLATION = { readIsolated: false, writeIsolated: true };
const FULL_ISOLATION = { readIsolated: true, writeIsolated: true };

/**
 * alpha.2 参考源码里全部模型可见工具的真实名字。
 *
 * 来源：`Void/参考项目/deepseek-harness-dsh-v0.1.6-alpha.2/packages/**` 中所有
 * `defineTool({ name: '...' })` 的字面量。列在这里是为了让「覆盖所有模型入口」这句
 * 话有可核对的名单，而不是靠人记得去补。
 */
const HOST_TOOL_SURFACE = [
  "ask_user_question", "bash", "cordis_define", "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self",
  "cordis_run", "cordis_stop", "cordis_undefine", "create_goal", "edit",
  "get_goal", "glob", "grep", "interrupt_agent", "job_kill", "job_list", "job_output", "list_agents",
  "list_mcp_resource_templates", "list_mcp_resources", "list_subagent_models", "lsp", "plugin_manager",
  "present", "pwsh", "ralph", "read", "read_image", "read_mcp_resource", "schedule_create",
  "schedule_delete", "schedule_list", "send_message", "session_event_read", "session_event_search",
  "session_event_trace", "session_search", "session_trace", "skill", "spawn_teammate",
  "str_replace_editor", "team_task_create", "team_task_get", "team_task_list", "team_task_update",
  "terminal_close", "terminal_list", "terminal_open", "terminal_read", "terminal_send", "terminal_signal",
  "todo_write", "update_goal", "wait_agent", "web_fetch", "web_search", "write",
] as const;

/**
 * 本机装着的 rc（0.1.5-rc.1）里真实存在的工具名，从 `node_modules/@deepseek-ai/dsh/
 * node_modules/@deepseek-ai/**` 的 `defineTool({ ... name: "..." })` 静态提取。
 *
 * 与上面的 alpha.2 参考面不完全一样——rc 多了 5 个 `cordis_*`，少了会话/终端/MCP
 * 那批。两个面都要覆盖，所以并集才是断言对象。
 */
const INSTALLED_RC_TOOL_SURFACE = [
  "ask_user_question", "bash", "cordis_define", "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self",
  "cordis_run", "cordis_stop", "cordis_undefine", "create_goal", "edit", "get_goal", "glob", "grep",
  "interrupt_agent", "job_kill", "job_list", "job_output", "list_subagent_models", "present", "pwsh", "ralph",
  "read", "read_image", "schedule_create", "schedule_delete", "schedule_list", "send_message", "skill",
  "str_replace_editor", "todo_write", "update_goal", "web_fetch", "web_search", "write",
] as const;

/** 本套件自己注册的模型可见工具（P3 记忆 + P4 军团）。 */
const VOID_TOOL_SURFACE = [
  "memory_search", "memory_read", "memory_list", "memory_write", "memory_update", "memory_retract",
  "launch_legion",
] as const;

const WRITE_OR_EXECUTE = new Set(["write", "execute"]);
const HOST_PRIVATE_OR_MANAGE = new Set<ToolEntryKind>(["host-private", "manage"]);

describe("tool entry classification", () => {
  it("takes the declared contract over the tool name", () => {
    // 名字看着像写，契约说是只读——以契约为准。
    expect(classifyToolEntry({ name: "write_report", contract: { isReadOnly: true } })).toBe("read");
    expect(classifyToolEntry({ name: "read_file", contract: { family: "command-exec" } })).toBe("execute");
    expect(classifyToolEntry({ name: "anything", contract: { family: "workspace-write" } })).toBe("write");
    expect(classifyToolEntry({ name: "anything", contract: { family: "plugin" } })).toBe("manage");
  });

  it("falls back to name families for the host's built-in tools", () => {
    expect(classifyToolEntry({ name: "read" })).toBe("read");
    expect(classifyToolEntry({ name: "grep" })).toBe("read");
    expect(classifyToolEntry({ name: "memory_search" })).toBe("read");
    expect(classifyToolEntry({ name: "bash" })).toBe("execute");
    expect(classifyToolEntry({ name: "pwsh" })).toBe("execute");
    expect(classifyToolEntry({ name: "write" })).toBe("write");
    expect(classifyToolEntry({ name: "edit" })).toBe("write");
    expect(classifyToolEntry({ name: "apply_patch" })).toBe("write");
    expect(classifyToolEntry({ name: "plugin" })).toBe("manage");
  });

  // 不认识的工具按最宽的一类处理：新工具默认被拒绝，而不是默认放行。
  it("treats an unknown tool as the widest entry kind", () => {
    expect(classifyToolEntry({ name: "brand_new_thing" })).toBe("manage");
    expect(classifyToolEntry({ name: "brand_new_thing", contract: { riskLevel: "low" } })).toBe("manage");
  });
});

describe("tool entry policy", () => {
  it("always allows read entries, isolation or not", () => {
    expect(assertToolEntryAllowed({ name: "read", policy: { isolation: NO_ISOLATION } })).toBe("read");
    expect(assertToolEntryAllowed({ name: "memory_search", policy: {} })).toBe("read");
  });

  // P2 退出条件：无隔离时原始执行不可用。
  it("refuses write and execute entries while there is no read isolation", () => {
    expect(() => assertToolEntryAllowed({ name: "bash", policy: { isolation: NO_ISOLATION } })).toThrow(EntryPolicyError);
    expect(() => assertToolEntryAllowed({ name: "bash", policy: { isolation: NO_ISOLATION } })).toThrow(
      /工具 bash 属于原始执行入口，需要读隔离执行环境，本机没有，已拒绝/,
    );
    expect(() => assertToolEntryAllowed({ name: "write", policy: { isolation: NO_ISOLATION } })).toThrow(/工具 write 属于写入入口/);
    // 完全没有 isolation 字段时按最坏情况处理。
    expect(() => assertToolEntryAllowed({ name: "edit", policy: {} })).toThrow(/已拒绝/);
    // 只限制写入不算隔离。
    expect(() => assertToolEntryAllowed({ name: "bash", policy: { isolation: { readIsolated: false, writeIsolated: true } } })).toThrow(/已拒绝/);
  });

  it("allows write and execute once both isolations are in place", () => {
    expect(assertToolEntryAllowed({ name: "bash", policy: { isolation: FULL_ISOLATION } })).toBe("execute");
    expect(assertToolEntryAllowed({ name: "write", policy: { isolation: FULL_ISOLATION } })).toBe("write");
  });

  // 管理入口不是「隔离好了就开放」的东西：它根本不在 Agent 的能力范围里。
  it("refuses manage entries even with full isolation", () => {
    expect(() => assertToolEntryAllowed({ name: "plugin", policy: { isolation: FULL_ISOLATION } })).toThrow(
      /工具 plugin 属于管理入口，未开放给 Agent，已拒绝/,
    );
    expect(() => assertToolEntryAllowed({ name: "session", policy: { isolation: FULL_ISOLATION, allowUnisolated: true } })).toThrow(/管理入口/);
  });

  it("honours the explicit switch and the per-tool allow list", () => {
    expect(assertToolEntryAllowed({ name: "bash", policy: { isolation: NO_ISOLATION, allowUnisolated: true } })).toBe("execute");
    expect(assertToolEntryAllowed({ name: "write", policy: { isolation: NO_ISOLATION, allowUnisolated: true } })).toBe("write");
    // 逐名放行只对该工具生效，不会顺带放开别的。
    const policy = { isolation: NO_ISOLATION, allowed: ["write"] };
    expect(assertToolEntryAllowed({ name: "write", policy })).toBe("write");
    expect(() => assertToolEntryAllowed({ name: "edit", policy })).toThrow(/已拒绝/);
    // 逐名放行也救不回 Host 私人数据与管理入口。
    expect(() => assertToolEntryAllowed({ name: "session_search", policy: { isolation: NO_ISOLATION, allowed: ["session_search"] } })).not.toThrow();
    expect(() => assertToolEntryAllowed({ name: "session_search", policy: { isolation: NO_ISOLATION } })).toThrow(/Host 私人数据/);
  });
});

describe("coverage of the real host tool surface", () => {
  // P2 退出条件：测试确认所有可用模型入口不能访问 Host 私人数据。
  it("classifies every real model-facing tool, and never silently allows an unknown one", () => {
    // 两个真实工具面（alpha.2 参考源码 + 本机装着的 rc）都必须被覆盖。
    for (const name of INSTALLED_RC_TOOL_SURFACE) expect(HOST_TOOL_SURFACE).toContain(name);
    expect(new Set(HOST_TOOL_SURFACE).size).toBe(HOST_TOOL_SURFACE.length);
    const unclassified = HOST_TOOL_SURFACE.filter((name) => classifyToolEntry({ name }) === "manage" && !/^(plugin|team_|schedule_|mcp|cordis_|session_)/.test(name));
    // 落进 manage 兜底的必须是真的管理类，不能是「没人认领的只读工具」。
    expect(unclassified).toEqual(["create_goal", "interrupt_agent", "job_kill", "present", "ralph", "send_message", "spawn_teammate", "update_goal"]);
    // 全部 58 个真实工具都有明确归类。
    expect(HOST_TOOL_SURFACE).toHaveLength(58);
    for (const name of HOST_TOOL_SURFACE) expect(classifyToolEntry({ name })).toBeTypeOf("string");
    // 动态改插件运行时的那几个属于管理入口，不是「看一眼」。
    for (const name of ["cordis_define", "cordis_run", "cordis_stop", "cordis_undefine"]) {
      expect(classifyToolEntry({ name })).toBe("manage");
    }
    for (const name of ["cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self"]) {
      expect(classifyToolEntry({ name })).toBe("host-private");
    }
  });

  it("allows only read-only entries while there is no read isolation", () => {
    const allowed: string[] = [];
    const refused: string[] = [];
    for (const name of [...HOST_TOOL_SURFACE, ...VOID_TOOL_SURFACE]) {
      try {
        const kind = assertToolEntryAllowed({ name, policy: { isolation: NO_ISOLATION } });
        expect(kind).toBe("read");
        allowed.push(name);
      } catch (error) {
        expect(error).toBeInstanceOf(EntryPolicyError);
        refused.push(name);
      }
    }
    // 放行的必须全是只读：没有一个写盘、起进程、读 Host 状态或改 Host 的工具混进来。
    for (const name of allowed) {
      expect(WRITE_OR_EXECUTE.has(classifyToolEntry({ name }))).toBe(false);
      expect(HOST_PRIVATE_OR_MANAGE.has(classifyToolEntry({ name }))).toBe(false);
    }
    // 写盘与起进程的真实入口全部被拒。
    for (const name of ["write", "edit", "str_replace_editor", "bash", "pwsh", "terminal_open", "terminal_send"]) {
      expect(refused).toContain(name);
    }
    // 原生会话查询与插件运行时检视被拒。
    for (const name of ["session_search", "session_trace", "session_event_read", "session_event_search", "session_event_trace", "cordis_inspect_list", "cordis_inspect_query"]) {
      expect(refused).toContain(name);
    }
    // 军团派活工具要起子代理，无隔离时同样被拒。
    expect(refused).toContain("launch_legion");
    // 记忆读写里只有读的三个放行；写/改/撤回要显式放行（见插件配置）。
    expect(allowed).toEqual(expect.arrayContaining(["memory_search", "memory_read", "memory_list"]));
    expect(refused).toEqual(expect.arrayContaining(["memory_write", "memory_update", "memory_retract"]));
  });

  // 会话记录与插件运行时不是「隔离好了就能看」的东西。
  it("still refuses host-private entries with full isolation", () => {
    for (const name of ["session_search", "session_trace", "session_event_search", "cordis_inspect_query"]) {
      expect(() => assertToolEntryAllowed({ name, policy: { isolation: FULL_ISOLATION, allowUnisolated: true } })).toThrow(/Host 私人数据/);
    }
  });

  it("opens the write and execute surface only after both isolations exist", () => {
    for (const name of ["write", "edit", "str_replace_editor", "bash", "pwsh"]) {
      expect(() => assertToolEntryAllowed({ name, policy: { isolation: NO_ISOLATION } })).toThrow(/已拒绝/);
      expect(() => assertToolEntryAllowed({ name, policy: { isolation: FULL_ISOLATION } })).not.toThrow();
    }
  });
});
