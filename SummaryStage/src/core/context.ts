/**
 * =============================================================================
 *  core/context.ts — AgentContext 接口和创建函数
 * =============================================================================
 *
 * AgentContext 是整个 Agent 系统的核心上下文对象，
 * 所有模块（工具、功能、钩子等）通过它共享状态。
 */

import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "../tools/registry.js";
import type { Message } from "./types.js";

/**
 * Agent 上下文接口
 *
 * 设计原则：
 * - 核心字段为必选（client, model, workDir, messages, toolRegistry）
 * - 功能模块引用为可选，由各模块注册时赋值
 * - 支持通过索引签名扩展自定义字段
 */
export interface AgentContext {
  /** Anthropic SDK 客户端 */
  client: Anthropic;
  /** 使用的模型 ID */
  model: string;
  /** 工作目录（所有文件操作的根目录） */
  workDir: string;
  /** 对话消息历史 */
  messages: Message[];
  /** 工具注册表 */
  toolRegistry: ToolRegistry;

  // ----- 可选功能模块引用（后续模块注册时赋值） -----
  /** 任务管理器 */
  taskManager?: import("../features/task/task-manager.js").TaskManager;
  /** 技能加载器 */
  skillLoader?: any;       // 后续由 SkillLoader 类型替换
  /** 钩子管理器 */
  hookManager?: any;       // 后续由 HookManager 类型替换
  /** 权限管理器 */
  permissionManager?: any; // 后续由 PermissionManager 类型替换
  /** 记忆管理器 */
  memoryManager?: any;     // 后续由 MemoryManager 类型替换

  /** 可扩展字段 */
  [key: string]: any;
}

/** createAgentContext 的选项参数 */
export interface CreateAgentContextOptions {
  apiKey: string;
  model: string;
  workDir: string;
  baseURL?: string;
}

/**
 * 创建并初始化 AgentContext。
 *
 * @param options - 初始化选项
 * @returns 完整的 AgentContext 实例
 */
export function createAgentContext(options: CreateAgentContextOptions): AgentContext {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  const toolRegistry = new ToolRegistry();

  return {
    client,
    model: options.model,
    workDir: options.workDir,
    messages: [],
    toolRegistry,
  };
}
