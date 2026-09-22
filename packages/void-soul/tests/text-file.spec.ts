import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TEXT_FILE_BYTES, SoulProfileError, decodeUtf8Text, readUtf8TextFile } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-soul-text-"));
  roots.push(root);
  const file = path.join(root, "SOUL.md");
  await writeFile(file, bytes);
  return file;
}

/** 一份合法 UTF-8 的 SOUL（含中文与 emoji，验证多字节序列不会被误判）。 */
const GOOD = Buffer.from("---\nid: xiaobei\nname: 小贝\n---\n# 底线\n\n说人话，别编。🙂\n", "utf8");

describe("decodeUtf8Text", () => {
  it("合法 UTF-8 原样解出来（含中文与 emoji）", () => {
    expect(decodeUtf8Text(GOOD, "档案 SOUL.md")).toBe(GOOD.toString("utf8"));
  });

  it("坏字节拒绝，并指出是哪个文件、第几个字符", () => {
    // 0xFF 在 UTF-8 里永远不合法：单独出现就是坏字节。
    const broken = Buffer.concat([Buffer.from("# 底线\n\n", "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from("\n", "utf8")]);
    let caught: unknown;
    try {
      decodeUtf8Text(broken, "档案 SOUL.md", "小贝/SOUL.md");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SoulProfileError);
    const message = (caught as Error).message;
    expect(message).toContain("档案 SOUL.md 不是有效的 UTF-8 文本");
    expect(message).toContain("小贝/SOUL.md");
    expect(message).toContain(`共 ${broken.byteLength} 字节`);
    expect(message).toContain("第 7 个字符处");
    expect(message).toContain("另存为 UTF-8");
  });

  it("半截的多字节序列（截断的中文）也算坏", () => {
    const whole = Buffer.from("底线", "utf8");
    const cut = whole.subarray(0, whole.byteLength - 1);
    expect(() => decodeUtf8Text(cut, "记忆条目正文")).toThrow(/不是有效的 UTF-8/);
  });

  it("超过字节上限拒绝，报出实际大小与上限", () => {
    const big = Buffer.alloc(64, 0x61);
    let caught: unknown;
    try {
      decodeUtf8Text(big, "档案 SOUL.md", "小贝/SOUL.md", 32);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("档案 SOUL.md 太大，拒绝读入");
    expect((caught as Error).message).toContain("64 字节，上限 32 字节");
  });

  it("正好等于上限时放行（边界不多拒一个字节）", () => {
    const exact = Buffer.alloc(32, 0x61);
    expect(decodeUtf8Text(exact, "档案 SOUL.md", undefined, 32)).toHaveLength(32);
  });

  it("默认上限是 8 MiB，且是个正数", () => {
    expect(MAX_TEXT_FILE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("readUtf8TextFile", () => {
  it("读得到合法文件，报错时带上文件路径", async () => {
    const file = await tempFile(GOOD);
    expect(await readUtf8TextFile(file, "档案 SOUL.md")).toBe(GOOD.toString("utf8"));
  });

  it("坏文件抛 SoulProfileError，路径在消息里", async () => {
    const file = await tempFile(Buffer.from([0x23, 0x20, 0xff]));
    let caught: unknown;
    try {
      await readUtf8TextFile(file, "档案 SOUL.md");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SoulProfileError);
    expect((caught as Error).message).toContain(file);
  });
});
