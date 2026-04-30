/**
 * =============================================================================
 *  core/agent.ts — Agent 组装类
 * =============================================================================
 *
 * 负责将所有模块串联起来：
 * - 创建 AgentContext 并注册基础工具
 * - 提供 enableXxx() 方法按需启用功能模块
 * - 提供 run() 方法启动用户输入循环
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";

import { createAgentContext } from "./context.js";
import type { AgentContext } from "./context.js";
import { registerBaseTools } from "../tools/index.js";
import { registerTaskFeature } from "../features/task/index.js";
import { registerSkillsFeature } from "../features/skills/index.js";
import { registerSubagentFeature } from "../features/subagent/index.js";
import { registerCompressionFeature } from "../features/compression/index.js";
import { registerPermissionsFeature } from "../features/permissions/index.js";
import { registerHooksFeature } from "../features/hooks/index.js";
import { registerMemoryFeature } from "../features/memory/index.js";
import { agentLoop, findLastAssistantMessage } from "./agent-loop.js";
import { autoCompact } from "../features/compression/compression.js";
import type { PermissionMode } from "./types.js";

/** Agent 构造选项 */
interface AgentOptions {
  apiKey: string;
  model: string;
  workDir: string;
  baseURL?: string;
}

/**
 * Agent 组装类
 *
 * 内部流程：
 * - constructor 中调用 createAgentContext() + registerBaseTools() 初始化基础能力
 * - 每个 enableXxx() 方法调用对应的 registerXxxFeature()
 * - run() 方法实现 readline 用户输入循环
 */
export class Agent {
  private ctx: AgentContext;
  private rl: readline.Interface | null = null;

  constructor(options: AgentOptions) {
    this.ctx = createAgentContext({
      apiKey: options.apiKey,
      model: options.model,
      workDir: options.workDir,
      baseURL: options.baseURL,
    });

    // 注册基础工具（bash、read_file、write_file、edit_file）
    registerBaseTools(this.ctx);
  }

  /**
   * 启用 Task 任务管理功能。
   */
  enableTask(): void {
    registerTaskFeature(this.ctx);
  }

  /**
   * 启用技能加载功能。
   *
   * @param skillsDir - 技能文件目录路径
   */
  async enableSkills(skillsDir: string): Promise<void> {
    await registerSkillsFeature(this.ctx, skillsDir);
  }

  /**
   * 启用子代理功能。
   */
  enableSubagent(): void {
    registerSubagentFeature(this.ctx);
  }

  /**
   * 启用对话压缩功能。
   */
  enableCompression(): void {
    registerCompressionFeature(this.ctx);
  }

  /**
   * 启用权限管理功能。
   *
   * @param mode - 权限模式，默认 "default"
   */
  enablePermissions(mode?: string): void {
    // 确保 rl 已创建（permissions 需要用于交互）
    if (!this.rl) {
      this.rl = readline.createInterface({ input: stdin, output: stdout });
    }
    registerPermissionsFeature(this.ctx, mode, this.rl);
  }

  /**
   * 启用钩子功能。
   *
   * @param configPath - hooks.json 配置文件路径（可选，默认 workDir/hooks.json）
   */
  enableHooks(configPath?: string): void {
    registerHooksFeature(this.ctx, configPath);
  }

  /**
   * 启用持久记忆功能。
   * 加载已有记忆，注册 save_memory 工具。
   */
  enableMemory(): void {
    registerMemoryFeature(this.ctx);
  }

  /**
   * 获取 AgentContext（供外部访问）。
   */
  getContext(): AgentContext {
    return this.ctx;
  }

  /**
   * 启动 Agent REPL 循环。
   *
   * 流程：
   * 1. 创建 readline 接口
   * 2. 执行 SessionStart hooks（如果存在 hookManager）
   * 3. 循环接收用户输入 → 调用 agentLoop
   * 4. 支持 CLI 命令：q/exit、/compact、/mode、/rules、/memories
   */
  async run(): Promise<void> {
    // 创建 readline（如果尚未创建）
    if (!this.rl) {
      this.rl = readline.createInterface({ input: stdin, output: stdout });
    }

    console.log("╔════════════════════════════════════════════════╗");
    console.log("║   Mini-Claude-Code — Integrated Agent         ║");
    console.log("║   s01 基础框架 | s02 安全文件 | s03 任务管理  ║");
    console.log("║   s04 子代理   | s05 技能系统 | s06 对话压缩  ║");
    console.log("║   s09 记忆系统                                ║");
    console.log("║                                                ║");
    console.log("║   Type 'q' or 'exit' to quit                  ║");
    console.log("╚════════════════════════════════════════════════╝");

    // 执行 SessionStart hooks
    if (this.ctx.hookManager) {
      const sessionResult = this.ctx.hookManager.runHooks("SessionStart", null);
      for (const msg of sessionResult.messages) {
        console.log(`[SessionStart] ${msg}`);
      }
    }

    while (true) {
      let query: string;
      try {
        query = await this.rl.question("\x1b[36magent >> \x1b[0m");
      } catch {
        break; // Ctrl+D / EOF
      }

      const trimmed = (query ?? "").trim();

      // ----- CLI 命令处理 -----

      // 退出
      if (!trimmed || ["q", "exit"].includes(trimmed.toLowerCase())) {
        break;
      }

      // 手动压缩
      if (trimmed === "/compact") {
        if (this.ctx.messages.length > 0) {
          console.log("[manual compact]");
          const compacted = await autoCompact(this.ctx);
          this.ctx.messages.splice(0, this.ctx.messages.length, ...compacted);
          console.log("Conversation compressed.\n");
        } else {
          console.log("No messages to compress.\n");
        }
        continue;
      }

      // 权限模式切换
      if (trimmed.startsWith("/mode") && this.ctx.permissionManager) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const newMode = parts[1] as PermissionMode;
          if (["default", "plan", "auto"].includes(newMode)) {
            this.ctx.permissionManager.setMode(newMode);
            console.log(`Permission mode set to: ${newMode}\n`);
          } else {
            console.log(`Invalid mode. Available: default, plan, auto\n`);
          }
        } else {
          console.log(`Current mode: ${this.ctx.permissionManager.getMode()}\n`);
        }
        continue;
      }

      // 查看规则
      if (trimmed === "/rules" && this.ctx.permissionManager) {
        const rules = this.ctx.permissionManager.rules;
        if (rules.length === 0) {
          console.log("No permission rules configured.\n");
        } else {
          console.log("Permission rules:");
          for (const rule of rules) {
            console.log(`  ${JSON.stringify(rule)}`);
          }
          console.log();
        }
        continue;
      }

      // 查看记忆
      if (trimmed === "/memories" && this.ctx.memoryManager) {
        const memories = this.ctx.memoryManager.memories;
        if (Object.keys(memories).length === 0) {
          console.log("(no memories)\n");
        } else {
          for (const [name, mem] of Object.entries(memories) as any[]) {
            console.log(`  [${mem.type}] ${name}: ${mem.description}`);
          }
          console.log();
        }
        continue;
      }

      // ----- 正常用户输入 -----
      this.ctx.messages.push({ role: "user", content: query });

      // 运行 Agent 循环
      await agentLoop(this.ctx);

      // 输出最终回复
      const lastAssistant = findLastAssistantMessage(this.ctx.messages);
      const responseContent = lastAssistant?.content;

      if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
          if (block && typeof block.text === "string") {
            console.log(block.text);
          }
        }
      } else if (typeof responseContent === "string") {
        console.log(responseContent);
      }

      console.log();
    }

    this.rl.close();
  }
}
