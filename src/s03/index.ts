// # Harness: planning -- keeping the model on course without scripting the route.
// The model tracks its own progress via a TodoManager. A nag reminder
// forces it to keep updating when it forgets.

//     +----------+      +-------+      +---------+
//     |   User   | ---> |  LLM  | ---> | Tools   |
//     |  prompt  |      |       |      | + todo  |
//     +----------+      +---+---+      +----+----+
//                           ^               |
//                           |   tool_result |
//                           +---------------+
//                                 |
//                     +-----------+-----------+
//                     | TodoManager state     |
//                     | [ ] task A            |
//                     | [>] task B <- doing   |
//                     | [x] task C            |
//                     +-----------------------+
//                                 |
//                     if rounds_since_todo >= 3:
//                       inject <reminder>

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
const SYSTEM = `
You are a coding agent working at ${process.cwd()}.

For any task with more than one step:
1. First create or update a todo list using the todo tool.
2. Mark exactly one item as in_progress before doing work.
3. Use available tools to inspect files, edit code, and verify results.
4. After completing a step, update the todo list again.
5. Do not stop after creating a todo list if work remains.
6. Only respond with a final natural-language answer when no more tool use is needed.

Prefer tools over prose.
`;


type Message = {
  role: "user" | "assistant";
  content: any;
};

// -- TodoManager --
type TodoStatus = "pending" | "in_progress" | "completed";

type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
};

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

class TodoManager {
  private items: TodoItem[] = [];

  update(items: any[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? {};
      const id = String(item.id ?? i + 1);
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }

      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }

      const todoStatus = status as TodoStatus;

      if (todoStatus === "in_progress") {
        inProgressCount++;
      }

      validated.push({ id, text, status: todoStatus });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const done = this.items.filter((t) => t.status === "completed").length;
    return [
      ...this.items.map((item) => `${MARKERS[item.status]} #${item.id}: ${item.text}`),
      "",
      `(${done}/${this.items.length} completed)`,
    ].join("\n");
  }
}

const TODO = new TodoManager();



// -- Tool implementations --
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
    {"name": "todo", "description": "Update task list. Track progress on multi-step tasks.",
     "input_schema": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "text": {"type": "string"}, "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}}, "required": ["id", "text", "status"]}}}, "required": ["items"]}},
]

type ToolHandler = (input: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  todo: async ({ items }) => TODO.update(items),
};


// -- Agent loop --
async function runOneTurn(messages: Message[],roundsSinceTodo:number): Promise<boolean> {
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

  if(response.stop_reason !== "tool_use"){
    return false
  }

  console.log('llm return', response.content);

  const results: any[] = [];
  let usedTodo = false


  for (const block of response.content) {
    if (block.type === "tool_use") {
      const handler = TOOL_HANDLERS[block.name]
      let output = ''
      try {
        output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
      } catch (error) {
        output = `Error: ${error.message}`
      }

      if(block.name === 'todo') {
        usedTodo = true
      }
      roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
      if (roundsSinceTodo >= 3) {
        results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
      }

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
    let roundsSinceTodo = 0

    while (await runOneTurn(messages,roundsSinceTodo)) {}


    const lastMessage = messages[messages.length - 1];
    const finalText = extractText(lastMessage.content);
    console.log(finalText);
    console.log();
  }

  rl.close();
}

main();
