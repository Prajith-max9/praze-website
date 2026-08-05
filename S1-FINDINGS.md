# S-1 findings

Written while rebuilding `test/verify-s1.js`. **Nothing in the app was changed.**
The suite is green; this is a hole the S-1 rule does not currently cover, left
for a decision.

## The good news first

The documented rule holds everywhere it is documented to hold. `saveStore()`
returns a boolean, and with a full quota every path that writes:

- shows the storage-full error, styled as an error, and does not auto-dismiss it
- shows **no** success banner
- leaves whatever the user typed in front of them — form, draft and staged photo
- leaves the stored payload byte-for-byte unchanged

44 assertions across capture, diary, clip, goal, todo, edit, delete, undo and
import. All pass. The diary path is the best-behaved of the lot: it explicitly
pops the un-saved note back off the in-memory store, with a comment saying why.

## The hole

**A delete whose write failed is silently made permanent by the next successful
save.**

Delete removes the item from the in-memory store *before* saving, and does not
put it back when the save fails:

```js
case 'delete-yes':
  var noteIdx = store.notes.indexOf(note);
  store.notes = store.notes.filter(function (n) { return n.id !== note.id; });
  state.confirmingDeleteId = null;
  var noteGone = saveStore();          // <- fails
  render();                            // <- card disappears anyway
  if (noteGone) showBanner('Note deleted.', ...);   // correctly suppressed
```

At that moment disk is still correct, so nothing is lost *yet*. But memory and
disk now disagree, and every later `saveStore()` writes memory. The first one
that succeeds makes the deletion permanent.

### Reproduction

1. Fill the quota. Delete a note.
2. "Storage full" appears. No "Note deleted.", no Undo — both correctly withheld.
3. The card disappears from the screen anyway. The note is still on disk.
4. Free some space. Capture anything at all — that write succeeds.
5. The note deleted in step 1 is now gone from disk, permanently.

Verified end to end: the note is present on disk after step 3 and absent after
step 4, and stays absent across a reload.

### Scope

| Path | Effect of a failed write |
|---|---|
| Note delete | **Permanent loss** on the next successful save |
| Todo delete | **Permanent loss** on the next successful save |
| Goal delete | **Permanent loss** on the next successful save |
| Pin toggle | Pin state persisted later; harmless |
| `apply-tag` | Tag persisted later; harmless |
| Todo toggle / due | State persisted later; harmless |
| Edit save | Edited text persisted later; arguably desirable |

All of them share one mechanism: mutate memory, then save, and never reconcile
if the save fails. Only the three deletes destroy data.

### Why it is worse than the bug S-1 originally fixed

The original S-1 bug was loud once you noticed it — a note you had just written
was gone after a reload. This one is silent and delayed. The user is told
storage is full, which is true; they are not told a delete they did not see
confirmed is now queued to happen. They fix the storage problem, carry on, and
the note disappears later with nothing on screen connecting the two events.

Undo is correctly withheld — which means the one affordance that could have
saved the note is deliberately unavailable.

## Options

I have **not** picked one; this is delete/save logic and your call.

**A. Roll back on failure** — mirror what the diary path already does: keep the
removed item and its index, and splice it back if `saveStore()` returns false.
Smallest change, consistent with an existing solved case in the same file,
and makes the screen honest immediately. Roughly the same few lines in each of
the three delete handlers.

**B. Save first, mutate after** — build the prospective next state, write it,
and only apply it to `store` on success. Cleaner in principle and fixes the
whole class rather than three instances, but it is a change to how every write
in the app is shaped. Much bigger blast radius.

**C. Reload from disk on any failed write** — treat a failed save as "memory is
untrustworthy" and re-read. Simple and total, but it would also throw away
unrelated in-memory state the user may care about, including anything typed but
not yet saved. I would not do this.

**My recommendation: A.** It is contained, it matches a pattern the codebase has
already chosen once for exactly this problem, and it is easy to write an
assertion for. B is the better end state if you ever restructure writes, but it
is not a polish-pass change.

Whichever you pick, `test/verify-s1.js` has a `KNOWN ISSUE` block at the bottom
that currently *reports* this. Once it is fixed, promote it to a real assertion —
it already detects the fixed state and will say so.

## What I deliberately did not do

- Did not change any app logic. The instruction was to flag a real bug rather
  than fix it, and this is squarely one.
- Did not make the suite fail. A red build with no accompanying fix would just
  be noise; the finding is printed on every run instead, and linked here.
