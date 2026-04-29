/**
 * =============================================================================
 *  main.ts — CLI 入口
 * =============================================================================
 *
 * 加载环境变量、创建 Agent 实例、启用所有功能模块、启动 REPL 循环。
 */

import dotenv from "dotenv";
import path from "node:path";
import { Agent } from "./core/agent.js";

dotenv.config();

async function main() {
  const agent = new Agent({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.MODEL_ID || "claude-sonnet-4-20250514",
    workDir: process.cwd(),
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  // 启用所有功能
  agent.enableTodo();
  await agent.enableSkills(path.join(process.cwd(), "skills"));
  agent.enableSubagent();
  agent.enableCompression();
  agent.enablePermissions();  // 默认 "default" 模式
  agent.enableHooks();        // 默认加载 workDir/hooks.json
  agent.enableMemory();       // 加载记忆 + 注册 save_memory 工具

  await agent.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
