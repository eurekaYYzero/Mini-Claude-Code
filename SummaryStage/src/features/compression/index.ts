/**
 * =============================================================================
 *  features/compression/index.ts — 对话压缩系统模块
 * =============================================================================
 *
 * 导出压缩相关函数并实现功能注册。
 */

import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition } from "../../core/types.js";

export {
  estimateTokens,
  microCompact,
  autoCompact,
  COMPACT_THRESHOLD,
} from "./compression.js";

/** compact 工具定义（从 stage1.ts 提取） */
const compactToolDefinition: ToolDefinition = {
  name: "compact",
  description: "Trigger manual conversation compression to manage context window.",
  input_schema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description: "What to preserve in the summary",
      },
    },
  },
};

/**
 * 注册对话压缩功能模块。
 * 注册 compact 工具（手动压缩触发器）。
 *
 * @param ctx - Agent 上下文
 */
export function registerCompressionFeature(ctx: AgentContext): void {
  ctx.toolRegistry.register("compact", compactToolDefinition, async (_input: Record<string, unknown>, _ctx: AgentContext) => {
    return "Manual compression requested.";
  });
}
