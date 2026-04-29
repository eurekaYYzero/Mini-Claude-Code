/**
 * =============================================================================
 *  features/hooks/hook-manager.ts — 钩子系统
 * =============================================================================
 *
 * 从 s08/index.ts 提取并重构的钩子管理系统。
 *
 * 钩子系统允许在工具调用前后执行外部命令：
 * - PreToolUse: 工具调用前执行，可阻止执行或修改输入
 * - PostToolUse: 工具调用后执行，可注入附加信息
 * - SessionStart: 会话启动时执行
 *
 * 退出码约定：
 * - 0: 正常通过（可选 JSON stdout 修改输入/注入上下文/覆盖权限）
 * - 1: 阻止工具执行（stderr 为阻止原因）
 * - 2: 注入消息（stderr 内容注入到对话）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  HookEvent,
  HookDefinition,
  HooksConfig,
  HookContext,
  HookRunResult,
} from "../../core/types.js";
import { HOOK_EVENTS, HOOK_TIMEOUT } from "../../core/types.js";

// =============================================================================
// HookManager 类
// =============================================================================

/**
 * 钩子管理器
 *
 * 从 hooks.json 配置文件加载钩子定义，
 * 在事件触发时执行对应的外部命令。
 */
export class HookManager {
  public hooks: Record<HookEvent, HookDefinition[]>;
  private _sdkMode: boolean;
  private _workDir: string;
  private _trustMarker: string;

  constructor(workDir?: string, configPath?: string, sdkMode = false) {
    const resolvedWorkDir = workDir ?? process.cwd();
    this._workDir = resolvedWorkDir;
    this._sdkMode = sdkMode;
    this._trustMarker = path.join(resolvedWorkDir, ".claude");

    this.hooks = {
      PreToolUse: [],
      PostToolUse: [],
      SessionStart: [],
    };

    const finalConfigPath = configPath ?? path.join(resolvedWorkDir, "hooks.json");
    this.loadConfig(finalConfigPath);
  }

  /**
   * 从配置文件加载钩子定义。
   *
   * @param configPath - hooks.json 配置文件路径
   */
  loadConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) return;

    try {
      const config = JSON.parse(
        fs.readFileSync(configPath, "utf8"),
      ) as HooksConfig;

      for (const event of HOOK_EVENTS) {
        this.hooks[event] = config.hooks?.[event] ?? [];
      }

      console.log(`[Hooks loaded from ${configPath}]`);
    } catch (e) {
      console.log(`[Hook config error: ${String(e)}]`);
    }
  }

  /**
   * 检查当前工作区是否受信任。
   * 教学版本使用简单的 .claude 信任标记文件。
   * SDK 模式下，信任视为隐式授予。
   */
  _checkWorkspaceTrust(): boolean {
    if (this._sdkMode) {
      return true;
    }
    return fs.existsSync(this._trustMarker);
  }

  /**
   * 执行指定事件的所有钩子。
   *
   * @param event - 钩子事件名
   * @param context - 钩子上下文（工具名、输入、输出等）
   * @returns 执行结果：blocked 表示是否被阻止，messages 为注入的消息列表
   */
  runHooks(event: HookEvent, context: HookContext | null = null): HookRunResult {
    const result: HookRunResult = {
      blocked: false,
      messages: [],
    };

    // 信任检查：不受信任的工作区不执行钩子
    if (!this._checkWorkspaceTrust()) {
      return result;
    }

    const hooks = this.hooks[event] ?? [];

    for (const hookDef of hooks) {
      // 检查 matcher（工具名过滤，用于 PreToolUse/PostToolUse）
      const matcher = hookDef.matcher;
      if (matcher && context) {
        const toolName = String(context.tool_name ?? "");
        if (matcher !== "*" && matcher !== toolName) {
          continue;
        }
      }

      const command = hookDef.command ?? "";
      if (!command) {
        continue;
      }

      // 构建环境变量，传递钩子上下文
      const env: NodeJS.ProcessEnv = { ...process.env };

      if (context) {
        env.HOOK_EVENT = event;
        env.HOOK_TOOL_NAME = String(context.tool_name ?? "");
        env.HOOK_TOOL_INPUT = JSON.stringify(
          context.tool_input ?? {},
          null,
          0,
        ).slice(0, 10000);

        if ("tool_output" in context) {
          env.HOOK_TOOL_OUTPUT = String(context.tool_output).slice(0, 10000);
        }
      }

      try {
        const r = spawnSync(command, {
          shell: true,
          cwd: this._workDir,
          env,
          encoding: "utf8",
          timeout: HOOK_TIMEOUT,
          maxBuffer: 1024 * 1024,
        });

        const stdout = (r.stdout ?? "").trim();
        const stderr = (r.stderr ?? "").trim();

        if (r.status === 0) {
          // 正常通过
          if (stdout) {
            console.log(`  [hook:${event}] ${stdout.slice(0, 100)}`);
          }

          // 可选的结构化 stdout 输出
          try {
            const hookOutput = JSON.parse(r.stdout ?? "") as {
              updatedInput?: Record<string, unknown>;
              additionalContext?: string;
              permissionDecision?: unknown;
            };

            if ("updatedInput" in hookOutput && context) {
              context.tool_input = hookOutput.updatedInput;
            }

            if ("additionalContext" in hookOutput && hookOutput.additionalContext) {
              result.messages.push(hookOutput.additionalContext);
            }

            if ("permissionDecision" in hookOutput) {
              result.permission_override = hookOutput.permissionDecision;
            }
          } catch {
            // stdout 不是 JSON — 简单钩子的正常情况
          }
        } else if (r.status === 1) {
          // 阻止执行
          result.blocked = true;
          const reason = stderr || "Blocked by hook";
          result.block_reason = reason;
          console.log(`  [hook:${event}] BLOCKED: ${reason.slice(0, 200)}`);
        } else if (r.status === 2) {
          // 注入消息
          const msg = stderr;
          if (msg) {
            result.messages.push(msg);
            console.log(`  [hook:${event}] INJECT: ${msg.slice(0, 200)}`);
          }
        } else if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          console.log(`  [hook:${event}] Timeout (${HOOK_TIMEOUT / 1000}s)`);
        } else if (r.error) {
          console.log(`  [hook:${event}] Error: ${String(r.error)}`);
        }
      } catch (e) {
        console.log(`  [hook:${event}] Error: ${String(e)}`);
      }
    }

    return result;
  }
}
