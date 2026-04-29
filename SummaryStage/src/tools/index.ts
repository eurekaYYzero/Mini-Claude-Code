/**
 * =============================================================================
 *  tools/index.ts — 基础工具注册
 * =============================================================================
 *
 * 将所有基础工具（bash、read_file、write_file、edit_file）注册到
 * AgentContext 的 ToolRegistry 中。
 */

import type { AgentContext } from "../core/context.js";

import { bashDefinition, bashHandler } from "./bash.js";
import { fileReadDefinition, fileReadHandler } from "./file-read.js";
import { fileWriteDefinition, fileWriteHandler } from "./file-write.js";
import { fileEditDefinition, fileEditHandler } from "./file-edit.js";

// 导出子模块，方便外部按需引用
export { createSafePath } from "./safe-path.js";
export { bashDefinition, bashHandler } from "./bash.js";
export { fileReadDefinition, fileReadHandler } from "./file-read.js";
export { fileWriteDefinition, fileWriteHandler } from "./file-write.js";
export { fileEditDefinition, fileEditHandler } from "./file-edit.js";
export { ToolRegistry } from "./registry.js";

/**
 * 注册基础工具集到 AgentContext 的 ToolRegistry。
 *
 * 基础工具包括：
 * - bash: 执行 shell 命令
 * - read_file: 读取文件内容
 * - write_file: 写入文件内容
 * - edit_file: 精确替换文件文本
 *
 * 每个工具的 handler 通过闭包绑定 ctx，使其在调用时可以访问上下文。
 *
 * @param ctx - Agent 上下文
 */
export function registerBaseTools(ctx: AgentContext): void {
  ctx.toolRegistry.register(
    bashDefinition.name,
    bashDefinition,
    (input) => bashHandler(input, ctx),
  );

  ctx.toolRegistry.register(
    fileReadDefinition.name,
    fileReadDefinition,
    (input) => fileReadHandler(input, ctx),
  );

  ctx.toolRegistry.register(
    fileWriteDefinition.name,
    fileWriteDefinition,
    (input) => fileWriteHandler(input, ctx),
  );

  ctx.toolRegistry.register(
    fileEditDefinition.name,
    fileEditDefinition,
    (input) => fileEditHandler(input, ctx),
  );
}
