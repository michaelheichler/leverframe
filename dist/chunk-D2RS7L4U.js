#!/usr/bin/env node

// src/server-runtime.ts
import {
  closeSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { dirname, join as join2 } from "path";

// src/paths.ts
import { homedir } from "os";
import { join } from "path";
import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";
var APP_DIR_NAME = "leverframe";
var LEGACY_APP_DIR_NAME = "clodex";
var OLDER_LEGACY_APP_DIR_NAME = "relay-ai";
function userHome(env = process.env) {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}
function resolveAppHomeOverride(env = process.env) {
  const override = env.LEVERFRAME_HOME;
  return override?.trim() || void 0;
}
function getAppHome(env = process.env) {
  const override = resolveAppHomeOverride(env);
  if (override) return override;
  return join(userHome(env), `.${APP_DIR_NAME}`);
}
function getDefaultAppHome(env = process.env) {
  return join(userHome(env), `.${APP_DIR_NAME}`);
}
function getLegacyAppHome(env = process.env) {
  return join(userHome(env), `.${LEGACY_APP_DIR_NAME}`);
}
function getOlderLegacyAppHome(env = process.env) {
  return join(userHome(env), `.${OLDER_LEGACY_APP_DIR_NAME}`);
}
var legacyMigrationDone = false;
function ensureLegacyAppHomeMigrated(env = process.env) {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  if (resolveAppHomeOverride(env)) return;
  try {
    const appHome = getAppHome(env);
    if (existsSync(appHome)) return;
    const legacyHome = [getLegacyAppHome(env), getOlderLegacyAppHome(env)].find((path) => existsSync(path));
    if (!legacyHome) return;
    mkdirSync(appHome, { recursive: true, mode: 448 });
    const entries = readdirSync(legacyHome);
    for (const entry of entries) {
      if (entry === "logs") continue;
      cpSync(join(legacyHome, entry), join(appHome, entry), { recursive: true });
    }
  } catch {
  }
}
function getConfigPath(env = process.env) {
  return join(getAppHome(env), "config.json");
}
function getProvidersPath(env = process.env) {
  return join(getAppHome(env), "providers.json");
}
function getCredentialCleanupPath(env = process.env) {
  return join(getAppHome(env), "credential-cleanup.json");
}
function getLogsPath(env = process.env) {
  return join(getAppHome(env), "logs");
}

// src/server-runtime.ts
function getServerRuntimePath(env = process.env) {
  return join2(getAppHome(env), "server-runtime.json");
}
function getServerRuntimeLockPath(env = process.env) {
  return join2(getAppHome(env), "server-runtime.lock");
}
function isDiscoveryDisabled(flag, env = process.env) {
  if (flag !== void 0) return flag;
  const raw = env.LEVERFRAME_NO_DISCOVERY?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
function isPort(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}
function parseServerRuntimeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const mode = record["mode"];
  if (mode !== "endpoint" && mode !== "proxy") return null;
  if (!isPort(record["port"])) return null;
  const pid = record["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = typeof record["startedAt"] === "string" ? record["startedAt"] : "";
  const caPath = record["caPath"];
  const token = typeof record["token"] === "string" && record["token"].trim() ? record["token"] : void 0;
  if (mode === "proxy") {
    if (typeof caPath !== "string" || !caPath.trim()) return null;
    return { mode, port: record["port"], pid, caPath, token, startedAt };
  }
  return { mode, port: record["port"], pid, token, startedAt };
}
function parseServerRuntimeStates(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const states = [];
  for (const item of items) {
    const state = parseServerRuntimeRecord(item);
    if (state) states.push(state);
  }
  return states;
}
function isPidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
var RUNTIME_LOCK_STALE_MS = 1e4;
var RUNTIME_LOCK_WAIT_MS = 500;
var RUNTIME_LOCK_RETRY_MS = 25;
function tryAcquireRuntimeLock(lockPath, opts = {}) {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? isPidAlive;
  mkdirSync2(dirname(lockPath), { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      const content = { pid: process.pid, startedAt: now };
      writeFileSync(fd, JSON.stringify(content));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
        }
      };
    } catch {
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8"));
        stale = !existing.pid || !alive(existing.pid) || typeof existing.startedAt === "number" && now - existing.startedAt > RUNTIME_LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return null;
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
  }
  return null;
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withRuntimeWriteLock(env, mutate) {
  const lockPath = getServerRuntimeLockPath(env);
  let release = null;
  const deadline = Date.now() + RUNTIME_LOCK_WAIT_MS;
  for (; ; ) {
    release = tryAcquireRuntimeLock(lockPath);
    if (release || Date.now() >= deadline) break;
    sleepSync(RUNTIME_LOCK_RETRY_MS);
  }
  try {
    mutate();
  } finally {
    release?.();
  }
}
function readAllRecords(env) {
  let raw;
  try {
    raw = readFileSync(getServerRuntimePath(env), "utf8");
  } catch {
    return [];
  }
  return parseServerRuntimeStates(raw);
}
function atomicWriteRecords(path, records) {
  mkdirSync2(dirname(path), { recursive: true, mode: 448 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync(tmpPath, path);
}
function registerServerRuntimeState(state, env = process.env, options = {}) {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        (record) => record.pid !== state.pid && alive(record.pid)
      );
      records.push(state);
      atomicWriteRecords(getServerRuntimePath(env), records);
    });
  } catch {
  }
}
function unregisterServerRuntimeState(pid = process.pid, env = process.env, options = {}) {
  const alive = options.isAlive ?? isPidAlive;
  try {
    withRuntimeWriteLock(env, () => {
      const records = readAllRecords(env).filter(
        (record) => record.pid !== pid && alive(record.pid)
      );
      if (records.length === 0) {
        rmSync(getServerRuntimePath(env), { force: true });
      } else {
        atomicWriteRecords(getServerRuntimePath(env), records);
      }
    });
  } catch {
  }
}
function readLiveServerRuntimeStates(env = process.env, options = {}) {
  const alive = options.isAlive ?? isPidAlive;
  return readAllRecords(env).filter((state) => alive(state.pid));
}
function orderWrapperServerCandidates(records) {
  return [...records].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === "proxy" ? -1 : 1;
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
  });
}

// src/constants.ts
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";

// package.json
var package_default = {
  name: "@michaelheichler/leverframe",
  version: "0.3.7",
  description: "Bridge Claude Code to OpenAI-compatible providers, including OpenAI, ChatGPT/Codex OAuth, Kimi, Moonshot, and z.ai",
  author: "Michael Heichler",
  license: "MIT",
  keywords: [
    "claude",
    "claude-code",
    "openai",
    "chatgpt",
    "codex",
    "ai",
    "llm",
    "cli",
    "bridge",
    "proxy"
  ],
  type: "module",
  packageManager: "pnpm@10.34.5",
  bin: {
    leverframe: "dist/cli.js",
    "leverframe-claude": "dist/claude-wrapper.js"
  },
  files: [
    "dist/*.js",
    "dist/*.mjs",
    "docs/background-agents.md",
    "docs/model-picker.png",
    "README.md"
  ],
  engines: {
    node: ">=22"
  },
  scripts: {
    build: `tsup && node --input-type=module -e "import { copyFileSync } from 'node:fs'; copyFileSync('src/keyring-child.mjs', 'dist/keyring-child.mjs');"`,
    "build:test-candidate": "tsup $(find src -name 'candidate-?li.ts' -print) --format esm --target node22 --out-dir dist-${LEVERFRAME_CANDIDATE_OUTPUT:-test} --sourcemap false --clean",
    "check:package": "node scripts/verify-package-contents.mjs",
    dev: "tsup --watch",
    lint: "oxlint src tests",
    test: "vitest run",
    "test:watch": "vitest",
    typecheck: "tsc --noEmit && tsc --noEmit -p tests/tsconfig.json",
    prepare: "test ! -d .husky || husky"
  },
  dependencies: {
    "@ai-sdk/anthropic": "4.0.12",
    "@ai-sdk/openai": "4.0.11",
    "@ai-sdk/openai-compatible": "3.0.7",
    "@ai-sdk/provider": "4.0.3",
    "@ai-sdk/provider-utils": "5.0.7",
    "@clack/prompts": "0.9.1",
    ai: "7.0.22",
    "https-proxy-agent": "9.1.0",
    "ipaddr.js": "2.4.0",
    "node-forge": "1.4.0",
    "node-gyp-build": "4.8.4",
    open: "11.0.0",
    picocolors: "1.1.1",
    tweakcc: "4.3.3",
    undici: "7.28.0",
    ws: "8.21.0"
  },
  devDependencies: {
    "@commitlint/cli": "19.8.1",
    "@commitlint/config-conventional": "19.8.1",
    "@types/node": "22.19.19",
    "@types/node-forge": "1.3.14",
    "@types/ws": "8.18.1",
    husky: "9.1.7",
    oxlint: "^1.75.0",
    tsup: "8.5.1",
    typescript: "5.9.3",
    vitest: "2.1.9"
  },
  optionalDependencies: {
    "@github/copilot-sdk": "1.0.9",
    "@napi-rs/keyring": "1.3.0"
  },
  pnpm: {
    onlyBuiltDependencies: [
      "node-lief"
    ]
  },
  repository: {
    type: "git",
    url: "git+https://github.com/michaelheichler/leverframe.git"
  },
  homepage: "https://github.com/michaelheichler/leverframe#readme",
  bugs: {
    url: "https://github.com/michaelheichler/leverframe/issues"
  }
};

// src/constants.ts
var CODEX_RESPONSES_LITE_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
var CODEX_RESPONSES_LITE_VERSION = "0.144.1";
var CODEX_RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06";
var CONFLICTING_ENV_VARS = [
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL"
];
var OPENCODE_CACHE_PATH = join3(homedir2(), ".cache", "opencode", "models.json");
var MAX_MODEL_CATALOG = 20;
var DEFAULT_SERVER_PORT = 17645;
var VERTEX_ANTHROPIC_NPM = "@ai-sdk/google-vertex/anthropic";
var VERSION = package_default.version;

// src/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync5 } from "fs";

// src/registry/lock.ts
import { AsyncLocalStorage } from "async_hooks";
import { createHash, randomUUID } from "crypto";
import {
  closeSync as closeSync2,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync as mkdirSync3,
  openSync as openSync2,
  readFileSync as readFileSync2,
  statSync,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname as dirname2, join as join4 } from "path";
var DEFAULT_WAIT_MS = 3e4;
var DEFAULT_CREDENTIAL_WAIT_MS = 15e4;
var DEFAULT_RETRY_MS = 25;
var lockContext = new AsyncLocalStorage();
var RegistryLockLostError = class extends Error {
  constructor(lockPath) {
    super(`Registry lock ownership was lost before publication: ${lockPath}`);
    this.name = "RegistryLockLostError";
  }
};
function getRegistryLockPath(registryPath = getProvidersPath()) {
  return `${registryPath}.lock`;
}
function isPidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function parseOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
function createLockRecord(lockPath, owner) {
  const raw = JSON.stringify(owner);
  const temporary = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  let fd;
  let snapshot = null;
  let cleanupError;
  try {
    fd = openSync2(temporary, "wx", 384);
    writeFileSync2(fd, raw);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    try {
      linkSync(temporary, lockPath);
      snapshot = { raw, device: stats.dev, inode: stats.ino, modifiedAt: stats.mtimeMs };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (fd !== void 0) closeSync2(fd);
    try {
      unlinkSync2(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupError = error;
    }
  }
  if (cleanupError !== void 0) throw cleanupError;
  return snapshot;
}
function readSnapshot(lockPath) {
  const pathStats = lstatSync(lockPath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Lock path is not a regular file: ${lockPath}`);
  }
  let fd;
  try {
    fd = openSync2(lockPath, "r");
    const opened = fstatSync(fd);
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino) {
      throw new Error(`Lock changed while opening: ${lockPath}`);
    }
    return {
      raw: readFileSync2(fd, "utf8"),
      device: opened.dev,
      inode: opened.ino,
      modifiedAt: opened.mtimeMs
    };
  } finally {
    if (fd !== void 0) closeSync2(fd);
  }
}
function lockMatches(lease) {
  try {
    const snapshot = readSnapshot(lease.lockPath);
    const owner = parseOwner(snapshot.raw);
    const current = statSync(lease.lockPath);
    return owner?.token === lease.token && snapshot.device === lease.device && snapshot.inode === lease.inode && current.dev === lease.device && current.ino === lease.inode;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function createLease(lockPath, owner, snapshot) {
  const lease = {
    active: true,
    lockPath,
    token: owner.token,
    device: snapshot.device,
    inode: snapshot.inode,
    assertOwned() {
      if (!lease.active || !lockMatches(lease)) {
        lease.active = false;
        throw new RegistryLockLostError(lockPath);
      }
    },
    release() {
      if (!lease.active) return;
      const owned = lockMatches(lease);
      lease.active = false;
      if (owned) unlinkSync2(lockPath);
    }
  };
  return lease;
}
function assertRegistryWriteOwnership(registryPath = getProvidersPath()) {
  const lockPath = getRegistryLockPath(registryPath);
  const lease = lockContext.getStore()?.leases.get(lockPath);
  if (!lease) throw new RegistryLockLostError(lockPath);
  lease.assertOwned();
}
function staleSnapshot(lockPath, alive) {
  const snapshot = readSnapshot(lockPath);
  const owner = parseOwner(snapshot.raw);
  return owner && alive(owner.pid) ? null : snapshot;
}
function removeSnapshot(lockPath, expected) {
  try {
    const current = readSnapshot(lockPath);
    if (current.raw !== expected.raw || current.device !== expected.device || current.inode !== expected.inode || current.modifiedAt !== expected.modifiedAt) return false;
    unlinkSync2(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function tryAcquireReaper(lockPath, now, alive) {
  const guardPath = `${lockPath}.reap`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = { pid: process.pid, startedAt: now, token: randomUUID() };
    try {
      const snapshot = createLockRecord(guardPath, owner);
      if (snapshot) return createLease(guardPath, owner, snapshot);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let stale;
    try {
      stale = staleSnapshot(guardPath, alive);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stale) return null;
    if (!removeSnapshot(guardPath, stale)) continue;
  }
  return null;
}
function tryAcquireRegistryLock(lockPath = getRegistryLockPath(), options = {}) {
  const now = options.now?.() ?? Date.now();
  const alive = options.isAlive ?? isPidAlive2;
  mkdirSync3(dirname2(lockPath), { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = { pid: process.pid, startedAt: now, token: randomUUID() };
    try {
      const snapshot = createLockRecord(lockPath, owner);
      if (snapshot) return createLease(lockPath, owner, snapshot);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let stale;
    try {
      stale = staleSnapshot(lockPath, alive);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stale) return null;
    const reaper = tryAcquireReaper(lockPath, now, alive);
    if (!reaper) return null;
    try {
      let current;
      try {
        current = staleSnapshot(lockPath, alive);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!current) return null;
      if (!removeSnapshot(lockPath, current)) continue;
    } finally {
      reaper.release();
    }
  }
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sleepSync2(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function timeoutError(lockPath, waitMs, alive) {
  let owner = null;
  try {
    owner = parseOwner(readSnapshot(lockPath).raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (owner && alive(owner.pid)) {
    return new Error(`Timed out after ${waitMs}ms waiting for lock held by Leverframe process (pid ${owner.pid}): ${lockPath}`);
  }
  return new Error(`Timed out after ${waitMs}ms waiting for lock: ${lockPath}`);
}
async function withRegistryWriteLock(operation, options = {}) {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inherited = lockContext.getStore()?.leases;
  if (inherited?.get(lockPath)?.active) return operation();
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease = null;
  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, { now, isAlive: options.isAlive });
    if (lease) break;
    if (now() >= deadline) throw timeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive2);
    await sleep(retryMs);
  }
  const leases = new Map(inherited);
  leases.set(lockPath, lease);
  return lockContext.run({ leases }, async () => {
    try {
      return await operation();
    } finally {
      lease.release();
    }
  });
}
function withRegistryWriteLockSync(operation, options = {}) {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inherited = lockContext.getStore()?.leases;
  if (inherited?.get(lockPath)?.active) return operation();
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease = null;
  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, { now, isAlive: options.isAlive });
    if (lease) break;
    if (now() >= deadline) throw timeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive2);
    sleepSync2(retryMs);
  }
  const leases = new Map(inherited);
  leases.set(lockPath, lease);
  return lockContext.run({ leases }, () => {
    try {
      return operation();
    } finally {
      lease.release();
    }
  });
}
function getCredentialMutationLockPath(authRef) {
  const digest = createHash("sha256").update("leverframe-credential\0").update(authRef).digest("hex");
  return join4(getAppHome(), "credential-locks", `${digest}.lock`);
}
function withCredentialMutationLock(authRef, operation, options = {}) {
  return withRegistryWriteLock(operation, {
    ...options,
    lockPath: getCredentialMutationLockPath(authRef),
    waitMs: options.waitMs ?? DEFAULT_CREDENTIAL_WAIT_MS
  });
}
function getProviderMutationLockPath(providerSlot) {
  const digest = createHash("sha256").update("leverframe-provider\0").update(providerSlot).digest("hex");
  return `${getProvidersPath()}.provider-${digest}.lock`;
}
function withProviderMutationLock(providerSlot, operation) {
  return withRegistryWriteLock(operation, { lockPath: getProviderMutationLockPath(providerSlot) });
}

// src/keyring-operations.ts
import { spawn } from "child_process";
import { statSync as statSync2 } from "fs";
import { createRequire } from "module";
import { join as join5 } from "path";
import { fileURLToPath, pathToFileURL } from "url";
var KEYRING_TIMEOUT_MS = process.platform === "linux" ? 3e3 : 45e3;
function keyringChildPath() {
  return fileURLToPath(new URL("./keyring-child.mjs", import.meta.url));
}
function classifyKeyringError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("timed out")) return "keyring operation timed out";
  if (lower.includes("integrity:")) return msg.replace(/^integrity:\s*/i, "keyring integrity error: ");
  if (lower.includes("d-bus session is unavailable")) {
    return "D-Bus session is unavailable (preserve XDG_RUNTIME_DIR or provide DBUS_SESSION_BUS_ADDRESS)";
  }
  if (lower.includes("cannot find module") || lower.includes("module not found") || lower.includes("failed to load")) {
    return "native keyring module not available on this system";
  }
  if (lower.includes("secret service") || lower.includes("org.freedesktop.secrets") || lower.includes("dbus") || lower.includes("d-bus") || lower.includes("daemon")) {
    return "Secret Service daemon is not running (start GNOME Keyring or KWallet, or provide a D-Bus session)";
  }
  if (lower.includes("denied") || lower.includes("locked") || lower.includes("cancelled") || lower.includes("user refused")) {
    return "keychain access was denied or the keychain is locked";
  }
  return `keyring error: ${msg}`;
}
function resolveKeyringModule() {
  return pathToFileURL(createRequire(import.meta.url).resolve("@napi-rs/keyring")).href;
}
var KEYRING_ENV_NAMES = [
  "APPDATA",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ProgramData",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR"
];
function buildKeyringHelperEnv(source = process.env) {
  const env = {};
  for (const name of KEYRING_ENV_NAMES) if (source[name] !== void 0) env[name] = source[name];
  if (process.platform === "linux" && !env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    const uid = process.getuid?.();
    if (uid === void 0) return env;
    const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
    const socketPath = join5(runtimeDir, "bus");
    try {
      const socket = statSync2(socketPath);
      if (socket.isSocket() && socket.uid === uid) {
        env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`;
      }
    } catch {
      delete env.DBUS_SESSION_BUS_ADDRESS;
    }
  }
  return env;
}
function missingDbusReason(env) {
  if (process.platform !== "linux" || env.DBUS_SESSION_BUS_ADDRESS?.trim()) return null;
  return "D-Bus session is unavailable; Secret Service keyring access cannot be used";
}
function runIsolatedKeyringOperation(input, options = {}) {
  const sourceEnv = options.env ?? process.env;
  const helperEnv = buildKeyringHelperEnv(sourceEnv);
  if (!options.skipAvailabilityCheck) {
    const reason = missingDbusReason(helperEnv);
    if (reason) return Promise.resolve({ ok: false, error: reason });
  }
  let moduleUrl;
  try {
    moduleUrl = options.moduleUrl ?? resolveKeyringModule();
  } catch (error) {
    return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = (options.spawnImpl ?? spawn)(process.execPath, [keyringChildPath()], {
        env: helperEnv,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const stdout = [];
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdin.removeListener("error", onStdinError);
      child.stdout.removeListener("data", onStdoutData);
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
    };
    const finish = (result, terminate = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) {
        child.kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
      resolve(result);
    };
    const onStdoutData = (chunk) => {
      stdout.push(Buffer.from(chunk));
    };
    const onStdinError = (error) => {
      finish({ ok: false, error: error.message }, true);
    };
    const onChildError = (error) => {
      finish({ ok: false, error: error.message }, true);
    };
    const onClose = () => {
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (result?.ok === true && (result.value === null || typeof result.value === "string")) finish(result);
        else if (result?.ok === false && typeof result.error === "string") finish(result);
        else finish({ ok: false, error: "keyring helper returned an invalid response" });
      } catch {
        finish({ ok: false, error: "keyring helper returned an invalid response" });
      }
    };
    const timeoutMs = options.timeoutMs ?? KEYRING_TIMEOUT_MS;
    timer = setTimeout(() => finish({ ok: false, error: `keyring operation timed out after ${timeoutMs}ms` }, true), timeoutMs);
    timer.unref();
    child.stdout.on("data", onStdoutData);
    child.stdin.on("error", onStdinError);
    child.on("error", onChildError);
    child.on("close", onClose);
    child.stdin.end(JSON.stringify({ ...input, moduleUrl }));
  });
}

// src/credential-fallback-store.ts
import { existsSync as existsSync2 } from "fs";
import { dirname as dirname4, join as join6 } from "path";

// src/durable-io.ts
import { randomUUID as randomUUID2 } from "crypto";
import {
  chmodSync,
  closeSync as closeSync3,
  fstatSync as fstatSync2,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  unlinkSync as unlinkSync3,
  writeSync
} from "fs";
import { dirname as dirname3 } from "path";
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
function errorCode(error) {
  return error?.code;
}
function ensurePrivateDirectory(path, mode = PRIVATE_DIRECTORY_MODE) {
  mkdirSync4(path, { recursive: true, mode });
  const stats = lstatSync2(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Private storage path is not a regular directory: ${path}`);
  }
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
function assertSafeExistingFile(path, description = "file") {
  let stats;
  try {
    stats = lstatSync2(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${description} is not a regular file: ${path}`);
  }
}
function readFileStrict(path, options = {}) {
  const description = options.description ?? "State file";
  const before = lstatSync2(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${description} is not a regular file: ${path}`);
  }
  let fd;
  try {
    fd = openSync3(path, "r");
    const opened = fstatSync2(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`${description} changed while opening: ${path}`);
    }
    if (options.maxBytes !== void 0 && opened.size > options.maxBytes) {
      throw new Error(`${description} exceeds ${options.maxBytes} bytes: ${path}`);
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      throw new Error(`${description} is owned by another user: ${path}`);
    }
    if (options.requirePrivateMode && process.platform !== "win32" && (opened.mode & 63) !== 0) {
      throw new Error(`${description} permissions are too broad: ${path}`);
    }
    return readFileSync3(fd, "utf8");
  } finally {
    if (fd !== void 0) closeSync3(fd);
  }
}
function syncParentDirectory(path) {
  let fd;
  try {
    fd = openSync3(dirname3(path), "r");
    fsyncSync2(fd);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") {
      throw error;
    }
  } finally {
    if (fd !== void 0) closeSync3(fd);
  }
}
function completeWrite(fd, content) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(fd, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error("Could not complete durable file write");
    offset += written;
  }
}
function durableAtomicWrite(path, content, options = {}) {
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  const directoryMode = options.directoryMode ?? PRIVATE_DIRECTORY_MODE;
  const directory = dirname3(path);
  ensurePrivateDirectory(directory, directoryMode);
  if (options.validateExisting !== false) assertSafeExistingFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  let fd;
  let renamed = false;
  let cleanupError;
  try {
    fd = openSync3(temporary, "wx", mode);
    completeWrite(fd, content);
    fsyncSync2(fd);
    closeSync3(fd);
    fd = void 0;
    options.fence?.();
    if (options.validateExisting !== false) assertSafeExistingFile(path);
    options.fence?.();
    renameSync2(temporary, path);
    renamed = true;
    syncParentDirectory(path);
  } finally {
    if (fd !== void 0) closeSync3(fd);
    if (!renamed) {
      try {
        unlinkSync3(temporary);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") cleanupError = error;
      }
    }
  }
  if (cleanupError !== void 0) throw cleanupError;
}

// src/credential-fallback-store.ts
var FALLBACK_FILE_NAME = "credentials-fallback.json";
var MAX_FALLBACK_BYTES = 16 * 1024 * 1024;
function getCredentialFallbackPath(env = process.env) {
  return join6(getAppHome(env), FALLBACK_FILE_NAME);
}
function emptyFallbackFile() {
  return { schemaVersion: 1, credentials: /* @__PURE__ */ Object.create(null) };
}
function readFallbackFile(path = getCredentialFallbackPath()) {
  if (!existsSync2(path)) return emptyFallbackFile();
  const text = readFileStrict(path, {
    maxBytes: MAX_FALLBACK_BYTES,
    requirePrivateMode: true,
    description: "Credential fallback file"
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Credential fallback file is corrupt: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  const record = parsed;
  const credentials = record.credentials;
  const fields = Object.keys(record);
  if (fields.length !== 2 || !fields.includes("schemaVersion") || !fields.includes("credentials") || record.schemaVersion !== 1 || !credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error(`Credential fallback file has an invalid format: ${path}`);
  for (const value of Object.values(credentials)) {
    if (typeof value !== "string") throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  return { schemaVersion: 1, credentials: Object.assign(/* @__PURE__ */ Object.create(null), credentials) };
}
function writeFallbackFile(data, path = getCredentialFallbackPath()) {
  ensurePrivateDirectory(dirname4(path));
  durableAtomicWrite(path, `${JSON.stringify(data, null, 2)}
`);
}
function withFallbackLock(path, operation) {
  return withRegistryWriteLockSync(operation, { lockPath: `${path}.lock` });
}
function readFallbackCredential(account, path = getCredentialFallbackPath()) {
  return withFallbackLock(path, () => readFallbackFile(path).credentials[account] ?? null);
}
function writeFallbackCredential(account, value, path = getCredentialFallbackPath()) {
  withFallbackLock(path, () => {
    const data = readFallbackFile(path);
    data.credentials[account] = value;
    writeFallbackFile(data, path);
  });
}
function deleteFallbackCredential(account, path = getCredentialFallbackPath()) {
  return withFallbackLock(path, () => {
    const data = readFallbackFile(path);
    if (!Object.hasOwn(data.credentials, account)) return false;
    delete data.credentials[account];
    writeFallbackFile(data, path);
    return true;
  });
}

// src/credential-store.ts
var KEYRING_SERVICE = "leverframe";
var LEGACY_KEYRING_SERVICES = ["clodex", "relay-ai"];
var FALLBACK_WARNING = "Using plaintext credential fallback storage (permissions 0600 in a 0700 directory); no at-rest encryption is available";
var emittedCredentialWarnings = /* @__PURE__ */ new Set();
function reportWarning(diag, message) {
  if (diag) {
    diag(message);
    return;
  }
  if (emittedCredentialWarnings.has(message)) return;
  emittedCredentialWarnings.add(message);
  console.warn(`leverframe: ${message}`);
}
async function keyringOperation(input) {
  return runIsolatedKeyringOperation(input);
}
var _credentialStoreInternals = { keyringOperation };
function readKeyringService(service, account) {
  return _credentialStoreInternals.keyringOperation({ operation: "read", service, account });
}
function isIntegrityError(error) {
  return /^integrity:/i.test(error);
}
function fallbackWarning() {
  return `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`;
}
function removeFallbackCredential(account, diag) {
  try {
    deleteFallbackCredential(account);
    if (readFallbackCredential(account) !== null) {
      reportWarning(diag, "Credential fallback deletion could not be verified");
      return false;
    }
    return true;
  } catch (error) {
    reportWarning(diag, `Could not verify credential fallback deletion: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
async function promoteFallbackCredential(account, value, diag) {
  const published = await _credentialStoreInternals.keyringOperation({
    operation: "write",
    service: KEYRING_SERVICE,
    account,
    value
  });
  if (!published.ok) {
    reportWarning(diag, classifyKeyringError(published.error));
    if (isIntegrityError(published.error)) return null;
    reportWarning(diag, fallbackWarning());
    return value;
  }
  const verified = await readKeyringService(KEYRING_SERVICE, account);
  if (!verified.ok) {
    reportWarning(diag, classifyKeyringError(verified.error));
    if (isIntegrityError(verified.error)) return null;
    reportWarning(diag, fallbackWarning());
    return value;
  }
  if (verified.deleted || verified.value !== value) {
    reportWarning(diag, "Keyring promotion could not be verified");
    return null;
  }
  if (!removeFallbackCredential(account, diag)) return null;
  return value;
}
async function readKeyringAfterIntegrityRepair(opts) {
  const { account, primary, diag } = opts;
  if (primary.ok || !isIntegrityError(primary.error)) return { primary, repaired: false };
  reportWarning(diag, `${classifyKeyringError(primary.error)} (account ${account}); repairing keyring journal`);
  const repaired = await _credentialStoreInternals.keyringOperation({
    operation: "repair",
    service: KEYRING_SERVICE,
    account
  });
  if (!repaired.ok) {
    reportWarning(diag, classifyKeyringError(repaired.error));
    return { primary, repaired: false };
  }
  if (repaired.value !== null) return { primary: { ok: true, value: repaired.value }, repaired: true };
  return { primary: await readKeyringService(KEYRING_SERVICE, account), repaired: true };
}
async function readStoredCredential(account, diag) {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const { primary, repaired } = await readKeyringAfterIntegrityRepair({
      account,
      primary: await readKeyringService(KEYRING_SERVICE, account),
      diag
    });
    if (!primary.ok) {
      if (isIntegrityError(primary.error)) {
        const suffix = repaired ? " after automatic keyring repair" : "; run `leverframe keyring repair` to rebuild the journal";
        reportWarning(diag, `${classifyKeyringError(primary.error)} (account ${account})${suffix}`);
        return null;
      }
      reportWarning(diag, classifyKeyringError(primary.error));
    }
    let fallback;
    try {
      fallback = readFallbackCredential(account);
    } catch (error) {
      reportWarning(diag, `Could not read credential fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (fallback !== null) return promoteFallbackCredential(account, fallback, diag);
    if (primary.ok && primary.deleted) return null;
    if (primary.ok && primary.value !== null) return primary.value;
    for (const service of LEGACY_KEYRING_SERVICES) {
      const legacy = await readKeyringService(service, account);
      if (legacy.ok && legacy.value !== null) {
        await writeStoredCredentialUnlocked(account, legacy.value, diag);
        return legacy.value;
      }
      if (!legacy.ok) {
        reportWarning(diag, classifyKeyringError(legacy.error));
        if (isIntegrityError(legacy.error)) return null;
      }
    }
    return null;
  });
}
async function writeStoredCredentialUnlocked(account, value, diag) {
  let staged = false;
  try {
    staged = readFallbackCredential(account) !== null;
    if (staged) writeFallbackCredential(account, value);
  } catch (error) {
    reportWarning(diag, `Could not update credential fallback: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const result = await _credentialStoreInternals.keyringOperation({ operation: "write", service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    if (!removeFallbackCredential(account, diag)) {
      reportWarning(diag, "Keyring save succeeded, but stale fallback material remains queued for removal");
    }
    return true;
  }
  reportWarning(diag, classifyKeyringError(result.error));
  if (isIntegrityError(result.error)) return false;
  try {
    if (!staged) writeFallbackCredential(account, value);
    reportWarning(diag, fallbackWarning());
    return true;
  } catch (error) {
    reportWarning(diag, `Could not write credential fallback: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function writeStoredCredential(account, value, diag) {
  return withCredentialMutationLock(
    `keyring:${account}`,
    () => writeStoredCredentialUnlocked(account, value, diag)
  );
}
function deleteStoredCredential(account, diag) {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    if (!removeFallbackCredential(account, diag)) return false;
    const result = await _credentialStoreInternals.keyringOperation({ operation: "delete", service: KEYRING_SERVICE, account });
    if (!result.ok) reportWarning(diag, classifyKeyringError(result.error));
    return result.ok;
  });
}
function repairStoredCredential(account) {
  return withCredentialMutationLock(
    `keyring:${account}`,
    () => _credentialStoreInternals.keyringOperation({ operation: "repair", service: KEYRING_SERVICE, account })
  );
}
async function diagnoseCredentialStorage(env = process.env) {
  if (process.platform !== "linux") return [];
  const headless = Boolean(env.SSH_CONNECTION || env.SSH_TTY || !env.DISPLAY && !env.WAYLAND_DISPLAY);
  const diagnostics = [];
  if (headless) diagnostics.push({ level: "info", message: "Headless/SSH session detected; OpenAI device-code sign-in does not require a GUI." });
  const helperEnv = buildKeyringHelperEnv(env);
  const dbusReason = missingDbusReason(helperEnv);
  const probe = dbusReason ? { ok: false, error: dbusReason } : await runIsolatedKeyringOperation({ operation: "read", service: KEYRING_SERVICE, account: "__leverframe_probe__" }, { env: helperEnv });
  if (!probe.ok) {
    diagnostics.push({
      level: "warn",
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`
    });
  }
  return diagnostics;
}

// src/config-lock.ts
import { randomUUID as randomUUID3 } from "crypto";
import { constants as fsConstants } from "fs";
import { dirname as dirname5, join as join7 } from "path";
import {
  closeSync as closeSync4,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync5,
  openSync as openSync4,
  readFileSync as readFileSync4,
  unlinkSync as unlinkSync4,
  utimesSync,
  writeFileSync as writeFileSync3
} from "fs";
var CONFIG_DIR_MODE = 448;
var CONFIG_LOCK_WAIT_MS = 5e3;
var CONFIG_LOCK_RETRY_MS = 25;
var CONFIG_LOCK_MALFORMED_GRACE_MS = 500;
var CONFIG_LOCK_FUTURE_SKEW_MS = 5e3;
var CONFIG_LOCK_BUSY_ERROR = "ConfigLockBusyError";
var O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
function getConfigLockPath() {
  return join7(getAppHome(), "config.lock");
}
function getServerPasswordLockPath() {
  return join7(getAppHome(), "server-password.lock");
}
var ConfigLockBusyError = class extends Error {
  lockPath;
  constructor(lockPath, waitedMs) {
    super(
      `Could not acquire the config lock at ${lockPath} after ${waitedMs}ms. Another leverframe process is likely writing preferences or migrating a server password. If no leverframe process is running, remove the lock file and re-run.`
    );
    this.name = CONFIG_LOCK_BUSY_ERROR;
    this.lockPath = lockPath;
  }
};
function isRegularLockPath(lockPath) {
  try {
    return lstatSync3(lockPath).isFile();
  } catch {
    return true;
  }
}
function assertLockPathIsRegular(lockPath) {
  if (!isRegularLockPath(lockPath)) {
    throw new Error(`Config lock path is not a regular file: ${lockPath}`);
  }
}
function tryAcquireConfigLock(lockPath = getConfigLockPath(), opts = {}) {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? pidIsAlive;
  const nonce = randomUUID3();
  mkdirSync5(dirname5(lockPath), { recursive: true, mode: CONFIG_DIR_MODE });
  for (let attempt = 0; attempt < 3; attempt++) {
    assertLockPathIsRegular(lockPath);
    let fd;
    try {
      fd = openSync4(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW);
    } catch (err) {
      const code = err?.code;
      if (code === "EEXIST") {
        if (maybeUnlinkStaleLock(lockPath, alive, { now })) continue;
        return null;
      }
      if (code === "ELOOP") {
        throw new Error(`Config lock path is a symlink and cannot be used: ${lockPath}`);
      }
      throw err;
    }
    let dataWritten = false;
    try {
      writeFileSync3(fd, JSON.stringify({ pid: process.pid, startedAt: now, nonce }));
      dataWritten = true;
      closeSync4(fd);
      fd = void 0;
    } catch (publishErr) {
      if (fd !== void 0) {
        try {
          closeSync4(fd);
        } catch {
        }
        fd = void 0;
      }
      if (dataWritten) {
        unlinkLockIfOwned(lockPath, nonce);
      } else {
        try {
          unlinkSync4(lockPath);
        } catch {
        }
      }
      throw publishErr;
    }
    return () => releaseConfigLock(lockPath, nonce);
  }
  return null;
}
function readLockMetadata(lockPath) {
  let raw;
  try {
    raw = readFileSync4(lockPath, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed;
  if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid)) return null;
  if (typeof obj.startedAt !== "number" || !Number.isFinite(obj.startedAt)) return null;
  if (typeof obj.nonce !== "string" || obj.nonce.length === 0) return null;
  return { pid: obj.pid, startedAt: obj.startedAt, nonce: obj.nonce };
}
function readLockMtimeMs(lockPath) {
  try {
    return lstatSync3(lockPath).mtimeMs;
  } catch {
    return null;
  }
}
function maybeUnlinkStaleLock(lockPath, alive, opts = {}) {
  const now = opts.now ?? Date.now();
  const meta = readLockMetadata(lockPath);
  if (meta === null) {
    const mtime = readLockMtimeMs(lockPath);
    if (mtime === null) return false;
    const age = now - mtime;
    if (age >= 0) {
      if (age < CONFIG_LOCK_MALFORMED_GRACE_MS) return false;
    } else if (-age < CONFIG_LOCK_FUTURE_SKEW_MS) {
      return false;
    }
    try {
      unlinkSync4(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  if (!alive(meta.pid)) {
    try {
      unlinkSync4(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
function unlinkLockIfOwned(lockPath, nonce) {
  const current = readLockMetadata(lockPath);
  if (current === null || current.nonce !== nonce) return;
  try {
    unlinkSync4(lockPath);
  } catch {
  }
}
function releaseConfigLock(lockPath, nonce) {
  try {
    const current = JSON.parse(readFileSync4(lockPath, "utf8"));
    if (current.nonce !== nonce) return;
  } catch {
    return;
  }
  try {
    unlinkSync4(lockPath);
  } catch {
  }
}
function sleepSync3(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withConfigWriteLock(mutate) {
  const lockPath = getConfigLockPath();
  const release = acquireConfigLockSync(lockPath);
  try {
    return mutate();
  } finally {
    release();
  }
}
function acquireConfigLockSync(lockPath = getConfigLockPath()) {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (; ; ) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    sleepSync3(CONFIG_LOCK_RETRY_MS);
  }
}
async function acquireServerPasswordLock() {
  const lockPath = getServerPasswordLockPath();
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (; ; ) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, CONFIG_LOCK_RETRY_MS);
      timer.unref?.();
    });
  }
}

// src/config.ts
var CONFIG_FILE_MODE = 384;
function validateLaunchConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const candidate = raw;
  if (typeof candidate.bypassPermissions !== "boolean") return void 0;
  return { bypassPermissions: candidate.bypassPermissions };
}
var CorruptConfigError = class extends Error {
  configPath;
  constructor(configPath, options) {
    super(
      `Config file at ${configPath} exists but is unreadable or not valid JSON. Inspect or restore it (a \`.bak\` sibling may exist), then re-run. Removing the file resets preferences to defaults.`,
      options
    );
    this.name = "CorruptConfigError";
    this.configPath = configPath;
  }
};
function readConfig() {
  ensureLegacyAppHomeMigrated();
  const configPath = getConfigPath();
  if (!existsSync3(configPath)) return {};
  let raw;
  try {
    raw = readFileSync5(configPath, "utf8");
  } catch (err) {
    throw new CorruptConfigError(configPath, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptConfigError(configPath, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptConfigError(configPath);
  }
  return parsed;
}
function writeConfig(config) {
  durableAtomicWrite(
    getConfigPath(),
    `${JSON.stringify(config, null, 2)}
`,
    { mode: CONFIG_FILE_MODE, directoryMode: CONFIG_DIR_MODE }
  );
}
function loadPreferences() {
  let config;
  try {
    config = readConfig();
  } catch (err) {
    if (err instanceof CorruptConfigError) {
      console.warn(`leverframe: ${err.message}`);
      return {};
    }
    throw err;
  }
  return {
    lastModel: config.lastModel,
    lastProvider: config.lastProvider,
    recentModelsByProvider: config.recentModelsByProvider,
    favoriteModels: config.favoriteModels,
    modelAliases: config.modelAliases,
    claudeBridgeMode: config.claudeBridgeMode,
    serverBridgeMode: config.serverBridgeMode,
    appPathOverrides: config.appPathOverrides,
    recentLaunchFolders: config.recentLaunchFolders,
    launch: validateLaunchConfig(config.launch),
    server: config.server
  };
}
function savePreferences(prefs) {
  withConfigWriteLock(() => {
    const config = readConfig();
    if (prefs.lastModel !== void 0) config.lastModel = prefs.lastModel;
    if (prefs.lastProvider !== void 0) config.lastProvider = prefs.lastProvider;
    if (prefs.recentModelsByProvider !== void 0) config.recentModelsByProvider = prefs.recentModelsByProvider;
    if (prefs.favoriteModels !== void 0) config.favoriteModels = prefs.favoriteModels;
    if (prefs.modelAliases !== void 0) config.modelAliases = prefs.modelAliases;
    if (prefs.claudeBridgeMode !== void 0) config.claudeBridgeMode = prefs.claudeBridgeMode;
    if (prefs.serverBridgeMode !== void 0) config.serverBridgeMode = prefs.serverBridgeMode;
    if (prefs.appPathOverrides !== void 0) config.appPathOverrides = prefs.appPathOverrides;
    if (prefs.recentLaunchFolders !== void 0) config.recentLaunchFolders = prefs.recentLaunchFolders;
    writeConfig(config);
  });
}
function getAppPathOverride(appId) {
  const value = loadPreferences().appPathOverrides?.[appId];
  return typeof value === "string" && value.trim() ? value : void 0;
}
function resolveBridgeMode(command, explicit, opts = {}) {
  const key = command === "claude" ? "claudeBridgeMode" : "serverBridgeMode";
  if (explicit) {
    if (opts.persist === true) savePreferences({ [key]: explicit });
    return explicit;
  }
  return loadPreferences()[key] ?? "proxy";
}
var MAX_RECENT_MODELS = 3;
function recordLaunchSelection(_agent, providerId, modelId, prefs) {
  const prevRecent = prefs.recentModelsByProvider?.[providerId] ?? [];
  const updatedRecent = [modelId, ...prevRecent.filter((id) => id !== modelId)].slice(0, MAX_RECENT_MODELS);
  savePreferences({
    lastProvider: providerId,
    lastModel: modelId,
    recentModelsByProvider: { ...prefs.recentModelsByProvider, [providerId]: updatedRecent }
  });
}
var SERVER_PASSWORD_SERVICE = "leverframe-server-password";
var SERVER_PASSWORD_ACCOUNT = "server-password";
async function getSavedServerPassword() {
  const release = await acquireServerPasswordLock();
  try {
    const peeked = loadPreferences();
    const pwd = peeked.server?.savedPassword;
    if (pwd) {
      const migrated = await runIsolatedKeyringOperation({
        operation: "write",
        service: SERVER_PASSWORD_SERVICE,
        account: SERVER_PASSWORD_ACCOUNT,
        value: pwd
      });
      if (migrated.ok) {
        try {
          withConfigWriteLock(() => {
            const config = readConfig();
            if (config.server?.savedPassword !== pwd) return;
            delete config.server.savedPassword;
            if (Object.keys(config.server).length === 0) delete config.server;
            writeConfig(config);
          });
        } catch {
        }
        return { status: "ok", password: pwd };
      }
      return {
        status: "migration-failed",
        plaintextPresent: true,
        error: classifyKeyringError(migrated.error)
      };
    }
    const result = await runIsolatedKeyringOperation({
      operation: "read",
      service: SERVER_PASSWORD_SERVICE,
      account: SERVER_PASSWORD_ACCOUNT
    });
    if (result.ok) {
      return result.value === null ? { status: "absent" } : { status: "ok", password: result.value };
    }
    return {
      status: "migration-failed",
      plaintextPresent: false,
      error: classifyKeyringError(result.error)
    };
  } finally {
    release();
  }
}
async function setSavedServerPassword(password) {
  const release = await acquireServerPasswordLock();
  try {
    const result = await runIsolatedKeyringOperation({
      operation: "write",
      service: SERVER_PASSWORD_SERVICE,
      account: SERVER_PASSWORD_ACCOUNT,
      value: password
    });
    if (result.ok) {
      withConfigWriteLock(() => {
        const config = readConfig();
        if (!config.server?.savedPassword) return;
        delete config.server.savedPassword;
        if (Object.keys(config.server).length === 0) delete config.server;
        writeConfig(config);
      });
      return { ok: true };
    }
    return { ok: false, error: classifyKeyringError(result.error) };
  } finally {
    release();
  }
}
function getServerExposedProviders() {
  const list = loadPreferences().server?.exposedProviders;
  return list && list.length > 0 ? list : null;
}
function setServerExposedProviders(providerIds) {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...config.server,
      exposedProviders: providerIds
    };
    writeConfig(config);
  });
}
function getServerMaskGatewayIds() {
  return loadPreferences().server?.maskGatewayIds ?? true;
}
function setServerMaskGatewayIds(mask) {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...config.server,
      maskGatewayIds: mask
    };
    writeConfig(config);
  });
}
function getServerFavoritesOnly() {
  return loadPreferences().server?.favoritesOnly ?? false;
}
function setServerFavoritesOnly(favoritesOnly) {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...config.server,
      favoritesOnly
    };
    writeConfig(config);
  });
}
function getServerListenMode() {
  return loadPreferences().server?.listenMode === "network" ? "network" : "local";
}
function setServerListenMode(listenMode) {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...config.server,
      listenMode
    };
    writeConfig(config);
  });
}

// src/launch.ts
import { execFileSync as execFileSync2, spawn as spawn2 } from "child_process";
import { existsSync as existsSync5, appendFileSync } from "fs";
import { homedir as homedir3 } from "os";
import { join as join8 } from "path";

// src/binary-lookup.ts
import { execFileSync } from "child_process";
import { existsSync as existsSync4 } from "fs";
function findBinaryOnPath(name, fallbackPaths, options = {}) {
  const isWindows2 = options.isWindows ?? process.platform === "win32";
  const exists = options.exists ?? existsSync4;
  const runWhich = options.runWhich ?? ((binary, win) => execFileSync(win ? "where.exe" : "which", [binary], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }));
  try {
    const lines = runWhich(name, isWindows2).trim().split("\n").map((line) => line.trim()).filter(Boolean);
    const path = (isWindows2 ? lines.find((line) => line.toLowerCase().endsWith(".cmd")) : null) ?? lines[0];
    if (path && (!options.verifyWhichResult || exists(path))) return path;
  } catch {
  }
  for (const path of fallbackPaths) {
    if (exists(path)) return path;
  }
  return null;
}

// src/launch.ts
var isWindows = process.platform === "win32";
var CMD_PATH_METACHARACTERS = /[\r\n"&|<>^()%!]/;
var FALLBACK_PATHS = isWindows ? [
  join8(process.env["APPDATA"] ?? homedir3(), "npm", "claude.cmd"),
  join8(process.env["APPDATA"] ?? homedir3(), "npm", "claude"),
  join8(homedir3(), "AppData", "Roaming", "npm", "claude.cmd")
] : [
  join8(homedir3(), ".local", "bin", "claude"),
  join8(homedir3(), ".npm", "bin", "claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude"
];
function findClaudeBinary() {
  const environmentOverride = process.env["LEVERFRAME_CLAUDE_PATH"];
  if (environmentOverride?.trim()) {
    return existsSync5(environmentOverride) ? environmentOverride : null;
  }
  const override = getAppPathOverride("claude");
  if (override) return existsSync5(override) ? override : null;
  return findBinaryOnPath("claude", FALLBACK_PATHS);
}
function buildClaudeVersionProbe(claudePath, platform = process.platform, comSpec = process.env["ComSpec"] || "cmd.exe") {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(claudePath)) {
    return { file: claudePath, args: ["--version"] };
  }
  if (CMD_PATH_METACHARACTERS.test(claudePath)) return null;
  return {
    file: comSpec,
    args: ["/d", "/s", "/c", `"${claudePath}" --version`]
  };
}
function getInstalledClaudeVersion(claudePathOverride) {
  try {
    const claudePath = claudePathOverride ?? findClaudeBinary();
    if (!claudePath) return "2.1.183";
    const probe = buildClaudeVersionProbe(claudePath);
    if (!probe) return "2.1.183";
    const result = execFileSync2(probe.file, probe.args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5e3,
      killSignal: "SIGKILL"
    });
    const match = result.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {
  }
  return "2.1.183";
}
var PERMISSION_OVERRIDE_FLAGS = ["--dangerously-skip-permissions", "--permission-mode"];
function buildClaudeArgs(model, extraArgs, options = {}) {
  const args = model ? ["--model", model, ...extraArgs] : [...extraArgs];
  const userOverrodePermissions = extraArgs.some((arg) => PERMISSION_OVERRIDE_FLAGS.includes(arg));
  if (options.bypassPermissions && !userOverrodePermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}
function launchClaude(options) {
  const { installation, env, model, extraArgs } = options;
  return new Promise((resolve) => {
    const launchOverride = env["LEVERFRAME_CLAUDE_LAUNCH_PATH"]?.trim();
    const claudePath = launchOverride && existsSync5(launchOverride) && (!isWindows || !CMD_PATH_METACHARACTERS.test(launchOverride)) ? launchOverride : installation.canonicalPath;
    const bypassPermissions = loadPreferences().launch?.bypassPermissions === true;
    const args = buildClaudeArgs(model, extraArgs, { bypassPermissions });
    const debugFileIdx = extraArgs.indexOf("--debug-file");
    const debugLogPath = debugFileIdx !== -1 && extraArgs[debugFileIdx + 1] ? extraArgs[debugFileIdx + 1] : void 0;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const muteWrite = (chunk, encodingOrCallback, callback) => {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (debugLogPath) {
        try {
          const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          appendFileSync(debugLogPath, `[parent] ${str}`);
        } catch {
        }
      }
      done?.();
      return true;
    };
    process.stdout.write = muteWrite;
    process.stderr.write = muteWrite;
    const restore = () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    };
    const child = spawn2(claudePath, args, {
      stdio: "inherit",
      env,
      shell: isWindows
    });
    const forward = (signal) => {
      child.kill(signal);
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    child.on("exit", (code) => {
      restore();
      resolve(code ?? 0);
    });
    child.on("error", () => {
      restore();
      resolve(1);
    });
  });
}

// src/context-model-id.ts
var ONE_M_CONTEXT_SUFFIX = "[1m]";
var ONE_M_CONTEXT_WINDOW = 1e6;
function stripOneMContextSuffix(modelId) {
  return modelId.replace(/\[1m\]$/i, "");
}
function claudeCodeClientModelId(modelId, contextWindow) {
  const bare = stripOneMContextSuffix(modelId);
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow >= ONE_M_CONTEXT_WINDOW) {
    return `${bare}${ONE_M_CONTEXT_SUFFIX}`;
  }
  return bare;
}
function routeLookupIds(id) {
  const bare = stripOneMContextSuffix(id);
  const googleBare = bare.startsWith("models/") ? bare.slice("models/".length) : bare;
  return [.../* @__PURE__ */ new Set([
    id,
    bare,
    `${bare}${ONE_M_CONTEXT_SUFFIX}`,
    googleBare,
    `${googleBare}${ONE_M_CONTEXT_SUFFIX}`,
    `models/${googleBare}`,
    `models/${bare}`
  ])];
}

// src/oauth/types.ts
function oauthCredentialToKeychainJson(cred) {
  return JSON.stringify(cred);
}
function tokensToStoredCredential(tokens, existingRefresh, accountId, providerData) {
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? existingRefresh ?? "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1e3,
    ...accountId ? { accountId } : {},
    ...providerData ? { providerData } : {}
  };
}
function parseStoredOAuthCredential(raw) {
  if (!raw?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === "oauth" && typeof parsed.access === "string" && typeof parsed.refresh === "string" && typeof parsed.expires === "number" && (parsed.accessRejected === void 0 || parsed.accessRejected === true)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
var OAUTH_REFRESH_SKEW_MS = 12e4;
function oauthCredentialNeedsRefresh(cred, skewMs = OAUTH_REFRESH_SKEW_MS) {
  return cred.expires <= Date.now() + Math.max(0, skewMs);
}
function accessTokenIsExpiring(token, skewMs = OAUTH_REFRESH_SKEW_MS) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (typeof claims.exp !== "number") return false;
    return claims.exp * 1e3 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}
var NATIVE_OAUTH_PROVIDER_IDS = ["openai", "openai-oauth", "github-copilot"];
function supportsNativeOAuth(providerId) {
  return NATIVE_OAUTH_PROVIDER_IDS.includes(providerId);
}

// src/oauth/pkce.ts
function positiveSecondsToMs(value, defaultMs) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : defaultMs;
}
async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// src/oauth/fetch-timeout.ts
var OAUTH_REQUEST_TIMEOUT_MS = 15e3;
async function withAbortTimeout(operation, timeoutMessage, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// src/oauth/refresh-http.ts
async function postOAuthRefresh(url, body, options) {
  const isJson = options.contentType === "json";
  return withAbortTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...options.headers
      },
      body: isJson ? JSON.stringify(body) : body.toString(),
      signal
    });
    if (!response.ok) {
      const detail = options.includeBody ? await response.text().catch(() => "") : "";
      const status = options.includeStatus ? ` (${response.status})` : "";
      throw new Error(`${options.errorPrefix}${status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }, `${options.errorPrefix}: request timed out`);
}

// src/oauth/openai.ts
var CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var ISSUER = "https://auth.openai.com";
var OAUTH_POLLING_SAFETY_MARGIN_MS = 3e3;
var DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1e3;
function extractOpenAiAccountId(tokens) {
  const token = tokens.id_token ?? tokens.access_token;
  if (!token) return void 0;
  const parts = token.split(".");
  if (parts.length !== 3) return void 0;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return claims.chatgpt_account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.organizations?.[0]?.id;
  } catch {
    return void 0;
  }
}
async function requestOpenAiDeviceCode() {
  return withAbortTimeout(async (signal) => {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `leverframe/${VERSION}`
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal
    });
    if (!response.ok) throw new Error("Failed to initiate OpenAI device authorization");
    return response.json();
  }, "OpenAI device-code request timed out");
}
function openAiDeviceCodeUrl() {
  return `${ISSUER}/codex/device`;
}
async function pollOpenAiDeviceCodeToken(deviceData, opts) {
  const sleep2 = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? (() => Date.now());
  const intervalMs = Math.max(parseInt(deviceData.interval, 10) || 5, 1) * 1e3;
  const deadline = now() + positiveSecondsToMs(deviceData.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);
  while (now() < deadline) {
    const remainingMs = Math.max(0, deadline - now());
    const requestTimeoutMs = Math.min(OAUTH_REQUEST_TIMEOUT_MS, remainingMs);
    let response;
    try {
      response = await withAbortTimeout(async (signal) => {
        const result = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `leverframe/${VERSION}`
          },
          body: JSON.stringify({
            device_auth_id: deviceData.device_auth_id,
            user_code: deviceData.user_code
          }),
          signal
        });
        return {
          status: result.status,
          data: result.ok ? await result.json() : void 0
        };
      }, "OpenAI device authorization poll request timed out", requestTimeoutMs);
    } catch (err) {
      if (now() >= deadline) throw new Error("OpenAI device authorization timed out", { cause: err });
      throw err;
    }
    if (response.data) {
      const data = response.data;
      let tokens;
      try {
        tokens = await withAbortTimeout(async (signal) => {
          const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: data.authorization_code,
              redirect_uri: `${ISSUER}/deviceauth/callback`,
              client_id: CLIENT_ID,
              code_verifier: data.code_verifier
            }).toString(),
            signal
          });
          if (!tokenResponse.ok) throw new Error(`OpenAI token exchange failed (${tokenResponse.status})`);
          return tokenResponse.json();
        }, "OpenAI token exchange request timed out", Math.min(OAUTH_REQUEST_TIMEOUT_MS, Math.max(0, deadline - now())));
      } catch (err) {
        if (now() >= deadline) throw new Error("OpenAI device authorization timed out", { cause: err });
        throw err;
      }
      return { tokens, accountId: extractOpenAiAccountId(tokens) };
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`OpenAI device authorization failed (${response.status})`);
    }
    await sleep2(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, Math.max(0, deadline - now())));
  }
  throw new Error("OpenAI device authorization timed out");
}
async function refreshOpenAiAccessToken(refreshToken) {
  return postOAuthRefresh(
    `${ISSUER}/oauth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    }),
    {
      contentType: "form",
      errorPrefix: "OpenAI token refresh failed",
      includeStatus: true
    }
  );
}
async function runOpenAiDeviceCodeFlow(onDeviceCode, opts) {
  const deviceData = await requestOpenAiDeviceCode();
  onDeviceCode({ url: openAiDeviceCodeUrl(), userCode: deviceData.user_code });
  return pollOpenAiDeviceCodeToken(deviceData, opts);
}

// src/oauth/refresh.ts
function oauthCredentialShouldRefresh(cred, providerId) {
  if (cred.accessRejected === true) return true;
  if (oauthCredentialNeedsRefresh(cred)) return true;
  if (NATIVE_OAUTH_PROVIDER_IDS.includes(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}
async function refreshStoredOAuthCredential(providerId, cred) {
  if (providerId === "github-copilot") {
    throw new Error(
      "github-copilot: GitHub OAuth token cannot be refreshed; run leverframe providers auth github-copilot"
    );
  }
  if (!cred.refresh) {
    throw new Error(`${providerId}: OAuth refresh token missing. Run leverframe providers auth ${providerId}`);
  }
  if (providerId !== "openai" && providerId !== "openai-oauth") {
    throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
  }
  const tokens = await refreshOpenAiAccessToken(cred.refresh);
  return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
}

// src/env.ts
var HTTP_PROXY_AUTH_USER = "leverframe";
var HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY = "sk-ant-api03-leverframe-http-proxy";
var ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
function ensureAnthropicProxyChildAuth(env) {
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
  const authToken = env["ANTHROPIC_AUTH_TOKEN"]?.trim();
  if (apiKey || authToken) return;
  env["ANTHROPIC_API_KEY"] = HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY;
}
function withProxyAnthropicOriginSettings(claudeArgs) {
  const hasSettings = claudeArgs.some((arg) => arg === "--settings" || arg.startsWith("--settings="));
  if (hasSettings) return [...claudeArgs];
  return [
    "--settings",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: ANTHROPIC_API_ORIGIN } }),
    ...claudeArgs
  ];
}
function detectConflicts() {
  return CONFLICTING_ENV_VARS.filter((name) => process.env[name] !== void 0).map((name) => ({ name, value: process.env[name] }));
}
function applyClaudeCodeThirdPartyCompat(env) {
  env["ENABLE_TOOL_SEARCH"] = "true";
  env["CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT"] = "0";
}
function buildChildEnv(baseUrl, model, apiKey, proxyPort, contextWindow, enableGatewayDiscovery) {
  const env = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    delete env[name];
  }
  env["ANTHROPIC_BASE_URL"] = proxyPort ? `http://127.0.0.1:${proxyPort}` : baseUrl;
  env["ANTHROPIC_API_KEY"] = apiKey;
  env["ANTHROPIC_MODEL"] = claudeCodeClientModelId(model, contextWindow);
  delete env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"];
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = String(contextWindow);
  }
  if (enableGatewayDiscovery) {
    env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1";
  }
  applyClaudeCodeThirdPartyCompat(env);
  return env;
}
function applyAnthropicProxyEnvNormalization(env) {
  for (const name of CONFLICTING_ENV_VARS) {
    if (name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN" || name === "ANTHROPIC_MODEL") continue;
    delete env[name];
  }
  const noProxy = env["NO_PROXY"] ?? env["no_proxy"];
  if (noProxy !== void 0) {
    const filtered = noProxy.split(",").map((value) => value.trim()).filter(Boolean).filter((value) => {
      const entry = value.toLowerCase().replace(/^https?:\/\//, "");
      const host = entry.replace(/:\d+$/, "");
      if (host === "*") return false;
      const suffix = host.startsWith("*.") ? host.slice(1) : host;
      const bypassesAnthropic = suffix.startsWith(".") ? "api.anthropic.com".endsWith(suffix) : "api.anthropic.com" === suffix || "api.anthropic.com".endsWith(`.${suffix}`);
      return !bypassesAnthropic;
    }).join(",");
    if (filtered) {
      env["NO_PROXY"] = filtered;
      env["no_proxy"] = filtered;
    } else {
      delete env["NO_PROXY"];
      delete env["no_proxy"];
    }
  }
  env["ANTHROPIC_BASE_URL"] = ANTHROPIC_API_ORIGIN;
}
function buildHttpProxyChildEnv(proxyPort, caCertPath, proxyToken) {
  const env = { ...process.env };
  applyAnthropicProxyEnvNormalization(env);
  const proxyUrl = proxyToken ? `http://${HTTP_PROXY_AUTH_USER}:${encodeURIComponent(proxyToken)}@127.0.0.1:${proxyPort}` : `http://127.0.0.1:${proxyPort}`;
  env["HTTPS_PROXY"] = proxyUrl;
  env["HTTP_PROXY"] = proxyUrl;
  env["https_proxy"] = proxyUrl;
  env["http_proxy"] = proxyUrl;
  env["NODE_EXTRA_CA_CERTS"] = caCertPath;
  env["CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"] = "1";
  ensureAnthropicProxyChildAuth(env);
  return env;
}
function oauthProviderKeyringAccount(providerId) {
  return `oauth:provider:${providerId}`;
}
function oauthProviderIdFromAccount(account) {
  const prefix = "oauth:provider:";
  return account.startsWith(prefix) ? account.slice(prefix.length) : null;
}
var oauthRefreshInflight = /* @__PURE__ */ new Map();
function parseAuthRef(authRef) {
  if (authRef === "none:anonymous") return { kind: "none" };
  if (authRef.startsWith("keyring:")) {
    const account = authRef.slice("keyring:".length);
    return account ? { kind: "keyring", account } : null;
  }
  if (authRef.startsWith("env:")) {
    const varName = authRef.slice("env:".length);
    return varName ? { kind: "env", varName } : null;
  }
  return null;
}
function leverframeKeyEnvVar(providerId) {
  return `LEVERFRAME_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
function readEnvCredential(varName) {
  const raw = process.env[varName];
  if (!raw?.trim()) return null;
  return raw.trim().split(/\r?\n/)[0]?.trim() || null;
}
async function readKeyringAccount(account, diag) {
  return readStoredCredential(account, diag);
}
async function writeKeyringAccount(account, key, diag) {
  return writeStoredCredential(account, key, diag);
}
async function deleteKeyringAccount(account, diag) {
  return deleteStoredCredential(account, diag);
}
async function resolveProviderCredential(providerId, authRef, diag, options = {}) {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === "none") return null;
  const namespaced = readEnvCredential(leverframeKeyEnvVar(providerId));
  if (namespaced && namespaced !== options.rejectedAccessToken) return namespaced;
  if (parsed.kind === "env") {
    const value = readEnvCredential(parsed.varName);
    return value === options.rejectedAccessToken ? null : value;
  }
  return readProviderSecret(parsed.account, diag, options.rejectedAccessToken);
}
async function resolveProviderOAuthAccountId(authRef, diag) {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== "keyring" || !oauthProviderIdFromAccount(parsed.account)) return void 0;
  const raw = await readKeyringAccount(parsed.account, diag);
  return parseStoredOAuthCredential(raw)?.accountId;
}
async function resolveProviderOAuthProviderData(authRef, diag) {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== "keyring" || !oauthProviderIdFromAccount(parsed.account)) return void 0;
  const raw = await readKeyringAccount(parsed.account, diag);
  return parseStoredOAuthCredential(raw)?.providerData;
}
function decodeProviderSecret(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const oauth = parseStoredOAuthCredential(trimmed);
  if (oauth) return oauth.access;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.type === "oauth" && typeof parsed.access === "string") return parsed.access;
    if (parsed.type === "wellknown" && typeof parsed.token === "string") return parsed.token;
  } catch {
  }
  return trimmed;
}
async function refreshOAuthKeyringAccount(account, providerId, initialRaw, diag, rejectedAccessToken) {
  const inflightKey = `${account}\0${rejectedAccessToken ?? ""}`;
  const existing = oauthRefreshInflight.get(inflightKey);
  if (existing) return existing;
  const work = withCredentialMutationLock(`keyring:${account}`, async () => {
    let raw = initialRaw;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latestRaw = await readKeyringAccount(account, diag);
      if (!latestRaw) return null;
      raw = latestRaw;
      const credential = parseStoredOAuthCredential(raw);
      if (!credential) {
        const decoded = decodeProviderSecret(raw);
        return decoded === rejectedAccessToken ? null : decoded;
      }
      const forceRefresh = credential.access === rejectedAccessToken || credential.accessRejected === true;
      if (!forceRefresh && !oauthCredentialShouldRefresh(credential, providerId)) return credential.access;
      let refreshed;
      try {
        refreshed = await refreshStoredOAuthCredential(providerId, credential);
      } catch (error) {
        diag?.(error instanceof Error ? error.message : String(error));
        if (!forceRefresh && credential.access && credential.expires > Date.now()) return credential.access;
        throw error;
      }
      if (await readKeyringAccount(account, diag) !== raw) continue;
      const accessRejected = refreshed.access === rejectedAccessToken || credential.accessRejected === true && refreshed.access === credential.access;
      const replacement = accessRejected ? { ...refreshed, accessRejected: true } : refreshed;
      const saved = await writeKeyringAccount(
        account,
        oauthCredentialToKeychainJson(replacement),
        diag
      );
      if (!saved) throw new Error("Could not persist refreshed OAuth credential");
      return accessRejected ? null : refreshed.access;
    }
    throw new Error("OAuth credential changed repeatedly while refresh was in progress");
  });
  oauthRefreshInflight.set(inflightKey, work);
  try {
    return await work;
  } finally {
    if (oauthRefreshInflight.get(inflightKey) === work) oauthRefreshInflight.delete(inflightKey);
  }
}
async function readProviderSecret(account, diag, rejectedAccessToken) {
  const raw = await readKeyringAccount(account, diag);
  if (!raw) return null;
  const oauthProviderId = oauthProviderIdFromAccount(account);
  if (oauthProviderId && raw.trim().startsWith("{")) {
    return refreshOAuthKeyringAccount(account, oauthProviderId, raw, diag, rejectedAccessToken);
  }
  const decoded = decodeProviderSecret(raw);
  return decoded === rejectedAccessToken ? null : decoded;
}
async function saveProviderCredential(authRef, key, diag) {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== "keyring") return false;
  return writeKeyringAccount(parsed.account, key, diag);
}
async function deleteProviderCredential(authRef, diag) {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== "keyring") return false;
  return deleteKeyringAccount(parsed.account, diag);
}

export {
  resolveAppHomeOverride,
  getAppHome,
  getDefaultAppHome,
  ensureLegacyAppHomeMigrated,
  getProvidersPath,
  getCredentialCleanupPath,
  getLogsPath,
  isDiscoveryDisabled,
  registerServerRuntimeState,
  unregisterServerRuntimeState,
  readLiveServerRuntimeStates,
  orderWrapperServerCandidates,
  CODEX_RESPONSES_LITE_WS_URL,
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_WEBSOCKETS_BETA,
  OPENCODE_CACHE_PATH,
  MAX_MODEL_CATALOG,
  DEFAULT_SERVER_PORT,
  VERTEX_ANTHROPIC_NPM,
  VERSION,
  stripOneMContextSuffix,
  claudeCodeClientModelId,
  routeLookupIds,
  oauthCredentialToKeychainJson,
  tokensToStoredCredential,
  supportsNativeOAuth,
  sleepMs,
  OAUTH_REQUEST_TIMEOUT_MS,
  withAbortTimeout,
  extractOpenAiAccountId,
  runOpenAiDeviceCodeFlow,
  getRegistryLockPath,
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
  withCredentialMutationLock,
  withProviderMutationLock,
  classifyKeyringError,
  runIsolatedKeyringOperation,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
  readFileStrict,
  durableAtomicWrite,
  repairStoredCredential,
  diagnoseCredentialStorage,
  HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY,
  ensureAnthropicProxyChildAuth,
  withProxyAnthropicOriginSettings,
  detectConflicts,
  buildChildEnv,
  applyAnthropicProxyEnvNormalization,
  buildHttpProxyChildEnv,
  oauthProviderKeyringAccount,
  parseAuthRef,
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
  resolveProviderOAuthProviderData,
  saveProviderCredential,
  deleteProviderCredential,
  loadPreferences,
  savePreferences,
  getAppPathOverride,
  resolveBridgeMode,
  recordLaunchSelection,
  getSavedServerPassword,
  setSavedServerPassword,
  getServerExposedProviders,
  setServerExposedProviders,
  getServerMaskGatewayIds,
  setServerMaskGatewayIds,
  getServerFavoritesOnly,
  setServerFavoritesOnly,
  getServerListenMode,
  setServerListenMode,
  findClaudeBinary,
  buildClaudeVersionProbe,
  getInstalledClaudeVersion,
  launchClaude
};
//# sourceMappingURL=chunk-D2RS7L4U.js.map