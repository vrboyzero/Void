import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;

export type BoundedTextFileResult =
  | { status: "ok"; content: string; bytesRead: number }
  | { status: "too_large"; bytesRead: number };

/**
 * 在打开后的同一 handle 上做 size 预检和 max+1 哨兵读取，防止 stat/read 间文件增长绕过上限。
 */
export async function readUtf8FileBounded(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedTextFileResult> {
  signal?.throwIfAborted();
  const limit = Math.max(1, Math.floor(maxBytes));
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    signal?.throwIfAborted();
    if (stats.size > limit) {
      return { status: "too_large", bytesRead: 0 };
    }

    const decoder = new StringDecoder("utf8");
    const textChunks: string[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal <= limit) {
      signal?.throwIfAborted();
      const readLength = Math.min(READ_CHUNK_BYTES, limit - bytesReadTotal + 1);
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, null);
      if (bytesRead === 0) {
        textChunks.push(decoder.end());
        return {
          status: "ok",
          content: textChunks.join(""),
          bytesRead: bytesReadTotal,
        };
      }
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > limit) {
        return { status: "too_large", bytesRead: bytesReadTotal };
      }
      textChunks.push(decoder.write(buffer.subarray(0, bytesRead)));
    }

    return { status: "too_large", bytesRead: bytesReadTotal };
  } finally {
    await handle.close();
  }
}
