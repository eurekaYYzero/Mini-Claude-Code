// # Harness: on-demand knowledge -- domain expertise, loaded when the model asks.
// System prompt:
//     +--------------------------------------+
//     | You are a coding agent.              |
//     | Skills available:                    |
//     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
//     |   - code-review: Review code...      |
//     +--------------------------------------+

//     When model calls load_skill("pdf"):
//     +--------------------------------------+
//     | tool_result:                         |
//     | <skill>                              |
//     |   Full PDF processing instructions   |  <-- Layer 2: full body
//     |   Step 1: ...                        |
//     |   Step 2: ...                        |
//     | </skill>                             |
//     +--------------------------------------+
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "path"
import fs from "fs";
import yaml from 'js-yaml'

dotenv.config();

const execAsync = promisify(exec);
const WORKDIR = process.cwd();
const SKILLS_DIR = path.resolve(WORKDIR, 'skills');


const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;
type Message = {
  role: "user" | "assistant";
  content: any;
};

class SkillLoader {
  private skillsDir: string;
  private skills: Record<string, any>;
  constructor(skillsDir:string) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  _loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const skillFiles = this._findSkillFiles(this.skillsDir).sort();

    for (const file of skillFiles) {
      const text = fs.readFileSync(file, "utf8");
      const [meta, body] = this._parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(file));

      this.skills[name] = {
        meta,
        body,
        path: file,
      };
    }
  }

  _findSkillFiles(dir:any) {
    let results:any = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results = results.concat(this._findSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }

    return results;
  }

  _parseFrontmatter(text:string) {
    // Parse YAML frontmatter between --- delimiters
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!match) {
      return [{}, text];
    }

    let meta = {};
    try {
      meta = yaml.load(match[1]) || {};
    } catch (err) {
      meta = {};
    }

    return [meta, match[2].trim()];
  }

  getDescriptions() {
    // Layer 1: short descriptions for the system prompt
    const names = Object.keys(this.skills);
    if (names.length === 0) {
      return "(no skills available)";
    }

    const lines = [];
    for (const name of names) {
      const skill = this.skills[name];
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags || "";

      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }

  getContent(name:string) {
    // Layer 2: full skill body returned in tool_result
    const skill = this.skills[name];
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    }

    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

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
     {"name": "load_skill", "description": "Load specialized knowledge by name.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string", "description": "Skill name to load"}}, "required": ["name"]}},
]

type ToolHandler = (input: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  load_skill: ({ name }) => SKILL_LOADER.getContent(name),
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
