/* Polish pass 2: timestamps, clamped previews, copy, offline, active tab,
 * destructive-action presentation, and what survives a tab round trip.
 *
 * Everything asserted here is read-only or presentation-only. Nothing in this
 * suite writes a note, and nothing it exercises calls saveStore — that is the
 * point of the pass, and `no write path touched` below asserts it directly.
 *
 * Run:  node verify-polish.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8134;
const check = makeChecker();

const SEED = () => {
  const now = Date.now();
  localStorage.setItem('praze.brain.v1', JSON.stringify({
    schemaVersion: 2, rev: 1,
    notes: [
      { id: 'long', title: 'Long one', body: 'protein training content that runs on '.repeat(12),
        tags: ['training', 'content'], pinned: false, kind: 'idea',
        createdAt: now - 8 * 60000, updatedAt: now - 8 * 60000 },
      // pinned, so the accent-bar radius rule has something to assert against
      { id: 'short', title: 'Short one', body: 'brief', tags: ['training'], pinned: true,
        kind: 'idea', createdAt: now - 3 * 3600000, updatedAt: now - 3 * 3600000 },
      { id: 'dry', title: '', body: 'today was ==good==', tags: [], pinned: false,
        kind: 'diary', createdAt: now - 30000, updatedAt: now - 30000 }
    ].concat(
      // filler so the Ideas list is tall enough to scroll; untagged so they do
      // not disturb the tag-filter counts below
      Array.from({ length: 10 }, (_, i) => ({
        id: 'f' + i, title: 'Filler ' + i, body: 'padding '.repeat(20), tags: [],
        pinned: false, kind: 'idea', createdAt: now - (i + 20) * 86400000,
        updatedAt: now - (i + 20) * 86400000
      }))),
    goals: [],
    // one todo, so the checkbox radius rule has something to assert against
    todos: [{ id: 't1', text: 'A todo', done: false, dueAt: null, notified: false,
              createdAt: now, completedAt: null, updatedAt: now }]
  }));
  localStorage.setItem('praze.brain.onboarded', '1');
};

(async () => {
  const server = await serve(PORT);
  const url = 'http://localhost:' + PORT + '/brain.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:' + PORT });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(SEED);
  await page.reload();                       // reload, never hash-nav
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('.note');

  console.log('\nPolish pass @ ' + PHONE.width + 'x' + PHONE.height);

  /* ---------- 1. relative timestamps ---------- */
  const stamps = await page.$$eval('.note__date', els => els.map(e => ({
    text: e.textContent.trim(),
    title: (e.querySelector('[title]') || {}).title || ''
  })));
  // not anchored: the stamp shares its line with a "Pinned" badge and an
  // "edited …" suffix, either of which can sit either side of it
  check('cards show minute-level relative time', stamps.some(s => /\b8m ago\b/.test(s.text)),
    JSON.stringify(stamps.map(s => s.text)));
  check('cards show hour-level relative time', stamps.some(s => /\b3h ago\b/.test(s.text)),
    JSON.stringify(stamps.map(s => s.text)));
  check('every relative stamp carries the exact moment',
    stamps.every(s => /^\d{2} [A-Z]{3} \d{4} · \d{2}:\d{2}$/.test(s.title)),
    JSON.stringify(stamps.map(s => s.title)));

  // opening a note for edit shows the exact date AND time, not a relative one
  await page.click('.note[data-id="short"] [data-action="edit"]');
  await page.waitForSelector('.note--editing');
  check('the opened note shows an exact date and time',
    /^\d{2} [A-Z]{3} \d{4} · \d{2}:\d{2}$/.test(
      (await page.textContent('.note--editing .note__date')).trim()),
    await page.textContent('.note--editing .note__date'));
  await page.click('.note--editing [data-action="edit-cancel"]');
  await page.waitForSelector('.note--editing', { state: 'detached' });

  /* ---------- 2. clamped previews ---------- */
  // Whether a body overflows can only be known after paint, so the toggle is
  // revealed on the next frame. Wait for that rather than racing it.
  await page.waitForFunction(() =>
    !document.querySelector('.note[data-id="long"] .note__more').hidden, { timeout: 4000 });
  const clamp = await page.evaluate(() => {
    const longEl = document.querySelector('.note[data-id="long"] .note__body');
    const shortEl = document.querySelector('.note[data-id="short"] .note__body');
    // Ask whether it is actually PAINTED, not whether the property is set: an
    // author `display` rule beats [hidden], so .hidden alone can be true while
    // the button is still on screen. That exact bug shipped past a weaker check.
    const onScreen = sel => {
      const el = document.querySelector(sel);
      return !!el && !!el.offsetParent && el.getBoundingClientRect().height > 0;
    };
    return {
      longClamped: longEl.classList.contains('note__body--clamped'),
      longLines: getComputedStyle(longEl).webkitLineClamp,
      longToggleShown: onScreen('.note[data-id="long"] .note__more'),
      shortToggleShown: onScreen('.note[data-id="short"] .note__more'),
      shortToggleHiddenProp: document.querySelector('.note[data-id="short"] .note__more').hidden,
      shortClamped: shortEl.classList.contains('note__body--clamped')
    };
  });
  check('a long body is clamped to 3 lines', clamp.longClamped && clamp.longLines === '3',
    JSON.stringify(clamp));
  check('the toggle appears only where the body is actually cut off',
    clamp.longToggleShown && !clamp.shortToggleShown, JSON.stringify(clamp));
  check('[hidden] on the toggle actually removes it from the page',
    clamp.shortToggleHiddenProp && !clamp.shortToggleShown, JSON.stringify(clamp));

  const beforeLen = (await page.textContent('.note[data-id="long"] .note__body')).length;
  await page.click('.note[data-id="long"] .note__more');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const el = document.querySelector('.note[data-id="long"] .note__body');
    return { clamped: el.classList.contains('note__body--clamped'), len: el.textContent.length,
             label: document.querySelector('.note[data-id="long"] .note__more').textContent.trim() };
  });
  check('expanding un-clamps and shows more than the snippet',
    !after.clamped && after.len > beforeLen, JSON.stringify({ beforeLen, after }));
  check('the toggle flips to Show less', /less/i.test(after.label), after.label);

  /* ---------- 3. copy ---------- */
  await page.click('.note[data-id="short"] [data-action="note-copy"]');
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('Copy puts the note on the clipboard', /Short one/.test(clip) && /brief/.test(clip),
    JSON.stringify(clip));

  await page.evaluate(() => { location.hash = '#diary'; });
  await page.waitForSelector('.note--diary');
  await page.click('.note--diary [data-action="note-copy"]');
  await page.waitForTimeout(250);
  const diaryClip = await page.evaluate(() => navigator.clipboard.readText());
  check('a copied diary entry has its ==marks== stripped',
    /today was good/.test(diaryClip) && !/==/.test(diaryClip), JSON.stringify(diaryClip));

  /* ---------- 4. active tab ---------- */
  const tabs = await page.$$eval('.tabs__tab', els => els.map(e => ({
    v: e.getAttribute('data-view'),
    active: e.classList.contains('tabs__tab--active'),
    current: e.getAttribute('aria-current'),
    weight: getComputedStyle(e).fontWeight,
    border: getComputedStyle(e).borderBottomColor
  })));
  const activeTab = tabs.find(t => t.active);
  check('exactly one tab is active', tabs.filter(t => t.active).length === 1);
  check('the active tab is the only one with aria-current',
    activeTab.current === 'page' && tabs.filter(t => t.current === 'page').length === 1);

  // The underline is the sliding #tabs-indicator, not a per-tab border: the
  // per-tab border is deliberately transparent so the two cannot both show.
  const indicator = await page.evaluate(() => {
    const ind = document.getElementById('tabs-indicator');
    const tab = document.querySelector('.tabs__tab--active');
    const ir = ind.getBoundingClientRect(), tr = tab.getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    const n = document.createElement('div');
    n.style.color = root.getPropertyValue('--lime').trim();
    document.body.appendChild(n);
    const lime = getComputedStyle(n).color; n.remove();
    return {
      bg: getComputedStyle(ind).backgroundColor, lime: lime,
      weight: getComputedStyle(tab).fontWeight,
      color: getComputedStyle(tab).color,
      // the indicator is a 100px base scaled and translated onto the active tab
      alignedLeft: Math.abs(ir.left - tr.left) < 2,
      alignedWidth: Math.abs(ir.width - tr.width) < 2
    };
  });
  check('the underline is lime', indicator.bg === indicator.lime, JSON.stringify(indicator));
  check('the underline sits exactly under the active tab',
    indicator.alignedLeft && indicator.alignedWidth, JSON.stringify(indicator));
  check('the active tab is also heavier than the rest',
    Number(indicator.weight) >= 700 &&
    tabs.filter(t => !t.active).every(t => Number(t.weight) < 700),
    JSON.stringify({ active: indicator.weight, rest: tabs.filter(t => !t.active).map(t => t.weight) }));

  /* ---------- 5. destructive action stays quiet until touched ---------- */
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForSelector('.note');
  const del = await page.evaluate(() => {
    const d = document.querySelector('[data-action="delete-ask"]');
    const e = document.querySelector('[data-action="edit"]');
    const root = getComputedStyle(document.documentElement);
    const asRgb = v => { const n = document.createElement('div'); n.style.color = v.trim();
      document.body.appendChild(n); const c = getComputedStyle(n).color; n.remove(); return c; };
    return { delColor: getComputedStyle(d).color, editColor: getComputedStyle(e).color,
             gray: asRgb(root.getPropertyValue('--gray')), danger: asRgb(root.getPropertyValue('--danger')) };
  });
  check('Delete reads as quietly as Edit until touched',
    del.delColor === del.gray && del.delColor === del.editColor, JSON.stringify(del));
  check('Delete is not pre-coloured with the danger token',
    del.delColor !== del.danger, JSON.stringify(del));

  /* ---------- 6. offline indicator ---------- */
  check('offline badge hidden while online',
    await page.evaluate(() => document.getElementById('offline-badge').hidden));
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(120);
  check('offline badge appears when connectivity drops',
    await page.evaluate(() => !document.getElementById('offline-badge').hidden));
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(120);
  check('offline badge clears when connectivity returns',
    await page.evaluate(() => document.getElementById('offline-badge').hidden));

  /* ---------- 7. what survives a tab round trip ---------- */
  await page.evaluate(() => {
    document.querySelector('.tag-rail .tag-chip').click();   // filter to a tag
  });
  await page.waitForTimeout(200);
  const filtered = await page.evaluate(() => ({
    tag: document.querySelector('.tag-chip--active') ? document.querySelector('.tag-chip--active').textContent.trim() : null,
    count: document.querySelectorAll('.note').length
  }));
  await page.evaluate(() => { location.hash = '#diary'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForTimeout(250);
  const returned = await page.evaluate(() => ({
    tag: document.querySelector('.tag-chip--active') ? document.querySelector('.tag-chip--active').textContent.trim() : null,
    count: document.querySelectorAll('.note').length
  }));
  check('an active tag filter survives leaving and returning to Ideas',
    returned.tag === filtered.tag && returned.count === filtered.count,
    JSON.stringify({ filtered, returned }));

  /* Scroll restore. HANDOVER section 9 is explicit that this is a no-op for
     *tab taps* — the tab bar is not sticky, so reaching it scrolls you to the
     top and there is no offset left to restore. It does work for programmatic
     and back-gesture navigation, which is what is asserted here. */
  await page.evaluate(() => { document.querySelector('.tag-chip--active').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => scrollTo(0, 400));
  await page.waitForTimeout(150);
  const beforeLeave = await page.evaluate(() => Math.round(scrollY));
  await page.evaluate(() => { location.hash = '#diary'; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForTimeout(600);            // restore re-asserts over several frames
  const afterReturn = await page.evaluate(() => Math.round(scrollY));
  check('scroll position is restored on programmatic navigation',
    beforeLeave > 200 && Math.abs(afterReturn - beforeLeave) < 40,
    JSON.stringify({ beforeLeave, afterReturn }));

  /* ---------- 8. the corner-radius design system ----------
     One token, referenced everywhere, with three deliberate departures. Each
     of those was a decision, so each gets an assertion — otherwise the next
     person "tidies" one back to the token and quietly undoes it. */
  const radius = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const px = sel => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).borderRadius : null;
    };
    return {
      token: root.getPropertyValue('--radius').trim(),
      tokenSm: root.getPropertyValue('--radius-sm').trim(),
      // an unpinned card: a pinned one deliberately squares its left edge
      note: px('.note[data-id="long"]'),
      pinned: px('.note--pinned'),
      chip: px('.tag-chip'),
      input: px('#capture-body')
    };
  });
  check('a --radius token is defined', /^\d+px$/.test(radius.token), radius.token);
  check('a separate --radius-sm exists for small controls',
    /^\d+px$/.test(radius.tokenSm) && parseFloat(radius.tokenSm) < parseFloat(radius.token),
    radius.tokenSm);
  check('cards use the token', radius.note === radius.token, radius.note);
  check('inputs use the token', radius.input === radius.token, radius.input);
  check('chips use the token', radius.chip === radius.token, radius.chip);

  // an accent bar keeps its hard edge: left corners square, right corners not
  check('an accented surface keeps its left edge square',
    /^0px \d+px \d+px 0px$/.test(radius.pinned), radius.pinned);

  await page.evaluate(() => { location.hash = '#todos'; });
  await page.waitForTimeout(300);
  const control = await page.evaluate(() => {
    const cb = document.querySelector('.todo__check');
    const root = getComputedStyle(document.documentElement);
    return { cb: cb ? getComputedStyle(cb).borderRadius : null,
             sm: root.getPropertyValue('--radius-sm').trim(),
             full: root.getPropertyValue('--radius').trim() };
  });
  check('a checkbox takes the small token, so it cannot round into a radio button',
    control.cb === control.sm && control.cb !== control.full, JSON.stringify(control));

  await page.evaluate(() => { location.hash = '#goals'; });
  await page.waitForTimeout(300);
  check('the streak cells stay square so the pair does not double-round',
    await page.evaluate(() => {
      const cell = document.querySelector('.streak-card');
      return !cell || getComputedStyle(cell).borderRadius === '0px';
    }));

  await page.evaluate(() => { location.hash = '#ideas'; });
  await page.waitForTimeout(300);

  /* ---------- 9. the whole pass wrote nothing ---------- */
  // A single rev covering everything above: the store must be byte-identical to
  // what was seeded, because not one of these features is allowed to write.
  const storeNow = await page.evaluate(() => localStorage.getItem('praze.brain.v1'));
  const revNow = JSON.parse(storeNow).rev;
  check('no write path touched: store rev is still the seeded one', revNow === 1, 'rev=' + revNow);
  check('expand state never reached the store', !/expanded/.test(storeNow));

  await browser.close();
  server.close();
  process.exit(check.summary('polish') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
