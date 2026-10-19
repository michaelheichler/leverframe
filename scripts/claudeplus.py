#!/usr/bin/env python3
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from typing import Iterator, NamedTuple
import urllib.error
import urllib.parse
import urllib.request


HOME_DIR = Path.home()
APP_HOME = Path(os.environ.get("LEVERFRAME_HOME", HOME_DIR / ".leverframe")).expanduser()
LEVERFRAME = Path(os.environ.get("CLAUDEPLUS_LEVERFRAME_PATH") or shutil.which("leverframe") or "leverframe")
CLAUDE = Path(os.environ.get("CLAUDEPLUS_CLAUDE_PATH") or shutil.which("claude") or "claude")
PROXY_KEYS = ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy")
NO_PROXY_KEYS = ("NO_PROXY", "no_proxy")
BACKEND_FLAGS = ("CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY")
CREDENTIAL_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")
PINNED_SETTINGS_KEYS = (*PROXY_KEYS, "ANTHROPIC_BASE_URL", "NODE_EXTRA_CA_CERTS", "LEVERFRAME_CONTEXT_SELECTION_BASE_URL",
                        "LEVERFRAME_CONTEXT_SELECTION_TOKEN", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT")
ANTHROPIC_ORIGIN = "https://api.anthropic.com"


class Proxy(NamedTuple):
    url: str
    ca_path: str


def client_environment(inherited: dict, proxy: Proxy, bare: bool = False) -> dict:
    env = dict(inherited)
    env.pop("CLAUDE_CODE_MAX_CONTEXT_TOKENS", None)
    for key in NO_PROXY_KEYS:
        env.pop(key, None)
    env.update({key: proxy.url for key in PROXY_KEYS})
    env.update({key: "0" for key in BACKEND_FLAGS})
    env["ANTHROPIC_BASE_URL"] = ANTHROPIC_ORIGIN
    env["NODE_EXTRA_CA_CERTS"] = proxy.ca_path
    if bare and not any(env.get(key, "").strip() for key in CREDENTIAL_KEYS):
        env["ANTHROPIC_API_KEY"] = "sk-ant-api03-leverframe-http-proxy"
    env["CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"] = "1"
    env.setdefault("ENABLE_TOOL_SEARCH", "auto")
    return env


def read_settings(value: str) -> dict:
    content = value if value.lstrip().startswith("{") else Path(value).expanduser().read_text()
    settings = json.loads(content)
    if not isinstance(settings, dict):
        raise RuntimeError("Settings must be a JSON object")
    return settings


def split_settings(arguments: list) -> tuple:
    remaining, settings = [], {}
    iterator = iter(arguments)
    for argument in iterator:
        if argument == "--":
            remaining.extend([argument, *iterator])
            break
        if argument != "--settings" and not argument.startswith("--settings="):
            remaining.append(argument)
            continue
        value = next(iterator, None) if argument == "--settings" else argument.split("=", 1)[1]
        if not value:
            raise RuntimeError("--settings requires JSON or a file path")
        settings.update(read_settings(value))
    return remaining, settings


def pinned_settings_env(settings: dict, env: dict) -> dict:
    settings_env = dict(settings.get("env", {}))
    settings_env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = ""
    settings_env.update({key: "" for key in NO_PROXY_KEYS})
    settings_env.update({key: "0" for key in BACKEND_FLAGS})
    settings_env.update({key: env[key] for key in PINNED_SETTINGS_KEYS if key in env})
    return settings_env


def claude_arguments(arguments: list, env: dict, log_dir: Path) -> list:
    remaining, settings = split_settings(arguments)
    settings["env"] = pinned_settings_env(settings, env)
    path = log_dir / "claude-settings.json"
    with open(path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(settings, output)
    return ["--settings", str(path), *remaining]


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@contextmanager
def startup_lock(log_root: Path) -> Iterator[None]:
    lock_path = log_root / "startup.lock"
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def stop_processes(processes: list) -> None:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def responds(opener: urllib.request.OpenerDirector, url: str) -> bool:
    try:
        with opener.open(url, timeout=2) as response:
            return response.status == 200
    except urllib.error.HTTPError as error:
        # Because the proxy demands its token, a 407 already proves that it listens.
        return error.code == 407
    except (urllib.error.URLError, TimeoutError):
        return False


def wait_ready(process: subprocess.Popen, url: str, log_path: Path) -> None:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 120
    while process.poll() is None and time.monotonic() < deadline:
        if responds(opener, url):
            return
        time.sleep(0.2)
    raise RuntimeError(f"Service failed to become ready. See {log_path}")


def start_leverframe(env: dict, log_dir: Path, processes: list) -> tuple:
    port = free_port()
    env = dict(env)
    for key in (*PROXY_KEYS, "ANTHROPIC_BASE_URL"):
        env.pop(key, None)
    env["LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS"] = "600000"
    env["LEVERFRAME_CLAUDE_PATH"] = str(CLAUDE)
    log_path = log_dir / "leverframe.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(
            [str(LEVERFRAME), "server", "--proxy", "--prepare-claude", "--port", str(port)],
            env=env, stdout=log, stderr=log, start_new_session=True,
        )
    processes.append(process)
    wait_ready(process, f"http://127.0.0.1:{port}", log_path)
    runtime = json.loads((APP_HOME / "server-runtime.json").read_text())
    entry = next(item for item in runtime if item["port"] == port and item["pid"] == process.pid)
    token = urllib.parse.quote(entry["token"], safe="")
    return Proxy(f"http://leverframe:{token}@127.0.0.1:{port}", entry["caPath"]), entry


def main() -> int:
    processes = []
    log_root = HOME_DIR / ".local/state/claudeplus"
    log_root.mkdir(parents=True, exist_ok=True)
    log_dir = Path(tempfile.mkdtemp(prefix="session-", dir=log_root))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(129))
    try:
        with startup_lock(log_root):
            proxy, runtime = start_leverframe(os.environ, log_dir, processes)
        print(f"Session logs: {log_dir}", file=sys.stderr)
        arguments = sys.argv[1:]
        option_end = arguments.index("--") if "--" in arguments else len(arguments)
        env = client_environment(os.environ, proxy, bare="--bare" in arguments[:option_end])
        env["LEVERFRAME_CONTEXT_SELECTION_BASE_URL"] = f"http://127.0.0.1:{runtime['port']}"
        env["LEVERFRAME_CONTEXT_SELECTION_TOKEN"] = runtime["token"]
        child = subprocess.Popen([str(CLAUDE), *claude_arguments(arguments, env, log_dir)], env=env)
        processes.append(child)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        return child.wait()
    finally:
        stop_processes(processes)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, TypeError, KeyError, StopIteration, subprocess.SubprocessError) as error:
        print(f"claudeplus: {error}", file=sys.stderr)
        sys.exit(1)
