import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemoryError, AgentMemoryStore, agentMemoryRoot } from "../src/agent-store.js";
import { MemoryConflictError } from "../src/documents.js";
import { MemoryIndexStore } from "../src/index-store.js";
import { SensitiveContentError } from "../src/sensitive-content.js";

const SECRET = "sk-1234567890abcdefghijklmnopqrst";
const FIXED_DAY = new Date(2026, 8, 22, 10, 0, 0);

let dataDir: string;
const opened: MemoryIndexStore[] = [];
const outsideDirs: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "void-memory-store-"));
});

afterEach(async () => {
  for (const index of opened.splice(0)) index.close();
  for (const directory of outsideDirs.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

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

async function makeOutside(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "void-memory-outside-"));
  outsideDirs.push(directory);
  return directory;
}

function openAgent(agentId: string, withIndex = true): AgentMemoryStore {
  const root = agentMemoryRoot(dataDir, agentId);
  const index = withIndex ? MemoryIndexStore.open({ path: path.join(root, "memory.sqlite"), agentId }) : undefined;
  if (index) opened.push(index);
  return new AgentMemoryStore({ root, dataRoot: dataDir, agentId, index, now: () => FIXED_DAY });
}

async function readTree(directory: string): Promise<{ relative: string; content: string }[]> {
  const files: { relative: string; content: string }[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const content = await readFile(full).catch(() => Buffer.alloc(0));
      files.push({ relative: path.relative(dataDir, full), content: content.toString("utf8") });
    }
  }
  await walk(directory);
  return files;
}

describe("每档案记忆仓", () => {
  it("写入条目后能按 id 读回，并立刻可检索", async () => {
    const store = openAgent("xiaobei");
    const written = await store.write({ body: "小贝的第一条守则：先看清再动手。" });
    expect(written.target).toEqual({ kind: "entry", entryId: "20260922-0001" });
    expect(written.indexSynced).toBe(true);

    const read = await store.read(written.target);
    expect(read.body).toContain("先看清再动手");
    expect(read.revision).toBe(1);

    const hits = await store.search({ query: "守则" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.entryId).toBe("20260922-0001");
  });

  it("一份档案写的东西，另一份档案读不到也搜不到", async () => {
    const xiaobei = openAgent("xiaobei");
    const xiaoma = openAgent("xiaoma");
    const written = await xiaobei.write({ body: "小贝的私事：今天有点累。" });
    await xiaoma.write({ body: "小马的私事：今天很开心。" });

    expect((await xiaobei.search({ query: "私事" }))[0]!.snippet).toContain("小贝");
    expect((await xiaoma.search({ query: "私事" }))[0]!.snippet).toContain("小马");

    const entryId = (written.target as { entryId: string }).entryId;
    // 条目 id 是按档案各自递增的，所以同名 id 在两边都存在，但内容各归各的。
    expect((await xiaoma.read({ kind: "entry", entryId })).body).toContain("小马");
    // 小贝多写一条，小马就再也拿不到这个 id —— 记忆仓是按档案分根的。
    const second = await xiaobei.write({ body: "小贝的第二条：关键词 海豚。" });
    const secondId = (second.target as { entryId: string }).entryId;
    expect(secondId).not.toBe(entryId);
    await expect(xiaoma.read({ kind: "entry", entryId: secondId })).rejects.toThrow(/记忆条目不存在/);
    expect(await xiaoma.search({ query: "海豚" })).toEqual([]);
    // 小马自己也有“私事”，但查“小贝”不能命中到小马身上（单字口径不放开）。
    expect(await xiaoma.search({ query: "小贝" })).toEqual([]);
    expect((await xiaoma.search({ query: "私事" })).every((hit) => !hit.snippet.includes("小贝"))).toBe(true);
  });

  it("伪造的条目 id 与越界路径一律拒绝", async () => {
    const store = openAgent("xiaobei");
    for (const forged of ["../../../../etc/passwd", "..", "20260922-0001/../../x", "C:\\Windows\\win.ini"]) {
      await expect(store.read({ kind: "entry", entryId: forged })).rejects.toThrow(/不合法/);
    }
    expect(() => agentMemoryRoot(dataDir, "../escape")).toThrow(AgentMemoryError);
    expect(() => agentMemoryRoot(dataDir, "a/b")).toThrow(AgentMemoryError);
  });

  it("共用模组库那层是保留名，不能当档案的记忆根", async () => {
    // 放行的话，绑定到 facets 的会话会把 MEMORY.md 与 memory.sqlite 写进模组库目录。
    for (const reserved of ["facets", "Facets", "FACETS"]) {
      expect(() => agentMemoryRoot(dataDir, reserved)).toThrow(/撞上共用模组库的保留目录名/);
      expect(() => agentMemoryRoot(dataDir, reserved)).toThrow(/agents\/facets 那层归灵魂的模组库/);
    }
    expect(() => openAgent("facets")).toThrow(AgentMemoryError);
    // 名字里带 facets 不算撞保留名。
    expect(agentMemoryRoot(dataDir, "facet_dev")).toBe(path.join(dataDir, "agents", "facet_dev"));
    expect(await existsSync(path.join(dataDir, "agents", "facets"))).toBe(false);
  });

  it("撤回后立刻不再命中，原文仍可恢复", async () => {
    const store = openAgent("xiaobei");
    const written = await store.write({ body: "这条待会儿要撤回，关键词 蓝鲸。" });
    const target = written.target as { kind: "entry"; entryId: string };
    expect((await store.search({ query: "蓝鲸" })).length).toBe(1);

    const retracted = await store.retract({ target });
    expect(retracted.indexSynced).toBe(true);
    expect(await store.search({ query: "蓝鲸" })).toEqual([]);
    await expect(store.read(target)).rejects.toThrow(/已撤回/);

    const recovered = await readFile(retracted.recoveredPath, "utf8");
    expect(recovered).toContain("蓝鲸");
    expect(await store.list()).toMatchObject({ total: 0 });
  });

  it("并发改动用修订号挡住覆盖", async () => {
    const store = openAgent("xiaobei");
    const written = await store.write({ body: "第一版正文。" });
    const target = written.target;

    const updated = await store.update({ target, body: "第二版正文。", expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    await expect(store.update({ target, body: "第三版正文。", expectedRevision: 1 })).rejects.toBeInstanceOf(MemoryConflictError);
    expect((await store.read(target)).body).toContain("第二版");
  });

  it("敏感内容在落盘之前被拒，正文、临时文件、备份与索引都不留痕", async () => {
    const store = openAgent("xiaobei");
    await expect(store.write({ body: `记住这个 ${SECRET}` })).rejects.toBeInstanceOf(SensitiveContentError);
    await expect(store.write({ target: "long-term", body: `长期记忆里也不要 ${SECRET}` })).rejects.toBeInstanceOf(SensitiveContentError);

    const files = await readTree(agentMemoryRoot(dataDir, "xiaobei"));
    for (const file of files) {
      expect(file.content).not.toContain(SECRET);
      expect(file.content).not.toContain("1234567890abcdefghijklmnopqrst");
    }
    expect(await store.search({ query: SECRET })).toEqual([]);
    expect(await store.list()).toMatchObject({ total: 0 });
  });

  it("分页按 id 倒序，游标往后走不重不漏", async () => {
    const store = openAgent("xiaobei", false);
    for (const body of ["第一条", "第二条", "第三条"]) {
      await store.write({ body, date: "2026-09-22" });
    }
    const first = await store.list({ limit: 2 });
    expect(first.total).toBe(3);
    expect(first.entries.map((entry) => entry.entryId)).toEqual(["20260922-0003", "20260922-0002"]);
    expect(first.entries[0]!.preview).toBe("第三条");

    const second = await store.list({ limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.entryId)).toEqual(["20260922-0001"]);
    expect(second.nextCursor).toBeUndefined();

    const capped = await store.list({ limit: 1000 });
    expect(capped.entries.length).toBe(3);
  });

  it("长期文字按修订整文编辑，清空必须显式撤回", async () => {
    const store = openAgent("xiaobei");
    const appended = await store.write({ target: "long-term", body: "我是小贝。" });
    expect(appended.revision).toBe(1);
    const again = await store.write({ target: "long-term", body: "我负责看代码。" });
    expect(again.revision).toBe(2);
    expect((await store.readLongTerm()).body).toContain("我是小贝。");
    expect((await store.readLongTerm()).body).toContain("我负责看代码。");

    await expect(
      store.update({ target: { kind: "long-term" }, body: "整篇换掉", expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(MemoryConflictError);

    const cleared = await store.retract({ target: { kind: "long-term" } });
    expect(cleared.revision).toBe(3);
    expect((await store.readLongTerm()).body).toBe("");
    expect(await readFile(cleared.recoveredPath, "utf8")).toContain("我负责看代码");
  });

  it("撤回过的条目 id 不会被复用", async () => {
    const store = openAgent("xiaobei");
    const first = await store.write({ body: "会被撤回的一条。", date: "2026-09-22" });
    await store.retract({ target: first.target });
    const second = await store.write({ body: "撤回之后新写的一条。", date: "2026-09-22" });
    expect(second.target).not.toEqual(first.target);
    expect((second.target as { entryId: string }).entryId).toBe("20260922-0002");
  });

  it("索引写失败时正文照样落盘，并留下可诊断的告警", async () => {
    const store = openAgent("xiaobei");
    const broken = new AgentMemoryStore({
      root: agentMemoryRoot(dataDir, "xiaobei"),
      dataRoot: dataDir,
      agentId: "xiaobei",
      index: {
        upsert: () => {
          throw new Error("disk full");
        },
        remove: () => undefined,
        markDirty: () => undefined,
        search: () => [],
      } as unknown as MemoryIndexStore,
    });
    const written = await broken.write({ body: "索引坏了但正文还在。" });
    expect(written.indexSynced).toBe(false);
    expect(written.warning).toBe("正文已保存、检索待同步");
    expect((await store.read(written.target)).body).toContain("索引坏了但正文还在");
  });

  it("没有索引时检索明确报错，不悄悄退化成全量扫描", async () => {
    const store = openAgent("xiaobei", false);
    await expect(store.search({ query: "任意" })).rejects.toThrow(/缺少索引/);
  });

  it("索引丢了可以从正文重建", async () => {
    const store = openAgent("xiaobei");
    await store.write({ body: "重建目标条目，关键词 黄鹂。" });
    const index = opened[0]!;
    index.remove("20260922-0001");
    expect(await store.search({ query: "黄鹂" })).toEqual([]);

    const rebuilt = await store.rebuildIndexFromBodies();
    expect(rebuilt).toBe(1);
    expect((await store.search({ query: "黄鹂" })).length).toBe(1);
  });

  it("损坏的条目文件能被诊断出来", async () => {
    const store = openAgent("xiaobei", false);
    const journal = path.join(agentMemoryRoot(dataDir, "xiaobei"), "memory", "2026-09-22");
    await mkdir(journal, { recursive: true });
    await writeFile(path.join(journal, "20260922-0001.md"), "没有前置信息的条目", "utf8");
    await expect(store.list()).rejects.toThrow(/记忆条目损坏/);
  });
});

// 字符串级的 contain 拦不住「先建链接再读写」：这里要的是真正落盘前再解析一次真实位置。
describe("链接越界的记忆仓", () => {
  it("memory/ 被换成根外链接时，写入被拒而且根外什么都没落", async (context) => {
    const store = openAgent("xiaobei", false);
    const agentRoot = agentMemoryRoot(dataDir, "xiaobei");
    await mkdir(agentRoot, { recursive: true });
    const away = await makeOutside();
    if (!(await makeJunction(away, path.join(agentRoot, "memory"), context))) return;

    await expect(store.write({ body: "这条不该出现在数据根外面。" })).rejects.toThrow(/经链接后越界/);
    expect(await readdir(away)).toEqual([]);
    // 列表同样拒绝：不能一边拒绝写入、一边把根外的条目列出来。
    await expect(store.list()).rejects.toThrow(/经链接后越界/);
  });

  it("MEMORY.md 被换成根外链接时，长期文字读不出来", async (context) => {
    const store = openAgent("xiaobei", false);
    const agentRoot = agentMemoryRoot(dataDir, "xiaobei");
    await mkdir(agentRoot, { recursive: true });
    const away = await makeOutside();
    // 守卫只看 realpath 的结果，不看链接类型；Windows 上 junction 指向文件是坏链接，
    // 所以这里指向一个目录，让本机也真能跑到判定那一步。
    await writeFile(path.join(away, "MEMORY.md"), "根外的长期记忆，不该被读到。", "utf8");
    if (!(await makeJunction(away, path.join(agentRoot, "MEMORY.md"), context))) return;

    await expect(store.readLongTerm()).rejects.toThrow(/经链接后越界/);
    await expect(store.read({ kind: "long-term" })).rejects.toThrow(/经链接后越界/);
  });

  it("索引文件被换成根外链接时，句柄路径先被拒", async (context) => {
    const store = openAgent("xiaoma", false);
    const agentRoot = agentMemoryRoot(dataDir, "xiaoma");
    await mkdir(agentRoot, { recursive: true });
    const away = await makeOutside();
    if (!(await makeJunction(away, path.join(agentRoot, "memory.sqlite"), context))) return;

    expect(() => store.indexPath).toThrow(/经链接后越界/);
  });

  it("档案根自己落在链接下时照常工作", async (context) => {
    const real = path.join(dataDir, "agents", "xiaobei");
    await mkdir(real, { recursive: true });
    const linked = path.join(dataDir, "agents", "linked");
    if (!(await makeJunction(real, linked, context))) return;

    const store = new AgentMemoryStore({ root: linked, dataRoot: dataDir, agentId: "linked", now: () => FIXED_DAY });
    const written = await store.write({ body: "链接下的档案照常写。" });
    expect((await store.read(written.target)).body).toContain("链接下的档案照常写");
    // 而同一个根下指向根外的链接仍然要被拒：查一条不存在的条目会走到撤回区。
    const away = await makeOutside();
    if (!(await makeJunction(away, path.join(real, "retracted"), context))) return;
    await expect(store.readEntry("20260922-0009")).rejects.toThrow(/经链接后越界/);
    expect(await readdir(away)).toEqual([]);
  });
});

describe("非 UTF-8 与超大正文", () => {
  /** 条目文件在 `<档案根>/memory/<日期>/<条目 id>.md`（见 documents.ts 的 resolveEntryPath）。 */
  function entryFile(agentId: string, entryId: string): string {
    const date = `${entryId.slice(0, 4)}-${entryId.slice(4, 6)}-${entryId.slice(6, 8)}`;
    return path.join(agentMemoryRoot(dataDir, agentId), "memory", date, `${entryId}.md`);
  }

  it("日记条目不是 UTF-8：读它报错，列表点名是哪一条", async () => {
    const store = openAgent("xiaobei");
    const written = await store.write({ body: "这条本来好好的。" });
    const file = entryFile("xiaobei", "20260922-0001");
    // 把正文换成带坏字节的字节流：模拟别人用别的编码存了一次。
    await writeFile(file, Buffer.concat([Buffer.from("---\nrevision: 1\n---\n\n", "utf8"), Buffer.from([0xff, 0xfe, 0x0a])]));

    await expect(store.read(written.target)).rejects.toThrow(/记忆条目正文 不是有效的 UTF-8 文本/);
    await expect(store.list()).rejects.toThrow(/记忆条目损坏: 20260922-0001（记忆条目正文 不是有效的 UTF-8 文本/);
    // 坏文件不会被当成「条目没了」，也不会被静默跳过：检索照旧按索引走，读正文才拦。
    expect(existsSync(file)).toBe(true);
  });

  it("长期文字不是 UTF-8：读它报错，重建索引也报错", async () => {
    const store = openAgent("xiaobei");
    await mkdir(agentMemoryRoot(dataDir, "xiaobei"), { recursive: true });
    await writeFile(path.join(agentMemoryRoot(dataDir, "xiaobei"), "MEMORY.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe]));

    await expect(store.readLongTerm()).rejects.toThrow(/长期记忆正文 不是有效的 UTF-8 文本/);
    await expect(store.rebuildIndexFromBodies()).rejects.toThrow(/长期记忆正文 不是有效的 UTF-8 文本/);
  });

  it("正文超过 8 MiB：拒绝读入，不做截断", async () => {
    const store = openAgent("xiaobei");
    await mkdir(agentMemoryRoot(dataDir, "xiaobei"), { recursive: true });
    const file = path.join(agentMemoryRoot(dataDir, "xiaobei"), "MEMORY.md");
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    await expect(store.readLongTerm()).rejects.toThrow(/太大，拒绝读入/);
    // 文件本身一个字没动：拒绝的是读，不是删或截断。
    expect((await readFile(file)).byteLength).toBe(8 * 1024 * 1024 + 1);
  });
});
