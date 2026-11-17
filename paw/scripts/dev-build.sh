#!/bin/sh
# Build the development Paw (target/debug/paw) and sign it with your own code
# signing identity, under the app's identifier (net.reevik.paw).
#
# Why: an unsigned (ad-hoc) build is a different app to macOS after every
# rebuild, so the Keychain forgets "Always Allow" and asks again for every
# item Paw reads. Signed with the same identity each time, the build keeps
# its access across rebuilds.
#
#   paw/scripts/dev-build.sh            # cargo build, then sign
#   paw/scripts/dev-build.sh --release  # any cargo build arguments
#
# PAW_SIGN_IDENTITY picks the identity; by default the first "Developer ID
# Application" or "Apple Development" one in your Keychain. Without one the
# build stays ad-hoc signed (and macOS keeps asking after rebuilds).
set -e
cd "$(dirname "$0")/../src-tauri"
cargo build "$@"

profile=debug
for a in "$@"; do [ "$a" = "--release" ] && profile=release; done
bin="target/$profile/paw"

id="${PAW_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null |
  awk -F'"' '/"Developer ID Application|"Apple Development/ { print $2; exit }')}"
if [ -z "$id" ]; then
  echo "dev-build: no code signing identity found; $bin stays ad-hoc signed." >&2
  exit 0
fi
codesign --force --sign "$id" --identifier net.reevik.paw "$bin"
echo "dev-build: signed $bin as net.reevik.paw with $id"
