// 注意，这是基于anthropic的api来进行设计的，openai的api调用、模型出入参都会不一样
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "path"
import fs from 'fs/promises'

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
]

type ToolHandler = (input: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
};


async function runOneTurn(messages: Message[]): Promise<boolean> {
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

  console.log('llm return', response);

  if (response.stop_reason !== "tool_use") {
    return false;
  }

  const results: any[] = [];

  for (const block of response.content) {
    if (block.type === "tool_use") {
      const handler = TOOL_HANDLERS[block.name]
      const output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
  }

  messages.push({
    role: "user",
    content: results,
  });

  return true;
}

async function main() {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  const messages: Message[] = [];

  while (true) {
    const query = await rl.question("s01 >> ");

    if (!query.trim() || query === "q" || query === "exit") {
      break;
    }

    messages.push({
      role: "user",
      content: query,
    });

    while (await runOneTurn(messages)) {}

    const lastMessage = messages[messages.length - 1];
    const finalText = extractText(lastMessage.content);
    console.log(finalText);
    console.log();
  }

  rl.close();
}

main();
