# Go-live kit

Status: draft. Nothing in this folder has been submitted to Meta, Google, Apple or anyone else. The user submits, from the real accounts.

Written from the code and kept honest by `node tools/review-pack/index.mjs` (also `node --test "test/p9/review-pack/**/*.test.js"`). The check fails when the pack and the code drift apart. Files marked "written from" are produced by `node tools/review-pack/index.mjs --write`; edit their source, not them.

| Folder | What it holds |
| --- | --- |
| meta-app-review | One entry per permission the code asks for, the screencast scripts, the reviewer's test steps, data handling answers, the release gates and the submission checklist |
| store | Bhava for Business listing text, Play data safety and Apple privacy answers, screenshots, age rating, review notes, and the template for a seller's branded app |
| privacy | What each surface collects, retention, processors, the DPDP notes, and the public pages the reviews point to |
| cutover | The runbook for moving the two existing single-shop apps onto Bhava |

What is never written here: a secret, a real customer's details, a real account id, the review phone number or code. Those are typed into the provider's form by hand.
