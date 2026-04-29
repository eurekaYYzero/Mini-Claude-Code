/**
 * =============================================================================
 *  features/todo/todo-manager.ts — 任务进度管理
 * =============================================================================
 *
 * 从 stage1.ts 提取的 TodoManager 类，管理多步骤任务的 todo 列表。
 */

import type { TodoStatus, TodoItem } from "../../core/types.js";

/**
 * 管理多步骤任务的 todo 列表，确保：
 * - 最多 20 个待办项
 * - 同一时间只有一个任务处于 in_progress 状态
 * - 自动渲染进度的文本表示
 */
export class TodoManager {
  private items: TodoItem[] = [];

  /**
   * 更新任务列表（全量替换）。输入由 LLM 生成，需严格校验。
   */
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

      if (status === "in_progress") {
        inProgressCount++;
      }

      validated.push({ id, text, status: status as TodoStatus });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  /**
   * 渲染任务列表为文本格式。
   * 格式：`[ ] | [>] | [x] #id: task text`
   */
  render(): string {
    if (this.items.length === 0) return "No todos.";

    const markers: Record<TodoStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };
    const done = this.items.filter((t) => t.status === "completed").length;

    return [
      ...this.items.map((item) => `${markers[item.status]} #${item.id}: ${item.text}`),
      "",
      `(${done}/${this.items.length} completed)`,
    ].join("\n");
  }
}
