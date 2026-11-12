#!/usr/bin/env bash
# Takes the listing screenshots of one brand's APK on the running emulator (the emulator step of
# .github/workflows/brand-apps.yml, which runs each line of its script on its own, so the steps live here).
#
#   bash tools/listing-shots/capture-android.sh <flows.env> <app.apk> <captures dir>
#
# Installs the APK, sets the screen to the shape the Play listing takes (at most twice as tall as wide), runs the shots flow
# from the captures folder so the pictures land there, puts the screen back, and stamps the folder with the APK's hash.
set -euo pipefail

ENV_FILE="$1"
APK="$2"
OUT="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
APK="$(cd "$(dirname "$APK")" && pwd)/$(basename "$APK")"
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

adb install -r "$APK" > /dev/null
adb shell wm size 1080x2160
trap 'adb shell wm size reset' EXIT

args=()
APP_ID=""
while IFS='=' read -r name value; do
  if [ -n "$name" ]; then
    args+=(-e "$name=$value")
    if [ "$name" = "APP_ID" ]; then APP_ID="$value"; fi
  fi
done < "$ENV_FILE"

(cd "$OUT" && maestro test "${args[@]}" "$ROOT/apps/shopper/.maestro/shots/shots.yaml")
node "$ROOT/tools/listing-shots/index.mjs" stamp --platform android --app-id "$APP_ID" --build "$APK" --device phone --out "$OUT"
