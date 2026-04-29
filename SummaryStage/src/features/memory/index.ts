/**
 * =============================================================================
 *  features/memory/index.ts — Memory 持久记忆模块
 * =============================================================================
 *
 * 导出 MemoryManager 并实现功能注册。
 * 注册 save_memory 工具到 ToolRegistry，让 Agent 可以保存跨会话记忆。
 */

import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition } from "../../core/types.js";
import { MemoryManager, MEMORY_TYPES } from "./memory-manager.js";

export { MemoryManager, MEMORY_TYPES } from "./memory-manager.js";
export type { MemoryRecord, MemoryType } from "./memory-manager.js";

/** save_memory 工具定义 */
const saveMemoryDefinition: ToolDefinition = {
  name: "save_memory",
  description: "Save a persistent memory that survives across sessions.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short identifier (e.g. prefer_tabs, db_schema)",
      },
      description: {
        type: "string",
        description: "One-line summary of what this memory captures",
      },
      type: {
        type: "string",
        enum: ["user", "feedback", "project", "reference"],
        description:
          "user=preferences, feedback=corrections, project=non-obvious project conventions or decision reasons, reference=external resource pointers",
      },
      content: {
        type: "string",
        description: "Full memory content (multi-line OK)",
      },
    },
    required: ["name", "description", "type", "content"],
  },
};

/**
 * 注册 Memory 功能模块。
 *
 * 1. 创建 MemoryManager 并加载已有记忆
 * 2. 挂载到 ctx.memoryManager
 * 3. 注册 save_memory 工具
 *
 * @param ctx     - Agent 上下文
 * @param workDir - 工作目录（.memory/ 的父目录），默认 ctx.workDir
 */
export function registerMemoryFeature(ctx: AgentContext, workDir?: string): void {
  const dir = workDir ?? ctx.workDir;
  const memoryManager = new MemoryManager(`${dir}/.memory`);
  memoryManager.loadAll();

  ctx.memoryManager = memoryManager;

  ctx.toolRegistry.register(
    "save_memory",
    saveMemoryDefinition,
    async (input: Record<string, unknown>, _ctx: AgentContext) => {
      return memoryManager.saveMemory(
        String(input.name ?? ""),
        String(input.description ?? ""),
        String(input.type ?? ""),
        String(input.content ?? ""),
      );
    },
  );
}
