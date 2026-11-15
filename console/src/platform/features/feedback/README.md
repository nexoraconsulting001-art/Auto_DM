# Feedback (Phase 8)

The Platform Console's feedback screen goes here: `index.jsx` (the feature, as `../index.js` describes) and its pages.

It lists what businesses said in showcase sessions and tracks each item from new to planned, then fixed (with what fixed
it) or declined. The routes are `platform.feedback`, `platform.createFeedback` and `platform.updateFeedback`; the server
side is `src/modules/feedback`.

When the screen is added, the Phase 7 screen list in `test/p7/platform-ui/source.test.js` (the `main` map of the F-39
test, and the routes it lists as having no screen) needs the new feature: say so in the track's report.
