/**
 * =============================================================================
 *  stage1.ts — 完整集成的 AI Agent 架构
 * =============================================================================
 *
 * 本文件整合了 s01～s06 六个阶段的核心能力，形成一个生产级的 Agent 框架：
 *
 *    s01 - 基础框架   LLM 消息循环、工具调用系统、文本提取
 *    s02 - 安全操作    安全路径校验（safePath）、read/write/edit 文件工具
 *    s03 - 任务管理    TodoManager 进度追踪、多轮提醒注入
 *    s04 - 子代理      独立上下文的任务委派、结果汇总、轮次限制
 *    s05 - 技能系统    SkillLoader、YAML Frontmatter 解析、按需加载知识
 *    s06 - 对话压缩    三级渐进压缩（微压缩、自动压缩、手动压缩）
 *
 * 架构概览：
 *
 *   +----------+     +-----------+      +-----------------------------+
 *   |  User    | --> |   LLM     | <--> | Tool Dispatcher             |
 *   | (stdin)  |     | (Claude)  |      |  ├─ bash                    |
 *   +----------+     +-----+-----+      |  ├─ read_file / write_file  |
 *                         ^             |  ├─ edit_file               |
 *                         |             |  ├─ todo     (TodoManager)  |
 *                         |             |  ├─ task     (Subagent)     |
 *                         |             |  ├─ load_skill(SkillLoader) |
 *                         +------+------+  └─ compact  (Compression)  |
 *                          tool_result  +-----------------------------+
 *                                            |
 *                             +--------------+--------------+
 *                             |              |              |
 *                        microCompact   autoCompact    manual compact
 *                          (every turn)  (threshold)    (on demand)
 * =============================================================================
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import yaml from "js-yaml";

// =============================================================================
// 1. 配置与初始化
// =============================================================================

dotenv.config();

const execAsync = promisify(exec);
const WORKDIR = process.cwd();
const SKILLS_DIR = path.resolve(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.resolve(WORKDIR, ".transcripts");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const BASH_TIMEOUT = 120000; // bash 命令超时（毫秒）
const MAX_OUTPUT_LENGTH = 50000; // 单次工具结果最大长度

// 压缩配置
const COMPACT_THRESHOLD = 1000; // token 阈值，超过触发自动压缩
const KEEP_RECENT = 1; // 保留最近 N 条工具结果原文
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]); // 保留这些工具的结果不压缩

// =============================================================================
// 2. 类型定义
// =============================================================================

type TodoStatus = "pending" | "in_progress" | "completed";

interface Message {
  role: "user" | "assistant";
  content: any;
}

interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
  [key: string]: any;
}

interface SkillEntry {
  meta: SkillMeta;
  body: string;
  path: string;
}

type ToolHandler = (input: any) => Promise<string>;

// =============================================================================
// 3. 安全路径验证（s02）
// =============================================================================

/**
 * 验证文件路径是否在 WORKDIR 范围内，防止路径穿越攻击。
 * 所有文件操作的入口都必须经过此函数。
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const workspace = path.resolve(WORKDIR);
  const relative = path.relative(workspace, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return resolved;
}

// =============================================================================
// 4. 工具实现（s02 / s03 / s04 / s05）
// =============================================================================

/**
 * 执行 shell 命令并返回输出。
 * 支持 2 分钟超时，合并 stdout 和 stderr。
 */
async function runBash(command: string): Promise<string> {
  try {
    const result = await execAsync(command, {
      cwd: WORKDIR,
      timeout: BASH_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = (result.stdout + result.stderr).trim();
    return output || "(no output)";
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

/**
 * 读取文件内容，支持可选的行数限制。
 * 超过限制的行会被截断并显示剩余行数。
 */
async function runRead(filePath: string, limit?: number | null): Promise<string> {
  try {
    const fp = safePath(filePath);
    const text = await fsPromises.readFile(fp, "utf8");
    let lines = text.split(/\r?\n/);

    if (limit != null && limit > 0 && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }

    return lines.join("\n").slice(0, MAX_OUTPUT_LENGTH);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

/**
 * 写入文件内容，自动创建父目录。
 */
async function runWrite(filePath: string, content: string): Promise<string> {
  try {
    const fp = safePath(filePath);
    await fsPromises.mkdir(path.dirname(fp), { recursive: true });
    await fsPromises.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

/**
 * 编辑文件：精确匹配并替换文本。
 * 要求 oldText 在文件中唯一存在，否则返回错误。
 */
async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
  try {
    const fp = safePath(filePath);
    const content = await fsPromises.readFile(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    await fsPromises.writeFile(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// =============================================================================
// 5. TodoManager — 任务进度管理（s03）
// =============================================================================

/**
 * 管理多步骤任务的 todo 列表，确保：
 * - 最多 20 个待办项
 * - 同一时间只有一个任务处于 in_progress 状态
 * - 自动渲染进度的文本表示
 */
class TodoManager {
  private items: TodoItem[] = [];

  /**
   * 更新任务列表（全量替换）。输入由 LLM 生成，需严格校验。
   */
  update(items: any[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? {};
      const id = String(item.id ?? i + 1);
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }

      if (status === "in_progress") {
        inProgressCount++;
      }

      validated.push({ id, text, status: status as TodoStatus });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  /**
   * 渲染任务列表为文本格式。
   * 格式：`[ ] | [>] | [x] #id: task text`
   */
  render(): string {
    if (this.items.length === 0) return "No todos.";

    const markers: Record<TodoStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };
    const done = this.items.filter((t) => t.status === "completed").length;

    return [
      ...this.items.map((item) => `${markers[item.status]} #${item.id}: ${item.text}`),
      "",
      `(${done}/${this.items.length} completed)`,
    ].join("\n");
  }
}

// =============================================================================
// 6. SkillLoader — 按需加载知识体系（s05）
// =============================================================================

/**
 * 扫描 skills 目录下的 SKILL.md 文件，解析 YAML Frontmatter。
 * 采用两层架构：
 *   - Layer 1: 元数据（名称、描述、标签）注入系统提示词
 *   - Layer 2: 完整技能内容通过 load_skill 工具按需返回
 */
class SkillLoader {
  private skills: Record<string, SkillEntry> = {};

  constructor(skillsDir: string) {
    this.loadAll(skillsDir);
  }

  /** 递归查找并加载所有 SKILL.md 文件 */
  private loadAll(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return;

    const files = this.findSkillFiles(skillsDir).sort();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const [meta, body] = this.parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(file));
      this.skills[name] = { meta, body, path: file };
    }
  }

  /** 递归查找目录中的 SKILL.md 文件 */
  private findSkillFiles(dir: string): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results = results.concat(this.findSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }

    return results;
  }

  /** 解析 YAML Frontmatter（--- 分隔符之间的部分） */
  private parseFrontmatter(text: string): [SkillMeta, string] {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return [{}, text];

    let meta: SkillMeta = {};
    try {
      meta = (yaml.load(match[1]) as SkillMeta) || {};
    } catch {
      meta = {};
    }

    return [meta, match[2].trim()];
  }

  /** Layer 1: 返回所有技能的简短描述（用于系统提示词） */
  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (names.length === 0) return "(no skills available)";

    return names
      .map((name) => {
        const skill = this.skills[name];
        const desc = skill.meta.description || "No description";
        const tags = skill.meta.tags || "";
        return `  - ${name}: ${desc}${tags ? ` [${tags}]` : ""}`;
      })
      .join("\n");
  }

  /** Layer 2: 返回完整技能内容（通过 tool_result 给 LLM） */
  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      const available = Object.keys(this.skills).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }

    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// =============================================================================
// 7. 子代理系统（s04）
// =============================================================================

/**
 * 子代理的工具列表（不含 task、todo、load_skill、compact）
 * 防止递归生成子代理或无权限操作父级功能。
 */
const CHILD_TOOLS: any[] = [
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
];

/** 子代理的工具调度表 */
const CHILD_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit ?? null),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
};

/** 子代理系统提示词 */
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

/**
 * 创建子代理并在独立上下文（新 messages 数组）中执行任务。
 * 子代理与父代理共享文件系统但不共享对话历史。
 * 最多执行 30 轮工具调用后强制返回。
 * 只返回最终文本结果，工具调用痕迹被丢弃。
 */
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Message[] = [{ role: "user", content: prompt }];

  let response: any;

  for (let i = 0; i < 30; i++) {
    response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages as any,
      tools: CHILD_TOOLS as any,
      max_tokens: 8000,
    });

    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = CHILD_HANDLERS[block.name];
        let output: string;
        try {
          output = await handler(block.input);
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }

        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, MAX_OUTPUT_LENGTH),
        });
      }
    }

    subMessages.push({ role: "user", content: results });
  }

  // 只返回最终文本，不暴露工具调用过程
  return (
    response.content
      .filter((b: any) => "text" in b)
      .map((b: any) => b.text)
      .join("") || "(no summary)"
  );
}

// =============================================================================
// 8. 对话压缩系统（s06）
// =============================================================================

/**
 * 估算消息列表的 token 数。
 * 粗略估算：~4 字符 ≈ 1 token。
 */
function estimateTokens(messages: any[]): number {
  return Math.floor(String(JSON.stringify(messages)).length / 4);
}

/**
 * Layer 1: 微压缩 —— 每轮调用，自动替换非最新的工具调用结果。
 * - 保留最近 KEEP_RECENT 条结果的完整内容
 * - 去除非最新且长度 > 100 字符的工具结果
 * - 保留 read_file 的结果（作为参考材料不压缩）
 * - 被压缩的结果替换为 "[Previous: used {tool_name}]"
 */
function microCompact(messages: any[]): void {
  // 收集所有 tool_result 条目的位置
  const toolResults: [number, number, any][] = [];

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
        const part = msg.content[partIndex];
        if (part && typeof part === "object" && part.type === "tool_result") {
          toolResults.push([msgIndex, partIndex, part]);
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  // 建立 tool_use_id → tool_name 映射
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          toolNameMap[block.id] = block.name;
        }
      }
    }
  }

  // 压缩旧结果（保留最近 KEEP_RECENT 条）
  const toClear = toolResults.slice(0, -KEEP_RECENT);

  for (const [, , result] of toClear) {
    if (typeof result.content !== "string" || result.content.length <= 100) continue;

    const toolId = result.tool_use_id || "";
    const toolName = toolNameMap[toolId] || "unknown";

    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;

    result.content = `[Previous: used ${toolName}]`;
  }
}

/**
 * Layer 2: 自动压缩 —— token 超出阈值时触发。
 * 步骤：
 *   1. 将完整对话保存到 .transcripts/ 目录（JSONL 格式）
 *   2. 用 LLM 总结对话（包含已完成、当前状态、关键决策）
 *   3. 用总结内容替换整个消息历史
 */
async function autoCompact(messages: any[]): Promise<any[]> {
  // 保存完整转录到磁盘
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
  fs.writeFileSync(transcriptPath, lines, "utf8");
  console.log(`[transcript saved: ${transcriptPath}]`);

  // 用 LLM 总结对话（截取最后 80000 字符）
  const conversationText = JSON.stringify(messages).slice(-80000);

  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.content
    ?.filter((b: any) => b && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("") || "No summary generated.";

  // 用压缩后的单条消息替换整个历史
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
  ];
}

// =============================================================================
// 9. 辅助函数
// =============================================================================

/**
 * 从 assistant 消息的 content 数组中提取纯文本。
 */
function extractText(content: any): string {
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * 查找历史中最后一条 assistant 消息。
 */
function findLastAssistantMessage(history: any[]): any | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") return history[i];
  }
  return null;
}

// =============================================================================
// 10. 主代理：工具定义与调度
// =============================================================================

// 一次性初始化全局组件
const todoManager = new TodoManager();
const skillLoader = new SkillLoader(SKILLS_DIR);

/**
 * 基础工具集（子代理也能看到）。
 * 包括：bash、read_file、write_file、edit_file
 */
const BASE_TOOLS: any[] = [
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
];

/**
 * 父代理工具集 = 基础工具 + 专属工具。
 * 专属工具：todo（任务管理）、task（子代理）、load_skill（技能加载）、compact（手动压缩）
 */
const PARENT_TOOLS: any[] = [
  ...BASE_TOOLS,
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description:
      "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to load",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "compact",
    description: "Trigger manual conversation compression to manage context window.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "What to preserve in the summary",
        },
      },
    },
  },
];

/**
 * 父代理工具调度表。
 * 所有工具处理函数根据 block.name 进行分发。
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit ?? null),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  todo: async ({ items }) => todoManager.update(items),
  task: async ({ prompt }) => {
    console.log(`> task: ${(prompt ?? "").slice(0, 80)}`);
    return runSubagent(prompt);
  },
  load_skill: async ({ name }) => skillLoader.getContent(name),
  compact: async () => "Manual compression requested.",
};

// =============================================================================
// 11. 系统提示词构建
// =============================================================================

/**
 * 构建系统提示词，包含：
 * - 工作目录信息
 * - 能力概述
 * - 任务管理流程说明
 * - 所有可用的技能元数据列表
 */
function buildSystemPrompt(): string {
  const skillDescriptions = skillLoader.getDescriptions();

  return `You are a coding agent working at ${WORKDIR}. You have access to a variety of tools.

CAPABILITIES:
- Run shell commands via bash
- Read, write, and edit files (path safety enforced)
- Track multi-step tasks with the todo tool (update progress as you work)
- Delegate subtasks to subagents via the task tool (they work independently with fresh context)
- Load specialized skill knowledge via load_skill
- Manually compress conversation context via compact

TASK MANAGEMENT:
For any task with more than one step:
1. First create or update a todo list using the todo tool.
2. Mark exactly one item as in_progress before doing work.
3. Use available tools to inspect files, edit code, and verify results.
4. After completing a step, update the todo list again.
5. Do not stop after creating a todo list if work remains.
6. Only respond with a final natural-language answer when no more tool use is needed.

SKILLS AVAILABLE:
${skillDescriptions}

Prefer tools over prose.`;
}

// =============================================================================
// 12. 主消息循环
// =============================================================================

/**
 * Agent 主循环，处理每一轮的用户查询。
 *
 * 每轮循环的执行流程：
 *   1. 微压缩（microCompact）—— 精简旧工具结果
 *   2. 检查是否触发自动压缩阈值
 *   3. 调用 LLM 获取响应
 *   4. 处理工具调用（分发到对应 handler）
 *   5. 注入 todo 提醒（如果超过 3 轮未更新）
 *   6. 处理手动压缩请求
 */
async function agentLoop(messages: any[]): Promise<void> {
  const systemPrompt = buildSystemPrompt();

  while (true) {
    // ----- Layer 1: 微压缩（每轮执行） -----
    microCompact(messages);

    // ----- Layer 2: 自动压缩（token 超出阈值时） -----
    if (estimateTokens(messages) > COMPACT_THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // ----- 调用 LLM -----
    const response = await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages: messages as any,
      tools: PARENT_TOOLS as any,
      max_tokens: 8000,
    });

    // 将 assistant 回复追加到历史
    messages.push({ role: "assistant", content: response.content });

    // 如果 LLM 没有要求使用工具，结束本轮
    if (response.stop_reason !== "tool_use") return;

    // ----- 处理工具调用结果 -----
    const results: any[] = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let output: string;

      try {
        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
        }
      } catch (e: any) {
        output = `Error: ${e.message}`;
      }

      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(output),
      });
    }

    // ----- Todo 提醒注入（s03） -----
    // 如果超过 3 轮未更新 todo，注入提醒促使用户/模型更新进度
    // 注：这里的提醒逻辑简化处理，实际可通过分析消息历史判断
    const hasTodoResult = results.some((r) => {
      // 反向查找对应的 tool_use 是否是 todo
      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "todo") {
          return true;
        }
      }
      return false;
    });

    // 将工具结果回写到消息历史
    messages.push({ role: "user", content: results });

    // ----- Layer 3: 手动压缩 -----
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return;
    }
  }
}

// =============================================================================
// 13. 主入口
// =============================================================================

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const history: any[] = [];

  console.log("╔════════════════════════════════════════════════╗");
  console.log("║   Mini-Claude-Code — Integrated Agent         ║");
  console.log("║   s01 基础框架 | s02 安全文件 | s03 任务管理  ║");
  console.log("║   s04 子代理   | s05 技能系统 | s06 对话压缩  ║");
  console.log("║                                                ║");
  console.log("║   Type 'q' or 'exit' to quit                  ║");
  console.log("╚════════════════════════════════════════════════╝");

  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36magent >> \x1b[0m");
    } catch {
      break; // Ctrl+D / EOF
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    // 添加用户消息到历史
    history.push({ role: "user", content: query });

    // 运行 Agent 循环
    await agentLoop(history);

    // 输出最终回复
    const lastAssistant = findLastAssistantMessage(history);
    const responseContent = lastAssistant?.content;

    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block && typeof block.text === "string") {
          console.log(block.text);
        }
      }
    } else if (typeof responseContent === "string") {
      console.log(responseContent);
    }

    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
