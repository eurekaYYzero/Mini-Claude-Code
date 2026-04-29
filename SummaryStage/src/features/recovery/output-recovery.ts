/**
 * =============================================================================
 *  features/recovery/output-recovery.ts — 输出截断恢复管理
 * =============================================================================
 *
 * 处理 LLM 响应被 max_tokens 截断的场景，
 * 通过注入续接消息让模型继续输出。
 */

// =============================================================================
// 类型定义
// =============================================================================

/** 恢复状态 */
export interface RecoveryState {
  /** 当前已尝试的 max_tokens 恢复次数 */
  maxTokensRecoveryCount: number;
  /** 是否已尝试过因上下文溢出的反应式压缩 */
  hasAttemptedReactiveCompact: boolean;
}

/** 最大输出恢复尝试次数 */
export const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

/** 续接提示消息 */
const CONTINUATION_MESSAGE =
  "Your previous response was cut off due to output length limits. " +
  "Please continue exactly where you left off. Do not repeat any content that was already generated.";

// =============================================================================
// 状态管理函数
// =============================================================================

/**
 * 创建初始恢复状态。
 */
export function createRecoveryState(): RecoveryState {
  return {
    maxTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  };
}

/**
 * 检查响应是否被截断，返回是否应续接以及续接消息。
 *
 * @param response - LLM 响应对象
 * @param state - 当前恢复状态（会被修改）
 * @returns shouldContinue 为 true 时需要续接
 */
export function handleMaxTokensResponse(
  response: any,
  state: RecoveryState,
): { shouldContinue: boolean; continuationMessage?: string } {
  // 超过最大恢复次数，放弃续接
  if (state.maxTokensRecoveryCount >= MAX_OUTPUT_RECOVERY_ATTEMPTS) {
    console.log(
      `[Recovery] Max output recovery attempts (${MAX_OUTPUT_RECOVERY_ATTEMPTS}) reached. Treating as end_turn.`,
    );
    return { shouldContinue: false };
  }

  // 递增计数器
  state.maxTokensRecoveryCount++;

  console.log(
    `[Recovery] Output truncated (max_tokens). Recovery attempt ${state.maxTokensRecoveryCount}/${MAX_OUTPUT_RECOVERY_ATTEMPTS}.`,
  );

  return {
    shouldContinue: true,
    continuationMessage: CONTINUATION_MESSAGE,
  };
}

/**
 * 正常 end_turn 时重置恢复计数器。
 */
export function resetOutputRecovery(state: RecoveryState): void {
  state.maxTokensRecoveryCount = 0;
}
