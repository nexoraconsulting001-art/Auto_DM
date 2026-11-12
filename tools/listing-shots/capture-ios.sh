#!/usr/bin/env bash
# Takes the listing screenshots of one brand's iOS simulator app on a booted simulator (the macOS job of
# .github/workflows/brand-apps.yml).
#
#   bash tools/listing-shots/capture-ios.sh <flows.env> <app.zip> <captures dir>
#
# <app.zip> is the zipped .app the iOS job makes. The simulator should be a 6.9 inch iPhone, so the pictures are the size the
# App Store takes before they are fitted.
set -euo pipefail

ENV_FILE="$1"
ZIP="$2"
OUT="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"
APP="$(ls -d "$WORK"/*.app | head -1)"
xcrun simctl install booted "$APP"

args=()
while IFS='=' read -r name value; do
  if [ -n "$name" ] && [ "$name" != "APP_ID" ]; then args+=(-e "$name=$value"); fi
done < "$ENV_FILE"
# On iOS the app id is the bundle id, which the flow's own value for Android is not.
BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
args+=(-e "APP_ID=$BUNDLE")

(cd "$OUT" && maestro test "${args[@]}" "$ROOT/apps/shopper/.maestro/shots/shots.yaml")
node "$ROOT/tools/listing-shots/index.mjs" stamp --platform ios --app-id "$BUNDLE" --build "$ZIP" --device iphone_6_9 --out "$OUT"
