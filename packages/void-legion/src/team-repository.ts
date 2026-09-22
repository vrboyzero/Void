/**
 * 队伍配置的落盘仓库（L10「存下来复用，但可修改」）。
 *
 * 旧实现把队伍只放在 `Map` 里，进程一退配置就没了。这里给每支队伍一个
 * `<数据根>/legion/teams/<teamId>.json`，写入走同目录临时文件 + rename，
 * 保存用 `revision` 乐观锁挡住并发覆盖。
 *
 * **临时成员不进这里**：L14 要的是「临时叫一个审计员进来干完就走」，那种名单只
 * 活在本次 run 的合成结果里（见 {@link composeRunRoster}），一行都不写回固定名单。
 *
 * @module @void/void-legion/team-repository
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveVoidDataRoot, SoulProfileError, tryResolveVoidDataRoot } from "@void/void-soul";
import { writeFileAtomic } from "./atomic-file.js";
import {
  assertMaxConcurrentTasks,
  assertMemberLimit,
  assertTeamId,
  LEGION_SCHEMA_VERSION,
  parseTeamDocument,
  serializeTeamDocument,
  type TeamDocument,
} from "./contracts.js";
import { validateTeamPlan } from "./plan-validator.js";
import type { DelegationTeamMember } from "./team.js";

export class LegionRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionRepositoryError";
  }
}

/** 并发保存冲突：磁盘上的修订号已经变了，不能拿旧快照覆盖。 */
export class LegionConflictError extends LegionRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "LegionConflictError";
  }
}

export class LegionNotFoundError extends LegionRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "LegionNotFoundError";
  }
}

export interface LegionDataDirOptions {
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  /** 宿主给插件的档案目录（`ctx.baseUrl`），认运行中的档案用。 */
  baseUrl?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * 军团数据根。路径规则本身在 void-soul，这里只把失败换成军团自己的说法。
 * 档案名（profile）必须显式给——绝不猜一个默认档案去读写用户的日常数据。
 */
export function resolveLegionDataDir(options: LegionDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.dataDir?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolveVoidDataRoot({ dataDir: explicit, env });
  try {
    const resolved = tryResolveVoidDataRoot({
      env,
      ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    if (resolved === undefined) {
      throw new LegionRepositoryError("军团缺少数据根：需要显式 dataDir，或 profile（DSH_PROFILE / 宿主给的档案目录）与可选的 dshHome（DSH_HOME）");
    }
    return resolved;
  } catch (error) {
    if (error instanceof LegionRepositoryError) throw error;
    if (error instanceof SoulProfileError) throw new LegionRepositoryError(`军团数据根不合法：${error.message}`);
    throw error;
  }
}

export interface TeamRepositoryOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
}

/** 队伍配置仓库。一个实例对应一个数据根；重启后新建实例即可读回全部配置。 */
export class TeamRepository {
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: TeamRepositoryOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new LegionRepositoryError("军团数据根必须是绝对路径");
    this.dataDir = path.resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  get dataDirPath(): string {
    return this.dataDir;
  }

  /** 队伍配置目录：`<数据根>/legion/teams`。 */
  get root(): string {
    return path.join(this.dataDir, "legion", "teams");
  }

  private fileOf(teamId: string): string {
    assertTeamId(teamId);
    return path.join(this.root, `${teamId}.json`);
  }

  /** 列出全部已保存队伍，按 id 排序（顺序稳定，界面与测试都不用再排一次）。 */
  async list(): Promise<TeamDocument[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new LegionRepositoryError(`读取队伍目录失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const documents: TeamDocument[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      documents.push(await this.require(name.slice(0, -".json".length)));
    }
    return documents;
  }

  /** 读一支队伍；不存在返回 undefined（「没有」不是错误）。 */
  async load(teamId: string): Promise<TeamDocument | undefined> {
    const file = this.fileOf(teamId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new LegionRepositoryError(`读取队伍配置失败: ${file}`);
    }
    try {
      return parseTeamDocument(text);
    } catch (error) {
      throw new LegionRepositoryError(`队伍配置损坏: ${file}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  /** 读一支队伍；不存在直接报错。 */
  async require(teamId: string): Promise<TeamDocument> {
    const document = await this.load(teamId);
    if (document === undefined) throw new LegionNotFoundError(`队伍不存在: ${teamId}`);
    return document;
  }

  /**
   * 保存（新建或覆盖）。`expectedRevision` 是调用方读到的修订号：
   * 传 0 表示「我认为这是新队伍」，不传则采用当前磁盘值（无条件覆盖）。
   */
  async save(input: { document: TeamDocument; expectedRevision?: number | undefined }): Promise<TeamDocument> {
    const { document } = input;
    assertTeamId(document.id);
    assertMemberLimit(document.memberLimit);
    // 坏名单不许进磁盘：保存时就拦住，调度器不用再替它兜底。
    validateTeamPlan({ members: document.members, memberLimit: document.memberLimit, schedule: document.schedule });
    const current = await this.load(document.id);
    const actual = current?.revision ?? 0;
    const expected = input.expectedRevision ?? actual;
    if (expected !== actual) {
      throw new LegionConflictError(`队伍配置已被其他保存更新（期望修订 ${expected}，实际 ${actual}），请重读后再改`);
    }
    const next: TeamDocument = {
      ...document,
      schemaVersion: LEGION_SCHEMA_VERSION,
      revision: actual + 1,
      updatedAt: this.now().toISOString(),
    };
    // 写盘前过一遍解析器：交进来的 `document` 是外部输入（面板、工具、测试），字段类型不对
    // 就该现在报错，而不是写进磁盘、等下一次 load 才说「队伍配置损坏」——那时已经查不出是谁写的。
    const parsed = parseTeamDocument(JSON.stringify(next));
    await writeFileAtomic(this.fileOf(document.id), serializeTeamDocument(parsed));
    return parsed;
  }

  /** 改人数上限（L13）。读改写一步完成，调用方不用自己接修订号。 */
  async setMemberLimit(teamId: string, input: { memberLimit: number; expectedRevision?: number | undefined }): Promise<TeamDocument> {
    assertMemberLimit(input.memberLimit);
    const current = await this.require(teamId);
    return this.save({
      document: { ...current, memberLimit: input.memberLimit },
      expectedRevision: input.expectedRevision ?? current.revision,
    });
  }

  /**
   * 改本服务总并发上限（§15.3 三个量里的第二个）。读改写一步完成。
   *
   * 与人数上限一样，改了**只影响之后的派活**：已经在跑的那一次用的是派活时冻结的值。
   */
  async setMaxConcurrentTasks(
    teamId: string,
    input: { maxConcurrentTasks: number; expectedRevision?: number | undefined },
  ): Promise<TeamDocument> {
    assertMaxConcurrentTasks(input.maxConcurrentTasks);
    const current = await this.require(teamId);
    return this.save({
      document: { ...current, maxConcurrentTasks: input.maxConcurrentTasks },
      expectedRevision: input.expectedRevision ?? current.revision,
    });
  }

  async remove(teamId: string, options: { expectedRevision?: number | undefined } = {}): Promise<void> {
    const current = await this.require(teamId);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new LegionConflictError(`队伍配置已被其他保存更新（期望修订 ${options.expectedRevision}，实际 ${current.revision}），请重读后再删`);
    }
    await rm(this.fileOf(teamId), { force: true });
  }
}

/**
 * 合成一次 run 的实际名单：固定名单 + 本次临时成员，先校验再返回。
 *
 * 临时成员只存在于这个返回值里。调用方拿它去派活，固定名单一个字都不动——
 * 这正是 L14 要的「临时进来干完就走」。
 */
export function composeRunRoster(
  document: TeamDocument,
  temporaryMembers: readonly DelegationTeamMember[] = [],
): DelegationTeamMember[] {
  return validateTeamPlan({
    members: document.members,
    temporaryMembers,
    memberLimit: document.memberLimit,
    schedule: document.schedule,
  });
}
