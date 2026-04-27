// Harness: tool dispatch -- expanding what the model can reach.
// +----------+      +-------+      +------------------+
// |   User   | ---> |  LLM  | ---> | Tool Dispatch    |
// |  prompt  |      |       |      | {                |
// +----------+      +---+---+      |   bash: run_bash |
//                       ^          |   read: run_read |
//                       |          |   write: run_wr  |
//                       +----------+   edit: run_edit |
//                       tool_result| }                |
//                                  +------------------+
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "path"
import fs from "node:fs";
import fsp from "node:fs/promises";

import { spawnSync } from "node:child_process";

dotenv.config();

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to inspect and change the workspace.`;

type Message = {
  role: "user" | "assistant";
  content: any;
};

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

function findLastAssistantMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages[i];
    }
  }
  return undefined;
}

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

export const HOOK_TIMEOUT = 30_000; // milliseconds

// Real CC timeouts:
//   TOOL_HOOK_EXECUTION_TIMEOUT_MS = 600000 (10 minutes for tool hooks)
//   SESSION_END_HOOK_TIMEOUT_MS = 1500 (1.5 seconds for SessionEnd hooks)

// Workspace trust marker. Hooks only run if this file exists (or SDK mode).
export const TRUST_MARKER = path.join(WORKDIR, ".claude");

export interface HookContext {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  [key: string]: unknown;
}

export interface HookDefinition {
  matcher?: string;
  command?: string;
  [key: string]: unknown;
}

export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
}

export interface HookRunResult {
  blocked: boolean;
  messages: string[];
  block_reason?: string;
  permission_override?: unknown;
}

export class HookManager {
  public hooks: Record<HookEvent, HookDefinition[]>;
  private _sdkMode: boolean;

  constructor(configPath?: string, sdkMode = false) {
    this.hooks = {
      PreToolUse: [],
      PostToolUse: [],
      SessionStart: [],
    };
    this._sdkMode = sdkMode;

    const finalConfigPath = configPath ?? path.join(WORKDIR, "hooks.json");

    if (fs.existsSync(finalConfigPath)) {
      try {
        const config = JSON.parse(
          fs.readFileSync(finalConfigPath, "utf8")
        ) as HooksConfig;

        for (const event of HOOK_EVENTS) {
          this.hooks[event] = config.hooks?.[event] ?? [];
        }

        console.log(`[Hooks loaded from ${finalConfigPath}]`);
      } catch (e) {
        console.log(`[Hook config error: ${String(e)}]`);
      }
    }
  }

  /**
   * Check whether the current workspace is trusted.
   * The teaching version uses a simple trust marker file.
   * In SDK mode, trust is treated as implicit.
   */
  private _checkWorkspaceTrust(): boolean {
    if (this._sdkMode) {
      return true;
    }
    return fs.existsSync(TRUST_MARKER);
  }

  /**
   * Execute all hooks for an event.
   * Returns: { blocked: boolean, messages: string[] }
   *   - blocked: true if any hook returned exit code 1
   *   - messages: stderr content from exit-code-2 hooks (to inject)
   */
  runHooks(event: HookEvent, context: HookContext | null = null): HookRunResult {
    const result: HookRunResult = {
      blocked: false,
      messages: [],
    };

    // Trust gate: refuse to run hooks in untrusted workspaces
    if (!this._checkWorkspaceTrust()) {
      return result;
    }

    const hooks = this.hooks[event] ?? [];

    for (const hookDef of hooks) {
      // Check matcher (tool name filter for PreToolUse/PostToolUse)
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

      // Build environment with hook context
      const env: NodeJS.ProcessEnv = { ...process.env };

      if (context) {
        env.HOOK_EVENT = event;
        env.HOOK_TOOL_NAME = String(context.tool_name ?? "");
        env.HOOK_TOOL_INPUT = JSON.stringify(
          context.tool_input ?? {},
          null,
          0
        ).slice(0, 10000);

        if ("tool_output" in context) {
          env.HOOK_TOOL_OUTPUT = String(context.tool_output).slice(0, 10000);
        }
      }

      try {
        const r = spawnSync(command, {
          shell: true,
          cwd: WORKDIR,
          env,
          encoding: "utf8",
          timeout: HOOK_TIMEOUT,
          maxBuffer: 1024 * 1024,
        });

        const stdout = (r.stdout ?? "").trim();
        const stderr = (r.stderr ?? "").trim();

        if (r.status === 0) {
          // Continue silently
          if (stdout) {
            console.log(`  [hook:${event}] ${stdout.slice(0, 100)}`);
          }

          // Optional structured stdout: small extension point that
          // keeps the teaching contract simple.
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
            // stdout was not JSON -- normal for simple hooks
          }
        } else if (r.status === 1) {
          // Block execution
          result.blocked = true;
          const reason = stderr || "Blocked by hook";
          result.block_reason = reason;
          console.log(`  [hook:${event}] BLOCKED: ${reason.slice(0, 200)}`);
        } else if (r.status === 2) {
          // Inject message
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

function safePath(p:string) {
  const resolved = path.resolve(WORKDIR, p);
  const workspace = path.resolve(WORKDIR);

  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return resolved;
  
}

async function runRead(filePath:string, limit = null) {
  try {
    const text = await fsp.readFile(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);

    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
    }

    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

async function runWrite(filePath:string, content:string) {
  try {
    const fp = safePath(filePath);
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

async function runEdit(filePath:string, oldText:string, newText:string) {
  try {
    const fp = safePath(filePath);
    const content = await fsp.readFile(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    await fsp.writeFile(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}


async function runBash(command: string): Promise<string> {
  try {
    const result = await execAsync(command, {
      cwd: process.cwd(),
      timeout: 120000,
    });

    const output = (result.stdout + result.stderr).trim();
    return output || "(no output)";
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

const TOOLS = [
    {"name": "bash", "description": "Run a shell command.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
    {"name": "read_file", "description": "Read file contents.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["path"]}},
    {"name": "write_file", "description": "Write content to file.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "edit_file", "description": "Replace exact text in file.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]}},
]

type ToolHandler = (input: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
};

const hooks = new HookManager()


async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 2000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    console.log("llm return", response);

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ToolResultBlock[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const toolInput: Record<string, unknown> =
        block.input && typeof block.input === "object"
          ? { ...(block.input as Record<string, unknown>) }
          : {};

      const ctx: {
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_output?: unknown;
      } = {
        tool_name: block.name,
        tool_input: toolInput,
      };

      const preResult = hooks.runHooks("PreToolUse", ctx);

      for (const msg of preResult.messages ?? []) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `[Hook message]: ${msg}`,
        });
      }

      if (preResult.blocked) {
        const blockedOutput = `Tool blocked by PreToolUse hook: ${preResult.block_reason ?? "Blocked by hook"}`;
        console.log(`> ${block.name}:`);
        console.log(blockedOutput.slice(0, 200));

        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blockedOutput,
        });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];

      let output: unknown;
      try {
        output = handler
          ? await handler(ctx.tool_input)
          : `Unknown tool: ${block.name}`;
      } catch (e) {
        output = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }

      console.log(`> ${block.name}:`);
      console.log(String(output).slice(0, 200));

      ctx.tool_output = output;
      const postResult = hooks.runHooks("PostToolUse", ctx);

      let finalOutput = String(output);
      for (const msg of postResult.messages ?? []) {
        finalOutput += `\n[Hook note]: ${msg}`;
      }

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: finalOutput,
      });
    }

    messages.push({
      role: "user",
      content: results as any,
    });
  }
}

async function main() {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  const history: Message[] = [];

  const sessionResult = hooks.runHooks("SessionStart", {});
  for (const msg of sessionResult.messages ?? []) {
    console.log(`[SessionStart] ${msg}`);
  }

  while (true) {
    let query: string;
    try {
      query = await rl.question("s01 >> ");
    } catch {
      break;
    }

    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({
      role: "user",
      content: query,
    });

    await agentLoop(history);

    const assistantMessage = findLastAssistantMessage(history);
    const responseContent = assistantMessage?.content;

    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          console.log((block as { text: string }).text);
        }
      }
    } else if (typeof responseContent === "string") {
      console.log(responseContent);
    }

    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});