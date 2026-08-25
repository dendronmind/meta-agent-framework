import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inferAgent,
  inferProjectRoot,
} from "../codex/scripts/maf-codex-common.mjs";

function withoutAgentOverride(run) {
  const previous = process.env.MAF_AGENT_NAME;
  delete process.env.MAF_AGENT_NAME;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.MAF_AGENT_NAME;
    else process.env.MAF_AGENT_NAME = previous;
  }
}

test("a parent .git directory does not promote a nested Codex launch directory", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-codex-project-root-"));
  const repository = path.join(testRoot, "repository");
  const launchDir = path.join(repository, "codex");
  mkdirSync(path.join(repository, ".git"), { recursive: true });
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");

  try {
    assert.equal(inferProjectRoot(launchDir), launchDir);
    assert.notEqual(inferProjectRoot(launchDir), repository);
    withoutAgentOverride(() => {
      assert.deepEqual(inferAgent(launchDir), {
        agentName: "codex",
        projectPath: launchDir,
      });
    });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a project AGENTS.md first-line marker defines agent identity and project root", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-codex-agents-md-root-"));
  const projectRoot = path.join(testRoot, "project");
  const launchDir = path.join(projectRoot, "source", "nested");
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(projectRoot, "AGENTS.md"), [
    "# Codex project agent: netcore-eea2.0",
    "",
    "Project instructions.",
    "",
  ].join("\n"));

  try {
    assert.equal(inferProjectRoot(launchDir), projectRoot);
    withoutAgentOverride(() => {
      assert.deepEqual(inferAgent(launchDir), {
        agentName: "netcore-eea2.0",
        projectPath: projectRoot,
      });
    });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("project TOML identity takes precedence over an AGENTS.md marker", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-codex-agent-root-"));
  const projectRoot = path.join(testRoot, "project");
  const launchDir = path.join(projectRoot, "source", "nested");
  const agentsDir = path.join(projectRoot, ".codex", "agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "worker.toml"), 'name = "netcore-eea2.0"\n');
  writeFileSync(path.join(projectRoot, "AGENTS.md"), "# Codex project agent: lower-priority-marker\n");

  try {
    assert.equal(inferProjectRoot(launchDir), projectRoot);
    withoutAgentOverride(() => {
      assert.deepEqual(inferAgent(launchDir), {
        agentName: "netcore-eea2.0",
        projectPath: projectRoot,
      });
    });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an AGENTS.md marker below the first line is not an identity source", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "maf-codex-late-marker-"));
  const launchDir = path.join(testRoot, "project");
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(launchDir, "AGENTS.md"), [
    "# Project instructions",
    "# Codex project agent: ignored-marker",
    "",
  ].join("\n"));

  try {
    withoutAgentOverride(() => {
      assert.deepEqual(inferAgent(launchDir), {
        agentName: "project",
        projectPath: launchDir,
      });
    });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Client and Server Codex common scripts stay byte-identical", () => {
  const clientScript = fileURLToPath(new URL("../codex/scripts/maf-codex-common.mjs", import.meta.url));
  const serverScript = fileURLToPath(new URL("../../server/plugins/codex/scripts/maf-codex-common.mjs", import.meta.url));
  assert.equal(readFileSync(clientScript, "utf-8"), readFileSync(serverScript, "utf-8"));
});
