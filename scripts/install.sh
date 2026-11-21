#!/usr/bin/env bash
# Installs Serra from this checkout: checks the prerequisites, installs dependencies, then runs setup.
#
#   ./scripts/install.sh                      # check, install, then the interactive setup
#   ./scripts/install.sh --check              # only check the prerequisites
#   ./scripts/install.sh --no-setup           # check and install, skip setup
#   ./scripts/install.sh --config my.json --profile /abs/folder   # unattended setup (arguments go to setup)
#
# It changes nothing outside this checkout except, when pnpm is missing, enabling Corepack's pnpm shim.
# It never starts the bot, installs a launchd service or contacts Slack.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

check_only=0
run_setup=1
setup_args=()
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --no-setup) run_setup=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) setup_args+=("$arg") ;;
  esac
done

if [ -t 1 ]; then ok=$'\033[32m✓\033[0m'; bad=$'\033[31m✗\033[0m'; warn=$'\033[33m!\033[0m'; else ok='OK'; bad='MISSING'; warn='NOTE'; fi
failed=0
pass() { printf '  %s %s\n' "$ok" "$1"; }
fail() { printf '  %s %s\n' "$bad" "$1"; failed=1; }
note() { printf '  %s %s\n' "$warn" "$1"; }

echo "Checking prerequisites"

if [ "$(uname -s)" = "Darwin" ]; then pass "macOS $(sw_vers -productVersion)"
else note "Not macOS: the bot runs in the foreground, but the background service and the app need macOS"; fi

if command -v node >/dev/null 2>&1; then
  version="$(node -p 'process.versions.node')"
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>=24 || (a===22 && b>=18) ? 0 : 1)'; then pass "Node $version"
  else fail "Node $version is too old. Install Node 24 (or 22.18+), for example: brew install node@24"; fi
else
  fail "Node is not installed. Install Node 24, for example: brew install node@24"
fi

if command -v git >/dev/null 2>&1; then pass "Git $(git --version | awk '{print $3}')"
else fail "Git is not installed. Run: xcode-select --install"; fi

if command -v gh >/dev/null 2>&1; then
  if login="$(gh api user --jq .login 2>/dev/null)" && [ -n "$login" ]; then pass "GitHub CLI, signed in as $login"
  else fail "GitHub CLI is not signed in. Run: gh auth login"; fi
else
  fail "GitHub CLI is not installed. Run: brew install gh, then gh auth login"
fi

t3_bin="${T3_BIN:-$HOME/.t3/bin/t3}"
if [ ! -x "$t3_bin" ] && command -v t3 >/dev/null 2>&1; then t3_bin="$(command -v t3)"; fi
if [ -x "$t3_bin" ]; then
  if "$t3_bin" thread start --help >/dev/null 2>&1; then pass "T3 Code CLI at $t3_bin (doctor checks the server and your project later)"
  else fail "$t3_bin doesn't support \"t3 thread\". Update T3 Code"; fi
  [ "$t3_bin" = "$HOME/.t3/bin/t3" ] || note "T3 isn't at ~/.t3/bin/t3: setup will need \"t3Bin\": \"$t3_bin\" in profile.json"
else
  fail "T3 Code CLI not found at ~/.t3/bin/t3 or on PATH. Install T3 Code and its t3 command first"
fi

pnpm_cmd=()
if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm); pass "pnpm $(pnpm --version)"
elif command -v corepack >/dev/null 2>&1; then
  if [ "$check_only" = 1 ]; then note "pnpm is not on PATH. Install will run: corepack enable pnpm"
  elif corepack enable pnpm 2>/dev/null && command -v pnpm >/dev/null 2>&1; then pnpm_cmd=(pnpm); pass "pnpm enabled with Corepack"
  else pnpm_cmd=(corepack pnpm); note "Couldn't add a pnpm command to PATH; using \"corepack pnpm\". Use it wherever the docs say pnpm"; fi
else
  fail "pnpm is not installed and Corepack is missing. Run: npm install -g pnpm@10"
fi

if [ "$failed" = 1 ]; then echo; echo "Fix the items marked above, then run this script again."; exit 1; fi
[ "$check_only" = 1 ] && { echo; echo "All prerequisites found."; exit 0; }

echo
echo "Installing dependencies"
"${pnpm_cmd[@]}" install --frozen-lockfile

if [ "$run_setup" = 0 ]; then
  echo
  echo "Installed. Create your bot with: ${pnpm_cmd[*]} run setup"
  exit 0
fi

echo
echo "Creating your bot profile"
"${pnpm_cmd[@]}" run setup "${setup_args[@]+"${setup_args[@]}"}"
