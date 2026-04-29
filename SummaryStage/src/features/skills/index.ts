/**
 * =============================================================================
 *  features/skills/index.ts — 技能加载系统模块
 * =============================================================================
 *
 * 导出 SkillLoader 并实现功能注册。
 */

import type { AgentContext } from "../../core/context.js";
import type { ToolDefinition } from "../../core/types.js";
import { SkillLoader } from "./skill-loader.js";

export { SkillLoader } from "./skill-loader.js";

/** load_skill 工具定义（从 stage1.ts 提取） */
const loadSkillToolDefinition: ToolDefinition = {
  name: "load_skill",
  description: "Load specialized knowledge by name.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name to load",
      },
    },
    required: ["name"],
  },
};

/**
 * 注册技能加载功能模块。
 * 创建 SkillLoader 实例并加载所有技能，挂载到 ctx.skillLoader，并注册 load_skill 工具。
 *
 * @param ctx - Agent 上下文
 * @param skillsDir - 技能文件目录路径
 */
export async function registerSkillsFeature(ctx: AgentContext, skillsDir: string): Promise<void> {
  const skillLoader = new SkillLoader();
  skillLoader.loadAll(skillsDir);
  ctx.skillLoader = skillLoader;

  ctx.toolRegistry.register("load_skill", loadSkillToolDefinition, async (input: Record<string, unknown>, _ctx: AgentContext) => {
    return skillLoader.getContent(input.name as string);
  });
}
