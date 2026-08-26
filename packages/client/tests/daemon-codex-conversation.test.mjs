import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const daemonScript = path.resolve("daemon/daemon.mjs");
const mockCodex = path.resolve("../../scripts/mock-codex-app-server.mjs");
const localToken = "maf-client-codex-conversation-test-token-0123456789";

function requestTarget(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function signedHeaders(privateKey, method, url, body) {
  const timestamp = String(Date.now());
  const nonce = "conversation-test-" + Math.random().toString(36).slice(2) + "-" + Date.now();
  const digest = createHash("sha256").update(body || "").digest("hex");
  const canonical = Buffer.from([method.toUpperCase(), requestTarget(url), timestamp, nonce, digest].join("\n"));
  return {
    "Content-Type": "application/json",
    "X-MAF-Role": "server",
    "X-MAF-ID": "maf-server",
    "X-MAF-Timestamp": timestamp,
    "X-MAF-Nonce": nonce,
    "X-MAF-Signature": sign(null, canonical, privateKey).toString("base64url"),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function daemonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { Authorization: "Bearer " + localToken, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body };
}

test("Codex conversation bridge owns a stdio app-server and forwards live events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "maf-codex-conversation-"));
  const mafHome = path.join(root, "maf-home");
  const projectDir = path.join(root, "project");
  const wrapper = path.join(root, "mock-codex-bin");
  const screenWrapper = path.join(root, "screen");
  const screenLog = path.join(root, "screen.log");
  const rpcLog = path.join(root, "mock-codex-rpc.log");
  const serverKeyDir = path.join(mafHome, "auth");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(serverKeyDir, { recursive: true });
  const { privateKey: serverPrivate, publicKey: serverPublic } = generateKeyPairSync("ed25519");
  const serverPrivatePem = serverPrivate.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(path.join(serverKeyDir, "server-public.pem"), serverPublic.export({ type: "spki", format: "pem" }));
  writeFileSync(wrapper, "#!/usr/bin/env node\nimport " + JSON.stringify(mockCodex) + ";\n");
  chmodSync(wrapper, 0o700);
  writeFileSync(screenWrapper, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> " + JSON.stringify(screenLog) + "\nexit 1\n");
  chmodSync(screenWrapper, 0o700);

  const events = [];
  const workflowStarted = [];
  const workflowResults = [];
  let eventUploadsEnabled = true;
  const mockServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (req.url === "/api/auth/enroll") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "active", server_public_key: serverPublic.export({ type: "spki", format: "pem" }).toString() }));
      return;
    }
    if (req.url === "/api/clients/register" || req.url === "/api/clients/heartbeat") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, runtime_modes: { codex_delivery: "managed" } }));
      return;
    }
    if (req.url?.startsWith("/api/codex/conversations/") && req.url.endsWith("/events")) {
      if (!eventUploadsEnabled) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }
      try { events.push(...(JSON.parse(raw).events || [])); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: events.length }));
      return;
    }
    if (/^\/api\/workflows\/[^/]+\/nodes\/[^/]+\/started$/.test(req.url || "")) {
      workflowStarted.push({ url: req.url, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
      return;
    }
    if (/^\/api\/workflows\/[^/]+\/nodes\/[^/]+\/result$/.test(req.url || "")) {
      workflowResults.push({ url: req.url, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const serverPort = await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => resolve(mockServer.address().port));
  });
  const daemonPort = await freePort();
  const spawnDaemon = () => spawn(process.execPath, [daemonScript], {
    cwd: projectDir,
    stdio: "ignore",
    env: {
      ...process.env,
      PATH: root + path.delimiter + process.env.PATH,
      HOME: mafHome,
      MAF_HOME: mafHome,
      MAF_DIRECTORY: projectDir,
      MAF_NODE_PORT: String(daemonPort),
      MAF_LOCAL_TOKEN: localToken,
      META_AGENT_SERVER: "http://127.0.0.1:" + serverPort,
      CODEX_APP_SERVER_BIN: wrapper,
      MAF_CODEX_APP_SERVER_BIN: wrapper,
      MAF_CODEX_APP_SERVER_CMD: "",
      MOCK_CODEX_RPC_LOG: rpcLog,
      MOCK_CODEX_SLOW_TURN_DELAY_MS: "5000",
      MAF_CODEX_EVENT_RETRY_ATTEMPTS: "1",
    },
  });
  let daemon = spawnDaemon();
  const baseUrl = "http://127.0.0.1:" + daemonPort;
  try {
    await waitFor(async () => {
      try { return (await daemonRequest(baseUrl, "/health")).response.ok; } catch { return false; }
    }, "daemon did not become healthy");
    const connected = await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "conversation_test_agent", runtime: "codex", directory: projectDir }),
    });
    assert.equal(connected.response.ok, true, JSON.stringify(connected.body));
    await waitFor(() => readFileSync(path.join(serverKeyDir, "server-public.pem"), "utf-8").length > 0, "enrollment did not complete");
    const registeredAgent = await daemonRequest(baseUrl, "/agents");
    assert.equal(registeredAgent.body.agents[0]?.status, "standby");

    const conversationId = "conversation-test-00000001";
    const startUrl = baseUrl + "/codex/conversations/start";
    const startBody = JSON.stringify({ conversation_id: conversationId, agent_name: "conversation_test_agent", project_path: projectDir, approval_policy: "never", sandbox_mode: "danger-full-access" });
    const started = await fetch(startUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", startUrl, startBody), body: startBody });
    const startedBody = await started.json();
    assert.equal(started.status, 201, JSON.stringify(startedBody));
    assert.equal(startedBody.thread_id, "mock-thread-1");
    const onlineAgent = await daemonRequest(baseUrl, "/agents");
    assert.equal(onlineAgent.body.agents[0]?.status, "online");

    const turnUrl = baseUrl + "/codex/conversations/turn";
    const turnBody = JSON.stringify({ conversation_id: conversationId, maf_turn_id: "maf-turn-00000001", agent_name: "conversation_test_agent", project_path: projectDir, thread_id: startedBody.thread_id, input: "hello from dashboard", approval_policy: "never", sandbox_mode: "danger-full-access" });
    const turnResponse = await fetch(turnUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", turnUrl, turnBody), body: turnBody });
    const turn = await turnResponse.json();
    assert.equal(turnResponse.status, 202, JSON.stringify(turn));
    assert.equal(turn.turn_id, "mock-turn-1");
    await waitFor(() => events.some(event => event.event_type === "item/agentMessage/delta"), "assistant delta was not forwarded");
    await waitFor(() => events.some(event => event.event_type === "turn/completed"), "turn completion was not forwarded");
    assert.match(String(events.find(event => event.event_type === "item/agentMessage/delta")?.payload?.delta || ""), /hello from dashboard|mock attached codex completed/);

    const readUrl = baseUrl + "/codex/conversations/read";
    const readBody = JSON.stringify({ conversation_id: conversationId, agent_name: "conversation_test_agent", project_path: projectDir, thread_id: startedBody.thread_id, approval_policy: "never", sandbox_mode: "danger-full-access" });
    const readResponse = await fetch(readUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", readUrl, readBody), body: readBody });
    const readResult = await readResponse.json();
    assert.equal(readResponse.status, 200, JSON.stringify(readResult));
    assert.equal(readResult.thread_id, startedBody.thread_id);
    assert.equal(readResult.thread?.turns?.length, 1);
    assert.match(String(readResult.thread.turns[0]?.items?.find(item => item.type === "userMessage")?.text || ""), /hello from dashboard/);
    assert.match(String(readResult.thread.turns[0]?.items?.find(item => item.type === "agentMessage")?.text || ""), /mock attached codex completed/);

    const localRead = await daemonRequest(baseUrl, "/codex/conversations/read", { method: "POST", body: readBody });
    assert.equal(localRead.response.status, 403);

    const resetStartBody = JSON.stringify({ conversation_id: conversationId, agent_name: "conversation_test_agent", project_path: projectDir, new_thread: true, approval_policy: "never", sandbox_mode: "danger-full-access" });
    const resetStart = await fetch(startUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", startUrl, resetStartBody), body: resetStartBody });
    const resetStarted = await resetStart.json();
    assert.equal(resetStart.status, 201, JSON.stringify(resetStarted));
    assert.equal(resetStarted.thread_id, startedBody.thread_id);
    const resetReadBody = JSON.stringify({ conversation_id: conversationId, agent_name: "conversation_test_agent", project_path: projectDir, thread_id: resetStarted.thread_id, approval_policy: "never", sandbox_mode: "danger-full-access" });
    const resetRead = await fetch(readUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", readUrl, resetReadBody), body: resetReadBody });
    const resetReadResult = await resetRead.json();
    assert.equal(resetRead.status, 200, JSON.stringify(resetReadResult));
    assert.deepEqual(resetReadResult.thread?.turns, []);
    assert.equal((readFileSync(rpcLog, "utf-8").match(/thread\/start/g) || []).length, 2);

    daemon.kill("SIGTERM");
    await new Promise(resolve => daemon.once("exit", resolve));
    daemon = spawnDaemon();
    await waitFor(async () => {
      try { return (await daemonRequest(baseUrl, "/health")).response.ok; } catch { return false; }
    }, "restarted daemon did not become healthy");
    const reconnected = await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "conversation_test_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });
    assert.equal(reconnected.response.ok, true, JSON.stringify(reconnected.body));

    const resumedTurnBody = JSON.stringify({ conversation_id: conversationId, maf_turn_id: "maf-turn-00000002", agent_name: "conversation_test_agent", project_path: projectDir, thread_id: startedBody.thread_id, input: "continue after daemon restart", approval_policy: "never", sandbox_mode: "danger-full-access" });
    const resumedTurnResponse = await fetch(turnUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", turnUrl, resumedTurnBody), body: resumedTurnBody });
    const resumedTurn = await resumedTurnResponse.json();
    assert.equal(resumedTurnResponse.status, 202, JSON.stringify(resumedTurn));
    assert.match(readFileSync(rpcLog, "utf-8"), /thread\/resume/);
    await waitFor(() => events.some(event => event.turn_id === "maf-turn-00000002" && event.event_type === "turn/completed"), "resumed turn completion was not forwarded");

    const interruptUrl = baseUrl + "/codex/conversations/interrupt";
    const interruptBody = JSON.stringify({ conversation_id: conversationId, maf_turn_id: "maf-turn-00000002", agent_name: "conversation_test_agent", thread_id: startedBody.thread_id, turn_id: resumedTurn.turn_id });
    const interrupted = await fetch(interruptUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", interruptUrl, interruptBody), body: interruptBody });
    assert.equal(interrupted.status, 202, await interrupted.text());

    eventUploadsEnabled = false;
    const spooledTurnBody = JSON.stringify({ conversation_id: conversationId, maf_turn_id: "maf-turn-00000003", agent_name: "conversation_test_agent", project_path: projectDir, thread_id: startedBody.thread_id, input: "persist events while server is unavailable", approval_policy: "never", sandbox_mode: "danger-full-access" });
    const spooledTurnResponse = await fetch(turnUrl, { method: "POST", headers: signedHeaders(serverPrivatePem, "POST", turnUrl, spooledTurnBody), body: spooledTurnBody });
    assert.equal(spooledTurnResponse.status, 202, await spooledTurnResponse.text());
    const spoolFile = path.join(mafHome, "state", "codex-conversation-events", conversationId + ".jsonl");
    await waitFor(() => {
      try {
        return readFileSync(spoolFile, "utf-8").split("\n").filter(Boolean)
          .map(line => JSON.parse(line))
          .some(event => event.turn_id === "maf-turn-00000003" && event.event_type === "turn/completed");
      } catch { return false; }
    }, "conversation events were not persisted to the disk spool");

    daemon.kill("SIGTERM");
    await new Promise(resolve => daemon.once("exit", resolve));
    eventUploadsEnabled = true;
    daemon = spawnDaemon();
    await waitFor(async () => {
      try { return (await daemonRequest(baseUrl, "/health")).response.ok; } catch { return false; }
    }, "daemon for spool recovery did not become healthy");
    const spoolReconnect = await daemonRequest(baseUrl, "/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent_name: "conversation_test_agent", runtime: "codex", directory: projectDir, plugin_pid: process.pid }),
    });
    assert.equal(spoolReconnect.response.ok, true, JSON.stringify(spoolReconnect.body));
    try {
      await waitFor(() => events.some(event => event.turn_id === "maf-turn-00000003" && event.event_type === "turn/completed"), "disk-spooled events were not uploaded after daemon restart");
    } catch (error) {
      const daemonLog = path.join(mafHome, "logs", "client-daemon.log");
      const spool = existsSync(spoolFile) ? readFileSync(spoolFile, "utf-8") : "<removed>";
      error.message += `\nevents=${JSON.stringify(events)}\nspool=${spool}\ndaemon_log=${readFileSync(daemonLog, "utf-8")}`;
      throw error;
    }
    await waitFor(() => !existsSync(spoolFile), "disk spool was not removed after successful upload");

    const managedConversationId = "managed-conversation-000001";
    const executeUrl = baseUrl + "/execute";
    const executeBody = JSON.stringify({
      task_id: "managed-task-000001",
      execution_id: "managed-execution-000001",
      workflow_id: "managed-workflow-000001",
      node_id: "managed-node-000001",
      agent_name: "conversation_test_agent",
      runtime: "codex",
      project_path: projectDir,
      title: "managed workflow test",
      prompt: "Codex attached e2e task: managed workflow",
      delivery_mode: "managed",
      codex_conversation_id: managedConversationId,
      codex_turn_id: "managed-maf-turn-000001",
      codex_source_type: "workflow",
    });
    const executeResponse = await fetch(executeUrl, {
      method: "POST",
      headers: signedHeaders(serverPrivatePem, "POST", executeUrl, executeBody),
      body: executeBody,
    });
    const executeResult = await executeResponse.json();
    assert.equal(executeResponse.status, 202, JSON.stringify(executeResult));
    assert.equal(executeResult.mode, "codex-managed-app-server");
    assert.equal(executeResult.delivery_mode, "managed");
    await waitFor(() => workflowStarted.some(item => item.body.execution_id === "managed-execution-000001"), "managed workflow start was not reported");
    await waitFor(() => workflowResults.some(item => item.body.execution_id === "managed-execution-000001"), "managed workflow result was not reported");
    const managedResult = workflowResults.find(item => item.body.execution_id === "managed-execution-000001");
    assert.equal(managedResult.body.status, "completed");
    assert.match(managedResult.body.result, /managed workflow/);
    await waitFor(() => events.some(event => event.turn_id === "managed-maf-turn-000001" && event.event_type === "turn\/completed"), "managed turn completion was not streamed");
    const screenCalls = existsSync(screenLog) ? readFileSync(screenLog, "utf-8") : "";
    assert.doesNotMatch(screenCalls, /(?:^|\n)-dmS(?:\s|$)/, "managed delivery must not create a screen");

    const cancelConversationId = "managed-conversation-000002";
    const cancelExecuteBody = JSON.stringify({
      task_id: "managed-task-000002",
      execution_id: "managed-execution-000002",
      workflow_id: "managed-workflow-000002",
      node_id: "managed-node-000002",
      agent_name: "conversation_test_agent",
      runtime: "codex",
      project_path: projectDir,
      title: "managed cancellation test",
      prompt: "MAF_E2E_SLOW_TURN Codex attached e2e task: cancel managed workflow",
      delivery_mode: "managed",
      codex_conversation_id: cancelConversationId,
      codex_turn_id: "managed-maf-turn-000002",
      codex_source_type: "workflow",
    });
    const cancelExecuteResponse = await fetch(executeUrl, {
      method: "POST",
      headers: signedHeaders(serverPrivatePem, "POST", executeUrl, cancelExecuteBody),
      body: cancelExecuteBody,
    });
    assert.equal(cancelExecuteResponse.status, 202, await cancelExecuteResponse.text());
    await waitFor(() => events.some(event => event.turn_id === "managed-maf-turn-000002" && event.event_type === "turn/started"), "managed cancellable turn did not start");
    const cancelUrl = baseUrl + "/cancel";
    const cancelBody = JSON.stringify({ execution_id: "managed-execution-000002", reason: "test cancellation" });
    const cancelResponse = await fetch(cancelUrl, {
      method: "POST",
      headers: signedHeaders(serverPrivatePem, "POST", cancelUrl, cancelBody),
      body: cancelBody,
    });
    const cancelResult = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelResult));
    assert.equal(cancelResult.termination_confirmed, true);
    await waitFor(() => events.some(event => event.turn_id === "managed-maf-turn-000002" && event.event_type === "turn/completed" && String(event.payload?.turn?.status?.type || event.payload?.turn?.status) === "interrupted"), "managed turn interruption was not streamed");
    assert.match(readFileSync(rpcLog, "utf-8"), /turn\/interrupt/);
    assert.equal(workflowResults.some(item => item.body.execution_id === "managed-execution-000002"), false, "cancelled managed result must not be reported late");
  } finally {
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise(resolve => daemon.once("exit", resolve));
    }
    await new Promise(resolve => mockServer.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
