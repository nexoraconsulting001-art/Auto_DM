# Submission checklist

Do these in order. All of them are done by the user in Meta's own consoles; nothing here has been done.

- [ ] Meta Business Verification for Bhava is complete.
- [ ] Meta Tech Provider status applied for.
- [ ] The app's privacy policy address, deauthorize callback and data deletion callback are set to the production addresses in data-handling.md, and each answers (the go-live checklist item "privacy page and data-deletion callback" is ready).
- [ ] The review login and the demo business are set up (REVIEW_LOGIN_PHONE and REVIEW_LOGIN_CODE_HASH set in the platform's settings; the demo business exists).
- [ ] Two tester accounts with a role on the app exist: one to connect, one to send messages and comments.
- [ ] One screencast per script in screencast-scripts.md is recorded on the real app, after the rehearsal video from `e2e/p9/screencasts` was watched.
- [ ] For every permission in permissions.md: the justification is pasted, the screencast attached, and nothing extra requested.
- [ ] The app listing, icon and category are filled in; the data use answers match data-handling.md.
- [ ] The reviewer's test steps are pasted from reviewer-steps.md, with the review phone number and code typed in the credentials fields.
- [ ] The Meta app is switched to Live mode after approval, not before.
- [ ] After approval: the go-live checklist shows Advanced Access ready for each permission group.

Keep out of every text: any promise about accounts never being restricted, and any claim of Meta approval before approval and Tech Provider status are granted. `node tools/review-pack/index.mjs` checks this.
