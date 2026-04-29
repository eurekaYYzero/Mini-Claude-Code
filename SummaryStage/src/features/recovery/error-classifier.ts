/**
 * =============================================================================
 *  features/recovery/error-classifier.ts — 错误分类器
 * =============================================================================
 *
 * 基于 HTTP 状态码和 SDK 异常类型对 API 错误进行分类，
 * 决定后续的恢复策略（重试 / 压缩 / 终止）。
 */

import Anthropic from "@anthropic-ai/sdk";

// =============================================================================
// 类型定义
// =============================================================================

/** 错误分类枚举 */
export type ErrorCategory = "retryable" | "context_overflow" | "fatal" | "unknown";

/** 分类后的错误对象 */
export interface ClassifiedError {
  category: ErrorCategory;
  /** 从 Retry-After 头提取的等待时间（毫秒） */
  retryAfterMs?: number;
  originalError: Error;
  statusCode?: number;
  message: string;
}

// =============================================================================
// 网络错误关键字
// =============================================================================

const NETWORK_ERROR_KEYWORDS = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "fetch failed",
  "network",
  "socket hang up",
];

// =============================================================================
// 分类函数
// =============================================================================

/**
 * 对错误进行分类，返回 ClassifiedError。
 *
 * 分类逻辑：
 * - retryable: 429, 503, 529, 408, 504, 网络错误
 * - context_overflow: 413, 或消息包含 prompt_too_long / overlong_prompt
 * - fatal: 401, 400, 404, 403
 * - unknown: 其他
 */
export function classifyError(error: unknown): ClassifiedError {
  // 处理 Anthropic APIError
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const message = error.message || String(error);
    const retryAfterMs = extractRetryAfter(error);

    // 上下文溢出
    if (
      status === 413 ||
      message.includes("prompt_too_long") ||
      message.includes("overlong_prompt")
    ) {
      return {
        category: "context_overflow",
        originalError: error,
        statusCode: status,
        message,
        retryAfterMs,
      };
    }

    // 可重试错误
    if ([429, 503, 529, 408, 504].includes(status)) {
      return {
        category: "retryable",
        originalError: error,
        statusCode: status,
        message,
        retryAfterMs,
      };
    }

    // 致命错误
    if ([401, 400, 404, 403].includes(status)) {
      return {
        category: "fatal",
        originalError: error,
        statusCode: status,
        message,
      };
    }

    // 未知 API 错误
    return {
      category: "unknown",
      originalError: error,
      statusCode: status,
      message,
      retryAfterMs,
    };
  }

  // 处理非 APIError（网络错误等）
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message || String(err);

  // 检查是否为网络相关错误
  const isNetworkError = NETWORK_ERROR_KEYWORDS.some((keyword) =>
    message.toLowerCase().includes(keyword.toLowerCase())
  );

  if (isNetworkError) {
    return {
      category: "retryable",
      originalError: err,
      message,
    };
  }

  // 检查消息中是否包含上下文溢出关键字
  if (message.includes("prompt_too_long") || message.includes("overlong_prompt")) {
    return {
      category: "context_overflow",
      originalError: err,
      message,
    };
  }

  return {
    category: "unknown",
    originalError: err,
    message,
  };
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 从 APIError 的 headers 中提取 Retry-After 值（转换为毫秒）。
 */
function extractRetryAfter(error: InstanceType<typeof Anthropic.APIError>): number | undefined {
  try {
    const headers = (error as any).headers;
    if (!headers) return undefined;

    // 尝试获取 retry-after header
    const retryAfter =
      headers?.["retry-after"] ??
      headers?.get?.("retry-after") ??
      undefined;

    if (!retryAfter) return undefined;

    const value = Number(retryAfter);
    if (!isNaN(value) && value > 0) {
      // Retry-After 通常为秒，转换为毫秒
      return value * 1000;
    }
  } catch {
    // 静默忽略解析错误
  }
  return undefined;
}
