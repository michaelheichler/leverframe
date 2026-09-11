import json
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


HOME_DIR = Path.home()
APP_HOME = Path(os.environ.get("LEVERFRAME_HOME", HOME_DIR / ".leverframe")).expanduser()
LEVERFRAME = Path(shutil.which("leverframe") or "leverframe")
HEADROOM = HOME_DIR / ".local/bin/headroom"
CLAUDE = HOME_DIR / ".local/bin/claude"
PROXY_KEYS = ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy")
BACKEND_FLAGS = ("CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY")


def client_environment(inherited, port, bare=False):
    env = dict(inherited)
    for key in PROXY_KEYS:
        env.pop(key, None)
    for key in BACKEND_FLAGS:
        env[key] = "0"
    env["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}"
    env["HEADROOM_PROXY_URL"] = env["ANTHROPIC_BASE_URL"]
    if bare and not any(env.get(key, "").strip() for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")):
        env["ANTHROPIC_API_KEY"] = "sk-ant-api03-leverframe-http-proxy"
    env["CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"] = "1"
    env.setdefault("ENABLE_TOOL_SEARCH", "auto")
    return env


def read_settings(value):
    content = value if value.lstrip().startswith("{") else Path(value).expanduser().read_text()
    settings = json.loads(content)
    if not isinstance(settings, dict):
        raise RuntimeError("Settings must be a JSON object")
    return settings


def claude_arguments(arguments, env, log_dir):
    remaining, settings = [], {}
    iterator = iter(arguments)
    for argument in iterator:
        if argument == "--":
            remaining.extend([argument, *iterator])
            break
        if argument == "--settings" or argument.startswith("--settings="):
            value = next(iterator, None) if argument == "--settings" else argument.split("=", 1)[1]
            if not value:
                raise RuntimeError("--settings requires JSON or a file path")
            settings.update(read_settings(value))
        else:
            remaining.append(argument)
    settings_env = dict(settings.get("env", {}))
    settings_env.update({key: "" for key in PROXY_KEYS})
    settings_env.update({key: "0" for key in BACKEND_FLAGS})
    for key in ("ANTHROPIC_BASE_URL", "LEVERFRAME_CONTEXT_SELECTION_BASE_URL",
                "LEVERFRAME_CONTEXT_SELECTION_TOKEN", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"):
        if key in env:
            settings_env[key] = env[key]
    settings["env"] = settings_env
    path = log_dir / "claude-settings.json"
    with open(path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(settings, output)
    return ["--settings", str(path), *remaining]


def context_windows(runtime):
    request = urllib.request.Request(
        f"http://127.0.0.1:{runtime['port']}/v1/leverframe/context-metadata",
        headers={"Authorization": f"Bearer {runtime['token']}"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        windows = json.load(response).get("contextWindows")
    if not isinstance(windows, dict) or any(
        not isinstance(key, str) or type(value) is not int or not 0 < value <= 9007199254740991
        for key, value in windows.items()
    ):
        raise RuntimeError("Leverframe returned invalid context metadata")
    return windows


def headroom_model_limits(inherited, windows):
    config = read_settings(inherited) if inherited else {}
    anthropic = dict(config.get("anthropic", config))
    anthropic["context_limits"] = {**anthropic.get("context_limits", {}), **windows}
    return json.dumps({**config, "anthropic": anthropic})


def preserve_headroom_context_modes(provider, windows):
    sanitize = provider.sanitize_anthropic_model_id

    def normalize(model):
        cleaned = sanitize(model)
        if windows.get(cleaned.lower(), 0) >= 1000000:
            return cleaned
        maximum = cleaned.lower() + "[maximum]"
        if provider.has_context_1m_suffix(model) and windows.get(maximum, 0) >= 1000000:
            return maximum
        return cleaned

    provider.sanitize_anthropic_model_id = normalize


def headroom_proxy():
    from headroom.providers import anthropic
    from headroom.proxy.handlers import anthropic as handler
    from headroom.cli import main as headroom_main

    limits = json.loads(os.environ["LEVERFRAME_HEADROOM_CONTEXT_WINDOWS"])
    preserve_headroom_context_modes(anthropic, limits)
    handler.sanitize_anthropic_model_id = anthropic.sanitize_anthropic_model_id
    sys.argv = [str(HEADROOM), *sys.argv[2:]]
    return headroom_main()


def mcp_config(port):
    return json.dumps({"mcpServers": {"headroom": {
        "command": str(HEADROOM), "args": ["mcp", "serve"],
        "env": {"HEADROOM_PROXY_URL": f"http://127.0.0.1:{port}"},
    }}})


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def stop_processes(processes):
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def wait_ready(process, url, log_path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 120
    while process.poll() is None and time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=2) as response:
                if response.status == 200:
                    return
        except urllib.error.HTTPError as error:
            if error.code == 407 and not url.endswith("/readyz"):
                return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Service failed to become ready. See {log_path}")


def start_service(command, env, log_path, url, processes):
    with log_path.open("w") as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
    processes.append(process)
    wait_ready(process, url, log_path)
    return process


def start_leverframe(env, log_dir, processes):
    port = free_port()
    env = dict(env)
    for key in (*PROXY_KEYS, "ANTHROPIC_BASE_URL"):
        env.pop(key, None)
    env["LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS"] = "600000"
    env["LEVERFRAME_CLAUDE_PATH"] = str(CLAUDE)
    process = start_service(
        [str(LEVERFRAME), "server", "--proxy", "--prepare-claude", "--port", str(port)], env,
        log_dir / "leverframe.log", f"http://127.0.0.1:{port}", processes,
    )
    runtime = json.loads((APP_HOME / "server-runtime.json").read_text())
    entry = next(item for item in runtime if item["port"] == port and item["pid"] == process.pid)
    token = urllib.parse.quote(entry["token"], safe="")
    return f"http://leverframe:{token}@127.0.0.1:{port}", entry


def start_headroom(env, proxy_url, log_dir, processes, windows):
    port = free_port()
    env = client_environment(env, port)
    env.pop("ANTHROPIC_BASE_URL")
    env["HEADROOM_HTTP_PROXY"] = proxy_url
    env["HEADROOM_REQUEST_TIMEOUT"] = "600"
    env["HEADROOM_MODEL_LIMITS"] = headroom_model_limits(env.get("HEADROOM_MODEL_LIMITS"), windows)
    env["LEVERFRAME_HEADROOM_CONTEXT_WINDOWS"] = json.dumps(windows)
    context = ssl.create_default_context()
    context.load_verify_locations(APP_HOME / "http-proxy/leverframe-ca.pem")
    bundle = log_dir / "ca-bundle.pem"
    bundle.write_text("".join(ssl.DER_cert_to_PEM_cert(cert) for cert in context.get_ca_certs(binary_form=True)))
    env["SSL_CERT_FILE"] = str(bundle)
    start_service(
        [str(HEADROOM.resolve().with_name("python3")), "-B", str(Path(__file__).resolve()),
         "--headroom-proxy", "proxy", "--host", "127.0.0.1", "--port", str(port),
         "--mode", "cache", "--workers", "1", "--backend", "anthropic", "--no-telemetry",
         "--anthropic-api-url", "https://api.anthropic.com"], env,
        log_dir / "headroom.log", f"http://127.0.0.1:{port}/readyz", processes,
    )
    return port


def main():
    processes = []
    log_root = HOME_DIR / ".local/state/claudeplus"
    log_root.mkdir(parents=True, exist_ok=True)
    log_dir = Path(tempfile.mkdtemp(prefix="session-", dir=log_root))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(129))
    try:
        proxy, runtime = start_leverframe(os.environ, log_dir, processes)
        windows = context_windows(runtime)
        port = start_headroom(os.environ, proxy, log_dir, processes, windows)
        print(f"Headroom dashboard: http://127.0.0.1:{port}/dashboard", file=sys.stderr)
        print(f"Session logs: {log_dir}", file=sys.stderr)
        arguments = sys.argv[1:]
        option_end = arguments.index("--") if "--" in arguments else len(arguments)
        env = client_environment(os.environ, port, bare="--bare" in arguments[:option_end])
        env["LEVERFRAME_CONTEXT_SELECTION_BASE_URL"] = f"http://127.0.0.1:{runtime['port']}"
        env["LEVERFRAME_CONTEXT_SELECTION_TOKEN"] = runtime["token"]
        child = subprocess.Popen(
            [str(CLAUDE), "--mcp-config", mcp_config(port), *claude_arguments(arguments, env, log_dir)],
            env=env,
        )
        processes.append(child)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        return child.wait()
    finally:
        stop_processes(processes)


if __name__ == "__main__":
    try:
        sys.exit(headroom_proxy() if sys.argv[1:2] == ["--headroom-proxy"] else main())
    except (RuntimeError, OSError, ValueError, TypeError, StopIteration, subprocess.SubprocessError) as error:
        print(f"claudeplus: {error}", file=sys.stderr)
        sys.exit(1)
