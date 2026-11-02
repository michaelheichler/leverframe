#!/bin/sh
if [ "$CALIBER_SUBPROCESS" = "1" ] || [ -n "$CALIBER_SPAWNED" ]; then
  exit 0
fi
INPUT=$(cat 2>/dev/null)
printf '%s' "$INPUT" | grep -qE '(\.claude/(skills|rules)|\.cursor/(skills|rules)|\.agents/skills|\.opencode/skills|\.github/instructions)/' || exit 0
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  PROJECT_DIR="$CLAUDE_PROJECT_DIR"
else
  script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || script_dir=""
  if [ -n "$script_dir" ]; then
    PROJECT_DIR=$(cd "$script_dir/../.." 2>/dev/null && pwd) || PROJECT_DIR="$PWD"
  else
    PROJECT_DIR="$PWD"
  fi
fi
cd "$PROJECT_DIR" 2>/dev/null || exit 0
caliber sync --quiet >/dev/null 2>&1
exit 0
