#!/usr/bin/env node
/**
 * Harness: persistent tasks -- goals that outlive any single conversation.
 *
 * s12_task_system.ts - Tasks
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task carries a small dependency graph:
 * - blockedBy: what must finish first
 * - blocks: what this task unlocks later
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key idea: task state survives compression because it lives on disk, not only
 * inside the conversation.
 * These are durable work-graph tasks, not transient runtime execution slots.
 *
 * Read this file in this order:
 * 1. TaskManager: what a TaskRecord looks like on disk.
 * 2. TOOL_HANDLERS / TOOLS: how task operations enter the same loop as normal tools.
 * 3. agentLoop: how persistent work state is exposed back to the model.
 *
 * Most common confusion:
 * - a task record is a durable work item
 * - it is not a thread, background slot, or worker process
 *
 * Teaching boundary:
 * this chapter teaches the durable work graph first.
 * Runtime execution slots and schedulers arrive later.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config({ override: true });

// 如果配置了自定义 base URL，移除可能冲突的 AUTH_TOKEN
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

// ==================== 类型定义 ====================

/** 消息角色 */
type Role = "user" | "assistant";

/** 消息结构 */
interface Message {
  role: Role;
  content: unknown;
}

/** 工具使用块 */
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

/** 工具定义 */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 工具处理函数类型 */
type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

/** 任务数据结构（磁盘持久化格式） */
interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

// ==================== 系统提示词 ====================

const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// ==================== TaskManager: 持久化任务图的 CRUD ====================

/**
 * TaskManager: 持久化任务存储
 * 把它理解为"磁盘上的工作图"，而不是"正在运行的 worker"
 */
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this._maxId() + 1;
  }

  /** 扫描已有任务文件，找到最大 ID */
  private _maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  /** 从磁盘加载单个任务 */
  private _load(taskId: number): Task {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Task;
  }

  /** 将任务保存到磁盘 */
  private _save(task: Task): void {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8");
  }

  /**
   * 当任务完成时，从所有其他任务的 blockedBy 列表中移除该任务
   * 这实现了依赖图的自动推进
   */
  private _clearDependency(completedId: number): void {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    for (const f of files) {
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Task;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this._save(task);
      }
    }
  }

  /** 创建新任务 */
  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this._save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  /** 获取单个任务详情 */
  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  /** 更新任务属性 */
  update(
    taskId: number,
    status?: string,
    owner?: string,
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this._load(taskId);

    if (owner !== undefined) {
      task.owner = owner;
    }

    if (status) {
      const validStatuses = ["pending", "in_progress", "completed", "deleted"];
      if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task["status"];

      // 当任务完成时，自动从其他任务的 blockedBy 中移除
      if (status === "completed") {
        this._clearDependency(taskId);
      }
    }

    if (addBlockedBy && addBlockedBy.length > 0) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks && addBlocks.length > 0) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];

      // 双向更新：同时更新被阻塞任务的 blockedBy 列表
      for (const blockedId of addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this._save(blocked);
          }
        } catch {
          // 目标任务不存在，忽略
        }
      }
    }

    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  /** 列出所有任务，格式化渲染 */
  listAll(): string {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    const tasks: Task[] = files
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Task);

    if (tasks.length === 0) {
      return "No tasks.";
    }

    const statusMarker: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
      deleted: "[-]",
    };

    const lines = tasks.map((t) => {
      const marker = statusMarker[t.status] ?? "[?]";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: [${t.blockedBy.join(",")}])` : "";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      return `${marker} #${t.id}: ${t.subject}${owner}${blocked}`;
    });

    return lines.join("\n");
  }
}

// 实例化任务管理器
const TASKS = new TaskManager(TASKS_DIR);

// ==================== 基础工具实现 ====================

/**
 * 安全路径解析
 * 确保所有文件操作都在工作目录内，防止路径逃逸攻击
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/** 执行 Shell 命令 */
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

/** 读取文件内容 */
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

/** 写入文件 */
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

/** 编辑文件（精确文本替换） */
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

// ==================== 工具注册表 ====================

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // 基础工具
  bash: async (args) => runBash(String(args.command ?? "")),
  read_file: (args) =>
    runRead(
      String(args.path ?? ""),
      typeof args.limit === "number" ? args.limit : undefined
    ),
  write_file: (args) =>
    runWrite(String(args.path ?? ""), String(args.content ?? "")),
  edit_file: (args) =>
    runEdit(
      String(args.path ?? ""),
      String(args.old_text ?? ""),
      String(args.new_text ?? "")
    ),

  // 任务管理工具
  task_create: (args) =>
    TASKS.create(String(args.subject ?? ""), String(args.description ?? "")),
  task_get: (args) =>
    TASKS.get(Number(args.task_id)),
  task_update: (args) =>
    TASKS.update(
      Number(args.task_id),
      args.status != null ? String(args.status) : undefined,
      args.owner != null ? String(args.owner) : undefined,
      args.addBlockedBy as number[] | undefined,
      args.addBlocks as number[] | undefined
    ),
  task_list: () => TASKS.listAll(),
};

const TOOLS: ToolDefinition[] = [
  // -- 基础工具 --
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
  // -- 任务管理工具 --
  {
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status, owner, or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        owner: {
          type: "string",
          description: "Set when a teammate claims the task",
        },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ==================== Agent Loop ====================

/**
 * agentLoop: 处理工具调用的主循环
 * 与 s11 类似的结构，但不包含错误恢复策略（本章聚焦任务管理）
 */
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    // 正常结束：没有工具调用请求
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 处理工具调用
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
          : `Unknown tool: ${toolBlock.name}`;
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

    messages.push({ role: "user", content: results });
  }
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  console.log("[Task management enabled: task_create / task_get / task_update / task_list]");

  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms12 >> \x1b[0m",
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

    history.push({ role: "user", content: query });

    try {
      await agentLoop(history);

      // 打印最后一条助手消息中的文本内容
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
