/**
 * =============================================================================
 *  tools/file-read.ts — 文件读取工具
 * =============================================================================
 *
 * 从 stage1.ts 提取的文件读取逻辑。
 * 支持可选的行数限制，使用 safePath 进行路径校验。
 */

import fsPromises from "node:fs/promises";
import type { ToolDefinition, ToolHandler } from "../core/types.js";
import type { AgentContext } from "../core/context.js";
import { MAX_OUTPUT_LENGTH } from "../core/types.js";
import { createSafePath } from "./safe-path.js";

/**
 * read_file 工具定义（Anthropic API 格式）
 */
export const fileReadDefinition: ToolDefinition = {
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
};

/**
 * read_file 工具处理函数。
 * 读取文件内容，支持可选的行数限制。
 * 超过限制的行会被截断并显示剩余行数。
 *
 * @param input - 工具输入，包含 path 和可选的 limit 字段
 * @param ctx - Agent 上下文
 * @returns 文件内容或错误信息
 */
export const fileReadHandler: ToolHandler = async (
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> => {
  const filePath = input.path as string;
  const limit = (input.limit as number | undefined) ?? null;
  const safePath = createSafePath(ctx.workDir);

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
};
