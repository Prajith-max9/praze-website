/* Every control must be comfortable to hit with a thumb at phone width.
 *
 * Measures the EFFECTIVE tap area with elementFromPoint rather than reading
 * getBoundingClientRect, because several controls here deliberately keep a
 * small visible box and carry a larger invisible ::after target — a rect
 * cannot see that, and neither can a rect see a NEIGHBOUR stealing the point,
 * which is the failure mode that actually bites. Tag chips were reaching up
 * into "Show more" and swallowing its taps; only probing finds that.
 *
 * Two artifacts are excluded rather than reported, because neither is a defect:
 *  - probe points outside the viewport, where elementFromPoint returns null
 *  - probe points under the sticky .navbar, which correctly returns the navbar
 *
 * Run:  node verify-tap-targets.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8133;
const VIEWS = ['dashboard', 'ask', 'todos', 'ideas', 'diary', 'clips', 'goals', 'timeline'];
const check = makeChecker();

const SEED = () => {
  const now = Date.now();
  const mk = (id, kind, extra) => Object.assign({
    id, title: 'Note ' + id, body: 'protein training content that is quite long '.repeat(6),
    tags: ['training', 'content'], pinned: false, kind,
    createdAt: now - 90000, updatedAt: now - 90000
  }, extra || {});
  localStorage.setItem('praze.brain.v1', JSON.stringify({
    schemaVersion: 2, rev: 1,
    notes: [mk('a', 'idea'), mk('b', 'idea'), mk('c', 'idea'),
      mk('d', 'diary', { title: '', body: 'today was ==good== and long '.repeat(8) }),
      mk('e', 'clip', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })],
    goals: [{ id: 'g', title: 'Post 12 reels', target: 12, progress: 3, createdAt: now }],
    todos: [{ id: 't', text: 'Do the thing', done: false, dueAt: now + 86400000,
              notified: false, createdAt: now }]
  }));
  localStorage.setItem('praze.brain.onboarded', '1');
};

const PROBE = (view) => {
  const MIN = 44, half = MIN / 2 - 2;   // 2px of slack for sub-pixel layout
  const nb = document.querySelector('.navbar');
  const navBottom = nb ? nb.getBoundingClientRect().bottom : 0;
  const out = [];
  // `summary` is here because the footer's storage note became a <details>.
  // It is a control the user taps, so the 44px rule applies to it, but it
  // matches none of the other three selectors — a native summary carries its
  // role implicitly and has no role attribute to find it by.
  document.querySelectorAll('button, a[href], [role="button"], summary').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.hidden || el.closest('[hidden]')) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cy - half < navBottom || cy + half > innerHeight ||
        cx - half < 0 || cx + half > innerWidth) return;   // unprobeable, not unfixed
    const hits = (x, y) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === el || el.contains(t));
    };
    const vOk = hits(cx, cy - half) && hits(cx, cy + half);
    const hOk = hits(cx - half, cy) && hits(cx + half, cy);
    if (!vOk || !hOk) {
      const c = el.className;
      out.push({
        view,
        cls: String(c && c.baseVal !== undefined ? c.baseVal : (c || el.tagName)),
        action: el.getAttribute('data-action') || el.id || '',
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        short: (!vOk ? 'V' : '') + (!hOk ? 'H' : '')
      });
    }
  });
  return out;
};

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('http://localhost:' + PORT + '/brain.html');
  await page.evaluate(SEED);
  await page.reload();                       // reload, never hash-nav
  await page.waitForSelector('.tabs');

  console.log('\nTap targets @ ' + PHONE.width + 'x' + PHONE.height);

  const bad = [];
  for (const v of VIEWS) {
    await page.evaluate(view => { location.hash = '#' + view; }, v);
    await page.waitForTimeout(300);
    // walk the page so controls below the fold come into probe range
    for (const frac of [0, 0.5, 1]) {
      await page.evaluate(f => scrollTo(0, (document.body.scrollHeight - innerHeight) * f), frac);
      await page.waitForTimeout(150);
      bad.push(...await page.evaluate(PROBE, v));
    }
  }

  const seen = new Set(); const uniq = [];
  for (const b of bad) {
    const k = b.cls + '|' + b.action + '|' + b.short;
    if (!seen.has(k)) { seen.add(k); uniq.push(b); }
  }

  uniq.forEach(b => console.log('        ' + b.short.padEnd(3) + ' ' + b.box.padEnd(9) +
    b.cls.slice(0, 34).padEnd(35) + (b.action || '')));
  check('every probeable control has a 44px effective tap area', uniq.length === 0,
    uniq.length + ' short (V=vertical, H=horizontal)');

  await browser.close();
  server.close();
  process.exit(check.summary('tap-targets') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
