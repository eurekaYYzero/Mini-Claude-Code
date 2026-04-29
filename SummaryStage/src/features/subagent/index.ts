/**
 * =============================================================================
 *  features/subagent/index.ts — 子代理功能注册入口
 * =============================================================================
 *
 * 导出 runSubagent 并注册 task 工具到父代理的 ToolRegistry。
 * task 工具允许 LLM 委派子任务到独立上下文的子代理。
 */

import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition, ToolHandler } from "../../core/types.js";
import { runSubagent } from "./subagent.js";

export { runSubagent } from "./subagent.js";

/** task 工具定义 */
const TASK_TOOL_DEFINITION: ToolDefinition = {
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
};

/** task 工具处理函数 */
const taskHandler: ToolHandler = async (input, ctx) => {
  const prompt = String(input.prompt ?? "");
  console.log(`> task: ${prompt.slice(0, 80)}`);
  return runSubagent(ctx, prompt);
};

/**
 * 注册子代理功能模块。
 * 向 ctx.toolRegistry 注册 task 工具（子代理委派工具）。
 *
 * @param ctx - Agent 上下文
 */
export function registerSubagentFeature(ctx: AgentContext): void {
  ctx.toolRegistry.register("task", TASK_TOOL_DEFINITION, taskHandler);
}
