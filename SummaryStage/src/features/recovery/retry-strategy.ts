/**
 * =============================================================================
 *  features/recovery/retry-strategy.ts — 基于 p-retry 的重试策略
 * =============================================================================
 *
 * 对 API 调用进行智能重试，支持指数退避 + Full Jitter。
 * 仅对 retryable 类型的错误进行重试，fatal 和 context_overflow 立即终止。
 */

import pRetry, { AbortError } from "p-retry";
import { classifyError } from "./error-classifier.js";

// =============================================================================
// 类型定义
// =============================================================================

/** 重试配置 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 最小等待时间（毫秒） */
  minTimeout: number;
  /** 最大等待时间（毫秒） */
  maxTimeout: number;
  /** 退避因子 */
  factor: number;
  /** 是否启用随机抖动（Full Jitter） */
  randomize: boolean;
}

/** 默认 API 重试配置 */
export const DEFAULT_API_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  minTimeout: 1000,
  maxTimeout: 30000,
  factor: 2,
  randomize: true,
};

// =============================================================================
// 重试包装函数
// =============================================================================

/**
 * 对异步函数进行带错误分类的智能重试。
 *
 * - retryable 错误：按指数退避重试
 * - fatal / context_overflow 错误：立即终止（抛出 AbortError）
 * - 支持 Retry-After 头部等待
 *
 * @param fn - 要执行的异步函数
 * @param config - 可选的重试配置（覆盖默认值）
 */
export async function withApiRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const mergedConfig = { ...DEFAULT_API_RETRY_CONFIG, ...config };

  return pRetry(fn, {
    retries: mergedConfig.maxRetries,
    minTimeout: mergedConfig.minTimeout,
    maxTimeout: mergedConfig.maxTimeout,
    factor: mergedConfig.factor,
    randomize: mergedConfig.randomize,

    onFailedAttempt: async (error) => {
      const classified = classifyError(error);

      // fatal 错误立即终止
      if (classified.category === "fatal") {
        console.log(
          `[Recovery] Fatal error (${classified.statusCode}): ${classified.message}. Aborting.`,
        );
        throw new AbortError(classified.message);
      }

      // 上下文溢出不通过重试解决，需要压缩
      if (classified.category === "context_overflow") {
        console.log(
          `[Recovery] Context overflow detected (${classified.statusCode}): ${classified.message}. Aborting retry.`,
        );
        throw new AbortError(classified.message);
      }

      // 只有 retryable 和 unknown 才允许重试
      const attemptsLeft = error.retriesLeft;
      console.log(
        `[Recovery] Retryable error (${classified.statusCode ?? "network"}): ${classified.message}. ` +
        `Attempts remaining: ${attemptsLeft}`,
      );

      // 如果有 Retry-After 头，先等待指定时间
      if (classified.retryAfterMs && classified.retryAfterMs > 0) {
        const waitMs = Math.min(classified.retryAfterMs, mergedConfig.maxTimeout);
        console.log(`[Recovery] Respecting Retry-After: waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    },
  });
}
