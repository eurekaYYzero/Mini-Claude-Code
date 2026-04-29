/**
 * =============================================================================
 *  features/memory/memory-manager.ts — MemoryManager 持久记忆管理器
 * =============================================================================
 *
 * 负责跨会话持久记忆的加载、保存和索引管理。
 * 每一条记忆是一个带 YAML frontmatter 的 Markdown 文件，存储在 .memory/ 目录。
 *
 * 记忆类型:
 *   - user:       用户偏好（如 "我喜欢用 tabs"）
 *   - feedback:   用户纠正反馈（如 "不要做 X"）
 *   - project:    无法从代码推导的项目约定/决策原因
 *   - reference:  外部资源指针（如文档 URL、看板地址）
 */

import fs from "node:fs";
import path from "node:path";

/** 记忆类型常量 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 索引文件行数上限 */
const MAX_INDEX_LINES = 200;

/** 单条记忆记录 */
export interface MemoryRecord {
  description: string;
  type: MemoryType;
  content: string;
  file: string;
}

/** 解析 frontmatter 结果 */
interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  content: string;
  [key: string]: string | undefined;
}

/**
 * MemoryManager — 持久记忆管理器
 *
 * 每个记忆对应一个 .md 文件，MEMORY.md 是聚合索引。
 */
export class MemoryManager {
  readonly memoryDir: string;
  readonly indexFile: string;
  memories: Record<string, MemoryRecord>;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    this.indexFile = path.join(memoryDir, "MEMORY.md");
    this.memories = {};
  }

  /** 加载 .memory/ 目录下所有记忆文件 */
  loadAll(): void {
    this.memories = {};

    if (!fs.existsSync(this.memoryDir)) return;

    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();

    for (const file of files) {
      const fullPath = path.join(this.memoryDir, file);
      const parsed = this.#parseFrontmatter(fs.readFileSync(fullPath, "utf8"));
      if (!parsed) continue;

      const name = parsed.name ?? path.basename(file, ".md");
      const memType = MEMORY_TYPES.includes(parsed.type as MemoryType)
        ? (parsed.type as MemoryType)
        : "project";

      this.memories[name] = {
        description: parsed.description ?? "",
        type: memType,
        content: parsed.content ?? "",
        file,
      };
    }

    if (Object.keys(this.memories).length > 0) {
      console.log(`[Memory loaded: ${Object.keys(this.memories).length} memories from ${this.memoryDir}]`);
    }
  }

  /**
   * 构建注入 system prompt 的记忆段落。
   * 按类型分组，生成 Markdown 格式文本。
   */
  loadMemoryPrompt(): string {
    if (!Object.keys(this.memories).length) return "";

    const sections: string[] = ["# Memories (persistent across sessions)", ""];

    for (const memType of MEMORY_TYPES) {
      const typed = Object.entries(this.memories).filter(([, v]) => v.type === memType);
      if (!typed.length) continue;

      sections.push(`## [${memType}]`);
      for (const [name, mem] of typed) {
        sections.push(`### ${name}: ${mem.description}`);
        if (mem.content.trim()) {
          sections.push(mem.content.trim());
        }
        sections.push("");
      }
    }

    return sections.join("\n");
  }

  /**
   * 保存一条记忆到磁盘并更新索引。
   * @returns 状态信息字符串
   */
  saveMemory(name: string, description: string, memType: string, content: string): string {
    if (!MEMORY_TYPES.includes(memType as MemoryType)) {
      return `Error: type must be one of ${JSON.stringify(MEMORY_TYPES)}`;
    }

    const safeName = name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeName) return "Error: invalid memory name";

    fs.mkdirSync(this.memoryDir, { recursive: true });

    const frontmatter =
      `---\n` +
      `name: ${name}\n` +
      `description: ${description}\n` +
      `type: ${memType}\n` +
      `---\n` +
      `${content}\n`;

    const fileName = `${safeName}.md`;
    const filePath = path.join(this.memoryDir, fileName);
    fs.writeFileSync(filePath, frontmatter, "utf8");

    this.memories[name] = {
      description,
      type: memType as MemoryType,
      content,
      file: fileName,
    };

    this.#rebuildIndex();
    return `Saved memory '${name}' [${memType}] to ${fileName}`;
  }

  /** 重建 MEMORY.md 索引文件，上限 200 行 */
  #rebuildIndex(): void {
    const lines: string[] = ["# Memory Index", ""];
    for (const [name, mem] of Object.entries(this.memories)) {
      lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
        break;
      }
    }
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.writeFileSync(this.indexFile, lines.join("\n") + "\n", "utf8");
  }

  /** 解析 --- delimited frontmatter + body */
  #parseFrontmatter(text: string): ParsedFrontmatter | null {
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) return null;

    const header = match[1];
    const body = match[2];

    const result: ParsedFrontmatter = { content: body.trim() };
    for (const line of header.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return result;
  }

  /** 记忆引导提示词，告诉 agent 何时保存/不保存记忆 */
  static readonly GUIDANCE = `
When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)
`;
}
