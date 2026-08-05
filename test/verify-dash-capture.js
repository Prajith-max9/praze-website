/* Dashboard capture box — layout, wiring and theme.
 *
 * Covers the change that removed the PRAZE tagline from the greeting card and
 * replaced the single CAPTURE AN IDEA button with a prompt, three inline
 * options and a floating + button.
 *
 * Two traps this suite works around, both from HANDOVER.md section 7:
 *  - page.goto(url + '#hash') from the same page is a same-document navigation
 *    and does NOT re-run the app. Storage is seeded, then the page is reloaded.
 *  - clicking a tab scrolls the non-sticky tab bar into view, which scrolls the
 *    page to the top. Nothing here asserts on scroll position.
 *
 * Run:  node verify-dash-capture.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, seedScript, PHONE } = require('./lib/harness');

const PORT = 8131;
const check = makeChecker();

(async () => {
  const server = await serve(PORT);
  const url = 'http://localhost:' + PORT + '/brain.html';
  const browser = await chromium.launch();

  const phoneCtx = (init) => browser.newContext({
    viewport: PHONE, isMobile: true, hasTouch: true
  }).then(async ctx => { if (init) await ctx.addInitScript(init); return ctx; });

  async function dashboard(ctx, seed) {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.evaluate(seed || seedScript({}));
    await page.reload();                       // required: see header note
    await page.waitForSelector('.dash-capture', { timeout: 10000 });
    return page;
  }

  console.log('\nDashboard capture box @ ' + PHONE.width + 'x' + PHONE.height);

  const ctx = await phoneCtx();
  const page = await dashboard(ctx);

  /* ---------- the wrong tagline is gone ---------- */
  check('BUILT NOT BORN absent from the app',
    !/BUILT NOT BORN/i.test(await page.textContent('body')));

  /* ---------- layout order inside the hero card ---------- */
  const order = await page.evaluate(() =>
    [...document.querySelector('.dash-card--hero').children].map(el => el.className));
  check('greeting is first in the hero card', /dash-greeting/.test(order[0] || ''), order.join(' | '));
  check('link-line sits directly under the greeting', /dash-linkline/.test(order[1] || ''), order.join(' | '));
  check('capture box follows it', /dash-capture/.test(order[2] || ''), order.join(' | '));

  // it must be INSIDE the card, not a sibling below it as it used to be
  check('link-line is inside the card, not below it', await page.evaluate(() =>
    !!document.querySelector('.dash-card--hero .dash-linkline') &&
    !document.querySelector('.dash-card--hero + .dash-linkline')));

  /* ---------- prompt and the three options ---------- */
  check('prompt reads "What’s on your mind?"',
    (await page.textContent('.dash-capture__prompt')).trim() === 'What’s on your mind?');

  const opts = await page.$$eval('.dash-capture__opt', els => els.map(e => ({
    label: e.textContent.trim(),
    action: e.getAttribute('data-action'),
    icons: e.querySelectorAll('svg.icon').length
  })));
  check('three options rendered', opts.length === 3, JSON.stringify(opts));
  check('labels are Write / Speak / Clip',
    opts.map(o => o.label).join(',') === 'Write,Speak,Clip', JSON.stringify(opts.map(o => o.label)));
  check('each option has exactly one icon', opts.every(o => o.icons === 1), JSON.stringify(opts));

  const borders = await page.$$eval('.dash-capture__opt', els =>
    els.map(e => getComputedStyle(e).borderLeftWidth));
  check('dividers between options only, never before the first',
    borders[0] === '0px' && borders.slice(1).every(b => b !== '0px'), JSON.stringify(borders));

  /* ---------- the floating + button ---------- */
  const fab = await page.evaluate(() => {
    const f = document.querySelector('.dash-capture__fab');
    const box = document.querySelector('.dash-capture');
    if (!f || !box) return null;
    const fr = f.getBoundingClientRect(), br = box.getBoundingClientRect();
    const cs = getComputedStyle(f);
    return {
      radius: cs.borderRadius,
      onRight: fr.right > br.left + br.width / 2,
      centreDelta: Math.abs((fr.top + fr.height / 2) - (br.top + br.height / 2)),
      w: Math.round(fr.width), h: Math.round(fr.height),
      insideViewport: fr.right <= 390 && fr.left >= 0
    };
  });
  check('+ button is round', fab && /50%|9999px|\d+px/.test(fab.radius), fab && fab.radius);
  // token-resolved, not a literal — same reasoning as the dark theme block below
  const limeLight = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.dash-capture__fab'));
    const root = getComputedStyle(document.documentElement);
    const d = document.createElement('div');
    d.style.color = root.getPropertyValue('--lime').trim(); document.body.appendChild(d);
    const lime = getComputedStyle(d).color; d.remove();
    return { bg: cs.backgroundColor, lime: lime };
  });
  check('+ button is lime in the light theme',
    limeLight.bg === limeLight.lime, JSON.stringify(limeLight));
  check('+ button is on the right', fab && fab.onRight);
  check('+ button is vertically centred', fab && fab.centreDelta < 2, fab && fab.centreDelta);
  check('+ button does not overflow the phone viewport', fab && fab.insideViewport, JSON.stringify(fab));
  check('+ button meets a 44px tap target', fab && fab.w >= 44 && fab.h >= 44, fab && fab.w + 'x' + fab.h);

  check('no horizontal overflow at 390px', await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);

  /* ---------- each option triggers its EXISTING action ---------- */
  await page.click('.dash-capture__opt[data-action="dash-write"]');
  check('Write -> ideas tab, capture body focused', await page.evaluate(() =>
    location.hash === '#ideas' && document.activeElement === document.getElementById('capture-body')),
    await page.evaluate(() => location.hash + ' / ' + (document.activeElement || {}).id));

  const clipPage = await dashboard(await phoneCtx());
  await clipPage.click('.dash-capture__opt[data-action="dash-clip"]');
  check('Clip -> clips tab, url field focused', await clipPage.evaluate(() =>
    location.hash === '#clips' && document.activeElement === document.getElementById('clip-url')),
    await clipPage.evaluate(() => location.hash + ' / ' + (document.activeElement || {}).id));

  // The real engine is absent in headless Chromium, so it is stubbed before
  // load. A spec-faithful mock is not proof the device behaves — see the
  // dictation history in HANDOVER.md section 10 — but it is enough to assert
  // that this button reaches openDump, which is all this suite claims.
  const speakPage = await dashboard(await phoneCtx(() => {
    window.SpeechRecognition = function () {
      this.start = function () {}; this.stop = function () {};
      this.abort = function () {}; this.addEventListener = function () {};
    };
  }));
  const speak = await speakPage.$('.dash-capture__opt[data-action="dash-speak"]');
  check('Speak offered when SpeechRecognition exists', !!speak);
  if (speak) {
    await speak.click();
    await speakPage.waitForTimeout(200);
    check('Speak -> brain dump overlay opens', await speakPage.evaluate(() =>
      !document.getElementById('dump-overlay').hidden));
  }

  // and hidden without it, mirroring how #dump-btn is already gated
  const mutePage = await dashboard(await phoneCtx(() => {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  }));
  check('Speak hidden when SpeechRecognition is absent',
    (await mutePage.$$eval('.dash-capture__opt', els => els.map(e => e.textContent.trim())))
      .join(',') === 'Write,Clip');

  /* ---------- dark theme ----------
     The dark theme darkens --lime and flips --ink, and every lime chip in the
     app (.banner, .note__pinned) rides that pair. So assert the button resolves
     to the theme's own tokens rather than to any literal colour — pinning a
     literal here is exactly how this would drift from the rest of the app. */
  const darkPage = await dashboard(await phoneCtx(), seedScript({ theme: 'dark' }));
  const dark = await darkPage.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.dash-capture__fab'));
    const root = getComputedStyle(document.documentElement);
    const asRgb = (v) => {
      const d = document.createElement('div');
      d.style.color = v.trim(); document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c;
    };
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      bg: cs.backgroundColor, lime: asRgb(root.getPropertyValue('--lime')),
      fg: cs.color, ink: asRgb(root.getPropertyValue('--ink'))
    };
  });
  check('dark theme actually applied', dark.theme === 'dark', dark.theme);
  check('+ uses the theme --lime token', dark.bg === dark.lime, JSON.stringify(dark));
  check('+ glyph uses the theme --ink token', dark.fg === dark.ink, JSON.stringify(dark));

  await browser.close();
  server.close();
  process.exit(check.summary('dash-capture') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
