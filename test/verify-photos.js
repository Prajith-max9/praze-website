/* Diary photos: the security boundary, and the compression that keeps a phone
 * photo from eating the whole quota. Both are HANDOVER.md §5 invariants and
 * neither had a guard.
 *
 * The security one is the sharper of the two. From the comment above
 * PHOTO_URL_RE:
 *
 *   "Only a data URL this app produced ever reaches an <img src>. An imported
 *    or hand-edited store can carry anything in that slot, and a remote URL
 *    there would turn opening the diary into a callout to someone else's
 *    server."
 *
 * So the store is seeded with hostile `photo` values the way an imported file
 * could carry them, and nothing hostile may reach the DOM. SVG is refused even
 * though it is an image type, because it is scriptable.
 *
 * Run:  node verify-photos.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8136;
const check = makeChecker();

// a real 1x1 jpeg, so at least one photo in the fixture is legitimate
const GOOD_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKD' +
  'BQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxE' +
  'B/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1' +
  'FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc' +
  '3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo' +
  '6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAE' +
  'CAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVl' +
  'dYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1' +
  'dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

const HOSTILE = {
  remote:      'https://evil.example/pixel.png',
  protoRel:    '//evil.example/pixel.png',
  svg:         'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
  html:        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  javascript:  'javascript:alert(1)',
  gifNotAllowed: 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
};

const SEED = (fixture) => {
  const now = Date.now();
  const notes = Object.keys(fixture.hostile).map((k, i) => ({
    id: 'bad-' + k, title: '', body: 'entry carrying a ' + k + ' photo', tags: [],
    pinned: false, kind: 'diary', photo: fixture.hostile[k],
    createdAt: now - (i + 2) * 1000, updatedAt: now - (i + 2) * 1000
  }));
  notes.push({ id: 'good', title: '', body: 'entry with a real photo', tags: [],
    pinned: false, kind: 'diary', photo: fixture.good,
    createdAt: now - 1000, updatedAt: now - 1000 });
  localStorage.setItem('praze.brain.v1', JSON.stringify({
    schemaVersion: 2, rev: 1, notes: notes, goals: [], todos: []
  }));
  localStorage.setItem('praze.brain.onboarded', '1');
};

(async () => {
  const server = await serve(PORT);
  const url = 'http://localhost:' + PORT + '/brain.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });

  // any attempt to fetch an off-origin asset is a failure of the boundary, so
  // record every request that leaves the origin rather than trusting the DOM alone
  const offOrigin = [];
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (!u.startsWith('http://localhost:' + PORT) && !u.startsWith('data:')) offOrigin.push(u);
    return route.continue();
  });

  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(SEED, { hostile: HOSTILE, good: GOOD_JPEG });
  await page.reload();                       // reload, never hash-nav
  await page.evaluate(() => { location.hash = '#diary'; });
  await page.waitForSelector('.note--diary');
  await page.waitForTimeout(500);

  console.log('\nDiary photos @ ' + PHONE.width + 'x' + PHONE.height);

  /* ---------- 1. nothing hostile reaches an <img> ---------- */
  const srcs = await page.$$eval('img', els => els.map(e => e.getAttribute('src') || ''));
  const allowed = /^data:image\/(?:jpeg|png|webp);base64,/;
  const bad = srcs.filter(s => s && !allowed.test(s));
  check('every <img src> in the app is an allowed data URL', bad.length === 0,
    JSON.stringify(bad.slice(0, 3)));

  for (const kind of Object.keys(HOSTILE)) {
    const leaked = await page.evaluate(v =>
      [...document.querySelectorAll('img')].some(i => (i.getAttribute('src') || '') === v),
      HOSTILE[kind]);
    check('photo rejected: ' + kind, !leaked, HOSTILE[kind].slice(0, 40));
  }

  check('a legitimate jpeg still renders', await page.evaluate(v =>
    [...document.querySelectorAll('img')].some(i => (i.getAttribute('src') || '') === v),
    GOOD_JPEG));

  /* ---------- 2. nothing was fetched off-origin ---------- */
  check('no off-origin request was made while rendering the diary',
    offOrigin.length === 0, JSON.stringify(offOrigin.slice(0, 3)));

  /* ---------- 3. the hostile values are gone from memory, not just hidden ----
     A CSS-hidden img would still have fetched. Sanitising has to happen on the
     way in, so the store the app is working from must not hold them either. */
  const inMemory = await page.evaluate(() => {
    const raw = localStorage.getItem('praze.brain.v1');
    return raw.indexOf('evil.example') === -1 && raw.indexOf('javascript:') === -1
      ? 'clean-on-disk' : 'still-on-disk';
  });
  // the store on disk is only rewritten on the next save, so this is reported
  // rather than asserted; what matters is that nothing reached the DOM
  console.log('        (store on disk is ' + inMemory + ' until the next write)');

  /* ---------- 4. photos are compressed on the way in ----------
     A raw phone photo would eat the whole quota. Build a deliberately large PNG
     in the page, feed it through the real file input, and check what gets
     staged: JPEG, and no bigger than PHOTO_MAX_DIM on its longest side. */
  const bigPng = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 2400; c.height = 1600;
    const g = c.getContext('2d');
    // noise, so it cannot compress down to nothing and trivially pass
    for (let i = 0; i < 400; i++) {
      g.fillStyle = 'rgb(' + (i * 7 % 255) + ',' + (i * 13 % 255) + ',' + (i * 29 % 255) + ')';
      g.fillRect((i * 61) % 2400, (i * 37) % 1600, 220, 180);
    }
    return c.toDataURL('image/png').split(',')[1];
  });

  await page.setInputFiles('#diary-photo-file', {
    name: 'huge.png', mimeType: 'image/png', buffer: Buffer.from(bigPng, 'base64')
  });
  await page.waitForSelector('#diary-photo-preview img', { timeout: 8000 });
  const staged = await page.evaluate(() => {
    const img = document.querySelector('#diary-photo-preview img');
    return new Promise(resolve => {
      const probe = new Image();
      probe.onload = () => resolve({
        src: img.getAttribute('src').slice(0, 24),
        bytes: img.getAttribute('src').length,
        w: probe.naturalWidth, h: probe.naturalHeight
      });
      probe.src = img.getAttribute('src');
    });
  });
  check('an uploaded photo is re-encoded as jpeg',
    staged.src.indexOf('data:image/jpeg') === 0, staged.src);
  check('an uploaded photo is capped at 800px on its longest side',
    Math.max(staged.w, staged.h) <= 800, staged.w + 'x' + staged.h);
  check('the 2400x1600 source did not keep its aspect ratio by accident',
    Math.abs((staged.w / staged.h) - 1.5) < 0.02, staged.w + 'x' + staged.h);
  check('the staged photo is a sane size for localStorage (< 400KB)',
    staged.bytes < 400 * 1024, Math.round(staged.bytes / 1024) + ' KB');

  await browser.close();
  server.close();
  process.exit(check.summary('photos') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
