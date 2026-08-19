import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const daemonScript = path.resolve("daemon/daemon.mjs");
const localToken = "maf-client-standby-test-token-0123456789abcdef";

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

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`daemon exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("daemon did not become healthy");
}

function startDaemon({ mafHome, projectDir, port }) {
  return spawn(process.execPath, [daemonScript], {
    cwd: projectDir,
    stdio: "ignore",
    env: {
      ...process.env,
      MAF_HOME: mafHome,
      MAF_DIRECTORY: projectDir,
      MAF_NODE_PORT: String(port),
      MAF_LOCAL_TOKEN: localToken,
      MAF_CODEX_DELIVERY: "auto",
      META_AGENT_SERVER: "http://127.0.0.1:9",
    },
  });
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
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

test("Codex disconnect becomes standby and survives daemon restart", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-client-standby-"));
  const mafHome = path.join(testRoot, "maf-home");
  const projectDir = path.join(testRoot, "source");
  mkdirSync(projectDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let daemon = startDaemon({ mafHome, projectDir, port });

  try {
    await waitForHealth(baseUrl, daemon);
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({
        agent_name: "standby_test_agent",
        runtime: "codex",
        directory: projectDir,
        plugin_pid: process.pid,
      }),
    });

    const disconnected = await daemonRequest(baseUrl, "/agents/disconnect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "standby_test_agent", plugin_pid: process.pid }),
    });
    assert.equal(disconnected.retained, true);
    assert.equal(disconnected.status, "standby");

    const beforeRestart = await daemonRequest(baseUrl, "/agents");
    assert.equal(beforeRestart.agents[0]?.agent_name, "standby_test_agent");
    assert.equal(beforeRestart.agents[0]?.status, "standby");

    const inventory = JSON.parse(readFileSync(path.join(mafHome, "state", "agent-inventory.json"), "utf-8"));
    assert.deepEqual(inventory.agents, [{
      agent_name: "standby_test_agent",
      runtime: "codex",
      directory: projectDir,
    }]);

    await stopDaemon(daemon);
    daemon = startDaemon({ mafHome, projectDir, port });
    await waitForHealth(baseUrl, daemon);

    const afterRestart = await daemonRequest(baseUrl, "/agents");
    assert.equal(afterRestart.agents[0]?.agent_name, "standby_test_agent");
    assert.equal(afterRestart.agents[0]?.status, "standby");
  } finally {
    await stopDaemon(daemon);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex agent with a missing source directory is not dispatchable", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-client-missing-source-"));
  const mafHome = path.join(testRoot, "maf-home");
  const projectDir = path.join(testRoot, "daemon-cwd");
  const missingDir = path.join(testRoot, "missing-source");
  mkdirSync(projectDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemon = startDaemon({ mafHome, projectDir, port });

  try {
    await waitForHealth(baseUrl, daemon);
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({
        agent_name: "missing_source_agent",
        runtime: "codex",
        directory: missingDir,
        plugin_pid: process.pid,
      }),
    });
    const agents = await daemonRequest(baseUrl, "/agents");
    assert.equal(agents.agents[0]?.status, "offline");
  } finally {
    await stopDaemon(daemon);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
