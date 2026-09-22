import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathInsideRoots,
  assertRealPathInsideRoots,
  assertRealPathInsideRootsSync,
  normalizeHostPath,
  PathGuardError,
} from "../src/path-guard.js";

const ROOT = "C:\\Users\\admin\\.dsh\\void-data\\web";

describe("host path normalization", () => {
  it("normalizes the harmless aliases of the same file", () => {
    const expected = "C:\\Users\\admin\\.dsh\\void-data\\web\\agents\\a\\SOUL.md";
    expect(normalizeHostPath("C:\\Users\\admin\\.dsh\\void-data\\web\\agents\\a\\SOUL.md", "win32")).toBe(expected);
    // 正斜杠
    expect(normalizeHostPath("C:/Users/admin/.dsh/void-data/web/agents/a/SOUL.md", "win32")).toBe(expected);
    // 扩展长度前缀
    expect(normalizeHostPath("\\\\?\\C:\\Users\\admin\\.dsh\\void-data\\web\\agents\\a\\SOUL.md", "win32")).toBe(expected);
    // 大小写与 .. 归位
    expect(normalizeHostPath("c:\\Users\\admin\\.dsh\\void-data\\web\\agents\\b\\..\\a\\SOUL.md", "win32")).toBe(expected);
    // 混合分隔符
    expect(normalizeHostPath("C:\\Users\\admin/.dsh\\void-data/web\\agents/a/SOUL.md", "win32")).toBe(expected);
  });

  // P2 退出条件点名的「路径别名」：每一种都不能悄悄指向别处。
  it("refuses path aliases whose meaning cannot be settled without the filesystem", () => {
    expect(() => normalizeHostPath("\\\\.\\PhysicalDrive0", "win32")).toThrow(/拒绝设备路径/);
    expect(() => normalizeHostPath("\\\\server\\share\\secret.txt", "win32")).toThrow(/拒绝 UNC 网络路径/);
    expect(() => normalizeHostPath("C:\\Users\\admin\\.dsh\\a.txt:hidden", "win32")).toThrow(/拒绝 NTFS 数据流路径/);
    expect(() => normalizeHostPath("C:", "win32")).toThrow(/拒绝盘符相对路径/);
    expect(() => normalizeHostPath("C:\\PROGRA~1\\secret.txt", "win32")).toThrow(/拒绝 8.3 短名路径/);
    expect(() => normalizeHostPath("C:\\Users\\admin\\.dsh\\NUL", "win32")).toThrow(/拒绝设备名路径/);
    expect(() => normalizeHostPath("C:\\Users\\admin\\.dsh\\con.txt", "win32")).toThrow(/拒绝设备名路径/);
    // Windows 会把分段结尾的点和空格吃掉，所以 `admin.` 与 `admin` 不是同一串。
    expect(() => normalizeHostPath("C:\\Users\\admin.\\secret.txt", "win32")).toThrow(/含义不确定/);
    expect(() => normalizeHostPath("C:\\Users\\admin \\secret.txt", "win32")).toThrow(/含义不确定/);
    expect(() => normalizeHostPath("", "win32")).toThrow(/路径为空/);
  });
});

describe("path containment", () => {
  it("accepts paths inside an allowed root and returns the normalized form", () => {
    expect(assertPathInsideRoots("C:/Users/admin/.dsh/void-data/web/agents/a/SOUL.md", { roots: [ROOT], platform: "win32" })).toBe(
      "C:\\Users\\admin\\.dsh\\void-data\\web\\agents\\a\\SOUL.md",
    );
    expect(assertPathInsideRoots(ROOT, { roots: [ROOT], platform: "win32" })).toBe(ROOT);
  });

  it("rejects traversal, sibling prefixes and empty root lists", () => {
    // `..` 逃逸
    expect(() => assertPathInsideRoots("C:\\Users\\admin\\.dsh\\void-data\\web\\..\\..\\..\\secret.txt", { roots: [ROOT], platform: "win32" })).toThrow(
      /路径越界/,
    );
    // 前缀相同的兄弟目录：`web-backup` 不是 `web` 的子路径。
    expect(() => assertPathInsideRoots("C:\\Users\\admin\\.dsh\\void-data\\web-backup\\SOUL.md", { roots: [ROOT], platform: "win32" })).toThrow(
      /路径越界/,
    );
    // 日常 home 的别处
    expect(() => assertPathInsideRoots("C:\\Users\\admin\\.dsh\\config.json", { roots: [ROOT], platform: "win32" })).toThrow(/路径越界/);
    expect(() => assertPathInsideRoots("C:\\Users\\admin\\.dsh\\void-data\\web\\a.md", { roots: [], platform: "win32" })).toThrow(/没有允许的根/);
    expect(() => assertPathInsideRoots("C:\\Users\\admin\\.dsh\\void-data\\web\\a.md", { roots: [ROOT], platform: "win32" })).not.toThrow();
  });

  it("is case-insensitive on Windows and case-sensitive on POSIX", () => {
    expect(assertPathInsideRoots("c:\\users\\ADMIN\\.dsh\\void-data\\WEB\\a.md", { roots: [ROOT], platform: "win32" })).toContain("a.md");
    expect(() => assertPathInsideRoots("/home/admin/.dsh/void-data/web/a.md", { roots: ["/home/admin/.dsh/void-data/Web"], platform: "linux" })).toThrow(
      /路径越界/,
    );
    expect(assertPathInsideRoots("/home/admin/.dsh/void-data/Web/a.md", { roots: ["/home/admin/.dsh/void-data/Web"], platform: "linux" })).toBe(
      "/home/admin/.dsh/void-data/Web/a.md",
    );
  });
});

describe("real path containment", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  });

  it("lets a missing target through for the caller to handle", async () => {
    root = await mkdtemp(join(tmpdir(), "void-path-guard-"));
    await expect(assertRealPathInsideRoots(join(root, "not-there.md"), { roots: [root] })).resolves.toContain("not-there.md");
  });

  it("resolves an existing file inside the root", async () => {
    root = await mkdtemp(join(tmpdir(), "void-path-guard-"));
    const target = join(root, "SOUL.md");
    await writeFile(target, "# 底线", "utf8");
    await expect(assertRealPathInsideRoots(target, { roots: [root] })).resolves.toBe(await import("node:fs/promises").then((fs) => fs.realpath(target)));
  });

  // 字符串检查拦不住「先建链接再访问」，所以落盘前必须再看一眼真实位置。
  it("refuses a link that escapes the root, whichever way it was written", async (context) => {
    root = await mkdtemp(join(tmpdir(), "void-path-guard-"));
    const outside = await mkdtemp(join(tmpdir(), "void-path-outside-"));
    try {
      await mkdir(join(root, "agents"), { recursive: true });
      await writeFile(join(outside, "secret.txt"), "host secret", "utf8");
      const link = join(root, "agents", "escape");
      try {
        const { symlink } = await import("node:fs/promises");
        // junction 在 Windows 上不需要特权，能真跑到越界拒绝那一步。
        await symlink(outside, link, "junction");
      } catch (error) {
        // 本机不允许建链接时标成 skipped，不把环境限制说成通过。
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        context.skip();
        return;
      }
      await expect(assertRealPathInsideRoots(join(link, "secret.txt"), { roots: [root] })).rejects.toThrow(/路径经链接后越界/);
      // 链接目录本身也越界，不用带里面的文件名。
      await expect(assertRealPathInsideRoots(link, { roots: [root] })).rejects.toThrow(/路径经链接后越界/);
      // 纯字符串检查看不出这条路径有问题——这正是要两道检查的原因。
      expect(assertPathInsideRoots(join(link, "secret.txt"), { roots: [root] })).toContain("secret.txt");
      // 先摘掉链接本身再清理目录，绝不递归删除链接指向的地方。
      await rm(link, { force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("reports a broken alias as a guard error rather than a raw fs error", async () => {
    root = await mkdtemp(join(tmpdir(), "void-path-guard-"));
    await expect(assertRealPathInsideRoots("\\\\.\\PhysicalDrive0", { roots: [root] })).rejects.toThrow(PathGuardError);
  });
});

// 同步版给「构造函数里就同步打开句柄」的调用方用（sqlite、人格记忆的同步工厂），
// 语义必须与异步版逐条一致，否则同一个洞会在两个版本里得到两种结论。
describe("sync real path containment", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  });

  it("lets a missing target through, exactly like the async version", () => {
    root = mkdtempSync(join(tmpdir(), "void-path-guard-sync-"));
    expect(assertRealPathInsideRootsSync(join(root, "not-there.md"), { roots: [root] })).toContain("not-there.md");
  });

  it("resolves an existing file inside the root", () => {
    root = mkdtempSync(join(tmpdir(), "void-path-guard-sync-"));
    const target = join(root, "SOUL.md");
    writeFileSync(target, "# 底线", "utf8");
    expect(assertRealPathInsideRootsSync(target, { roots: [root] })).toBe(realpathSync(target));
  });

  it("refuses a link that escapes the root", async (context) => {
    root = mkdtempSync(join(tmpdir(), "void-path-guard-sync-"));
    const outside = mkdtempSync(join(tmpdir(), "void-path-outside-sync-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "host secret", "utf8");
      const link = join(root, "agents", "escape");
      try {
        symlinkSync(outside, link, "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        context.skip();
        return;
      }
      expect(() => assertRealPathInsideRootsSync(join(link, "secret.txt"), { roots: [root] })).toThrow(/路径经链接后越界/);
      expect(() => assertRealPathInsideRootsSync(link, { roots: [root] })).toThrow(/路径经链接后越界/);
      // 与异步版一样：字符串检查看不出问题，两道检查缺一不可。
      expect(assertPathInsideRoots(join(link, "secret.txt"), { roots: [root] })).toContain("secret.txt");
      rmSync(link, { force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  // 数据根本身就落在 junction 里是正常部署（例如整个 .dsh 被挪到别的盘），
  // 这种「根在链接下」不能当成越界，否则正常环境会被自己的守卫挡死。
  it("still accepts a root that itself lives under a link", async (context) => {
    const base = mkdtempSync(join(tmpdir(), "void-path-guard-base-"));
    root = join(base, "linked-root");
    try {
      const real = join(base, "real-root");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "SOUL.md"), "# 底线", "utf8");
      try {
        symlinkSync(real, root, "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        context.skip();
        return;
      }
      expect(assertRealPathInsideRootsSync(join(root, "SOUL.md"), { roots: [root] })).toBe(realpathSync(join(real, "SOUL.md")));
      // 而同一个根下指向根外的链接仍然要被拒。
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "host secret", "utf8");
      symlinkSync(outside, join(real, "escape"), "junction");
      expect(() => assertRealPathInsideRootsSync(join(root, "escape", "secret.txt"), { roots: [root] })).toThrow(/路径经链接后越界/);
    } finally {
      // root 是链接本身，先摘链接再删目录，绝不跟着链接递归删。
      if (existsSync(root)) rmSync(root, { force: true, maxRetries: 5, retryDelay: 100 });
      root = base;
    }
  });
});
