/**
 * =============================================================================
 *  features/permissions/index.ts — 权限管理功能注册入口
 * =============================================================================
 *
 * 导出 PermissionManager 并提供注册函数。
 * 权限系统不注册自己的工具，而是作为中间件嵌入到 agentLoop 的工具执行管道中。
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentContext } from "../../core/context.js";
import type { PermissionMode } from "../../core/types.js";
import { PermissionManager } from "./permission-manager.js";

export { PermissionManager } from "./permission-manager.js";
export {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  SAFE_TOOLS,
  DEFAULT_RULES,
} from "./permission-manager.js";

/**
 * 注册权限管理功能模块。
 * 创建 PermissionManager 实例并挂载到 ctx.permissionManager。
 *
 * 注意：权限系统不注册自己的工具，而是在 agentLoop 中
 * 通过 ctx.permissionManager.check() 进行权限决策。
 *
 * @param ctx - Agent 上下文
 * @param mode - 权限模式，默认 "default"
 * @param rl - readline 接口（可选，用于用户交互确认）
 */
export function registerPermissionsFeature(
  ctx: AgentContext,
  mode?: string,
  rl?: readline.Interface,
): void {
  const permMode = (mode ?? "default") as PermissionMode;

  // 如果未提供 rl，创建一个默认的
  const rlInterface = rl ?? readline.createInterface({ input: stdin, output: stdout });

  ctx.permissionManager = new PermissionManager(permMode, rlInterface);
}
