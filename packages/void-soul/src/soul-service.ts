/**
 * `voidSoul` 的真服务：**人类管理入口**（虚空面板）读写的门面。
 *
 * 与 `voidAuthority` 分开是有意的：那个服务只回答「这个会话是谁」，只读、每次重读磁盘、
 * 被军团调用；这个服务只给面板用，能改文件，因此**不发布给模型工具**——§19.2 的边界是
 * 「Agent/FACET 无权修改 SOUL 任何字段，只有可信人类管理入口能改显示名与头像」。
 *
 * @module @void/void-soul/src/soul-service
 */
import type { Context } from "@deepseek-ai/cordis";
import { Service } from "@deepseek-ai/cordis";
import { dataRootOptions, SoulProfileError, tryResolveVoidDataRoot } from "./profile.js";
import {
  bindSessionToProfile,
  createProfile,
  deleteProfile,
  inspectProfile,
  loadBindings,
  loadFacetDetail,
  loadFacetSummaries,
  loadProfileBody,
  loadProfileSummaries,
  loadSuspensionHistory,
  restoreProfileBody,
  saveFacetMarkdown,
  saveProfileBody,
  saveProfileDisplayFields,
  selectFacetForProfile,
  setFirstMeetingDone,
  setProfileSuspended,
  unbindSession,
  type FacetDetail,
  type FacetSummary,
  type ProfileBodyView,
  type ProfileDeletion,
  type ProfileInspection,
  type ProfileSummary,
  type ProfileSuspension,
  type SessionBindingSummary,
  type SuspensionEntry,
} from "./soul-library.js";

export interface SoulLibraryConfig {
  /** 显式数据根（绝对路径）。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
}

export class SoulLibrary extends Service {
  private readonly dataDir: string | undefined;

  constructor(ctx: Context, config: SoulLibraryConfig = {}) {
    super(ctx, "voidSoul");
    this.dataDir = tryResolveVoidDataRoot(dataRootOptions(ctx, config));
  }

  /** 本服务实际使用的数据根；没配好时为 undefined（此时照常加载，用到才报错）。 */
  get dataRoot(): string | undefined {
    return this.dataDir;
  }

  /** 没配数据根时抛一句看得懂的错，而不是让整个插件树加载失败（见 13.1 与 profile.ts）。 */
  private requireDataDir(): string {
    const dataDir = this.dataDir;
    if (dataDir === undefined) {
      throw new SoulProfileError("灵魂档案没有数据根，无法读写档案与模组：需要配置 dataDir，或同时提供 profile（DSH_PROFILE）与 dshHome（DSH_HOME）");
    }
    return dataDir;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    return loadProfileSummaries(this.requireDataDir());
  }

  async createProfile(input: { id: string; directoryName: string; name: string; summary: string; owner?: string; avatar?: string }): Promise<ProfileSummary> {
    return createProfile(this.requireDataDir(), input);
  }

  /** 删一份档案：只把档案自己的文件搬进回收站，**记忆与聊天记录一个字节都不动**。 */
  async deleteProfile(input: { profileId: string; expectedRevision?: string; note?: string }): Promise<ProfileDeletion> {
    return deleteProfile(this.requireDataDir(), input);
  }

  async saveProfileDisplayFields(input: { profileId: string; changes: Readonly<Record<string, unknown>>; expectedRevision: string }): Promise<ProfileSummary> {
    return saveProfileDisplayFields(this.requireDataDir(), input);
  }

  /** 标首次见面引导做完/重来。只改 `state.json`，不碰档案正文。 */
  async setFirstMeetingDone(input: { profileId: string; done: boolean }): Promise<ProfileSummary> {
    return setFirstMeetingDone(this.requireDataDir(), input);
  }

  /**
   * 停用或启用一份档案（19.1 的「停用 + 引用检查 + 预览回收范围」）。只改 `state.json` 里的
   * 一个布尔值，并往 `runtime/suspensions.jsonl` 追加一行留痕；**记忆与聊天记录都不动**。
   */
  async setProfileSuspended(input: { profileId: string; suspended: boolean; note?: string }): Promise<ProfileSuspension> {
    return setProfileSuspended(this.requireDataDir(), input);
  }

  /** 引用检查 + 回收范围预览（只读）。停用之前看一眼，删除之前更该看一眼。 */
  async inspectProfile(profileId: string): Promise<ProfileInspection> {
    return inspectProfile(this.requireDataDir(), profileId);
  }

  /** 读停用/启用留痕（最新在前）。 */
  async loadSuspensionHistory(profileId: string, limit?: number): Promise<SuspensionEntry[]> {
    return loadSuspensionHistory(this.requireDataDir(), profileId, limit);
  }

  /** 读底线正文与留痕（最新在前）。 */
  async loadProfileBody(profileId: string): Promise<ProfileBodyView> {
    return loadProfileBody(this.requireDataDir(), profileId);
  }

  /** 改底线正文。**改之前先把旧版整份留痕**，能看、能回滚。 */
  async saveProfileBody(input: { profileId: string; body: string; expectedRevision: string; note?: unknown }): Promise<ProfileSummary> {
    return saveProfileBody(this.requireDataDir(), input);
  }

  /** 回滚底线正文到留痕里的某一版；回滚本身也留痕。 */
  async restoreProfileBody(input: { profileId: string; revision: unknown; expectedRevision: string; note?: unknown }): Promise<ProfileSummary> {
    return restoreProfileBody(this.requireDataDir(), input);
  }

  async listFacets(): Promise<FacetSummary[]> {
    return loadFacetSummaries(this.requireDataDir());
  }

  async loadFacet(facetId: string): Promise<FacetDetail> {
    return loadFacetDetail(this.requireDataDir(), facetId);
  }

  async saveFacet(input: { facetId: string; changes: Readonly<Record<string, unknown>>; expectedRevision: string }): Promise<FacetDetail> {
    return saveFacetMarkdown(this.requireDataDir(), input);
  }

  async listBindings(): Promise<SessionBindingSummary[]> {
    return loadBindings(this.requireDataDir());
  }

  async bindSession(input: { profileId: string; sessionId: string }): Promise<SessionBindingSummary[]> {
    return bindSessionToProfile(this.requireDataDir(), input);
  }

  async unbindSession(sessionId: string): Promise<SessionBindingSummary[]> {
    return unbindSession(this.requireDataDir(), sessionId);
  }

  async selectFacet(input: { profileId: string; facetId: string | null; expectedRevision?: number }): Promise<{ profileId: string; facetId: string | null; name: string | null; selectionRevision: number }> {
    return selectFacetForProfile(this.requireDataDir(), input);
  }
}

export default SoulLibrary;
