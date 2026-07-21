# Bridging Claude Code background agents with Leverframe

One long-running `leverframe server --proxy` can bridge terminal sessions, agents view sessions, and background agents while preserving Claude Code's own Anthropic login.

## How it works

- `leverframe server --proxy` records its mode, port, process id, and CA certificate path in `~/.leverframe/server-runtime.json`.
- `leverframe-claude` reads the runtime file, discards dead records, prefers proxy servers over endpoint servers, and chooses the newest live record in that mode.
- For proxy mode, the wrapper injects `HTTPS_PROXY`, `HTTP_PROXY`, and `NODE_EXTRA_CA_CERTS` and removes `ANTHROPIC_BASE_URL`.
- For endpoint mode, the wrapper injects the gateway `ANTHROPIC_BASE_URL`.
- If no server is live, the wrapper launches Claude Code with the relevant environment unchanged.

Start a server with `--no-discovery`, or set `LEVERFRAME_NO_DISCOVERY=1`, when `leverframe-claude` should ignore that server.

## Setup

1. Build and link Leverframe from the repository checkout:

   ```bash
   pnpm install
   pnpm build
   npm link
   ```

2. Start the shared proxy server:

   ```bash
   leverframe server --proxy
   ```

3. Point Claude Code's process wrapper at a stable `leverframe-claude` launcher:

   ```bash
   export CLAUDE_CODE_PROCESS_WRAPPER="$HOME/.local/bin/leverframe-claude"
   ```

   The value must be a literal absolute path that remains valid across shells and Node upgrades. Do not assign it with `$(command -v leverframe-claude)` in a shell profile because version-manager paths can be temporary.

4. If the installed JavaScript bin cannot find Node in GUI-launched sessions, create a stable launcher:

   ```sh
   #!/bin/sh
   NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
   [ -x "$NODE" ] || NODE=node
   exec "$NODE" "$(npm root -g)/@michaelheichler/leverframe/dist/claude-wrapper.js" "$@"
   ```

   Make it executable and test it with a minimal environment:

   ```bash
   chmod +x "$HOME/.local/bin/leverframe-claude"
   env -i HOME="$HOME" PATH=/usr/bin:/bin "$HOME/.local/bin/leverframe-claude" --version
   ```

5. Use the wrapper for terminal sessions that should be bridged:

   ```bash
   leverframe-claude
   leverframe-claude -p "hi"
   ```

Claude Code invokes the same wrapper for spawned processes when `CLAUDE_CODE_PROCESS_WRAPPER` is present in its environment.

## Troubleshooting

- Run `leverframe models --list` to see accepted `leverframe:` routes and aliases.
- Check `~/.leverframe/server-runtime.json` if no live server is discovered.
- Confirm the server was not started with `--no-discovery` and `LEVERFRAME_NO_DISCOVERY` is unset.
- Use `leverframe server --proxy --port <n>` if port 17645 is occupied. Discovery records the actual port.
- If spawned agents report `env: node: No such file or directory`, use the stable launcher above and test it with the minimal environment command.
