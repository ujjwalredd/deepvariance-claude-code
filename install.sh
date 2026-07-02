#!/usr/bin/env bash
# deepvariance-claude-code installer
#   curl -fsSL https://raw.githubusercontent.com/ujjwalredd/deepvariance-claude-code/main/install.sh | bash
set -euo pipefail

REPO="ujjwalredd/deepvariance-claude-code"
BRANCH="main"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
HOME_DIR="$HOME/.deepvariance"
BIN_DIR="$HOME/.local/bin"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "deepvariance-claude-code installer"

# 1. Node >= 18
have node || die "Node.js >= 18 is required. Install from https://nodejs.org then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required (found $(node -v))."
have npm || die "npm is required (ships with Node)."
have curl || die "curl is required."

# 2. Claude Code
if have claude; then
  say "Claude Code already installed ($(claude --version 2>/dev/null | head -1))"
else
  say "Installing Claude Code (@anthropic-ai/claude-code)..."
  npm install -g @anthropic-ai/claude-code || die "failed to install Claude Code"
fi

# 3. Fetch deepvariance files
say "Installing deepvariance into $HOME_DIR"
mkdir -p "$HOME_DIR/lib" "$BIN_DIR"
curl -fsSL "$RAW/lib/proxy.js"          -o "$HOME_DIR/lib/proxy.js"        || die "fetch proxy.js failed"
curl -fsSL "$RAW/config.default.json"   -o "$HOME_DIR/config.default.json" || die "fetch config.default.json failed"
curl -fsSL "$RAW/bin/deepvariance"      -o "$BIN_DIR/deepvariance"         || die "fetch deepvariance failed"
chmod +x "$BIN_DIR/deepvariance"

# 4. PATH note
say "Installed."
echo
if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo "  Add ~/.local/bin to your PATH (add to ~/.zshrc or ~/.bashrc):"
  echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo
fi
echo "  Start it with:"
echo "      deepvariance launch claude"
echo
echo "  First run asks for your API key + email (saved locally, chmod 600)."
