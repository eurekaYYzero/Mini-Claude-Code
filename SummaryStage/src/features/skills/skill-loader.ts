/**
 * =============================================================================
 *  features/skills/skill-loader.ts — 按需加载知识体系
 * =============================================================================
 *
 * 从 stage1.ts 提取的 SkillLoader 类。
 * 扫描 skills 目录下的 SKILL.md 文件，解析 YAML Frontmatter。
 * 采用两层架构：
 *   - Layer 1: 元数据（名称、描述、标签）注入系统提示词
 *   - Layer 2: 完整技能内容通过 load_skill 工具按需返回
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { SkillMeta, SkillEntry } from "../../core/types.js";

export class SkillLoader {
  private skills: Record<string, SkillEntry> = {};

  /**
   * 加载指定目录下所有技能文件。
   * 构造函数不再自动加载，需显式调用 loadAll。
   */
  loadAll(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return;

    const files = this.findSkillFiles(skillsDir).sort();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const [meta, body] = this.parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(file));
      this.skills[name] = { meta, body, path: file };
    }
  }

  /** 递归查找目录中的 SKILL.md 文件 */
  private findSkillFiles(dir: string): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results = results.concat(this.findSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }

    return results;
  }

  /** 解析 YAML Frontmatter（--- 分隔符之间的部分） */
  private parseFrontmatter(text: string): [SkillMeta, string] {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return [{}, text];

    let meta: SkillMeta = {};
    try {
      meta = (yaml.load(match[1]) as SkillMeta) || {};
    } catch {
      meta = {};
    }

    return [meta, match[2].trim()];
  }

  /** Layer 1: 返回所有技能的简短描述（用于系统提示词） */
  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (names.length === 0) return "(no skills available)";

    return names
      .map((name) => {
        const skill = this.skills[name];
        const desc = skill.meta.description || "No description";
        const tags = skill.meta.tags || "";
        return `  - ${name}: ${desc}${tags ? ` [${tags}]` : ""}`;
      })
      .join("\n");
  }

  /** Layer 2: 返回完整技能内容（通过 tool_result 给 LLM） */
  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      const available = Object.keys(this.skills).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }

    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
