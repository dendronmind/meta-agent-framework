import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const daemonScript = path.resolve("daemon/daemon.mjs");
const localToken = "maf-client-persistent-screen-test-token-0123456789";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function daemonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function screenExists(screenDir, screenName) {
  try {
    const output = execFileSync("screen", ["-ls", screenName], {
      encoding: "utf-8",
      env: { ...process.env, SCREENDIR: screenDir },
    });
    return output.includes(screenName);
  } catch {
    return false;
  }
}

test("Codex detached tasks reuse one persistent screen per agent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "maf-codex-persistent-screen-"));
  const mafHome = path.join(root, "maf-home");
  const projectDir = path.join(root, "project");
  const screenDir = path.join(root, "screen");
  const fakeCodex = path.join(root, "fake-codex.mjs");
  const fakeLog = path.join(root, "fake-codex.log");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(screenDir, { recursive: true, mode: 0o700 });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const logFile = process.env.FAKE_CODEX_LOG;
const resultFile = process.env.FAKE_CODEX_RESULT;
function report(prompt) {
  const match = String(prompt).match(/node "([^"\\n]*maf-codex-report-[^"\\n]+\\.mjs)" completed/);
  if (!match) return;
  writeFileSync(resultFile, "persistent fake codex completed\\n");
  spawnSync(process.execPath, [match[1], "completed", resultFile], { stdio: "ignore", env: process.env });
  appendFileSync(logFile, "report:" + (prompt.match(/task_id: ([^\\n]+)/)?.[1] || "unknown") + "\\n");
}
const initial = process.argv.slice(2).join(" ");
appendFileSync(logFile, "start\\n");
report(initial);
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  const end = buffer.indexOf("\\x1b[201~");
  if (end < 0) return;
  const start = buffer.lastIndexOf("\\x1b[200~", end);
  if (start >= 0) report(buffer.slice(start + 6, end));
  buffer = buffer.slice(end + 6);
});
setInterval(() => {}, 1000);
`, "utf-8");
  chmodSync(fakeCodex, 0o700);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemon = spawn(process.execPath, [daemonScript], {
    cwd: projectDir,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: mafHome,
      MAF_HOME: mafHome,
      MAF_DIRECTORY: projectDir,
      MAF_NODE_PORT: String(port),
      MAF_LOCAL_TOKEN: localToken,
      META_AGENT_SERVER: "",
      MAF_CODEX_DELIVERY: "detached",
      MAF_CODEX_MODE: "tui",
      CODEX_BIN: fakeCodex,
      SCREENDIR: screenDir,
      FAKE_CODEX_LOG: fakeLog,
      FAKE_CODEX_RESULT: path.join(root, "result.md"),
      MAF_TEST_ALLOW_LOCAL_EXECUTE: "1",
    },
  });
  const screenName = "maf-codex-persistent_screen_test_agent";

  try {
    await waitFor(async () => {
      try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
    }, "daemon did not become healthy");
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "persistent_screen_test_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });

    for (const [taskId, title] of [["persistent-task-1", "first"], ["persistent-task-2", "second"]]) {
      await daemonRequest(baseUrl, "/execute", {
        method: "POST",
        body: JSON.stringify({
          agent_name: "persistent_screen_test_agent",
          target_agent: "persistent_screen_test_agent",
          runtime: "codex",
          task_id: taskId,
          title,
          description: `persistent screen ${title}`,
          delivery_mode: "detached",
        }),
      });
      await waitFor(() => {
        try {
          return readFileSync(fakeLog, "utf-8").includes(`report:${taskId}`);
        } catch { return false; }
      }, `${taskId} was not reported`);
      assert.equal(screenExists(screenDir, screenName), true, `${taskId} should leave screen alive`);
    }

    const log = readFileSync(fakeLog, "utf-8");
    assert.equal((log.match(/^start$/gm) || []).length, 1, "Codex TUI should start once");
    assert.equal((log.match(/^report:/gm) || []).length, 2, "both tasks should report");
  } finally {
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise(resolve => daemon.once("exit", resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
