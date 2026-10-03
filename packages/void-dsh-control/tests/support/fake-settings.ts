/**
 * 宿主写入侧的测试替身。
 *
 * **0.1.x 的那个替身已经不成立了，这里记下为什么，免得有人照着旧注释再写一遍。**
 * 旧版模拟的是 `ctx.settings.installSection()`：插件把 `(ns, schema, entry, validate)`
 * 交给宿主，宿主在写入时跑跨字段校验、在卸载时注销命名空间。dsh 0.2.0 删掉了那个 API
 * ——宿主改为**从入口的 `Config` 派生表单**（命名空间 = 组合入口 id），不再有注册/注销，
 * 跨字段校验也从「写入时」挪到了插件自己的「读取时」（见 `src/index.ts` 的
 * `createConfigSource`）。所以这里没有 `FakeSettings` 可模拟了。
 *
 * 剩下能模拟、也必须模拟的是**写入本身**：宿主把用户层盖在入口层上重新解析整份 `Config`，
 * 再把结果**就地写进插件持有的那些 `Volatile` 引用**（cordis-plugin-loader 的
 * `Entry._commitVolatile()` 就是这么做的），最后发 `settings/document-updated`。
 * {@link writeSection} 走的是同一条路：取真 schema 解析出的引用、按协议符号写回、发事件。
 *
 * 引用与其写入协议都来自**真实解析结果**（`bootControl` 经真实 Loader 加载插件，
 * `config` 就是 `fiber.config`），没有手搓的假引用——否则测的就不是线上那套 schema 了。
 */
import type { Context, Fiber } from "@deepseek-ai/cordis";
// 只为加载 `fiber.entry` / `ctx.loader` 的 `declare module` 增强。
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import * as Control from "../../src/index.js";
import { SETTINGS_NAMESPACE } from "../../src/protocol.js";

/**
 * 引用写入协议的键。
 *
 * cosmokit 自己用 `Symbol.for('cosmokit.volatile.write')` 而不是模块内唯一符号，正是为了
 * 让 ESM/CJS 两份副本互认；这里也就能直接用它，不必把 cosmokit 拉成测试依赖。
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** 面板每提交一次就递增；插件只按 `ns` 过滤，不读 revision，但事件形状与宿主一致。 */
let revision = 0;

/**
 * 判断一个解析后的字段是不是宿主给的 volatile 引用。
 *
 * 判据与 cosmokit 的 `isVolatile()` 相同：**只认写协议符号**，不看 `get` 存不存在。
 *
 * @param value - `Control.Config(...)` 解析结果里的一个字段。
 * @returns 该字段是否由 `.volatile()` 承载。
 */
export function isVolatileField(value: unknown): boolean {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

function volatileGetter(value: unknown): (() => unknown) | undefined {
  if (!isVolatileField(value)) return undefined;
  const get = (value as { get?: unknown }).get;
  return typeof get === "function" ? (get as () => unknown) : undefined;
}

function volatileWriter(value: unknown): ((next: unknown) => void) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const write = (value as Record<symbol, unknown>)[VOLATILE_WRITE];
  return typeof write === "function" ? (write as (next: unknown) => void) : undefined;
}

/**
 * 摊平一份解析后的配置：引用换成它当前的值，深层结构照走。
 *
 * dsh-settings 的 `plainConfig()` 做的是同一件事（`isVolatile(value) ? plainConfig(value.get())`），
 * 面板与 `describe()` 都拿这套形状去比对字段。
 *
 * @param value - 解析后的配置或其一部分。
 * @returns 等价的不含引用的数据。
 */
export function plainConfig(value: unknown): unknown {
  const get = volatileGetter(value);
  if (get !== undefined) return plainConfig(get.call(value));
  if (Array.isArray(value)) return value.map((item) => plainConfig(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

function ownerFiber(ctx: Context, config: object): Fiber | undefined {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.config === config) return fiber;
    }
  }
  return undefined;
}

/** {@link writeSection} 的开关。 */
export interface WriteOptions {
  /**
   * 是否在写完之后发 `settings/document-updated`（默认发，与宿主一致）。
   *
   * 关掉只有一个理由：**本次写入的值会被插件的读取点校验拒掉**。插件的事件回调是
   * `source.watch(() => void refreshRoots())`，而 `refreshRoots` 的第一句就是
   * `source.live()`（读取点校验）——于是那次拒绝没有任何人接管，成了一个
   * unhandled rejection，vitest 会把它记成运行级错误、整个 `pnpm run test` 判失败。
   * 校验组的命题是「写入被接受 → 下一次读取抛错」，不涉及通知路径，所以显式关掉事件；
   * 通知路径本身由「活体生效」那一组覆盖。
   */
  notify?: boolean;
}

/**
 * 模拟宿主侧的一次面板写入：就地更新插件持有的配置引用，再发出变更事件。
 *
 * 0.2.0 里插件不注册命名空间——它拿到的是宿主解析 `Config` 后给出的 `Volatile` 引用，
 * 写入就是更新这些引用。这里刻意**不做跨字段校验**：宿主也不做（0.2.0 的写入路径只按
 * schema 逐字段验），坏值会先存进去，下一次读取时才抛——这正是读取点校验的语义，
 * 测试必须能复现它。
 *
 * `section` 是**整份字段值**（如整份 `callback`），与面板提交一层的方式一致：宿主把用户层
 * 盖在入口层上**重新解析整份配置**，所以带默认值的对象字段不会缺键。
 *
 * @param ctx - `bootControl` 起的上下文。
 * @param config - 插件实际持有的那份解析配置（见 `tests/support/boot.ts` 的 `parsedConfig`）。
 * @param section - 本次写入的字段。
 * @param options - 见 {@link WriteOptions}。
 * @throws Error 当 `config` 不是这个上下文里运行中插件持有的配置，或写入的字段不是 volatile。
 */
export function writeSection(
  ctx: Context,
  config: object,
  section: Record<string, unknown>,
  options: WriteOptions = {},
): void {
  const fiber = ownerFiber(ctx, config);
  if (fiber === undefined) {
    throw new Error("writeSection: the given config is not held by a live plugin fiber on this context");
  }

  // 宿主解析的是「入口层 + 用户层」的合成值，不是用户层本身；这里同样过一遍真 schema，
  // 否则部分对象（如只写 enabled/url 的 callback）会缺掉 schema 默认值。
  const raw = { ...(plainConfig(config) as Record<string, unknown>), ...section };
  const next = Control.Config(raw) as unknown as Record<string, unknown>;

  for (const key of Object.keys(section)) {
    const current = (config as Record<string, unknown>)[key];
    const write = volatileWriter(current);
    if (write === undefined) {
      throw new Error(`writeSection: config field "${key}" is not volatile; the host would not put it in the form`);
    }
    write.call(current, plainConfig(next[key]));
  }

  if (options.notify === false) return;

  // 宿主在引用**已经就地更新之后**才发这条事件（dsh-settings 的 `describe()`），所以监听者
  // 读到的一定是新值。命名空间取组合入口的 id——宿主用的就是它（`entry.options.id`），
  // 事件签名要的是 `SettingsNamespace`（编译期标称类型），`brandString` 不改运行时值。
  const entryId = ctx.loader.locate(fiber) ?? SETTINGS_NAMESPACE;
  fiber.ctx.emit("settings/document-updated", brandString<SettingsNamespace>(entryId), revision);
  revision += 1;
}
