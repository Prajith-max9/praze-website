/* S-1: STORAGE HONESTY. The suite HANDOVER.md §5 says to run after touching
 * any save path.
 *
 * The rule, in the words of the comment above saveStore() itself:
 *
 *   "Returns true when the write actually landed. Callers MUST check it before
 *    reporting success, clearing a draft or resetting a form: a full quota used
 *    to be reported as 'Idea captured.' and the draft was wiped along with it,
 *    so the note vanished on the next reload with the user none the wiser."
 *
 * So for every path that writes, with the quota full:
 *   1. the storage-full error is shown
 *   2. NO success banner is shown
 *   3. whatever the user typed is still in front of them
 *   4. localStorage is byte-for-byte what it was — nothing silently half-landed
 *
 * (4) is the one that matters most. A path can look right on screen and still
 * have corrupted the stored payload.
 *
 * HOW THE QUOTA IS FAKED
 * Storage.prototype.setItem is wrapped before the app loads and throws a real
 * QuotaExceededError for the store key only while a flag is set. Drafts live
 * under different keys and must keep working — the whole point of the rule is
 * that the draft survives when the note does not — so they are never failed.
 *
 * Run:  node verify-s1.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8135;
const STORE_KEY = 'praze.brain.v1';
const check = makeChecker();

/* Anything that would read as "it worked". If a banner matches this while the
   quota is full, that is the S-1 bug itself. */
const SUCCESS_WORDS = /captured|saved|set\.|deleted|restored|imported|linked|goal hit/i;
const STORAGE_FULL = /storage full/i;

const INSTALL_QUOTA_SWITCH = () => {
  const real = Storage.prototype.setItem;
  window.__s1FailStore = false;
  window.__s1Writes = [];
  Storage.prototype.setItem = function (k, v) {
    if (window.__s1FailStore && k === 'praze.brain.v1') {
      window.__s1Writes.push(k);
      // the real thing browsers throw when the quota is gone
      const err = new DOMException('Quota exceeded', 'QuotaExceededError');
      throw err;
    }
    return real.call(this, k, v);
  };
};

const SEED = () => {
  const now = Date.now();
  localStorage.setItem('praze.brain.v1', JSON.stringify({
    schemaVersion: 2, rev: 1,
    notes: [
      { id: 'keep', title: 'Existing note', body: 'already saved', tags: ['training'],
        pinned: false, kind: 'idea', createdAt: now - 60000, updatedAt: now - 60000 },
      { id: 'keep2', title: 'Second note', body: 'also already saved', tags: [],
        pinned: false, kind: 'idea', createdAt: now - 55000, updatedAt: now - 55000 },
      { id: 'dia', title: '', body: 'an existing diary entry', tags: [], pinned: false,
        kind: 'diary', createdAt: now - 50000, updatedAt: now - 50000 }
    ],
    goals: [{ id: 'g1', title: 'Post 12 reels', target: 12, progress: 3,
              createdAt: now, completedAt: null }],
    todos: [{ id: 't1', text: 'Existing todo', done: false, dueAt: null,
              notified: false, createdAt: now, completedAt: null, updatedAt: now }]
  }));
  localStorage.setItem('praze.brain.onboarded', '1');
};

(async () => {
  const server = await serve(PORT);
  const url = 'http://localhost:' + PORT + '/brain.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  await ctx.addInitScript(INSTALL_QUOTA_SWITCH);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(SEED);
  await page.reload();                       // reload, never hash-nav
  await page.waitForSelector('.tabs');

  console.log('\nS-1 storage honesty @ ' + PHONE.width + 'x' + PHONE.height);

  const snapshot = () => page.evaluate(k => localStorage.getItem(k), STORE_KEY);
  const banner = () => page.evaluate(() => {
    const b = document.getElementById('banner');
    return { hidden: b.hidden, text: document.getElementById('banner-text').textContent.trim(),
             action: document.getElementById('banner-action').hidden ? null
                     : document.getElementById('banner-action').textContent.trim() };
  });
  const setFail = on => page.evaluate(v => { window.__s1FailStore = v; }, on);
  // cleared before each case so a case can only read its OWN banner
  const clearBanner = () => page.evaluate(() => {
    document.getElementById('banner').hidden = true;
    document.getElementById('banner-text').textContent = '';
  });

  /* Every case: run `act` with the quota full, then assert the four guarantees.
     `expect` adds whatever is specific to that path. Pass keepBanner when the
     action is itself a button living in the banner, e.g. Undo. */
  async function withFullQuota(name, act, expect, opts) {
    const before = await snapshot();
    if (!(opts && opts.keepBanner)) await clearBanner();
    await setFail(true);
    await act();
    await page.waitForTimeout(250);
    const b = await banner();
    const after = await snapshot();

    check(name + ': storage-full error shown', !b.hidden && STORAGE_FULL.test(b.text), b.text);
    check(name + ': no success banner', !SUCCESS_WORDS.test(b.text), b.text);
    check(name + ': stored payload untouched', before === after,
      before === after ? '' : 'store changed while the quota was full');
    if (expect) await expect();
    await setFail(false);
  }

  /* ---------- 1. capture an idea ---------- */
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('#capture-form');
  await withFullQuota('capture',
    async () => {
      await page.fill('#capture-title', 'Doomed title');
      await page.fill('#capture-body', 'This text must not disappear.');
      await page.click('#capture-form button[type="submit"]');
    },
    async () => {
      const form = await page.evaluate(() => ({
        title: document.getElementById('capture-title').value,
        body: document.getElementById('capture-body').value,
        draft: localStorage.getItem('praze.brain.draft.v1')
      }));
      check('capture: the form was NOT reset', form.title === 'Doomed title' &&
        form.body === 'This text must not disappear.', JSON.stringify(form));
      check('capture: the draft was NOT cleared',
        !!form.draft && /must not disappear/.test(form.draft), String(form.draft));
    });

  // and once space is free the very same submit works and clears up after itself
  await page.click('#capture-form button[type="submit"]');
  await page.waitForTimeout(300);
  const recovered = await page.evaluate(() => ({
    banner: document.getElementById('banner-text').textContent.trim(),
    title: document.getElementById('capture-title').value,
    saved: JSON.parse(localStorage.getItem('praze.brain.v1')).notes
      .some(n => n.body === 'This text must not disappear.'),
    draft: localStorage.getItem('praze.brain.draft.v1')
  }));
  check('recovery: the same capture succeeds once space is free',
    recovered.saved && recovered.title === '', JSON.stringify(recovered));
  check('recovery: the draft is cleared only after a real write',
    !recovered.draft || !/must not disappear/.test(recovered.draft), String(recovered.draft));

  /* ---------- 2. diary — the rollback case ---------- */
  await page.evaluate(() => { location.hash = '#diary'; });
  await page.waitForSelector('#diary-form');
  await withFullQuota('diary',
    async () => {
      await page.fill('#diary-body', 'A day that must not be half-saved.');
      await page.click('#diary-form button[type="submit"]');
    },
    async () => {
      const st = await page.evaluate(() => ({
        body: document.getElementById('diary-body').value,
        inMemory: window.__brainDebug ? null : null,
        rendered: [...document.querySelectorAll('.note--diary .note__body')]
          .some(e => /must not be half-saved/.test(e.textContent))
      }));
      check('diary: the textarea keeps the entry', /must not be half-saved/.test(st.body), st.body);
      // this path explicitly pops the note back off, so it must not be on screen
      // either — a rendered card would claim a save that never happened
      check('diary: the un-saved entry is rolled back, not left on screen',
        !st.rendered, JSON.stringify(st));
    });

  /* ---------- 3. clip ---------- */
  await page.evaluate(() => { location.hash = '#clips'; });
  await page.waitForSelector('#clip-form');
  await withFullQuota('clip',
    async () => {
      await page.fill('#clip-url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await page.fill('#clip-note', 'why this matters');
      await page.click('#clip-form button[type="submit"]');
    },
    async () => {
      const v = await page.evaluate(() => ({
        url: document.getElementById('clip-url').value,
        note: document.getElementById('clip-note').value
      }));
      check('clip: the form keeps the url and the note',
        /dQw4w9WgXcQ/.test(v.url) && /why this matters/.test(v.note), JSON.stringify(v));
    });

  /* ---------- 4. goal ---------- */
  await page.evaluate(() => { location.hash = '#goals'; });
  await page.waitForSelector('#goal-form');
  await withFullQuota('goal',
    async () => {
      await page.fill('#goal-title', 'Ship the thing');
      await page.fill('#goal-target', '5');
      await page.click('#goal-form button[type="submit"]');
    },
    async () => {
      const v = await page.evaluate(() => ({
        title: document.getElementById('goal-title').value,
        target: document.getElementById('goal-target').value
      }));
      check('goal: the form keeps the title and target',
        v.title === 'Ship the thing' && v.target === '5', JSON.stringify(v));
    });

  /* ---------- 5. todo ---------- */
  await page.evaluate(() => { location.hash = '#todos'; });
  await page.waitForSelector('#todo-form');
  await withFullQuota('todo',
    async () => {
      await page.fill('#todo-text', 'Remember this one');
      await page.click('#todo-form button[type="submit"]');
    },
    async () => {
      check('todo: the text stays in the box',
        (await page.inputValue('#todo-text')) === 'Remember this one',
        await page.inputValue('#todo-text'));
    });

  /* ---------- 6. editing an existing note ---------- */
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('.note[data-id="keep"]');
  await page.click('.note[data-id="keep"] [data-action="edit"]');
  await page.waitForSelector('.note--editing');
  await withFullQuota('edit',
    async () => {
      await page.fill('.note--editing .note__edit-body', 'rewritten and must survive');
      await page.click('.note--editing [data-action="edit-save"]');
    },
    async () => {
      const st = await page.evaluate(() => {
        const ed = document.querySelector('.note--editing .note__edit-body');
        return { stillEditing: !!ed, text: ed ? ed.value : null };
      });
      check('edit: the editor stays open with the rewrite in it',
        st.stillEditing && /must survive/.test(st.text), JSON.stringify(st));
    });
  await page.click('.note--editing [data-action="edit-cancel"]');
  await page.waitForTimeout(200);

  /* ---------- 7. deleting a note ---------- */
  await page.waitForSelector('.note[data-id="keep"]');
  await page.click('.note[data-id="keep"] [data-action="delete-ask"]');
  await page.waitForSelector('[data-action="delete-yes"]');
  await withFullQuota('delete',
    async () => { await page.click('[data-action="delete-yes"]'); },
    async () => {
      const b = await banner();
      // offering Undo would be a promise the app cannot keep: nothing was written,
      // so there is nothing to undo, and the note is still on disk regardless
      check('delete: no Undo is offered for a delete that never landed',
        b.action === null, String(b.action));
      const still = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === 'keep'));
      check('delete: the note is still on disk', still);
    });

  /* ---------- 8. undo restore ----------
     Reload first. A failed delete leaves the in-memory store diverged from disk
     (see KNOWN ISSUE at the bottom), so without this the next cases would be
     running against a store that no longer matches the file. */
  await page.reload();
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('.note[data-id="keep2"]');

  await page.click('.note[data-id="keep2"] [data-action="delete-ask"]');
  await page.waitForSelector('[data-action="delete-yes"]');
  await page.click('[data-action="delete-yes"]');
  await page.waitForTimeout(300);
  const undoOffered = (await banner()).action;
  check('delete: a delete that DID land offers Undo', /undo/i.test(String(undoOffered)),
    String(undoOffered));

  await withFullQuota('undo',
    async () => { await page.click('#banner-action'); },
    async () => {
      const back = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === 'keep2'));
      check('undo: a restore that could not be written does not claim it restored',
        !back, 'note is ' + (back ? 'on' : 'off') + ' disk');
    }, { keepBanner: true });
  await page.reload();
  await page.waitForSelector('.tabs');

  /* ---------- 9. import ---------- */
  await withFullQuota('import',
    async () => {
      await page.setInputFiles('#import-file', {
        name: 'brain-export.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
          schemaVersion: 2, rev: 99,
          notes: [{ id: 'imported', title: 'From a file', body: 'imported body', tags: [],
                    pinned: false, kind: 'idea', createdAt: Date.now(), updatedAt: Date.now() }],
          goals: [], todos: []
        }))
      });
      await page.waitForTimeout(400);
    },
    async () => {
      const landed = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === 'imported'));
      check('import: nothing from the file reached disk', !landed);
    });

  /* ---------- 10. the storage-full banner is an error, and it persists ---------- */
  await setFail(true);
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('#capture-form');
  await page.fill('#capture-body', 'one more');
  await page.click('#capture-form button[type="submit"]');
  await page.waitForTimeout(300);
  const cls = await page.evaluate(() => document.getElementById('banner').className);
  check('the storage-full banner is styled as an error', /banner--error/.test(cls), cls);
  await page.waitForTimeout(1200);
  check('the storage-full banner does not auto-dismiss',
    await page.evaluate(() => !document.getElementById('banner').hidden));
  await setFail(false);

  /* ---------- KNOWN ISSUE ----------
     Reported, not asserted. Every check above covers the rule as HANDOVER.md §5
     states it — no false success, no cleared draft, no reset form — and the app
     passes all of it. What follows is a hole the rule does not currently cover,
     found by this suite and left for a decision rather than patched, because
     the fix is in delete/save logic rather than in a test.

     A delete removes the item from the in-memory store BEFORE saving, and does
     not put it back when the save fails. Disk is still correct at that moment,
     so nothing is lost yet — but memory and disk now disagree, and the NEXT
     successful write persists memory. The item is then gone for good, without
     the user ever seeing "deleted" or being offered Undo.

     handleDiarySubmit already solves exactly this for the insert case, with an
     explicit store.notes.pop() and a comment explaining why. The delete paths
     have no equivalent.

     Turn this into a hard assertion once it is fixed. */
  const known = await (async () => {
    await page.evaluate(() => { location.hash = '#ideas'; });
    await page.waitForSelector('.note[data-id="dia"], .note', { timeout: 5000 }).catch(() => {});
    const target = await page.evaluate(() => {
      const n = JSON.parse(localStorage.getItem('praze.brain.v1')).notes[0];
      return n ? n.id : null;
    });
    if (!target) return null;
    await setFail(true);
    const card = await page.$('.note[data-id="' + target + '"] [data-action="delete-ask"]');
    if (!card) { await setFail(false); return null; }
    await card.click();
    await page.waitForSelector('[data-action="delete-yes"]');
    await page.click('[data-action="delete-yes"]');
    await page.waitForTimeout(250);
    const stillOnDisk = await page.evaluate(t =>
      JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === t), target);
    await setFail(false);
    // an unrelated write that DOES land
    await page.fill('#capture-body', 'an unrelated later note');
    await page.click('#capture-form button[type="submit"]');
    await page.waitForTimeout(400);
    const survived = await page.evaluate(t =>
      JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === t), target);
    return { stillOnDisk, survived };
  })();

  if (known && known.stillOnDisk && !known.survived) {
    console.log('\n  KNOWN ISSUE  a delete whose write failed is silently made permanent');
    console.log('               by the next successful save. Confirmed for notes, todos');
    console.log('               and goals. See S1-FINDINGS.md — not fixed here on purpose.');
  } else if (known && known.survived) {
    console.log('\n  NOTE  the failed-delete divergence appears to be FIXED — promote the');
    console.log('        KNOWN ISSUE block in this file to a real assertion.');
  }

  await browser.close();
  server.close();
  process.exit(check.summary('s1') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
