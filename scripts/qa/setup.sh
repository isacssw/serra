#!/bin/sh
# Prepares /tmp/serra-qa for the QA driver: playwright-core, the fake t3, a scratch HOME and a clone of this repository
# as the bot's project. Touches nothing outside /tmp/serra-qa. Run from anywhere.
set -eu
QA=/tmp/serra-qa
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
mkdir -p "$QA/bin" "$QA/shots" "$QA/pw"
[ -d "$QA/pw/node_modules/playwright-core" ] || (cd "$QA/pw" && npm init -y >/dev/null && npm i --silent playwright-core@1.56.1)
cp "$HERE/fake-t3.cjs" "$QA/bin/t3" && chmod +x "$QA/bin/t3"
# The app runs with HOME=$QA/home (lib.mjs), so it never sees your real profiles. Only the Keychains folder is linked
# in, so 03 can store its two fake tokens (cleanup.sh removes them).
mkdir -p "$QA/home/Library"
[ -e "$QA/home/Library/Keychains" ] || ln -s "$HOME/Library/Keychains" "$QA/home/Library/Keychains"
if [ ! -d "$QA/project" ]; then
  git clone -q "$REPO" "$QA/project"
  git -C "$QA/project" remote set-url origin "$(git -C "$REPO" remote get-url origin)"
  git -C "$QA/project" fetch -q origin && git -C "$QA/project" remote set-head origin -a >/dev/null
fi
echo "QA folder ready: $QA"
