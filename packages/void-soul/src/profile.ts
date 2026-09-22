import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 宿主放档案的目录名：档案目录一律是 `<DSH_HOME>/profiles/<档案名>/`。 */
export const PROFILE_DIRECTORY_NAME = "profiles";

/** 档案名规则：只认字面量，不猜、不归一化。 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 档案名是否合法。 */
export function isProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}

/** 档案位置：家在哪儿（DSH_HOME）、档案叫什么。 */
export interface ProfileLocation {
  home: string;
  name: string;
}

/**
 * 从宿主给插件的 `baseUrl` 认档案位置。
 *
 * cordis 把根配置的 include 根锚在**档案目录**上（`dsh/lib/profile-boot-*.js`：
 * 「the Loader needs a real include root to anchor `baseUrl` at the profile directory」），
 * 所以根树插件的 `ctx.baseUrl` 就是 `<DSH_HOME>/profiles/<档案名>/`。这是插件在运行期
 * 唯一能拿到的「我是哪个档案」的宿主事实——宿主从不设 `DSH_PROFILE`（2026-09-22 真机核对）。
 *
 * 形状对不上就返回 `undefined`：**绝不猜一个默认档案**去读写别人的数据。
 *
 * `void-entry` 有一份同口径的实现（它不能依赖本包，本包也不能依赖它）：两边的行为由
 * `packages/void/tests/profile-anchor-closure.spec.ts` 钉住，改一处就得改另一处。
 */
export function profileLocationFromBaseUrl(baseUrl: string | undefined): ProfileLocation | undefined {
  const raw = baseUrl?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let directory: string;
  try {
    directory = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
  } catch {
    return undefined;
  }
  if (!path.isAbsolute(directory)) return undefined;
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (path.basename(parent) !== PROFILE_DIRECTORY_NAME) return undefined;
  const name = path.basename(resolved);
  if (!isProfileName(name)) return undefined;
  const home = path.dirname(parent);
  return path.isAbsolute(home) ? { home, name } : undefined;
}

/** 档案开头目前接受的单行字段。 */
const SCALAR_KEYS = ["id", "name", "summary", "schemaVersion", "avatar", "owner", "firstMeeting"] as const;
/** `authority:` 缩进块里接受的字段。 */
const AUTHORITY_KEYS = ["enabled", "superiors", "subordinates"] as const;
type AuthorityKey = (typeof AUTHORITY_KEYS)[number];

function isAuthorityKey(value: string): value is AuthorityKey {
  return (AUTHORITY_KEYS as readonly string[]).includes(value);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OWNER_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class SoulProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoulProfileError";
  }
}

/**
 * 结构化上下级（§13.1）。关系引用稳定档案 id，显示标签只作展示，**不从正文反向推断**。
 *
 * `enabled: false` 只是把这份档案从身份图里摘出去（关系仍在文件里，但不参与判定）。
 * 它**只能让许可更窄**：摘掉之后上级不算上级、下级不算下级，什么都没被放开。
 */
export interface SoulAuthority {
  enabled: boolean;
  superiors: readonly string[];
  subordinates: readonly string[];
}

export interface SoulFrontMatter {
  id: string;
  name: string;
  summary: string;
  schemaVersion?: string;
  avatar?: string;
  /** 主人 UUID。一份档案只有一套主人，换角色不改主人。 */
  owner?: string;
  /**
   * 首次见面引导（12 节目录方案与 13 节：这条从档案读，不写在代码里）。写一行，见面时
   * 先装进提示词，档案的 `state.json` 记「已完成引导」之后就撤掉。没有这一行 = 这份档案
   * 不做自我介绍，见面时什么都不加。
   */
  firstMeeting?: string;
  authority?: SoulAuthority;
}

export interface ParsedSoulDocument {
  frontMatter: SoulFrontMatter;
  body: string;
}

/** 默认 `<DSH_HOME>/void-data/<profile>`。override 必须是绝对路径。 */
export function resolveVoidDataDir(input: {
  dshHome: string;
  profile: string;
  override?: string;
}): string {
  if (!PROFILE_PATTERN.test(input.profile)) {
    throw new SoulProfileError(`非法 profile 名: ${input.profile}`);
  }
  if (input.override !== undefined) {
    if (!path.isAbsolute(input.override)) {
      throw new SoulProfileError("VOID_DATA_DIR 覆盖值必须是绝对路径");
    }
    return path.resolve(input.override);
  }
  if (!path.isAbsolute(input.dshHome)) {
    throw new SoulProfileError("DSH_HOME 必须是绝对路径");
  }
  return path.join(path.resolve(input.dshHome), "void-data", input.profile);
}

/**
 * 宿主对 `DSH_HOME` 的定义：环境变量优先，没设就是 `~/.dsh`。
 * 这是**宿主自己的规则**，Void 只跟随，不另立一套默认目录。
 */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return path.join(os.homedir(), ".dsh");
}

export interface VoidDataRootOptions {
  /** 显式数据根。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  /**
   * 宿主给插件的档案目录（根树插件就是 `ctx.baseUrl`，形如
   * `<DSH_HOME>/profiles/<档案名>/`）。运行中的档案名从这里认：宿主从不设
   * `DSH_PROFILE`（2026-09-22 真机核对），没有这一条就只能靠装包的人手写配置。
   */
  baseUrl?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** 插件配置里跟数据根有关的那三个字段（三个服务包的配置都是这个形状）。 */
export interface VoidDataRootConfig {
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
}

/**
 * 宿主给插件的档案目录。根树插件的 `ctx.baseUrl` 就是档案目录（cordis 把 include 根锚在
 * 那里），取不到就返回 `undefined`——不猜。
 */
export function readProfileDirectory(ctx: unknown): string | undefined {
  const baseUrl = (ctx as { baseUrl?: unknown } | undefined)?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : undefined;
}

/**
 * 服务构造器拼数据根的唯一入口：显式配置优先，宿主给的档案目录兜底。
 *
 * 每个服务都是 `tryResolveVoidDataRoot({ ...显式字段, baseUrl })` 这一个形状，写在一处
 * 免得四个包各拼一遍、各漏一个字段。
 */
export function dataRootOptions(ctx: unknown, config: VoidDataRootConfig = {}): VoidDataRootOptions {
  const baseUrl = readProfileDirectory(ctx);
  return {
    ...(config.dataDir === undefined ? {} : { dataDir: config.dataDir }),
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
    ...(config.profile === undefined ? {} : { profile: config.profile }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

/**
 * 数据根的统一解析：显式 `dataDir` > 显式 `profile` > `DSH_PROFILE` > 宿主给的档案目录
 * （`baseUrl`）> `~/.dsh` + profile。
 *
 * 档案名以前只能靠 `DSH_PROFILE` 显式给，因为「插件在运行期拿不到 CLI 概念」；真机核对
 * 推翻了这一条——cordis 把 include 根锚在档案目录上，所以 `ctx.baseUrl` 认得出正在跑的
 * 档案。**仍然绝不猜默认档案**：三条来源都没有就是没配，由调用方决定是抛还是等。
 */
export function resolveVoidDataRoot(options: VoidDataRootOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.dataDir?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (!path.isAbsolute(explicit)) throw new SoulProfileError("数据根必须是绝对路径");
    return path.resolve(explicit);
  }
  const anchor = profileLocationFromBaseUrl(options.baseUrl);
  const profile = options.profile?.trim() ?? env.DSH_PROFILE?.trim() ?? anchor?.name;
  if (profile === undefined || profile.length === 0) {
    throw new SoulProfileError("数据根缺少档案名：需要显式 dataDir，或 profile（DSH_PROFILE / 宿主给的档案目录）与可选的 dshHome（DSH_HOME）");
  }
  const configuredHome = options.dshHome?.trim() ?? env.DSH_HOME?.trim();
  const home = configuredHome !== undefined && configuredHome.length > 0 ? configuredHome : anchor?.home ?? resolveHarnessHome(env);
  return resolveVoidDataDir({ dshHome: home, profile });
}

/**
 * 「没配」与「配错」分开：**没配**数据根返回 `undefined`，**配错**照实抛。
 *
 * 缺席只有一种情况：既没给 `dataDir`，也没有任何档案名（`options.profile`、`DSH_PROFILE`
 * 或宿主给的档案目录）。宿主 rc 线不给运行期档案名（见 13.1），装包的人很可能只漏了一个
 * 环境变量——那不该让整棵插件树加载失败（cordis 把构造器抛错当插件启动失败，整个 GUI 都
 * 起不来），而应该在**真正用到数据**的时候报一句看得懂的错。反过来，给了 `dataDir` 或
 * profile 却解析不出来（相对路径、非法档案名），绝不能静默降级成别的目录，一律照
 * `resolveVoidDataRoot` 抛。
 */
export function tryResolveVoidDataRoot(options: VoidDataRootOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const explicit = options.dataDir?.trim();
  const anchor = profileLocationFromBaseUrl(options.baseUrl);
  const profile = options.profile?.trim() ?? env.DSH_PROFILE?.trim() ?? anchor?.name;
  const hasRoot = explicit !== undefined && explicit.length > 0;
  const hasProfile = profile !== undefined && profile.length > 0;
  if (!hasRoot && !hasProfile) return undefined;
  return resolveVoidDataRoot(options);
}

/** 共用模组库占着 `agents/facets` 这一层，不能同时当某份档案的目录。 */
export const FACET_DIRECTORY_NAME = "facets";

/**
 * 档案目录名是不是共用模组库那一层。
 *
 * 大小写不敏感是有意的：Windows 上 `agents/Facets` 与 `agents/facets` 是同一个目录，
 * 只挡小写的话，一份叫 `Facets` 的档案会直接住进模组库，两边的文件混在一层里。
 */
export function isFacetDirectoryName(name: string): boolean {
  return name.toLowerCase() === FACET_DIRECTORY_NAME;
}

/** 档案目录名只是位置。拒绝越界、绝对路径和共用模组库保留名。 */
export function resolveAgentDirectory(dataDir: string, directoryName: string): string {
  if (!path.isAbsolute(dataDir)) throw new SoulProfileError("数据根必须是绝对路径");
  if (
    directoryName.length === 0
    || directoryName === "."
    || directoryName === ".."
    || isFacetDirectoryName(directoryName)
    || directoryName.includes("/")
    || directoryName.includes("\\")
    || path.isAbsolute(directoryName)
  ) {
    throw new SoulProfileError(`非法 Agent 目录名: ${directoryName}`);
  }
  const resolved = path.resolve(dataDir, "agents", directoryName);
  const agentsRoot = path.resolve(dataDir, "agents");
  if (resolved !== path.join(agentsRoot, directoryName)) {
    throw new SoulProfileError(`Agent 目录越界: ${directoryName}`);
  }
  return resolved;
}

export function parseSoulDocument(markdown: string): ParsedSoulDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) throw new SoulProfileError("档案缺少开头的 front matter");
  const raw = parseFrontMatter(match[1] ?? "");
  const id = required(raw.scalars, "id");
  if (!ID_PATTERN.test(id)) throw new SoulProfileError(`非法档案 id: ${id}`);
  const owner = raw.scalars.owner;
  if (owner !== undefined && !OWNER_PATTERN.test(owner)) {
    throw new SoulProfileError(`owner 必须是主人 UUID: ${owner}`);
  }
  const authority = raw.authority === undefined ? undefined : finishAuthority(raw.authority, id);
  return {
    frontMatter: {
      id,
      name: required(raw.scalars, "name"),
      summary: required(raw.scalars, "summary"),
      ...(raw.scalars.schemaVersion ? { schemaVersion: raw.scalars.schemaVersion } : {}),
      ...(raw.scalars.avatar ? { avatar: raw.scalars.avatar } : {}),
      ...(raw.scalars.firstMeeting ? { firstMeeting: raw.scalars.firstMeeting } : {}),
      ...(owner ? { owner } : {}),
      ...(authority === undefined ? {} : { authority }),
    },
    body: markdown.slice(match[0].length),
  };
}

/** 同一 id 只能有一份档案。缺档案由调用方拒绝，这里不制造默认身份。 */
export function indexSoulProfiles(entries: readonly { directory: string; id: string }[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing !== undefined) {
      throw new SoulProfileError(`档案 id 重复: ${entry.id}（${existing} 与 ${entry.directory}）`);
    }
    byId.set(entry.id, entry.directory);
  }
  return byId;
}

interface RawAuthority {
  enabled?: string;
  superiors?: string[];
  subordinates?: string[];
  /** 用块列表语法开了头、但一个条目都还没写的字段。 */
  pending?: "superiors" | "subordinates";
}

/**
 * front matter 只有两层：顶层单行字段，加一个缩进的 `authority:` 块。
 *
 * 这里刻意写得挑剔：未知字段、重复字段、缩进错位、空列表都报错而不是猜。档案是人手写的，
 * 猜错的代价是权限悄悄变了——那比报错难查得多。
 */
function parseFrontMatter(block: string): { scalars: Record<string, string>; authority?: RawAuthority } {
  const scalars: Record<string, string> = {};
  let authority: RawAuthority | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) {
      authority = parseAuthorityLine(authority, line.trim());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw new SoulProfileError(`无法读取的 front matter 行: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (key === "authority") {
      if (authority !== undefined) throw new SoulProfileError("front matter 字段重复: authority");
      if (value.length > 0) {
        throw new SoulProfileError(`authority 不接受行内值: ${value}（请缩进写 enabled / superiors / subordinates）`);
      }
      authority = {};
      continue;
    }
    if (!SCALAR_KEYS.includes(key as typeof SCALAR_KEYS[number])) {
      throw new SoulProfileError(`本期不接受的 front matter 字段: ${key}`);
    }
    if (scalars[key] !== undefined) throw new SoulProfileError(`front matter 字段重复: ${key}`);
    if (value.length === 0) throw new SoulProfileError(`front matter 字段为空: ${key}`);
    scalars[key] = value;
  }
  settlePending(authority);
  return { scalars, ...(authority === undefined ? {} : { authority }) };
}

/**
 * 收尾一个块列表。写了 `key:` 却一个条目都没有，就是没写完——报错而不是当成空列表：
 * 「空」和「忘了写」在权限上完全不是一回事，猜错的方向恰好是少给许可，人只会觉得规则坏了。
 */
function settlePending(authority: RawAuthority | undefined): void {
  const pending = authority?.pending;
  if (authority === undefined || pending === undefined) return;
  if (authority[pending]?.length === 0) throw new SoulProfileError(emptyListMessage(pending));
  authority.pending = undefined;
}

function parseAuthorityLine(authority: RawAuthority | undefined, content: string): RawAuthority {
  if (authority === undefined) throw new SoulProfileError(`front matter 行缩进不对: ${content}`);
  if (content.startsWith("-")) {
    const item = stripQuotes(content.slice(1).trim());
    const key = authority.pending;
    if (key === undefined) throw new SoulProfileError(`authority 列表项没有归属的字段: ${content}`);
    if (item.length === 0) throw new SoulProfileError(`authority.${key} 有空项`);
    authority[key]?.push(item);
    return authority;
  }
  const separator = content.indexOf(":");
  if (separator <= 0) throw new SoulProfileError(`无法读取的 front matter 行: ${content}`);
  const key = content.slice(0, separator).trim();
  const value = stripQuotes(content.slice(separator + 1).trim());
  if (!isAuthorityKey(key)) {
    throw new SoulProfileError(`本期不接受的 authority 字段: ${key}`);
  }
  if (authority[key] !== undefined) throw new SoulProfileError(`authority 字段重复: ${key}`);
  settlePending(authority);
  if (key === "enabled") {
    if (value.length === 0) throw new SoulProfileError("authority 字段为空: enabled");
    if (value !== "true" && value !== "false") throw new SoulProfileError(`authority.enabled 必须是 true 或 false: ${value}`);
    authority.enabled = value;
    return authority;
  }
  const listKey = key;
  if (value.length === 0) {
    authority[listKey] = [];
    authority.pending = listKey;
    return authority;
  }
  authority[listKey] = parseInlineList(value, listKey);
  return authority;
}

function emptyListMessage(key: string): string {
  return `authority 列表字段为空: ${key}（写 [] 表示空列表）`;
}

/** 行内列表：`[a, b]`。这是给人少写几行的写法，块列表与它等价。 */
function parseInlineList(value: string, key: "superiors" | "subordinates"): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new SoulProfileError(`authority.${key} 必须写成 [a, b] 这样的列表: ${value}`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items = inner.split(",").map((item) => stripQuotes(item.trim()));
  if (items.some((item) => item.length === 0)) throw new SoulProfileError(`authority.${key} 有空项`);
  return items;
}

/** 定稿：补默认值、校验关系本身，并挡住「关了开关还留着关系」这种自相矛盾。 */
function finishAuthority(raw: RawAuthority, id: string): SoulAuthority {
  const enabled = raw.enabled === undefined ? true : raw.enabled === "true";
  const superiors = checkRelations(raw.superiors ?? [], id, "superiors");
  const subordinates = checkRelations(raw.subordinates ?? [], id, "subordinates");
  if (!enabled && (superiors.length > 0 || subordinates.length > 0)) {
    throw new SoulProfileError(`authority 已关掉，却还写着 ${superiors.length > 0 ? "superiors" : "subordinates"}：要么删掉关系，要么打开开关`);
  }
  return { enabled, superiors, subordinates };
}

function checkRelations(items: readonly string[], id: string, key: "superiors" | "subordinates"): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (!ID_PATTERN.test(item)) throw new SoulProfileError(`authority.${key} 里有非法档案 id: ${item}`);
    if (item === id) throw new SoulProfileError(`authority.${key} 不能写自己: ${id}`);
    if (seen.has(item)) throw new SoulProfileError(`authority.${key} 里有重复的档案 id: ${item}`);
    seen.add(item);
  }
  return [...items];
}

function required(values: Record<string, string>, key: "id" | "name" | "summary"): string {
  const value = values[key];
  if (value === undefined) throw new SoulProfileError(`front matter 缺少 ${key}`);
  return value;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}
