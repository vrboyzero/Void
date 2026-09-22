/**
 * 业务详情视图的共享契约与请求门禁。
 *
 * 入口只认「视图 id + 渲染数据 + 回调」，队伍、任务、记忆、灵魂档案这些业务一律由
 * **所属插件**实现（§16.1）：入口长出第二套业务知识就会两边各写一份、日久失同步，
 * 而插件各自最清楚自己的数据根与修订语义。
 *
 * 门禁也在这里，而不是散在每个 handler 里：新增一条写路由时忘了核对来源，是这类
 * 面板最典型的漏洞，所以核对只有一处实现（{@link assertTrustedMutation}）。
 */

/** 与入口 `ProfileLocation` 同形。重述一遍是为了让本模块不反向依赖入口实现。 */
export interface DetailProfile {
  home: string;
  name: string;
}

/** 列表里的一条。摘要与次要信息都是**已经算好的文字**，面板不再推断业务含义。 */
export interface VoidDetailItem {
  id: string;
  title: string;
  /** 一行状态文字。不写百分比——进度按真实结算数说（§15.2）。 */
  summary?: string;
  /** 右侧次要信息，如「修订 3」。 */
  meta?: string;
}

/**
 * 列表结果。除了条目还能带一行说明。
 *
 * `note` 是**列表级**的话（「每个档案最多列 20 条，更早的用检索找」「有 1 个档案读不出来」），
 * 塞进某一条里就会被当成那一条的属性；而列表被截断这件事必须说出来，不能让人以为
 * 「就这些」。只返回数组也是合法的，旧的视图不必改。
 */
export interface VoidDetailList {
  items: readonly VoidDetailItem[];
  note?: string;
}

/**
 * 检索声明。给了就在列表上方出搜索框，`list` 会收到 `query`。
 *
 * 检索为什么走 `list` 的参数而不是另开一条路由：结果本来就是「列出来的那些条目」，
 * 分成两套渲染只会让面板里出现两种列表。声明放在这里，是因为**只有所属插件知道
 * 这份数据能不能检索、检索的是不是全量**——记忆只查索引，队伍根本不查。
 */
export interface VoidDetailSearch {
  /** 输入框的占位提示，如「检索本人的记忆」。 */
  label?: string;
  /** 输入框下方的一行说明，如「只查索引，不全量扫描」。 */
  hint?: string;
}

/**
 * 详情里的一个展示区块。
 *
 * 给的是**结构化数据**而不是拼好的 HTML：Markdown 正文要按安全文本渲染，表格与
 * 组织图各有各的渲染方式，插件不该替面板决定长什么样。
 */
export interface VoidDetailTextSection {
  id: string;
  title: string;
  /** 渲染提示。面板不认识的值退化为纯文本，因此新增类型不会让旧面板崩。 */
  kind?: "lines" | "table" | "org";
  /** `table` 用。 */
  columns?: readonly string[];
  rows?: ReadonlyArray<readonly string[]>;
  /** `lines` / `org` 用。 */
  lines?: readonly string[];
  /**
   * `table` 用：哪些格子其实是一个能点开的原生会话。
   *
   * 键是 `${行号}:${列号}`（都从 0 数），值是宿主原生会话 id。面板不认识这个字段时照旧
   * 画纯文本——链接是增强，不是数据本身。
   */
  sessionLinks?: Readonly<Record<string, string>>;
}

/** 可编辑行表格的一列。`type` 决定面板给什么控件、以及把文本转回什么值。 */
export interface VoidDetailColumn {
  key: string;
  label: string;
  type?: "text" | "list" | "boolean" | "number";
}

/**
 * 可编辑的行表格：一组同形对象（成员名单、检索结果）的编辑面。
 *
 * 单独给一种区块、而不是让人编辑 JSON 文本，是因为面板要解决的问题正是「不必手改
 * JSON 才能用」——塞一个 JSON 文本框进来只是把编辑器搬了个地方。写回时整组替换
 * `changes[key]`，由所属插件按自己的校验规则决定收不收。
 */
export interface VoidDetailRowsSection {
  id: string;
  title: string;
  kind: "rows";
  columns: readonly VoidDetailColumn[];
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** 写回 `changes` 时用的字段名；不给就是只读表格。 */
  key?: string;
  editable?: boolean;
  /** 「加一行」按钮的文字；不给按「加一行」。 */
  addLabel?: string;
  help?: string;
}

export type VoidDetailSection = VoidDetailTextSection | VoidDetailRowsSection;

/**
 * 一个可编辑字段的当前值。
 *
 * `readOnly` 的字段照旧展示、但不给编辑控件：渲染出一个「写了不生效」的控件是最糟的
 * 面板 bug，因为它看起来像是成功了。
 */
export interface VoidDetailField {
  key: string;
  label: string;
  value: string | number | null;
  readOnly?: boolean;
  /**
   * 控件形状。默认单行文本框；`markdown` 给多行正文（模组 Markdown 草稿）用。
   *
   * 多行正文仍然只是**字符串**，不是 HTML：面板按安全文本渲染与提交，绝不 `innerHTML`。
   */
  kind?: "text" | "markdown";
  /** 一句话说明，显示在控件下方。 */
  help?: string;
}

/** 详情正文。 */
export interface VoidDetailBody {
  title: string;
  /** 安全文本渲染的 Markdown（SOUL 正文、任务说明）。 */
  markdown?: string;
  sections: readonly VoidDetailSection[];
  /**
   * 开始编辑时的修订号；保存时原样带回，用来挡住并发覆盖。
   *
   * 数字或字符串都行：队伍配置的修订是自增整数，而文件正文（模组 Markdown）的修订
   * 是内容哈希。面板不解释它，只负责带回来。
   */
  revision?: number | string;
  fields?: readonly VoidDetailField[];
  /** 这个详情上能做的动作（停单任务/全队等）。 */
  actions?: readonly VoidDetailAction[];
  /**
   * 这份详情还在动（一次运行还在跑、一份文件正被别的进程改）：面板打开期间会自动重读它。
   *
   * 只该在**还没结束**的对象上置位；终态置位等于让面板白轮询。
   */
  live?: boolean;
}

/**
 * 详情上的一个动作（不是字段：动作会改状态，字段只是可写数据）。
 *
 * `args` 描述动作需要哪些参数，面板据此收集后再调 {@link VoidDetailSource.act}。
 */
export interface VoidDetailAction {
  id: string;
  label: string;
  hint?: string;
  /** 会造成不可逆后果的动作，需要二次确认。 */
  danger?: boolean;
  args?: readonly VoidDetailField[];
}

/**
 * 一个业务视图的数据来源，由所属插件登记。
 *
 * `save` / `act` / `actView` 都是可选的：只读视图不实现它们，入口也不会给出编辑控件。
 */
export interface VoidDetailSource {
  /** 视图 id，形如 `void-legion:teams`；重复登记会被拒绝。 */
  id: string;
  title: string;
  /**
   * 视图级动作：不针对某一条的动作（新建队伍这类「条目还不存在」的事）。
   *
   * 面板把它们显示在条目列表上方；点了就走 {@link VoidDetailSource.actView}，
   * 成功后重新读一次列表——新建出来的条目自然会出现在列表里。
   */
  viewActions?: readonly VoidDetailAction[];
  /** 有它就有搜索框；`list` 会收到 `query`（没检索时是 `undefined`）。 */
  search?: VoidDetailSearch;
  list(input: DetailProfile & { query?: string }): Promise<readonly VoidDetailItem[] | VoidDetailList>;
  detail(input: DetailProfile & { itemId: string }): Promise<VoidDetailBody>;
  save?(
    input: DetailProfile & { itemId: string; expectedRevision: number | string; changes: Readonly<Record<string, unknown>> },
  ): Promise<VoidDetailBody>;
  /**
   * 条目上的动作（停单任务、删队伍等）。
   *
   * `expectedRevision` 是面板打开这一条时读到的修订：动作也可能是破坏性的（删除、
   * 取消），用同一条栅挡住「看着旧数据下手」。面板没给就是没栅，来源可以自己要求它。
   */
  act?(
    input: DetailProfile & {
      itemId: string;
      actionId: string;
      args: Readonly<Record<string, unknown>>;
      expectedRevision?: number | string | undefined;
    },
  ): Promise<VoidDetailBody>;
  /** 视图级动作的执行；没有返回值，面板随后重读列表。 */
  actView?(input: DetailProfile & { actionId: string; args: Readonly<Record<string, unknown>> }): Promise<void>;
}

/** 浏览器跨站发不出的自定义头。它出现，就说明请求来自我们自己的页面。 */
export const VOID_REQUEST_HEADER = "x-void-request";

/** 请求被门禁挡下。`statusCode` 决定入口回什么码。 */
export class VoidRequestRejected extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "VoidRequestRejected";
  }
}

/**
 * 门禁要看的那几个字段。
 *
 * 结构性重述：host 半的请求对象是 node 的 `IncomingMessage`，这里只声明用到的部分，
 * 免得为了一个类型把 node 类型拖进客户端可见的模块。
 */
export interface VoidRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** 取一个请求头（同名多值时取第一个，node 对这几个头不会给数组）。 */
export function requestHeader(req: VoidRequestLike, name: string): string | undefined {
  const value = req.headers?.[name.toLowerCase()];
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * 核对同源。**只看 Origin，不做「本机地址所以可信」的假设**（§16.1）。
 *
 * 没有 Origin 的请求（curl、测试、非浏览器客户端）放行：这条路由挡的是「用户浏览器
 * 里的别的页面替用户发请求」，而不是挡命令行。有 Origin 就必须与 Host 一致——否则
 * 一个恶意页面就能让用户的面板替它读档案、改队伍。
 */
export function assertSameOrigin(req: VoidRequestLike): void {
  const origin = requestHeader(req, "origin");
  if (origin === undefined) return;
  const host = requestHeader(req, "host");
  if (host === undefined) throw new VoidRequestRejected("请求缺少 Host，无法核对同源");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new VoidRequestRejected(`Origin 不是合法地址: ${origin}`);
  }
  if (originHost !== host) throw new VoidRequestRejected(`跨站请求被拒绝：Origin ${originHost} 与 Host ${host} 不一致`);
}

/**
 * 改动类请求的门禁：同源 + 自定义头 + JSON。
 *
 * 两条额外要求都不是形式主义：跨站页面**发不出**自定义头（要先过 preflight，而我们
 * 不回应任何 CORS 预检），所以这个头本身就是「来自我们自己的页面」的证据；
 * `application/json` 同样会触发预检，顺带挡住表单式的简单请求。
 */
export function assertTrustedMutation(req: VoidRequestLike): void {
  assertSameOrigin(req);
  if (requestHeader(req, VOID_REQUEST_HEADER) === undefined) {
    throw new VoidRequestRejected(`缺少同源标记（${VOID_REQUEST_HEADER}），拒绝改动`);
  }
  const contentType = requestHeader(req, "content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new VoidRequestRejected(`改动请求必须是 application/json：收到 ${contentType === "" ? "空" : contentType}`);
  }
}
