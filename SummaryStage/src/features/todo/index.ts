/**
 * =============================================================================
 *  features/todo/index.ts — Todo 任务管理模块
 * =============================================================================
 *
 * 导出 TodoManager 并实现功能注册。
 */

import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition } from "../../core/types.js";
import { TodoManager } from "./todo-manager.js";

export { TodoManager } from "./todo-manager.js";

/** todo 工具定义（从 stage1.ts 提取） */
const todoToolDefinition: ToolDefinition = {
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
};

/**
 * 注册 Todo 功能模块。
 * 将 TodoManager 实例挂载到 ctx.todoManager，并注册 todo 工具。
 *
 * @param ctx - Agent 上下文
 */
export function registerTodoFeature(ctx: AgentContext): void {
  const todoManager = new TodoManager();
  ctx.todoManager = todoManager;

  ctx.toolRegistry.register("todo", todoToolDefinition, async (input: Record<string, unknown>, _ctx: AgentContext) => {
    return todoManager.update(input.items as any[]);
  });
}
