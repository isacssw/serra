#!/usr/bin/env bash
# Installs Serra from this checkout on macOS or Linux: checks the prerequisites, installs dependencies, then runs setup.
#
#   ./scripts/install.sh                      # check, install, then the interactive setup
#   ./scripts/install.sh --check              # only check the prerequisites
#   ./scripts/install.sh --no-setup           # check and install, skip setup
#   ./scripts/install.sh --config my.json --profile /abs/folder   # unattended setup (arguments go to setup)
#
# Without Node 24 (or 22.18+) it installs Node for you only, in ~/.local/share/serra/runtime, from nodejs.org,
# after checking the download against the SHA-256 pinned below. It also adds a `serra` command to ~/.local/bin and,
# when pnpm is missing, Corepack's pnpm shim. It changes nothing else outside this checkout: no sudo, no service,
# no open port, and it never contacts Slack. On Linux it installs only what the bot runs (no desktop app).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Node for this user when none fits. Bump all five together, from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
NODE_VERSION=24.22.3
node_sha256() {
  case "$1" in
    darwin-arm64) echo ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
    darwin-x64) echo 977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
    linux-arm64) echo 261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
    linux-x64) echo 061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
    *) return 1 ;;
  esac
}
NODE_MIRROR="${SERRA_NODE_MIRROR:-https://nodejs.org/dist}"
RUNTIME="${XDG_DATA_HOME:-$HOME/.local/share}/serra/runtime"
BIN_DIR="$HOME/.local/bin"

check_only=0
run_setup=1
setup_args=()
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --no-setup) run_setup=0 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) setup_args+=("$arg") ;;
  esac
done

if [ -t 1 ]; then ok=$'\033[32m✓\033[0m'; bad=$'\033[31m✗\033[0m'; warn=$'\033[33m!\033[0m'; else ok='OK'; bad='MISSING'; warn='NOTE'; fi
failed=0
pass() { printf '  %s %s\n' "$ok" "$1"; }
fail() { printf '  %s %s\n' "$bad" "$1"; failed=1; }
note() { printf '  %s %s\n' "$warn" "$1"; }
# Before setup, gh and T3 are needed; an install that skips setup only notes them.
needed() { if [ "$run_setup" = 1 ] || [ "$check_only" = 1 ]; then fail "$1"; else note "$1 (needed before setup)"; fi; }

node_fits() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>=24 || (a===22 && b>=18) ? 0 : 1)' 2>/dev/null; }

echo "Checking prerequisites"

os="$(uname -s)"
case "$os" in
  Darwin) platform=darwin; pass "macOS $(sw_vers -productVersion)" ;;
  Linux) platform=linux; pass "Linux $(uname -r)" ;;
  *) platform=''; fail "$os isn't supported. Serra runs on macOS and Linux" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) arch="$(uname -m)" ;;
esac

if [ "$(id -u)" = 0 ]; then fail "Running as root. Run this as the user the bot will run as"; fi

node_bin=''
pinned="node-v$NODE_VERSION-$platform-$arch"
if command -v node >/dev/null 2>&1 && node_fits node; then
  node_bin="$(command -v node)"; pass "Node $(node -p 'process.versions.node')"
elif [ -x "$RUNTIME/$pinned/bin/node" ]; then
  node_bin="$RUNTIME/$pinned/bin/node"; pass "Node $NODE_VERSION in $RUNTIME"
elif ! node_sha256 "$platform-$arch" >/dev/null; then
  fail "No Node download for $os $arch. Install Node 24 yourself, then run this again"
elif [ "$platform" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  fail "Node from nodejs.org needs glibc. Install Node 24 with your package manager, then run this again"
elif ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  fail "Node is missing, and so are curl and wget to download it. Install curl"
else
  if command -v node >/dev/null 2>&1; then note "Node $(node -p 'process.versions.node') is too old. Will install Node $NODE_VERSION for you only"
  else note "Node is missing. Will install Node $NODE_VERSION for you only"; fi
fi

if command -v git >/dev/null 2>&1; then pass "Git $(git --version | awk '{print $3}')"
elif [ "$platform" = darwin ]; then fail "Git is not installed. Run: xcode-select --install"
else fail "Git is not installed. Install it with your package manager"; fi

if command -v gh >/dev/null 2>&1; then
  if login="$(gh api user --jq .login 2>/dev/null)" && [ -n "$login" ]; then pass "GitHub CLI, signed in as $login"
  else needed "GitHub CLI is not signed in. Run: gh auth login"; fi
elif [ "$platform" = darwin ]; then needed "GitHub CLI is not installed. Run: brew install gh, then gh auth login"
else needed "GitHub CLI is not installed. See cli.github.com, then run gh auth login"; fi

t3_bin="${T3_BIN:-$HOME/.t3/bin/t3}"
if [ ! -x "$t3_bin" ] && command -v t3 >/dev/null 2>&1; then t3_bin="$(command -v t3)"; fi
if [ -x "$t3_bin" ]; then
  if "$t3_bin" thread start --help >/dev/null 2>&1; then pass "T3 Code CLI at $t3_bin (doctor checks the server and your project later)"
  else needed "$t3_bin doesn't support \"t3 thread\". Update T3 Code"; fi
  [ "$t3_bin" = "$HOME/.t3/bin/t3" ] || note "T3 isn't at ~/.t3/bin/t3: setup will need \"t3Bin\": \"$t3_bin\" in profile.json"
else
  needed "T3 Code CLI not found at ~/.t3/bin/t3 or on PATH. Install T3 Code and its t3 command first"
fi

if [ "$failed" = 1 ]; then echo; echo "Fix the items marked above, then run this script again."; exit 1; fi
[ "$check_only" = 1 ] && { echo; echo "All prerequisites found."; exit 0; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https,file' --tlsv1.2 --retry 2 -o "$2" "$1"
  else wget -q --https-only -O "$2" "$1"; fi
}

if [ -z "$node_bin" ]; then
  echo
  echo "Installing Node $NODE_VERSION"
  expected="$(node_sha256 "$platform-$arch")"
  (umask 077; mkdir -p "$RUNTIME")
  work="$(mktemp -d "$RUNTIME/.download.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  download "$NODE_MIRROR/v$NODE_VERSION/$pinned.tar.gz" "$work/node.tar.gz"
  actual="$(sha256 "$work/node.tar.gz")"
  if [ "$actual" != "$expected" ]; then
    echo "The Node download doesn't match its pinned checksum, so it wasn't installed." >&2
    echo "  expected $expected" >&2
    echo "  got      $actual" >&2
    exit 1
  fi
  tar -xzf "$work/node.tar.gz" -C "$work"
  rm -rf "${RUNTIME:?}/$pinned"
  mv "$work/$pinned" "$RUNTIME/$pinned"
  node_bin="$RUNTIME/$pinned/bin/node"
  pass "Node $("$node_bin" -p 'process.versions.node') (checksum verified)"
fi
node_dir="$(dirname "$node_bin")"
export PATH="$node_dir:$PATH"
# Corepack would otherwise stop to ask before fetching pnpm. It checks pnpm's signature from npm itself.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

pnpm_cmd=()
if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm); pass "pnpm $(pnpm --version)"
elif command -v corepack >/dev/null 2>&1; then
  if corepack enable pnpm 2>/dev/null && command -v pnpm >/dev/null 2>&1; then pnpm_cmd=(pnpm); pass "pnpm enabled with Corepack"
  else pnpm_cmd=(corepack pnpm); note "Couldn't add a pnpm command to PATH; using \"corepack pnpm\". Use it wherever the docs say pnpm"; fi
else
  echo "pnpm is not installed and Corepack is missing. Run: npm install -g pnpm@10" >&2; exit 1
fi

echo
echo "Installing dependencies"
if [ "$platform" = linux ]; then "${pnpm_cmd[@]}" install --frozen-lockfile --prod
else "${pnpm_cmd[@]}" install --frozen-lockfile; fi

# `serra`: the bot CLI (pnpm bot) on this Node, from anywhere. Never replaces a `serra` this script didn't write.
marker='# Serra CLI, written by scripts/install.sh'
mkdir -p "$BIN_DIR"
if [ ! -e "$BIN_DIR/serra" ] || grep -qxF "$marker" "$BIN_DIR/serra" 2>/dev/null; then
  q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  printf '#!/bin/sh\n%s\nPATH=%s:"$PATH" exec %s %s "$@"\n' "$marker" "$(q "$node_dir")" "$(q "$node_bin")" "$(q "$ROOT/src/manage.ts")" > "$BIN_DIR/serra.tmp"
  chmod 755 "$BIN_DIR/serra.tmp"
  mv "$BIN_DIR/serra.tmp" "$BIN_DIR/serra"
  pass "serra command in $BIN_DIR"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) note "Add $BIN_DIR to PATH to run serra" ;; esac
else
  note "$BIN_DIR/serra exists and isn't Serra's; left as it is"
fi

if [ "$run_setup" = 0 ]; then
  echo
  echo "Installed. Next: serra server doctor, then ${pnpm_cmd[*]} run setup"
  exit 0
fi

echo
echo "Creating your bot profile"
"${pnpm_cmd[@]}" run setup "${setup_args[@]+"${setup_args[@]}"}"
