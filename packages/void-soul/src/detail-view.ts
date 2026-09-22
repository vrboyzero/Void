/**
 * 灵魂档案与模组库的业务视图（§16.1 的「灵魂卡片/详情」「模组库详情」）。
 *
 * 两个视图都由 `void-soul` 自己登记，入口只当通用渲染器。这里只做三件事：
 * 把服务读到的只读事实排成行、把**允许改的字段**交出去、把动作参数校验清楚。
 * 语义与边界都在 `soul-library.ts` 里，视图不自己读文件，也不自己造默认值。
 *
 * @module @void/void-soul/src/detail-view
 */
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SoulProfileError, resolveVoidDataRoot } from "./profile.js";
import type { FacetDetail, FacetSummary, ProfileBodyView, ProfileDeletion, ProfileInspection, ProfileSummary, ProfileSuspension, ReclaimScopeEntry, SessionBindingSummary, SoulBodyHistoryEntry, SuspensionEntry } from "./soul-library.js";
import { DELETION_LOG_FILE, RUNTIME_DIRECTORY_NAME, SOUL_HISTORY_DIRECTORY_NAME, SUSPENSION_LOG_FILE, TRASH_DIRECTORY_NAME } from "./soul-library.js";
import type { ProfileReferences, TeamReference } from "./references.js";

export const PROFILE_VIEW_ID = "void-soul:profiles";
export const FACET_VIEW_ID = "void-soul:facets";

interface ViewTextSection {
  id: string;
  title: string;
  kind?: "lines" | "table" | "org";
  columns?: readonly string[];
  rows?: ReadonlyArray<readonly string[]>;
  lines?: readonly string[];
}

interface ViewField {
  key: string;
  label: string;
  value: string | number | null;
  readOnly?: boolean;
  kind?: "text" | "markdown";
  help?: string;
}

interface ViewAction {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  args?: readonly ViewField[];
}

interface ViewBody {
  title: string;
  markdown?: string;
  sections: readonly ViewTextSection[];
  revision?: number | string;
  fields?: readonly ViewField[];
  actions?: readonly ViewAction[];
}

interface ViewProfile {
  home: string;
  name: string;
}

interface ViewSource {
  id: string;
  title: string;
  list(profile: ViewProfile): Promise<readonly { id: string; title: string; summary?: string; meta?: string }[]>;
  detail(profile: ViewProfile & { itemId: string }): Promise<ViewBody>;
  save?(input: ViewProfile & { itemId: string; expectedRevision: number | string; changes: Readonly<Record<string, unknown>> }): Promise<ViewBody>;
  act?(input: ViewProfile & { itemId: string; actionId: string; args: Readonly<Record<string, unknown>>; expectedRevision?: number | string }): Promise<ViewBody>;
  viewActions?: readonly ViewAction[];
  actView?(input: ViewProfile & { actionId: string; args: Readonly<Record<string, unknown>> }): Promise<void>;
}

/** 视图需要的那部分 `voidSoul` 服务。测试里换成假的就能验全部语义。 */
export interface SoulViewHost {
  dataRoot: string | undefined;
  listProfiles(): Promise<ProfileSummary[]>;
  createProfile(input: { id: string; directoryName: string; name: string; summary: string; owner?: string }): Promise<ProfileSummary>;
  /** 删一份档案：只把档案自己的文件搬进回收站，记忆与聊天记录一个字节都不动。 */
  deleteProfile(input: { profileId: string; expectedRevision?: string; note?: string }): Promise<ProfileDeletion>;
  saveProfileDisplayFields(input: { profileId: string; changes: Readonly<Record<string, unknown>>; expectedRevision: string }): Promise<ProfileSummary>;
  /** 标首次见面引导做完/重来。只改状态，不改档案。 */
  setFirstMeetingDone(input: { profileId: string; done: boolean }): Promise<ProfileSummary>;
  /** 停用或启用一份档案：只改状态里的一个布尔值，并留一行痕。 */
  setProfileSuspended(input: { profileId: string; suspended: boolean; note?: string }): Promise<ProfileSuspension>;
  /** 引用检查 + 回收范围预览（只读）：还有谁在用它、真要删会涉及哪些地方。 */
  inspectProfile(profileId: string): Promise<ProfileInspection>;
  /** 读停用/启用留痕（最新在前）。 */
  loadSuspensionHistory(profileId: string): Promise<SuspensionEntry[]>;
  /** 读底线正文与留痕。 */
  loadProfileBody(profileId: string): Promise<ProfileBodyView>;
  /** 改底线正文（改之前先留痕）。 */
  saveProfileBody(input: { profileId: string; body: string; expectedRevision: string; note?: unknown }): Promise<ProfileSummary>;
  /** 回滚底线正文到留痕里的某一版（回滚本身也留痕）。 */
  restoreProfileBody(input: { profileId: string; revision: unknown; expectedRevision: string; note?: unknown }): Promise<ProfileSummary>;
  listFacets(): Promise<FacetSummary[]>;
  loadFacet(facetId: string): Promise<FacetDetail>;
  saveFacet(input: { facetId: string; changes: Readonly<Record<string, unknown>>; expectedRevision: string }): Promise<FacetDetail>;
  listBindings(): Promise<SessionBindingSummary[]>;
  bindSession(input: { profileId: string; sessionId: string }): Promise<SessionBindingSummary[]>;
  unbindSession(sessionId: string): Promise<SessionBindingSummary[]>;
  selectFacet(input: { profileId: string; facetId: string | null }): Promise<{ profileId: string; facetId: string | null; name: string | null; selectionRevision: number }>;
}

function listOrNone(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.join("、");
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new SoulProfileError(`${label}是必填`);
  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SoulProfileError(`${label}必须是文本`);
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** 正文按原样收下（空串也收）：空正文由保存那一层拒绝，那里的话说得更清楚。 */
function readBodyText(value: unknown): string {
  if (typeof value !== "string") throw new SoulProfileError("底线正文必须是文本");
  return value;
}

/** 文件修订是内容哈希。空值、数字都不接受：那说明面板传错了东西。 */
function readFileRevision(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SoulProfileError(`文件修订必须是内容哈希: ${String(value)}`);
  }
  return value.trim();
}

/** 请求的档案与这份数据根必须对得上：面板可以开两个 profile，视图不能被串着用。 */
function assertProfileMatches(host: SoulViewHost, profile: ViewProfile): void {
  const root = host.dataRoot;
  if (root === undefined) throw new SoulProfileError("灵魂没有数据根，业务视图不可用");
  const expected = resolveVoidDataRoot({ dshHome: profile.home, profile: profile.name });
  if (path.resolve(root) !== path.resolve(expected)) {
    throw new SoulProfileError(`业务视图的档案与灵魂数据根不一致：请求 ${expected}（${profile.name}），实际 ${path.resolve(root)}`);
  }
}

function profileLines(profile: ProfileSummary): readonly string[] {
  return [
    `档案 id：${profile.id}`,
    `显示名：${profile.name}`,
    `简介：${profile.summary}`,
    `头像：${profile.avatar ?? "没有头像"}`,
    `目录：agents/${profile.directoryName}/SOUL.md`,
  ];
}

/** 底线正文那一节：当前这一版多大、留痕几条、最近一次是谁改的。 */
function bodyLines(body: ProfileBodyView): readonly string[] {
  const last = body.history[0];
  return [
    `当前正文：${body.body.length} 字符，修订 ${body.revision}`,
    `留痕：${body.history.length} 条（存在 ${SOUL_HISTORY_DIRECTORY_NAME}/ 里：改一次留一次，能回滚）`,
    last === undefined
      ? "还没有改动记录：这一版就是最初写下的那一版。"
      : `最近一次：${last.at} 由人${last.action === "restore" ? `回滚到 ${last.sourceRevision ?? "?"}` : "改写"}，换掉的是修订 ${last.revision}`,
    "改正文不碰 front matter：id、显示名、主人、权限与首次见面引导都原样保留。",
  ];
}

/** 留痕列表（最新在前）：一版一行，看得见改过几次、每次换掉了哪一版。 */
function historyLines(body: ProfileBodyView): readonly string[] {
  if (body.history.length === 0) return ["还没有留痕：改一次正文，这里就会多一条。"];
  return body.history.map((entry: SoulBodyHistoryEntry) => {
    const what = entry.action === "restore" ? `回滚到 ${entry.sourceRevision ?? "?"}` : "改写";
    const note = entry.note === undefined ? "" : ` · ${entry.note}`;
    return `${entry.at} · ${what} · 换掉 ${entry.revision}（${entry.bytes} 字节）→ ${entry.nextRevision}${note}`;
  });
}

function authorityLines(profile: ProfileSummary): readonly string[] {
  return [
    `上下级：${profile.authorityEnabled ? "已开启" : "没有（关掉或没写）"}`,
    `上级：${listOrNone(profile.superiors, "没有上级")}`,
    `下级：${listOrNone(profile.subordinates, "没有下级")}`,
    "说明：上下级是身份关系；一次派活还要看队伍名单里的 reportsTo 与 mayDirect（两条边）。",
    "说明：这个入口能改显示名、头像与底线正文；主人与权限不开放编辑。",
  ];
}

function bindingLines(bindings: readonly SessionBindingSummary[], profileId: string): readonly string[] {
  const mine = bindings.filter((item) => item.profileId === profileId).map((item) => item.sessionId);
  if (mine.length === 0) return ["这个档案还没有绑定会话：绑上之后，那个会话进模型时用这份档案。"];
  return mine.map((sessionId) => `会话 ${sessionId}`);
}

function facetLines(facet: FacetDetail): readonly string[] {
  return facet.usedBy.length === 0
    ? ["现在没有档案把这份模组选成角色。"]
    : facet.usedBy.map((id) => `档案 ${id} 正在用`);
}

/** 首次见面：引导文字来自档案，完成状态来自 `state.json`，两个来源分开写清楚。 */
function firstMeetingLines(profile: ProfileSummary): readonly string[] {
  return [
    profile.firstMeeting === null ? "档案里没写 firstMeeting：见面时不加任何东西。" : `档案里写的引导：${profile.firstMeeting}`,
    `状态：${profile.firstMeetingDone ? "已完成（下次进模型不再装引导）" : "还没做（下次进模型时跟着提示词一起装）"}`,
    "引导文字写在 SOUL.md 的 front matter 里，只有人类改得了；这个入口只标做完没做完，改不了底线。",
  ];
}

/**
 * 停用状态那一节：现在是什么状态、这个开关到底动了什么、上一次是谁按的。
 *
 * 「停用不是删除」必须写在人按下按钮**之前**：这个开关只改一个布尔值，底线、记忆、聊天记录、
 * 会话绑定一个字节都不动——所以它没有做成危险动作，也不该让人以为点了就等于删。
 */
function suspensionLines(profile: ProfileSummary, history: readonly SuspensionEntry[]): readonly string[] {
  const last = history[0];
  return [
    profile.suspended
      ? "状态：已停用（绑定它的会话进模型会被拒绝，理由写进通知栏「灵魂未生效」；军团也不会拿它派活）"
      : "状态：启用中（绑定它的会话照常装底线与角色）",
    "这个开关只改 state.json 里的一个布尔值：底线正文、记忆、聊天记录、会话绑定一个字节都不动。",
    last === undefined
      ? "还没有停用/启用记录。"
      : `最近一次：${last.at} 由人${last.suspended ? "停用" : "启用"}${last.note === undefined ? "" : ` · ${last.note}`}`,
    `留痕：${RUNTIME_DIRECTORY_NAME}/${SUSPENSION_LOG_FILE}，每按一次追加一行。`,
  ];
}

/** 一处军团引用怎么说人话：队伍 + lane + 角色，管理者单说。 */
function describeTeamReference(reference: TeamReference): string {
  if (reference.kind === "manager") return `${reference.teamId} 的管理者`;
  const role = reference.role === null ? "成员" : reference.role;
  return reference.laneId === null ? `${reference.teamId} 的${role}` : `${reference.teamId} 的 ${reference.laneId} 当${role}`;
}

/**
 * 引用检查那一节（19.1）：还有谁在用它。**只报事实，不替人决定**——停用与删除都不去改这些
 * 引用，但被停用/删掉的成员会让队伍派不出活，这一点得先说清楚。读不了的队伍文件单列出来：
 * 它不算「没有引用」。
 */
function referenceLines(references: ProfileReferences): readonly string[] {
  const sessions =
    references.sessions.length === 0
      ? "没有会话绑着它"
      : `${references.sessions.length} 个（${references.sessions.slice(0, 5).join("、")}${references.sessions.length > 5 ? " 等" : ""}）`;
  const lines = [
    `绑定会话：${sessions}`,
    `军团队伍：${references.teams.length === 0 ? "没有队伍用到它" : references.teams.map(describeTeamReference).join("、")}`,
    // 这里只列**别人**写进来的关系：它自己写的上下级在上面「主人与权限」那一节，
    // 而删掉这份档案时，别人写的这些 id 会悬空——那才是要人先看见的。
    `组织图：别人写它当上级的 ${listOrNone(references.superiors, "没有")}；写它当下级的 ${listOrNone(references.subordinates, "没有")}`,
    "引用只报事实：停用与删除都不会改这些引用，但队伍里少了这份身份就派不出活。",
  ];
  for (const problem of references.unreadableTeams) {
    const detail = problem.detail === undefined ? "" : `：${problem.detail}`;
    lines.push(`读不了的队伍文件：${problem.file}（${problem.reason}${detail}）——这一处不算「没有引用」。`);
  }
  return lines;
}

/** 回收范围预览那一节：真要删会涉及哪些地方。**是预览，不是计划**——停用一个字节都不删。 */
function reclaimLines(scope: readonly ReclaimScopeEntry[]): readonly string[] {
  const how = { move: "搬进回收站", keep: "一个字节都不动", append: "只追加一行留痕" } as const;
  return [
    ...scope.map((entry) => `${how[entry.action]}：${entry.path} —— ${entry.what}`),
    "这是预览：删除只搬档案自己的那几样，记忆、聊天记录、会话绑定与队伍引用都留在原地，绝不递归删。",
  ];
}

async function profileBody(host: SoulViewHost, profileId: string): Promise<ViewBody> {
  const summaries = await host.listProfiles();
  const profile = summaries.find((item) => item.id === profileId);
  if (!profile) throw new SoulProfileError(`没有这份档案: ${profileId}`);
  const bindings = await host.listBindings();
  const body = await host.loadProfileBody(profileId);
  // 引用检查与停用留痕都是只读的：面板详情每次都现读，不在视图里缓存。
  const inspection = await host.inspectProfile(profileId);
  const suspensions = await host.loadSuspensionHistory(profileId);
  return {
    title: `${profile.name}（${profile.id}）`,
    sections: [
      { id: "identity", title: "身份", kind: "lines", lines: profileLines(profile) },
      { id: "authority", title: "主人与权限", kind: "lines", lines: authorityLines(profile) },
      { id: "suspension", title: "停用状态", kind: "lines", lines: suspensionLines(profile, suspensions) },
      { id: "body", title: "底线正文", kind: "lines", lines: bodyLines(body) },
      { id: "history", title: "正文留痕", kind: "lines", lines: historyLines(body) },
      { id: "bindings", title: "会话绑定", kind: "lines", lines: bindingLines(bindings, profile.id) },
      { id: "references", title: "引用检查", kind: "lines", lines: referenceLines(inspection.references) },
      { id: "reclaim", title: "回收范围预览", kind: "lines", lines: reclaimLines(inspection.reclaimScope) },
      {
        id: "facet",
        title: "当前角色",
        kind: "lines",
        lines: [
          `模组：${profile.facetId === null ? "没有模组（显式无角色）" : `${profile.facetName ?? "?"}（${profile.facetId}）`}`,
          `选择修订：${profile.selectionRevision}`,
          "换角色在「模组库」视图里做：指派一份模组给这个档案，或者清掉它。",
        ],
      },
      { id: "first-meeting", title: "首次见面", kind: "lines", lines: firstMeetingLines(profile) },
    ],
    revision: profile.revision,
    fields: [
      { key: "name", label: "显示名", value: profile.name, help: "改名不搬目录：目录名只是位置，id 才是身份。" },
      { key: "avatar", label: "头像", value: profile.avatar ?? null, help: "留空就是清掉头像。" },
      {
        key: "body",
        label: "底线正文",
        value: body.body,
        kind: "markdown",
        help: `只改正文，front matter 由面板保留。空正文会被拒——没有底线的档案取不出派活身份。保存前会把旧版整份存进 ${SOUL_HISTORY_DIRECTORY_NAME}/，改动原因一并进留痕。`,
      },
      {
        key: "note",
        label: "改动原因（可空）",
        value: null,
        help: "只有真的改了正文才会记进留痕；只改显示名/头像时忽略。",
      },
      { key: "id", label: "档案 id", value: profile.id, readOnly: true },
      { key: "summary", label: "简介", value: profile.summary, readOnly: true, help: "简介参与提示词与队伍展示，本期不开放编辑。" },
      { key: "owner", label: "主人", value: profile.owner ?? null, readOnly: true, help: "一份档案只有一套主人；换主人要人类直接改档案。" },
      { key: "authority", label: "上下级", value: profile.authorityEnabled ? "已开启" : "没有", readOnly: true },
      { key: "revision", label: "修订", value: profile.revision, readOnly: true, help: "文件内容哈希；保存时带回，别人先改过会被拒。" },
    ],
    actions: [
      {
        id: "bind-session",
        label: "绑定一个会话",
        hint: "绑上之后，那个会话进模型时用这份档案。已经绑了别的档案要先解绑，不能悄悄换人。",
        args: [{ key: "sessionId", label: "会话 id", value: null }],
      },
      {
        id: "unbind-session",
        label: "解绑一个会话",
        hint: "解绑后那个会话没有身份，进不了模型。",
        args: [{ key: "sessionId", label: "会话 id", value: null }],
      },
      {
        id: "restore-body",
        label: "回滚底线正文",
        hint: `填留痕里的那一版修订（上面「换掉 <修订>」那个值）。回滚本身也留痕：被换掉的那一版照样进 ${SOUL_HISTORY_DIRECTORY_NAME}/，滚过去还能滚回来。`,
        args: [
          { key: "revision", label: "回滚到哪一版（留痕里的修订）", value: null },
          { key: "note", label: "这次回滚的原因（可空）", value: null },
        ],
      },
      {
        id: "complete-first-meeting",
        label: "标记「引导已完成」",
        hint: "标完这个档案下次进模型就不装引导了。档案里没写引导时会被拒——没得可做，标了也没意义。",
      },
      {
        id: "reset-first-meeting",
        label: "让引导再来一遍",
        hint: "把状态改回「还没做」：下次进模型重新装一次引导。",
      },
      // 停用/启用**不是危险动作**：它只改一个布尔值，按错了再按回来就是，什么都不删。
      profile.suspended
        ? {
            id: "resume-profile",
            label: "启用这份档案",
            hint: "启用之后下一轮装配就自愈：同一个会话照旧用这份档案，不用换会话、也不用重启宿主。",
            args: [{ key: "note", label: "启用原因（可空）", value: null }],
          }
        : {
            id: "suspend-profile",
            label: "停用这份档案",
            hint: "停用后：绑定它的会话进模型会被拒（理由写进通知栏「灵魂未生效」），军团也不会拿它派活。只改 state.json 里的一个布尔值——底线、记忆、聊天记录、会话绑定都不动，随时可以启用回来。",
            args: [{ key: "note", label: "停用原因（可空）", value: null }],
          },
      {
        id: "delete-profile",
        label: "删除这份档案",
        hint: `要删就再敲一遍 ${profile.id}：档案自己的文件会搬进 ${TRASH_DIRECTORY_NAME}/（搬，不是抹，人能自己捞回来），记忆与聊天记录一个字节都不动；还绑着的会话绑定也留着——重新建一份同 id 的档案就接回来。`,
        danger: true,
        args: [
          { key: "confirmProfileId", label: "再敲一遍档案 id", value: null },
          { key: "note", label: "删除原因（可空）", value: null },
        ],
      },
    ],
  };
}

/**
 * 删完之后的回执：这一条已经不在列表里了，面板没法再读它的详情，所以把「删了什么、
 * 什么没动、怎么捞回来」一次说清。**不写成空正文**——删除是危险动作，回执就是它的留痕。
 */
function deletionBody(deleted: ProfileDeletion): ViewBody {
  const bound = deleted.boundSessions;
  return {
    title: `已删除 ${deleted.name}（${deleted.profileId}）`,
    sections: [
      {
        id: "removed",
        title: "删掉了什么",
        kind: "lines",
        lines: [
          `档案目录：${deleted.archiveDirectory}/`,
          `搬走：${deleted.moved.length === 0 ? "（什么都没有，目录本来就是空的）" : deleted.moved.join("、")}`,
          deleted.removedDirectory
            ? "目录空了，一并删掉了。"
            : `目录留着（里面还有：${deleted.leftBehind.join("、")}）——不是档案的东西一个都没搬。`,
          `删除留痕：${TRASH_DIRECTORY_NAME}/${DELETION_LOG_FILE} 记了这一笔（时间 ${deleted.at}）。`,
        ],
      },
      {
        id: "kept",
        title: "没动什么",
        kind: "lines",
        lines: [
          `记忆：${deleted.memoryDirectory}/（MEMORY.md、memory/、memory.sqlite、retracted/）一个字节没动。`,
          "聊天记录：dsh 原生的会话流水照旧留着，删档案不删它。",
          bound.length === 0
            ? "会话绑定：没有会话绑着这份档案。"
            : `会话绑定：还绑着 ${bound.length} 个会话（${bound.slice(0, 5).join("、")}${bound.length > 5 ? " 等" : ""}），绑定留着不动——那些会话取不到身份会拒绝进模型，重新建一份 id 为 ${deleted.profileId} 的档案就能接回来（记忆按 id 存着）。`,
        ],
      },
      {
        id: "restore",
        title: "要捞回来",
        kind: "lines",
        lines: [
          `把 ${deleted.movedTo}/ 里的 ${deleted.moved.join("、")} 搬回 ${deleted.archiveDirectory}/，就是原来那份档案（内容一个字节没变，修订也不变）。`,
          `捞回来之后照旧能用：绑定没动过，记忆也一直在 ${deleted.memoryDirectory}/。`,
        ],
      },
    ],
  };
}

/**
 * 停用/启用的回执。与删除不同，这一条**还在列表里**，所以回执只讲「刚刚改了什么、什么没动」，
 * 再把引用检查与回收范围摊开——停用本来就是删除前的那一步，人在这里就该看见全貌。
 */
function suspensionBody(result: ProfileSuspension): ViewBody {
  const what = result.suspended ? "已停用" : "已启用";
  return {
    title: `${what} ${result.name}（${result.profileId}）`,
    sections: [
      {
        id: "changed",
        title: "改了什么",
        kind: "lines",
        lines: [
          `状态：${result.suspended ? "已停用" : "启用中"}（时间 ${result.at}）`,
          `只改了 ${result.stateFile} 里的一个布尔值：suspended=${result.suspended ? "true" : "false"}。`,
          `留痕：${result.logFile} 追加了一行——停用与启用都记，谁在什么时候按的查得到。`,
          result.suspended
            ? "接下来：绑定它的会话进模型会被拒（理由进通知栏「灵魂未生效」），军团也不会拿它派活；正在进行的请求不改写，下一轮装配生效。"
            : "接下来：下一轮装配就把底线与角色装回来，同一个会话照旧用，不用换会话、也不用重启宿主。",
        ],
      },
      {
        id: "kept",
        title: "没动什么",
        kind: "lines",
        lines: [
          "底线正文、正文留痕、记忆（MEMORY.md、memory/、memory.sqlite、retracted/）、聊天记录、会话绑定：一个字节都没动。",
          "这不是删除：真要删走下面「删除这份档案」那条路，删除会搬进回收站。",
        ],
      },
      { id: "references", title: "引用检查", kind: "lines", lines: referenceLines(result.references) },
      { id: "reclaim", title: "回收范围预览", kind: "lines", lines: reclaimLines(result.reclaimScope) },
    ],
  };
}

async function facetBody(host: SoulViewHost, facetId: string): Promise<ViewBody> {  const facet = await host.loadFacet(facetId);
  return {
    title: `${facet.name}（${facet.id}）`,
    markdown: facet.markdown,
    sections: [{ id: "usedBy", title: "哪些档案在用", kind: "lines", lines: facetLines(facet) }],
    revision: facet.revision,
    fields: [
      { key: "name", label: "显示名", value: facet.name },
      { key: "summary", label: "简介", value: facet.summary },
      {
        key: "body",
        label: "正文",
        value: facet.body,
        kind: "markdown",
        help: "只改正文，front matter 由面板保留。未知变量（{{…}}）会在保存时被拒——到下次请求才炸就太晚了。",
      },
      { key: "id", label: "模组 id", value: facet.id, readOnly: true, help: "改 id 等于换一份模组，应该新建文件。" },
      { key: "revision", label: "修订", value: facet.revision, readOnly: true },
    ],
  };
}

/** 只认允许改的字段，且必须有改动。真正的白名单在服务里再查一遍。 */
function requireChanges(changes: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new SoulProfileError("没有要保存的改动");
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new SoulProfileError(`${label}不接受这个改动: ${unknown.join("、")}`);
}

export function createSoulViews(host: () => SoulViewHost | undefined): [ViewSource, ViewSource] {
  const requireHost = (): SoulViewHost => {
    const service = host();
    if (!service) throw new SoulProfileError("灵魂服务没装上，业务视图不可用");
    return service;
  };
  const checked = (profile: ViewProfile): SoulViewHost => {
    const service = requireHost();
    assertProfileMatches(service, profile);
    return service;
  };

  const profiles: ViewSource = {
    id: PROFILE_VIEW_ID,
    title: "灵魂档案",
    async list(profile) {
      const service = checked(profile);
      const summaries = await service.listProfiles();
      return summaries.map((item) => ({
        id: item.id,
        title: item.suspended ? `${item.name}（已停用）` : item.name,
        summary: `${item.id} · ${item.facetName ?? "没有模组"} · ${item.boundSessions.length} 个会话`,
        meta: item.suspended ? `修订 ${item.revision} · 已停用` : `修订 ${item.revision}`,
      }));
    },
    async detail(input) {
      return profileBody(checked(input), input.itemId);
    },
    async save(input) {
      const service = checked(input);
      requireChanges(input.changes, ["name", "avatar", "body", "note"], "灵魂档案");
      const revision = readFileRevision(input.expectedRevision);
      const note = readOptionalString(input.changes.note, "改动原因");
      const display: Record<string, unknown> = {};
      if ("name" in input.changes) display.name = input.changes.name;
      if ("avatar" in input.changes) display.avatar = input.changes.avatar;
      // 面板每次保存都把整张表单送上来，所以正文要先跟磁盘上那一版逐字比：
      // 照单全写会让留痕里塞满「什么都没改」的空条目。
      let wroteBody = false;
      if ("body" in input.changes) {
        const text = readBodyText(input.changes.body);
        const current = await service.loadProfileBody(input.itemId);
        if (text !== current.body) {
          await service.saveProfileBody({
            profileId: input.itemId,
            body: text,
            expectedRevision: revision,
            ...(note === undefined ? {} : { note }),
          });
          wroteBody = true;
        }
      }
      if (Object.keys(display).length > 0) {
        // 正文刚写过就带上新修订：否则会被「已被其他保存更新」拦下，人以为自己的改名丢了。
        const expected = wroteBody ? (await service.loadProfileBody(input.itemId)).revision : revision;
        await service.saveProfileDisplayFields({ profileId: input.itemId, changes: display, expectedRevision: expected });
      }
      return profileBody(service, input.itemId);
    },
    async act(input) {
      const service = checked(input);
      // 删除是唯一一个会让这一条从列表里消失的动作：先办它，别跟别的动作混在一条路上。
      if (input.actionId === "delete-profile") {
        const confirm = readString(input.args.confirmProfileId, "确认用的档案 id");
        if (confirm !== input.itemId) {
          throw new SoulProfileError(`确认的档案 id 和要删的不是同一份: ${confirm} ≠ ${input.itemId}`);
        }
        const note = readOptionalString(input.args.note, "删除原因");
        const deleted = await service.deleteProfile({
          profileId: input.itemId,
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: readFileRevision(input.expectedRevision) }),
          ...(note === undefined ? {} : { note }),
        });
        return deletionBody(deleted);
      }
      // 停用/启用不看修订：这个状态是幂等的（按错再按回来就是），两个方向都进留痕。
      if (input.actionId === "suspend-profile" || input.actionId === "resume-profile") {
        const note = readOptionalString(input.args.note, "原因");
        const result = await service.setProfileSuspended({
          profileId: input.itemId,
          suspended: input.actionId === "suspend-profile",
          ...(note === undefined ? {} : { note }),
        });
        return suspensionBody(result);
      }
      if (input.actionId === "bind-session") {
        await service.bindSession({ profileId: input.itemId, sessionId: readString(input.args.sessionId, "会话 id") });
        return profileBody(service, input.itemId);
      }
      if (input.actionId === "unbind-session") {
        await service.unbindSession(readString(input.args.sessionId, "会话 id"));
        return profileBody(service, input.itemId);
      }
      if (input.actionId === "restore-body") {
        const note = readOptionalString(input.args.note, "回滚原因");
        // 面板不一定会带修订过来（动作不像保存那样天然有栅）；没带就按当前这一版算。
        const expected =
          input.expectedRevision === undefined
            ? (await service.loadProfileBody(input.itemId)).revision
            : readFileRevision(input.expectedRevision);
        await service.restoreProfileBody({
          profileId: input.itemId,
          revision: readString(input.args.revision, "回滚到哪一版"),
          expectedRevision: expected,
          ...(note === undefined ? {} : { note }),
        });
        return profileBody(service, input.itemId);
      }
      if (input.actionId === "complete-first-meeting" || input.actionId === "reset-first-meeting") {
        await service.setFirstMeetingDone({ profileId: input.itemId, done: input.actionId === "complete-first-meeting" });
        return profileBody(service, input.itemId);
      }
      throw new SoulProfileError(`灵魂详情不认识这个动作: ${input.actionId}`);
    },
    viewActions: [
      {
        id: "new-profile",
        label: "新建一份档案",
        hint: "目录名只是位置，id 才是身份。建完再按需绑会话。",
        args: [
          { key: "id", label: "档案 id", value: null },
          { key: "directoryName", label: "目录名", value: null },
          { key: "name", label: "显示名", value: null },
          { key: "summary", label: "简介", value: null },
          { key: "owner", label: "主人 UUID（可空）", value: null },
        ],
      },
    ],
    async actView(input) {
      const service = checked(input);
      if (input.actionId !== "new-profile") throw new SoulProfileError(`灵魂档案列表不认识这个动作: ${input.actionId}`);
      const owner = readOptionalString(input.args.owner, "主人 UUID");
      await service.createProfile({
        id: readString(input.args.id, "档案 id"),
        directoryName: readString(input.args.directoryName, "目录名"),
        name: readString(input.args.name, "显示名"),
        summary: readString(input.args.summary, "简介"),
        ...(owner === undefined ? {} : { owner }),
      });
    },
  };

  const facets: ViewSource = {
    id: FACET_VIEW_ID,
    title: "模组库",
    async list(profile) {
      const service = checked(profile);
      const summaries = await service.listFacets();
      return summaries.map((item) => ({
        id: item.id,
        title: item.name,
        summary: item.summary,
        meta: `修订 ${item.revision} · ${item.usedBy.length} 个档案在用`,
      }));
    },
    async detail(input) {
      return facetBody(checked(input), input.itemId);
    },
    async save(input) {
      const service = checked(input);
      requireChanges(input.changes, ["name", "summary", "body"], "模组详情");
      const revision = readFileRevision(input.expectedRevision);
      await service.saveFacet({ facetId: input.itemId, changes: input.changes, expectedRevision: revision });
      return facetBody(service, input.itemId);
    },
    viewActions: [
      {
        id: "assign-facet",
        label: "把模组指派给一个档案",
        hint: "指派后那个档案下一次请求就用它；当前进行中的请求不改写。",
        args: [
          { key: "profileId", label: "档案 id", value: null },
          { key: "facetId", label: "模组 id", value: null },
        ],
      },
      {
        id: "clear-facet",
        label: "清掉一个档案的模组",
        hint: "清掉是显式的「无模组」：仍然完整注入 SOUL，不回退到别的模组。",
        args: [{ key: "profileId", label: "档案 id", value: null }],
      },
    ],
    async actView(input) {
      const service = checked(input);
      if (input.actionId === "assign-facet") {
        await service.selectFacet({
          profileId: readString(input.args.profileId, "档案 id"),
          facetId: readString(input.args.facetId, "模组 id"),
        });
        return;
      }
      if (input.actionId === "clear-facet") {
        await service.selectFacet({ profileId: readString(input.args.profileId, "档案 id"), facetId: null });
        return;
      }
      throw new SoulProfileError(`模组库列表不认识这个动作: ${input.actionId}`);
    },
  };

  return [profiles, facets];
}

/** 入口 `VoidSuite.registerDetail` 的结构契约（重述，避免跨包类型依赖）。 */
export interface DetailHost {
  registerDetail(source: ViewSource): () => void;
}

export const name = "void-soul-detail";
export const inject = ["voidSuite", "voidSoul"];

/**
 * 把两个视图登记进入口。
 *
 * 只在 web 组合里生效：headless 组合没有 `voidSuite`，这个回调就永不执行，灵魂本身照常
 * 工作（读隔离门禁与提示词注入都不依赖面板）。
 */
export function apply(ctx: Context): void {
  ctx.inject(["voidSuite", "voidSoul"], (viewCtx) => {
    const suite = viewCtx.get("voidSuite") as DetailHost | undefined;
    if (suite === undefined || typeof suite.registerDetail !== "function") return;
    const host = (): SoulViewHost | undefined => viewCtx.get("voidSoul") as SoulViewHost | undefined;
    for (const source of createSoulViews(host)) {
      viewCtx.effect(() => suite.registerDetail(source), `void-soul: detail view ${source.id}`);
    }
  });
}

export default apply;
