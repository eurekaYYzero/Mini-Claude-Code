// s01 >> help me to review code in index.ts
// > llm return {
//   id: 'chatcmpl-696d0f97-39d7-9c24-828c-a165af6db13c',
//   type: 'message',
//   role: 'assistant',
//   model: 'ZhipuAI/GLM-5',
//   content: [
//     {
//       type: 'text',
//       text: "I'll help you review the code in index.ts. Let me first load the code review skill and then read the file."
//     },
//     {
//       type: 'thinking',
//       thinking: 'The user wants me to review code in index.ts. I should use the load_skill function to access the code-review skill first, then read the file to perform the review.'
//     },
//     {
//       type: 'tool_use',
//       id: 'tool-30f96ec5a2374fb895d915e3bf349e25',
//       name: 'load_skill',
//       input: [Object]
//     },
//     {
//       type: 'tool_use',
//       id: 'tool-0e5fce71b5d14a61994a1ee19fc22751',
//       name: 'read_file',
//       input: [Object]
//     }
//   ],
//   stop_reason: 'tool_use',
//   stop_sequence: null,
//   usage: { input_tokens: 519, output_tokens: 105 }
// }
// llm return {
//   id: 'chatcmpl-645e2082-070d-9103-8cec-49f2d8c46998',
//   type: 'message',
//   role: 'assistant',
//   model: 'ZhipuAI/GLM-5',
//   content: [
//     { type: 'text', text: 'Let me try reading the file using bash:' },
//     {
//       type: 'thinking',
//       thinking: 'It looks like there was an error reading the file. Let me try using bash to read the file instead.'
//     },
//     {
//       type: 'tool_use',
//       id: 'tool-7b3dae310bfc4819a6f1db945ea42402',
//       name: 'bash',
//       input: [Object]
//     }
//   ],
//   stop_reason: 'tool_use',
//   stop_sequence: null,
//   usage: { input_tokens: 1685, output_tokens: 66 }
// }
// llm return {
//   id: 'chatcmpl-ded4a224-0539-9146-b216-1510284c69a8',
//   type: 'message',
//   role: 'assistant',
//   model: 'ZhipuAI/GLM-5',
//   content: [
//     {
//       type: 'text',
//       text: '## Code Review: index.ts\n' +
//         '\n' +
//         '### Summary\n' +
//         'This is a CLI-based AI coding agent that implements a skill-loading system with two-layer knowledge (metadata in system prompt, full content on-demand). The code demonstrates good architecture but has several security and type safety concerns that should be addressed.\n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Critical Issues\n' +
//         '\n' +
//         '1. **Command Injection Vulnerability** (line 165-177)\n' +
//         '   - **Impact**: The `runBash` function executes arbitrary shell commands without any sanitization or validation. Malicious user input could execute dangerous commands.\n' +
//         '   - **Fix**: \n' +
//         '   ```typescript\n' +
//         '   async function runBash(command: string): Promise<string> {\n' +
//         '     // Add command validation/whitelist\n' +
//         '     const BLOCKED_PATTERNS = [/\\brm\\s+-rf/, /\\bsudo\\b/, /\\bchmod\\b/];\n' +
//         '     for (const pattern of BLOCKED_PATTERNS) {\n' +
//         '       if (pattern.test(command)) {\n' +
//         '         return `Error: Blocked potentially dangerous command`;\n' +
//         '       }\n' +
//         '     }\n' +
//         '     \n' +
//         '     try {\n' +
//         '       const result = await execAsync(command, {\n' +
//         '         cwd: process.cwd(),\n' +
//         '         timeout: 120000,\n' +
//         '         // Consider adding maxBuffer limit\n' +
//         '         maxBuffer: 10 * 1024 * 1024, // 10MB\n' +
//         '       });\n' +
//         '       // ... rest of code\n' +
//         '     }\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '2. **Type Safety Issues** (multiple lines)\n' +
//         "   - **Impact**: Using `any` type extensively defeats TypeScript's type checking, leading to potential runtime errors.\n" +
//         '   - **Locations**:\n' +
//         '     - Line 75: `private skills: Record<string, any>`\n' +
//         '     - Line 84: `_findSkillFiles(dir:any)`\n' +
//         '     - Line 178: `err: any`\n' +
//         '     - Line 195: `content: any`\n' +
//         '     - Line 238: `messages as any`\n' +
//         '   - **Fix**: Define proper interfaces:\n' +
//         '   ```typescript\n' +
//         '   interface Skill {\n' +
//         '     meta: SkillMeta;\n' +
//         '     body: string;\n' +
//         '     path: string;\n' +
//         '   }\n' +
//         '   \n' +
//         '   interface SkillMeta {\n' +
//         '     name?: string;\n' +
//         '     description?: string;\n' +
//         '     tags?: string;\n' +
//         '   }\n' +
//         '   \n' +
//         '   interface ContentBlock {\n' +
//         '     type: string;\n' +
//         '     text?: string;\n' +
//         '     name?: string;\n' +
//         '     input?: any;\n' +
//         '     id?: string;\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '3. **Unsafe File Operations** (lines 121-128)\n' +
//         '   - **Impact**: The `runRead` function slices to 50000 bytes which might break multi-byte UTF-8 characters.\n' +
//         '   - **Fix**: \n' +
//         '   ```typescript\n' +
//         '   async function runRead(filePath: string, limit: number | null = null) {\n' +
//         '     try {\n' +
//         '       const text = await fs.readFile(safePath(filePath), "utf8");\n' +
//         '       let lines = text.split(/\\r?\\n/);\n' +
//         '   \n' +
//         '       if (limit && limit < lines.length) {\n' +
//         '         lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);\n' +
//         '       }\n' +
//         '   \n' +
//         '       const result = lines.join("\\n");\n' +
//         "       // Ensure we don't cut in middle of multi-byte character\n" +
//         "       const buffer = Buffer.from(result, 'utf8');\n" +
//         '       if (buffer.length > 50000) {\n' +
//         "         return buffer.slice(0, 50000).toString('utf8');\n" +
//         '       }\n' +
//         '       return result;\n' +
//         '     } catch (e: unknown) {\n' +
//         '       const error = e as Error;\n' +
//         '       return `Error: ${error.message}`;\n' +
//         '     }\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '4. **Missing Input Validation** (line 165-177)\n' +
//         '   - **Impact**: Tool inputs are not validated before use.\n' +
//         '   - **Fix**: Add input validation:\n' +
//         '   ```typescript\n' +
//         "   import { z } from 'zod'; // or use manual validation\n" +
//         '   \n' +
//         '   const ReadFileSchema = z.object({\n' +
//         '     path: z.string().min(1),\n' +
//         '     limit: z.number().positive().optional()\n' +
//         '   });\n' +
//         '   ```\n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Improvements\n' +
//         '\n' +
//         '1. **Magic Numbers** (multiple lines)\n' +
//         '   - Define constants for magic numbers:\n' +
//         '   ```typescript\n' +
//         '   const MAX_FILE_SIZE = 50000;\n' +
//         '   const COMMAND_TIMEOUT = 120000;\n' +
//         '   const MAX_TOKENS = 2000;\n' +
//         '   ```\n' +
//         '\n' +
//         '2. **Error Handling** (lines 120-150)\n' +
//         '   - Improve error typing:\n' +
//         '   ```typescript\n' +
//         '   } catch (e: unknown) {\n' +
//         '     const error = e as Error;\n' +
//         '     return `Error: ${error.message}`;\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '3. **Path Validation** (lines 100-113)\n' +
//         '   - The `safePath` function is good but could be enhanced:\n' +
//         '   ```typescript\n' +
//         '   function safePath(p: string): string {\n' +
//         "     if (!p || typeof p !== 'string') {\n" +
//         "       throw new Error('Invalid path provided');\n" +
//         '     }\n' +
//         '     \n' +
//         '     const resolved = path.resolve(WORKDIR, p);\n' +
//         '     const workspace = path.resolve(WORKDIR);\n' +
//         '   \n' +
//         '     const relative = path.relative(workspace, resolved);\n' +
//         '     if (relative.startsWith("..") || path.isAbsolute(relative)) {\n' +
//         '       throw new Error(`Path escapes workspace: ${p}`);\n' +
//         '     }\n' +
//         '   \n' +
//         '     return resolved;\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '4. **Function Length** (lines 244-278)\n' +
//         '   - The `runOneTurn` function could be split into smaller functions:\n' +
//         '   ```typescript\n' +
//         '   function extractToolCalls(content: any[]): ToolCall[] {\n' +
//         '     return content.filter(block => block.type === "tool_use");\n' +
//         '   }\n' +
//         '   \n' +
//         '   async function executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {\n' +
//         '     // ...\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '5. **Resource Cleanup** (lines 290-307)\n' +
//         '   - The readline interface should be closed in a `finally` block:\n' +
//         '   ```typescript\n' +
//         '   async function main() {\n' +
//         '     const rl = readline.createInterface({\n' +
//         '       input: stdin,\n' +
//         '       output: stdout,\n' +
//         '     });\n' +
//         '   \n' +
//         '     try {\n' +
//         '       const messages: Message[] = [];\n' +
//         '       // ... main loop\n' +
//         '     } finally {\n' +
//         '       rl.close();\n' +
//         '     }\n' +
//         '   }\n' +
//         '   ```\n' +
//         '\n' +
//         '6. **Environment Variable Validation** (lines 26-31)\n' +
//         '   - Add validation for required environment variables:\n' +
//         '   ```typescript\n' +
//         '   if (!process.env.ANTHROPIC_API_KEY) {\n' +
//         "     throw new Error('ANTHROPIC_API_KEY environment variable is required');\n" +
//         '   }\n' +
//         '   \n' +
//         '   const client = new Anthropic({\n' +
//         '     apiKey: process.env.ANTHROPIC_API_KEY,\n' +
//         '     baseURL: process.env.ANTHROPIC_BASE_URL,\n' +
//         '   });\n' +
//         '   ```\n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Positive Notes\n' +
//         '\n' +
//         '✅ Good architecture with clear separation of concerns (SkillLoader, tools, handlers)  \n' +
//         '✅ Proper use of async/await throughout  \n' +
//         '✅ Good path traversal protection in `safePath`  \n' +
//         '✅ Two-layer skill loading pattern is elegant and efficient  \n' +
//         '✅ Proper error handling in most file operations  \n' +
//         '✅ Clean use of TypeScript type annotations in function signatures  \n' +
//         '✅ Good use of `promisify` for converting callback-style functions  \n' +
//         '✅ Clear and descriptive function names  \n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Security Audit Recommendations\n' +
//         '\n' +
//         '1. Run `npm audit` to check for vulnerable dependencies\n' +
//         '2. Consider adding rate limiting for tool calls\n' +
//         '3. Add logging for security-sensitive operations (bash commands, file writes)\n' +
//         '4. Consider sandboxing bash commands in a containerized environment\n' +
//         '5. Add input sanitization for all tool parameters\n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Testing Recommendations\n' +
//         '\n' +
//         '1. Add unit tests for:\n' +
//         '   - `safePath` function (edge cases: `../`, absolute paths, symlinks)\n' +
//         '   - SkillLoader methods\n' +
//         '   - All tool handlers with mock file system\n' +
//         '   - Error handling paths\n' +
//         '\n' +
//         '2. Add integration tests for:\n' +
//         '   - Full conversation flow\n' +
//         '   - Tool execution sequences\n' +
//         '   - Error recovery\n' +
//         '\n' +
//         '---\n' +
//         '\n' +
//         '### Verdict\n' +
//         '\n' +
//         '⚠️ **Needs major revision**\n' +
//         '\n' +
//         '**Priority Fixes:**\n' +
//         '1. **Critical**: Add command validation in `runBash` to prevent command injection\n' +
//         '2. **Critical**: Replace `any` types with proper TypeScript interfaces\n' +
//         '3. **High**: Add input validation for all tool handlers\n' +
//         '4. **High**: Fix multi-byte character handling in file reading\n' +
//         '5. **Medium**: Add environment variable validation on startup\n' +
//         '\n' +
//         'The code has a solid architecture and good practices in many areas, but the security vulnerabilities and type safety issues must be addressed before this can be considered production-ready. The command injection vulnerability is particularly concerning for a tool that executes shell commands.'
//     },
//     {
//       type: 'thinking',
//       thinking: 'Great! Now I have the code. Let me perform a comprehensive code review using the checklist from the skill I loaded. Let me analyze this TypeScript file systematically:\n' +
//         '\n' +
//         '**Security Issues:**\n' +
//         '1. Command injection vulnerability in runBash - no sanitization of command\n' +
//         '2. Path traversal protection in safePath looks good\n' +
//         '3. No validation of file paths in read/write operations beyond safePath\n' +
//         '4. No rate limiting or input validation\n' +
//         '5. API key loaded from environment (good) but no validation\n' +
//         '6. No sanitization of content being written to files\n' +
//         '\n' +
//         '**Correctness Issues:**\n' +
//         '1. Type safety: using `any` in many places (messages, content, skills)\n' +
//         '2. The `limit` parameter in runRead signature has wrong type (should be `number | null` not just `null`)\n' +
//         '3. Error handling could be improved\n' +
//         '4. No validation of tool inputs\n' +
//         '\n' +
//         '**Performance Issues:**\n' +
//         '1. Reading entire file into memory then slicing - could stream large files\n' +
//         "2. No caching of skills - they're loaded once at startup which is good\n" +
//         '3. Slicing to 50000 bytes might break multi-byte characters\n' +
//         '\n' +
//         '**Maintainability Issues:**\n' +
//         '1. Using `any` types reduces type safety benefits\n' +
//         '2. Some functions are long (runOneTurn)\n' +
//         '3. Comments are good but some sections could use more explanation\n' +
//         '4. Magic numbers (50000, 120000, 2000) should be constants\n' +
//         '\n' +
//         '**Testing:**\n' +
//         '- No tests visible in this file\n' +
//         '\n' +
//         'Let me provide a comprehensive review.'
//     }
//   ],
//   stop_reason: 'end_turn',
//   stop_sequence: null,
//   usage: { input_tokens: 4042, output_tokens: 2034 }
// }
// ## Code Review: index.ts

// ### Summary
// This is a CLI-based AI coding agent that implements a skill-loading system with two-layer knowledge (metadata in system prompt, full content on-demand). The code demonstrates good architecture but has several security and type safety concerns that should be addressed.

// ---

// ### Critical Issues

// 1. **Command Injection Vulnerability** (line 165-177)
//    - **Impact**: The `runBash` function executes arbitrary shell commands without any sanitization or validation. Malicious user input could execute dangerous commands.
//    - **Fix**: 
//    ```typescript
//    async function runBash(command: string): Promise<string> {
//      // Add command validation/whitelist
//      const BLOCKED_PATTERNS = [/\brm\s+-rf/, /\bsudo\b/, /\bchmod\b/];
//      for (const pattern of BLOCKED_PATTERNS) {
//        if (pattern.test(command)) {
//          return `Error: Blocked potentially dangerous command`;
//        }
//      }
     
//      try {
//        const result = await execAsync(command, {
//          cwd: process.cwd(),
//          timeout: 120000,
//          // Consider adding maxBuffer limit
//          maxBuffer: 10 * 1024 * 1024, // 10MB
//        });
//        // ... rest of code
//      }
//    }
//    ```

// 2. **Type Safety Issues** (multiple lines)
//    - **Impact**: Using `any` type extensively defeats TypeScript's type checking, leading to potential runtime errors.
//    - **Locations**:
//      - Line 75: `private skills: Record<string, any>`
//      - Line 84: `_findSkillFiles(dir:any)`
//      - Line 178: `err: any`
//      - Line 195: `content: any`
//      - Line 238: `messages as any`
//    - **Fix**: Define proper interfaces:
//    ```typescript
//    interface Skill {
//      meta: SkillMeta;
//      body: string;
//      path: string;
//    }
   
//    interface SkillMeta {
//      name?: string;
//      description?: string;
//      tags?: string;
//    }
   
//    interface ContentBlock {
//      type: string;
//      text?: string;
//      name?: string;
//      input?: any;
//      id?: string;
//    }
//    ```

// 3. **Unsafe File Operations** (lines 121-128)
//    - **Impact**: The `runRead` function slices to 50000 bytes which might break multi-byte UTF-8 characters.
//    - **Fix**: 
//    ```typescript
//    async function runRead(filePath: string, limit: number | null = null) {
//      try {
//        const text = await fs.readFile(safePath(filePath), "utf8");
//        let lines = text.split(/\r?\n/);
   
//        if (limit && limit < lines.length) {
//          lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
//        }
   
//        const result = lines.join("\n");
//        // Ensure we don't cut in middle of multi-byte character
//        const buffer = Buffer.from(result, 'utf8');
//        if (buffer.length > 50000) {
//          return buffer.slice(0, 50000).toString('utf8');
//        }
//        return result;
//      } catch (e: unknown) {
//        const error = e as Error;
//        return `Error: ${error.message}`;
//      }
//    }
//    ```

// 4. **Missing Input Validation** (line 165-177)
//    - **Impact**: Tool inputs are not validated before use.
//    - **Fix**: Add input validation:
//    ```typescript
//    import { z } from 'zod'; // or use manual validation
   
//    const ReadFileSchema = z.object({
//      path: z.string().min(1),
//      limit: z.number().positive().optional()
//    });
//    ```

// ---

// ### Improvements

// 1. **Magic Numbers** (multiple lines)
//    - Define constants for magic numbers:
//    ```typescript
//    const MAX_FILE_SIZE = 50000;
//    const COMMAND_TIMEOUT = 120000;
//    const MAX_TOKENS = 2000;
//    ```

// 2. **Error Handling** (lines 120-150)
//    - Improve error typing:
//    ```typescript
//    } catch (e: unknown) {
//      const error = e as Error;
//      return `Error: ${error.message}`;
//    }
//    ```

// 3. **Path Validation** (lines 100-113)
//    - The `safePath` function is good but could be enhanced:
//    ```typescript
//    function safePath(p: string): string {
//      if (!p || typeof p !== 'string') {
//        throw new Error('Invalid path provided');
//      }
     
//      const resolved = path.resolve(WORKDIR, p);
//      const workspace = path.resolve(WORKDIR);
   
//      const relative = path.relative(workspace, resolved);
//      if (relative.startsWith("..") || path.isAbsolute(relative)) {
//        throw new Error(`Path escapes workspace: ${p}`);
//      }
   
//      return resolved;
//    }
//    ```

// 4. **Function Length** (lines 244-278)
//    - The `runOneTurn` function could be split into smaller functions:
//    ```typescript
//    function extractToolCalls(content: any[]): ToolCall[] {
//      return content.filter(block => block.type === "tool_use");
//    }
   
//    async function executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
//      // ...
//    }
//    ```

// 5. **Resource Cleanup** (lines 290-307)
//    - The readline interface should be closed in a `finally` block:
//    ```typescript
//    async function main() {
//      const rl = readline.createInterface({
//        input: stdin,
//        output: stdout,
//      });
   
//      try {
//        const messages: Message[] = [];
//        // ... main loop
//      } finally {
//        rl.close();
//      }
//    }
//    ```

// 6. **Environment Variable Validation** (lines 26-31)
//    - Add validation for required environment variables:
//    ```typescript
//    if (!process.env.ANTHROPIC_API_KEY) {
//      throw new Error('ANTHROPIC_API_KEY environment variable is required');
//    }
   
//    const client = new Anthropic({
//      apiKey: process.env.ANTHROPIC_API_KEY,
//      baseURL: process.env.ANTHROPIC_BASE_URL,
//    });
//    ```

// ---

// ### Positive Notes

// ✅ Good architecture with clear separation of concerns (SkillLoader, tools, handlers)  
// ✅ Proper use of async/await throughout  
// ✅ Good path traversal protection in `safePath`  
// ✅ Two-layer skill loading pattern is elegant and efficient  
// ✅ Proper error handling in most file operations  
// ✅ Clean use of TypeScript type annotations in function signatures  
// ✅ Good use of `promisify` for converting callback-style functions  
// ✅ Clear and descriptive function names  

// ---

// ### Security Audit Recommendations

// 1. Run `npm audit` to check for vulnerable dependencies
// 2. Consider adding rate limiting for tool calls
// 3. Add logging for security-sensitive operations (bash commands, file writes)
// 4. Consider sandboxing bash commands in a containerized environment
// 5. Add input sanitization for all tool parameters

// ---

// ### Testing Recommendations

// 1. Add unit tests for:
//    - `safePath` function (edge cases: `../`, absolute paths, symlinks)
//    - SkillLoader methods
//    - All tool handlers with mock file system
//    - Error handling paths

// 2. Add integration tests for:
//    - Full conversation flow
//    - Tool execution sequences
//    - Error recovery

// ---

// ### Verdict

// ⚠️ **Needs major revision**

// **Priority Fixes:**
// 1. **Critical**: Add command validation in `runBash` to prevent command injection
// 2. **Critical**: Replace `any` types with proper TypeScript interfaces
// 3. **High**: Add input validation for all tool handlers
// 4. **High**: Fix multi-byte character handling in file reading
// 5. **Medium**: Add environment variable validation on startup

// The code has a solid architecture and good practices in many areas, but the security vulnerabilities and type safety issues must be addressed before this can be considered production-ready. The command injection vulnerability is particularly concerning for a tool that executes shell commands.