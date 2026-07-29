#!/usr/bin/env node
/**
 * Pack/publish MAF npm packages without committing duplicated package versions.
 *
 * The repository keeps the release version only in the root package.json. npm
 * still requires a concrete version in the package being packed/published, so
 * this script copies packages/server or packages/client into a temporary staging
 * directory and injects the root version there only.
 *
 * Usage:
 *   node scripts/pack-package.mjs server --pack-destination out
 *   node scripts/pack-package.mjs client --dry-run --json
 *   node scripts/pack-package.mjs server --publish
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const target = args.shift();

const TARGETS = {
  server: "packages/server",
  client: "packages/client",
};

function usage(exitCode = 1) {
  console.error("Usage: node scripts/pack-package.mjs <server|client> [npm-pack-options|--publish]");
  process.exit(exitCode);
}

if (!target || target === "-h" || target === "--help") usage(target ? 0 : 1);
if (!TARGETS[target]) usage(1);

const publish = args.includes("--publish");
const npmArgs = args.filter(a => a !== "--publish");
for (let i = 0; i < npmArgs.length; i += 1) {
  if (npmArgs[i] === "--pack-destination" && npmArgs[i + 1]) {
    npmArgs[i + 1] = resolve(ROOT, npmArgs[i + 1]);
    mkdirSync(npmArgs[i + 1], { recursive: true });
    i += 1;
  } else if (npmArgs[i].startsWith("--pack-destination=")) {
    const dest = resolve(ROOT, npmArgs[i].slice("--pack-destination=".length));
    mkdirSync(dest, { recursive: true });
    npmArgs[i] = `--pack-destination=${dest}`;
  }
}
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version = rootPkg.version;
if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
  console.error(`❌ 根 package.json version 无效: ${version || "<missing>"}`);
  process.exit(1);
}

const srcDir = join(ROOT, TARGETS[target]);
const stageRoot = mkdtempSync(join(tmpdir(), `maf-${target}-pack-`));
const stageDir = join(stageRoot, basename(srcDir));

function copyFilter(src) {
  const base = basename(src);
  if (base === "node_modules" || base === ".git") return false;
  if (base.endsWith(".tgz")) return false;
  return true;
}

function run(cmd, cmdArgs, options = {}) {
  const npmCache = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(tmpdir(), "maf-npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const res = spawnSync(cmd, cmdArgs, {
    cwd: stageDir,
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache,
      ...(options.env || {}),
    },
  });
  if (res.status !== 0) process.exit(res.status || 1);
  if (res.error) throw res.error;
}

try {
  cpSync(srcDir, stageDir, { recursive: true, dereference: false, filter: copyFilter });
  const pkgPath = join(stageDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const commandArgs = publish ? ["publish", ...npmArgs] : ["pack", ...npmArgs];
  run("npm", commandArgs);
} finally {
  if (process.env.MAF_KEEP_PACK_STAGE === "1") {
    console.error(`保留 staging 目录: ${stageDir}`);
  } else if (existsSync(stageRoot)) {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
