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
- **Android**: a Trusted Web Activity wrapping that exact URL, packaged via
  PWABuilder. See `BUILD-APK.md`. The phone is running the live site, not a
  separate build — so a deploy reaches the app.
- **Working branch**: `claude/second-brain-master-plan-hst2eu`
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
    photo,                 // diary only, compressed JPEG data URL — see §5
    createdAt, updatedAt
  }],
  goals: [{ id, title, target, progress, createdAt, completedAt }],
  todos: [{ id, text, done, dueAt, notified, createdAt, completedAt, updatedAt }]
}
```

`todos` was added **without a schema bump** — every read path defaults a missing
key to `[]`. Do the same for anything you add; a bump would strand old exports.

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
where available so EXIF orientation is applied.

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

There is **no test directory in the repo**. All 32 Playwright suites live in a
session scratchpad:

```
/tmp/claude-0/-home-user-praze-website/<session-id>/scratchpad/
```

**That directory is session-specific and will not exist for you.** This is the
single biggest gap in this handover. The suites cover a lot of hard-won
behaviour — storage-full, dictation, back button, photos, offline, icons. If
they are gone, they are gone.

**Recommendation: move them into the repo** (e.g. `test/`, with `runall.sh`) so
they survive. This was deliberately not done unilaterally because the repo has
never had a test directory and that is a structural change worth a decision.

How they work, if you still have them or rebuild them:

```bash
python3 -m http.server 8123     # must be running
node verify-back.js             # one suite
bash runall.sh                  # the 18 in the standard set
```

Chromium is at `/opt/pw-browsers/chromium`. Suites seed `localStorage`
directly, mock `api.anthropic.com` via `page.route`, and mock
`SpeechRecognition` and `navigator.vibrate` via `addInitScript`.

`runall.sh` runs 18 of the 32. The rest (`verify-s1.js` … `verify-s789.js`,
`verify-todos.js`, `verify-graph-settings.js`, `verify-dictation-repeat.js`,
`verify-s3-photos.js`, `verify-s4-taborder.js`, …) are run individually.
**`verify-s1.js` is the storage-honesty suite — run it after touching any save
path.**

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
4. Run the suites. Full set if the change is broad; at minimum the ones
   covering what you touched, plus `verify-s1.js` for save paths.
5. PR into `main`, merge.
6. GitHub Pages builds automatically — check the `pages build and deployment`
   workflow succeeded before telling anyone to test on a phone.
7. **Verifying a fix on the device**: the sandbox's egress policy blocks
   `prajith-max9.github.io`, so you cannot fetch the live site to confirm what
   is being served. The technique that worked was putting a visible build stamp
   in the UI, so the user's screenshot answers "is this current?" definitively.

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
