# Turning Second Brain into an Android APK

The app is now an installable PWA (web manifest + service worker + icons), which
is the prerequisite for packaging it as an Android app. There are two ways to get
an actual `.apk` file — neither needs you to write any Android code.

## Option A — PWABuilder (no tools, ~2 minutes) — recommended

PWABuilder is Microsoft's free tool that wraps a live PWA into a signed Android
package. Because Second Brain is already hosted on GitHub Pages, this just works.

1. Go to **https://www.pwabuilder.com**
2. Paste the live URL:
   **`https://prajith-max9.github.io/praze-website/brain.html`**
   then click **Start**.
3. It scores the PWA and shows the manifest + service worker it found.
4. Click **Package For Stores → Android**.
5. Leave the defaults (or set Package ID to something like `com.secondbrain.app`),
   click **Download**.
6. You get a zip containing:
   - `app-release-signed.apk` — sideload this straight onto a phone
     (Settings → allow installs from this source), **or**
   - `app-release.aab` + a signing key — upload to Google Play if you ever
     want it in the store.

The generated app is a Trusted Web Activity: a thin native shell that runs the
hosted app full-screen with no browser bar. Since all data lives in the phone's
browser storage, notes persist on the device exactly like the web version.

## Option B — Local build with Bubblewrap (needs Android SDK on your machine)

If you'd rather build it yourself and don't want to rely on PWABuilder:

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://prajith-max9.github.io/praze-website/manifest.webmanifest
bubblewrap build
```

Bubblewrap needs a local JDK and the Android SDK (it will offer to fetch them).
The output is the same kind of signed APK/AAB.

## Why not build it here?

The cloud environment this was developed in has Java and Gradle but no Android
SDK, and the network policy blocks Google's download hosts (`dl.google.com`),
which is the only place `aapt2`, `d8`/`r8`, and the platform `android.jar` are
distributed. Without those, no environment can assemble or sign a valid APK —
hence the hosted-URL packaging route above.

## Direct install without an APK

On an Android phone, opening the live URL in Chrome and choosing **Install app**
(or "Add to Home screen") installs the same standalone app instantly — home-screen
icon, full-screen, works offline. For most uses this is indistinguishable from a
sideloaded APK.
