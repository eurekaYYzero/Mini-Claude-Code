/**
 * =============================================================================
 *  core/types.ts — 所有共享类型定义
 * =============================================================================
 *
 * 从 stage1.ts 提取并增强的类型，供所有模块共享使用。
 */


// Re-export AgentContext from context.ts (single source of truth)
import type { AgentContext } from "./context.js";
export type { AgentContext };

// =============================================================================
// 基础消息类型
// =============================================================================

/** Anthropic SDK 消息格式 */
export interface Message {
  role: "user" | "assistant";
  content: any;
}

// =============================================================================
// Todo 相关类型
// =============================================================================

/** 任务状态 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单个待办项 */
export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

// =============================================================================
// 技能系统相关类型
// =============================================================================

/** 技能元数据（来自 YAML Frontmatter） */
export interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
  [key: string]: any;
}

/** 技能条目（完整技能数据） */
export interface SkillEntry {
  meta: SkillMeta;
  body: string;
  path: string;
}

// =============================================================================
// 工具系统相关类型
// =============================================================================

/** 工具输入 schema 定义 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
}

/** 工具定义（Anthropic API 格式） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

/** 工具处理函数签名 */
export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: AgentContext,
) => Promise<string>;

// =============================================================================
// 钩子系统相关类型
// =============================================================================

/** 钩子事件名称（与 Claude Code 一致） */
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/** 钩子超时（毫秒） */
export const HOOK_TIMEOUT = 30_000;

/** 钩子上下文 */
export interface HookContext {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  [key: string]: unknown;
}

/** 钩子执行结果 */
export interface HookRunResult {
  blocked: boolean;
  messages: string[];
  block_reason?: string;
  permission_override?: unknown;
}

/** 单个钩子定义 */
export interface HookDefinition {
  matcher?: string;
  command?: string;
  [key: string]: unknown;
}

/** 钩子配置文件格式 */
export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
}

// =============================================================================
// 权限系统相关类型
// =============================================================================

/** 权限模式 */
export type PermissionMode = "default" | "plan" | "auto";

/** 权限行为 */
export type PermissionBehavior = "allow" | "deny" | "ask";

/** 权限规则 */
export interface PermissionRule {
  tool: string;
  behavior: "allow" | "deny";
  path?: string;
  content?: string;
}

/** 权限决策 */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
}

// =============================================================================
// 压缩系统相关类型
// =============================================================================

/** 压缩配置 */
export interface CompactConfig {
  /** token 阈值，超过触发自动压缩 */
  threshold: number;
  /** 保留最近 N 条工具结果原文 */
  keepRecent: number;
  /** 保留这些工具的结果不压缩 */
  preserveResultTools: Set<string>;
}

// =============================================================================
// 子代理相关类型
// =============================================================================

/** 子代理配置 */
export interface SubagentConfig {
  /** 最大执行轮次 */
  maxTurns: number;
  /** 单次输出最大长度 */
  maxOutputLength: number;
}

// =============================================================================
// 常量配置
// =============================================================================

/** 默认 bash 超时（毫秒） */
export const BASH_TIMEOUT = 120_000;

/** 单次工具结果最大长度 */
export const MAX_OUTPUT_LENGTH = 50_000;

/** 默认压缩配置 */
export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  threshold: 50000,
  keepRecent: 3,
  preserveResultTools: new Set(["read_file", "bash"]),
};

/** 默认子代理配置 */
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  maxTurns: 30,
  maxOutputLength: MAX_OUTPUT_LENGTH,
};
