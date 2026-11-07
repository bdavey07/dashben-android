# DashBen (Android)

Capacitor 5 shell around the local-first PKM client — the Android app for
Ben's personal knowledge manager. Package `ca.bendavey.pkm`, launcher name
DashBen, debug-signed for personal use.

## What lives here

- `www/` — the app itself: a shell variant of the PKM web client
  (`public/local/` in the [PKM-new repo](https://github.com/bdavey07/PKM-new)).
  It shares the client's engine, store, and UI, plus shell-only pieces:
  native file persistence (a real `pkm.db` in the app sandbox, via the
  Filesystem plugin), secure token storage (Android Keystore), share-sheet
  inbox capture, native-call timeouts, and the Management-tab sync token
  field. The canonical web client is the source of truth for shared code;
  this `www/` is a variant copy — a fix to shared code currently lands in
  both places (a single-source build script is planned to end that).
- `www/extras.mjs` and `www/refresh.css` — shared verbatim with the web
  client (stamp eu); keep them byte-identical with `public/local/` in
  PKM-new.
- `android/` — the Capacitor Android project: `MainActivity`, the custom
  `ShareIntentPlugin` (share-sheet capture), manifest (incl. the `SEND`
  intent filter), launcher icons, and Gradle config.
- `maven-seed/` + `gradle-offline.init.gradle` — only needed in sandboxed
  or offline build environments (see below). On a normal machine with
  network access, ignore them: Gradle downloads its dependencies itself.

## Build from a fresh clone

Prerequisites: Node 18+, JDK 17, Android SDK with platform android-33 and
build-tools 34.0.0, Gradle 8.0.2 (or use the wrapper, which downloads its
own distribution).

```sh
npm install
npx cap sync android
# cap sync regenerates android/capacitor-cordova-android-plugins/build.gradle,
# so re-apply the build-tools patch (AGP 8.0.0 defaults to 30.0.3, which is
# not installed — only 34.0.0 is):
#   add:  buildToolsVersion "34.0.0"
#   after the compileSdkVersion line in that file.
python3 scripts/gen-assets.py   # launcher icons + splash screens (see below)
cd android
gradle assembleDebug            # APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Install with `adb install app-debug.apk`. If an older wrapper with the same
app ID is on the device, uninstall it first (different debug signature):
`adb uninstall ca.bendavey.pkm`.

## Native extras (stamp eu)

- App shortcuts: long-press the launcher icon for Capture / New task /
  Quick note (`res/xml/shortcuts.xml`).
- Quick Settings tile: add "DashBen capture" from the shade's edit
  screen (`CaptureTileService`).
- Back button closes the top-most layer (popup, menu, drawer) before
  leaving the app (`MainActivity.onBackPressed` → `window.__dashbenBack`).
- Status and navigation bars follow the theme (`SystemBarsPlugin`).
- Widgets use Material You colours on Android 12+ (`values-v31/colors.xml`);
  older versions keep the Ember palette.
- Per-task reminder times are scheduled through the existing
  LocalNotifications reminders; such a task skips the 9 a.m. one.

## Binary assets

PNGs are not committed (the repo's push tooling is text-only). Run
`python3 scripts/gen-assets.py` (needs Pillow) to regenerate them:
launcher icons are an exact redraw of `favicon-v2.svg`; splash screens are
white canvases with the same mark centered (the originals were Capacitor
defaults, not app art).

## Using the app

- First run starts with an empty local database. Open the Management tab,
  paste the sync token (the `SYNC_TOKEN` secret on the pkm-new Worker),
  tap Save token — the first sync pulls the full server snapshot.
- If items ever go missing after a sync, Management → **Re-download
  everything** pushes pending edits first, then pulls the full snapshot.
- Afterwards, edits push automatically a few seconds after you save
  (when online); otherwise sync runs on launch, on reconnect, and on
  Sync now.
- The token lives in secure storage (Keystore). Uninstalling wipes it;
  reinstalling means entering it again.

## Sandboxed / offline builds (historical note)

The environment this shell was first built in could not download SDK
packages or Gradle dependencies (egress proxy quirks), so the build was
done offline: a pre-seeded Maven repo, `gradle --offline` with
`gradle-offline.init.gradle`, and hand-fetched artifacts. That recipe is
preserved in `maven-seed/` and the init script, but it is a workaround
for that sandbox, not the normal path — prefer the networked build above.
