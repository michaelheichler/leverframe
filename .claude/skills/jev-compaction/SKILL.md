---
name: jev-compaction
description: Compact session context without rewriting it. Drops stale tool calls and results and keeps everything else verbatim. Use when a session is long and heavy with old tool output, or when the user asks to compact or shrink the context.
x-caliber-origin: plugin:caliber-jev-compaction
---

# Jev Compaction

Compact session context without losing wording. Ordinary compaction asks a model
to summarize old turns. A file path, an exact error, or a constraint can vanish
when it matters. Jev compaction never rewrites anything. It scores each tool
call and tool result, then drops or truncates the ones that are no longer needed.
Everything kept stays verbatim.

When context is large, or the user asks to compact / shrink context, use this
skill. Do **not** invent a summary yourself.

## What each host can do today

| Host | Automatic compact | What you can do |
|---|---|---|
| Claude Code | Yes. Plugin hooks `session.compact` and can toast `/compact` | Install the plugin, or run `caliber compact` as a report |
| Cursor agents | No hook surface | Run `caliber compact --provider generic --transcript <path>` and apply the report |
| Grok Bot / Codex / similar | No hook surface | Same CLI path. There is no `/compact` toast unless the host adds a hook later |

Cursor's on-disk `agent-transcripts/*.jsonl` is unofficial and usually has
`tool_use` without ids and **no `tool_result`**. Jev needs paired results to
drop anything, so prefer an in-memory export (below) over that file.

## 1. Claude Code plugin (automatic, in-session)

Caliber ships a Claude Code plugin that replaces built-in compaction outright.
It hooks `session.compact` to substitute the verbatim-trimmed transcript for the
summary, and `turn.complete` to request compaction once context passes a
threshold (60% by default). When Jev fails or the reduction is not worth it, it
falls back to Claude Code's built-in summary rather than breaking the session.

```bash
caliber plugin install              # materialize it into .claude/plugins/
```

Enabling it needs two environment variables and Claude Code's own plugin
commands. `caliber plugin install` prints the exact steps. Function hooks are an
early-access Claude Code surface and are off unless you set
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## 2. The command (every agent)

```bash
caliber compact                                    # Claude: newest transcript, report only
caliber compact --json
caliber compact --provider generic --transcript ./session.json
caliber compact --provider generic --transcript ./session.json --write
caliber compact --provider cursor --transcript ~/.cursor/projects/<slug>/agent-transcripts/<id>.jsonl
```

Provide `--transcript` unless Claude can auto-discover
`~/.claude/projects/<slug>/*.jsonl`. `--write` is **generic schema only**
(proven round-trip). Claude Code and Cursor own their files. Do not rewrite them.

### Non-Claude agents export, score, and apply

1. Serialize the conversation, including tool results, to
   `caliber.transcript.v1` or an OpenAI-compatible messages array. Write it to
   a temp file.
2. Run `caliber compact --provider generic --transcript <path>` (add `--json`
   when you will apply decisions yourself).
3. Apply the decisions to this session's working context, **or** show the report
   and stop. With `--write`, the command replaces the generic file. You still have to
   load it back into the host. Cursor / Grok Bot will not toast `/compact`
   unless the host adds a hook later.

Generic envelope:

```json
{
  "schema": "caliber.transcript.v1",
  "messages": [
    { "role": "user", "text": "Fix the test", "toolUses": [] },
    {
      "role": "assistant",
      "text": "Reading",
      "toolUses": [{ "tool_use_id": "call_1", "tool": "Read", "input": { "path": "a.ts" } }]
    },
    {
      "role": "user",
      "text": "",
      "toolUses": [],
      "toolResults": [{ "tool_use_id": "call_1", "text": "file contents" }]
    }
  ]
}
```

The same `--provider generic` encoding accepts OpenAI-compatible JSON arrays
(`role: user|assistant|tool`, `tool_calls`).

Both paths need **your own** key. A Vercel AI Gateway key is not a TypeSafe
key. Set `AI_GATEWAY_API_KEY` (Vercel AI Gateway, model `typesafe-ai/jev`)
or `TYPESAFE_API_KEY` (direct TypeSafe System One, https://typesafe.ai).
Caliber does not ship or proxy a key.

## Reading the output

- **kept** means the call and result still matter, so both stay byte-for-byte alone.
- **result dropped** means the call still matters, but its output no longer does. The
  command truncates the result to a short head plus a note.
- **call dropped** means neither the call nor its result matters, so the command removes both.

If the reduction ratio is under 25%, compaction is not worth it. Say so and
leave the context alone rather than spending a request on it.
