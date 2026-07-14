#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook：禁止 Meta-Agent-Server 修改框架托管资产
 * 
 * stdin: JSON { tool_name, tool_input: { file_path, ... } }
 * exit 0: 放行
 * exit 2: 拒绝（stderr 显示给 agent）
 */

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "create_file", "edit_file", "write"];

function isManagedAsset(filePath) {
  if (!filePath) return false;
  return filePath.includes("/.opencode/")
    || filePath.includes("/.claude/")
    || filePath.includes("/common_agent/")
    || filePath.endsWith("/AGENTS.md")
    || filePath.endsWith("/CLAUDE.md")
    || filePath.endsWith("/opencode.json");
}

function suggestUserPath(filePath) {
  return filePath
    .replace(/\/\.opencode\//, "/user/")
    .replace(/\/\.claude\//, "/user/")
    .replace(/\/common_agent\//, "/user/");
}

let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || "";
    const filePath = input.tool_input?.file_path || input.tool_input?.filePath || "";

    // 只拦截写入类工具
    if (WRITE_TOOLS.some(t => toolName.includes(t)) && isManagedAsset(filePath)) {
      const suggested = suggestUserPath(filePath);
      process.stderr.write(
        `禁止修改框架托管资产（升级会覆盖）。请将内容写入 user/ 目录，例如: ${suggested}\n`
      );
      process.exit(2);
    }
  } catch {}

  process.exit(0);
});
