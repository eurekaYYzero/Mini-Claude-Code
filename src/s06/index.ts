// Harness: compression -- clean memory for infinite sessions.
// Every turn:
//     +------------------+
//     | Tool call result |
//     +------------------+
//             |
//             v
//     [Layer 1: micro_compact]        (silent, every turn)
//       Replace non-read_file tool_result content older than last 3
//       with "[Previous: used {tool_name}]"
//             |
//             v
//     [Check: tokens > 50000?]
//        |               |
//        no              yes
//        |               |
//        v               v
//     continue    [Layer 2: auto_compact]
//                   Save full transcript to .transcripts/
//                   Ask LLM to summarize conversation.
//                   Replace all messages with [summary].
//                         |
//                         v
//                 [Layer 3: compact tool]
//                   Model calls compact -> immediate summarization.
//                   Same as auto, triggered manually.
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "path"
import fs from 'fs'

dotenv.config();

const execAsync = promisify(exec);
const WORKDIR = process.cwd();
const rl = readline.createInterface({ input, output });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to inspect and change the workspace.`;

const THRESHOLD = 1000
const TRANSCRIPT_DIR = path.resolve(WORKDIR, ".transcripts");
const KEEP_RECENT = 2
const PRESERVE_RESULT_TOOLS = ["read_file"]

/**
 * Rough token count: ~4 chars per token.
 * @param {Array} messages
 * @returns {number}
 */
function estimateTokens(messages:any) {
  return Math.floor(String(JSON.stringify(messages)).length / 4);
}

function findLastAssistantMessage(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") {
      return history[i];
    }
  }
  return null;
}


/**
 * Layer 1: micro_compact - replace old tool results with placeholders
 * @param {Array} messages
 * @param {Object} options
 * @param {number} options.KEEP_RECENT
 * @param {Set<string>} options.PRESERVE_RESULT_TOOLS
 * @returns {Array}
 */
// 这里一系列的处理就是找到非最新的tool_result，然后一句话总结调用过了放到messages
function microCompact(messages:any) {
  // Collect (msgIndex, partIndex, toolResultDict) for all tool_result entries
  const toolResults = [];

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

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  // Find tool_name for each result by matching tool_use_id in prior assistant messages
  const toolNameMap = {};

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = msg.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && block.type === "tool_use") {
            toolNameMap[block.id] = block.name;
          }
        }
      }
    }
  }

  // Clear old results (keep last KEEP_RECENT). Preserve read_file outputs because
  // they are reference material; compacting them forces the agent to re-read files.
  const toClear = toolResults.slice(0, -KEEP_RECENT);

  for (const [, , result] of toClear) {
    if (typeof result.content !== "string" || result.content.length <= 100) {
      continue;
    }

    const toolId = result.tool_use_id || "";
    const toolName = toolNameMap[toolId] || "unknown";

    if (PRESERVE_RESULT_TOOLS.includes(toolName)) {
      continue;
    }

    result.content = `[Previous: used ${toolName}]`;
  }

  return messages;
}

/**
 * Layer 2: auto_compact - save transcript, summarize, replace messages
 * @param {Array} messages
 * @param {Object} options
 * @param {string} options.TRANSCRIPT_DIR
 * @param {string} options.MODEL
 * @param {Object} options.client
 * @returns {Promise<Array>}
 */
// 这一步相当于直接把历史信息保存到磁盘记录链接，然后让大模型总结，最后返回总结和原始信息的保存链接
export async function autoCompact(
  messages:any
) {
  // Save full transcript to disk
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const transcriptPath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`
  );

  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
  fs.writeFileSync(transcriptPath, lines, "utf8");

  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(-80000);

  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary =
    response.content?.find(
      (block) => block && typeof block.text === "string"
    )?.text || "No summary generated.";

  // Replace all messages with compressed summary
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
  ];
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
    const text = await fs.readFile(safePath(filePath), "utf8");
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
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

async function runEdit(filePath:string, oldText:string, newText:string) {
  try {
    const fp = safePath(filePath);
    const content = await fs.readFile(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    await fs.writeFile(fp, content.replace(oldText, newText), "utf8");
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
    {"name": "compact", "description": "Trigger manual conversation compression.",
     "input_schema": {"type": "object", "properties": {"focus": {"type": "string", "description": "What to preserve in the summary"}}}},
]

type ToolHandler = (input: any) => any;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  compact: () => "Manual compression requested.",
};


async function agentLoop(messages) {
  while (true) {
    microCompact(messages);

    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let output;
      if (block.name === "compact") {
        manualCompact = true;
        output = "Compressing...";
      } else {
        const handler = TOOL_HANDLERS[block.name];
        try {
          output = handler
            ? await handler(block.input)
            : `Unknown tool: ${block.name}`;
        } catch (e) {
          output = `Error: ${e}`;
        }
      }

      console.log(`> ${block.name}:`);
      console.log(String(output).slice(0, 200));

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(output),
      });
    }

    messages.push({ role: "user", content: results });

    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return;
    }
  }
}


async function main() {
  const history = [];

  while (true) {
    let query;
    try {
      query = await rl.question("\x1b[36ms06 >> \x1b[0m");
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({ role: "user", content: query });

    await agentLoop(history);

    const assistantMessage = findLastAssistantMessage(history);
    const responseContent = assistantMessage?.content;

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

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
