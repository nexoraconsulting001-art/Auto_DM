# Go-live (Platform Console)

Track: golive. Empty until that track builds it.

To build here: `index.jsx` registering the feature (`{ name: 'golive', roles: ['super_admin', 'support'], nav, routes }`, see `../index.js`) and its page.

- The page shows `api.goliveStatus()` (`platform.goliveStatus`, `GoliveStatus` in `src/contracts/golive.js`): every item with ready or missing, who must act, the phase it blocks and whether it blocks go-live; blocking items first.
- It never shows a setting's value: an item's detail is a fixed phrase or a setting's name.
- Sign-up's mode stays on the sign-up screen (`../signup`). That screen's change to `public` can be refused with code `conflict` and the missing item ids in `fields.golive`; a super admin may then repeat it with `force: true` and a second reason (`forceReason`).
