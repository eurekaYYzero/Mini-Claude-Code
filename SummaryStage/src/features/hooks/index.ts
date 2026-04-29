/**
 * =============================================================================
 *  features/hooks/index.ts — 钩子功能注册入口
 * =============================================================================
 *
 * 导出 HookManager 并提供注册函数。
 * Hooks 不注册自己的工具，而是在 agentLoop 中通过 ctx.hookManager 调用。
 */

import type { AgentContext } from "../../core/context.js";
import { HookManager } from "./hook-manager.js";

export { HookManager } from "./hook-manager.js";

/**
 * 注册钩子功能模块。
 * 创建 HookManager 实例并挂载到 ctx.hookManager。
 *
 * 注意：Hooks 不注册自己的工具，而是在 agentLoop 中
 * 通过 ctx.hookManager.runHooks() 触发钩子执行。
 *
 * @param ctx - Agent 上下文
 * @param configPath - hooks.json 配置文件路径（可选）
 */
export function registerHooksFeature(ctx: AgentContext, configPath?: string): void {
  ctx.hookManager = new HookManager(ctx.workDir, configPath);
}
