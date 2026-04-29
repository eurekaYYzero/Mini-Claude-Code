/**
 * =============================================================================
 *  features/subagent/subagent.ts — 子代理系统
 * =============================================================================
 *
 * 从 stage1.ts 提取的完整子代理系统：
 * - CHILD_TOOLS: 子代理可用的工具定义（bash, read_file, write_file, edit_file）
 * - CHILD_HANDLERS: 子代理工具调度表
 * - runSubagent(): 在独立上下文中执行子任务
 *
 * 关键设计：
 * - 子代理使用独立的 messages 数组，不共享父代理对话历史
 * - 子代理共享 ctx.client 和 ctx.workDir
 * - 子代理工具集不通过 ToolRegistry 注册（内部使用）
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import type { AgentContext } from "../../core/context.js";
import type { Message, ToolHandler } from "../../core/types.js";
import { MAX_OUTPUT_LENGTH, BASH_TIMEOUT } from "../../core/types.js";

const execAsync = promisify(exec);

// =============================================================================
// 子代理内部工具实现
// =============================================================================

/** 安全路径校验（子代理共享 workDir） */
function safePath(workDir: string, p: string): string {
  const resolved = path.resolve(workDir, p);
  const workspace = path.resolve(workDir);
  const relative = path.relative(workspace, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return resolved;
}

async function runBash(command: string, workDir: string): Promise<string> {
  try {
    const result = await execAsync(command, {
      cwd: workDir,
      timeout: BASH_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = (result.stdout + result.stderr).trim();
    return output ? output.slice(0, MAX_OUTPUT_LENGTH) : "(no output)";
  } catch (e: any) {
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    return output ? output.slice(0, MAX_OUTPUT_LENGTH) : `Error: ${e.message}`;
  }
}

async function runRead(workDir: string, filePath: string, limit: number | null): Promise<string> {
  try {
    const text = await fs.readFile(safePath(workDir, filePath), "utf8");
    let lines = text.split(/\r?\n/);

    if (limit != null && limit > 0 && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
    }

    return lines.join("\n").slice(0, MAX_OUTPUT_LENGTH);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runWrite(workDir: string, filePath: string, content: string): Promise<string> {
  try {
    const fp = safePath(workDir, filePath);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runEdit(workDir: string, filePath: string, oldText: string, newText: string): Promise<string> {
  try {
    const fp = safePath(workDir, filePath);
    const content = await fs.readFile(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    await fs.writeFile(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// =============================================================================
// CHILD_TOOLS — 子代理可用的工具定义
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

// =============================================================================
// CHILD_HANDLERS — 子代理工具调度表
// =============================================================================

/** 创建子代理的工具调度表（绑定 workDir） */
function createChildHandlers(workDir: string): Record<string, (input: any) => Promise<string>> {
  return {
    bash: ({ command }: any) => runBash(command, workDir),
    read_file: ({ path: p, limit }: any) => runRead(workDir, p, limit ?? null),
    write_file: ({ path: p, content }: any) => runWrite(workDir, p, content),
    edit_file: ({ path: p, old_text, new_text }: any) => runEdit(workDir, p, old_text, new_text),
  };
}

// =============================================================================
// runSubagent — 核心子代理执行函数
// =============================================================================

/**
 * 创建子代理并在独立上下文（新 messages 数组）中执行任务。
 * 子代理与父代理共享文件系统但不共享对话历史。
 * 最多执行 maxTurns 轮工具调用后强制返回。
 * 只返回最终文本结果，工具调用痕迹被丢弃。
 *
 * @param ctx - Agent 上下文（使用 ctx.client, ctx.model, ctx.workDir）
 * @param taskDescription - 子任务描述/提示
 * @param maxTurns - 最大执行轮次，默认 30
 */
export async function runSubagent(
  ctx: AgentContext,
  taskDescription: string,
  maxTurns: number = 30,
): Promise<string> {
  const subMessages: Message[] = [{ role: "user", content: taskDescription }];
  const subSystem = `You are a coding subagent at ${ctx.workDir}. Complete the given task, then summarize your findings.`;
  const childHandlers = createChildHandlers(ctx.workDir);

  let response: any;

  for (let i = 0; i < maxTurns; i++) {
    response = await ctx.client.messages.create({
      model: ctx.model,
      system: subSystem,
      messages: subMessages as any,
      tools: CHILD_TOOLS as any,
      max_tokens: 8000,
    });

    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = childHandlers[block.name];
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
