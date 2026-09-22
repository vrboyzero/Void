import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { SoulProfileError } from "./profile.js";

/**
 * 一份正文文件最多读多大。
 *
 * 说明书（SOUL.md）与模组正文都还要进模型，装得下的上限由字符预算管（`plugin.ts` 的
 * `resolvePromptBudget`）；这里的字节上限是更外面的一道闸：面板与档案列表会整份读进来，
 * 一个几百 MB 的文件不该把宿主读爆。8 MiB 对正文来说已经离谱地宽了。
 */
export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * 把一段字节按 UTF-8 解成正文；不是合法 UTF-8（或太大）就抛可读的中文错误。
 *
 * 为什么不能直接用 `readFile(..., "utf8")`：Node 遇到非法字节**不报错**，它把坏字节换成
 * U+FFFD，于是坏文件会以乱码装进模型、面板上也只看到一串问号，没人知道是文件坏了还是
 * 插件坏了。这里 fail-closed，与「档案 id 重复」「档案路径越界」同一类处理。
 */
export function decodeUtf8Text(
  bytes: Uint8Array,
  label: string,
  where?: string,
  maxBytes: number = MAX_TEXT_FILE_BYTES,
): string {
  const at = where === undefined ? "" : `: ${where}`;
  if (bytes.byteLength > maxBytes) {
    throw new SoulProfileError(`${label} 太大，拒绝读入${at}（${bytes.byteLength} 字节，上限 ${maxBytes} 字节）。`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (!isUtf8(bytes)) {
    const bad = text.indexOf("\uFFFD");
    const position = bad < 0 ? "" : `，第 ${bad + 1} 个字符处`;
    throw new SoulProfileError(
      `${label} 不是有效的 UTF-8 文本${at}（共 ${bytes.byteLength} 字节${position}出现非法字节）。请把文件另存为 UTF-8 再试。`,
    );
  }
  return text;
}

/** 读一份必须是 UTF-8 的正文文件（先按字节读，再验编码与大小）。 */
export async function readUtf8TextFile(file: string, label: string, maxBytes?: number): Promise<string> {
  return decodeUtf8Text(await readFile(file), label, file, maxBytes);
}
