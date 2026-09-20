/**
 * 「虚空（Void）」面板清单。
 *
 * 字段标签、控件选择与业务词汇表都是**本插件自己的知识**，所以由本插件贡献给
 * 入口的 `ctx.voidSuite`，而不是让入口维护一张涵盖所有插件的大表——那样两边
 * 各写一份，日久必然失同步。
 *
 * 前置关系**不在这里重述**：它必须与运行时 `expandOperations` 完全一致，否则界面
 * 显示的授权范围会和实际生效的不符。这里直接用 `protocol.ts` 那一份，
 * {@link impliedOperations} 就是它的反向查询。
 *
 * 面板本身不认识这些 id；装在不含 `void-entry` 的 profile 里时，这段逻辑不执行。
 *
 * @module @void/void-dsh-control/panel
 */
import type { Context } from "@deepseek-ai/cordis";
import { CONTROL_OPERATIONS, expandOperations, type ControlOperation } from "./protocol.js";

/** 与入口 `VoidSuite.registerPanel` 的结构契约（结构性重述，避免跨包类型依赖）。 */
interface PanelHost {
  registerPanel(packageName: string, manifest: unknown): () => void;
}

/** 包名：面板按它把清单挂到目录里对应的那一行。 */
const PACKAGE = "@void/void-dsh-control";

/** 十种业务的中文通俗名（对应方案文档 §25.5.1 的表格）。 */
const OPERATION_LABELS: Record<ControlOperation, string> = {
  "workspace.read": "看项目与对话",
  "workspace.open": "登记项目文件夹",
  "session.list": "列出对话",
  "session.create": "开新对话",
  "session.prompt": "给对话发消息",
  "session.inject": "塞背景资料",
  "session.steer": "干活时插话改方向",
  "session.observe": "看进度与状态",
  "task.read": "查派出去的活",
  "task.cancel": "撤回派出去的活",
};

/** 最常用的那一项，在矩阵里特别标注。 */
const MOST_USED: ControlOperation = "session.prompt";

/**
 * 列出「因为勾了别的项而自动生效」的权限。
 *
 * 直接用运行时的展开函数求闭包再减去用户勾选的，所以界面标出来的灰色项与
 * `Authenticator` 实际授予的权限必然是同一套。
 *
 * @param selected - 用户勾选的权限。
 * @returns 会自动生效但用户没勾的权限，按词汇表顺序。
 */
export function impliedOperations(selected: readonly ControlOperation[]): ControlOperation[] {
  const chosen = new Set(selected);
  const effective = expandOperations(selected);
  return CONTROL_OPERATIONS.filter((name) => effective.has(name) && !chosen.has(name));
}

/**
 * 构建面板清单。
 *
 * @returns 分组、字段提示与业务词汇表。
 */
export function buildPanelManifest(): unknown {
  return {
    namespace: "dsh-agent-control",
    groups: [
      {
        id: "basic",
        title: "基本",
        fields: [
          { path: ["enabled"], label: "启用控制面", widget: "switch", readOnly: true, help: "关闭后不注册端点。由组合入口 cordis.patch.yml 决定，改后需重启" },
          { path: ["path"], label: "端点路径", widget: "text", readOnly: true, help: "由组合入口决定，改后需重启" },
          { path: ["ledger"], label: "账本后端", widget: "text", readOnly: true, help: "storage 持久 / memory 重启即丢。由组合入口决定，改后需重启" },
          { path: ["transport"], label: "传输方式", widget: "text", readOnly: true, help: "目前只实现 streamable-http。由组合入口决定" },
        ],
      },
      {
        id: "permissions",
        title: "权限",
        summary: "允许对方办哪些业务",
        fields: [
          {
            path: ["allowedOperations"],
            label: "默认授权集合",
            widget: "operations",
            help: "凭据没单独声明权限时用这一套。勾选某项会自动带上前置项，灰色标注的是自动补的。",
          },
          {
            path: ["allowAnonymous"],
            label: "允许无凭据调用",
            widget: "switch",
            danger: true,
            help: "仅供本机测试。开启后任何能访问该端口的人都能指挥 DSH。",
          },
        ],
      },
      {
        id: "callers",
        title: "调用方",
        summary: "凭据与环境变量名",
        fields: [
          {
            path: ["tokens"],
            label: "机器调用凭据",
            widget: "tokens",
            help: "每行是一个调用方。token 的值只从环境变量读，不写进配置，也不显示在这里。",
          },
        ],
      },
      {
        id: "workspaces",
        title: "工作区根目录",
        summary: "允许按路径寻址的目录",
        fields: [
          {
            path: ["allowedRoots"],
            label: "允许的根目录",
            widget: "list",
            help: "留空则完全禁用按路径寻址。只接受存在且为绝对路径的目录。",
          },
        ],
      },
      {
        id: "requirements",
        title: "任务要求",
        summary: "必填字段 · 文档要求 · 禁用正则",
        fields: [
          { path: ["callerInstructions"], label: "调用约束正文", widget: "text", help: "dsh_control_info 返回给外部 Agent 的说明" },
          { path: ["requiredFields"], label: "必填 metadata 字段", widget: "list" },
          { path: ["requiredDocumentRules"], label: "任务文档要求", widget: "rules" },
          { path: ["forbiddenPatterns"], label: "禁用正则", widget: "list", help: "命中即拒绝；用于禁止密钥等内容进入会话" },
          { path: ["instructionsVersion"], label: "规则版本号", widget: "number", help: "改动规则时递增" },
        ],
      },
      {
        id: "callback",
        title: "回调通知",
        summary: "未启用",
        fields: [
          { path: ["callback", "enabled"], label: "启用回调", widget: "switch" },
          { path: ["callback", "url"], label: "回调地址", widget: "text" },
          { path: ["callback", "secretEnv"], label: "签名密钥变量名", widget: "text", help: "密钥本身只从环境变量读" },
          { path: ["callback", "events"], label: "触发事件", widget: "list" },
          { path: ["callback", "timeoutMs"], label: "超时（毫秒）", widget: "number" },
          { path: ["callback", "maxAttempts"], label: "最大重试次数", widget: "number" },
          { path: ["callback", "allowedHosts"], label: "主机白名单", widget: "list", help: "留空表示接受配置里写的地址" },
          { path: ["callback", "includeAssistantSummary"], label: "附带助手摘要", widget: "switch", help: "模型产出的文本，默认不发送" },
        ],
      },
    ],
    operations: CONTROL_OPERATIONS.map((value) => ({
      value,
      label: OPERATION_LABELS[value],
      // 下发**传递闭包**而不是直接边：客户端只做集合并集，不做图运算，所以它没有
      // 任何机会把展开规则实现错。这些值就是 expandOperations 的输出本身。
      implies: [...expandOperations([value])].filter((implied) => implied !== value),
      ...(value === MOST_USED ? { mostUsed: true } : {}),
    })),
  };
}

/**
 * 把清单贡献给入口。
 *
 * `voidSuite` 是可选依赖：装在没有 `void-entry` 的 profile 里时它永远不出现，
 * 本插件的其余功能不受影响。
 *
 * @param ctx - 插件上下文。
 */
export function registerVoidPanel(ctx: Context): void {
  ctx.inject(["voidSuite"], (panelCtx) => {
    const host = panelCtx.get("voidSuite") as PanelHost | undefined;
    if (host === undefined || typeof host.registerPanel !== "function") return;
    panelCtx.effect(() => host.registerPanel(PACKAGE, buildPanelManifest()), "void-dsh-control: panel manifest");
  });
}
