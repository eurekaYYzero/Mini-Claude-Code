#!/usr/bin/env node
// Teaching version: a simple permission pipeline for tool use.
// Pipeline:
//   0. basic bash safety check
//   1. deny rules
//   2. mode check
//   3. allow rules
//   4. ask user

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.`;

// ---------- Types ----------

type Message = {
  role: "user" | "assistant";
  content: any;
};

type PermissionMode = "default" | "plan" | "auto";
type PermissionBehavior = "allow" | "deny" | "ask";

type PermissionDecision = {
  behavior: PermissionBehavior;
  reason: string;
};

type PermissionRule = {
  tool: string;
  behavior: "allow" | "deny";
  path?: string;
  content?: string;
};

type ToolHandler = (input: any) => Promise<string>;

// ---------- Constants ----------

const MODES: PermissionMode[] = ["default", "plan", "auto"];

const READ_ONLY_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  { tool: "read_file", path: "*", behavior: "allow" },
];

// ---------- Helpers ----------

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
}

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return globToRegExp(pattern).test(value);
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];

  for (const block of content) {
    if (block?.text) texts.push(block.text);
  }

  return texts.join("\n").trim();
}

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const workspace = path.resolve(WORKDIR);
  const relative = path.relative(workspace, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return resolved;
}

// ---------- Basic Bash Safety Check ----------

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

// ---------- Permission Manager ----------

class PermissionManager {
  mode: PermissionMode;
  rules: PermissionRule[];
  rl: readline.Interface;

  constructor(mode: PermissionMode, rl: readline.Interface, rules?: PermissionRule[]) {
    this.mode = mode;
    this.rl = rl;
    this.rules = rules ? [...rules] : [...DEFAULT_RULES];
  }

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

  private checkBash(toolName: string, toolInput: any): PermissionDecision | null {
    if (toolName !== "bash") return null;
    const command = String(toolInput.command || "");
    return checkBasicBashSafety(command);
  }

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
      if (READ_ONLY_TOOLS.has(toolName)) {
        return {
          behavior: "allow",
          reason: "Auto mode: read-only tool auto-approved",
        };
      }
    }

    return null;
  }

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

  private matchesRule(rule: PermissionRule, toolName: string, toolInput: any): boolean {
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
}

// ---------- Tool Implementations ----------

async function runRead(filePath: string, limit?: number): Promise<string> {
  try {
    const text = await fs.readFile(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);

    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more)`);
    }

    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runWrite(filePath: string, content: string): Promise<string> {
  try {
    const fp = safePath(filePath);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
  try {
    const fp = safePath(filePath);
    const content = await fs.readFile(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    await fs.writeFile(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runBash(command: string): Promise<string> {
  try {
    const result = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    });

    const output = (result.stdout + result.stderr).trim();
    return output ? output.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    return output ? output.slice(0, 50000) : `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
};

const TOOLS = [
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

// ---------- Tool Execution ----------

async function executeToolCall(block: any, perms: PermissionManager) {
  const toolName = block.name;
  const toolInput = block.input || {};
  const decision = perms.check(toolName, toolInput);

  let output: string;

  if (decision.behavior === "deny") {
    output = `Permission denied: ${decision.reason}`;
    console.log(`  [DENIED] ${toolName}: ${decision.reason}`);
  } else if (decision.behavior === "ask") {
    const approved = await perms.askUser(toolName, toolInput);
    if (approved) {
      const handler = TOOL_HANDLERS[toolName];
      output = handler ? await handler(toolInput) : `Unknown tool: ${toolName}`;
      console.log(`> ${toolName}: ${String(output).slice(0, 200)}`);
    } else {
      output = `Permission denied by user for ${toolName}`;
      console.log(`  [USER DENIED] ${toolName}`);
    }
  } else {
    const handler = TOOL_HANDLERS[toolName];
    output = handler ? await handler(toolInput) : `Unknown tool: ${toolName}`;
    console.log(`> ${toolName}: ${String(output).slice(0, 200)}`);
  }

  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: String(output),
  };
}

// ---------- Agent Loop ----------

async function agentLoop(messages: Message[], perms: PermissionManager): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: any[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await executeToolCall(block, perms);
      results.push(result);
    }

    messages.push({
      role: "user",
      content: results,
    });
  }
}

// ---------- CLI ----------

async function selectMode(rl: readline.Interface): Promise<PermissionMode> {
  console.log("Permission modes: default, plan, auto");
  const input = (await rl.question("Mode (default): ")).trim().toLowerCase();

  if (input === "plan" || input === "auto" || input === "default") {
    return input;
  }

  return "default";
}

async function main() {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  const mode = await selectMode(rl);
  const perms = new PermissionManager(mode, rl);
  const history: Message[] = [];

  console.log(`[Permission mode: ${mode}]`);

  while (true) {
    const query = await rl.question("\x1b[36ms07 >> \x1b[0m");

    if (!query.trim() || query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit") {
      break;
    }

    if (query.startsWith("/mode")) {
      const parts = query.trim().split(/\s+/);
      if (parts.length === 2 && (parts[1] === "default" || parts[1] === "plan" || parts[1] === "auto")) {
        perms.mode = parts[1] as PermissionMode;
        console.log(`[Switched to ${parts[1]} mode]`);
      } else {
        console.log("Usage: /mode <default|plan|auto>");
      }
      continue;
    }

    if (query.trim() === "/rules") {
      perms.rules.forEach((rule, i) => {
        console.log(`  ${i}: ${JSON.stringify(rule)}`);
      });
      continue;
    }

    history.push({
      role: "user",
      content: query,
    });

    await agentLoop(history, perms);

    const lastMessage = history[history.length - 1];
    const finalText = extractText(lastMessage.content);

    if (finalText) {
      console.log(finalText);
    }
    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
