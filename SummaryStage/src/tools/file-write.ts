/**
 * =============================================================================
 *  tools/file-write.ts — 文件写入工具
 * =============================================================================
 *
 * 从 stage1.ts 提取的文件写入逻辑。
 * 自动创建父目录，使用 safePath 进行路径校验。
 */

import path from "node:path";
import fsPromises from "node:fs/promises";
import type { ToolDefinition, ToolHandler } from "../core/types.js";
import type { AgentContext } from "../core/context.js";
import { createSafePath } from "./safe-path.js";

/**
 * write_file 工具定义（Anthropic API 格式）
 */
export const fileWriteDefinition: ToolDefinition = {
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
};

/**
 * write_file 工具处理函数。
 * 写入文件内容，自动创建父目录。
 *
 * @param input - 工具输入，包含 path 和 content 字段
 * @param ctx - Agent 上下文
 * @returns 写入结果或错误信息
 */
export const fileWriteHandler: ToolHandler = async (
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> => {
  const filePath = input.path as string;
  const content = input.content as string;
  const safePath = createSafePath(ctx.workDir);

  try {
    const fp = safePath(filePath);
    await fsPromises.mkdir(path.dirname(fp), { recursive: true });
    await fsPromises.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
};
