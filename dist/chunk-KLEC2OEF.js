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
  version: "0.1.0",
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
    "dist",
    "docs",
    "README.md"
  ],
  engines: {
    node: ">=22"
  },
  scripts: {
    build: "tsup",
    dev: "tsup --watch",
    test: "vitest run",
    "test:watch": "vitest",
    typecheck: "tsc --noEmit",
    prepare: "test ! -d .husky || husky"
  },
  dependencies: {
    "@ai-sdk/anthropic": "4.0.12",
    "@ai-sdk/openai": "4.0.11",
    "@ai-sdk/openai-compatible": "3.0.7",
    "@ai-sdk/provider-utils": "5.0.7",
    "@clack/prompts": "0.9.1",
    ai: "7.0.22",
    "https-proxy-agent": "9.1.0",
    "ipaddr.js": "2.4.0",
    "node-forge": "1.4.0",
    open: "11.0.0",
    picocolors: "1.1.1",
    tweakcc: "4.3.0",
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
    tsup: "8.5.1",
    typescript: "5.9.3",
    vitest: "2.1.9"
  },
  optionalDependencies: {
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

// src/context-window.ts
import { readFileSync as readFileSync2 } from "fs";
var DEFAULT_CONTEXT_WINDOW = 2e5;
var CACHE_PROVIDER_PRIORITY = /* @__PURE__ */ new Set(["opencode", "opencode-go"]);
var HEURISTIC_RULES = [
  [/gemini-2\.5-pro|gemini-1\.5-pro|gemini-3-pro/i, 2e6],
  [/gemini/i, 1e6],
  [/claude-opus-4-[678]|claude-sonnet-4-[678]/i, 1e6],
  [/claude-haiku-4-[567]/i, 2e5],
  [/claude.*\[1m\]/i, 1e6],
  [/claude-opus-4-[56]|claude-sonnet-4-[45]|claude-3/i, 2e5],
  [/claude/i, 2e5],
  [/deepseek-v4|deepseek-r1|deepseek-reasoner/i, 1e6],
  [/deepseek/i, 64e3],
  [/gpt-5|gpt-4\.1|o3-|o4-/i, 1e6],
  [/gpt-4o|gpt-4-turbo|gpt-4/i, 128e3],
  [/gpt-oss/i, 131072],
  [/qwen3|qwen-3|qwen2\.5-72b|qwen2\.5-32b|qwen-coder/i, 262144],
  [/qwen/i, 131072],
  [/^k3$|^k3-|kimi-k3/i, 1048576],
  [/kimi-k2|kimi-k2\.5|moonshot/i, 262144],
  [/minimax-m2/i, 204800],
  [/minimax/i, 128e3],
  [/mistral-large|ministral|mistral/i, 262144],
  [/llama-3\.[23]|llama3/i, 131072],
  [/grok-4\.20/i, 1e6],
  [/grok-4\.5/i, 5e5],
  [/grok-3|grok-4/i, 131072],
  [/nemotron/i, 131072],
  [/glm-5\.2/i, 1e6],
  [/glm-5-turbo|glm-4\.7/i, 128e3],
  [/glm-4/i, 128e3],
  [/solar-pro3/i, 131072],
  [/solar-pro2/i, 65536],
  [/solar/i, 32768]
];
var parsedCache;
var cacheIndex;
var heuristicCache = /* @__PURE__ */ new Map();
function loadOpencodeCache() {
  if (parsedCache === void 0) {
    try {
      parsedCache = JSON.parse(readFileSync2(OPENCODE_CACHE_PATH, "utf8"));
    } catch {
      parsedCache = null;
    }
  }
  return parsedCache;
}
function buildContextWindowIndex(cache) {
  const index = /* @__PURE__ */ new Map();
  const allLimits = /* @__PURE__ */ new Map();
  for (const [providerKey, providerData] of Object.entries(cache)) {
    const models = providerData?.models;
    if (!models) continue;
    for (const [modelId, entry] of Object.entries(models)) {
      const ctx = entry.limit?.context;
      if (typeof ctx !== "number" || ctx <= 0) continue;
      const limits = allLimits.get(modelId) ?? [];
      limits.push(ctx);
      allLimits.set(modelId, limits);
      if (CACHE_PROVIDER_PRIORITY.has(providerKey)) {
        index.set(modelId, ctx);
      }
    }
  }
  for (const [modelId, limits] of allLimits) {
    if (!index.has(modelId)) {
      index.set(modelId, Math.max(...limits));
    }
  }
  return index;
}
function getCacheIndex() {
  if (cacheIndex === void 0) {
    const cache = loadOpencodeCache();
    cacheIndex = cache ? buildContextWindowIndex(cache) : /* @__PURE__ */ new Map();
  }
  return cacheIndex;
}
function contextWindowFromHeuristics(modelId) {
  const cached = heuristicCache.get(modelId);
  if (cached !== void 0) return cached;
  for (const [pattern, size] of HEURISTIC_RULES) {
    if (pattern.test(modelId)) {
      heuristicCache.set(modelId, size);
      return size;
    }
  }
  heuristicCache.set(modelId, DEFAULT_CONTEXT_WINDOW);
  return DEFAULT_CONTEXT_WINDOW;
}
function lookupContextWindow(modelId) {
  return getCacheIndex().get(modelId) ?? contextWindowFromHeuristics(modelId);
}
function resolveContextWindow(modelId, explicit) {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  return lookupContextWindow(modelId);
}

// src/context-model-id.ts
var ONE_M_CONTEXT_SUFFIX = "[1m]";
var ONE_M_CONTEXT_WINDOW = 1e6;
function stripOneMContextSuffix(modelId) {
  return modelId.replace(/\[1m\]$/i, "");
}
function claudeCodeClientModelId(modelId, contextWindow) {
  const bare = stripOneMContextSuffix(modelId);
  const window = resolveContextWindow(bare, contextWindow);
  if (window >= ONE_M_CONTEXT_WINDOW) {
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
    if (parsed.type === "oauth" && typeof parsed.access === "string" && typeof parsed.refresh === "string" && typeof parsed.expires === "number") {
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
var NATIVE_OAUTH_PROVIDER_IDS = ["openai", "openai-oauth"];
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
  const sleep = opts?.sleep ?? sleepMs;
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
    await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, Math.max(0, deadline - now())));
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
  if (oauthCredentialNeedsRefresh(cred)) return true;
  if (NATIVE_OAUTH_PROVIDER_IDS.includes(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}
async function refreshStoredOAuthCredential(providerId, cred) {
  if (!cred.refresh) {
    throw new Error(`${providerId}: OAuth refresh token missing \u2014 run leverframe providers auth ${providerId}`);
  }
  let tokens;
  if (providerId === "openai" || providerId === "openai-oauth") {
    tokens = await refreshOpenAiAccessToken(cred.refresh);
  } else {
    throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
  }
  return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
}

// src/credential-store.ts
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createRequire } from "module";
import {
  chmodSync,
  existsSync as existsSync2,
  lstatSync,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname as dirname2, join as join4 } from "path";
import { pathToFileURL } from "url";
var KEYRING_SERVICE = "leverframe";
var LEGACY_KEYRING_SERVICES = ["clodex", "relay-ai"];
var KEYRING_TIMEOUT_MS = 3e3;
var FALLBACK_FILE_NAME = "credentials-fallback.json";
var FALLBACK_WARNING = "Using plaintext credential fallback storage (permissions 0600 in a 0700 directory); no at-rest encryption is available";
var KEYRING_CHILD_SOURCE = String.raw`
const CHUNK_PREFIX = '__relay_chunked__:';
const CHUNK_SIZE = 1200;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { Entry } = await import(input.moduleUrl);
  const entry = new Entry(input.service, input.account);
  let value = null;
  if (input.operation === 'read') {
    value = entry.getPassword() ?? null;
    if (value?.startsWith(CHUNK_PREFIX)) {
      const count = Number(value.slice(CHUNK_PREFIX.length));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Keyring credential has an invalid chunk marker');
      const parts = [];
      for (let index = 0; index < count; index++) {
        const part = new Entry(input.service, input.account + '::chunk::' + index).getPassword();
        if (!part) throw new Error('Keyring credential is incomplete');
        parts.push(part);
      }
      value = parts.join('');
      if (!value) throw new Error('Keyring credential is incomplete');
    }
  } else if (input.operation === 'write') {
    if (input.value.length <= CHUNK_SIZE) entry.setPassword(input.value);
    else {
      const count = Math.ceil(input.value.length / CHUNK_SIZE);
      for (let index = 0; index < count; index++) {
        new Entry(input.service, input.account + '::chunk::' + index)
          .setPassword(input.value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
      }
      entry.setPassword(CHUNK_PREFIX + count);
    }
  } else if (input.operation === 'delete') {
    value = entry.getPassword() ?? null;
    if (value?.startsWith(CHUNK_PREFIX)) {
      const count = Number(value.slice(CHUNK_PREFIX.length));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Keyring credential has an invalid chunk marker');
      for (let index = 0; index < count; index++) {
        new Entry(input.service, input.account + '::chunk::' + index).deletePassword();
      }
    }
    entry.deletePassword();
    value = null;
  }
  else throw new Error('Unsupported keyring operation');
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
`;
function classifyKeyringError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("timed out")) return "keyring operation timed out";
  if (lower.includes("cannot find module") || lower.includes("module not found") || lower.includes("failed to load")) {
    return "native keyring module not available on this system";
  }
  if (lower.includes("secret service") || lower.includes("dbus") || lower.includes("daemon")) {
    return "Secret Service daemon is not running (start GNOME Keyring or KWallet, or provide a D-Bus session)";
  }
  if (lower.includes("denied") || lower.includes("locked") || lower.includes("cancelled") || lower.includes("user refused")) {
    return "keychain access was denied or the keychain is locked";
  }
  return `keyring error: ${msg}`;
}
function resolveKeyringModule() {
  const resolved = createRequire(import.meta.url).resolve("@napi-rs/keyring");
  return pathToFileURL(resolved).href;
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
  for (const name of KEYRING_ENV_NAMES) {
    if (source[name] !== void 0) env[name] = source[name];
  }
  return env;
}
function runIsolatedKeyringOperation(input, options = {}) {
  if (!options.skipAvailabilityCheck) {
    const dbusReason = missingDbusReason(options.env ?? process.env);
    if (dbusReason) return Promise.resolve({ ok: false, error: dbusReason });
  }
  let moduleUrl;
  try {
    moduleUrl = options.moduleUrl ?? resolveKeyringModule();
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = (options.spawnImpl ?? spawn)(process.execPath, ["--input-type=module", "--eval", KEYRING_CHILD_SOURCE], {
        env: buildKeyringHelperEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
    const onStdinError = (err) => {
      finish({ ok: false, error: err.message }, true);
    };
    const onChildError = (err) => {
      finish({ ok: false, error: err.message }, true);
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
    timer = setTimeout(() => {
      finish({ ok: false, error: `keyring operation timed out after ${timeoutMs}ms` }, true);
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", onStdoutData);
    child.stdin.on("error", onStdinError);
    child.on("error", onChildError);
    child.on("close", onClose);
    child.stdin.end(JSON.stringify({ ...input, moduleUrl }));
  });
}
function getCredentialFallbackPath(env = process.env) {
  return join4(getAppHome(env), FALLBACK_FILE_NAME);
}
function emptyFallbackFile() {
  return { schemaVersion: 1, credentials: /* @__PURE__ */ Object.create(null) };
}
function readFallbackFile(path = getCredentialFallbackPath()) {
  if (!existsSync2(path)) return emptyFallbackFile();
  if (!lstatSync(path).isFile()) throw new Error(`Credential fallback path is not a regular file: ${path}`);
  chmodSync(dirname2(path), 448);
  chmodSync(path, 384);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(path, "utf8"));
  } catch (err) {
    throw new Error(`Credential fallback file is corrupt: ${path}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  const record = parsed;
  const credentials = record["credentials"];
  const fields = Object.keys(record);
  if (fields.length !== 2 || !fields.includes("schemaVersion") || !fields.includes("credentials") || record["schemaVersion"] !== 1 || !credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  for (const value of Object.values(credentials)) {
    if (typeof value !== "string") throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  return {
    schemaVersion: 1,
    credentials: Object.assign(/* @__PURE__ */ Object.create(null), credentials)
  };
}
function writeFallbackFile(data, path = getCredentialFallbackPath()) {
  const directory = dirname2(path);
  mkdirSync3(directory, { recursive: true, mode: 448 });
  chmodSync(directory, 448);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync2(temporary, `${JSON.stringify(data, null, 2)}
`, { flag: "wx", mode: 384 });
    chmodSync(temporary, 384);
    renameSync2(temporary, path);
    chmodSync(path, 384);
  } finally {
    rmSync2(temporary, { force: true });
  }
}
function readFallbackCredential(account, path = getCredentialFallbackPath()) {
  return readFallbackFile(path).credentials[account] ?? null;
}
function writeFallbackCredential(account, value, path = getCredentialFallbackPath()) {
  const data = readFallbackFile(path);
  data.credentials[account] = value;
  writeFallbackFile(data, path);
}
function deleteFallbackCredential(account, path = getCredentialFallbackPath()) {
  const data = readFallbackFile(path);
  if (!Object.hasOwn(data.credentials, account)) return false;
  delete data.credentials[account];
  writeFallbackFile(data, path);
  return true;
}
function missingDbusReason(env) {
  if (process.platform !== "linux" || env["DBUS_SESSION_BUS_ADDRESS"]?.trim()) return null;
  return "D-Bus session is unavailable; Secret Service keyring access cannot be used";
}
function reportCredentialWarning(diag, message) {
  if (diag) diag(message);
  else console.warn(`leverframe: ${message}`);
}
async function keyringOperation(input) {
  return runIsolatedKeyringOperation(input);
}
var _credentialStoreInternals = {
  keyringOperation
};
async function readKeyringService(service, account) {
  return _credentialStoreInternals.keyringOperation({ operation: "read", service, account });
}
async function readStoredCredential(account, diag) {
  const primary = await readKeyringService(KEYRING_SERVICE, account);
  if (primary.ok && primary.value !== null) return primary.value;
  if (!primary.ok) reportCredentialWarning(diag, classifyKeyringError(primary.error));
  for (const service of LEGACY_KEYRING_SERVICES) {
    const legacy = await readKeyringService(service, account);
    if (legacy.ok && legacy.value !== null) {
      await writeStoredCredential(account, legacy.value, diag);
      return legacy.value;
    }
    if (!legacy.ok) reportCredentialWarning(diag, classifyKeyringError(legacy.error));
  }
  const fallback = readFallbackCredential(account);
  if (fallback !== null) reportCredentialWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
  return fallback;
}
async function writeStoredCredential(account, value, diag) {
  const result = await _credentialStoreInternals.keyringOperation({ operation: "write", service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    try {
      deleteFallbackCredential(account);
    } catch (err) {
      reportCredentialWarning(diag, `Keyring save succeeded, but stale fallback material was not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
  reportCredentialWarning(diag, classifyKeyringError(result.error));
  try {
    writeFallbackCredential(account, value);
    reportCredentialWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return true;
  } catch (err) {
    reportCredentialWarning(diag, `Could not write credential fallback: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
async function deleteStoredCredential(account, diag) {
  const result = await _credentialStoreInternals.keyringOperation({ operation: "delete", service: KEYRING_SERVICE, account });
  if (!result.ok) reportCredentialWarning(diag, classifyKeyringError(result.error));
  let fallbackDeleted = false;
  try {
    fallbackDeleted = deleteFallbackCredential(account);
  } catch (err) {
    reportCredentialWarning(diag, `Could not update credential fallback: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.ok || fallbackDeleted;
}
async function diagnoseCredentialStorage(env = process.env) {
  if (process.platform !== "linux") return [];
  const headless = Boolean(env["SSH_CONNECTION"] || env["SSH_TTY"] || !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]);
  const diagnostics = [];
  if (headless) {
    diagnostics.push({ level: "info", message: "Headless/SSH session detected; OpenAI device-code sign-in does not require a GUI." });
  }
  const dbusReason = missingDbusReason(env);
  const probe = dbusReason ? { ok: false, error: dbusReason } : await runIsolatedKeyringOperation({ operation: "read", service: KEYRING_SERVICE, account: "__leverframe_probe__" });
  if (!probe.ok) {
    diagnostics.push({
      level: "warn",
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`
    });
  }
  return diagnostics;
}

// src/env.ts
var HTTP_PROXY_AUTH_USER = "leverframe";
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
  const bareModel = stripOneMContextSuffix(model);
  env["ANTHROPIC_MODEL"] = claudeCodeClientModelId(model, contextWindow);
  env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = String(resolveContextWindow(bareModel, contextWindow));
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
  return env;
}
function oauthProviderIdFromAccount(account) {
  const prefix = "oauth:provider:";
  return account.startsWith(prefix) ? account.slice(prefix.length) : null;
}
var oauthRefreshInflight = /* @__PURE__ */ new Map();
function parseAuthRef(authRef) {
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
async function resolveProviderCredential(providerId, authRef, diag) {
  const namespaced = readEnvCredential(leverframeKeyEnvVar(providerId));
  if (namespaced) return namespaced;
  const parsed = parseAuthRef(authRef);
  if (!parsed) return null;
  if (parsed.kind === "env") {
    return readEnvCredential(parsed.varName);
  }
  return readProviderSecret(parsed.account, diag);
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
async function refreshOAuthKeyringAccount(account, providerId, raw, diag) {
  const existing = oauthRefreshInflight.get(account);
  if (existing) return existing;
  const work = (async () => {
    const cred = parseStoredOAuthCredential(raw);
    if (!cred || !oauthCredentialShouldRefresh(cred, providerId)) {
      return decodeProviderSecret(raw);
    }
    try {
      const refreshed = await refreshStoredOAuthCredential(providerId, cred);
      const json = oauthCredentialToKeychainJson(refreshed);
      await writeKeyringAccount(account, json, diag);
      return refreshed.access;
    } catch (err) {
      diag?.(err instanceof Error ? err.message : String(err));
      if (cred.access && cred.expires > Date.now()) return cred.access;
      throw err;
    }
  })();
  oauthRefreshInflight.set(account, work);
  try {
    return await work;
  } finally {
    oauthRefreshInflight.delete(account);
  }
}
async function readProviderSecret(account, diag) {
  const raw = await readKeyringAccount(account, diag);
  if (!raw) return null;
  const oauthProviderId = oauthProviderIdFromAccount(account);
  if (oauthProviderId && raw.trim().startsWith("{")) {
    return refreshOAuthKeyringAccount(account, oauthProviderId, raw, diag);
  }
  return decodeProviderSecret(raw);
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

// src/config.ts
import { randomUUID as randomUUID2 } from "crypto";
import { constants as fsConstants } from "fs";
import { dirname as dirname3, join as join5 } from "path";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  existsSync as existsSync3,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync4,
  openSync as openSync2,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  rmSync as rmSync3,
  unlinkSync as unlinkSync2,
  utimesSync,
  writeFileSync as writeFileSync3
} from "fs";
var CONFIG_FILE_MODE = 384;
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
  return join5(getAppHome(), "config.lock");
}
function getServerPasswordLockPath() {
  return join5(getAppHome(), "server-password.lock");
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
    return lstatSync2(lockPath).isFile();
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
  const nonce = randomUUID2();
  mkdirSync4(dirname3(lockPath), { recursive: true, mode: CONFIG_DIR_MODE });
  for (let attempt = 0; attempt < 3; attempt++) {
    assertLockPathIsRegular(lockPath);
    let fd;
    try {
      fd = openSync2(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW);
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
      closeSync2(fd);
      fd = void 0;
    } catch (publishErr) {
      if (fd !== void 0) {
        try {
          closeSync2(fd);
        } catch {
        }
        fd = void 0;
      }
      if (dataWritten) {
        unlinkLockIfOwned(lockPath, nonce);
      } else {
        try {
          unlinkSync2(lockPath);
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
    return lstatSync2(lockPath).mtimeMs;
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
      unlinkSync2(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  if (!alive(meta.pid)) {
    try {
      unlinkSync2(lockPath);
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
    unlinkSync2(lockPath);
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
    unlinkSync2(lockPath);
  } catch {
  }
}
function sleepSync2(ms) {
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
    sleepSync2(CONFIG_LOCK_RETRY_MS);
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
    raw = readFileSync4(configPath, "utf8");
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
  const configPath = getConfigPath();
  mkdirSync4(dirname3(configPath), { recursive: true, mode: CONFIG_DIR_MODE });
  const tmpPath = `${configPath}.${process.pid}.${randomUUID2()}.tmp`;
  try {
    writeFileSync3(tmpPath, `${JSON.stringify(config, null, 2)}
`, {
      encoding: "utf8",
      mode: CONFIG_FILE_MODE
    });
    try {
      chmodSync2(tmpPath, CONFIG_FILE_MODE);
    } catch {
    }
    renameSync3(tmpPath, configPath);
    try {
      chmodSync2(configPath, CONFIG_FILE_MODE);
    } catch {
    }
  } finally {
    try {
      rmSync3(tmpPath, { force: true });
    } catch {
    }
  }
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
      ...config.server ?? {},
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
      ...config.server ?? {},
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
      ...config.server ?? {},
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
      ...config.server ?? {},
      listenMode
    };
    writeConfig(config);
  });
}

// src/launch.ts
import { execFileSync as execFileSync2, spawn as spawn2 } from "child_process";
import { existsSync as existsSync5, appendFileSync } from "fs";
import { homedir as homedir3 } from "os";
import { join as join6 } from "path";

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
  join6(process.env["APPDATA"] ?? homedir3(), "npm", "claude.cmd"),
  join6(process.env["APPDATA"] ?? homedir3(), "npm", "claude"),
  join6(homedir3(), "AppData", "Roaming", "npm", "claude.cmd")
] : [
  join6(homedir3(), ".local", "bin", "claude"),
  join6(homedir3(), ".npm", "bin", "claude"),
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
function buildClaudeArgs(model, extraArgs) {
  return model ? ["--model", model, ...extraArgs] : [...extraArgs];
}
function launchClaude(env, model, extraArgs) {
  return new Promise((resolve) => {
    const claudePath = findClaudeBinary();
    const args = buildClaudeArgs(model, extraArgs);
    const debugFileIdx = extraArgs.indexOf("--debug-file");
    const debugLogPath = debugFileIdx !== -1 && extraArgs[debugFileIdx + 1] ? extraArgs[debugFileIdx + 1] : void 0;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const muteWrite = (chunk, encoding, callback) => {
      if (typeof encoding === "function") {
        callback = encoding;
      }
      if (debugLogPath) {
        try {
          const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          appendFileSync(debugLogPath, `[parent] ${str}`);
        } catch {
        }
      }
      if (callback) callback();
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
    child.on("error", (err) => {
      restore();
      resolve(1);
    });
  });
}

export {
  getAppHome,
  ensureLegacyAppHomeMigrated,
  getProvidersPath,
  getLogsPath,
  isDiscoveryDisabled,
  registerServerRuntimeState,
  unregisterServerRuntimeState,
  readLiveServerRuntimeStates,
  orderWrapperServerCandidates,
  CODEX_RESPONSES_LITE_WS_URL,
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_WEBSOCKETS_BETA,
  MAX_MODEL_CATALOG,
  DEFAULT_SERVER_PORT,
  VERTEX_ANTHROPIC_NPM,
  VERSION,
  resolveContextWindow,
  stripOneMContextSuffix,
  claudeCodeClientModelId,
  routeLookupIds,
  oauthCredentialToKeychainJson,
  tokensToStoredCredential,
  supportsNativeOAuth,
  extractOpenAiAccountId,
  runOpenAiDeviceCodeFlow,
  diagnoseCredentialStorage,
  detectConflicts,
  buildChildEnv,
  applyAnthropicProxyEnvNormalization,
  buildHttpProxyChildEnv,
  parseAuthRef,
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
  resolveProviderOAuthProviderData,
  saveProviderCredential,
  deleteProviderCredential,
  loadPreferences,
  savePreferences,
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
  getInstalledClaudeVersion,
  launchClaude
};
//# sourceMappingURL=chunk-KLEC2OEF.js.map