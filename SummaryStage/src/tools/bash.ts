/**
 * =============================================================================
 *  tools/bash.ts — Bash 命令执行工具
 * =============================================================================
 *
 * 从 stage1.ts 提取的 shell 命令执行逻辑。
 * 支持超时控制和输出大小限制。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolHandler } from "../core/types.js";
import type { AgentContext } from "../core/context.js";
import { BASH_TIMEOUT } from "../core/types.js";

const execAsync = promisify(exec);

/**
 * bash 工具定义（Anthropic API 格式）
 */
export const bashDefinition: ToolDefinition = {
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

/**
 * bash 工具处理函数。
 * 执行 shell 命令并返回合并的 stdout + stderr 输出。
 * 支持 2 分钟超时，最大 10MB 输出缓冲。
 *
 * @param input - 工具输入，包含 command 字段
 * @param ctx - Agent 上下文
 * @returns 命令输出或错误信息
 */
export const bashHandler: ToolHandler = async (
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> => {
  const command = input.command as string;

  try {
    const result = await execAsync(command, {
      cwd: ctx.workDir,
      timeout: BASH_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = (result.stdout + result.stderr).trim();
    return output || "(no output)";
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
};
