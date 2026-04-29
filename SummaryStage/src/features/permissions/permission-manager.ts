/**
 * =============================================================================
 *  features/permissions/permission-manager.ts — 权限管理系统
 * =============================================================================
 *
 * 从 s07/index.ts 提取并重构的权限管理系统。
 *
 * 权限决策管道：
 *   0. basic bash safety check
 *   1. deny rules
 *   2. mode check
 *   3. allow rules
 *   4. ask user
 */

import readline from "node:readline/promises";
import type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionDecision,
} from "../../core/types.js";

// =============================================================================
// 常量
// =============================================================================

/** 只读工具集 */
export const READ_ONLY_TOOLS = new Set(["read_file"]);

/** 写入工具集 */
export const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

/** 安全工具集（无需权限检查，自动批准） */
export const SAFE_TOOLS = new Set(["read_file", "write_file", "edit_file", "todo"]);

/** 默认权限规则 */
export const DEFAULT_RULES: PermissionRule[] = [
  // deny: 危险 bash 命令
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "rm *", behavior: "deny" },
  { tool: "bash", content: "rmdir *", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  // allow: 文件操作工具
  { tool: "read_file", path: "*", behavior: "allow" },
  { tool: "write_file", path: "*", behavior: "allow" },
  { tool: "edit_file", path: "*", behavior: "allow" },
  // allow: 安全 bash 命令
  { tool: "bash", content: "ls *", behavior: "allow" },
  { tool: "bash", content: "pwd", behavior: "allow" },
  { tool: "bash", content: "echo *", behavior: "allow" },
  { tool: "bash", content: "cat *", behavior: "allow" },
  { tool: "bash", content: "mkdir *", behavior: "allow" },
  { tool: "bash", content: "node *", behavior: "allow" },
  { tool: "bash", content: "npm *", behavior: "allow" },
  { tool: "bash", content: "npx *", behavior: "allow" },
  { tool: "bash", content: "pnpm *", behavior: "allow" },
  { tool: "bash", content: "tsc *", behavior: "allow" },
  { tool: "bash", content: "tsc", behavior: "allow" },
  { tool: "bash", content: "which *", behavior: "allow" },
];

// =============================================================================
// 辅助函数
// =============================================================================

/** 将 glob 模式转为正则表达式 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
}

/** 检查值是否匹配 glob 模式 */
function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return globToRegExp(pattern).test(value);
}

/** 基础 bash 安全检查 */
function checkBasicBashSafety(command: string): PermissionDecision | null {
  const trimmed = command.trim();

  if (trimmed.includes("rm -rf /")) {
    return {
      behavior: "deny",
      reason: "Bash safety check: dangerous delete detected",
    };
  }

  if (trimmed.startsWith("sudo ") || trimmed.includes(" sudo ")) {
    return {
      behavior: "deny",
      reason: "Bash safety check: sudo is blocked",
    };
  }

  return null;
}

// =============================================================================
// PermissionManager 类
// =============================================================================

/**
 * 权限管理器
 *
 * 实现分层权限决策管道：
 * 1. Bash 安全检查（危险命令直接拒绝）
 * 2. Deny 规则匹配
 * 3. 模式检查（plan/auto/default）
 * 4. Allow 规则匹配
 * 5. 兜底：询问用户
 */
export class PermissionManager {
  mode: PermissionMode;
  rules: PermissionRule[];
  private rl: readline.Interface;

  constructor(
    mode: PermissionMode,
    rl: readline.Interface,
    rules?: PermissionRule[],
  ) {
    this.mode = mode;
    this.rl = rl;
    this.rules = rules ? [...rules] : [...DEFAULT_RULES];
  }

  /**
   * 权限决策管道入口。
   * 按顺序检查 bash 安全 → deny 规则 → 模式 → allow 规则 → 兜底 ask。
   */
  check(toolName: string, toolInput: any): PermissionDecision {
    const bashDecision = this.checkBash(toolName, toolInput);
    if (bashDecision) return bashDecision;

    const denyDecision = this.checkDenyRules(toolName, toolInput);
    if (denyDecision) return denyDecision;

    const modeDecision = this.checkMode(toolName);
    if (modeDecision) return modeDecision;

    const allowDecision = this.checkAllowRules(toolName, toolInput);
    if (allowDecision) return allowDecision;

    return {
      behavior: "ask",
      reason: `No rule matched for ${toolName}, asking user`,
    };
  }

  /** Layer 0: Bash 基础安全检查 */
  private checkBash(toolName: string, toolInput: any): PermissionDecision | null {
    if (toolName !== "bash") return null;
    const command = String(toolInput.command || "");
    return checkBasicBashSafety(command);
  }

  /** Layer 1: Deny 规则匹配 */
  private checkDenyRules(toolName: string, toolInput: any): PermissionDecision | null {
    for (const rule of this.rules) {
      if (rule.behavior !== "deny") continue;
      if (this.matchesRule(rule, toolName, toolInput)) {
        return {
          behavior: "deny",
          reason: `Blocked by deny rule: ${JSON.stringify(rule)}`,
        };
      }
    }
    return null;
  }

  /** Layer 2: 模式检查 */
  private checkMode(toolName: string): PermissionDecision | null {
    if (this.mode === "plan") {
      if (WRITE_TOOLS.has(toolName)) {
        return {
          behavior: "deny",
          reason: "Plan mode: write operations are blocked",
        };
      }
      return {
        behavior: "allow",
        reason: "Plan mode: read-only tools are allowed",
      };
    }

    if (this.mode === "auto") {
      if (SAFE_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)) {
        return {
          behavior: "allow",
          reason: "Auto mode: safe/read-only tool auto-approved",
        };
      }
    }

    if (this.mode === "default") {
      if (SAFE_TOOLS.has(toolName)) {
        return {
          behavior: "allow",
          reason: "Default mode: safe tool auto-approved",
        };
      }
    }

    return null;
  }

  /** Layer 3: Allow 规则匹配 */
  private checkAllowRules(toolName: string, toolInput: any): PermissionDecision | null {
    for (const rule of this.rules) {
      if (rule.behavior !== "allow") continue;
      if (this.matchesRule(rule, toolName, toolInput)) {
        return {
          behavior: "allow",
          reason: `Matched allow rule: ${JSON.stringify(rule)}`,
        };
      }
    }
    return null;
  }

  /** 检查规则是否匹配给定的工具调用 */
  matchesRule(rule: PermissionRule, toolName: string, toolInput: any): boolean {
    if (rule.tool !== "*" && rule.tool !== toolName) {
      return false;
    }

    if (rule.path && rule.path !== "*") {
      const value = String(toolInput.path || "");
      if (!matchesGlob(value, rule.path)) return false;
    }

    if (rule.content) {
      const value = String(toolInput.command || "");
      if (!matchesGlob(value, rule.content)) return false;
    }

    return true;
  }

  /** Layer 4: 询问用户是否允许工具调用 */
  async askUser(toolName: string, toolInput: any): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200);
    console.log(`\n  [Permission] ${toolName}: ${preview}`);

    try {
      const answer = (await this.rl.question("  Allow? (y/n): ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } catch {
      return false;
    }
  }

  /** 设置权限模式 */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** 获取当前权限模式 */
  getMode(): PermissionMode {
    return this.mode;
  }
}
