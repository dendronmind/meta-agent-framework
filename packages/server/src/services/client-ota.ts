import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { serverAuthHeaders } from '../auth';
import { SERVER_VERSION } from '../types';

export type ClientOtaRuntime = 'daemon' | 'opencode' | 'claude-code' | 'codex';

export interface ClientOtaFile {
  path: string;
  content: string;
  hash: string;
  runtime?: ClientOtaRuntime;
  relative_path?: string;
}

export interface ClientOtaBundle {
  version: string;
  bundle_hash: string;
  assets: number;
  files: ClientOtaFile[];
  missing: string[];
}

interface OtaAsset {
  logicalPath: string;
  runtime: ClientOtaRuntime;
  relativePath: string;
  primaryPath: string;
  content: string;
  compatibilityPaths?: string[];
}

const SERVER_ROOT = join(__dirname, '..', '..');

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function versionedJson(filePath: string, extra: Record<string, unknown> = {}): string {
  const value = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return `${JSON.stringify({ ...value, ...extra, version: SERVER_VERSION }, null, 2)}\n`;
}

function generatedPackage(name: string): string {
  return `${JSON.stringify({ name, version: SERVER_VERSION, type: 'module' }, null, 2)}\n`;
}

function readAsset(
  logicalPath: string,
  runtime: ClientOtaRuntime,
  relativePath: string,
  primaryPath: string,
  sourcePath: string,
  missing: string[],
  options: { versioned?: boolean; compatibilityPaths?: string[] } = {},
): OtaAsset | null {
  if (!existsSync(sourcePath)) {
    missing.push(sourcePath);
    return null;
  }
  return {
    logicalPath,
    runtime,
    relativePath,
    primaryPath,
    content: options.versioned ? versionedJson(sourcePath) : readFileSync(sourcePath, 'utf-8'),
    compatibilityPaths: options.compatibilityPaths,
  };
}

function buildAssets(): { assets: OtaAsset[]; missing: string[] } {
  const missing: string[] = [];
  const assets: Array<OtaAsset | null> = [];
  const daemonDir = join(SERVER_ROOT, 'plugins', 'node-daemon');
  const opencodeDir = join(SERVER_ROOT, 'plugins', 'opencode-plugin-meta-agent-framework');
  const claudeDir = join(SERVER_ROOT, 'plugins', 'claude-code-plugin-maf');
  const codexDir = join(SERVER_ROOT, 'plugins', 'codex');

  assets.push(readAsset(
    'daemon/daemon.mjs',
    'daemon',
    'daemon.mjs',
    '~/.meta-agent-framework/daemon.mjs',
    join(daemonDir, 'daemon.mjs'),
    missing,
    { compatibilityPaths: ['plugin/daemon.mjs'] },
  ));
  assets.push({
    logicalPath: 'daemon/package.json',
    runtime: 'daemon',
    relativePath: 'package.json',
    primaryPath: '~/.meta-agent-framework/package.json',
    content: generatedPackage('@maf/meta-agent-daemon'),
  });

  assets.push(readAsset(
    'opencode/index.js',
    'opencode',
    'index.js',
    '~/.config/opencode/plugins/opencode-plugin-meta-agent-framework/index.js',
    join(opencodeDir, 'index.js'),
    missing,
  ));
  assets.push(readAsset(
    'opencode/package.json',
    'opencode',
    'package.json',
    '~/.config/opencode/plugins/opencode-plugin-meta-agent-framework/package.json',
    join(opencodeDir, 'package.json'),
    missing,
    { versioned: true },
  ));
  assets.push({
    logicalPath: 'opencode/meta-agent-framework.js',
    runtime: 'opencode',
    relativePath: 'meta-agent-framework.js',
    primaryPath: '~/.config/opencode/plugins/meta-agent-framework.js',
    content: 'export { MetaAgentBridge as server } from "./opencode-plugin-meta-agent-framework/index.js";\n',
  });

  for (const relativePath of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'scripts/maf-agent.mjs',
  ]) {
    assets.push(readAsset(
      `claude-code/${relativePath}`,
      'claude-code',
      relativePath,
      `~/.claude/plugins/marketplaces/maf-plugins/claude-code-plugin-maf/${relativePath}`,
      join(claudeDir, relativePath),
      missing,
      { versioned: relativePath === '.claude-plugin/plugin.json' },
    ));
  }

  for (const relativePath of [
    '.codex-plugin/plugin.json',
    'hooks.json',
    'scripts/maf-codex-common.mjs',
    'scripts/maf-codex-hook.mjs',
    'scripts/maf-codex-app-server.mjs',
    'scripts/maf-codex-attached-receiver.mjs',
  ]) {
    assets.push(readAsset(
      `codex/${relativePath}`,
      'codex',
      relativePath,
      `~/plugins/maf/${relativePath}`,
      join(codexDir, relativePath),
      missing,
      { versioned: relativePath === '.codex-plugin/plugin.json' },
    ));
  }
  assets.push({
    logicalPath: 'codex/package.json',
    runtime: 'codex',
    relativePath: 'package.json',
    primaryPath: '~/plugins/maf/package.json',
    content: generatedPackage('@maf/codex-plugin'),
  });

  return { assets: assets.filter((asset): asset is OtaAsset => asset !== null), missing };
}

function bundleHash(assets: OtaAsset[]): string {
  const fingerprint = assets
    .map(asset => `${asset.logicalPath}:${contentHash(asset.content)}`)
    .sort()
    .join('\n');
  return contentHash(fingerprint);
}

function safeVersionPath(version: string): string {
  return /^[A-Za-z0-9._+-]+$/.test(version) ? version : '';
}

/** Build the complete runtime Client bundle plus compatibility cache targets. */
export function buildClientOtaBundle(clientVersion = ''): ClientOtaBundle {
  const built = buildAssets();
  const hash = bundleHash(built.assets);
  const files: ClientOtaFile[] = [];
  const seenTargets = new Set<string>();
  const legacyClaudeVersion = safeVersionPath(clientVersion);

  const appendTarget = (asset: OtaAsset, target: string) => {
    if (seenTargets.has(target)) return;
    seenTargets.add(target);
    files.push({
      path: target,
      content: asset.content,
      hash: contentHash(asset.content),
      runtime: asset.runtime,
      relative_path: asset.relativePath,
    });
  };

  for (const asset of built.assets) {
    appendTarget(asset, asset.primaryPath);
    for (const target of asset.compatibilityPaths || []) appendTarget(asset, target);

    // Old Daemons ignore runtime metadata, so include their currently active
    // runtime caches explicitly for the first OTA that installs the new Daemon.
    if (asset.runtime === 'claude-code' && legacyClaudeVersion) {
      appendTarget(asset, `~/.claude/plugins/cache/maf-plugins/maf/${legacyClaudeVersion}/${asset.relativePath}`);
    }
    if (asset.runtime === 'codex') {
      appendTarget(asset, `~/.codex/plugins/cache/personal/maf/local/${asset.relativePath}`);
    }
  }

  const manifest = {
    schema_version: 1,
    version: SERVER_VERSION,
    bundle_hash: hash,
    assets: built.assets.map(asset => ({
      logical_path: asset.logicalPath,
      path: asset.primaryPath,
      hash: contentHash(asset.content),
    })),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  files.push({
    path: '~/.meta-agent-framework/ota-manifest.json',
    content: manifestContent,
    hash: contentHash(manifestContent),
    runtime: 'daemon',
    relative_path: 'ota-manifest.json',
  });

  return {
    version: SERVER_VERSION,
    bundle_hash: hash,
    assets: built.assets.length,
    files,
    missing: built.missing,
  };
}

export function getClientOtaBundleHash(): string {
  return buildClientOtaBundle().bundle_hash;
}

async function postOta(daemonUrl: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const url = `${daemonUrl}/ota`;
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Daemon OTA HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return await response.json() as Record<string, any>;
}

async function waitForUpdatedDaemon(daemonUrl: string, expectedHash: string): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const response = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) continue;
      const health = await response.json() as { daemon_hash?: string };
      if (!expectedHash || health.daemon_hash === expectedHash) return true;
    } catch {}
  }
  return false;
}

/**
 * Push an OTA payload and bridge one legacy-Daemon upgrade boundary.
 *
 * Old Daemons can replace daemon.mjs but cannot mirror every new runtime path.
 * If that first pass reports partial failure, wait for the upgraded Daemon and
 * resend once with a fresh Server signature.
 */
export async function pushClientOta(
  daemonUrl: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  const first = await postOta(daemonUrl, payload);
  if (!first.daemon_updated || Number(first.failed || 0) === 0) return { ...first, attempts: 1 };

  const files = Array.isArray(payload.files) ? payload.files as ClientOtaFile[] : [];
  const daemonFile = files.find(file =>
    file.runtime === 'daemon' && file.relative_path === 'daemon.mjs'
    || file.path === 'plugin/daemon.mjs'
  );
  if (!await waitForUpdatedDaemon(daemonUrl, daemonFile?.hash || '')) {
    return {
      ...first,
      attempts: 1,
      retry_error: 'updated Daemon did not become reachable within 25 seconds',
    };
  }

  const second = await postOta(daemonUrl, payload);
  return { ...second, attempts: 2, first_attempt_failed: Number(first.failed || 0) };
}
