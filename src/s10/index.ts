#!/usr/bin/env node
/**
 * Harness: assembly -- the system prompt is a pipeline, not a string.
 *
 * s10_system_prompt.ts - System Prompt Construction
 * This chapter teaches one core idea:
 * the system prompt should be assembled from clear sections, not written as one
 * giant hardcoded blob.
 *
 * Teaching pipeline:
 *   1. core instructions
 *   2. tool listing
 *   3. skill metadata
 *   4. memory section
 *   5. CLAUDE.md chain
 *   6. dynamic context
 *
 * The builder keeps stable information separate from information that changes
 * often. A simple DYNAMIC_BOUNDARY marker makes that split visible.
 *
 * Per-turn reminders are even more dynamic. They are better injected as a
 * separate user-role system reminder than mixed blindly into the stable prompt.
 *
 * Key insight: "Prompt construction is a pipeline with boundaries, not one
 * big string."
 */

import fs from "node:fs";
import os from "node:os";
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

const MODEL = process.env.MODEL_ID!;
if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

const DYNAMIC_BOUNDARY = "=== DYNAMIC_BOUNDARY ===";

// -- Types --

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

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

// -- MemoryManager (from s09, persistent memory) --

class MemoryManager {
  /**
   * Load, build, and save persistent memories across sessions.
   * The teaching version keeps memory explicit:
   * one Markdown file per memory, plus one compact index file.
   */
  memoryDir: string;
  indexPath: string;
  memories: Record<string, MemoryRecord>;

  constructor(memoryDir: string = path.join(WORKDIR, ".memory")) {
    this.memoryDir = memoryDir;
    this.indexPath = path.join(memoryDir, "MEMORY.md");
    this.memories = {};
  }

  loadAll(): void {
    this.memories = {};
    if (!fs.existsSync(this.memoryDir)) return;

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
    if (!Object.keys(this.memories).length) return "";

    const sections: string[] = ["# Memories (persistent across sessions)", ""];

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

    this._rebuildIndex();
    return `Saved memory '${name}' [${memType}] to ${path.relative(WORKDIR, filePath)}`;
  }

  private _rebuildIndex(): void {
    const lines: string[] = ["# Memory Index", ""];
    for (const [name, mem] of Object.entries(this.memories)) {
      lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
        break;
      }
    }
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf8");
  }

  private _parseFrontmatter(text: string): ParsedFrontmatter | null {
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

// -- SystemPromptBuilder (pipeline construction from s10 Python) --

class SystemPromptBuilder {
  /**
   * Assemble the system prompt from independent sections.
   * The teaching goal here is clarity:
   * each section has one source and one responsibility.
   * That makes the prompt easier to reason about, easier to test, and easier
   * to evolve as the agent grows new capabilities.
   */
  private workdir: string;
  private tools: ToolDefinition[];
  private skillsDir: string;
  private memoryMgr: MemoryManager;

  constructor(
    workdir: string,
    tools: ToolDefinition[],
    memoryMgr: MemoryManager
  ) {
    this.workdir = workdir;
    this.tools = tools;
    this.skillsDir = path.join(workdir, "skills");
    this.memoryMgr = memoryMgr;
  }

  // -- Section 1: Core instructions --
  private _buildCore(): string {
    return (
      `You are a coding agent operating in ${this.workdir}.\n` +
      "Use the provided tools to explore, read, write, and edit files.\n" +
      "Always verify before assuming. Prefer reading files over guessing."
    );
  }

  // -- Section 2: Tool listings --
  private _buildToolListing(): string {
    if (!this.tools.length) return "";
    const lines: string[] = ["# Available tools"];
    for (const tool of this.tools) {
      const props = tool.input_schema?.properties ?? {};
      const params = Object.keys(props).join(", ");
      lines.push(`- ${tool.name}(${params}): ${tool.description}`);
    }
    return lines.join("\n");
  }

  // -- Section 3: Skill metadata (layer 1 from s05 concept) --
  private _buildSkillListing(): string {
    if (!fs.existsSync(this.skillsDir)) return "";

    const skills: string[] = [];
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const text = fs.readFileSync(skillMdPath, "utf8");
      // Parse frontmatter for name + description
      const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) continue;

      const meta: Record<string, string> = {};
      for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx !== -1) {
          meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }

      const name = meta["name"] ?? entry.name;
      const desc = meta["description"] ?? "";
      skills.push(`- ${name}: ${desc}`);
    }

    if (!skills.length) return "";
    return "# Available skills\n" + skills.join("\n");
  }

  // -- Section 4: Memory content --
  private _buildMemorySection(): string {
    return this.memoryMgr.loadMemoryPrompt();
  }

  // -- Section 5: CLAUDE.md chain --
  private _buildClaudeMd(): string {
    /**
     * Load CLAUDE.md files in priority order (all are included):
     * 1. ~/.claude/CLAUDE.md (user-global instructions)
     * 2. <project-root>/CLAUDE.md (project instructions)
     * 3. <current-subdir>/CLAUDE.md (directory-specific instructions)
     */
    const sources: Array<[string, string]> = [];

    // User-global
    const userClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(userClaude)) {
      sources.push([
        "user global (~/.claude/CLAUDE.md)",
        fs.readFileSync(userClaude, "utf8"),
      ]);
    }

    // Project root
    const projectClaude = path.join(this.workdir, "CLAUDE.md");
    if (fs.existsSync(projectClaude)) {
      sources.push([
        "project root (CLAUDE.md)",
        fs.readFileSync(projectClaude, "utf8"),
      ]);
    }

    // Subdirectory -- in real CC, this walks from cwd up to project root
    // Teaching: check cwd if different from workdir
    const cwd = process.cwd();
    if (cwd !== this.workdir) {
      const subdirClaude = path.join(cwd, "CLAUDE.md");
      if (fs.existsSync(subdirClaude)) {
        sources.push([
          `subdir (${path.basename(cwd)}/CLAUDE.md)`,
          fs.readFileSync(subdirClaude, "utf8"),
        ]);
      }
    }

    if (!sources.length) return "";

    const parts: string[] = ["# CLAUDE.md instructions"];
    for (const [label, content] of sources) {
      parts.push(`## From ${label}`);
      parts.push(content.trim());
    }
    return parts.join("\n\n");
  }

  // -- Section 6: Dynamic context --
  private _buildDynamicContext(): string {
    const lines = [
      `Current date: ${new Date().toISOString().slice(0, 10)}`,
      `Working directory: ${this.workdir}`,
      `Model: ${MODEL}`,
      `Platform: ${process.platform}`,
    ];
    return "# Dynamic context\n" + lines.join("\n");
  }

  // -- Assemble all sections --
  build(): string {
    /**
     * Assemble the full system prompt from all sections.
     * Static sections (1-5) are separated from dynamic (6) by
     * the DYNAMIC_BOUNDARY marker. In real CC, the static prefix
     * is cached across turns to save prompt tokens.
     */
    const sections: string[] = [];

    const core = this._buildCore();
    if (core) sections.push(core);

    const tools = this._buildToolListing();
    if (tools) sections.push(tools);

    const skills = this._buildSkillListing();
    if (skills) sections.push(skills);

    const memory = this._buildMemorySection();
    if (memory) sections.push(memory);

    const claudeMd = this._buildClaudeMd();
    if (claudeMd) sections.push(claudeMd);

    // Memory guidance -- teach the model when to use save_memory
    sections.push(MEMORY_GUIDANCE.trim());

    // Static/dynamic boundary
    sections.push(DYNAMIC_BOUNDARY);

    const dynamic = this._buildDynamicContext();
    if (dynamic) sections.push(dynamic);

    return sections.join("\n\n");
  }
}

// -- System reminder (per-turn dynamic injection) --

function buildSystemReminder(extra?: string): Message | null {
  /**
   * Build a system-reminder user message for per-turn dynamic content.
   * The teaching version keeps reminders outside the stable system prompt so
   * short-lived context does not get mixed into the long-lived instructions.
   */
  const parts: string[] = [];
  if (extra) parts.push(extra);
  if (!parts.length) return null;

  const content =
    "<system-reminder>\n" + parts.join("\n") + "\n</system-reminder>";
  return { role: "user", content };
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
      shell: "/bin/sh",
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

const TOOLS: ToolDefinition[] = [
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
];

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

// -- Global instances --
const promptBuilder = new SystemPromptBuilder(WORKDIR, TOOLS, memoryMgr);

// -- Agent loop --

async function agentLoop(messages: Message[]): Promise<void> {
  /**
   * Agent loop with assembled system prompt.
   * The system prompt is rebuilt each iteration. In real CC, the static
   * prefix is cached and only the dynamic suffix changes per turn.
   */
  while (true) {
    const system = promptBuilder.build();

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

    if (response.stop_reason !== "tool_use") return;

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

// -- Main --

async function main(): Promise<void> {
  memoryMgr.loadAll();

  // Show the assembled prompt at startup for educational purposes
  const fullPrompt = promptBuilder.build();
  const sectionCount = (fullPrompt.match(/\n# /g) ?? []).length;
  console.log(
    `[System prompt assembled: ${fullPrompt.length} chars, ~${sectionCount} sections]`
  );

  const memCount = Object.keys(memoryMgr.memories).length;
  if (memCount) {
    console.log(`[${memCount} memories loaded into context]`);
  } else {
    console.log(
      "[No existing memories. The agent can create them with save_memory.]"
    );
  }

  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms10 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const query = line.trim();

    if (
      !query ||
      query.toLowerCase() === "q" ||
      query.toLowerCase() === "exit"
    ) {
      rl.close();
      return;
    }

    // /prompt -- show the full assembled system prompt
    if (query === "/prompt") {
      console.log("--- System Prompt ---");
      console.log(promptBuilder.build());
      console.log("--- End ---");
      rl.prompt();
      return;
    }

    // /sections -- show only section headings and boundary marker
    if (query === "/sections") {
      const prompt = promptBuilder.build();
      for (const ln of prompt.split("\n")) {
        if (ln.startsWith("# ") || ln === DYNAMIC_BOUNDARY) {
          console.log(`  ${ln}`);
        }
      }
      rl.prompt();
      return;
    }

    // /memories -- list loaded memories
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
