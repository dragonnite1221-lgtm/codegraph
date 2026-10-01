#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/target"
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
exit 7
SH
cat > "$tmp/bin/node" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" > "$MARKER"
SH
chmod +x "$tmp/bin/claude" "$tmp/bin/node"
export MARKER="$tmp/parser-path"
export PATH="$tmp/bin:$PATH"
export AGENT_EVAL_OUT="$tmp/out"
export CG_BIN=/unused/codegraph
cd "$root"
set +e
bash scripts/agent-eval/run-agent.sh "$tmp/target" synthetic prompt > "$tmp/stdout"
status=$?
set -e
test "$status" -eq 7
test "$(cat "$MARKER")" = "$root/scripts/agent-eval/parse-run.mjs"
