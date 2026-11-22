#!/bin/sh
# Try Paw's first start, live: a second Paw next to yours, with empty
# settings, that doesn't see what's on this Mac outside it (Claude's and
# Copilot CLI's sign-ins, API keys in the environment or other tools' files,
# Ollama). Keys you paste and sign-ins you make in it go to a Keychain item
# of its own ("net.reevik.paw.first-run"), never your real Paw's.
#
#   paw/scripts/first-run.sh         start afresh (empty settings and Keychain item)
#   paw/scripts/first-run.sh stop    quit it, and its background process
#
# It runs the build in src-tauri/target/debug (paw/scripts/dev-build.sh).
set -e
cd "$(dirname "$0")/../src-tauri"
dir="${TMPDIR:-/tmp}/paw-first-run"

# Its processes: the window and the background process with this folder.
stop() {
  for p in $(pgrep -f "target/debug/paw" || true); do
    if ps eww -p "$p" 2>/dev/null | grep -q "PAW_CONFIG_DIR=$dir"; then
      kids=$(pgrep -P "$p" || true)
      kill "$p" 2>/dev/null || true
      [ -n "$kids" ] && kill $kids 2>/dev/null || true
    fi
  done
}

stop
[ "$1" = "stop" ] && { echo "first-run Paw stopped"; exit 0; }

# Afresh: no settings, no saved keys or sign-ins.
rm -rf "$dir"
mkdir -p "$dir"
while security delete-generic-password -s net.reevik.paw.first-run >/dev/null 2>&1; do :; done

[ -x target/debug/paw ] || { echo "Build Paw first: paw/scripts/dev-build.sh" >&2; exit 1; }
PAW_CONFIG_DIR="$dir" PAW_HIDE_PROVIDERS=1 nohup ./target/debug/paw >"$dir/window.log" 2>&1 </dev/null &
echo "first-run Paw started (settings in $dir); quit it with: paw/scripts/first-run.sh stop"
