# Tests

Playwright verification suites for Second Brain.

## Why this directory exists

The previous 32 suites lived in a session scratchpad outside the repo and were
lost when that session ended — `HANDOVER.md` §7 called that the single biggest
gap in the handover. Anything worth asserting belongs in here, in git.

## Setup

```bash
cd test
npm install
npx playwright install chromium
```

**npm lives here and nowhere else.** The app itself has no build step, no
bundler and no dependencies, and that stays true — nothing in this directory is
needed to run, serve or ship it. `node build-brain-app.js` at the repo root uses
only Node builtins.

## Running

```bash
node runall.js                 # every suite
node verify-dash-capture.js    # one suite
```

Each suite starts its own static server on its own port, so no server needs to
be running first and suites do not collide.

```bash
node screenshot.js dashboard dash    # look at it, light and dark
```

Screenshots are gitignored — they are for looking at, not for asserting on.

## geometry.js — proving a change did not reach the phone

```bash
node geometry.js snap before.txt                  # this checkout
# ...make the change...
node geometry.js snap after.txt
node geometry.js diff before.txt after.txt        # identical hash = layout untouched

node geometry.js snap old.txt --root ../worktree   # some other checkout
node geometry.js snap wide.txt --viewport 1440x900
```

Walks every **painted** element across all nine tabs at a fixed viewport and
hashes tag/id/class/rect. Two identical hashes mean the layout is byte-for-byte
the same, which is how a `min-width` rule gets shown not to touch the phone
rather than merely argued to.

It is a tool, not a suite — the name is deliberately not `verify-*.js` so
`runall.js` skips it, and it says nothing on its own. Snapshots are gitignored.

Three things it has learned:

- **Run it twice against unchanged code first.** A comparison is worthless until
  you know the tool is deterministic. That is why the store is seeded with a
  fixed clock: relative timestamps and streak counters both read the current
  time, and a snapshot that drifts proves nothing.
- **Painted is not the same as laid out.** A closed `<details>` keeps a layout
  box for its contents — Chromium uses `content-visibility` rather than
  `display: none` so find-in-page still reaches them — so
  `getBoundingClientRect` cheerfully reports 342×84 for text nobody can see.
  That inflated the counts in one comparison by exactly nine elements, one
  footer note per tab. `checkVisibility()` is the general fix and covers
  `visibility` and `display` at the same time.
- **Horizontal and vertical differences are not the same news.** A density pass
  is allowed to move things down; it is not allowed to change where content
  sits across the page. `diff` separates the two, which turns "the hash
  changed" into something you can act on.

This file has been written from scratch three times, because the first two
versions lived in a session scratchpad thrown away with the session — the same
way the original 32 suites were lost. It is the only thing that can
substantiate "the phone is untouched", and that claim has now been made in
three separate PRs. It lives in git now.

## Writing a suite

Name it `verify-*.js` and `runall.js` picks it up. Use `lib/harness.js` for the
server, assertions and store seeding.

Assertions report every failure in a run rather than dying on the first, so one
run tells you everything that broke.

### Traps that have bitten repeatedly

- **`page.goto(url + '#hash')` from the same page is a same-document navigation
  and does not re-run the app.** Seed storage, then `page.reload()`. The harness
  header says this too; it has caught out several test-writing passes.
- **Clicking a tab scrolls the non-sticky tab bar into view**, which scrolls the
  page to the top. Do not assert scroll position after a tab click — test scroll
  behaviour through the back gesture instead.
- **`window.__brainDebug.nodes` is a count, not an array.**
- **A spec-faithful mock is not proof the device behaves.** The dictation saga
  (§10) had a green suite while the real engine misbehaved in two distinct ways.
  Mocks here assert wiring, not engine behaviour — keep that claim narrow.

### Colours

Assert against the resolved CSS custom property, not a literal. The dark theme
flips `--ink` and darkens `--lime`, so a hardcoded rgb passes in one theme and
fails in the other — or worse, pins a value the rest of the app has moved off.

## Coverage

| Suite | Covers |
|---|---|
| `verify-dash-capture.js` | Dashboard capture box: layout order, the three options and their wiring to existing capture flows, the `+` button, phone-viewport geometry, dark theme tokens |
| `verify-polish.js` | Relative timestamps, clamped previews and their toggle, copy, active-tab feedback, destructive-action presentation, offline badge, filter/scroll restore — and an assertion that none of it wrote to the store |
| `verify-tap-targets.js` | Every control has a 44px **effective** tap area across all views |
| `verify-s1.js` | **Storage honesty.** Run after touching any save path. Fakes a full quota and checks every write path refuses to claim success, keeps what was typed, and leaves the stored payload byte-identical |
| `verify-back.js` | The back-button layer stack: each of the nine layers closes topmost-first, the spare history entry never leaks however deep or however repeated, closing by UI does not undo tab navigation, and normal hash routing and forward navigation still work |
| `verify-interactions.js` | The seams between features: IndexedDB unavailable vs. failing, importing a pre-migration export, a layer open when the page is killed, and dictation under a tracked layer |
| `verify-photos.js` | The `PHOTO_URL_RE` security boundary — a hostile `photo` value must never reach an `<img src>`, from localStorage **or** IndexedDB — plus compression to jpeg at 800px, the one-way migration into IndexedDB, and export round-tripping |
| `verify-graph-fit.js` | The graph frames itself to its canvas: sparse graphs (<5 notes) are left at 1x, larger ones fill their limiting axis without clipping or exceeding the zoom ceiling, the rAF loop still comes to rest, and pan/zoom/drag hand the camera to the user while double-click hands it back |

### Two things those suites learned the hard way

**Assert what is painted, not what is set.** `.note__more` sets `display`, which
beats the UA stylesheet's `[hidden] { display: none }` — so `el.hidden` was
`true` while the button was still on screen. A check reading the property passed;
the bug was visible in a screenshot. Prefer `offsetParent` and a real height.

**Measure tap targets by probing, not by rect.** `getBoundingClientRect` cannot
see an `::after` hit box, and more importantly cannot see a *neighbour* stealing
the point. Tag chips were reaching ~10px above their pills and swallowing taps
meant for "Show more". Only `elementFromPoint` finds that.

**Dictation** is the last of the lost suites with no replacement. It is the one
to be careful with: §10 of the handover records a green mock sitting alongside an
engine that misbehaved in two distinct ways on a real device, so a suite there
should claim wiring only, and say so.

### Measure position, not just count

`verify-back.js` learned this the hard way. Its leak assertions read
`history.length`, and a deliberately-leaking build **passed** — because after any
`back()` the cursor sits mid-stack, so `pushState` reuses a forward slot and the
length never moves. The assertion was measuring nothing.

The fix was a `toTip()` helper that forces a real hash navigation first, so
pushes actually extend the stack. If you assert on `history.length`, make sure
you know where the cursor is, and pair it with a behavioural check — walking
back twice catches a stranded entry that counting can miss.

`verify-interactions.js` then did the same thing in a different costume. Its
IndexedDB-interlock check measured the store immediately after boot — but a
broken interlock only strips photos on the *next* write, so a deliberately
broken build passed. Fixed by provoking an unrelated save and looking again.

**Both misses share a shape: the assertion ran before the damage could happen.**
When you assert that something was *not* destroyed, make sure you have actually
reached the moment it would have been.

### Trust an assertion only after you have seen it fail

`verify-s1.js` found a real bug — a delete whose write failed was silently
committed by the next successful save. Before the `rollback/*` checks were
believed, they were run against the pre-fix commit in a throwaway worktree and
confirmed to fail there.

That was worth doing: the *first* half of each check ("survives the failed delete
itself") passes either way, because disk was always correct at that moment. Only
the second half, after an unrelated successful write, actually catches it. A
plausible-looking assertion that cannot fail is worse than none — it reads as
coverage.

`verify-graph-fit.js` then paid for the habit a third time. Its coverage floor
started at 60%, and against the pre-camera build that assertion **passed** for
20 notes on the phone: a 340px-wide canvas and a ~212px cluster is 62% by
coincidence, not by framing. The one case a phone user would most notice was the
one being waved through. Raised to 75%, where the fitted build sits at 79–88%
and the old one at 33–62%, so all four cases now discriminate.
