#!/usr/bin/env node
import {
  applyAnthropicProxyEnvNormalization,
  findClaudeBinary,
  orderWrapperServerCandidates,
  readLiveServerRuntimeStates
} from "./chunk-HRR5J3AN.js";

// src/claude-wrapper.ts
import { spawn } from "child_process";
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from "fs";
import { connect } from "net";
import { constants as osConstants } from "os";
import { fileURLToPath } from "url";

// src/wrapper-env.ts
var PROXY_ENV_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
var PROXY_AUTH_USER = "leverframe";
function computeWrapperEnv(baseEnv, state) {
  const env = { ...baseEnv };
  if (!state) return env;
  if (state.mode === "proxy") {
    applyAnthropicProxyEnvNormalization(env);
    const proxyUrl = state.token ? `http://${PROXY_AUTH_USER}:${encodeURIComponent(state.token)}@127.0.0.1:${state.port}` : `http://127.0.0.1:${state.port}`;
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env["NODE_EXTRA_CA_CERTS"] = state.caPath;
    return env;
  }
  for (const name of PROXY_ENV_VARS) delete env[name];
  env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${state.port}/anthropic`;
  if (state.token) {
    env["ANTHROPIC_API_KEY"] = state.token;
  } else {
    delete env["ANTHROPIC_API_KEY"];
  }
  return env;
}

// src/claude-wrapper.ts
var isWindows = process.platform === "win32";
function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows) accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function looksLikeWrapperContractPath(arg) {
  if (!arg) return false;
  if (existsSync(arg)) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  const base = arg.toLowerCase();
  return base === "claude" || base.startsWith("claude.");
}
function execIntoClaude(file, args, env) {
  if (isWindows || typeof process.execve !== "function") return;
  if (!isExecutableFile(file)) return;
  try {
    process.execve(file, [file, ...args], env);
  } catch {
  }
}
function portIsOpen(port, timeoutMs = 100) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
async function main() {
  const argv = process.argv.slice(2);
  let claudePath;
  let claudeArgs;
  if (argv[0] && isExecutableFile(argv[0])) {
    claudePath = argv[0];
    claudeArgs = argv.slice(1);
  } else {
    claudePath = findClaudeBinary();
    claudeArgs = argv;
  }
  if (!claudePath) {
    process.stderr.write("leverframe-claude: could not find the claude binary (set LEVERFRAME_CLAUDE_PATH)\n");
    process.exit(127);
  }
  let state = null;
  for (const candidate of orderWrapperServerCandidates(readLiveServerRuntimeStates())) {
    if (await portIsOpen(candidate.port)) {
      state = candidate;
      break;
    }
  }
  const env = computeWrapperEnv(process.env, state);
  execIntoClaude(claudePath, claudeArgs, env);
  const child = spawn(claudePath, claudeArgs, {
    stdio: "inherit",
    env,
    shell: isWindows
  });
  const forward = (signal) => child.kill(signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.on("error", (err) => {
    process.stderr.write(`leverframe-claude: failed to launch ${claudePath}: ${err.message}
`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      const signum = osConstants.signals[signal];
      process.exit(signum ? 128 + signum : 1);
    }
    process.exit(code ?? 0);
  });
}
function isClaudeWrapperEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isClaudeWrapperEntryPoint()) {
  void main();
}
export {
  execIntoClaude,
  looksLikeWrapperContractPath
};
//# sourceMappingURL=claude-wrapper.js.map