/**
 * =============================================================================
 *  features/compression/compression.ts — 对话压缩系统
 * =============================================================================
 *
 * 从 stage1.ts 提取的三级渐进压缩系统：
 *   - Layer 1: microCompact — 每轮调用，精简旧工具结果
 *   - Layer 2: autoCompact — token 超出阈值时触发 LLM 总结
 *   - Layer 3: 手动压缩 — 通过 compact 工具触发（复用 autoCompact）
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentContext } from "../../core/context.js";
import { DEFAULT_COMPACT_CONFIG } from "../../core/types.js";

// 压缩相关常量（从 DEFAULT_COMPACT_CONFIG 提取）
const COMPACT_THRESHOLD = DEFAULT_COMPACT_CONFIG.threshold;
const KEEP_RECENT = DEFAULT_COMPACT_CONFIG.keepRecent;
const PRESERVE_RESULT_TOOLS = DEFAULT_COMPACT_CONFIG.preserveResultTools;

/**
 * 估算消息列表的 token 数。
 * 粗略估算：~4 字符 ≈ 1 token。
 */
export function estimateTokens(messages: any[]): number {
  return Math.floor(String(JSON.stringify(messages)).length / 4);
}

/**
 * Layer 1: 微压缩 —— 每轮调用，自动替换非最新的工具调用结果。
 * - 保留最近 KEEP_RECENT 条结果的完整内容
 * - 去除非最新且长度 > 100 字符的工具结果
 * - 保留 read_file 的结果（作为参考材料不压缩）
 * - 被压缩的结果替换为 "[Previous: used {tool_name}]"
 */
export function microCompact(messages: any[]): void {
  // 收集所有 tool_result 条目的位置
  const toolResults: [number, number, any][] = [];

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
        const part = msg.content[partIndex];
        if (part && typeof part === "object" && part.type === "tool_result") {
          toolResults.push([msgIndex, partIndex, part]);
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  // 建立 tool_use_id → tool_name 映射
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          toolNameMap[block.id] = block.name;
        }
      }
    }
  }

  // 压缩旧结果（保留最近 KEEP_RECENT 条）
  const toClear = toolResults.slice(0, -KEEP_RECENT);

  for (const [, , result] of toClear) {
    if (typeof result.content !== "string" || result.content.length <= 100) continue;

    const toolId = result.tool_use_id || "";
    const toolName = toolNameMap[toolId] || "unknown";

    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;

    result.content = `[Previous: used ${toolName}]`;
  }
}

/**
 * Layer 2: 自动压缩 —— token 超出阈值时触发。
 * 步骤：
 *   1. 将完整对话保存到 .transcripts/ 目录（JSONL 格式）
 *   2. 用 LLM 总结较旧的对话（包含已完成的工作、当前状态、关键决策）
 *   3. 保留最近 keepRecent 条消息，只总结前面的部分
 *   4. 返回 [总结消息, ...保留的最近消息]
 *
 * @param ctx - Agent 上下文（需要 client、messages、workDir）
 */
export async function autoCompact(ctx: AgentContext): Promise<any[]> {
  const transcriptDir = path.resolve(ctx.workDir, ".transcripts");

  // 保存完整转录到磁盘
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(transcriptDir, `transcript_${timestamp}.jsonl`);

  const lines = ctx.messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
  fs.writeFileSync(transcriptPath, lines, "utf8");
  console.log(`[transcript saved: ${transcriptPath}]`);

  // 确定保留的最近消息数量（至少保留 2 条，确保有上下文）
  const keepCount = Math.max(KEEP_RECENT, 2);

  // 分割：需要总结的旧消息 vs 保留的最近消息
  const totalMessages = ctx.messages.length;
  const splitIndex = Math.max(0, totalMessages - keepCount);
  const messagesToSummarize = ctx.messages.slice(0, splitIndex);
  const recentMessages = ctx.messages.slice(splitIndex);

  // 如果没有需要总结的消息，直接返回保留的消息
  if (messagesToSummarize.length === 0) {
    return recentMessages;
  }

  // 用 LLM 总结较旧的对话（截取最后 80000 字符）
  const conversationText = JSON.stringify(messagesToSummarize).slice(-80000);

  const response = await ctx.client.messages.create({
    model: ctx.model,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished so far, 2) Current state and progress, " +
          "3) Key decisions made, 4) Important file paths and changes. " +
          "Be concise but preserve all critical details needed to continue work.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.content
    ?.filter((b: any) => b && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("") || "No summary generated.";

  // 构建压缩后的消息数组：总结 + 保留的最近消息
  const summaryMessage = {
    role: "user" as const,
    content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
  };

  // 确保消息交替满足 Anthropic API 要求：
  // 总结消息是 user role，如果 recentMessages 第一条也是 user，
  // 需要插入一条 assistant 过渡消息
  const result: any[] = [summaryMessage];

  if (recentMessages.length > 0 && recentMessages[0].role === "user") {
    result.push({
      role: "assistant" as const,
      content: [{ type: "text", text: "Understood. Continuing from where we left off." }],
    });
  }

  result.push(...recentMessages);
  return result;
}

/** 导出压缩阈值常量，供 agentLoop 使用 */
export { COMPACT_THRESHOLD };
