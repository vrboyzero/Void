import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertMemoryEntryNotLink, assertMemoryPathInside, MemoryPathError } from "../src/paths.js";

let dataDir: string | undefined;
let outside: string | undefined;

afterEach(async () => {
  for (const directory of [dataDir, outside]) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  dataDir = undefined;
  outside = undefined;
});

async function makeRoots(): Promise<{ root: string; away: string }> {
  dataDir = await mkdtemp(path.join(tmpdir(), "void-memory-paths-"));
  outside = await mkdtemp(path.join(tmpdir(), "void-memory-outside-"));
  return { root: dataDir, away: outside };
}

/** junction 在 Windows 上不需要特权；建不出来就标 skipped，不把环境限制说成通过。 */
async function makeJunction(target: string, link: string, context: { skip: () => void }): Promise<boolean> {
  try {
    await symlink(target, link, "junction");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    context.skip();
    return false;
  }
}

describe("记忆路径守卫", () => {
  it("数据根内的普通路径原样通过", async () => {
    const { root } = await makeRoots();
    const target = path.join(root, "agents", "xiaobei", "memory", "2026-09-22", "20260922-0001.md");
    expect(assertMemoryPathInside(root, target)).toBe(target);
    // 数据根本身也在允许范围内。
    expect(assertMemoryPathInside(root, root)).toBe(root);
  });

  it("字符串层面的越界当场拒绝，并说清数据根在哪", async () => {
    const { root } = await makeRoots();
    const escape = path.join(root, "agents", "..", "..", "..", "secret.md");
    expect(() => assertMemoryPathInside(root, escape)).toThrow(MemoryPathError);
    expect(() => assertMemoryPathInside(root, escape)).toThrow(/记忆路径越界/);
    expect(() => assertMemoryPathInside(root, escape)).toThrow(new RegExp(root.replace(/\\/g, "\\\\")));
  });

  it("目标还不存在、父目录正常时放行（首次写入）", async () => {
    const { root } = await makeRoots();
    await mkdir(path.join(root, "agents", "xiaobei"), { recursive: true });
    const target = path.join(root, "agents", "xiaobei", "MEMORY.md");
    expect(assertMemoryPathInside(root, target)).toBe(target);
  });

  // 目标还没建出来时，真正会被跟着走的是最近的已存在祖先——这一步最容易被漏掉。
  it("目标还不存在、最近的已存在祖先是越界链接时拒绝", async (context) => {
    const { root, away } = await makeRoots();
    const agentRoot = path.join(root, "agents", "xiaobei");
    await mkdir(agentRoot, { recursive: true });
    if (!(await makeJunction(away, path.join(agentRoot, "memory"), context))) return;
    const target = path.join(agentRoot, "memory", "2026-09-22", "20260922-0001.md");
    // 纯字符串检查看不出这条路径有问题——这正是要第二道检查的原因。
    expect(() => assertMemoryPathInside(root, target)).toThrow(/记忆路径经链接后越界/);
    expect(() => assertMemoryPathInside(root, target)).toThrow(/路径经链接后越界/);
    // 链接目录本身也越界，不用带里面的文件名。
    expect(() => assertMemoryPathInside(root, path.join(agentRoot, "memory"))).toThrow(/经链接后越界/);
  });

  // 守卫的判定只看 realpath 的结果，不看链接类型；Windows 上把 junction 指向**文件**
  // 会得到一个坏链接（realpath 报 ENOENT），所以这里指向目录，保证本机真能跑到判定。
  it("单个文件位置被换成指向根外的链接时拒绝", async (context) => {
    const { root, away } = await makeRoots();
    const agentRoot = path.join(root, "agents", "xiaobei");
    const outsideDir = path.join(away, "outside");
    await mkdir(agentRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "MEMORY.md"), "根外的长期记忆", "utf8");
    if (!(await makeJunction(outsideDir, path.join(agentRoot, "MEMORY.md"), context))) return;
    expect(() => assertMemoryPathInside(root, path.join(agentRoot, "MEMORY.md"))).toThrow(/经链接后越界/);
  });

  // 坏链接（指向不存在的目标，或指向文件的 junction）会被 ENOENT 放行——这是有意的：
  // 放行的结果是调用方自己读写失败，而不是读到根外的东西。
  it("坏链接放行，但读写会失败而不是读到根外", async (context) => {
    const { root, away } = await makeRoots();
    const agentRoot = path.join(root, "agents", "xiaobei");
    await mkdir(agentRoot, { recursive: true });
    await writeFile(path.join(away, "secret.md"), "host secret", "utf8");
    const link = path.join(agentRoot, "MEMORY.md");
    if (!(await makeJunction(path.join(away, "secret.md"), link, context))) return;
    expect(assertMemoryPathInside(root, link)).toBe(link);
    await expect(readFile(link, "utf8")).rejects.toThrow();
  });

  // 整个 .dsh 被挪到别的盘是正常部署，这种「根在链接下」不能当成越界，
  // 否则正常环境会被自己的守卫挡死。
  it("数据根本身在链接下时仍然放行", async (context) => {
    const { away } = await makeRoots();
    const real = path.join(away, "real-data");
    await mkdir(real, { recursive: true });
    const linked = path.join(away, "linked-data");
    if (!(await makeJunction(real, linked, context))) return;
    const target = path.join(linked, "agents", "xiaobei", "MEMORY.md");
    expect(assertMemoryPathInside(linked, target)).toBe(target);
  });

  it("列目录遇到链接直接拒绝，不静默跳过", () => {
    const parent = path.join("C:", "data", "agents", "xiaobei", "memory");
    expect(() => assertMemoryEntryNotLink({ name: "2026-09-22", isSymbolicLink: () => true }, parent)).toThrow(/记忆目录里有链接，拒绝读入/);
    expect(() => assertMemoryEntryNotLink({ name: "2026-09-22", isSymbolicLink: () => false }, parent)).not.toThrow();
  });
});
