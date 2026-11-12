#!/usr/bin/env bash
# Runs inside the emulator step of android-e2e (.github/workflows/apps.yml), which runs each line of its script on its
# own, so the steps live here. Installs the APK, then runs every flow at the top of apps/owner/.maestro with the values
# the job's server wrote (support/server.mjs: ids, invented numbers, local addresses) and APP_ID.
#
#   bash apps/owner/.maestro/support/run-flows.sh <flows.env> <app.apk> <junit.xml>
set -euo pipefail

ENV_FILE="$1"
APK="$2"
REPORT="$3"
: "${APP_ID:?APP_ID is not set}"

adb install -r "$APK"
args=(-e "APP_ID=$APP_ID")
while IFS='=' read -r name value; do
  if [ -n "$name" ]; then args+=(-e "$name=$value"); fi
done < "$ENV_FILE"
maestro --version
maestro test "${args[@]}" --format junit --output "$REPORT" apps/owner/.maestro
