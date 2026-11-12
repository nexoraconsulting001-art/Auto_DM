# play_target_api: Target API level

**Store:** Google Play. **Resubmit without a new build:** only when the steps below say so.

## What it means

Google Play refused the build because its targetSdkVersion is below what the store requires.

## Fix

1. Run the pre-submit gate for Android: target_api must pass.
2. Raise targetSdkVersion in the app config (expo-build-properties), run `node tools/presubmit/index.mjs --release-facts --write`, and rebuild every brand in one native-change batch.
3. This always needs a new build.

## If it happens again

A second rejection under the same guideline (ignoring any bracket, so 4.3(a) and 4.3 count together) opens a review task in the
Platform Console and blocks the next resubmit. Do not send the app again: a person on our team reads both rejections, decides the
fix, and resolves the task with what was done. Only then can the app go back to review.
