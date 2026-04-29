/**
 * =============================================================================
 *  core/agent-loop.ts — Agent 主消息循环
 * =============================================================================
 *
 * 从 stage1.ts 提取并重构的核心循环逻辑。
 * 基于 AgentContext 和 ToolRegistry，通过可选检查支持功能模块的动态接入。
 *
 * 每轮循环的执行流程：
 *   1. 压缩管道（微压缩 + 自动压缩）
 *   2. 调用 LLM 获取响应
 *   3. 助手消息回写
 *   4. 工具执行管道（hooks → permissions → handler）
 *   5. Todo 提醒注入
 *   6. 结果回写
 *   7. 手动压缩处理
 */

import type { AgentContext } from "./context.js";
import type { PermissionDecision } from "./types.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import {
  estimateTokens,
  microCompact,
  autoCompact,
  COMPACT_THRESHOLD,
} from "../features/compression/compression.js";
import { withApiRetry, classifyError } from "../features/recovery/index.js";
import {
  createRecoveryState,
  handleMaxTokensResponse,
  resetOutputRecovery,
} from "../features/recovery/index.js";

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 从 assistant 消息的 content 数组中提取纯文本。
 */
export function extractText(content: any): string {
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * 查找历史中最后一条 assistant 消息。
 */
export function findLastAssistantMessage(history: any[]): any | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") return history[i];
  }
  return null;
}

// =============================================================================
// 主消息循环
// =============================================================================

/**
 * Agent 主消息循环。
 *
 * 通过 `if (ctx.hookManager)` / `if (ctx.permissionManager)` 等可选检查
 * 来决定是否执行某个管道阶段，新增模块不需要修改此函数。
 *
 * @param ctx - Agent 上下文
 */
export async function agentLoop(ctx: AgentContext): Promise<void> {
  const systemPrompt = buildSystemPrompt(ctx);

  // 错误恢复状态
  const recoveryState = createRecoveryState();

  // 压缩冷却：记录上次自动压缩的时间，防止短时间内重复压缩
  let lastCompactTime = 0;
  const COMPACT_COOLDOWN_MS = 10_000; // 至少 10 秒间隔

  while (true) {
    // ===== 1. 压缩管道 =====

    // Layer 1: 微压缩（每轮执行）
    microCompact(ctx.messages);

    // Layer 2: 自动压缩（token 超出阈值时，需满足冷却时间）
    const currentTokens = estimateTokens(ctx.messages);
    const now = Date.now();
    const cooldownElapsed = now - lastCompactTime >= COMPACT_COOLDOWN_MS;

    if (currentTokens > COMPACT_THRESHOLD && cooldownElapsed) {
      console.log(`[auto_compact triggered] messages: ${ctx.messages.length}, tokens: ~${currentTokens}`);
      const compacted = await autoCompact(ctx);
      ctx.messages.splice(0, ctx.messages.length, ...compacted);
      lastCompactTime = Date.now();
      const newTokens = estimateTokens(ctx.messages);
      console.log(`[auto_compact done] messages: ${ctx.messages.length}, tokens: ~${newTokens}`);
    } else if (currentTokens > COMPACT_THRESHOLD && !cooldownElapsed) {
      console.log(`[auto_compact skipped] cooldown not elapsed (${Math.round((COMPACT_COOLDOWN_MS - (now - lastCompactTime)) / 1000)}s remaining)`);
    }

    // ===== 2. 调用 LLM（带重试和错误恢复） =====
    let response;
    try {
      response = await withApiRetry(() =>
        ctx.client.messages.create({
          model: ctx.model,
          system: systemPrompt,
          messages: ctx.messages as any,
          tools: ctx.toolRegistry.getDefinitions() as any,
          max_tokens: 8000,
        }),
      );
    } catch (error: any) {
      // 检查是否为上下文溢出
      const classified = classifyError(error);
      if (classified.category === "context_overflow" && !recoveryState.hasAttemptedReactiveCompact) {
        console.log("[Recovery] Context overflow detected, triggering reactive compact...");
        recoveryState.hasAttemptedReactiveCompact = true;
        // 触发已有的 autoCompact
        const compacted = await autoCompact(ctx);
        ctx.messages.splice(0, ctx.messages.length, ...compacted);
        lastCompactTime = Date.now();
        continue; // 压缩后重试
      }
      // 其他错误直接抛出
      throw error;
    }

    // ===== 3. 检查输出是否被截断 =====
    if (response.stop_reason === "max_tokens") {
      const recovery = handleMaxTokensResponse(response, recoveryState);
      if (recovery.shouldContinue && recovery.continuationMessage) {
        // 保存被截断的助手消息
        ctx.messages.push({ role: "assistant", content: response.content });
        // 注入续接请求
        ctx.messages.push({ role: "user", content: recovery.continuationMessage });
        continue; // 继续循环，让 LLM 续写
      }
      // 超过最大恢复次数，当作正常 end_turn 处理
    }

    // ===== 4. 助手消息回写 =====
    ctx.messages.push({ role: "assistant", content: response.content });

    // ===== 5. 如果没有工具调用，结束本轮 =====
    if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") {
      resetOutputRecovery(recoveryState);
      return;
    }

    // ===== 6. 工具执行管道 =====
    const results: any[] = [];
    let manualCompact = false;
    let hasTodoCall = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const toolName = block.name;
      const toolInput = block.input as Record<string, unknown>;
      let output: string;
      let hookMessages: string[] = [];

      try {
        // ----- 5a. PreToolUse hooks -----
        if (ctx.hookManager) {
          const hookResult = ctx.hookManager.runHooks("PreToolUse", {
            tool_name: toolName,
            tool_input: toolInput,
          });

          if (hookResult.blocked) {
            output = `Tool use blocked: ${hookResult.block_reason ?? "Blocked by hook"}`;
            console.log(`> ${toolName}: ${output}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
            continue;
          }

          // 收集 hook 消息
          hookMessages = hookResult.messages || [];

          // ----- 5b. Permission check (hooks 可覆盖) -----
          let decision: PermissionDecision | null = null;
          if (hookResult.permission_override) {
            decision = hookResult.permission_override as PermissionDecision;
          } else if (ctx.permissionManager) {
            decision = ctx.permissionManager.check(toolName, toolInput);
          }

          if (decision) {
            if (decision.behavior === "deny") {
              output = `Permission denied: ${decision.reason}`;
              console.log(`> ${toolName}: ${output}`);
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
              });
              continue;
            }

            if (decision.behavior === "ask" && ctx.permissionManager) {
              const allowed = await ctx.permissionManager.askUser(toolName, toolInput);
              if (!allowed) {
                output = "Permission denied by user.";
                console.log(`> ${toolName}: ${output}`);
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: output,
                });
                continue;
              }
            }
          }
        } else if (ctx.permissionManager) {
          // 无 hookManager 时，直接走 permissionManager
          const decision = ctx.permissionManager.check(toolName, toolInput);

          if (decision.behavior === "deny") {
            output = `Permission denied: ${decision.reason}`;
            console.log(`> ${toolName}: ${output}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
            continue;
          }

          if (decision.behavior === "ask") {
            const allowed = await ctx.permissionManager.askUser(toolName, toolInput);
            if (!allowed) {
              output = "Permission denied by user.";
              console.log(`> ${toolName}: ${output}`);
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
              });
              continue;
            }
          }
        }

        // ----- 5c. 特殊处理 compact 工具 -----
        if (toolName === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          // ----- 5d. 通过 ToolRegistry 执行 handler -----
          const handler = ctx.toolRegistry.getHandler(toolName);
          if (handler) {
            output = await handler(toolInput, ctx);
          } else {
            output = `Unknown tool: ${toolName}`;
          }
        }

        // 标记 todo 工具调用
        if (toolName === "todo") {
          hasTodoCall = true;
        }
      } catch (e: any) {
        output = `Error: ${e.message}`;
        // 工具执行错误标记（Anthropic API 支持 is_error）
      }

      console.log(`> ${toolName}: ${String(output).slice(0, 200)}`);

      // ----- 5e. PostToolUse hooks -----
      if (ctx.hookManager) {
        const postHookResult = ctx.hookManager.runHooks("PostToolUse", {
          tool_name: toolName,
          tool_input: toolInput,
          tool_output: output,
        });
        if (postHookResult.messages && postHookResult.messages.length > 0) {
          output += "\n" + postHookResult.messages.join("\n");
        }
      }

      // 将 PreToolUse hook 消息追加到工具结果输出
      if (hookMessages.length > 0) {
        output = hookMessages.join("\n") + "\n" + output;
      }

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(output),
      });
    }

    // ===== 7. Todo 提醒注入 =====
    // 如果有 todoManager 且本轮有 todo 工具调用，可在此注入提醒
    // （保持与原 stage1.ts 逻辑一致：预留扩展点）

    // ===== 8. 结果回写 =====
    ctx.messages.push({ role: "user", content: results });

    // ===== 9. 手动压缩处理 =====
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(ctx);
      ctx.messages.splice(0, ctx.messages.length, ...compacted);
      return;
    }
  }
}
