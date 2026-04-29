/**
 * =============================================================================
 *  tools/registry.ts — ToolRegistry 工具注册表
 * =============================================================================
 *
 * 集中管理所有工具的定义和处理函数，支持动态注册/注销。
 * 供 Agent 循环在调用 LLM 时传入工具列表，并在收到工具调用时分发到对应 handler。
 */

import type { ToolDefinition, ToolHandler } from "../core/types.js";

/** 工具注册条目 */
interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * ToolRegistry — 工具注册表
 *
 * 功能：
 * - 注册工具（名称 + schema + handler）
 * - 注销工具
 * - 获取所有工具定义（传给 Anthropic API）
 * - 按名称查找 handler（用于分发工具调用）
 */
export class ToolRegistry {
  private tools: Map<string, ToolEntry> = new Map();

  /**
   * 注册一个工具。
   * 如果名称已存在，会覆盖旧的注册。
   *
   * @param name - 工具名称（唯一标识）
   * @param definition - 工具定义（包含 name, description, input_schema）
   * @param handler - 工具处理函数
   */
  register(name: string, definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(name, { definition, handler });
  }

  /**
   * 注销一个工具。
   *
   * @param name - 要注销的工具名称
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * 获取所有已注册工具的定义列表。
   * 用于传给 Anthropic API 的 tools 参数。
   *
   * @returns 工具定义数组
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((entry) => entry.definition);
  }

  /**
   * 根据名称获取工具的处理函数。
   *
   * @param name - 工具名称
   * @returns 处理函数，若不存在返回 undefined
   */
  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  /**
   * 检查工具是否已注册。
   *
   * @param name - 工具名称
   * @returns 是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有已注册工具的名称列表。
   *
   * @returns 工具名称数组
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
