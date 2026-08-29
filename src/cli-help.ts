import pc from 'picocolors';
import { VERSION, MAX_MODEL_CATALOG } from './constants.js';

export function rootHelpText(): string {
  return `${pc.bold('leverframe')} v${VERSION}
Bridge Claude Code to supported OpenAI-compatible providers.

${pc.bold('Usage:')}
  leverframe claude [options] [claude-flags]
  leverframe server [options]
  leverframe patch [--restore]
  leverframe models
  leverframe favorites
  leverframe providers
  leverframe executions <list|show|reconcile>
  leverframe --help
  leverframe --version

${pc.bold('Root options:')}
  -h, --help       Show this help
  -v, --version    Show version

${pc.bold('Commands:')}
  claude      Launch Claude Code bridged to supported providers
  server      Run a foreground gateway (endpoint or proxy mode)
  patch       Patch the Claude Code binary so leverframe models are first-class
  models      Manage favorite models and aliases (max ${MAX_MODEL_CATALOG})
  favorites   Alias for models
  providers   Add or sign in to supported providers
  executions  Inspect and reconcile interrupted executions

${pc.bold('Bridge modes (claude and server):')}
  --endpoint   Local Anthropic-format gateway; Claude Code launches with
               ANTHROPIC_BASE_URL pointed at it
  --proxy      Selective MITM of api.anthropic.com; Claude Code keeps its
               normal Anthropic auth, leverframe: models route to supported providers
               (default when nothing is saved)
  --save-mode  Persist the mode given by --endpoint/--proxy as that
               command's default. Without --save-mode a mode flag applies
               to that run only.

${pc.bold('Examples:')}
  leverframe claude
  leverframe claude --proxy
  leverframe models
  leverframe patch
  leverframe server
  leverframe claude -c
  leverframe claude -- --print "hello"`;
}

export function claudeHelpText(): string {
  return `${pc.bold('leverframe claude')} v${VERSION}
Launch Claude Code bridged to supported OpenAI-compatible providers.

${pc.bold('Usage:')}
  leverframe claude [options] [claude-flags]
  leverframe claude --help
  leverframe claude --version

${pc.bold('Options:')}
  --endpoint   Endpoint bridge mode for this run: local gateway + ANTHROPIC_BASE_URL
  --proxy      Proxy bridge mode for this run: keep Claude Code's Anthropic auth;
               route leverframe: models to supported providers (default when nothing is saved)
  --save-mode  With --endpoint/--proxy: save that mode as the claude default
  --dry-run    Run the wizard but show a preview instead of launching Claude Code
  --trace      Write debug logs to ~/.leverframe/logs/ and show errors on exit
  --provider   Boot provider id (skip wizard when paired with --model or in print mode)
  --model      Boot model id (skip wizard when paired with --provider or in print mode)
  --help       Show this command help
  --version    Show version

${pc.bold('Providers:')}
  openai         OpenAI API key (platform.openai.com)
  openai-oauth   ChatGPT/Codex plan OAuth — sign in with leverframe providers auth openai
  kimi           Kimi Coding Plan membership key
  moonshot       Moonshot pay-as-you-go API key
  zai            z.ai Coding Plan API key

${pc.bold('Model switching:')}
  Run leverframe models to save favorites (max ${MAX_MODEL_CATALOG}).
  When favorites exist, endpoint mode starts a multi-route proxy and Claude
  Code /model lists your starting model plus favorites for live switching.
  With no favorites, launch uses a single model.

${pc.bold('Proxy mode:')}
  leverframe claude --proxy leaves ANTHROPIC_BASE_URL unset and launches
  Claude Code with its normal Anthropic login. Favorite models from supported
  OpenAI-compatible providers are available by typing
  /model leverframe:<provider-id>:<model-id>.
  Save short names with leverframe models --alias, and run --list to print them.
  Run leverframe patch to make those names first-class inside Claude Code.

${pc.bold('Note:')}
  Claude Code may save the launched model to ~/.claude/settings.json.
  Bare claude later can still show that model — reset with claude --model sonnet.

${pc.bold('Examples:')}
  leverframe claude
  leverframe claude -c
  leverframe claude --resume abc-123
  leverframe claude --dry-run -c
  leverframe claude --trace --resume abc-123
  leverframe claude --endpoint
  leverframe claude --endpoint --save-mode
  leverframe claude --provider openai-oauth --model gpt-5.6-sol
  leverframe claude -- --print "hello"
  leverframe claude -- --dangerously-skip-permissions`;
}

export function serverHelpText(): string {
  return `${pc.bold('leverframe server')} v${VERSION}
Run a foreground gateway bridging Anthropic-format requests to supported OpenAI-compatible providers.
Two modes: ${pc.bold('endpoint')} (an Anthropic-format HTTP gateway you point clients at) and
${pc.bold('proxy')} (a selective api.anthropic.com MITM proxy; clients keep their Anthropic
auth while leverframe: models route to supported providers).

${pc.bold('Usage:')}
  leverframe server [--endpoint | --proxy] [options]
  leverframe server --help
  leverframe server --version

${pc.bold('Common options (both modes):')}
  --endpoint                   Endpoint mode for this run
  --proxy                      Proxy mode for this run (default when nothing is
                               saved; local only)
  --save-mode                  With --endpoint/--proxy: save that mode as the
                               server default
  --port <1-65535>             Listen port (default 17645)
  --no-discovery               Do not advertise this server in
                               ~/.leverframe/server-runtime.json, so the
                               leverframe-claude wrapper never bridges to it
                               (LEVERFRAME_NO_DISCOVERY=1 works too)
  --ws-diagnostics             Log sanitized request envelopes and WebSocket
                               head decisions
  --help, --version            Help / version

${pc.bold('Endpoint mode only')} ${pc.dim('(error if combined with --proxy)')}:
  --quick, --saved             Start immediately from saved/default settings,
                               skipping the wizard
  --listen local|network       One-run listen mode override
  --providers all|favorites|id1,id2
                               One-run provider catalog override
  --mask-gateway-ids           Mask vendor names in discovery model ids (see below)
  --no-mask-gateway-ids        Expose unmasked discovery model ids
  --password                   Removed. Use LEVERFRAME_SERVER_PASSWORD for a
                               one-run password, or run 'leverframe server'
                               interactively to enter one hidden

${pc.bold('Proxy mode only:')}
  (no extra options — proxy mode takes only the common options above)

${pc.bold('Bare leverframe server:')}
  Uses the saved default mode (proxy if none saved). Proxy mode starts
  immediately. Endpoint mode on a TTY opens a short wizard: start from saved
  settings, or configure — favorites-only catalog?, which providers to expose,
  discovery-id masking, listen local/network (network asks for a password).
  Without a TTY (or with --quick / any endpoint-mode option) it skips all
  prompts and starts from saved settings; network mode then needs a saved
  password or LEVERFRAME_SERVER_PASSWORD.

${pc.bold('--mask-gateway-ids explained:')}
  Endpoint-mode discovery ids look like anthropic-openai-oauth__gpt-5.6.
  Some Claude clients validate model names (Claude Desktop / Cowork pickers,
  Claude Code skill/agent "model:" frontmatter) and reject or filter ids that
  contain non-Anthropic vendor names. Masking reverses the provider and model
  segments (anthropic-htuao-ianepo__6.5-tpg) so vendor strings never appear
  literally; display names stay readable ("GPT 5.6 (OpenAI)"), and the
  gateway accepts both masked and unmasked ids in requests. Tradeoff: the ids
  are unreadable, so copy them exactly from the printed catalog. Masking is on
  by default; use --no-mask-gateway-ids for clients that don't need it.

${pc.bold('Proxy mode env:')}
  Start leverframe server --proxy, then export the HTTPS_PROXY, HTTP_PROXY,
  and NODE_EXTRA_CA_CERTS values it prints. Do not set ANTHROPIC_BASE_URL.

${pc.bold('Gateway endpoints (endpoint mode):')}
  Anthropic-compatible:  ANTHROPIC_BASE_URL=http://127.0.0.1:17645/anthropic
  OpenAI-compatible:     OPENAI_BASE_URL=http://127.0.0.1:17645/openai/v1
  API key: use anything locally; use the server password in network mode.

${pc.bold('Examples:')}
  # Endpoint gateway serving only your favorites, no prompts, for a local client
  leverframe server --endpoint --quick --providers favorites

  # Proxy mode for an existing-auth Claude Code (export the env it prints)
  leverframe server --proxy`;
}

export function modelsHelpText(): string {
  return `${pc.bold('leverframe favorites')} v${VERSION}
Manage favorite models for mid-session switching.

${pc.bold('Usage:')}
  leverframe favorites
  leverframe models --list
  leverframe models --alias sol=leverframe:openai-oauth:gpt-5.6-sol
  leverframe models --unalias sol
  leverframe models --context-ceiling gpt-5.6-sol
  leverframe models
  leverframe favorites --help
  leverframe favorites --version

${pc.bold('Behavior:')}
  Opens an interactive manager to add or remove favorites.
  Search all providers at once (paginated results) or browse one provider at a time.
  Favorites are saved to ~/.leverframe/config.json (max ${MAX_MODEL_CATALOG}).
  --list prints the exact leverframe:<provider-id>:<model-id> names available in
  proxy mode, without opening the interactive manager.
  --alias <name=target> saves a short name for a proxy-mode favorite. The
  target is leverframe:<provider-id>:<model-id> (the leverframe: prefix is optional).
  --unalias <name> removes a saved short name.
  --context-ceiling <model-id> opts a model in to the maximum context window its
  provider reports, for providers that serve a smaller tuned default. The
  maximum is read from live provider metadata (ChatGPT/Codex reports both
  context_window and max_context_window), never from a bundled number, because
  it varies by account. Run it with an unknown model to list the models that
  currently offer one. Nothing is applied automatically, and an opted-in window
  is recorded as an override rather than as provider-confirmed metadata. Run
  leverframe patch afterwards to apply it.
  --no-context-ceiling <model-id> returns a model to the window it is served.

${pc.bold('How it works:')}
  claude and server use the global favorites list.
  Favorites appear in the /model switch menu (endpoint mode) and are routable
  by name in proxy mode. leverframe patch bakes favorites + aliases into the
  Claude Code binary so they pass model validation and report real context.

${pc.bold('Examples:')}
  leverframe favorites
  leverframe models --alias sol=leverframe:openai-oauth:gpt-5.6-sol
  leverframe claude    # switch menu active when favorites are set`;
}

export function patchHelpText(): string {
  return `${pc.bold('leverframe patch')} v${VERSION}
Patch the installed Claude Code binary so leverframe favorites and aliases are
first-class: accepted by the Agent tool, listed in /model, resolved to their
real ids, and reporting the correct context window.

${pc.bold('Usage:')}
  leverframe patch
  leverframe patch --restore
  leverframe patch --diagnose
  leverframe patch --diagnose --json
  leverframe patch --target <path>
  leverframe patch --help

${pc.bold('Options:')}
  --restore     Restore the pristine (unpatched) Claude Code binary
  --trace       Show per-patch-site results (OK/SKIP/FAIL)
  --diagnose    Read-only, network-free report: resolved installation, patch
                state, baseline, drift, pending transaction, lock, and legacy
                migration eligibility. Never modifies anything.
  --json        With --diagnose, print the report as ANSI-free JSON
  --target <path>
                Pin an explicit Claude Code installation instead of the usual
                discovery order (applies to patch, --restore, and --diagnose)

${pc.bold('Behavior:')}
  The patch map is built automatically from your leverframe favorites and aliases
  (leverframe models); context windows come from provider metadata. Patch state
  is per installation, keyed by its canonical path, under
  ~/.leverframe/state/patches/<identity>/. A content-addressed, immutable
  pristine baseline is kept per Claude Code version; re-runs are no-ops until
  your config or Claude Code version changes — then the binary is restored
  first and re-patched fresh. Every patch and restore is journaled so an
  interrupted run is reconciled automatically on the next leverframe patch run.
  Run leverframe patch again after every claude update.`;
}

export function printHelp(text: string): void {
  console.log(`\n${text}\n`);
}
