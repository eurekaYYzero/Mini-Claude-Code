/**
 * =============================================================================
 *  prompts/system-prompt.ts — 系统提示词构建
 * =============================================================================
 *
 * 根据 AgentContext 动态构建系统提示词，
 * 包含工作目录、能力概述、任务管理说明、技能列表、记忆等。
 * 设计为可扩展：新模块可以通过追加段落增强提示词。
 */

import type { AgentContext } from "../core/context.js";
import { MemoryManager } from "../features/memory/memory-manager.js";

/**
 * 构建系统提示词。
 *
 * - 包含工作目录信息、能力概述、任务管理流程说明
 * - 如果 ctx.skillLoader 存在，追加技能元数据列表
 * - 如果 ctx.todoManager 存在，追加任务管理相关指引
 * - 如果 ctx.memoryManager 存在，注入持久记忆和保存指引
 *
 * @param ctx - Agent 上下文
 * @returns 完整的系统提示词字符串
 */
export function buildSystemPrompt(ctx: AgentContext): string {
  const sections: string[] = [];

  // 基础角色描述
  sections.push(`You are a coding agent working at ${ctx.workDir}. You have access to a variety of tools.`);

  // 能力概述
  sections.push(`CAPABILITIES:
- Run shell commands via bash
- Read, write, and edit files (path safety enforced)
- Track multi-step tasks with the todo tool (update progress as you work)
- Delegate subtasks to subagents via the task tool (they work independently with fresh context)
- Load specialized skill knowledge via load_skill
- Manually compress conversation context via compact
- Save persistent memories via save_memory (survive across sessions)`);

  // 任务管理指引（如果 todoManager 存在）
  if (ctx.todoManager) {
    sections.push(`TASK MANAGEMENT:
For any task with more than one step:
1. First create or update a todo list using the todo tool.
2. Mark exactly one item as in_progress before doing work.
3. Use available tools to inspect files, edit code, and verify results.
4. After completing a step, update the todo list again.
5. Do not stop after creating a todo list if work remains.
6. Only respond with a final natural-language answer when no more tool use is needed.`);
  }

  // 技能列表（如果 skillLoader 存在）
  if (ctx.skillLoader) {
    const skillDescriptions = ctx.skillLoader.getDescriptions();
    sections.push(`SKILLS AVAILABLE:\n${skillDescriptions}`);
  }

  // 记忆注入（如果 memoryManager 存在）
  if (ctx.memoryManager) {
    const memoryPrompt = ctx.memoryManager.loadMemoryPrompt();
    if (memoryPrompt) {
      sections.push(memoryPrompt);
    }
    sections.push(MemoryManager.GUIDANCE);
  }

  // 结束指示
  sections.push("Prefer tools over prose.");

  return sections.join("\n\n");
}
