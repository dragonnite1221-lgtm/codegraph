#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d /tmp/codegraph-release-XXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/repo/scripts" "$tmp/bin"
git init -q --bare "$tmp/remote.git"
git init -q "$tmp/repo"
git -C "$tmp/repo" config user.name Test
git -C "$tmp/repo" config user.email test@example.invalid
git -C "$tmp/repo" remote add origin "$tmp/remote.git"
cp "$root/scripts/release.sh" "$tmp/repo/scripts/release.sh"
printf '{"version":"1.0.0"}\n' > "$tmp/repo/package.json"
printf '## [1.0.0] - 2026-01-01\n' > "$tmp/repo/CHANGELOG.md"
git -C "$tmp/repo" add .
git -C "$tmp/repo" commit -qm first
git -C "$tmp/repo" tag v1.0.0
git -C "$tmp/repo" push -q origin v1.0.0
printf 'second\n' > "$tmp/repo/change.txt"
git -C "$tmp/repo" add .
git -C "$tmp/repo" commit -qm second
cat > "$tmp/bin/node" <<'SH'
#!/usr/bin/env bash
if [ "$1" = -p ]; then printf '1.0.0\n'; else printf 'notes\n'; fi
SH
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
touch "$GH_CALLED"
SH
chmod +x "$tmp/bin/node" "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GH_CALLED="$tmp/gh-called"

if bash "$tmp/repo/scripts/release.sh" > "$tmp/local-out" 2>&1; then exit 1; fi
grep -q 'local tag.*different commit' "$tmp/local-out"
test ! -e "$GH_CALLED"

git -C "$tmp/repo" tag -d v1.0.0 >/dev/null
if bash "$tmp/repo/scripts/release.sh" > "$tmp/remote-out" 2>&1; then exit 1; fi
grep -q 'origin tag.*different commit' "$tmp/remote-out"
if git -C "$tmp/repo" show-ref --verify --quiet refs/tags/v1.0.0; then exit 1; fi
test ! -e "$GH_CALLED"
