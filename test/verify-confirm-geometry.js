/* verify-confirm-geometry.js — a confirm step must not put a control where the
 * trigger just was.
 *
 * The bug this exists for. Clicking "Delete" on a diary entry swapped the
 * action row for "Delete? Yes No". Both rows are right-aligned and every
 * .note__action carries min-width: 44px, so the LAST button of each row
 * occupied the same box — "Delete" at x 1012..1057, "No" at 1013..1057. A
 * mouse user who clicked Delete and then clicked again without moving the
 * pointer hit "No" and cancelled their own deletion, silently. It read as
 * "delete doesn't work on my laptop". The coincidence was structural, not
 * accidental: same right edge, same min-width.
 *
 * Why no existing suite caught it. Every delete test drives the confirm by
 * selector — `page.click('[data-action="delete-yes"]')` — so Playwright
 * re-finds the button wherever it moved to. That can never observe a pointer
 * that stays still. verify-s1.js proves the storage semantics of delete are
 * correct, and they always were; nothing modelled the pointer.
 *
 * The invariant, stated so it outlives this particular row: after a
 * destructive trigger opens an inline confirm, the box the trigger occupied
 * may contain nothing but that same trigger. Not the cancel (silently undoes
 * the user's intent) and not the confirm either (turns a stray double-click
 * into a deletion, which is worse). The trigger itself is fine and is the
 * point of the fix — clicking it again just re-opens the confirm that is
 * already open, so a pointer that never moves can only repeat what it asked
 * for.
 *
 * Run:  node verify-confirm-geometry.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8139;
const VIEWPORTS = [PHONE, { width: 1024, height: 768 }, { width: 1440, height: 900 }];

const SEED = `(() => {
  const t = 1754700000000;
  const notes = [], goals = [], todos = [];
  for (let i = 0; i < 2; i++) {
    notes.push({ id: 'd' + i, title: '', body: 'today was fine and it went well #' + i,
      tags: ['training'], pinned: false, kind: 'diary',
      createdAt: t - i * 3600000, updatedAt: t - i * 3600000 });
    notes.push({ id: 'n' + i, title: 'Idea ' + i, body: 'protein training content ' + i,
      tags: ['training'], pinned: false, kind: 'idea',
      createdAt: t - i * 7200000, updatedAt: t - i * 7200000 });
  }
  notes.push({ id: 'c1', title: 'A clip', body: 'why I saved it', tags: [], pinned: false,
    kind: 'clip', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', createdAt: t, updatedAt: t });
  goals.push({ id: 'g1', title: 'Post 12 reels', target: 12, progress: 3, createdAt: t });
  todos.push({ id: 'td1', text: 'Water the plants', done: false, createdAt: t });
  localStorage.setItem('praze.brain.v1', JSON.stringify({ schemaVersion: 2, rev: 1, notes, goals, todos }));
  localStorage.setItem('praze.brain.onboarded', '1');
})()`;

/* Every inline confirm in the app. Todo's delete is deliberately absent: it
   deletes in one step with an undo banner and has no confirm row to get wrong.
   If a two-step confirm is ever added anywhere, add it here. */
const CASES = [
  { tab: 'diary', name: 'diary entry', trigger: '.note--diary [data-action="delete-ask"]' },
  { tab: 'ideas', name: 'idea note', trigger: '.note:not(.note--diary) [data-action="delete-ask"]' },
  { tab: 'clips', name: 'clip', trigger: '.clip [data-action="delete-ask"]' },
  { tab: 'goals', name: 'goal', trigger: '.goal [data-action="goal-del-ask"]' }
];

/* Samples a grid over the vacated box rather than just its centre: a partial
   overlap is still a control under the pointer, and the centre alone would
   miss a button covering only one edge. */
const PROBE = ({ sel }) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  /* behavior:'instant' matters. styles.css sets html { scroll-behavior:
     smooth }, so a plain scrollIntoView animates over several frames — and an
     early reading of the box, taken mid-flight, made this suite report a 43px
     "shift" that was entirely its own doing. An assertion that fails for the
     wrong reason is worth no more than one that passes for the wrong reason. */
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  // the re-render replaces the node, so identity is no use — compare by action
  const triggerAction = el.getAttribute('data-action');

  /* Wait for the layout to stop moving before recording anything. The clip card
     carries a YouTube thumbnail that resolves asynchronously — and in this
     environment fails to — so its height changes under the probe. A box
     captured mid-reflow and compared against a settled one reports an overlap
     that does not exist, which is exactly how this suite spent a round
     accusing the fix it was meant to be checking. */
  const settled = () => new Promise(resolve => {
    let last = null, same = 0, frames = 0;
    (function tick() {
      const b = el.getBoundingClientRect();
      const key = [b.left, b.top, b.width, b.height].join(',');
      same = key === last ? same + 1 : 0;
      last = key;
      if (same >= 3 || ++frames > 90) return resolve();
      requestAnimationFrame(tick);
    })();
  });

  return settled().then(() => new Promise(resolve => {
    const r = el.getBoundingClientRect();
    const box = { l: r.left, t: r.top, w: r.width, h: r.height };
    el.click();
    // read back once the re-render has laid out
    requestAnimationFrame(() => requestAnimationFrame(() => {
    const hits = [];
    for (let ix = 0; ix <= 2; ix++) {
      for (let iy = 0; iy <= 2; iy++) {
        const x = box.l + 2 + (box.w - 4) * (ix / 2);
        const y = box.t + 2 + (box.h - 4) * (iy / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        const btn = hit.closest('button');
        // the trigger reappearing in its own box is the intended outcome
        if (btn && btn.getAttribute('data-action') !== triggerAction) {
          hits.push({ x: Math.round(x), y: Math.round(y), action: btn.getAttribute('data-action'), text: btn.textContent.trim() });
        }
      }
    }
    const confirmOpen = !!document.querySelector(
      '[data-action="delete-yes"], [data-action="goal-del-yes"]');
    resolve({
      found: true, confirmOpen,
      box: { l: Math.round(box.l), t: Math.round(box.t), w: Math.round(box.w), h: Math.round(box.h) },
      hits
    });
    }));
  }));
};

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();
  const check = makeChecker();

  for (const vp of VIEWPORTS) {
    const label = '@' + vp.width + 'x' + vp.height;
    console.log('\nConfirm steps ' + label);
    const ctx = await browser.newContext(Object.assign({ viewport: vp },
      vp.width <= 500 ? { isMobile: true, hasTouch: true } : {}));
    const page = await ctx.newPage();
    await page.goto('http://localhost:' + PORT + '/brain.html');
    await page.evaluate(SEED);
    await page.reload();                       // seed, then reload — never hash-nav

    for (const c of CASES) {
      await page.evaluate(t => { location.hash = '#' + t; }, c.tab);
      await page.waitForTimeout(450);
      const r = await page.evaluate(PROBE, { sel: c.trigger });

      if (!r.found) { check(c.name + ' ' + label + ': trigger renders', false, c.trigger); continue; }
      if (!r.confirmOpen) { check(c.name + ' ' + label + ': confirm step opens', false, 'no yes/no rendered'); continue; }

      const detail = r.hits.length
        ? r.hits.map(h => '[' + h.action + '] "' + h.text + '" at ' + h.x + ',' + h.y).join('; ')
        : '';
      check(c.name + ' ' + label + ': no other control takes the trigger\'s box',
        r.hits.length === 0, 'box ' + r.box.l + ',' + r.box.t + ' ' + r.box.w + 'x' + r.box.h +
        ' now covered by ' + detail);
    }
    await ctx.close();
  }

  await browser.close();
  server.close();
  process.exit(check.summary('confirm-geometry'));
})().catch(e => { console.error(e); process.exit(1); });
