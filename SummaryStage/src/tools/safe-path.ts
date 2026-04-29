/**
 * =============================================================================
 *  tools/safe-path.ts — 安全路径验证
 * =============================================================================
 *
 * 从 stage1.ts 提取的路径安全校验逻辑。
 * 验证文件路径是否在工作目录范围内，防止路径穿越攻击。
 */

import path from "node:path";

/**
 * 创建绑定了 workDir 的安全路径校验函数。
 *
 * @param workDir - 工作目录（所有文件操作的根目录）
 * @returns 绑定了 workDir 的 safePath 函数
 */
export function createSafePath(workDir: string): (p: string) => string {
  return function safePath(p: string): string {
    const resolved = path.resolve(workDir, p);
    const workspace = path.resolve(workDir);
    const relative = path.relative(workspace, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${p}`);
    }

    return resolved;
  };
}
