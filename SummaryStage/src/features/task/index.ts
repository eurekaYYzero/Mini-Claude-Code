/**
 * =============================================================================
 *  features/task/index.ts — Task 任务管理模块
 * =============================================================================
 *
 * 导出 TaskManager 并实现功能注册，提供 task_create / task_get / task_update / task_list 四个工具。
 */

import * as path from "path";
import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition } from "../../core/types.js";
import { TaskManager } from "./task-manager.js";

export { TaskManager } from "./task-manager.js";

// =============================================================================
// 工具定义
// =============================================================================

const taskCreateDef: ToolDefinition = {
  name: "task_create",
  description: "Create a new task. Returns the created task as JSON.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Brief task title" },
      description: { type: "string", description: "Detailed task description" },
      blockedBy: {
        type: "array",
        items: { type: "number" },
        description: "IDs of tasks that block this one",
      },
    },
    required: ["subject", "description"],
  },
};

const taskGetDef: ToolDefinition = {
  name: "task_get",
  description: "Get details of a specific task by ID.",
  input_schema: {
    type: "object",
    properties: {
      taskId: { type: "number", description: "The task ID to retrieve" },
    },
    required: ["taskId"],
  },
};

const taskUpdateDef: ToolDefinition = {
  name: "task_update",
  description:
    "Update a task's status, dependencies, or metadata. When a task is completed, dependent tasks are automatically unblocked.",
  input_schema: {
    type: "object",
    properties: {
      taskId: { type: "number", description: "The task ID to update" },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "failed"],
      },
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: {
        type: "string",
        description: "Present continuous form shown while in progress",
      },
      owner: { type: "string" },
      metadata: { type: "object" },
      addBlockedBy: {
        type: "array",
        items: { type: "number" },
        description: "Task IDs to add as blockers",
      },
      addBlocks: {
        type: "array",
        items: { type: "number" },
        description: "Task IDs that this task blocks",
      },
    },
    required: ["taskId"],
  },
};

const taskListDef: ToolDefinition = {
  name: "task_list",
  description: "List all tasks with status summary. Shows blocked/ready status.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

// =============================================================================
// 注册函数
// =============================================================================

/**
 * 注册 Task 功能模块。
 * 将 TaskManager 实例挂载到 ctx，并注册 4 个 task 工具。
 *
 * @param ctx - Agent 上下文
 */
export function registerTaskFeature(ctx: AgentContext): void {
  const tasksDir = path.join(process.cwd(), ".tasks");
  const manager = new TaskManager(tasksDir);

  // 挂载到上下文
  ctx.taskManager = manager;

  // ---- task_create ----
  ctx.toolRegistry.register("task_create", taskCreateDef, async (input: Record<string, unknown>, _ctx: AgentContext) => {
    const task = manager.create({
      subject: input.subject as string,
      description: input.description as string,
      blockedBy: input.blockedBy as number[] | undefined,
    });
    return JSON.stringify(task, null, 2);
  });

  // ---- task_get ----
  ctx.toolRegistry.register("task_get", taskGetDef, async (input: Record<string, unknown>, _ctx: AgentContext) => {
    const task = manager.get(input.taskId as number);
    if (!task) {
      return `Task #${input.taskId} not found.`;
    }
    return JSON.stringify(task, null, 2);
  });

  // ---- task_update ----
  ctx.toolRegistry.register("task_update", taskUpdateDef, async (input: Record<string, unknown>, _ctx: AgentContext) => {
    const taskId = input.taskId as number;
    const task = manager.update(taskId, {
      taskId,
      status: input.status as any,
      subject: input.subject as string | undefined,
      description: input.description as string | undefined,
      activeForm: input.activeForm as string | undefined,
      owner: input.owner as string | undefined,
      metadata: input.metadata as Record<string, any> | undefined,
      addBlockedBy: input.addBlockedBy as number[] | undefined,
      addBlocks: input.addBlocks as number[] | undefined,
    });
    return JSON.stringify(task, null, 2);
  });

  // ---- task_list ----
  ctx.toolRegistry.register("task_list", taskListDef, async (_input: Record<string, unknown>, _ctx: AgentContext) => {
    const rendered = manager.render();
    const stats = manager.getStats();
    return `${rendered}\n\nStats: ${JSON.stringify(stats)}`;
  });
}
