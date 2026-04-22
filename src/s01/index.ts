import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to inspect and change the workspace.`;

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
];

type Message = {
  role: "user" | "assistant";
  content: any;
};

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

  if (response.stop_reason !== "tool_use") {
    return false;
  }

  const results: any[] = [];

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "bash") {
      const command = (block.input as any).command || "";
      console.log("$", command);

      const output = await runBash(command);
      console.log(output.slice(0, 200));

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
  }

  if (results.length === 0) {
    return false;
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
