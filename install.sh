#!/usr/bin/env bash
# deepvariance-claude-code installer
#   curl -fsSL https://github.com/ujjwalredd/deepvariance-claude-code/raw/refs/heads/main/install.sh | bash
set -euo pipefail

REPO="ujjwalredd/deepvariance-claude-code"
VERSION="1.0.7"
REF="${DEEPVARIANCE_REF:-main}"
HOME_DIR="$HOME/.deepvariance"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
on_path() { case ":$PATH:" in *":$1:"*) return 0;; *) return 1;; esac; }

# Append the PATH line to a shell rc file if not already present.
add_path_to_rc() {
  local rc="$1" line="$2"
  [ -f "$rc" ] || return 1
  grep -qF "$line" "$rc" 2>/dev/null && return 0
  printf '\n# added by deepvariance-claude-code installer\n%s\n' "$line" >> "$rc"
}

say "deepvariance-claude-code installer ($REF)"

# 1. Node >= 18
have node || die "Node.js >= 18 is required. Install from https://nodejs.org then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required (found $(node -v))."
have npm || die "npm is required (ships with Node)."
have curl || die "curl is required."

# Resolve branch/tag refs to an immutable commit SHA before fetching payload
# files. This avoids raw.githubusercontent.com serving a stale `main` payload
# after a push. If resolution fails, fall back to the user-provided ref.
RESOLVED_REF="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data", c => s += c);
  process.stdin.on("end", () => { try { const j=JSON.parse(s); process.stdout.write(j.sha || ""); } catch (_) {} });
' || true)"
FETCH_REF="${RESOLVED_REF:-$REF}"
RAW="https://raw.githubusercontent.com/$REPO/$FETCH_REF"

# 2. Claude Code
if have claude; then
  say "Claude Code already installed ($(claude --version 2>/dev/null | head -1))"
else
  say "Installing Claude Code (@anthropic-ai/claude-code)..."
  npm install -g @anthropic-ai/claude-code || die "failed to install Claude Code"
fi

# 3. Pick a bin dir. Prefer updating the executable the shell already resolves,
#    otherwise prefer the npm global bin — it's already on PATH where `claude`
#    lives. Fall back to ~/.local/bin when needed.
EXISTING_BIN="$(command -v deepvariance 2>/dev/null || true)"
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
if [ -n "$EXISTING_BIN" ] && [ -w "$EXISTING_BIN" ] && [ -w "$(dirname "$EXISTING_BIN")" ]; then
  BIN_DIR="$(dirname "$EXISTING_BIN")"
elif [ -d "$NPM_BIN" ] && [ -w "$NPM_BIN" ] && on_path "$NPM_BIN"; then
  BIN_DIR="$NPM_BIN"
else
  BIN_DIR="$HOME/.local/bin"
fi

# 4. Fetch deepvariance files
say "Installing library into $HOME_DIR"
mkdir -p "$HOME_DIR/lib" "$BIN_DIR"
curl -fsSL "$RAW/lib/proxy.js"          -o "$HOME_DIR/lib/proxy.js"        || die "fetch proxy.js failed"
curl -fsSL "$RAW/config.default.json"   -o "$HOME_DIR/config.default.json" || die "fetch config.default.json failed"
say "Installing 'deepvariance' into $BIN_DIR"
curl -fsSL "$RAW/bin/deepvariance"      -o "$BIN_DIR/deepvariance"         || die "fetch deepvariance failed"
chmod +x "$BIN_DIR/deepvariance"

# 5. Ensure the bin dir is on PATH. If we used ~/.local/bin and it isn't on
#    PATH yet, wire it into the shell rc files automatically so a NEW shell
#    picks it up — no manual step required.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
NEED_RESTART=0
if ! on_path "$BIN_DIR"; then
  add_path_to_rc "$HOME/.zshrc"   "$PATH_LINE" || true
  add_path_to_rc "$HOME/.bashrc"  "$PATH_LINE" || true
  add_path_to_rc "$HOME/.profile" "$PATH_LINE" || true
  # make sure at least one rc exists for login shells
  [ -f "$HOME/.zshrc" ] || add_path_to_rc "$HOME/.zprofile" "$PATH_LINE" || true
  export PATH="$BIN_DIR:$PATH"
  NEED_RESTART=1
fi

say "Installed."
echo
echo "  Installed from: $REF"
[ "$FETCH_REF" != "$REF" ] && echo "  Resolved commit: $FETCH_REF"
echo "  Binary: $BIN_DIR/deepvariance"
"$BIN_DIR/deepvariance" version 2>/dev/null | sed 's/^/  Version: /' || true
if [ -n "$EXISTING_BIN" ] && [ "$EXISTING_BIN" != "$BIN_DIR/deepvariance" ] && on_path "$(dirname "$EXISTING_BIN")"; then
  echo
  echo "  Warning: existing deepvariance at $EXISTING_BIN may still be earlier on PATH."
  echo "  Open a new terminal after PATH update, or remove the old binary."
fi
echo
echo "  Start it with:"
echo "      deepvariance launch claude"
echo
if [ "$NEED_RESTART" = "1" ]; then
  echo "  (PATH was updated — open a NEW terminal, or run: source ~/.zshrc)"
  echo
fi
echo "  First run asks for your API key + email (saved locally, chmod 600)."
