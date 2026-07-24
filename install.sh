#!/usr/bin/env bash
# Symlink the schema harness into ~/.config/opencode and install plugin deps.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
mkdir -p "$CFG/agent" "$CFG/plugin"
for a in schema executor reviewer; do
  ln -sfn "$REPO/agent/$a.md" "$CFG/agent/$a.md"
done
ln -sfn "$REPO/plugin/schema" "$CFG/plugin/schema"
( cd "$REPO/plugin/schema" && bun install )
echo "Installed. Add \"plugin\": [\"./plugin/schema\"] to $CFG/opencode.json if not present."
