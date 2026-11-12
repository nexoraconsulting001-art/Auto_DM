# Bhava for Business (the owner app)

One app for every seller and creator, on Android and iOS, built from this folder with Expo and React Native. It talks only to the seller API at `/api/v1`, through `@bhava/api-client`. After sign-in it works in one of the person's businesses; nothing in this source tree names a business.

## The stack, and why this Expo SDK

**Expo SDK 58** (`expo ~58.0`, React Native 0.88, React 19.3), chosen on 2026-11-12 because it was the newest stable SDK (`latest` on npm; 59 existed only as canary) and it meets both store minimums:

- **Android:** React Native 0.88's version catalogue sets `targetSdk = 36` and `compileSdk = 37` (`node_modules/react-native/gradle/libs.versions.toml`), and `app.config.js` pins `targetSdkVersion: 36` as well. Google Play requires API 36 from 31 Aug 2026.
- **iOS:** React Native 0.88 needs Xcode 16.1 or newer (`min_xcode_version_supported` in its CocoaPods helpers), so it builds with Xcode 26 and the iOS 26 SDK, which the App Store requires from 28 Apr 2026.

Both are checked on the real build output in `.github/workflows/apps.yml` (`tools/build-check.mjs`), not taken on trust: the APK's `targetSdkVersion` is read with `aapt2`, and the iOS build prints and checks its Xcode and SDK versions.

Every dependency's version was chosen by `npx expo install`, so it matches the SDK. To add one, run `npx expo install <name>` here; to move to a newer SDK, `npx expo install expo@latest` and then `npx expo install --fix`.

Things that are settled, so tracks need not revisit them:

- **Navigation** is React Navigation (native stack and bottom tabs), not expo-router. Screens register from feature folders, so two people never edit one routes folder.
- **Tokens** live in SecureStore and nowhere else. The access token is in memory only. A test fails on any import of AsyncStorage.
- **Server state** is `@tanstack/react-query`, persisted per business to the app's own SQLite file for offline lists. Writes are never queued.
- **Icons** are `lucide-react-native`, imported one at a time (`import ShoppingBag from 'lucide-react-native/icons/shopping-bag'`), so the app carries only what it draws.
- **Fonts** are Unbounded and Figtree, loaded at start under the names in `@bhava/theme`.
- **No library that works on one platform only.** If a feature needs one, it needs an equivalent or a fallback on the other.
- **React is pinned once** for the whole repository (`overrides` in the root `package.json`), so the console and the apps share a single copy.

## Layout

```
apps/owner
  app.config.js      name, ids, permissions, privacy manifest, plugins; reads the build settings below
  eas.json           development, preview and production profiles; nothing account-specific (EAS is not used in CI)
  index.js, App.js   entry: fonts, then src/App.js
  src/App.js         the shell: update required, lock, sign-in, or the navigation
  src/services.js    createServices() and useServices(): session, api, queryClient, lock, config, strings
  src/shell          sign-in, the business switcher, the navigation built from the registry
  src/features       one folder per feature, and index.js listing them (see below)
  src/strings.js     the shell's words in English and Hindi, merged with each feature's
  .maestro           flows run on an emulator in CI; common/ shared steps, support/ the job's server and scripts
  store              store listings, privacy answers and the check that keeps them true (see Releasing)
packages/theme       design tokens: sellerTheme (Neel and Haldi) and fromBrandKit(kit)
packages/ui          cross-platform components that read the theme
packages/app-core    session and token storage, silent refresh, lock, push, deep links, offline cache, shared screens, strings
shared/api-client    the API client, shared with the web console (used as @bhava/api-client)
```

## How a feature registers

A feature is a folder in `src/features` whose `index.js` default-exports `{ name, access, feature, routeIds, screens, nav, strings }`. The full format is at the top of `src/features/index.js`. Every folder exists already with one placeholder screen, so building a feature means editing only its own folder:

1. Add screens to `screens` (`{ name, path, title, component }`). `path` is what a push or a link opens, such as `orders/:id`.
2. List every API route id the screens call, and every console page they stand in for (`'console:/orders/:id'`), in `routeIds`, written out as quoted strings.
3. Run `npm run parity`. It is strict: a seller route or console page with no app screen fails it, by name. `tools/parity-pending.json` stays empty, and there is no web-only flag of any spelling; the one exemption is a route flagged `consoleOnly` in the contract, an ops function in the Platform Console.
4. Put the feature's words in `strings` under keys that start with its name, in English and Hindi.
5. Inside a screen: `const { api, session } = useServices()`, data through react-query, components from `@bhava/ui`, words through `useStrings()`. Show `<OfflineBanner offline={...} />` over cached lists and disable buttons that write while offline.

`access` uses the same rules as the console and the server (`@bhava/app-core/access`), and `feature` names the entitlement the plan must include. The shell hides what a person may not open; the server refuses it again. A route marked `fresh` answers `reauth_required`: listen with `session.on('reauth', ...)`, re-authenticate, then repeat the call.

## Build settings

Read by `app.config.js`. The app builds with none of them set, and with no account anywhere.

| Setting | What it does |
|---|---|
| `API_BASE_URL` | The API's origin, such as `https://app.example.com`. Default `http://localhost:3000`; a production build refuses anything but https |
| `APP_ID` | Android package and iOS bundle id. Default `com.bhava.business` |
| `APP_ENV` | `development` (default), `preview` or `production` |
| `GOOGLE_SERVICES_JSON` | Path to `google-services.json` (or put it at `./google-services.json`). Without it Android push is off |
| `APNS_ENV` | `development` or `production`: adds the iOS push entitlement. Without it iOS push is off |
| `UPDATES_URL` | Where over-the-air updates are served. Without it updates are off |
| `HIDE_PLAN_PURCHASE` | `1` hides every buy button for a plan on iOS |

Keystores, `.p8` and `.p12` files and the Firebase files are never committed: `.gitignore` leaves them out and `npm run secret-scan` refuses them by name.

## Running it

```
npm install                                  # at the repository root: one lockfile for the server and the apps
npm run app:server                           # the API on its built-in database with simulators, port 3000
cd apps/owner
API_BASE_URL=http://10.0.2.2:3000 npx expo run:android     # an emulator reaches this machine at 10.0.2.2
API_BASE_URL=http://localhost:3000 npx expo run:ios        # on a Mac
```

`npx expo run:*` generates `android/` and `ios/` (both ignored by git) and builds them. The app uses native modules that Expo Go does not carry, so it needs this build.

## Tests

```
npm run test:apps                  # jest over apps/* and packages/*; tests sit beside the code as *.test.js
npm run parity                     # every seller route and console page has an app screen (strict)
node apps/owner/store/check.mjs    # the listings explain every permission; the privacy answers match the app
npm run app:export                 # the JavaScript bundles for Android and iOS
```

A jest test can reach `localhost` and nothing else (`tools/jest/net-guard.cjs`). A test or a Maestro flow whose name starts with a requirement id, such as `P-19 ...`, counts for that requirement in `npm run gate`; the gate does not run flows.

### The Maestro flows

The flows at the top of `.maestro` (sign in with a WhatsApp code, switch business, create an automation, confirm a cash on delivery order and see the console agree, replace the payment key after a fresh code, revoke a device and be signed out) run on an Android emulator in the `android-e2e` job. `support/server.mjs` is the job's own server: it seeds a made-up world (`support/world.mjs`) into a new built-in database, starts every simulator from `tools/sim` and the server, and writes the ids and invented numbers the flows need to a file that `support/run-flows.sh` passes to Maestro. The flows read sign-in codes from the WhatsApp simulator's outbox (`support/code.js`) and check the server side with `support/console-order.js` and `support/api-device.js`. To run them at a desk against an emulator:

```
PORT=3000 APP_HOST=10.0.2.2 node apps/owner/.maestro/support/server.mjs --out flows.env
APP_ID=com.bhava.business bash apps/owner/.maestro/support/run-flows.sh flows.env app-release.apk report.xml
```

`test/p5/app-release` checks every flow without a device: each element it touches is a testID the app renders, each value is one the server hands it, and each script works against the real server and simulators.

## Releasing

CI (`.github/workflows/apps.yml`) builds a signed release APK and an iOS simulator app on every push, with no secret and no account; either failing fails the run, and the last job, "Apps ready", passes only when every job did, so it is the one check a branch rule needs. The APK's `targetSdkVersion` (36 or higher) and the Xcode and iOS SDK versions (26 or newer) are checked in the jobs that build them (`tools/build-check.mjs`). The Android signing key is made in the job, masked and deleted; keystores, `.p8` and `.p12` files and the Firebase files are never committed (`.gitignore`, `npm run secret-scan`) and the APK is checked to carry none.

`store/` holds what the store consoles ask for:

| File | What it is |
|---|---|
| `listing.json` | The Play and App Store text for Bhava for Business, and the sentence that explains each permission the app asks for |
| `collection.json` | What the app collects, why, and the files that collect it. The one source for the answers below |
| `privacy-manifest.json` | The required-reason APIs the app reaches, Apple's reason code for each, and why |
| `play/data-safety.json`, `app-store/app-privacy.json` | The Data safety and App Privacy answers, generated from `collection.json` (`node apps/owner/store/check.mjs --write`); enter them in each console |
| `answers.cjs` | Works the answers and the iOS privacy manifest out of those files; `app.config.js` builds `ios.privacyManifests` with it |

`store/check.mjs` fails when the app config asks for a permission the listing does not explain, when a field, picker or SDK collects something `collection.json` does not list, when a reason code is not one Apple allows, or when the committed answers are stale. Account-specific details (developer name, contact email, privacy policy address, EAS project, signing credentials) are entered in each console when the accounts exist, never in this repository.

`eas.json` is ready for EAS Build later: `development` and `preview` make an internal APK and a simulator build, `production` an app bundle and a device build, each on its own update channel. A production build needs `API_BASE_URL` set to an https address (as an EAS environment variable); push needs the google-services file and `APNS_ENV`, supplied from outside the repository.
