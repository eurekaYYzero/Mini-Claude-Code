/**
 * =============================================================================
 *  features/task/task-manager.ts — 生产级 Task 管理系统
 * =============================================================================
 *
 * 支持任务依赖关系、循环检测、自动解阻塞、持久化的完整任务管理器。
 */

import * as fs from "fs";
import * as path from "path";

// =============================================================================
// 类型定义
// =============================================================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner?: string;
  activeForm?: string;
  metadata?: Record<string, any>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskUpdateInput {
  taskId: number;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, any>;
  addBlockedBy?: number[];
  addBlocks?: number[];
}

// =============================================================================
// TaskManager
// =============================================================================

export class TaskManager {
  private tasks: Map<number, Task> = new Map();
  private filePath: string;

  /**
   * @param tasksDir - `.tasks/` 目录路径
   */
  constructor(tasksDir: string) {
    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }
    this.filePath = path.join(tasksDir, "tasks.json");
    this._load();
  }

  // ---------------------------------------------------------------------------
  // 公共方法
  // ---------------------------------------------------------------------------

  /**
   * 创建新任务。
   */
  create(input: { subject: string; description: string; blockedBy?: number[] }): Task {
    const { subject, description, blockedBy = [] } = input;

    // 验证 blockedBy 引用的任务都存在
    for (const depId of blockedBy) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Blocked-by task #${depId} does not exist`);
      }
    }

    const id = this._nextId();

    // 循环检测（新任务 id 被 blockedBy 阻塞）
    if (blockedBy.length > 0 && this._hasCycle(id, blockedBy)) {
      throw new Error(`Adding blockedBy [${blockedBy.join(", ")}] to task #${id} would create a cycle`);
    }

    const task: Task = {
      id,
      subject,
      description,
      status: "pending",
      blockedBy: [...blockedBy],
      blocks: [],
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);

    // 双向同步：在被依赖任务的 blocks 中添加本任务
    for (const depId of blockedBy) {
      const dep = this.tasks.get(depId)!;
      if (!dep.blocks.includes(id)) {
        dep.blocks.push(id);
      }
    }

    this._save();
    return { ...task };
  }

  /**
   * 获取单个任务。
   */
  get(taskId: number): Task | null {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  /**
   * 更新任务。
   */
  update(taskId: number, input: TaskUpdateInput): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    // 简单字段更新
    if (input.subject !== undefined) task.subject = input.subject;
    if (input.description !== undefined) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;
    if (input.owner !== undefined) task.owner = input.owner;

    // metadata 合并
    if (input.metadata !== undefined) {
      if (!task.metadata) task.metadata = {};
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v === null) {
          delete task.metadata[k];
        } else {
          task.metadata[k] = v;
        }
      }
    }

    // 依赖关系：addBlockedBy
    if (input.addBlockedBy && input.addBlockedBy.length > 0) {
      for (const depId of input.addBlockedBy) {
        if (!this.tasks.has(depId)) {
          throw new Error(`Blocked-by task #${depId} does not exist`);
        }
      }
      const newBlockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])];
      if (this._hasCycle(taskId, newBlockedBy)) {
        throw new Error(`Adding blockedBy [${input.addBlockedBy.join(", ")}] to task #${taskId} would create a cycle`);
      }
      for (const depId of input.addBlockedBy) {
        if (!task.blockedBy.includes(depId)) {
          task.blockedBy.push(depId);
        }
        const dep = this.tasks.get(depId)!;
        if (!dep.blocks.includes(taskId)) {
          dep.blocks.push(taskId);
        }
      }
    }

    // 依赖关系：addBlocks
    if (input.addBlocks && input.addBlocks.length > 0) {
      for (const blockId of input.addBlocks) {
        if (!this.tasks.has(blockId)) {
          throw new Error(`Task #${blockId} does not exist`);
        }
      }
      // 检测循环：相当于让 blockId 的 blockedBy 加入 taskId
      for (const blockId of input.addBlocks) {
        const blocked = this.tasks.get(blockId)!;
        const newBlockedBy = [...new Set([...blocked.blockedBy, taskId])];
        if (this._hasCycle(blockId, newBlockedBy)) {
          throw new Error(`Adding task #${taskId} as blocker of #${blockId} would create a cycle`);
        }
      }
      for (const blockId of input.addBlocks) {
        if (!task.blocks.includes(blockId)) {
          task.blocks.push(blockId);
        }
        const blocked = this.tasks.get(blockId)!;
        if (!blocked.blockedBy.includes(taskId)) {
          blocked.blockedBy.push(taskId);
        }
      }
    }

    // 状态变更
    if (input.status !== undefined && input.status !== task.status) {
      task.status = input.status;

      if (input.status === "in_progress" && !task.startedAt) {
        task.startedAt = Date.now();
      }

      if (input.status === "completed") {
        task.completedAt = Date.now();
        // 自动解阻塞：从所有任务的 blockedBy 中移除此 taskId
        for (const [, t] of this.tasks) {
          const idx = t.blockedBy.indexOf(taskId);
          if (idx !== -1) {
            t.blockedBy.splice(idx, 1);
          }
        }
      }
    }

    this._save();
    return { ...task };
  }

  /**
   * 返回所有任务。
   */
  list(): Task[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }

  /**
   * 返回可执行的任务：status=pending 且 blockedBy 为空。
   */
  getReadyTasks(): Task[] {
    return this.list().filter((t) => t.status === "pending" && t.blockedBy.length === 0);
  }

  /**
   * 统计信息。
   */
  getStats(): { total: number; pending: number; inProgress: number; completed: number; failed: number; blocked: number } {
    let pending = 0, inProgress = 0, completed = 0, failed = 0, blocked = 0;
    for (const [, t] of this.tasks) {
      switch (t.status) {
        case "pending":
          if (t.blockedBy.length > 0) blocked++;
          else pending++;
          break;
        case "in_progress": inProgress++; break;
        case "completed": completed++; break;
        case "failed": failed++; break;
      }
    }
    return { total: this.tasks.size, pending, inProgress, completed, failed, blocked };
  }

  /**
   * 渲染任务列表为可读文本。
   */
  render(): string {
    const tasks = this.list();
    if (tasks.length === 0) return "No tasks.";

    const markers: Record<TaskStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
      failed: "[!]",
    };

    const done = tasks.filter((t) => t.status === "completed").length;
    const lines: string[] = [`Task List (${done}/${tasks.length} completed)`, ""];

    for (const t of tasks) {
      let line = `${markers[t.status]} #${t.id}: ${t.subject}`;
      if (t.blockedBy.length > 0) {
        line += ` (blocked by: ${t.blockedBy.map((id) => `#${id}`).join(", ")})`;
      }
      if (t.owner) {
        line += `  owner=${t.owner}`;
      }
      if (t.status === "in_progress" && t.activeForm) {
        line += `  [${t.activeForm}]`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // 私有方法
  // ---------------------------------------------------------------------------

  /**
   * DFS 循环检测。
   * 假设 taskId 的 blockedBy 变为 wouldBlockedBy，检测是否会形成环。
   *
   * 如果 taskId 被 wouldBlockedBy 中的某个任务阻塞，而该任务又直接/间接被 taskId 阻塞，则形成环。
   */
  _hasCycle(taskId: number, wouldBlockedBy: number[]): boolean {
    // 从每个 wouldBlockedBy 出发，沿着 blockedBy 链向上搜索，看是否能到达 taskId
    const visited = new Set<number>();

    const dfs = (currentId: number): boolean => {
      if (currentId === taskId) return true;
      if (visited.has(currentId)) return false;
      visited.add(currentId);

      const current = this.tasks.get(currentId);
      if (!current) return false;

      // 沿着 current 的 blockedBy 继续搜索
      for (const depId of current.blockedBy) {
        if (dfs(depId)) return true;
      }
      return false;
    };

    for (const depId of wouldBlockedBy) {
      visited.clear();
      // depId 阻塞 taskId，如果 depId 又被 taskId 直接/间接阻塞，则成环
      // 即从 depId 的 blockedBy 链能到达 taskId
      if (dfs(depId)) return true;
    }

    return false;
  }

  private _nextId(): number {
    let max = 0;
    for (const id of this.tasks.keys()) {
      if (id > max) max = id;
    }
    return max + 1;
  }

  private _load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const arr: Task[] = JSON.parse(raw);
      for (const t of arr) {
        this.tasks.set(t.id, t);
      }
    } catch {
      // 文件损坏则忽略，从空状态开始
    }
  }

  private _save(): void {
    const arr = Array.from(this.tasks.values());
    fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), "utf-8");
  }
}
