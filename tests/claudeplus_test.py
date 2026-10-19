import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
PROXY_URL = "http://leverframe:fixture@127.0.0.1:3128"
CA_PATH = "/tmp/leverframe-ca.pem"


def load_launcher() -> object:
    spec = importlib.util.spec_from_file_location("claudeplus", ROOT / "scripts/claudeplus.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = load_launcher()
PROXY = launcher.Proxy(PROXY_URL, CA_PATH)


def critical_section_interval(output: str) -> tuple:
    lines = output.splitlines()
    return [line.split()[0] for line in lines], (int(lines[0].split()[1]), int(lines[1].split()[1]))


def generated_settings_env(settings_args: list, env: dict, directory: str) -> dict:
    args = launcher.claude_arguments(settings_args, env, Path(directory))
    return json.loads(Path(args[1]).read_text())["env"]


class ClaudeplusTests(unittest.TestCase):
    def test_two_launchers_serialize_service_startup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = (
                "import sys, time\n"
                "from pathlib import Path\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "from scripts.claudeplus import startup_lock\n"
                "with startup_lock(Path(sys.argv[2])):\n"
                "    print(f'enter {time.monotonic_ns()}', flush=True)\n"
                "    time.sleep(0.4)\n"
                "    print(f'exit {time.monotonic_ns()}', flush=True)\n"
            )
            command = [sys.executable, "-c", script, str(ROOT), directory]
            first = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
            second = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
            first_output, _ = first.communicate(timeout=10)
            second_output, _ = second.communicate(timeout=10)
        first_events, first_interval = critical_section_interval(first_output)
        second_events, second_interval = critical_section_interval(second_output)
        self.assertEqual((first.returncode, second.returncode), (0, 0))
        self.assertEqual((first_events, second_events), (["enter", "exit"], ["enter", "exit"]))
        self.assertTrue(first_interval[1] <= second_interval[0] or second_interval[1] <= first_interval[0])

    def test_client_routes_anthropic_through_the_leverframe_proxy(self) -> None:
        inherited = {"HTTP_PROXY": "old", "NO_PROXY": "api.anthropic.com", "CLAUDE_CODE_OAUTH_TOKEN": "subscription-fixture"}
        env = launcher.client_environment(inherited, PROXY)
        self.assertEqual({key: env[key] for key in launcher.PROXY_KEYS}, dict.fromkeys(launcher.PROXY_KEYS, PROXY_URL))
        self.assertNotIn("NO_PROXY", env)
        self.assertEqual(env["NODE_EXTRA_CA_CERTS"], CA_PATH)
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "subscription-fixture")
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "https://api.anthropic.com")
        self.assertEqual(env.get("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"), "1")
        self.assertEqual(env["ENABLE_TOOL_SEARCH"], "auto")

    def test_bare_client_uses_proxy_auth_only_without_an_explicit_credential(self) -> None:
        self.assertNotIn("ANTHROPIC_API_KEY", launcher.client_environment({}, PROXY))
        env = launcher.client_environment({}, PROXY, bare=True)
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "sk-ant-api03-leverframe-http-proxy")

    def test_bare_client_keeps_each_explicit_credential(self) -> None:
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
            with self.subTest(key=key):
                explicit = launcher.client_environment({key: "subscription-fixture"}, PROXY, bare=True)
                self.assertEqual(explicit[key], "subscription-fixture")
                self.assertEqual(explicit.get("ANTHROPIC_API_KEY", "subscription-fixture"), "subscription-fixture")

    def test_client_environment_removes_inherited_context_cap_without_mutating_parent(self) -> None:
        inherited = {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000", "KEEP": "yes"}
        env = launcher.client_environment(inherited, PROXY)
        self.assertNotIn("CLAUDE_CODE_MAX_CONTEXT_TOKENS", env)
        self.assertEqual(env["KEEP"], "yes")
        self.assertEqual(inherited["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1000000")

    def test_private_settings_mask_context_caps_without_rewriting_user_settings(self) -> None:
        original = json.dumps({"env": {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000", "KEEP": "yes"}})
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "user.json"
            existing.write_text(original)
            from_json = generated_settings_env(["--settings", original], launcher.client_environment({}, PROXY), directory)
            (Path(directory) / "claude-settings.json").unlink()
            from_file = generated_settings_env(["--settings", str(existing)], launcher.client_environment({}, PROXY), directory)
            unchanged = existing.read_text()
        self.assertEqual((from_json["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], from_json["KEEP"]), ("", "yes"))
        self.assertEqual((from_file["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], from_file["KEEP"]), ("", "yes"))
        self.assertEqual(unchanged, original)

    def test_private_settings_mask_context_caps_without_user_settings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            actual = generated_settings_env([], launcher.client_environment({}, PROXY), directory)
        self.assertEqual(actual["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "")

    def test_settings_keep_user_values_and_pin_private_proxy_configuration(self) -> None:
        env = launcher.client_environment({}, PROXY)
        env["LEVERFRAME_CONTEXT_SELECTION_BASE_URL"] = "http://127.0.0.1:3128"
        env["LEVERFRAME_CONTEXT_SELECTION_TOKEN"] = "private-runtime-token"
        settings = {"env": {"ANTHROPIC_BASE_URL": "http://old", "KEEP": "yes"}, "permissions": {"defaultMode": "plan"}}
        with tempfile.TemporaryDirectory() as directory:
            args = launcher.claude_arguments(["--settings", json.dumps(settings), "--print", "hello"], env, Path(directory))
            config_file = Path(args[args.index("--settings") + 1])
            actual = json.loads(config_file.read_text())
            mode = stat.S_IMODE(config_file.stat().st_mode)
        self.assertEqual(actual["permissions"], settings["permissions"])
        self.assertEqual(actual["env"]["KEEP"], "yes")
        self.assertEqual(actual["env"]["ANTHROPIC_BASE_URL"], "https://api.anthropic.com")
        self.assertEqual(actual["env"]["LEVERFRAME_CONTEXT_SELECTION_TOKEN"], "private-runtime-token")
        self.assertNotIn("private-runtime-token", " ".join(args))
        self.assertNotIn("fixture", " ".join(args))
        self.assertEqual(mode, 0o600)
        self.assertEqual(args[-2:], ["--print", "hello"])

    def test_accepts_a_settings_file_and_preserves_the_prompt_separator(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "user.json"
            existing.write_text('{"model":"fable"}')
            args = launcher.claude_arguments([f"--settings={existing}", "--", "--settings", "literal"], launcher.client_environment({}, PROXY), root)
            actual = json.loads(Path(args[1]).read_text())
        self.assertEqual(actual["model"], "fable")
        self.assertEqual(args[-3:], ["--", "--settings", "literal"])

    def test_generated_settings_pin_the_proxy_path_and_native_backend(self) -> None:
        settings = {"env": {"HTTPS_PROXY": "http://old", "NO_PROXY": "*", "CLAUDE_CODE_USE_VERTEX": "1", "KEEP": "yes"}}
        env = launcher.client_environment(settings["env"], PROXY)
        with tempfile.TemporaryDirectory() as directory:
            actual = generated_settings_env(["--settings", json.dumps(settings)], env, directory)
        backends = launcher.BACKEND_FLAGS
        self.assertEqual({key: actual[key] for key in launcher.PROXY_KEYS}, dict.fromkeys(launcher.PROXY_KEYS, PROXY_URL))
        self.assertEqual(actual["NO_PROXY"], "")
        self.assertEqual(actual["NODE_EXTRA_CA_CERTS"], CA_PATH)
        self.assertEqual({key: actual[key] for key in backends}, dict.fromkeys(backends, "0"))
        self.assertEqual({key: env[key] for key in backends}, dict.fromkeys(backends, "0"))
        self.assertEqual(actual["KEEP"], "yes")

    def test_prepared_proxy_failure_cleans_up_without_launching_claude(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "HOME_DIR", Path(directory)), \
                patch.object(launcher, "start_leverframe", side_effect=RuntimeError("patch failed")), \
                patch.object(launcher.subprocess, "Popen") as child, \
                patch.object(launcher, "stop_processes") as cleanup, \
                patch.object(launcher.signal, "signal"):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                launcher.main()
        child.assert_not_called()
        cleanup.assert_called_once_with([])

    def test_proxy_startup_prepares_claude_and_returns_the_session_proxy(self) -> None:
        runtime = [{"port": 3128, "pid": 321, "token": "fix ture", "caPath": "/tmp/ca.pem"}]
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "APP_HOME", Path(directory)), \
                patch.object(launcher, "free_port", return_value=3128), \
                patch.object(launcher, "wait_ready"), \
                patch.object(launcher.subprocess, "Popen", return_value=Mock(pid=321)) as start:
            (Path(directory) / "server-runtime.json").write_text(json.dumps(runtime))
            proxy, entry = launcher.start_leverframe({}, Path(directory), [])
        command, env = start.call_args.args[0], start.call_args.kwargs["env"]
        self.assertIn("--prepare-claude", command)
        self.assertIn("--proxy", command)
        self.assertEqual(env["LEVERFRAME_CLAUDE_PATH"], str(launcher.CLAUDE))
        self.assertEqual(env["LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS"], "600000")
        self.assertEqual(proxy, launcher.Proxy("http://leverframe:fix%20ture@127.0.0.1:3128", "/tmp/ca.pem"))
        self.assertEqual(entry, runtime[0])


if __name__ == "__main__":
    unittest.main()
