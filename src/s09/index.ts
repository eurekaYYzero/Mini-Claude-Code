#!/usr/bin/env node
/**
 * Harness: persistence -- remembering across the session boundary.
 *
 * s09_memory_system.ts - Memory System
 * This teaching version focuses on one core idea:
 * some information should survive the current conversation, but not everything
 * belongs in memory.
 *
 * Use memory for:
 *   - user preferences
 *   - repeated user feedback
 *   - project facts that are NOT obvious from the current code
 *   - pointers to external resources
 *
 * Do NOT use memory for:
 *   - code structure that can be re-read from the repo
 *   - temporary task state
 *   - secrets
 *
 * Storage layout:
 *   .memory/
 *     MEMORY.md
 *     prefer_tabs.md
 *     review_style.md
 *     incident_board.md
 *
 * Each memory is a small Markdown file with frontmatter.
 * The agent can save a memory through save_memory(), and the memory index
 * is rebuilt after each write.
 *
 * An optional "Dream" pass can later consolidate, deduplicate, and prune
 * stored memories. It is useful, but it is not the first thing readers need
 * to understand.
 *
 * Key insight:
 * "Memory only stores cross-session information that is still worth recalling
 * later and is not easy to re-derive from the current repo."
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.MODEL_ID;
if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
const MAX_INDEX_LINES = 200;

type MemoryType = (typeof MEMORY_TYPES)[number];

interface MemoryRecord {
  description: string;
  type: MemoryType;
  content: string;
  file: string;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  content: string;
  [key: string]: string | undefined;
}

type Role = "user" | "assistant";

interface Message {
  role: Role;
  content: unknown;
}

/** 工具调用块，用于 agentLoop 中的类型收窄 */
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

class MemoryManager {
  /**
   * Load, build, and save persistent memories across sessions.
   * The teaching version keeps memory explicit:
   * one Markdown file per memory, plus one compact index file.
   */
  memoryDir: string;
  memories: Record<string, MemoryRecord>;

  constructor(memoryDir: string = MEMORY_DIR) {
    this.memoryDir = memoryDir;
    this.memories = {};
  }

  loadAll(): void {
    /** Load MEMORY.md index and all individual memory files. */
    this.memories = {};

    if (!fs.existsSync(this.memoryDir)) {
      return;
    }

    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();

    for (const file of files) {
      const fullPath = path.join(this.memoryDir, file);
      const parsed = this._parseFrontmatter(fs.readFileSync(fullPath, "utf8"));
      if (parsed) {
        const name = parsed.name ?? path.basename(file, ".md");
        this.memories[name] = {
          description: parsed.description ?? "",
          type: MEMORY_TYPES.includes((parsed.type ?? "project") as MemoryType)
            ? ((parsed.type ?? "project") as MemoryType)
            : "project",
          content: parsed.content ?? "",
          file,
        };
      }
    }

    const count = Object.keys(this.memories).length;
    if (count > 0) {
      console.log(`[Memory loaded: ${count} memories from ${this.memoryDir}]`);
    }
  }

  loadMemoryPrompt(): string {
    /** Build a memory section for injection into the system prompt. */
    if (!Object.keys(this.memories).length) {
      return "";
    }

    const sections: string[] = [];
    sections.push("# Memories (persistent across sessions)");
    sections.push("");

    for (const memType of MEMORY_TYPES) {
      const typed = Object.entries(this.memories).filter(
        ([, v]) => v.type === memType
      );
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

  saveMemory(
    name: string,
    description: string,
    memType: string,
    content: string
  ): string {
    /**
     * Save a memory to disk and update the index.
     * Returns a status message.
     */
    if (!MEMORY_TYPES.includes(memType as MemoryType)) {
      return `Error: type must be one of ${JSON.stringify(MEMORY_TYPES)}`;
    }

    const safeName = name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeName) {
      return "Error: invalid memory name";
    }

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

    this._rebuildIndex();

    return `Saved memory '${name}' [${memType}] to ${path.relative(
      WORKDIR,
      filePath
    )}`;
  }

  private _rebuildIndex(): void {
    /** Rebuild MEMORY.md from current in-memory state, capped at 200 lines. */
    const lines: string[] = ["# Memory Index", ""];

    for (const [name, mem] of Object.entries(this.memories)) {
      lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
        break;
      }
    }

    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.writeFileSync(MEMORY_INDEX, lines.join("\n") + "\n", "utf8");
  }

  private _parseFrontmatter(text: string): ParsedFrontmatter | null {
    /** Parse --- delimited frontmatter + body content. */
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) return null;

    const header = match[1];
    const body = match[2];

    const result: ParsedFrontmatter = { content: body.trim() };
    for (const line of header.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        result[key] = value;
      }
    }
    return result;
  }
}

// -- Tool implementations --

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      shell: true,
    });

    const out = `${stdout}${stderr}`.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e) {
    const err = e as {
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    if (err.killed || err.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }

    const out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.trim();
    return out ? out.slice(0, 50000) : "Error: command failed";
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more)`]);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

const memoryMgr = new MemoryManager();

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (args) => runBash(String(args.command ?? "")),
  read_file: async (args) =>
    runRead(
      String(args.path ?? ""),
      typeof args.limit === "number" ? args.limit : undefined
    ),
  write_file: async (args) =>
    runWrite(String(args.path ?? ""), String(args.content ?? "")),
  edit_file: async (args) =>
    runEdit(
      String(args.path ?? ""),
      String(args.old_text ?? ""),
      String(args.new_text ?? "")
    ),
  save_memory: async (args) =>
    memoryMgr.saveMemory(
      String(args.name ?? ""),
      String(args.description ?? ""),
      String(args.type ?? ""),
      String(args.content ?? "")
    ),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "save_memory",
    description: "Save a persistent memory that survives across sessions.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short identifier (e.g. prefer_tabs, db_schema)",
        },
        description: {
          type: "string",
          description: "One-line summary of what this memory captures",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description:
            "user=preferences, feedback=corrections, project=non-obvious project conventions or decision reasons, reference=external resource pointers",
        },
        content: {
          type: "string",
          description: "Full memory content (multi-line OK)",
        },
      },
      required: ["name", "description", "type", "content"],
    },
  },
] as const;

const MEMORY_GUIDANCE = `
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

function buildSystemPrompt(): string {
  /** Assemble system prompt with memory content included. */
  const parts: string[] = [
    `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`,
  ];

  const memorySection = memoryMgr.loadMemoryPrompt();
  if (memorySection) {
    parts.push(memorySection);
  }

  parts.push(MEMORY_GUIDANCE);
  return parts.join("\n\n");
}

async function agentLoop(messages: Message[]): Promise<void> {
  /**
   * Agent loop with memory-aware system prompt.
   * The system prompt is rebuilt each call so newly saved memories
   * are visible in the next LLM turn within the same session.
   */
  while (true) {
    const system = buildSystemPrompt();

    const response = await client.messages.create({
      model: MODEL,
      system,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of response.content as any[]) {
      if ((block as ToolUseBlock).type !== "tool_use") continue;

      const toolBlock = block as ToolUseBlock;
      const handler = TOOL_HANDLERS[toolBlock.name];

      let output: string;
      try {
        output = handler
          ? await handler(toolBlock.input ?? {})
          : `Unknown: ${toolBlock.name}`;
      } catch (e) {
        output = `Error: ${(e as Error).message}`;
      }

      console.log(`> ${toolBlock.name}: ${String(output).slice(0, 200)}`);

      results.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: String(output),
      });
    }

    messages.push({
      role: "user",
      content: results,
    });
  }
}

async function main(): Promise<void> {
  memoryMgr.loadAll();

  const memCount = Object.keys(memoryMgr.memories).length;
  if (memCount) {
    console.log(`[${memCount} memories loaded into context]`);
  } else {
    console.log("[No existing memories. The agent can create them with save_memory.]");
  }

  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms09 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const query = line.trim();

    if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") {
      rl.close();
      return;
    }

    if (query === "/memories") {
      if (Object.keys(memoryMgr.memories).length) {
        for (const [name, mem] of Object.entries(memoryMgr.memories)) {
          console.log(`  [${mem.type}] ${name}: ${mem.description}`);
        }
      } else {
        console.log("  (no memories)");
      }
      rl.prompt();
      return;
    }

    history.push({ role: "user", content: query });

    try {
      await agentLoop(history);

      const responseContent = history[history.length - 1]?.content;
      if (Array.isArray(responseContent)) {
        for (const block of responseContent as any[]) {
          if (
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof (block as { text: unknown }).text === "string"
          ) {
            console.log((block as { text: string }).text);
          }
        }
      }
      console.log();
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
