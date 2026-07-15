#!/usr/bin/env node
/**
 * MAF 一键配置初始化
 *
 * 用法：
 *   node scripts/maf-init.mjs server   # 配置 Server（部署 Server 的机器）
 *   node scripts/maf-init.mjs client   # 配置 Client（Agent 运行的机器）
 *   node scripts/maf-init.mjs --check  # 检查当前配置
 *
 * 生成 ~/.meta-agent-framework/maf.config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

const STATE_DIR = join(homedir(), ".meta-agent-framework");
const CONFIG_PATH = join(STATE_DIR, "maf.config.json");

// ============================================================
// 工具
// ============================================================

function getLocalIP() {
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (!iface.internal && iface.family === "IPv4") return iface.address;
      }
    }
  } catch {}
  return "127.0.0.1";
}

function readConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {}
  return null;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

/** 必填项：用户不输入就反复问 */
async function askRequired(question, hint = "", defaultVal = "") {
  while (true) {
    if (hint) console.log(`     ${hint}`);
    const answer = await ask(question, defaultVal);
    if (answer) return answer;
    console.log("     ⚠ 此项为必填，不能跳过\n");
  }
}

const SERVER_RUNTIME_ALIASES = {
  opencode: "opencode",
  claude: "claude",
  "claude-code": "claude",
  cc: "claude",
  codex: "codex",
};

function normalizeServerRuntime(runtime) {
  return SERVER_RUNTIME_ALIASES[String(runtime || "").trim().toLowerCase()] || "";
}

function missingRequiredFields(cfg, targetMode) {
  const missing = [];
  if (!cfg) return missing;

  if (targetMode === "server") {
    if (!cfg.server?.url) missing.push("server.url");
    if (!normalizeServerRuntime(cfg.server?.runtime)) missing.push("server.runtime");
    const registryType = cfg.registry?.type || (cfg.feishu?.app_id ? "feishu" : "none");
    if (registryType === "feishu") {
      if (!cfg.feishu?.app_id) missing.push("feishu.app_id");
      if (!cfg.feishu?.app_secret) missing.push("feishu.app_secret");
      if (!cfg.feishu?.bitable?.app_token) missing.push("feishu.bitable.app_token");
      if (!cfg.feishu?.bitable?.table_id) missing.push("feishu.bitable.table_id");
    }
  } else if (targetMode === "client") {
    if (!cfg.server?.url) missing.push("server.url");
  }

  return missing;
}

function printHelp() {
  console.log("");
  console.log("用法：");
  console.log("  maf-server init        初始化 / 重写 Server 配置");
  console.log("  node scripts/maf-init.mjs server   部署 Server 的机器上运行");
  console.log("  node scripts/maf-init.mjs client   Agent 运行的机器上运行");
  console.log("  node scripts/maf-init.mjs --check  查看当前配置");
  console.log("");
  console.log("说明：");
  console.log("  Server 是中控节点，负责调度和管理所有 Agent");
  console.log("  Client 是 Agent 运行的机器，接收 Server 分发的任务");
  console.log("  一台机器可以同时是 Server 和 Client");
  console.log("");
}

// ============================================================
// --check 模式
// ============================================================

if (process.argv.includes("--check")) {
  const cfg = readConfig();
  if (!cfg) {
    console.log("\n  ❌ 未找到配置文件: " + CONFIG_PATH);
    console.log("     运行 maf-server init 或 node scripts/maf-init.mjs server/client 进行初始化\n");
    process.exit(1);
  }

  console.log("\n  📋 当前配置 (" + CONFIG_PATH + ")\n");
  console.log(`  角色: ${cfg.role || "(未设置)"}`);
  console.log(`  Server URL:   ${cfg.server?.url || "(未设置)"}`);
  console.log(`  Server 端口:  ${cfg.server?.port || 3000}`);
  if (cfg.role === "server" || cfg.server?.runtime) {
    console.log(`  Server Runtime: ${cfg.server?.runtime || "(未设置)"}`);
  }
  console.log(`  Daemon 端口:  ${cfg.daemon?.port || 4100}`);

  const registryType = cfg.registry?.type || (cfg.feishu?.app_id ? 'feishu' : 'none');
  console.log(`  注册表类型:   ${registryType}`);
  if (registryType === 'feishu') {
    console.log(`    app_id:     ${cfg.feishu.app_id.substring(0, 10)}...`);
    console.log(`    app_secret: ${cfg.feishu?.app_secret ? "***已设置***" : "(未设置)"}`);
    console.log(`    bitable:    ${cfg.feishu?.bitable?.app_token || "(未设置)"}`);
  }

  const missing = [];
  if (!cfg.server?.url) missing.push("server.url");
  if (cfg.role === "server" && !cfg.server?.runtime) missing.push("server.runtime");
  if (missing.length > 0) {
    console.log(`\n  ⚠ 缺少必填项: ${missing.join(", ")}`);
  } else {
    console.log("\n  ✅ 配置完整");
  }
  console.log("");
  rl.close();
  process.exit(0);
}

// ============================================================
// 确定模式
// ============================================================

const mode = process.argv.find(a => a === "server" || a === "client");
if (!mode) {
  printHelp();
  rl.close();
  process.exit(0);
}

const existing = readConfig();

console.log("");
console.log("╔══════════════════════════════════════════╗");
if (mode === "server") {
  console.log("║    Meta-Agent Server 配置                ║");
} else {
  console.log("║    Meta-Agent Client 配置                ║");
}
console.log("╚══════════════════════════════════════════╝");
console.log("");

if (existing) {
  console.log(`  ℹ 已有配置文件: ${CONFIG_PATH}`);
  const missing = missingRequiredFields(existing, mode);
  const isSameRole = !existing.role || existing.role === mode;
  if (isSameRole && missing.length > 0) {
    console.log(`  ⚠ 检测到配置未完成，缺少必填项: ${missing.join(", ")}`);
    console.log("     将继续完整配置流程，不需要确认覆盖。\n");
  } else {
    const overwrite = await ask("  覆盖？(y/N)", "N");
    if (overwrite.toLowerCase() !== "y") {
      console.log("  取消\n");
      rl.close();
      process.exit(0);
    }
    console.log("");
  }
}

// ============================================================
// Server 模式
// ============================================================

let serverUrl = "";
let serverPort = 3000;
let daemonPort = existing?.daemon?.port || 4100;

if (mode === "server") {
  const localIP = getLocalIP();

  // --- Server 端口 ---
  console.log("  📡 Server 配置\n");
  console.log("     Server 是中控节点，其他机器的 Agent 会通过这个地址连接过来。");
  console.log(`     探测到本机 IP: ${localIP}\n`);

  serverPort = parseInt(await ask("  Server 监听端口", String(existing?.server?.port || 3000))) || 3000;
  serverUrl = `http://${localIP}:${serverPort}`;
  console.log(`\n     ✅ Server 地址: ${serverUrl}\n`);

  // --- Daemon ---
  console.log("  🔧 Node Daemon 配置\n");
  console.log("     Daemon 是本机的常驻代理进程，管理本机所有 Agent 的注册和任务路由。");
  console.log("     如果这台机器也要运行 Agent，需要一个 Daemon。\n");

  daemonPort = parseInt(await ask("  Daemon 端口", String(existing?.daemon?.port || 4100))) || 4100;
  console.log("");

  // --- 外部注册表 ---
  const hasExistingFeishu = existing?.feishu?.app_id || existing?.registry?.type === 'feishu';
  const feishuDefault = hasExistingFeishu ? "Y" : "N";
  console.log("  📊 外部注册表（可选）\n");
  console.log("     启用后，Agent 注册信息会双向同步到外部数据源（如飞书多维表格）。");
  console.log("     不启用也完全可用——Agent 通过 Daemon 动态自注册管理。\n");

  const enableFeishu = await ask("  启用飞书多维表格作为外部注册表？(y/N)", feishuDefault);

  let registryType = "none";
  let feishuAppId = "", feishuAppSecret = "", feishuApiUrl = "https://open.feishu.cn/open-apis";
  let bitableAppToken = "", bitableTableId = "", bitableViewId = "";

  if (enableFeishu.toLowerCase() === "y") {
    registryType = "feishu";
    console.log("\n     需要一个飞书自建应用的凭证（在飞书开放平台创建）。\n");
    feishuAppId = await askRequired("  飞书 App ID", "启用飞书注册表时必填。", existing?.feishu?.app_id || "");
    feishuAppSecret = await askRequired("  飞书 App Secret", "启用飞书注册表时必填。", existing?.feishu?.app_secret || "");
    feishuApiUrl = await ask("  飞书 API URL", existing?.feishu?.api_url || "https://open.feishu.cn/open-apis");
    console.log("\n     Agent 注册表的飞书多维表格地址（URL 中可找到以下 ID）。\n");
    bitableAppToken = await askRequired("  Bitable App Token", "启用飞书注册表时必填。", existing?.feishu?.bitable?.app_token || "");
    bitableTableId = await askRequired("  Bitable Table ID", "启用飞书注册表时必填。", existing?.feishu?.bitable?.table_id || "");
    bitableViewId = await ask("  Bitable View ID", existing?.feishu?.bitable?.view_id || "");
  } else {
    console.log("     跳过，使用纯自注册模式\n");
  }

  // --- AI Runtime ---
  console.log("  🤖 AI Runtime 配置\n");
  console.log("     Server Agent 需要一个 AI Runtime 来运行交互界面。");
  console.log("     支持 opencode、Claude Code 和 Codex。");
  console.log("     Runtime 是首次运行必须明确选择的选项，不会默认使用 opencode。\n");

  const detectedRuntimes = [];
  let detectedRuntime = "";
  try { execSync("which opencode", { stdio: "pipe" }); detectedRuntime = "opencode"; } catch {}
  if (detectedRuntime) detectedRuntimes.push(detectedRuntime);
  try { execSync("which claude", { stdio: "pipe" }); detectedRuntimes.push("claude"); } catch {}
  try { execSync("which codex", { stdio: "pipe" }); detectedRuntimes.push("codex"); } catch {}
  if (detectedRuntimes.length > 0) {
    console.log(`     已检测到: ${detectedRuntimes.join(", ")}（仅作提示，不作为默认值）\n`);
  } else {
    console.log("     未检测到已安装 Runtime；仍可先选择，后续再安装对应 CLI。\n");
  }

  const runtimeDefault = normalizeServerRuntime(existing?.server?.runtime);
  let runtime = "";
  while (!runtime) {
    const runtimeAnswer = (await ask("  Runtime (必选: opencode/claude/codex)", runtimeDefault)).toLowerCase();
    runtime = normalizeServerRuntime(runtimeAnswer);
    if (!runtime) {
      console.log("     ⚠ Runtime 为必选项，请输入 opencode、claude 或 codex\n");
    }
  }
  console.log(`\n     ✅ Runtime: ${runtime}\n`);

  // --- 生成配置 ---
  const config = {
    role: "server",
    server: { url: serverUrl, port: serverPort, runtime },
    daemon: { port: daemonPort },
    registry: { type: registryType },
    feishu: {
      app_id: feishuAppId, app_secret: feishuAppSecret, api_url: feishuApiUrl,
      bitable: { app_token: bitableAppToken, table_id: bitableTableId, view_id: bitableViewId },
    },
  };

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`  ✅ 配置已写入: ${CONFIG_PATH}\n`);

  // bashrc
  await setupBashrc(serverUrl, daemonPort);

  console.log("");
  console.log("  🎉 Server 配置完成！");
  console.log("");
  console.log("     启动 Server:  maf-server start");
  console.log("     查看状态:     maf-server status");
  console.log(`     Client 连接:  其他机器运行 node scripts/maf-init.mjs client，输入 ${serverUrl}`);
  console.log("");
}

// ============================================================
// Client 模式
// ============================================================

if (mode === "client") {
  console.log("  📡 连接到 Server\n");
  console.log("     Client 需要知道 Server 的地址才能注册 Agent 和接收任务。");
  console.log("     格式: http://<Server机器的IP>:<端口>，例如 http://192.168.1.100:3000");
  console.log("     （这个地址在 Server 机器上运行 maf-server init 时会显示）\n");

  serverUrl = await askRequired("  Server 地址", "例如: http://192.168.1.100:3000");

  // 验证格式
  try {
    const u = new URL(serverUrl);
    if (!u.hostname || !u.port) throw new Error();
    serverPort = parseInt(u.port);
  } catch {
    console.log("     ⚠ 地址格式可能有误，建议格式: http://IP:端口");
  }

  // 验证连通性
  console.log(`\n     正在测试连接 ${serverUrl} ...`);
  let serverOk = false;
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`     ✅ 连接成功！Server 版本: ${data.server_version || "unknown"}\n`);
      serverOk = true;
    } else {
      console.log(`     ⚠ Server 返回 ${res.status}，可能还没启动\n`);
    }
  } catch {
    console.log("     ⚠ 无法连接，请确认 Server 已启动且网络可达\n");
  }

  if (!serverOk) {
    const proceed = await ask("  继续配置？(Y/n)", "Y");
    if (proceed.toLowerCase() === "n") {
      console.log("  取消\n");
      rl.close();
      process.exit(0);
    }
    console.log("");
  }

  // --- Daemon ---
  console.log("  🔧 Node Daemon 配置\n");
  console.log("     Daemon 是本机的常驻代理进程，管理本机所有 Agent 的注册和任务路由。");
  console.log("     通常使用默认端口即可。\n");

  daemonPort = parseInt(await ask("  Daemon 端口", String(existing?.daemon?.port || 4100))) || 4100;
  console.log("");

  // --- 生成配置 ---
  const config = {
    role: "client",
    server: { url: serverUrl, port: serverPort },
    daemon: { port: daemonPort },
  };

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`  ✅ 配置已写入: ${CONFIG_PATH}\n`);

  // bashrc
  await setupBashrc(serverUrl, daemonPort);

  console.log("");
  console.log("  🎉 Client 配置完成！");
  console.log("");
  console.log("     启动 Agent: opencode --agent <agent名> / claude / codex");
  console.log("     查看配置:   node scripts/maf-init.mjs --check");
  console.log("");
}

rl.close();

// ============================================================
// bashrc 辅助
// ============================================================

async function setupBashrc(serverUrl, daemonPort) {
  const bashrc = join(homedir(), ".bashrc");
  let bashrcContent = "";
  try { bashrcContent = readFileSync(bashrc, "utf-8"); } catch {}

  const envHints = [];
  if (!bashrcContent.includes("META_AGENT_SERVER")) {
    envHints.push(`export META_AGENT_SERVER=${serverUrl}`);
  }
  if (!bashrcContent.includes("MAF_NODE_PORT")) {
    envHints.push(`export MAF_NODE_PORT=${daemonPort}`);
  }
  if (!bashrcContent.includes("alias opencode=")) {
    envHints.push("alias opencode='opencode --hostname localhost'");
  }

  if (envHints.length > 0) {
    console.log("  💡 以下环境变量需要添加到 ~/.bashrc：\n");
    for (const hint of envHints) {
      console.log(`     ${hint}`);
    }
    console.log("");
    const addToBashrc = await ask("  自动添加到 ~/.bashrc？(Y/n)", "Y");
    if (addToBashrc.toLowerCase() !== "n") {
      const lines = envHints.map(l => l + "\n").join("");
      try {
        appendFileSync(bashrc, "\n# Meta-Agent-Framework\n" + lines);
        console.log("  ✅ 已添加到 ~/.bashrc（重新打开终端或 source ~/.bashrc 生效）");
      } catch (e) {
        console.log("  ⚠ 写入失败: " + e.message);
      }
    }
  }
}
