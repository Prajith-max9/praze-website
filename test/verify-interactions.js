/* Cross-feature interactions introduced by the photos→IndexedDB move and the
 * back-button layer stack. Each suite before this one covers a feature; this
 * one covers the seams between them, which is where the new code can meet the
 * old code badly.
 *
 * Everything here probed clean before being written down — nothing in this file
 * is a workaround for a known bug. The one real finding from the same pass, the
 * cross-tab photo deletion, is deliberately NOT pinned here: see
 * STRESS-FINDINGS.md. Writing a test that asserts current behaviour would
 * enshrine it.
 *
 * Run:  node verify-interactions.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8138;
const check = makeChecker();

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKD' +
  'BQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxE' +
  'B/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1' +
  'FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc' +
  '3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo' +
  '6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAE' +
  'CAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVl' +
  'dYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1' +
  'dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

const SEED = (photo) => {
  const now = Date.now();
  localStorage.setItem('praze.brain.v1', JSON.stringify({
    schemaVersion: 2, rev: 1,
    notes: [
      { id: 'n1', title: 'One', body: 'a', tags: [], pinned: false, kind: 'idea',
        createdAt: now - 2000, updatedAt: now - 2000 },
      { id: 'd1', title: '', body: 'a day', tags: [], pinned: false, kind: 'diary',
        photo: photo, createdAt: now, updatedAt: now }
    ],
    goals: [], todos: []
  }));
  localStorage.setItem('praze.brain.onboarded', '1');
};

const idbHas = (id) => new Promise((resolve) => {
  const r = indexedDB.open('praze.brain.photos', 1);
  r.onsuccess = () => {
    const tx = r.result.transaction('photos', 'readonly');
    const g = tx.objectStore('photos').get(id);
    g.onsuccess = () => resolve(!!g.result);
    g.onerror = () => resolve(false);
  };
  r.onerror = () => resolve(false);
});

(async () => {
  const server = await serve(PORT);
  const url = 'http://localhost:' + PORT + '/brain.html';
  const browser = await chromium.launch();

  console.log('\nCross-feature interactions @ ' + PHONE.width + 'x' + PHONE.height);

  /* ---------- 1. IndexedDB unavailable: the interlock must hold ----------
     photosInIdb stays false, so the serializer keeps writing photos inline and
     nothing is discarded. This is the case that turns a storage upgrade into
     data loss if it is got wrong. */
  {
    const ctx = await browser.newContext({ viewport: PHONE });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.evaluate(SEED, JPEG);
    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('.note--diary');
    await p.waitForTimeout(900);
    check('no-idb: the photo still renders',
      await p.evaluate(() => !!document.querySelector('.note--diary img')));
    check('no-idb: the photo is kept inline rather than discarded',
      await p.evaluate(() => (localStorage.getItem('praze.brain.v1') || '').includes('base64')));
    check('no-idb: the app is still usable',
      await p.evaluate(() => !!document.getElementById('diary-form')));

    /* The interlock only bites on the NEXT write. If photosInIdb were wrongly
       left true, the store would still look right at this point and only lose
       the photo when something else saved — so provoke a save and look again.
       A mutation that broke the interlock passed this section until this was
       added. */
    await p.evaluate(() => { location.hash = '#ideas'; });
    await p.waitForSelector('#capture-form');
    await p.fill('#capture-body', 'an unrelated note that triggers a save');
    await p.click('#capture-form button[type="submit"]');
    await p.waitForTimeout(600);
    check('no-idb: an unrelated save does not strip the inline photo',
      await p.evaluate(() => (localStorage.getItem('praze.brain.v1') || '').includes('base64')));

    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('.note--diary');
    await p.waitForTimeout(700);
    check('no-idb: the photo survives a save and a reload',
      await p.evaluate(() => !!document.querySelector('.note--diary img')));
    await ctx.close();
  }

  /* ---------- 2. IndexedDB write fails while localStorage has room ----------
     The reverse of the S-1 case. The note lands; the photo does not; the app
     must say so and must not leave a photo on screen that storage has not got. */
  {
    const ctx = await browser.newContext({ viewport: PHONE });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.evaluate(SEED, '');
    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('#diary-form');
    await p.waitForTimeout(800);              // let boot migration settle first
    await p.evaluate(() => {
      const real = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (name, mode) {
        const tx = real.call(this, name, mode);
        if (mode === 'readwrite') setTimeout(() => { try { tx.abort(); } catch (e) {} }, 0);
        return tx;
      };
    });
    const png = await p.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      c.getContext('2d').fillRect(0, 0, 40, 40);
      return c.toDataURL('image/png').split(',')[1];
    });
    await p.fill('#diary-body', 'entry whose photo write fails');
    await p.setInputFiles('#diary-photo-file', {
      name: 'x.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')
    });
    await p.waitForSelector('#diary-photo-preview img');
    await p.click('#diary-form button[type="submit"]');
    await p.waitForTimeout(1000);

    check('idb-write-fail: the entry itself still saved', await p.evaluate(() =>
      JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => /photo write fails/.test(n.body))));
    check('idb-write-fail: the app says the photo specifically failed',
      /photo could not be stored/i.test(await p.evaluate(() =>
        document.getElementById('banner-text').textContent)),
      await p.evaluate(() => document.getElementById('banner-text').textContent.trim()));
    check('idb-write-fail: no phantom photo is left on screen',
      await p.evaluate(() => !document.querySelector('.note--diary img')));
    await ctx.close();
  }

  /* ---------- 3. importing an old-format export into an IndexedDB store ------
     An export written before the migration carries photos inline. Importing it
     into a store that has already moved must land them in IndexedDB, not leave
     them in localStorage and not drop them. */
  {
    const ctx = await browser.newContext({ viewport: PHONE });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.evaluate(SEED, '');
    await p.reload();
    await p.evaluate(() => { location.hash = '#ideas'; });
    await p.waitForSelector('.tabs');
    await p.waitForTimeout(900);              // photosInIdb now active

    await p.setInputFiles('#import-file', {
      name: 'old.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        schemaVersion: 2, rev: 5,
        notes: [{ id: 'imported-1', title: '', body: 'from an old export', tags: [],
                  pinned: false, kind: 'diary', photo: JPEG,
                  createdAt: Date.now(), updatedAt: Date.now() }],
        goals: [], todos: []
      }))
    });
    await p.waitForTimeout(1300);
    check('import: the note arrived', await p.evaluate(() =>
      JSON.parse(localStorage.getItem('praze.brain.v1')).notes.some(n => n.id === 'imported-1')));
    check('import: its photo went into IndexedDB',
      await p.evaluate(idbHas, 'imported-1'));
    check('import: nothing was left inline in localStorage', await p.evaluate(() =>
      !(localStorage.getItem('praze.brain.v1') || '').includes('base64')));
    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('.note--diary');
    await p.waitForTimeout(900);
    check('import: the imported photo renders after a reload', await p.evaluate(() =>
      [...document.querySelectorAll('.note--diary img')].length > 0));
    await ctx.close();
  }

  /* ---------- 4. a layer open when the page dies ----------
     History is per-session, so a reopened app must not believe it is still
     holding a guard entry for a layer that no longer exists. */
  {
    const ctx = await browser.newContext({ viewport: PHONE });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.evaluate(SEED, JPEG);
    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('.note--diary');
    await p.waitForTimeout(900);
    await p.click('[data-action="photo-open"]');
    await p.waitForTimeout(300);
    check('kill: the photo viewer was open before the kill',
      await p.evaluate(() => !document.getElementById('photo-view').hidden));
    await p.close();                          // hard kill: no close handler runs

    const p2 = await ctx.newPage();
    await p2.goto(url);
    await p2.evaluate(() => { location.hash = '#diary'; });
    await p2.waitForSelector('.note--diary');
    await p2.waitForTimeout(900);
    check('kill: nothing is stuck open after reopening', await p2.evaluate(() =>
      document.getElementById('photo-view').hidden &&
      document.getElementById('palette').hidden &&
      document.getElementById('settings-panel').hidden));
    check('kill: the photo still renders after reopening',
      await p2.evaluate(() => !!document.querySelector('.note--diary img')));
    const before = await p2.evaluate(() => location.hash);
    await p2.evaluate(() => history.back());
    await p2.waitForTimeout(400);
    check('kill: back is not swallowed by a phantom guard entry',
      (await p2.evaluate(() => location.hash)) !== before,
      before + ' -> ' + (await p2.evaluate(() => location.hash)));
    await ctx.close();
  }

  /* ---------- 5. dictation under a tracked layer ----------
     Opening the palette over a live mic must not disturb it, and leaving the
     diary must still stop it — §5 is explicit that a tab switch never leaves
     the mic hot. Wiring only: the mock says nothing about the real engine. */
  {
    const ctx = await browser.newContext({ viewport: PHONE });
    await ctx.addInitScript(() => {
      window.__mic = { starts: 0, stops: 0, live: false };
      window.SpeechRecognition = function () {
        const self = this;
        this.start = function () { window.__mic.starts++; window.__mic.live = true; };
        this.stop = function () { window.__mic.stops++; window.__mic.live = false;
          if (self.onend) self.onend(new Event('end')); };
        this.abort = function () { window.__mic.live = false; };
        this.addEventListener = function () {};
      };
    });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.evaluate(SEED, JPEG);
    await p.reload();
    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForSelector('#diary-form');
    await p.waitForTimeout(600);

    const started = await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /dictate/i.test(x.textContent));
      if (!b || b.hidden) return false;
      b.click();
      return true;
    });
    check('dictation: it started', started);
    check('dictation: the mic is live', await p.evaluate(() => window.__mic.live));

    await p.keyboard.press('Control+k');
    await p.waitForTimeout(300);
    check('dictation: the palette opened over it',
      await p.evaluate(() => !document.getElementById('palette').hidden));
    check('dictation: opening a layer does not disturb the mic',
      await p.evaluate(() => window.__mic.live && window.__mic.starts === 1));

    await p.evaluate(() => history.back());
    await p.waitForTimeout(400);
    check('dictation: back closed the palette',
      await p.evaluate(() => document.getElementById('palette').hidden));
    check('dictation: closing the layer did not restart or kill the mic',
      await p.evaluate(() => window.__mic.live && window.__mic.starts === 1),
      JSON.stringify(await p.evaluate(() => window.__mic)));

    await p.evaluate(() => { location.hash = '#ideas'; });
    await p.waitForTimeout(600);
    check('dictation: leaving the diary DOES stop the mic',
      await p.evaluate(() => !window.__mic.live && window.__mic.stops >= 1),
      JSON.stringify(await p.evaluate(() => window.__mic)));

    await p.evaluate(() => { location.hash = '#diary'; });
    await p.waitForTimeout(500);
    check('dictation: coming back does not silently restart it',
      await p.evaluate(() => !window.__mic.live && window.__mic.starts === 1),
      JSON.stringify(await p.evaluate(() => window.__mic)));
    await ctx.close();
  }

  await browser.close();
  server.close();
  process.exit(check.summary('interactions') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
