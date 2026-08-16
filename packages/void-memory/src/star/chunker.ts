export interface ChunkOptions {
  maxLength?: number;
  overlap?: number;
}

export class Chunker {
  private maxLength: number;
  private overlap: number;

  constructor(options: ChunkOptions = {}) {
    this.maxLength = options.maxLength ?? 1000;
    this.overlap = options.overlap ?? 100;
  }

  splitText(content: string): string[] {
    // 1. 按 Markdown 标题或双换行符初步切分为段落
    // 优先按标题切分，如果不包含标题，则按段落切分
    const sections = this.splitByHeaders(content);
    
    // 2. 对每个段落进行检查，如果过长则按句子/字符进一步切分
    // 如果过短则尝试合并
    const chunks: string[] = [];
    let currentChunk = "";

    for (const section of sections) {
      // 如果加上当前段落超过最大长度，先保存之前的 chunk
      if (currentChunk.length + section.length > this.maxLength) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          // 保留 overlap 部分作为下一个 chunk 的开头
          currentChunk = currentChunk.slice(-this.overlap);
        }
        
        // 如果单个段落本身就超过最大长度，需要强制切分
        if (section.length > this.maxLength) {
            // 简单的强制切分策略（后续可优化为按句子切分）
            let remaining = section;
            while (remaining.length > this.maxLength) {
                const subChunk = remaining.slice(0, this.maxLength);
                chunks.push(subChunk.trim());
                remaining = remaining.slice(this.maxLength - this.overlap);
            }
            currentChunk += remaining;
        } else {
             currentChunk += section;
        }
      } else {
        currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + section;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  private splitByHeaders(content: string): string[] {
    // 简单的按行遍历，检测标题行
    const lines = content.split(/\r?\n/);
    const sections: string[] = [];
    let buffer: string[] = [];

    for (const line of lines) {
      // 匹配 # 标题 (Markdown)
      if (line.match(/^#{1,6}\s/)) {
        if (buffer.length > 0) {
          sections.push(buffer.join("\n"));
          buffer = [];
        }
      }
      buffer.push(line);
    }
    
    if (buffer.length > 0) {
      sections.push(buffer.join("\n"));
    }

    return sections;
  }
}
