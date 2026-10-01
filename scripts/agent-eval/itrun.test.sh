#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d /tmp/codegraph-eval-XXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/repo with spaces;touch injected"
cat > "$tmp/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  new-session)
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -c ]; then printf '%s\n' "$2" > "$START_DIR"; break; fi
      shift
    done
    ;;
  send-keys) printf '%s\n' "$*" >> "$SENT" ;;
esac
SH
cat > "$tmp/bin/seq" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$tmp/bin/tmux" "$tmp/bin/seq"
export START_DIR="$tmp/start-dir" SENT="$tmp/sent"
export PATH="$tmp/bin:$PATH" AGENT_EVAL_OUT="$tmp/out"
cd "$root"
set +e
bash scripts/agent-eval/itrun.sh "$tmp/repo with spaces;touch injected" synthetic prompt > "$tmp/stdout" 2>&1
status=$?
set -e
test "$status" -ne 0
test "$(cat "$START_DIR")" = "$tmp/repo with spaces;touch injected"
test "$(cat "$SENT")" = 'send-keys -t cgt_synthetic claude --dangerously-skip-permissions Enter'
test ! -e "$root/injected"
