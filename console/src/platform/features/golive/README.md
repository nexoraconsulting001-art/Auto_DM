# Go-live (Platform Console)

Track: golive. The checklist and, beside it, the sign-up switch (G-15 to G-17).

- `pages.jsx` shows `api.goliveStatus()` (`platform.goliveStatus`, `GoliveStatus` in `src/contracts/golive.js`): every item as ready, missing or not checked, grouped by who must act and the phase it blocks, blocking and open items first, with the next step from `src/modules/golive/next-steps.js` (plain data, the same words `npm run golive` prints).
- "Check live" asks the server for `?live=1`: the probes run then, each with its own timeout. Without it, items that would ask a provider are not checked, and not checked never counts as ready.
- It never shows a setting's value: an item's detail is a fixed phrase, followed at most by setting names.
- The sign-up switch: closed, invite or public, a daily cap, and a reason, for a super admin only (support sees it read-only). A move to public refused with `conflict` lists the open item ids from `fields.golive`; the super admin may then repeat it with `force: true` and a second reason (`forceReason`), recorded as forced. Invite codes stay on the Sign-up screen (`../signup`). The server checks everything again.
