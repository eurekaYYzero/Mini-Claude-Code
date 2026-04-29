#!/usr/bin/env node
/**
 * Harness: resilience -- a robust agent recovers instead of crashing.
 *
 * s11_error_recovery.ts - Error Recovery
 * 本章教学核心：三层错误恢复机制
 *
 * 教学要点：
 * - 当输出被截断时继续生成（max_tokens 续文恢复）
 * - 当上下文过长时自动压缩（prompt_too_long 压缩重试）
 * - 当遇到临时错误时指数退避重试（连接/速率限制恢复）
 *
 * 恢复流程图：
 *   LLM 响应
 *        |
 *        v
 *   [检查 stop_reason]
 *        |
 *        +-- "max_tokens" ----> [策略1: max_output_tokens 续文恢复]
 *        |                       注入续接消息：
 *        |                       "Output limit hit. Continue directly."
 *        |                       最多重试 MAX_RECOVERY_ATTEMPTS (3) 次
 *        |                       计数器: maxOutputRecoveryCount
 *        |
 *        +-- API 错误 -------> [检查错误类型]
 *        |                       |
 *        |                       +-- prompt_too_long --> [策略2: 压缩 + 重试]
 *        |                       |   触发 autoCompact (LLM 摘要)
 *        |                       |   用摘要替换历史记录
 *        |                       |   重试当前轮
 *        |                       |
 *        |                       +-- 连接/速率限制 --> [策略3: 指数退避重试]
 *        |                           指数退避: base * 2^attempt + jitter
 *        |                           最多 3 次重试
 *        |
 *        +-- "end_turn" -----> [正常退出]
 *
 *   恢复优先级（先匹配者胜出）：
 *   1. max_tokens -> 注入续接消息，重试
 *   2. prompt_too_long -> 压缩上下文，重试
 *   3. 连接错误 -> 指数退避，重试
 *   4. 所有重试用尽 -> 优雅失败
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config({ override: true });

// 如果配置了自定义 base URL，移除可能冲突的 AUTH_TOKEN
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.MODEL_ID!;
if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

// ==================== 类型定义 ====================

/** 消息角色 */
type Role = "user" | "assistant";

/** 消息结构 */
interface Message {
  role: Role;
  content: unknown;
}

/** 工具使用块 */
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

/** 工具定义 */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** 工具处理函数类型 */
type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

// ==================== 恢复策略常量 ====================

/**
 * 最大恢复尝试次数
 * 每种恢复策略都最多尝试这么多次，避免无限循环
 */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * 指数退避基础延迟（秒）
 * 公式: delay = min(base * 2^attempt, maxDelay) + random_jitter
 * 第1次: ~1s, 第2次: ~2s, 第3次: ~4s
 */
const BACKOFF_BASE_DELAY = 1.0;

/**
 * 指数退避最大延迟（秒）
 * 防止延迟无限增长
 */
const BACKOFF_MAX_DELAY = 30.0;

/**
 * Token 阈值（字符数 / 4 ≈ token 数）
 * 超过此阈值时主动触发上下文压缩
 */
const TOKEN_THRESHOLD = 50000;

/**
 * 续文恢复注入的消息内容
 * 当 LLM 输出被截断时，注入此消息让 LLM 从断点继续
 */
const CONTINUATION_MESSAGE =
  "Output limit hit. Continue directly from where you stopped -- " +
  "no recap, no repetition. Pick up mid-sentence if needed.";

// ==================== 系统提示词 ====================

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

// ==================== 辅助函数 ====================

/**
 * 粗略估算 token 数量
 * 经验法则：约 4 个字符 ≈ 1 个 token
 * 这不是精确计算，但足以作为压缩触发的阈值判断
 */
function estimateTokens(messages: Message[]): number {
  return JSON.stringify(messages).length / 4;
}

/**
 * 自动压缩对话历史
 *
 * 原理：将整个对话历史发送给 LLM，让它生成一个简洁的摘要。
 * 然后用这个摘要替换原始历史，大幅减少 token 消耗。
 *
 * 这是策略2（prompt_too_long）的核心实现：
 * - 保留任务概述和成功标准
 * - 保留当前状态（已完成的工作、涉及的文件）
 * - 保留关键决策和失败尝试
 * - 保留剩余的下一步计划
 */
async function autoCompact(messages: Message[]): Promise<Message[]> {
  // 截取前 80000 字符避免压缩请求本身也太长
  const conversationText = JSON.stringify(messages).slice(0, 80000);

  const prompt =
    "Summarize this conversation for continuity. Include:\n" +
    "1) Task overview and success criteria\n" +
    "2) Current state: completed work, files touched\n" +
    "3) Key decisions and failed approaches\n" +
    "4) Remaining next steps\n" +
    "Be concise but preserve critical details.\n\n" +
    conversationText;

  let summary: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    });
    summary = (response.content[0] as { text: string }).text;
  } catch (e) {
    // 压缩本身失败时的降级处理
    summary = `(compact failed: ${(e as Error).message}). Previous context lost.`;
  }

  // 构建压缩后的续接消息
  const continuation =
    "This session continues from a previous conversation that was compacted. " +
    `Summary of prior context:\n\n${summary}\n\n` +
    "Continue from where we left off without re-asking the user.";

  return [{ role: "user", content: continuation }];
}

/**
 * 计算指数退避延迟
 *
 * 公式: delay = min(base * 2^attempt, maxDelay) + random_jitter
 *
 * 为什么需要 jitter（随机抖动）？
 * - 避免多个客户端同时重试造成"惊群效应"
 * - 分散重试请求，减轻服务器压力
 */
function backoffDelay(attempt: number): number {
  const delay = Math.min(BACKOFF_BASE_DELAY * Math.pow(2, attempt), BACKOFF_MAX_DELAY);
  const jitter = Math.random(); // 0~1 秒随机抖动
  return delay + jitter;
}

/**
 * 异步等待（替代 Python 的 time.sleep）
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 工具实现 ====================

/**
 * 安全路径解析
 * 确保所有文件操作都在工作目录内，防止路径逃逸攻击
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/** 执行 Shell 命令 */
async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      shell: "/bin/sh",
    });
    const out = `${stdout}${stderr}`.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e) {
    const err = e as {
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.trim();
    return out ? out.slice(0, 50000) : "Error: command failed";
  }
}

/** 读取文件内容 */
function runRead(filePath: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more)`]);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/** 写入文件 */
function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/** 编辑文件（精确文本替换） */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// ==================== 工具注册表 ====================

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (args) => runBash(String(args.command ?? "")),
  read_file: async (args) =>
    runRead(
      String(args.path ?? ""),
      typeof args.limit === "number" ? args.limit : undefined
    ),
  write_file: async (args) =>
    runWrite(String(args.path ?? ""), String(args.content ?? "")),
  edit_file: async (args) =>
    runEdit(
      String(args.path ?? ""),
      String(args.old_text ?? ""),
      String(args.new_text ?? "")
    ),
};

const TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

// ==================== 核心：三层错误恢复 Agent Loop ====================

/**
 * 带三层错误恢复的 Agent Loop
 *
 * 三层恢复策略：
 *
 * 【策略1】max_tokens 续文恢复
 *   - 触发条件：stop_reason === "max_tokens"
 *   - 处理方式：注入续接消息，让 LLM 从断点继续生成
 *   - 最大尝试：MAX_RECOVERY_ATTEMPTS 次
 *   - 原理：LLM 单次输出有 token 上限，但任务可能需要更长输出
 *
 * 【策略2】prompt_too_long 自动压缩
 *   - 触发条件：API 返回 prompt_too_long 错误（APIError）
 *   - 处理方式：调用 LLM 压缩上下文历史，用摘要替换原始对话
 *   - 原理：长对话会超出模型上下文窗口，压缩是保持对话延续性的关键
 *
 * 【策略3】连接/速率限制指数退避
 *   - 触发条件：429 (rate limit)、5xx (服务器错误)、网络超时等
 *   - 处理方式：指数退避重试 (base * 2^attempt + jitter)
 *   - 原理：临时错误通常会自行恢复，指数退避避免加重服务器负担
 */
async function agentLoop(messages: Message[]): Promise<void> {
  // max_tokens 续文恢复计数器
  let maxOutputRecoveryCount = 0;

  while (true) {
    // -- 尝试 API 调用，带连接重试 --
    let response: Anthropic.Message | null = null;

    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL,
          system: SYSTEM,
          messages: messages as any,
          tools: TOOLS as any,
          max_tokens: 8000,
        });
        break; // 成功，跳出重试循环
      } catch (e) {
        // 使用 SDK 的 APIError 类型进行错误分类
        if (e instanceof Anthropic.APIError) {
          const errorBody = String(e.message).toLowerCase();

          // 【策略2】prompt_too_long -> 压缩上下文并重试
          if (
            errorBody.includes("overlong_prompt") ||
            (errorBody.includes("prompt") && errorBody.includes("long"))
          ) {
            console.log(
              `[Recovery] Prompt too long. Compacting... (attempt ${attempt + 1})`
            );
            // 用压缩后的消息替换原始历史
            const compacted = await autoCompact(messages);
            messages.splice(0, messages.length, ...compacted);
            continue;
          }

          // 【策略3】其他 API 错误（429 速率限制、5xx 服务器错误等）-> 指数退避
          if (attempt < MAX_RECOVERY_ATTEMPTS) {
            const delay = backoffDelay(attempt);
            console.log(
              `[Recovery] API error: ${e.message}. ` +
                `Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`
            );
            await sleep(delay * 1000);
            continue;
          }

          // 所有重试用尽
          console.log(
            `[Error] API call failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${e.message}`
          );
          return;
        }

        // 网络级别错误（连接超时、DNS 失败等）-> 指数退避
        if (
          e instanceof TypeError || // fetch 网络错误
          (e as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
          (e as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
          (e as NodeJS.ErrnoException).code === "ENOTFOUND"
        ) {
          if (attempt < MAX_RECOVERY_ATTEMPTS) {
            const delay = backoffDelay(attempt);
            console.log(
              `[Recovery] Connection error: ${(e as Error).message}. ` +
                `Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`
            );
            await sleep(delay * 1000);
            continue;
          }
          console.log(
            `[Error] Connection failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${(e as Error).message}`
          );
          return;
        }

        // 未知错误，直接抛出
        throw e;
      }
    }

    // 所有重试后仍无响应
    if (response === null) {
      console.log("[Error] No response received.");
      return;
    }

    // 将助手响应添加到消息历史
    messages.push({ role: "assistant", content: response.content });

    // -- 【策略1】max_tokens 续文恢复 --
    if (response.stop_reason === "max_tokens") {
      maxOutputRecoveryCount += 1;

      if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
        console.log(
          `[Recovery] max_tokens hit ` +
            `(${maxOutputRecoveryCount}/${MAX_RECOVERY_ATTEMPTS}). ` +
            `Injecting continuation...`
        );
        // 注入续接消息，让 LLM 从断点继续
        messages.push({ role: "user", content: CONTINUATION_MESSAGE });
        continue; // 重新进入循环
      } else {
        console.log(
          `[Error] max_tokens recovery exhausted ` +
            `(${MAX_RECOVERY_ATTEMPTS} attempts). Stopping.`
        );
        return;
      }
    }

    // 成功的非 max_tokens 响应，重置计数器
    maxOutputRecoveryCount = 0;

    // -- 正常 end_turn：没有工具调用请求 --
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // -- 处理工具调用 --
    const results: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of response.content as any[]) {
      if ((block as ToolUseBlock).type !== "tool_use") continue;

      const toolBlock = block as ToolUseBlock;
      const handler = TOOL_HANDLERS[toolBlock.name];

      let output: string;
      try {
        output = handler
          ? await handler(toolBlock.input ?? {})
          : `Unknown: ${toolBlock.name}`;
      } catch (e) {
        output = `Error: ${(e as Error).message}`;
      }

      console.log(`> ${toolBlock.name}: ${String(output).slice(0, 200)}`);

      results.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: String(output),
      });
    }

    messages.push({ role: "user", content: results });

    // -- 主动压缩检查 --
    // 即使没有触发 prompt_too_long 错误，也在 token 估算超过阈值时主动压缩
    // 这是一种"预防性"恢复，比等到报错再压缩更优雅
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[Recovery] Token estimate exceeds threshold. Auto-compacting...");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  console.log(
    "[Error recovery enabled: max_tokens / prompt_too_long / connection backoff]"
  );

  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms11 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const query = line.trim();

    if (
      !query ||
      query.toLowerCase() === "q" ||
      query.toLowerCase() === "exit"
    ) {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });

    try {
      await agentLoop(history);

      // 打印最后一条助手消息中的文本内容
      const responseContent = history[history.length - 1]?.content;
      if (Array.isArray(responseContent)) {
        for (const block of responseContent as any[]) {
          if (
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof (block as { text: unknown }).text === "string"
          ) {
            console.log((block as { text: string }).text);
          }
        }
      }
      console.log();
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
