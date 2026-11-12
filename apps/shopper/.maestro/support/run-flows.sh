#!/usr/bin/env bash
# Runs inside the emulator step of .github/workflows/brand-apps.yml, which runs each line of its script on its own, so
# the steps live here. Installs the brand's APK, then runs every
# flow at the top of apps/shopper/.maestro with the values the job's server wrote (support/server.mjs).
#
#   bash apps/shopper/.maestro/support/run-flows.sh <flows.env> <app.apk> <junit.xml>
set -euo pipefail

ENV_FILE="$1"
APK="$2"
REPORT="$3"

adb install -r "$APK"
args=()
while IFS='=' read -r name value; do
  if [ -n "$name" ]; then args+=(-e "$name=$value"); fi
done < "$ENV_FILE"
maestro --version
maestro test "${args[@]}" --format junit --output "$REPORT" apps/shopper/.maestro
