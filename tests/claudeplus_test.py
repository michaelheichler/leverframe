import importlib.util
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("claudeplus", ROOT / "scripts/claudeplus.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class ClaudeplusTests(unittest.TestCase):
    def test_headroom_preserves_confirmed_external_maximum_context(self):
        provider = SimpleNamespace(
            sanitize_anthropic_model_id=lambda model: model.removesuffix("[1m]"),
            has_context_1m_suffix=lambda model: model.endswith("[1m]"),
        )
        windows = {"atlas": 272000, "atlas[maximum]": 1048576, "atlas[1m]": 1048576,
                   "broad": 1000000, "broad[maximum]": 2000000, "broad[1m]": 1000000}
        launcher.preserve_headroom_context_modes(provider, windows)
        self.assertEqual(provider.sanitize_anthropic_model_id("atlas[1m]"), "atlas[maximum]")
        self.assertEqual(provider.sanitize_anthropic_model_id("atlas[maximum]"), "atlas[maximum]")
        self.assertEqual(provider.sanitize_anthropic_model_id("atlas"), "atlas")
        self.assertEqual(provider.sanitize_anthropic_model_id("claude-opus-4-8[1m]"), "claude-opus-4-8")
        self.assertEqual(provider.sanitize_anthropic_model_id("unknown[1m]"), "unknown")
        self.assertEqual(provider.sanitize_anthropic_model_id("broad[1m]"), "broad")

    def test_client_environment_preserves_auth_and_enables_large_models(self):
        env = launcher.client_environment({"HTTP_PROXY": "old", "CLAUDE_CODE_OAUTH_TOKEN": "subscription-fixture"}, 8787)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "subscription-fixture")
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8787")
        self.assertEqual(env.get("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"), "1")
        self.assertEqual(env["ENABLE_TOOL_SEARCH"], "auto")

    def test_client_uses_proxy_auth_when_no_explicit_claude_credential_exists(self):
        self.assertNotIn("ANTHROPIC_API_KEY", launcher.client_environment({}, 8787))
        env = launcher.client_environment({}, 8787, bare=True)
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "sk-ant-api03-leverframe-http-proxy")
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
            explicit = launcher.client_environment({key: "subscription-fixture"}, 8787, bare=True)
            self.assertEqual(explicit[key], "subscription-fixture")
            if key != "ANTHROPIC_API_KEY":
                self.assertNotIn("ANTHROPIC_API_KEY", explicit)

    def test_settings_keep_user_values_and_pin_private_proxy_configuration(self):
        env = launcher.client_environment({}, 8787)
        env["LEVERFRAME_CONTEXT_SELECTION_BASE_URL"] = "http://127.0.0.1:3128"
        env["LEVERFRAME_CONTEXT_SELECTION_TOKEN"] = "private-runtime-token"
        settings = {"env": {"ANTHROPIC_BASE_URL": "http://old", "KEEP": "yes"}, "permissions": {"defaultMode": "plan"}}
        with tempfile.TemporaryDirectory() as directory:
            args = launcher.claude_arguments(["--settings", json.dumps(settings), "--print", "hello"], env, Path(directory))
            config_file = Path(args[args.index("--settings") + 1])
            actual = json.loads(config_file.read_text())
            self.assertEqual(actual["permissions"], settings["permissions"])
            self.assertEqual(actual["env"]["KEEP"], "yes")
            self.assertEqual(actual["env"]["ANTHROPIC_BASE_URL"], env["ANTHROPIC_BASE_URL"])
            self.assertEqual(actual["env"]["LEVERFRAME_CONTEXT_SELECTION_TOKEN"], "private-runtime-token")
            self.assertNotIn("private-runtime-token", " ".join(args))
            self.assertEqual(stat.S_IMODE(config_file.stat().st_mode), 0o600)
            self.assertEqual(args[-2:], ["--print", "hello"])

    def test_accepts_a_settings_file_and_preserves_the_prompt_separator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "user.json"
            existing.write_text('{"model":"fable"}')
            args = launcher.claude_arguments([f"--settings={existing}", "--", "--settings", "literal"], launcher.client_environment({}, 8787), root)
            actual = json.loads(Path(args[1]).read_text())
            self.assertEqual(actual["model"], "fable")
            self.assertEqual(args[-3:], ["--", "--settings", "literal"])

    def test_headroom_uses_confirmed_limits_and_matches_the_proxy_timeout(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "start_service") as start, patch.object(launcher.ssl, "create_default_context") as ssl_context:
            ssl_context.return_value.get_ca_certs.return_value = []
            inherited = {"HEADROOM_MODEL_LIMITS": '{"anthropic":{"context_limits":{"claude-sonnet-4-6[maximum]":1000000}}}'}
            windows = {"atlas": 272000, "atlas[maximum]": 1048576}
            launcher.start_headroom(inherited, "http://leverframe:fixture@127.0.0.1:3128", Path(directory), [], windows)
            command, env = start.call_args.args[:2]
            self.assertEqual(command[command.index("--mode") + 1], "cache")
            self.assertEqual(command[command.index("--workers") + 1], "1")
            self.assertEqual(env["HEADROOM_REQUEST_TIMEOUT"], "600")
            self.assertEqual(env["HEADROOM_HTTP_PROXY"], "http://leverframe:fixture@127.0.0.1:3128")
            self.assertEqual(json.loads(env["HEADROOM_MODEL_LIMITS"])["anthropic"]["context_limits"]["atlas[maximum]"], 1048576)
            self.assertEqual(json.loads(env["LEVERFRAME_HEADROOM_CONTEXT_WINDOWS"]), windows)

    def test_generated_settings_pin_the_proxy_path_and_native_backend(self):
        settings = {"env": {"HTTPS_PROXY": "http://old", "CLAUDE_CODE_USE_VERTEX": "1", "KEEP": "yes"}}
        env = launcher.client_environment(settings["env"], 8787)
        with tempfile.TemporaryDirectory() as directory:
            args = launcher.claude_arguments(["--settings", json.dumps(settings)], env, Path(directory))
            actual = json.loads(Path(args[1]).read_text())["env"]
            for key in launcher.PROXY_KEYS:
                self.assertEqual(actual[key], "")
            for key in ("CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY"):
                self.assertEqual(actual[key], "0")
                self.assertEqual(env[key], "0")
            self.assertEqual(actual["KEEP"], "yes")

    def test_prepared_proxy_failure_cleans_up_without_launching_headroom_or_claude(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "HOME_DIR", Path(directory)), \
                patch.object(launcher, "start_leverframe", side_effect=RuntimeError("patch failed")), \
                patch.object(launcher, "start_headroom") as headroom, \
                patch.object(launcher.subprocess, "Popen") as child, \
                patch.object(launcher, "stop_processes") as cleanup, \
                patch.object(launcher.signal, "signal"):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                launcher.main()
            headroom.assert_not_called()
            child.assert_not_called()
            cleanup.assert_called_once()

    def test_proxy_startup_requests_preparation_for_the_native_claude_target(self):
        runtime = [{"port": 3128, "pid": 321, "token": "fixture"}]
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "APP_HOME", Path(directory)), \
                patch.object(launcher, "free_port", return_value=3128), \
                patch.object(launcher, "start_service", return_value=Mock(pid=321)) as start:
            (Path(directory) / "server-runtime.json").write_text(json.dumps(runtime))
            launcher.start_leverframe({}, Path(directory), [])
            command, env = start.call_args.args[:2]
            self.assertIn("--prepare-claude", command)
            self.assertIn("--proxy", command)
            self.assertEqual(env["LEVERFRAME_CLAUDE_PATH"], str(launcher.CLAUDE))

    def test_metadata_request_uses_the_local_proxy_token(self):
        response = Mock()
        response.read.return_value = b'{"contextWindows":{"atlas":272000}}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(launcher.urllib.request, "build_opener") as build:
            build.return_value.open.return_value = response
            windows = launcher.context_windows({"port": 3128, "token": "private-runtime-token"})
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:3128/v1/leverframe/context-metadata")
            self.assertEqual(request.get_header("Authorization"), "Bearer private-runtime-token")
            self.assertEqual(windows, {"atlas": 272000})


if __name__ == "__main__":
    unittest.main()
