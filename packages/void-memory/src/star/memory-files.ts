import fs from "node:fs/promises";
import path from "node:path";

/**
 * Memory 文件项
 */
export type MemoryFileEntry = {
    /** 相对路径（相对于 workspaceDir） */
    path: string;
    /** 绝对路径 */
    absPath: string;
    /** 文件名 */
    name: string;
    /** 是否是 MEMORY.md（长期记忆） */
    isMainMemory: boolean;
    /** 是否是日期文件（memory/YYYY-MM-DD.md） */
    isDaily: boolean;
    /** 日期（如果是日期文件） */
    date?: string;
};

/**
 * 列出 Memory 文件的结果
 */
export type ListMemoryFilesResult = {
    /** 所有 memory 文件 */
    files: MemoryFileEntry[];
    /** 是否存在 MEMORY.md */
    hasMainMemory: boolean;
    /** 日期文件数量 */
    dailyCount: number;
};

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * 检查文件是否存在
 */
async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 递归遍历目录
 */
async function walkDir(dir: string, files: string[]): Promise<void> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walkDir(full, files);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith(".md")) continue;
            files.push(full);
        }
    } catch {
        // Directory doesn't exist or can't be read
    }
}

/**
 * 规范化相对路径
 */
export function normalizeRelPath(value: string): string {
    const trimmed = value.trim().replace(/^[./]+/, "");
    return trimmed.replace(/\\/g, "/");
}

/**
 * 检查路径是否是 Memory 路径
 */
export function isMemoryPath(relPath: string): boolean {
    const normalized = normalizeRelPath(relPath);
    if (!normalized) return false;
    if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
    return normalized.startsWith("memory/");
}

/**
 * 列出 Workspace 中的所有 Memory 文件
 * 
 * 按照 moltbot 约定：
 * - MEMORY.md 或 memory.md（长期记忆）
 * - memory/YYYY-MM-DD.md（日常记忆）
 * - memory/*.md（其他 memory 文件）
 */
export async function listMemoryFiles(workspaceDir: string): Promise<ListMemoryFilesResult> {
    const entries: MemoryFileEntry[] = [];

    // 1. 检查 MEMORY.md
    const memoryFile = path.join(workspaceDir, "MEMORY.md");
    const altMemoryFile = path.join(workspaceDir, "memory.md");

    if (await exists(memoryFile)) {
        entries.push({
            path: "MEMORY.md",
            absPath: memoryFile,
            name: "MEMORY.md",
            isMainMemory: true,
            isDaily: false,
        });
    } else if (await exists(altMemoryFile)) {
        entries.push({
            path: "memory.md",
            absPath: altMemoryFile,
            name: "memory.md",
            isMainMemory: true,
            isDaily: false,
        });
    }

    // 2. 扫描 memory/ 目录
    const memoryDir = path.join(workspaceDir, "memory");
    const mdFiles: string[] = [];
    await walkDir(memoryDir, mdFiles);

    for (const absPath of mdFiles) {
        const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
        const name = path.basename(absPath);
        const dateMatch = name.match(DATE_FILE_PATTERN);

        entries.push({
            path: relPath,
            absPath,
            name,
            isMainMemory: false,
            isDaily: !!dateMatch,
            date: dateMatch ? dateMatch[1] : undefined,
        });
    }

    // 去重（如果有符号链接等）
    const seen = new Set<string>();
    const deduped: MemoryFileEntry[] = [];
    for (const entry of entries) {
        let key = entry.absPath;
        try {
            key = await fs.realpath(entry.absPath);
        } catch { }
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
    }

    return {
        files: deduped,
        hasMainMemory: deduped.some(f => f.isMainMemory),
        dailyCount: deduped.filter(f => f.isDaily).length,
    };
}

/**
 * 确保 memory 目录存在
 */
export async function ensureMemoryDir(workspaceDir: string): Promise<string> {
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    return memoryDir;
}

/**
 * 获取今天的 memory 文件路径
 */
export function getTodayMemoryPath(workspaceDir: string): string {
    const today = formatLocalDate();
    return path.join(workspaceDir, "memory", `${today}.md`);
}

export function formatLocalDate(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * 读取 Memory 文件内容
 * 
 * @param workspaceDir Workspace 根目录
 * @param relPath 相对路径（如 "MEMORY.md" 或 "memory/2026-01-31.md"）
 * @param from 起始行号（1-indexed，可选）
 * @param lines 读取行数（可选）
 */
export async function readMemoryFile(params: {
    workspaceDir: string;
    relPath: string;
    from?: number;
    lines?: number;
}): Promise<{ text: string; path: string; totalLines: number }> {
    const { workspaceDir, relPath, from, lines } = params;
    const normalized = normalizeRelPath(relPath);

    // 安全检查：只允许读取 memory 路径
    if (!isMemoryPath(normalized)) {
        throw new Error(`Path is not a memory file: ${relPath}`);
    }

    const absPath = path.join(workspaceDir, normalized);

    // 检查文件存在
    if (!(await exists(absPath))) {
        throw new Error(`Memory file not found: ${normalized}`);
    }

    // 检查路径遍历
    const resolvedPath = await fs.realpath(absPath);
    const resolvedWorkspace = await fs.realpath(workspaceDir);
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
        throw new Error(`Path traversal detected: ${relPath}`);
    }

    // 读取内容
    const content = await fs.readFile(absPath, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;

    // 如果指定了行号范围
    if (from !== undefined && from >= 1) {
        const startIdx = from - 1; // 转为 0-indexed
        const endIdx = lines !== undefined ? startIdx + lines : allLines.length;
        const selectedLines = allLines.slice(startIdx, endIdx);
        return {
            text: selectedLines.join("\n"),
            path: normalized,
            totalLines,
        };
    }

    return {
        text: content,
        path: normalized,
        totalLines,
    };
}

/**
 * 追加内容到今天的 memory 文件
 */
export async function appendToTodayMemory(
    workspaceDir: string,
    content: string,
    date = new Date(),
): Promise<string> {
    await ensureMemoryDir(workspaceDir);
    const filePath = getTodayMemoryPathForDate(workspaceDir, date);

    // 如果文件不存在，创建带日期头的新文件
    if (!(await exists(filePath))) {
        const today = formatLocalDate(date);
        const header = `# ${today}\n\n`;
        await fs.writeFile(filePath, header + content.trim() + "\n", "utf-8");
    } else {
        // 追加到现有文件
        await fs.appendFile(filePath, "\n" + content.trim() + "\n", "utf-8");
    }

    return filePath;
}

function getTodayMemoryPathForDate(workspaceDir: string, date: Date): string {
    return path.join(workspaceDir, "memory", `${formatLocalDate(date)}.md`);
}

/**
 * 写入指定的 memory 文件。
 *
 * @param workspaceDir Workspace 根目录
 * @param relPath memory 相对路径（如 MEMORY.md 或 memory/2026-03-15.md）
 * @param content 要写入的内容
 * @param mode append / overwrite
 */
export async function writeMemoryFile(params: {
    workspaceDir: string;
    relPath: string;
    content: string;
    mode?: "append" | "overwrite";
}): Promise<string> {
    const { workspaceDir, relPath, content } = params;
    const mode = params.mode ?? "append";
    const normalized = normalizeRelPath(relPath);

    if (!isMemoryPath(normalized)) {
        throw new Error(`Path is not a memory file: ${relPath}`);
    }

    const absPath = path.join(workspaceDir, normalized);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    const existsAlready = await exists(absPath);
    const trimmedContent = content.trim();
    if (!trimmedContent) {
        throw new Error("Memory content cannot be empty");
    }

    if (mode === "overwrite") {
        if (normalized.startsWith("memory/")) {
            const fileName = path.basename(normalized);
            const dateMatch = fileName.match(DATE_FILE_PATTERN);
            if (dateMatch) {
                const header = `# ${dateMatch[1]}\n\n`;
                await fs.writeFile(absPath, header + trimmedContent + "\n", "utf-8");
                return absPath;
            }
        }

        await fs.writeFile(absPath, trimmedContent + "\n", "utf-8");
        return absPath;
    }

    if (!existsAlready) {
        if (normalized.startsWith("memory/")) {
            const fileName = path.basename(normalized);
            const dateMatch = fileName.match(DATE_FILE_PATTERN);
            if (dateMatch) {
                const header = `# ${dateMatch[1]}\n\n`;
                await fs.writeFile(absPath, header + trimmedContent + "\n", "utf-8");
                return absPath;
            }
        }

        await fs.writeFile(absPath, trimmedContent + "\n", "utf-8");
        return absPath;
    }

    await fs.appendFile(absPath, "\n" + trimmedContent + "\n", "utf-8");
    return absPath;
}
