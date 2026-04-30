/**
 * =============================================================================
 *  prompts/system-prompt.ts — 系统提示词构建
 * =============================================================================
 *
 * 根据 AgentContext 动态构建系统提示词，
 * 包含工作目录、能力概述、任务管理说明、技能列表、记忆等。
 * 设计为可扩展：新模块可以通过追加段落增强提示词。
 *
 * 架构说明（静态/动态分离）：
 *   本文件的段落分为两类——
 *   ① 静态段落：核心指令、能力概述、任务管理指引、技能列表、记忆、CLAUDE.md
 *      这些段落在同一个会话内基本不变，未来可用于 prompt caching 以节省 token。
 *   ② 动态段落：运行时上下文（日期、平台、模型）
 *      每次构建都会重新生成，放在提示词尾部。
 *   当前实现中两类段落连续拼接；若未来需要开启 Anthropic prompt caching，
 *   只需在 ① 和 ② 之间设置 cache_control 断点即可。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentContext } from "../core/context.js";
import { MemoryManager } from "../features/memory/memory-manager.js";

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 链式加载 CLAUDE.md 配置文件。
 * 按优先级依次检查三个位置，将所有找到的内容合并返回：
 *   1. ~/.claude/CLAUDE.md        （用户全局配置）
 *   2. <projectRoot>/CLAUDE.md    （项目级别配置）
 *   3. <workDir>/CLAUDE.md        （目录级别，仅当 workDir !== projectRoot 时）
 *
 * @param workDir - 当前工作目录（同时作为 projectRoot）
 * @returns 合并后的 CLAUDE.md 段落，若未找到任何文件则返回空字符串
 */
export function loadClaudeMdChain(workDir: string): string {
  const sources: Array<{ label: string; content: string }> = [];

  // 1. 用户全局 ~/.claude/CLAUDE.md
  const userClaudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (fs.existsSync(userClaudeMd)) {
    sources.push({
      label: "user global (~/.claude/CLAUDE.md)",
      content: fs.readFileSync(userClaudeMd, "utf8").trim(),
    });
  }

  // 2. 项目根目录 CLAUDE.md
  const projectClaudeMd = path.join(workDir, "CLAUDE.md");
  if (fs.existsSync(projectClaudeMd)) {
    sources.push({
      label: "project root (CLAUDE.md)",
      content: fs.readFileSync(projectClaudeMd, "utf8").trim(),
    });
  }

  // 3. 当前工作子目录 CLAUDE.md（仅当 cwd 不同于 workDir 时检查）
  const cwd = process.cwd();
  if (cwd !== path.resolve(workDir)) {
    const subdirClaudeMd = path.join(cwd, "CLAUDE.md");
    if (fs.existsSync(subdirClaudeMd)) {
      sources.push({
        label: `subdir (${path.basename(cwd)}/CLAUDE.md)`,
        content: fs.readFileSync(subdirClaudeMd, "utf8").trim(),
      });
    }
  }

  if (sources.length === 0) return "";

  const parts = ["# CLAUDE.md instructions"];
  for (const { label, content } of sources) {
    parts.push(`## From ${label}`);
    parts.push(content);
  }
  return parts.join("\n\n");
}

/**
 * 从 ToolRegistry 动态生成工具列表文档。
 * 格式: `- toolName(param1, param2): description`
 *
 * @param ctx - Agent 上下文
 * @returns 工具列表段落，若无工具则返回空字符串
 */
function buildToolListing(ctx: AgentContext): string {
  const definitions = ctx.toolRegistry.getDefinitions();
  if (definitions.length === 0) return "";

  const lines = ["# Available tools"];
  for (const tool of definitions) {
    const params = Object.keys(tool.input_schema.properties ?? {}).join(", ");
    lines.push(`- ${tool.name}(${params}): ${tool.description}`);
  }
  return lines.join("\n");
}

/**
 * 构建动态运行时上下文段落。
 *
 * @param ctx - Agent 上下文
 * @returns 动态上下文字符串
 */
function buildDynamicContext(ctx: AgentContext): string {
  const lines = [
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    `Working directory: ${ctx.workDir}`,
    `Platform: ${process.platform}`,
  ];

  // 模型名称（AgentContext 已有 model 字段）
  if (ctx.model) {
    lines.push(`Model: ${ctx.model}`);
  }

  return "# Dynamic context\n" + lines.join("\n");
}

// =============================================================================
// 主构建函数
// =============================================================================

/**
 * 构建系统提示词。
 *
 * - 包含工作目录信息、能力概述、任务管理流程说明
 * - 如果 ctx.toolRegistry 中有注册工具，追加详细工具列表
 * - 如果 ctx.skillLoader 存在，追加技能元数据列表
 * - 如果 ctx.memoryManager 存在，注入持久记忆和保存指引
 * - 如果存在 CLAUDE.md 配置文件，注入链式加载的指令
 * - 尾部附加动态运行时上下文（日期、平台、模型）
 *
 * @param ctx - Agent 上下文
 * @returns 完整的系统提示词字符串
 */
export function buildSystemPrompt(ctx: AgentContext): string {
  const sections: string[] = [];

  // =========================================================================
  // ① 静态段落 —— 会话内基本不变，可用于 prompt caching
  // =========================================================================

  // 基础角色描述
  sections.push(
    `You are a coding agent working at ${ctx.workDir}. You have access to a variety of tools.`,
  );

  // 能力概述
  sections.push(`CAPABILITIES:
- Run shell commands via bash
- Read, write, and edit files (path safety enforced)
- Track multi-step tasks with task management tools (task_create, task_get, task_update, task_list)
- Delegate subtasks to subagents via the task tool (they work independently with fresh context)
- Load specialized skill knowledge via load_skill
- Manually compress conversation context via compact
- Save persistent memories via save_memory (survive across sessions)`);

  // 工具列表（从 ToolRegistry 动态生成）
  const toolListing = buildToolListing(ctx);
  if (toolListing) {
    sections.push(toolListing);
  }

  // 任务管理指引（如果 taskManager 存在）
  if (ctx.taskManager) {
    sections.push(`## Task Management

You have access to task management tools for tracking multi-step work:

- **task_create**: Create a new task with subject and description. Optionally specify blockedBy to set dependencies.
- **task_get**: Get full details of a specific task by ID.
- **task_update**: Update task status, add dependencies, or modify metadata. When you complete a task, dependent tasks are automatically unblocked.
- **task_list**: List all tasks with their current status and dependency info.

### Workflow
1. Break complex work into tasks using task_create
2. Set dependencies with blockedBy to establish execution order
3. Mark tasks as in_progress before starting work
4. Mark tasks as completed when done (blocked tasks auto-unblock)
5. Use task_list to check progress and find ready tasks

### Status Values
- pending: Not yet started
- in_progress: Currently being worked on
- completed: Successfully finished
- failed: Could not be completed`);

    // 动态注入当前任务状态
    const stats = ctx.taskManager.getStats();
    if (stats.total > 0) {
      sections.push(`\n## Current Task Status\n${ctx.taskManager.render()}`);
    }
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

  // CLAUDE.md 链式加载（条件化：仅当找到文件时才追加）
  const claudeMd = loadClaudeMdChain(ctx.workDir);
  if (claudeMd) {
    sections.push(claudeMd);
  }

  // =========================================================================
  // ② 动态段落 —— 每次构建都会重新生成
  //    未来启用 prompt caching 时，在此处设置 cache_control 断点
  // =========================================================================

  sections.push(buildDynamicContext(ctx));

  // 结束指示
  sections.push("Prefer tools over prose.");

  return sections.join("\n\n");
}
