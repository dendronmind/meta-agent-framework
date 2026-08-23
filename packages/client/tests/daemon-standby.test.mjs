import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function startDaemon({ mafHome, projectDir, port, env = {} }) {
  return spawn(process.execPath, [daemonScript], {
    cwd: projectDir,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: mafHome,
      MAF_HOME: mafHome,
      MAF_DIRECTORY: projectDir,
      MAF_NODE_PORT: String(port),
      MAF_LOCAL_TOKEN: localToken,
      MAF_CODEX_DELIVERY: "auto",
      META_AGENT_SERVER: "http://127.0.0.1:9",
      ...env,
    },
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
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

test("formal Execution edits the registered repository and pushes one Gerrit-style commit through a non-origin remote", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-client-direct-repository-"));
  const mafHome = path.join(testRoot, "maf-home");
  const projectDir = path.join(testRoot, "source");
  const remoteDir = path.join(testRoot, "remote.git");
  const fakeCodex = path.join(testRoot, "fake-codex");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "MAF Test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "maf-test@example.com"], { cwd: projectDir });
  writeFileSync(path.join(projectDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir });
  execFileSync("git", ["remote", "add", "auto", remoteDir], { cwd: projectDir });
  execFileSync("git", ["push", "-u", "auto", "main"], { cwd: projectDir });
  mkdirSync(path.join(projectDir, ".codex", "agents"), { recursive: true });
  writeFileSync(path.join(projectDir, ".git", "info", "exclude"), ".codex/\n");
  writeFileSync(path.join(projectDir, ".codex", "agents", "direct_agent.toml"), [
    'name = "direct_agent"',
    'description = "direct repository test"',
    'target_branch = "main"',
    'remote_name = "auto"',
    '',
  ].join("\n"));
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -e
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
cat >/dev/null
printf 'agent change\\n' >> README.md
git add README.md
git commit -m $'fix: direct repository test\\n\\nChange-Id: I1234567890abcdef1234567890abcdef12345678'
printf '## 执行摘要\\n\\n已修改并测试。\\n' > "$out"
`);
  chmodSync(fakeCodex, 0o755);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemon = startDaemon({ mafHome, projectDir, port, env: { CODEX_BIN: fakeCodex, MAF_TEST_ALLOW_LOCAL_EXECUTE: "1" } });
  try {
    await waitForHealth(baseUrl, daemon);
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "direct_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });
    await daemonRequest(baseUrl, "/execute", {
      method: "POST",
      body: JSON.stringify({
        agent_name: "direct_agent", target_agent: "direct_agent", runtime: "codex",
        execution_id: "node-direct-1", workflow_id: "workflow-direct-1", node_id: "step-1",
        title: "direct repository", description: "modify the source",
        run_context: {
          execution_id: "framework-direct-1", request_id: "request-direct-1", external_id: "CASE-1",
          source_type: "test", source_ref: "test://1", workdir_policy: "direct_repository",
          artifacts: [], metadata: {},
        },
      }),
    });
    await waitFor(() => {
      try { return Boolean(execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "refs/for/main"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
      catch { return false; }
    }, "Gerrit-style ref was not created");
    await waitFor(() => execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf-8" }).trim() === "main", "repository branch was not restored");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");
    assert.equal(execFileSync("git", ["--git-dir", remoteDir, "rev-list", "--count", "refs/heads/main..refs/for/main"], { encoding: "utf-8" }).trim(), "1");
  } finally {
    await stopDaemon(daemon);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an existing task branch is preserved and forces read-only execution", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-client-existing-task-branch-"));
  const mafHome = path.join(testRoot, "maf-home");
  const projectDir = path.join(testRoot, "source");
  const remoteDir = path.join(testRoot, "remote.git");
  const fakeCodex = path.join(testRoot, "fake-codex");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "MAF Test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "maf-test@example.com"], { cwd: projectDir });
  writeFileSync(path.join(projectDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir });
  execFileSync("git", ["remote", "add", "auto", remoteDir], { cwd: projectDir });
  execFileSync("git", ["push", "-u", "auto", "main"], { cwd: projectDir });
  mkdirSync(path.join(projectDir, ".codex", "agents"), { recursive: true });
  writeFileSync(path.join(projectDir, ".git", "info", "exclude"), ".codex/\n");
  writeFileSync(path.join(projectDir, ".codex", "agents", "collision_agent.toml"), [
    'name = "collision_agent"',
    'description = "existing task branch test"',
    'target_branch = "main"',
    'remote_name = "auto"',
    '',
  ].join("\n"));
  execFileSync("git", ["branch", "maf/COLLISION-ABCDEFGH"], { cwd: projectDir });
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -e
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
cat >/dev/null
printf '## 执行摘要\\n\\n只读分析。\\n' > "$out"
`);
  chmodSync(fakeCodex, 0o755);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemon = startDaemon({ mafHome, projectDir, port, env: { CODEX_BIN: fakeCodex, MAF_TEST_ALLOW_LOCAL_EXECUTE: "1" } });
  try {
    await waitForHealth(baseUrl, daemon);
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "collision_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });
    await daemonRequest(baseUrl, "/execute", {
      method: "POST",
      body: JSON.stringify({
        agent_name: "collision_agent", target_agent: "collision_agent", runtime: "codex",
        execution_id: "node-collision-1", workflow_id: "workflow-collision-1", node_id: "step-1",
        title: "existing task branch", description: "read only", run_context: {
          execution_id: "ABCDEFGH-collision-1", request_id: "request-collision-1", external_id: "COLLISION",
          source_type: "test", source_ref: "test://collision", workdir_policy: "direct_repository",
          artifacts: [], metadata: {},
        },
      }),
    });
    const resultPath = path.join(mafHome, "executions", "ABCDEFGH-collision-1", "output", "result.md");
    try {
      await waitFor(() => existsSync(resultPath), "read-only execution did not finish");
    } catch (err) {
      const daemonLog = existsSync(path.join(mafHome, "logs", "client-daemon.log"))
        ? readFileSync(path.join(mafHome, "logs", "client-daemon.log"), "utf-8") : "";
      throw new Error(`${err.message}\n${daemonLog}`);
    }
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf-8" }).trim(), "main");
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/maf/COLLISION-ABCDEFGH"], { cwd: projectDir, encoding: "utf-8" }).trim(), execFileSync("git", ["rev-parse", "main"], { cwd: projectDir, encoding: "utf-8" }).trim());
    assert.throws(() => execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "refs/for/main"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  } finally {
    await stopDaemon(daemon);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("cancelling a running formal Execution terminates its process and restores the registered repository", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-client-cancel-execution-"));
  const mafHome = path.join(testRoot, "maf-home");
  const projectDir = path.join(testRoot, "source");
  const remoteDir = path.join(testRoot, "remote.git");
  const fakeCodex = path.join(testRoot, "fake-codex");
  const startedMarker = path.join(testRoot, "codex-started");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "MAF Test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "maf-test@example.com"], { cwd: projectDir });
  writeFileSync(path.join(projectDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir });
  execFileSync("git", ["remote", "add", "auto", remoteDir], { cwd: projectDir });
  execFileSync("git", ["push", "-u", "auto", "main"], { cwd: projectDir });
  mkdirSync(path.join(projectDir, ".codex", "agents"), { recursive: true });
  writeFileSync(path.join(projectDir, ".git", "info", "exclude"), ".codex/\n");
  writeFileSync(path.join(projectDir, ".codex", "agents", "cancel_agent.toml"), [
    'name = "cancel_agent"',
    'description = "cancellation test"',
    'target_branch = "main"',
    'remote_name = "auto"',
    '',
  ].join("\n"));
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -e
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
cat >/dev/null
touch "$MAF_TEST_CANCEL_MARKER"
sleep 30
printf 'late change\\n' >> README.md
git add README.md
git commit -m $'fix: must not be delivered\\n\\nChange-Id: Iabcdef1234567890abcdef1234567890abcdef12'
printf 'must not complete\\n' > "$out"
`);
  chmodSync(fakeCodex, 0o755);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemon = startDaemon({
    mafHome, projectDir, port,
    env: { CODEX_BIN: fakeCodex, MAF_TEST_ALLOW_LOCAL_EXECUTE: "1", MAF_TEST_CANCEL_MARKER: startedMarker },
  });
  try {
    await waitForHealth(baseUrl, daemon);
    await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "cancel_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });
    await daemonRequest(baseUrl, "/execute", {
      method: "POST",
      body: JSON.stringify({
        agent_name: "cancel_agent", target_agent: "cancel_agent", runtime: "codex",
        execution_id: "node-cancel-1", workflow_id: "workflow-cancel-1", node_id: "step-1",
        title: "cancel execution", description: "wait until cancelled",
        run_context: {
          execution_id: "framework-cancel-1", request_id: "request-cancel-1", external_id: "CASE-CANCEL",
          source_type: "test", source_ref: "test://cancel", workdir_policy: "direct_repository",
          artifacts: [], metadata: {},
        },
      }),
    });
    await waitFor(() => existsSync(startedMarker), "fake Codex did not start");
    const cancelled = await daemonRequest(baseUrl, "/cancel", {
      method: "POST",
      body: JSON.stringify({ execution_id: "node-cancel-1", framework_execution_id: "framework-cancel-1", reason: "test cancellation" }),
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.termination_confirmed, true);
    await waitFor(() => execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf-8" }).trim() === "main", "repository branch was not restored after cancellation");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");
    assert.throws(() => execFileSync("git", ["--git-dir", remoteDir, "show-ref", "--verify", "refs/for/main"], { stdio: "ignore" }));
  } finally {
    await stopDaemon(daemon);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
