/**
 * =============================================================================
 *  tools/file-edit.ts — 文件编辑工具
 * =============================================================================
 *
 * 从 stage1.ts 提取的文件编辑逻辑。
 * 精确匹配并替换文本，使用 safePath 进行路径校验。
 */

import fsPromises from "node:fs/promises";
import type { ToolDefinition, ToolHandler } from "../core/types.js";
import type { AgentContext } from "../core/context.js";
import { createSafePath } from "./safe-path.js";

/**
 * edit_file 工具定义（Anthropic API 格式）
 */
export const fileEditDefinition: ToolDefinition = {
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
};

/**
 * edit_file 工具处理函数。
 * 编辑文件：精确匹配并替换文本。
 * 要求 oldText 在文件中存在，否则返回错误。
 *
 * @param input - 工具输入，包含 path、old_text、new_text 字段
 * @param ctx - Agent 上下文
 * @returns 编辑结果或错误信息
 */
export const fileEditHandler: ToolHandler = async (
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> => {
  const filePath = input.path as string;
  const oldText = input.old_text as string;
  const newText = input.new_text as string;
  const safePath = createSafePath(ctx.workDir);

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
};
