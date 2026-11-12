# Unknown guideline: Something else the store asked for

**Store:** Either store. **Resubmit without a new build:** only when the steps below say so.

## What it means

The store named a guideline we have no playbook for, or none at all.

## Fix

1. Read the full message in the Platform Console (App rejections).
2. Decide the fix with the team and write it down. If it will happen again, add a playbook for its guideline in src/contracts/apps.js and docs/playbooks.
3. Resubmit only once the fix is done.

## If it happens again

A second rejection under the same guideline (ignoring any bracket, so 4.3(a) and 4.3 count together) opens a review task in the
Platform Console and blocks the next resubmit. Do not send the app again: a person on our team reads both rejections, decides the
fix, and resolves the task with what was done. Only then can the app go back to review.
