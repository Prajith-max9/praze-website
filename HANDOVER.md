# Handover — Second Brain

Written for whoever picks this up next, human or AI. It assumes you know how to
code and nothing about this project. Read **Invariants** before you change
anything; most of it is knowledge that cost a real bug to learn.

---

## 1. What this is

A private, offline-first personal knowledge app: notes, a diary, saved video
clips, todos, goals, and a force-directed graph of how the notes connect. It
runs entirely in the browser. There is **no backend, no account, no sync** —
every byte lives in that browser's `localStorage`.

- **Repo**: `prajith-max9/praze-website`, default branch `main`
- **Live**: <https://prajith-max9.github.io/praze-website/brain.html>
  (GitHub Pages, served from `main` at the repo root — there is no `gh-pages`
  branch and no build workflow)
- **Android**: a Trusted Web Activity wrapping that exact URL. The phone is
  running the live site, not a separate build — so a deploy reaches the app.
  `BUILD-APK.md` describes the PWABuilder web route; **§11 describes the local
  Bubblewrap build**, which now works and is the reproducible one.
- **Working branch**: `claude/second-brain-master-plan-hst2eu` — its PR (#21)
  was **merged into `main` on 2026-08-05**, so per §8 start new work from `main`
  rather than stacking on merged history.
- `index.html` is an unrelated public landing page for the "PRAZE" brand. It
  shares `styles.css` with the app. Don't break it.

## 2. Running it

```bash
python3 -m http.server 8123
# http://localhost:8123/brain.html
```

No install, no build step, no dependencies. Vanilla ES5-flavoured JS in an
IIFE; no framework, no bundler, no package.json.

## 3. File map

| File | Lines | What |
|---|---|---|
| `brain.html` | 351 | All markup for every view. Views are `<section class="view">` toggled by `hidden`. |
| `brain.js` | 4681 | Everything: store, router, all views, all interactions. One IIFE. |
| `brain-ai.js` | 478 | `window.BrainAI` — offline TF-IDF similarity/search **and** the Claude API client. |
| `brain-graph.js` | 614 | `window.BrainGraph` — canvas force layout. `mount`/`destroy`/`setSettings`. |
| `brain.css` | 2518 | All app styles. Layered on `styles.css` tokens. |
| `brain-sw.js` | 95 | Service worker. Network-first, cache `praze-brain-v2`. |
| `build-brain-app.js` | 178 | Bundles everything into `brain-app.html`. |
| `brain-app.html` | ~341 KB | **Generated.** Single-file build, opens from `file://`. |
| `styles.css` | 375 | Shared tokens + landing page. Changes here hit `index.html` too. |

### The bundle is generated — always rebuild it

```bash
node build-brain-app.js
```

Run this after **any** edit to `brain.html`, `brain.js`, `brain-ai.js`,
`brain-graph.js`, `brain.css` or `styles.css`, and commit the result. A stale
`brain-app.html` is a silent lie. `git status` being clean after a rebuild is
the check that it matches.

## 4. Data model

One key holds everything: **`praze.brain.v1`**.

```js
{
  schemaVersion: 2,
  rev: 0,                  // bumped on every save; invalidates the TF-IDF cache
  notes: [{
    id, title, body, tags: [], pinned,
    kind: 'idea' | 'diary' | 'clip',
    url,                   // clips only
    photo,                 // diary only, compressed JPEG data URL — IN MEMORY
                           // ONLY. Persisted to IndexedDB, not to this key.
                           // See §5 and the note below.
    createdAt, updatedAt
  }],
  goals: [{ id, title, target, progress, createdAt, completedAt }],
  todos: [{ id, text, done, dueAt, notified, createdAt, completedAt, updatedAt }]
}
```

`todos` was added **without a schema bump** — every read path defaults a missing
key to `[]`. Do the same for anything you add; a bump would strand old exports.

### Photos live in IndexedDB, not in that key

A compressed 800px JPEG is ~70–200 KB as a base64 data URL. A few dozen fill a
5–10 MB localStorage quota on their own, which is what made the storage-full
path fire at all. They now live in **`praze.brain.photos`** (IndexedDB), object
store `photos`, keyed by note id.

Three things about that are worth knowing before you touch it:

- **In memory a note still carries `photo` as a data URL.** Nothing in the
  render path, `PHOTO_URL_RE`, `sanitizePhoto` or the compression pipeline
  changed. Only where it is persisted moved.
- **`photosInIdb` is an interlock, not a feature flag.** It stays false until
  photos are confirmed written to IndexedDB, and the store serializer only drops
  `photo` once it is true. A browser that blocks IndexedDB keeps photos inline
  exactly as before, rather than silently discarding them.
- **Exports still inline photos**, using a separate replacer from the store
  serializer. The export format is byte-identical to what it always was: an
  export written before this change still imports, and one written after it
  still opens in an older build. Don't "tidy" the two replacers into one.

Migration is on boot and one-way: inline photos are written to IndexedDB first,
and only then is localStorage rewritten without them. Photos whose note no
longer exists are garbage-collected at the same point.

### Other keys (UI state — never exported, never in the store)

| Key | Holds |
|---|---|
| `praze.brain.apikey` | Anthropic key. **Must never reach an export.** |
| `praze.brain.aimodel` | `fast` / `balanced` / `best` |
| `praze.brain.theme` | `light` / `dark` |
| `praze.brain.draft.v1` | Unsaved Ideas capture |
| `praze.brain.diarydraft.v1` | Unsaved diary entry |
| `praze.brain.graphsettings.v1` | Graph physics multipliers |
| `praze.brain.resurface.dismissed` | Dismissed dashboard suggestions |
| `praze.brain.notifyasked` | Notification permission asked once, ever |
| `praze.brain.onboarded` | First-run state |
| `praze.brain.v1.pre-migration` | One-time v1 safety copy |

## 5. Invariants — read before changing anything

Each of these exists because something broke.

**Storage honesty (the "S-1" rule).** `saveStore()` returns a boolean. Never
show a success banner, clear a draft, or reset a form without checking it.
localStorage is a few megabytes and it *does* fill up. `verify-s1.js` guards
this — if you touch a save path, re-run it.

**`showBanner` uses `textContent` deliberately.** Goal titles and note text are
interpolated into banner messages. Making it `innerHTML` for a flourish would be
an XSS hole. This is why a few emoji survive in banner strings.

**Every piece of user text goes through `escapeHtml`.** No raw user text in
`innerHTML`, ever. Model output too — it's untrusted.

**A write that fails must not leave memory disagreeing with disk.** The banner
half of S-1 is only half the rule. Deletes remove the item from `store` before
saving; if the save fails and the item is not put back, disk is still correct but
memory is not — and the *next* successful write persists memory, committing a
deletion the user was never told about and was never offered Undo for. All three
delete paths splice the item back on failure, and `handleDiarySubmit` pops its
un-saved note off for the same reason. Any new path that mutates `store` before
saving needs the same treatment. `verify-s1.js` `rollback/*` guards it.

**An empty `photo` is omitted from the serialized store** (`omitEmptyPhoto`
replacer). Writing `"photo":""` on every note made the first write after that
upgrade *larger* than what it replaced — which broke the guarantee that deleting
a note frees space on a full store. Keep new per-note fields out of the
serialized form when empty.

**Only `data:image/(jpeg|png|webp)` reaches an `<img src>`** (`PHOTO_URL_RE`). An
imported store could carry a remote URL there, turning "open the diary" into a
callout to someone else's server. SVG is refused — it's scriptable.

**Photos are compressed before storage**: canvas → max 800px longest side →
JPEG. A raw phone photo would eat the whole quota. `createImageBitmap` is used
where available so EXIF orientation is applied. They are persisted to IndexedDB
rather than to the main store — see §4.

**A photo that could not be written is dropped from memory too.** `persistPhoto`
runs after the note itself has saved; if the IndexedDB write fails it clears
`note.photo` and re-saves, so a note never holds a photo that storage does not.
That is the same rule as the delete rollback above, pointing the other way.

**Dictation: the engine misbehaves in two distinct ways.** Both are real,
confirmed from an on-device trace, and both are handled in `makeRecognizer`:
1. it emits the *same* segment as several separate final results;
2. it re-transcribes *cumulatively* — "hello", "hello mike", "hello mike
   testing" — so naive appending produces `hellohello mikehello mike testing`.
A final is dropped when identical with no interim between; a final that extends
the previous one within 2.5s on a word boundary **replaces** it. Do not "simplify"
this. `makeRecognizer` is shared by diary dictation and Brain Dump — changing it
changes both.

**Back button layering.** While anything dismissible is open, one spare history
entry is held. It is **never popped asynchronously** — an early version called
`history.back()` on close, which raced `setView`'s hash push and silently undid
tab navigation. `setView` reuses the entry via `location.replace` instead.

**The view fade is opacity-only, not translate.** `#synth-bar` is
`position: fixed` *inside* `#view-ideas`; a transform on `.view` would make it a
containing block and fling the bar across the screen for 180ms.

**Scroll restore must re-assert each frame** for a short window. A view's height
settles over several frames as fonts reflow text, *and* setting `location.hash`
makes the browser adjust scroll a frame or two later.

**Graph lifecycle**: `BrainGraph.destroy()` must be called when leaving `#graph`
or the rAF loop keeps running and eats battery. `window.__brainDebug.nodes` is a
**count, not an array** — this has caught out two test-writing passes.

**`prefers-reduced-motion` is a global `*` override** in `brain.css`. Any new
CSS transition or animation inherits it automatically. Don't add a per-rule one.

**Cross-tab merge is a union, not a CRDT.** It cannot distinguish "deleted over
there" from "created over here", so a note deleted in one tab can be resurrected
by another. Known and accepted; don't be surprised by it.

**Timeline's empty copy must point at Ideas.** `verify-timeline.js` asserts the
intent, not the string — the Timeline fills itself from elsewhere, so "go
capture something" is the useful prompt.

## 6. Feature map

| Tab | Hash | Where |
|---|---|---|
| HOME | `#dashboard` | `renderDashboard` / `renderDashboardCards` |
| ASK | `#ask` | `renderAsk`, `handleAsk` — local retrieval, then Claude |
| TODO | `#todos` | `renderTodos`, `handleTodoClick`, `scheduleTodoReminders` |
| IDEAS | `#ideas` | `renderIdeas`, `renderNoteCard`, capture form |
| DIARY | `#diary` | `renderDiary`, `renderDiaryEntry`, photos, dictation |
| CLIPS | `#clips` | `renderClips`, `renderClipCard` |
| GOALS | `#goals` | `renderGoals`, streaks, `celebrate()` confetti |
| GRAPH | `#graph` | `renderGraph` + `brain-graph.js` |
| TIMELINE | `#timeline` | `renderTimeline`, lazy-rendered |
| Settings | gear icon | `openSettings`, API key, model, theme |

Cross-cutting: `[[wiki-links]]`, `==highlights==` (diary read view only),
RELATED chips (TF-IDF, gated at 5+ non-clip notes), Brain Dump, Synthesize,
command palette (Ctrl/Cmd+K), export/import, undo-on-delete.

**AI is optional.** Without a key everything works except AI organize, AI
reflect, Ask answers, Synthesize, Digest and Brain Dump splitting. Models live
in `brain-ai.js`: `fast` = `claude-haiku-4-5`, `balanced` = `claude-sonnet-5`,
`best` = `claude-opus-4-8`. Calls go browser → Anthropic directly.

## 7. Testing — READ THIS

There is now a **`test/` directory in the repo** — see `test/README.md`.

```bash
cd test
npm install && npx playwright install chromium   # first time only
node runall.js                                   # every suite
node verify-dash-capture.js                      # one suite
```

Each suite starts its own static server, so nothing needs to be running first.
`npm` lives in `test/` and nowhere else: the app itself still has no build step
and no dependencies, and that must stay true.

**`verify-s1.js` is the storage-honesty suite — run it after touching any save
path.** It fakes a full quota by wrapping `Storage.prototype.setItem` before the
app loads and throwing a real `QuotaExceededError` for the store key alone;
drafts live under other keys and keep working, which is the whole point of the
rule. 44 assertions over capture, diary, clip, goal, todo, edit, delete, undo and
import, each checking that the storage-full error is shown, no success banner is,
what was typed is still on screen, and the stored payload is byte-for-byte
unchanged.

Rebuilding it found a real bug, since fixed: a delete whose write failed was
silently committed by the next successful save. The `rollback/*` assertions guard
it now, and were confirmed to fail against the pre-fix code before being trusted.
`S1-FINDINGS.md` has the reasoning and the options that were weighed.

**The earlier 32 suites are still gone.** They lived in a session scratchpad
(`/tmp/claude-0/…/scratchpad/`) that no longer exists, and covered a lot of
hard-won behaviour. Dictation, the back button, photos and offline still have
**no coverage**. Read the coverage table in `test/README.md` as the real state,
not the intended one.

The lost suites seeded `localStorage` directly, mocked `api.anthropic.com` via
`page.route`, and mocked `SpeechRecognition` and `navigator.vibrate` via
`addInitScript`. `test/lib/harness.js` re-establishes the first of those; the
rest are worth copying back as they are needed.

Two traps that have bitten repeatedly:
- `page.goto(url + '#hash')` from the same page is a *same-document* navigation
  and does **not** re-run the app. Call `page.reload()` after seeding storage.
- Clicking a tab makes Playwright scroll the (non-sticky) tab bar into view,
  which scrolls the page to the top. That is why scroll-preservation is tested
  via the back gesture, not tab clicks.

## 8. Workflow

1. Work on `claude/second-brain-master-plan-hst2eu`. If its PR is already
   merged, restart it from `main` rather than stacking on merged history.
2. Commit one logical change at a time.
3. `node build-brain-app.js` and commit the bundle.
4. `cd test && node runall.js`. If you touched something the suites do not
   cover — which today is most of the app (§7) — say so plainly rather than
   letting a green run imply more than it checked.
5. PR into `main`, merge.
6. GitHub Pages builds automatically — check the `pages build and deployment`
   workflow succeeded before telling anyone to test on a phone. With the `gh`
   CLI: `gh run list --limit 1 --json headSha,status,conclusion`, and confirm
   the `headSha` matches your commit rather than trusting the newest run.
7. **Verifying what is actually being served.** From a normal machine you can
   just fetch it, which is the fastest confirmation there is:
   `curl https://prajith-max9.github.io/praze-website/brain.js | grep …`.
   From the original cloud sandbox you could not — its egress policy blocked
   `prajith-max9.github.io` — and the technique that worked there was putting a
   visible build stamp in the UI so a screenshot answered "is this current?".

## 9. Open items

- **Sticky tab bar — a product decision, not made.** `#tabs` is
  `position: relative`, so reaching it means scrolling to the top; by the time
  a tab is tapped there is no offset left to preserve. Scroll restoration
  therefore works via the back gesture and programmatic navigation, and is a
  no-op for tab taps. Fixing that needs either continuous per-view scroll
  tracking (returns you to where you were *reading* despite deliberately
  scrolling up — arguably wrong) or a sticky tab bar (a layout change). **Ask
  before deciding.**
- **Unconfirmed on hardware**: haptics and the Android back gesture were
  verified in tests but not yet on a real phone.
- **Known cosmetic**: restarting dictation mid-thought can leave a double space
  at the seam, because continuation results carry a leading space. Not the
  reported bug; never fixed.
- **The undo toast is persistent, not a 5-second window.** Delete banners pass
  `persistent: true`. Briefs have described it as 5 seconds; it isn't.
- **The TWA is not Digital Asset Links verified, and structurally cannot be
  from its current URL.** `assetlinks.json` has never existed in this repo (checked
  across all branches), and `https://prajith-max9.github.io/.well-known/assetlinks.json`
  is a 404. So the APK shows a browser URL bar instead of running full-screen.
  This is a **hosting** problem, not a build or signing one — no amount of
  rebuilding or re-keying fixes it. Asset links must be served from the *origin
  root*, but the app lives on a GitHub Pages **project** path (`/praze-website/`),
  and only a repo literally named `prajith-max9.github.io` can serve that root.
  Fixing it means creating that repo, or moving to a custom domain. **Ask before
  deciding** — it is a hosting change, not a code change.
- **A website-independent (fully offline) APK was scoped but not built.**
  `brain-app.html` is genuinely self-contained — fonts are embedded as data URIs
  and the only outbound references are `api.anthropic.com` and YouTube thumbnail/
  embed URLs — so it drops straight into a WebView app serving assets over
  `WebViewAssetLoader`. The blocker worth discussing first: **the Web Speech API
  does not exist in Android WebView**, so diary dictation and Brain Dump splitting
  would be dead unless someone bridges the native `SpeechRecognizer` — and §5 is
  emphatic that `makeRecognizer` must not be casually reworked. Web Notifications
  (todo reminders) and `<input type=file>` photo capture also need explicit
  WebView plumbing. Note also that a WebView app has its **own** storage origin,
  so no existing data carries over; users would have to export/import.

## 10. History worth knowing

88 commits on `main`. The parts that will save you time:

- **The dictation saga took four rounds.** Round 1 fixed a re-tap replaying the
  transcript (a live-session `no-speech` error left the mic hot while the UI
  said idle). It still reproduced on-device. Round 2 shipped an **on-screen
  debug panel** — the phone has no devtools, so the raw engine events were
  rendered on screen and photographed. That trace produced rounds 3 and 4
  (duplicate finals, then cumulative re-transcription). The lesson: a
  spec-faithful mock passed every time while the real engine misbehaved.
  When device behaviour contradicts a green suite, instrument the device.
- **Several briefs described features as missing that already existed** — delete
  with undo on diary/clips, and most empty-state copy. Auditing first is worth
  the ten minutes.
- **The stress-test pass (S-1 … S-9)** found and fixed real data-loss bugs.
  `verify-s1.js` … `verify-s789.js` encode them. Don't regress them.

## 11. Building the APK locally

`BUILD-APK.md`'s "Why not build it here?" section is **no longer the whole
story**. It was true of the cloud environment this was developed in (no Android
SDK, `dl.google.com` blocked). On an ordinary machine with network access the
local Bubblewrap build works, and it is the reproducible route — PWABuilder's web
UI hands you a key and a zip you cannot regenerate.

Nothing here touches the web app. The APK is a thin shell around the **live**
URL, so shipping a code change still means deploying to Pages (§8), not
rebuilding the APK. Rebuild only when the app's *identity* changes: name, icons,
version, package ID.

### What you need

Git, Node, **JDK 17**, and the Android SDK (`platform-tools`, plus `build-tools`
and a `platforms` entry matching the `BUILD_TOOLS_VERSION` pinned by the
installed Bubblewrap — it was `36.1.0` / API 36 as of 2026-08-05; check, don't
assume). Then `npm install -g @bubblewrap/cli`. Android Studio is **not**
needed — a TWA has no native code.

### Three Windows traps, each of which cost a build

1. **Bubblewrap only looks for `sdkmanager` at the legacy `<sdk>\tools\bin\`
   path.** Modern SDKs put it in `cmdline-tools\latest\bin`. Copy that folder to
   `<sdk>\tools`. `sdkmanager` then warns about an "inconsistent location" —
   harmless. The misleading error if you skip this is *"the androidSdkPath isn't
   correct … must contain the folder `build`"*, which is not what it checks.
2. **Bubblewrap does not quote the `java.exe` path when it invokes `apksigner`.**
   A JDK under `C:\Program Files` therefore fails with `'C:\Program' is not
   recognized` — *after* Gradle has successfully built and aligned the APK, so it
   looks like a signing bug rather than a path bug. Point Bubblewrap's `jdkPath`
   at a copy of the JDK in a directory with **no spaces**.
3. **`bubblewrap update` prompts for a version name** and dies with
   `ERR_USE_AFTER_CLOSE` on a non-interactive stdin. Use
   `bubblewrap update --skipVersionUpgrade`.

Bubblewrap config lives in `~/.bubblewrap/config.json` (`jdkPath`,
`androidSdkPath`). Write it as UTF-8 **without a BOM** — Bubblewrap's JSON parse
fails on one.

### The build

Hand-writing `twa-manifest.json` and running `update` then `build` avoids
`bubblewrap init`'s long interactive prompt chain entirely:

```bash
bubblewrap update --skipVersionUpgrade   # generates the Gradle project
bubblewrap build --skipPwaValidation     # assembles + signs
```

Pass the keystore passwords as `BUBBLEWRAP_KEYSTORE_PASSWORD` and
`BUBBLEWRAP_KEY_PASSWORD` to keep it non-interactive. Output is
`app-release-signed.apk` (sideload) and `app-release-bundle.aab` (Play only —
a phone cannot install an `.aab`). Verify with
`apksigner verify --print-certs`; v1/v2/v3 schemes should all pass. The
`META-INF/... not protected by signature` warnings are normal for Gradle output.

Generate the Gradle project **outside this repo**. It has no `.gitignore` for
Android artifacts, and Gradle plus Windows `MAX_PATH` is a real failure mode —
keep the build directory short.

### Signing keys — the part that bites

An Android app can only be updated by an APK signed with the **same key**. Lose
the keystore and the app can never be updated; users must uninstall and
reinstall — and since every note lives in `localStorage`, *that wipes their
data*. Back the keystore up off-machine. Never commit it.

Two consequences worth knowing before you generate a fresh key:

- Because no `assetlinks.json` has ever pinned a fingerprint (§9), a new key
  breaks **no** existing verification. There is nothing to preserve there.
- A locally built APK will not replace a PWABuilder-installed one — different
  key *and* usually a different package ID, so it installs **alongside** it as a
  second app, with separate storage. Uninstall the old one for a clean swap.

As of 2026-08-05 this is set up on the maintainer's Windows PC with a helper
script that pins all of the above; the keystore and its password live outside
this repo. Machine-specific paths are deliberately not recorded here.
