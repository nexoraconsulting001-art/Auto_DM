# The shopper app

One source tree; one binary per brand. Each business that has the app gets its own Android and iOS app under its own
name, icon, colours and store accounts, built from this folder and one brand file. Nothing of any brand is in this
folder, and nothing a shopper sees names the platform: not a screen, an error, a header, a push or a host.

It is shopper-only. There are no admin screens and it never talks to the seller API: its only server is the store's
own address, through `@bhava/store-client` (`/api/store`).

## Stack

The same as `apps/owner` (see its README for why): Expo SDK 58, React Native 0.88, React 19, React Navigation, React
Query, on one lockfile. It shares `packages/theme` (`fromBrandKit`), `packages/ui` and `packages/app-core`, which it
imports by its parts (`@bhava/app-core/strings`, `/cache`, `/links`, `/push`, `/storage`, ...), never by its bare name:
the bare package carries the seller's session and client.

What a store adds: `expo-video` (reels), `expo-store-review`, `@bhava/store-client` and `@bhava/pay`.

## A brand

Everything a brand differs by is one file, named by the build setting `BRAND_FILE`, with its images beside it:

| In the brand file | Becomes |
| --- | --- |
| `name`, `shortName` | the app's name; the label under the icon |
| `android.package`, `android.versionCode` | the Android application id and build number |
| `ios.bundleId`, `ios.buildNumber`, `ios.teamId` | the iOS bundle id, build number and Apple team |
| `scheme` | the app's own link scheme (payment and sign-in come back by it) |
| `assets.*` | icon, adaptive icon (foreground and background), notification icon, splash |
| `colors`, `fonts`, `splashBackground` | the theme every screen is drawn in; the splash colour |
| `shopDomain`, `apiBaseUrl`, `tenantId` | the store's address, where every call goes, and the business id sent with each |
| `supportEmail`, `privacyUrl` | shown in the app and on the store listings |
| `associatedDomains`, `linkHosts`, `linkPaths` | iOS universal links; Android verified links (`autoVerify`) on the brand's own hosts |
| `runtimeVersion`, `appVersion` | which over-the-air updates fit; the version every brand shares |
| `payDriver`, `push`, `updates.channel` | how payment is taken; whether push is built in; the brand's update channel |

The schema is `BrandFile` in `src/contracts/apps.js`. `app.config.js` reads the file through `brand.cjs` and refuses to
make a config without one: there is no default brand. Fonts: any `.ttf` or `.otf` in a `fonts` folder beside the brand
file is built in, and `fonts/families.json` maps a brand font's name to the family the app uses; with none the app
uses the system font.

Two invented brands for CI and tests are in `tools/build-brand/fixtures`.

## Building

```
npm run build-brand -- tools/build-brand/fixtures/<name>/brand.json --platform android
npm run build-brand -- <business slug> --driver eas --profile production --submit
```

`tools/build-brand` loads the brand, validates it, checks the images against the stores' specs, writes the brand
folder under `.brand-builds/` (ignored by git), builds, submits and reports. The local driver needs no account:
`expo prebuild` and Gradle for an APK, `xcodebuild` for the iOS simulator with signing off. Signing keys for store
builds stay with the build service, per brand, and are never in the repository or a log.

To work on the app itself: `BRAND_FILE=../../tools/build-brand/fixtures/<name>/brand.json npx expo start` in this
folder, with a development build.

Build settings that are not a brand's (all optional except `BRAND_FILE`): `APP_ENV`, `API_BASE_URL` (test builds
only), `PAY_DRIVER`, `GOOGLE_SERVICES_JSON`, `APNS_ENV`, `UPDATES_URL`. They are described at the top of
`app.config.js`. `eas.json` names no project and no account.

## Payment

Physical goods are paid through the payment gateway, never through Apple's or Google's in-app purchase (App Review
guideline 3.1.3(e)). The app has no purchase library.

`@bhava/pay` has one interface, `pay(order)`, which answers `paid`, `failed` or `cancelled`, and two drivers:

- **hosted** (the default). Opens the store's own payment page, on the seller's address, in a system browser tab
  (Chrome Custom Tabs, SFSafariViewController), and comes back by the app's link `<scheme>://order/<token>`.
- **native**. The Razorpay SDK inside the app, through `plugins/with-native-pay.cjs`. It is built in only when the
  build setting `PAY_DRIVER` is `native`; in every other build `react-native.config.js` leaves the SDK out of the
  native projects altogether.

**The choice: hosted is on, native is off.** The native driver has not been built or run on a device. It stays off
until someone has: built with `PAY_DRIVER=native` on both platforms, paid with the gateway's test card and a test UPI
app on a real phone, and seen the release build's shrinker keep the SDK working. Until then no brand file says
`native`.

Neither driver decides that an order is paid. Whatever the browser tab or the SDK reports, the driver then asks the
server for the order's state; the server marks an order paid only from the provider's signed webhook, or from a
signature it checked itself.

## Features

`src/features/index.js` lists twenty folders, each default-exporting `{ name, screens, nav, strings }` (and
optionally `service`): home, catalog, reels, category, product, search, cart, checkout, payment, orders, tracking,
account, sign-in, notifications, rewards, wishlist, reviews, returns, addresses, legal. Each has one placeholder screen
until its track builds it. A track works inside its folder and touches no shared file. The format is at the top of
`src/features/index.js`; `src/shell/menu.js` turns the registry into tabs, screens and links.

A screen marked `link: true` opens from the same direct `https` link a message carries, on the brand's own hosts.
Those paths must be ones the server lists (`APP_LINK_PATHS`); a test checks both ways.

## Tests

- `npm run test:apps`: jest, beside the code (`src/**/*.test.js`). The network guard refuses any call that is not to
  this machine.
- `.maestro/*.yaml`: flows run on an emulator in `.github/workflows/brand-apps.yml`, once per fixture brand, against
  the job's own server (`.maestro/support/server.mjs`) with a seeded store for that brand. A flow's `name` counts
  toward a requirement when it starts with the requirement's id.
- `test/p6/shopper-app-workspace`: the parts that run with the server's tests (the client against the contract, the
  build tool, the policy check).
