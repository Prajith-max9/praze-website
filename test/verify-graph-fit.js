/* verify-graph-fit.js — the graph frames itself to whatever canvas it is given.
 *
 * Why this exists. The force layout's equilibrium size is set in absolute
 * pixels — the repulsion and rest-length constants have no idea how big the
 * canvas is — so the node cluster settles at roughly the same physical size
 * however much room it has. Measured at 1440x900 before the camera existed:
 * 20 notes spanned 165px of a 538px-tall canvas (31%), and 168px of a 718px
 * one (23%). More height made it emptier, not fuller. brain-graph.js now eases
 * the camera to frame the content, which is what makes canvas size mean
 * anything at all.
 *
 * These assertions were confirmed to FAIL against the pre-camera brain-graph.js
 * before being trusted — the coverage floor here is 60% and that build sits at
 * ~31%, so it fails on the number that matters rather than on a technicality.
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8137;
const DESKTOP = { width: 1440, height: 900 };

/* Notes that link to each other, so the graph has real edges rather than
   relying on the similarity gate. Fixed timestamps: nothing here reads them,
   but a drifting clock in a seed is a bug waiting to happen. */
function seed(n) {
  return `(() => {
    const t = 1754700000000;
    const notes = [];
    for (let i = 0; i < ${n}; i++) {
      notes.push({ id: 'seed' + i, title: 'Note ' + i,
        body: (i > 0 ? '[[Note ' + (i - 1) + ']] ' : '') + 'protein training content ' + i,
        tags: [], pinned: false, kind: 'idea',
        createdAt: t - i * 86400000, updatedAt: t - i * 86400000 });
    }
    localStorage.setItem('praze.brain.v1', JSON.stringify({
      schemaVersion: 2, rev: 1, notes, goals: [], todos: []
    }));
    localStorage.setItem('praze.brain.onboarded', '1');
  })()`;
}

async function openGraph(browser, count, viewport) {
  const ctx = await browser.newContext(
    Object.assign({ viewport }, viewport === PHONE ? { isMobile: true, hasTouch: true } : {}));
  const page = await ctx.newPage();
  await page.goto('http://localhost:' + PORT + '/brain.html');
  await page.evaluate(seed(count));
  await page.reload();                     // never hash-nav from the same page
  await page.evaluate(() => { location.hash = '#graph'; });
  return { ctx, page };
}

/* The rAF loop stops when the layout settles AND the camera has arrived, so
   "not running" is the signal that framing is finished. Returns how long it
   took, or null if it never stopped — a graph big enough not to settle is a
   real case (measured: 40+ notes, before this change as well as after), so
   callers decide whether that matters rather than this throwing. */
async function waitForRest(page, ms) {
  const limit = ms || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    const running = await page.evaluate(() => window.__brainDebug && window.__brainDebug.running);
    if (running === false) return Date.now() - t0;
    await page.waitForTimeout(60);
  }
  return null;
}

/* What the drawing actually occupies on screen, in canvas pixels. Mirrors
   contentBox() in brain-graph.js: circles plus the labels centred above them,
   put through the camera. Asserting on this rather than on the fit value the
   module reports means a fit that is computed but not applied still fails. */
function paintedBoxScript() {
  return () => {
    const d = window.__brainDebug;
    if (!d || !d.positions.length) return null;
    const showAll = d.positions.length <= 40;      // LABEL_LIMIT
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of d.positions) {
      const r = 5 + Math.min(6, n.deg * 1.2);      // radius(), nodeSize 1
      const halfW = showAll ? Math.max(r, n.halfLabel) : r;
      const top = showAll ? n.y - r - 17 : n.y - r;
      x0 = Math.min(x0, n.x - halfW); x1 = Math.max(x1, n.x + halfW);
      y0 = Math.min(y0, top);         y1 = Math.max(y1, n.y + r);
    }
    const s = d.scale;
    return {
      left: x0 * s + d.ox, right: x1 * s + d.ox,
      top: y0 * s + d.oy, bottom: y1 * s + d.oy,
      canvasW: d.w, canvasH: d.h, scale: s, autoFit: d.autoFit, nodes: d.nodes
    };
  };
}

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();
  const check = makeChecker();

  /* --- below the gate the camera never magnifies --------------------------
     A sparse graph is sparse, not small. Blowing one or two dots up to fill
     1300px reads as broken, and .graph-cold already explains the sparseness. */
  console.log('\nSparse graphs are left alone @1440x900');
  for (const count of [1, 2, 3, 4]) {
    const { ctx, page } = await openGraph(browser, count, DESKTOP);
    await waitForRest(page, 4000);
    const scale = await page.evaluate(() => window.__brainDebug.scale);
    check(count + ' note(s): camera stays at 1x', scale === 1, 'scale=' + scale);
    await ctx.close();
  }

  /* --- at and above the gate, the graph fills the canvas ------------------ */
  console.log('\nThe graph frames itself');
  for (const [count, viewport, label] of [
    [6, DESKTOP, '@1440x900'], [20, DESKTOP, '@1440x900'],
    [6, PHONE, '@390x844'], [20, PHONE, '@390x844']
  ]) {
    const { ctx, page } = await openGraph(browser, count, viewport);
    await waitForRest(page);
    const b = await page.evaluate(paintedBoxScript());
    const coverW = (b.right - b.left) / b.canvasW;
    const coverH = (b.bottom - b.top) / b.canvasH;
    const limiting = Math.max(coverW, coverH);
    // A roughly circular graph cannot fill both axes of a 2.4:1 canvas, so the
    // claim is about the limiting axis, not both.
    //
    // The floor is 75%, not 60%. At 60% this assertion PASSED against the
    // pre-camera build for 20 notes on the phone — a 340px-wide canvas and a
    // ~212px cluster is 62% by accident, not by framing — so it was measuring
    // nothing in exactly the case a phone user would care about. The fitted
    // build clears 80% in all four cases; the pre-camera one reaches 62%.
    console.log('        ' + count + ' notes ' + label + ': limiting axis ' +
      Math.round(limiting * 100) + '% (w ' + Math.round(coverW * 100) +
      '%, h ' + Math.round(coverH * 100) + '%, scale ' + b.scale.toFixed(2) + ')');
    check(count + ' notes ' + label + ': fills its limiting axis (>=75%)',
      limiting >= 0.75, Math.round(limiting * 100) + '% (w ' + Math.round(coverW * 100) +
      '%, h ' + Math.round(coverH * 100) + '%)');
    check(count + ' notes ' + label + ': nothing is framed off-canvas',
      b.left >= -1 && b.top >= -1 && b.right <= b.canvasW + 1 && b.bottom <= b.canvasH + 1,
      'box ' + [b.left, b.top, b.right, b.bottom].map(Math.round).join(',') +
      ' in ' + Math.round(b.canvasW) + 'x' + Math.round(b.canvasH));
    check(count + ' notes ' + label + ': never zooms past the 2.4x ceiling',
      b.scale <= 2.4 + 1e-6, 'scale=' + b.scale);
    await ctx.close();
  }

  /* --- the rAF loop still stops ------------------------------------------
     §5: leaving the loop running eats battery. The camera keeps it alive
     while it eases, so this checks the easing actually converges. */
  console.log('\nThe loop still comes to rest');
  {
    const { ctx, page } = await openGraph(browser, 20, DESKTOP);
    const restedAt = await waitForRest(page);
    check('20 notes: rAF loop stops', restedAt !== null, 'still running after 8s');
    await ctx.close();
  }

  /* --- the camera is the user's the moment they touch it ------------------ */
  console.log('\nUser input takes the camera');
  {
    const { ctx, page } = await openGraph(browser, 20, DESKTOP);
    await waitForRest(page);
    const box = await page.locator('#graph-canvas').boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(400);
    const zoomed = await page.evaluate(() => ({
      autoFit: window.__brainDebug.autoFit, scale: window.__brainDebug.scale
    }));
    check('wheel zoom: the graph stops auto-framing', zoomed.autoFit === false);

    // and stays where it was put rather than creeping back
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__brainDebug.scale);
    check('wheel zoom: the camera stays where the user left it',
      Math.abs(after - zoomed.scale) < 1e-6, zoomed.scale + ' -> ' + after);

    // double-click on empty canvas hands it back; the corner is empty because
    // the layout is a cluster in the middle
    await page.mouse.dblclick(box.x + 12, box.y + 12);
    await page.waitForTimeout(900);
    // .fit is tolerated as missing so this suite still completes when it is run
    // against a build without the camera — a suite that crashes half way
    // through reports less than one that fails cleanly.
    const reset = await page.evaluate(() => ({
      autoFit: window.__brainDebug.autoFit, scale: window.__brainDebug.scale,
      fit: (window.__brainDebug.fit || { scale: 1 }).scale
    }));
    check('double-click: auto-framing resumes', reset.autoFit === true);
    check('double-click: the camera returns to the framing, not to 1x',
      Math.abs(reset.scale - reset.fit) < 0.02 && reset.scale > 1.2,
      'scale=' + reset.scale + ' fit=' + reset.fit);
    await ctx.close();
  }

  /* --- dragging a node must not slide the graph out from under it --------- */
  console.log('\nDragging a node takes the camera too');
  {
    const { ctx, page } = await openGraph(browser, 20, DESKTOP);
    await waitForRest(page);
    const box = await page.locator('#graph-canvas').boundingBox();
    // a node's screen position, straight from the sample the module exposes
    const p = await page.evaluate(() => window.__brainDebug.sample);
    await page.mouse.move(box.x + p.x, box.y + p.y);
    await page.mouse.down();
    await page.mouse.move(box.x + p.x + 40, box.y + p.y + 30, { steps: 6 });
    const during = await page.evaluate(() => window.__brainDebug.autoFit);
    await page.mouse.up();
    check('node drag: the graph stops auto-framing', during === false);
    await ctx.close();
  }

  await browser.close();
  server.close();
  process.exit(check.summary('graph-fit'));
})().catch(e => { console.error(e); process.exit(1); });
