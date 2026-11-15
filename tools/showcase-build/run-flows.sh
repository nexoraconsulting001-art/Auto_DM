#!/usr/bin/env bash
# Installs an APK on the running emulator and runs the showcase flows against the job's own server. The emulator step of
# the workflow runs each line of its script on its own, so the steps live here.
#
#   bash tools/showcase-build/run-flows.sh <shopper|owner> <flows.env> <app.apk> <junit.xml> [app id]
#
# <flows.env> is what tools/showcase-build/server.mjs wrote. The shopper's app id is in it (APP_ID); the owner app's is the
# fifth argument.
set -euo pipefail

KIND="$1"
ENV_FILE="$2"
APK="$3"
REPORT="$4"
case "$KIND" in
  shopper) DIR=apps/shopper/.maestro/showcase ;;
  owner) DIR=apps/owner/.maestro/showcase ;;
  *) echo "The first argument is shopper or owner" >&2; exit 2 ;;
esac

adb install -r "$APK"
args=()
if [ -n "${5:-}" ]; then args+=(-e "APP_ID=$5"); fi
while IFS='=' read -r name value; do
  if [ -n "$name" ]; then args+=(-e "$name=$value"); fi
done < "$ENV_FILE"
maestro --version
maestro test "${args[@]}" --format junit --output "$REPORT" "$DIR"
