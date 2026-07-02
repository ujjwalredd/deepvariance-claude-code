#!/usr/bin/env bash
# Launcher regression tests. Runs bin/deepvariance under /bin/bash (bash 3.2 on
# macOS) with a stub `claude` binary and an isolated DEEPVARIANCE_HOME, and
# asserts safe-mode arg handling — in particular the empty-array + `set -u`
# crash on bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
note() { printf '%s\n' "$*"; }
check() { # check NAME COND_RESULT
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); note "ok - $1"; else FAIL=$((FAIL+1)); note "not ok - $1"; fi
}

# Isolated install dir with the real proxy + a config that needs no prompting.
export DEEPVARIANCE_HOME="$TMP/home"
mkdir -p "$DEEPVARIANCE_HOME/lib"
cp "$ROOT/lib/proxy.js" "$DEEPVARIANCE_HOME/lib/proxy.js"
cp "$ROOT/config.default.json" "$DEEPVARIANCE_HOME/config.default.json"

# Stub claude that just prints its args.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/claude" <<'EOF'
#!/bin/sh
echo "CLAUDE_ARGS:$*"
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

run_launcher() { # run_launcher PORT [extra args...]
  local port="$1"; shift
  cat > "$DEEPVARIANCE_HOME/config.json" <<EOF
{
  "apiBase": "http://127.0.0.1:1/v1",
  "email": "test@example.com",
  "apiKey": "test-key",
  "model": "test-model",
  "modelCtx": 32768,
  "toolMode": "emulated",
  "port": $port
}
EOF
  /bin/bash "$ROOT/bin/deepvariance" launch claude "$@" 2>&1
}

# 1. No extra args (the bash 3.2 empty-array crash case).
out="$(run_launcher 18917)" && rc=0 || rc=$?
check "launch with no args exits 0 (no unbound variable)" "$rc"
echo "$out" | grep -q 'unbound variable' && r=1 || r=0
check "no 'unbound variable' in output" "$r"
echo "$out" | grep -q 'CLAUDE_ARGS:--safe-mode$' && r=0 || r=1
check "--safe-mode injected by default" "$r"

# 2. Extra args pass through after --safe-mode.
out="$(run_launcher 18918 -p "do a thing")" && rc=0 || rc=$?
check "launch with -p exits 0" "$rc"
echo "$out" | grep -q 'CLAUDE_ARGS:--safe-mode -p do a thing' && r=0 || r=1
check "-p args pass through with safe-mode" "$r"

# 3. --no-safe-mode strips the flag.
out="$(run_launcher 18919 --no-safe-mode)" && rc=0 || rc=$?
check "launch --no-safe-mode exits 0" "$rc"
echo "$out" | grep -q 'CLAUDE_ARGS:$' && r=0 || r=1
check "--no-safe-mode passes no args to claude" "$r"

# 4. Invalid config (bad apiBase) fails fast instead of launching.
cat > "$DEEPVARIANCE_HOME/config.json" <<'EOF'
{ "apiBase": "not-a-url", "email": "test@example.com", "apiKey": "k", "model": "m", "modelCtx": 32768, "toolMode": "emulated", "port": 18920 }
EOF
out="$(/bin/bash "$ROOT/bin/deepvariance" launch claude 2>&1)" && rc=0 || rc=$?
[ "$rc" != "0" ] && r=0 || r=1
check "launch with bad apiBase exits non-zero" "$r"
echo "$out" | grep -q 'apiBase must be an http' && r=0 || r=1
check "bad apiBase prints a clear error" "$r"

# 5. doctor exits non-zero when there is no config, and runs under bash 3.2.
rm -f "$DEEPVARIANCE_HOME/config.json"
out="$(/bin/bash "$ROOT/bin/deepvariance" doctor 2>&1)" && rc=0 || rc=$?
[ "$rc" != "0" ] && r=0 || r=1
check "doctor with no config exits non-zero" "$r"
echo "$out" | grep -q 'deepvariance doctor' && r=0 || r=1
check "doctor prints its checklist header" "$r"

# 6. stop with no running proxy reports cleanly and exits 0.
out="$(/bin/bash "$ROOT/bin/deepvariance" stop 2>&1)" && rc=0 || rc=$?
check "stop with no proxy exits 0" "$rc"
echo "$out" | grep -q 'no running proxy found' && r=0 || r=1
check "stop reports no running proxy" "$r"

note ""
note "launcher tests: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
