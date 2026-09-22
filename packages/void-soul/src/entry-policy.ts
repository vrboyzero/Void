/**
 * 模型工具入口的统一策略。
 *
 * 方案文档 §17.2 的 P2 退出条件要求「覆盖模型直接/间接工具入口」并「测试确认所有
 * 可用模型入口不能访问 Host 私人数据」。逐个工具去补判断是补不完的——新加一个
 * 工具就又开一个口子。所以这里按**入口种类**判，凡是不认识的工具一律按最宽的
 * 「管理」处理：宁可拒绝一个只读工具，也不默认放行一个能写盘的。
 *
 * 五类入口的处置：
 *
 * | 种类 | 含义 | 无读隔离时 | 有完整隔离时 |
 * |---|---|---|---|
 * | `read` | 只读，或只动本次会话的本地状态 | 放行 | 放行 |
 * | `write` | 会写文件 | 拒绝 | 放行 |
 * | `execute` | 会起进程/命令 | 拒绝 | 放行 |
 * | `host-private` | 会读到 Host 自己的状态（会话记录、插件运行时） | 拒绝 | **仍拒绝** |
 * | `manage` | 会改动 Host 或派生别的 Agent | 拒绝 | **仍拒绝** |
 *
 * `host-private` 与 `manage` 不是「隔离好了就开放」的东西：它们根本不在 Agent 的
 * 能力范围里，隔离解决的是文件可见性，不是权限。
 *
 * @module @void/void-soul/entry-policy
 */
import { isExecutionAllowed, type ExecutionIsolation } from "./execution-policy.js";

export type ToolEntryKind = "read" | "write" | "execute" | "host-private" | "manage";

export class EntryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryPolicyError";
  }
}

/** `@void/void-tools` 契约里与本策略相关的字段。只读消费，不引入依赖。 */
export interface ToolContractLike {
  name?: string | undefined;
  family?: string | undefined;
  isReadOnly?: boolean | undefined;
  needsPermission?: boolean | undefined;
  riskLevel?: string | undefined;
}

export interface EntryPolicyOptions {
  /** 当前执行环境的隔离能力。没提供就当作完全没有隔离。 */
  isolation?: ExecutionIsolation | undefined;
  /**
   * 显式开关：读隔离落地前，在隔离 profile 里恢复写/执行入口。
   * 默认关闭——默认放行等于把 P2 的退出条件做成注释。
   */
  allowUnisolated?: boolean | undefined;
  /** 逐个工具名的显式放行（例如只写本档案记忆根的业务工具）。 */
  allowed?: readonly string[] | undefined;
}

const EXECUTE_FAMILIES = new Set(["command-exec", "shell", "exec", "process", "terminal"]);
const WRITE_FAMILIES = new Set(["workspace-write", "file-write", "patch", "edit", "filesystem-write"]);
const MANAGE_FAMILIES = new Set(["plugin", "session", "admin", "manage", "control-plane", "config"]);
const HOST_PRIVATE_FAMILIES = new Set(["session-query", "runtime-inspect", "host-state"]);

/**
 * 只读或只动本次会话本地状态的工具名。
 *
 * 这份名单对着 alpha.2 参考源码里 `defineTool({ name: ... })` 的真实工具面逐一核过
 * （见 `tests/entry-policy.spec.ts` 的 `HOST_TOOL_SURFACE`）。名单外的名字一律不
 * 当作只读——加新工具的人必须显式来这里认领，否则它默认被拒。
 */
const READ_NAMES = new Set([
  // 文件与检索
  "read", "read_file", "read_image", "glob", "grep", "search", "list", "list_dir", "lsp",
  // 会话本地状态
  "ask_user_question", "todo_write", "get_goal",
  // 作业与 Agent 的只读视图
  "job_output", "job_list", "list_agents", "wait_agent", "list_subagent_models",
  // 外部资源读取（MCP 与网络；它们不碰 Host 私人数据）
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "skill", "web_search", "web_fetch",
  // 本套件的记忆读取
  "memory_search", "memory_read", "memory_list",
  // 本套件的本机抓取：只发 GET、只去 profile 里逐条白名单的本机地址，重定向逐跳再校验
  // （把关全在工具内部，见 `@void/void-tools/local-fetch`；这里只认它是只读入口）
  "local_fetch",
]);

/** 会起进程或命令的工具名。 */
const EXECUTE_NAMES = new Set([
  "bash", "pwsh", "powershell", "shell", "exec", "run_command", "spawn", "terminal",
  "terminal_open", "terminal_close", "terminal_list", "terminal_read", "terminal_send", "terminal_signal",
]);

/** 会写文件的工具名。 */
const WRITE_NAMES = new Set([
  "write", "write_file", "edit", "edit_file", "patch", "apply_patch", "str_replace", "str_replace_editor", "notebook_edit",
  "memory_write", "memory_update", "memory_retract",
]);

/**
 * 会读到 Host 自己状态的工具名——原生会话查询与插件运行时检视。
 *
 * §17.2 把「原生 session 查询」点名为必须拒绝的绕过用例：会话库里是别人的对话、
 * 路径、密钥痕迹，隔离文件系统也改变不了「这不是这个 Agent 该看的东西」。
 */
const HOST_PRIVATE_NAMES = new Set([
  "session_search", "session_trace", "session_event_read", "session_event_search", "session_event_trace",
  "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self",
]);

/** 会改动 Host 或派生别的 Agent 的工具名。 */
const MANAGE_NAMES = new Set([
  "plugin_manager", "spawn_teammate", "team_task_create", "team_task_get", "team_task_list", "team_task_update",
  "schedule_create", "schedule_delete", "schedule_list", "create_goal", "update_goal",
  "send_message", "interrupt_agent", "job_kill", "ralph", "present",
  // 动态改插件运行时：cordis_define/run/stop/undefine 是改 Host 本身，不是「看一眼」。
  "cordis_define", "cordis_run", "cordis_stop", "cordis_undefine",
]);

/**
 * 判定一个工具属于哪一类入口。
 *
 * 契约优先于名字：名字是给人看的，契约是给策略看的。两者都没有明确结论时返回
 * `manage`——最宽的一类，因此会被默认拒绝。
 */
export function classifyToolEntry(input: { name: string; contract?: ToolContractLike | undefined }): ToolEntryKind {
  const contract = input.contract;
  if (contract?.isReadOnly === true) return "read";
  const family = contract?.family?.toLowerCase();
  if (family !== undefined) {
    if (HOST_PRIVATE_FAMILIES.has(family)) return "host-private";
    if (EXECUTE_FAMILIES.has(family)) return "execute";
    if (WRITE_FAMILIES.has(family)) return "write";
    if (MANAGE_FAMILIES.has(family)) return "manage";
  }
  const name = input.name.toLowerCase();
  if (READ_NAMES.has(name)) return "read";
  if (EXECUTE_NAMES.has(name)) return "execute";
  if (WRITE_NAMES.has(name)) return "write";
  if (HOST_PRIVATE_NAMES.has(name)) return "host-private";
  if (MANAGE_NAMES.has(name)) return "manage";
  // 前导词兜底：`session_*` 一律按 Host 私人数据，`plugin*`/`team_*` 一律按管理。
  if (name.startsWith("session_")) return "host-private";
  if (name.startsWith("cordis_inspect")) return "host-private";
  if (name.startsWith("plugin") || name.startsWith("team_") || name.startsWith("schedule_") || name.startsWith("mcp")) return "manage";
  if (name.startsWith("cordis_")) return "manage";
  return "manage";
}

/**
 * 判定一个入口该不该拒，拒绝就给出原因。
 *
 * 单独抽出来是因为 Host 有两种接入方式：`tools.guard` 要的是「返回原因字符串」，
 * 注册表包装要的是「抛异常」。两者必须给出同一句话，否则同一个工具在不同通道下
 * 的行为会不一致。
 *
 * @returns 拒绝原因；`undefined` 表示放行。
 */
export function entryDenialReason(input: {
  name: string;
  contract?: ToolContractLike | undefined;
  policy: EntryPolicyOptions;
}): string | undefined {
  const kind = classifyToolEntry({ name: input.name, contract: input.contract });
  if (kind === "read") return undefined;
  if ((input.policy.allowed ?? []).includes(input.name)) return undefined;
  if (kind === "host-private") {
    return `工具 ${input.name} 会读到 Host 私人数据（会话记录或插件运行时），未开放给 Agent，已拒绝`;
  }
  if (kind === "manage") {
    return `工具 ${input.name} 属于管理入口，未开放给 Agent，已拒绝`;
  }
  // 与底层 shell 门禁共用同一个判定（`isExecutionAllowed`）：`allowUnisolated` 与
  // 「读写都隔离」两种放行理由都在里面，同一份配置在两处必须同答。
  if (isExecutionAllowed(input.policy)) return undefined;
  const what = kind === "execute" ? "原始执行" : "写入";
  return `工具 ${input.name} 属于${what}入口，需要读隔离执行环境，本机没有，已拒绝`;
}

/**
 * 放行或拒绝一个工具入口。
 *
 * @returns 判定出来的入口种类，方便调用方记录。
 * @throws {EntryPolicyError} 拒绝时一定带明确原因，不静默降级成「不注册」。
 */
export function assertToolEntryAllowed(input: {
  name: string;
  contract?: ToolContractLike | undefined;
  policy: EntryPolicyOptions;
}): ToolEntryKind {
  const reason = entryDenialReason(input);
  if (reason !== undefined) throw new EntryPolicyError(reason);
  return classifyToolEntry({ name: input.name, contract: input.contract });
}
