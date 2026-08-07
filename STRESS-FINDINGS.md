# Targeted stress findings — post photos-migration / back-button rewrite

A pass aimed specifically at the seams between new code (photos → IndexedDB, the
back-button layer stack, the dashboard rebuild, the radius token) and old code.
Not a re-run of S-1…S-9.

Seven areas probed. **Five clean, two real findings.** Neither is fixed here —
both are recorded for a decision, in the same way `S1-FINDINGS.md` was.

---

## Finding 1 — a photo added in one tab is deleted by an edit in another

**Severity: moderate. Silent data loss. Needs two tabs open at once.**

### What happens

1. Tabs A and B are both open on the app.
2. In A, attach a photo to a diary entry. It is written to IndexedDB; the note
   is saved to localStorage *without* it, which is the whole design.
3. B receives the `storage` event and merges. **The merge only covers the
   localStorage payload**, so B's in-memory copy of that note still has
   `photo: ''` — B does not learn the photo exists.
4. In B, edit that same entry's text and save. `persistPhoto` sees an empty
   `photo` on the note and calls `deletePhoto`.
5. **The photo is gone from IndexedDB.** A still shows it until it reloads.

Confirmed directly: photo present in IndexedDB after step 2, absent after step 4.

### Why it exists

`mergeStores` was written when the store was one blob. It merges `notes`,
`goals` and `todos` by id — and photos are no longer in any of them. The merge
is not wrong so much as *incomplete for a shape that did not exist when it was
written*.

`persistPhoto` then treats "this note has no photo in memory" as "this note
should have no photo in storage". That inference was safe when memory always
held the truth. It no longer is.

This is a new instance of the limitation §5 already records — *"cross-tab merge
is a union, not a CRDT"* — but it is not the same bug. The documented one
resurrects deleted notes. This one destroys a photo, and it is silent.

### Options

**A. Re-read photos from IndexedDB after a cross-tab merge.** In
`handleStorageEvent`, for any note whose in-memory `photo` is empty, look it up
in IndexedDB and reattach. Small, contained, and it fixes the display gap in
step 3 as well as the deletion in step 4.

**B. Make `persistPhoto` only delete on an explicit removal.** Pass an intent
flag from the edit path, so an empty `photo` that was never touched by the user
is left alone. Narrower, but it leaves B showing no photo until a reload.

**C. Both.** A fixes what B sees; B stops the destructive inference regardless
of how the empty value got there.

**Recommendation: C**, with A as the priority half if only one gets done. A is
maybe 15 lines in `handleStorageEvent`.

### Not tested for on purpose

`verify-interactions.js` deliberately does **not** pin this behaviour. A test
asserting what happens today would enshrine the bug. Add one with the fix.

---

## Finding 2 — `.graph-cold` missed the corner-radius sweep

**Severity: cosmetic. One line.**

`#graph-cold` is a bordered notice on the Graph tab, shown only when there are
too few notes to draw a useful graph. It is still square-cornered while every
surface around it is rounded.

It was missed for exactly the reason the empty-state was: it renders
conditionally, so the screenshot pass never saw it. A static sweep of
`brain.css` found it — 29 surfaces, 24 rounded, 9 documented exceptions, one
genuine omission.

**Fix:** add `.graph-cold` to the surfaces list in the radius section. It uses
the existing token; no new value, no decision.

Left undone only because the instruction for this pass was to document rather
than fix. It is a one-liner whenever you want it.

---

## Probed clean

**Photos + storage-full, in both directions.** IndexedDB unavailable →
`photosInIdb` stays false, photos keep being written inline, nothing is
discarded, the app stays usable. IndexedDB write fails while localStorage has
room → the note saves, the banner says specifically that the *photo* failed, and
the photo is dropped from memory so nothing phantom remains on screen. Both now
covered by `verify-interactions.js`.

**A photo write in flight when the page dies.** The IndexedDB transaction is
atomic — it either commits or aborts, so there is no torn state. The narrow
consequence is that a photo can be lost if the page is killed inside the
milliseconds between the note saving and the transaction committing. The note
text always survives. Not judged worth engineering around at this scale;
recorded so it is a known quantity rather than a surprise.

**Importing an old-format export into an IndexedDB store.** Photos arrive
inline, land in IndexedDB, are not left in localStorage, and render after a
reload. Covered.

**Back button across a process kill.** Nothing is stuck open on reopen, the
photo still renders, and back is not swallowed by a phantom guard entry —
history is per-session, so there is nothing stale to inherit. Covered.

**Back button under speed.** The one-entry invariant holds: worst growth over 20
fast open/close cycles is 1; rapid stacking of three layers costs 1; opening a
layer while another is mid-close costs 0 and leaves correct state.

Two `history.back()` calls in the *same synchronous task* do diverge — the
second outruns the guard being re-pushed, so it consumes a real entry and leaves
the layer beneath open. Measured across intervals:

| gap | correct? |
|---|---|
| 0 ms (same tick) | ✗ |
| 16 ms | ✓ |
| 32 / 64 / 120 ms | ✓ |

16 ms is under one frame. No input path — hardware button, gesture, or
synthetic event — delivers two back presses inside a single task. Recorded as a
boundary of the mechanism, not a defect, and deliberately not "fixed": guarding
against it would mean queueing pops, which is exactly the asynchronous handling
§5 says not to reintroduce.

**Dictation under a tracked layer.** Opening the palette over a live mic does
not disturb it (`starts: 1`, still live); closing by back neither restarts nor
kills it; leaving the diary *does* stop it; returning does not silently restart
it. Covered. The mock asserts wiring only — §10 is emphatic that a green mock
proved nothing about the real engine.

---

## Coverage added

`test/verify-interactions.js` — 24 assertions across the seams above.

Proven able to fail before being trusted, using the `verify-back.js` approach.
Four mutations:

| Mutation | Result |
|---|---|
| interlock left true when IndexedDB fails | ✅ caught (after strengthening — see below) |
| failed photo write no longer reconciled | ✅ caught |
| imported photos never moved to IndexedDB | ✅ caught |
| leaving the diary stops stopping the mic | ✅ caught |

The first slipped through initially. The interlock only bites on the *next*
write, and the test never performed one — so a build with a broken interlock
looked fine at the point of measurement. Fixed by provoking an unrelated save
and re-checking, then confirming the mutation fails.

That is the second time in two suites that a plausible-looking assertion turned
out to measure nothing until a mutation proved otherwise. It is the strongest
argument for keeping this discipline.
