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
| `verify-photos.js` | The `PHOTO_URL_RE` security boundary — a hostile `photo` value must never reach an `<img src>`, from localStorage **or** IndexedDB — plus compression to jpeg at 800px, the one-way migration into IndexedDB, and export round-tripping |

### Two things those suites learned the hard way

**Assert what is painted, not what is set.** `.note__more` sets `display`, which
beats the UA stylesheet's `[hidden] { display: none }` — so `el.hidden` was
`true` while the button was still on screen. A check reading the property passed;
the bug was visible in a screenshot. Prefer `offsetParent` and a real height.

**Measure tap targets by probing, not by rect.** `getBoundingClientRect` cannot
see an `::after` hit box, and more importantly cannot see a *neighbour* stealing
the point. Tag chips were reaching ~10px above their pills and swallowing taps
meant for "Show more". Only `elementFromPoint` finds that.

The back button and dictation still have **no coverage here**. Those suites
existed once and were lost. Treat this table as the real state, not the intended
one. Dictation is the one to be careful with: §10 of the handover records a green
mock sitting alongside an engine that misbehaved in two distinct ways on a real
device, so a suite there should claim wiring only.

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
