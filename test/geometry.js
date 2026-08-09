/* Geometry snapshot — proves a layout change did not reach a viewport it was
 * not meant to reach.
 *
 * Walks every painted element on all nine tabs at a fixed viewport and records
 * tag/id/class/rect. Two snapshots that hash identically mean the layout is
 * byte-for-byte the same. The usual job is proving a `min-width` rule cannot
 * touch the phone, which is an argument nobody should have to take on trust.
 *
 * This is a tool, not a suite: the name is deliberately not verify-*.js, so
 * runall.js does not pick it up. It needs two runs to say anything.
 *
 *   node geometry.js snap before.txt                 # current working tree
 *   node geometry.js snap after.txt
 *   node geometry.js diff before.txt after.txt
 *
 *   node geometry.js snap old.txt --root ../wt       # some other checkout,
 *                                                    # e.g. a git worktree
 *   node geometry.js snap wide.txt --viewport 1440x900
 *
 * Snapshots are written as plain text, one element per line, so `diff` works
 * on them directly if you want to see the raw damage. They are gitignored.
 *
 * WHY IT LIVES HERE. This tool has now been written from scratch three times,
 * because the first two versions lived in a session scratchpad that was thrown
 * away with the session — the same way the 32 original suites were lost. It is
 * the only thing that can substantiate "the phone is untouched", and that claim
 * has been made in three separate PRs.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { serve, PHONE } = require('./lib/harness');

const PORT = 8138;
const TABS = ['dashboard', 'ask', 'todos', 'ideas', 'diary', 'clips', 'goals', 'timeline', 'graph'];

/* A fixed clock, not Date.now(). Relative timestamps ("2 minutes ago") and the
   streak counters both read the current time, and a snapshot whose contents
   drift between runs cannot prove anything. */
const T0 = 1754700000000;

const SEED = `(() => {
  const t = ${T0};
  const notes = [], goals = [], todos = [];
  for (let i = 0; i < 9; i++) {
    notes.push({
      id: 'seed' + i, title: 'Note ' + i,
      body: (i > 0 ? '[[Note ' + (i - 1) + ']] ' : '') + 'protein training content ' + i,
      tags: i % 2 ? ['training'] : ['food'], pinned: i === 0,
      kind: i < 6 ? 'idea' : (i < 8 ? 'diary' : 'clip'),
      url: i === 8 ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : undefined,
      createdAt: t - i * 86400000, updatedAt: t - i * 86400000
    });
  }
  goals.push({ id: 'g1', title: 'Read 12 books', target: 12, progress: 5, createdAt: t - 5 * 86400000 });
  todos.push({ id: 't1', text: 'Water the plants', done: false, createdAt: t - 86400000 });
  todos.push({ id: 't2', text: 'Call the dentist', done: true, createdAt: t - 2 * 86400000, completedAt: t - 86400000 });
  localStorage.setItem('praze.brain.v1', JSON.stringify({ schemaVersion: 2, rev: 1, notes, goals, todos }));
  localStorage.setItem('praze.brain.onboarded', '1');
})()`;

/* Runs in the page. Collects what is PAINTED, which is not the same as what is
   in the layout tree — see checkVisibility below. */
const COLLECT = (tabName) => {
  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;
    /* A closed <details> keeps a layout box for its contents — Chromium uses
       content-visibility rather than display:none so find-in-page can still
       reach them. getBoundingClientRect happily reports 342x84 for text nobody
       can see, which inflated the counts in an earlier comparison. This is the
       general form of that fix: checkVisibility() knows about
       content-visibility, visibility and display alike. */
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return;
    out.push([
      tabName, el.tagName, el.id || '',
      typeof el.className === 'string' ? el.className : '',
      Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)
    ].join('|'));
  });
  return out;
};

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') opts.root = argv[++i];
    else if (argv[i] === '--viewport') opts.viewport = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

async function snap(outFile, opts) {
  let viewport = PHONE;
  if (opts.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(opts.viewport);
    if (!m) throw new Error('--viewport wants WxH, e.g. 1440x900');
    viewport = { width: +m[1], height: +m[2] };
  }
  const isPhone = viewport.width <= 500;
  const root = opts.root ? path.resolve(opts.root) : null;

  const server = await serve(PORT, root);
  const browser = await chromium.launch();
  const ctx = await browser.newContext(
    Object.assign({ viewport }, isPhone ? { isMobile: true, hasTouch: true } : {}));
  const page = await ctx.newPage();

  await page.goto('http://localhost:' + PORT + '/brain.html');
  await page.evaluate(SEED);
  await page.reload();                       // seed, then reload — never hash-nav
  await page.waitForTimeout(600);

  const rows = [];
  for (const tab of TABS) {
    await page.evaluate(h => { location.hash = h; }, '#' + tab);
    // the graph runs a physics sim and a camera ease; everything else just
    // needs its fonts to settle
    await page.waitForTimeout(tab === 'graph' ? 3000 : 700);
    rows.push(...await page.evaluate(COLLECT, tab));
  }

  await browser.close();
  server.close();

  const body = rows.join('\n');
  fs.writeFileSync(outFile, body);
  console.log('root      ' + (root || '(this checkout)'));
  console.log('viewport  ' + viewport.width + 'x' + viewport.height);
  console.log('elements  ' + rows.length);
  console.log('hash      ' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16));
  console.log('written   ' + outFile);
}

function diff(aFile, bFile) {
  const parse = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    const p = l.split('|');
    return { key: p.slice(0, 4).join('|'), tab: p[0], tag: p[1], id: p[2], cls: p[3],
             left: +p[4], top: +p[5], w: +p[6], h: +p[7] };
  });
  const A = parse(aFile), B = parse(bFile);
  const hash = rows => crypto.createHash('sha256')
    .update(rows.map(r => [r.key, r.left, r.top, r.w, r.h].join('|')).join('\n'))
    .digest('hex').slice(0, 16);

  const hA = hash(A), hB = hash(B);
  console.log(aFile + '  ' + A.length + ' elements  ' + hA);
  console.log(bFile + '  ' + B.length + ' elements  ' + hB);
  if (hA === hB) { console.log('\nIDENTICAL — layout unchanged'); return 0; }

  /* Horizontal vs vertical is the distinction that matters in practice. A
     density or spacing pass is allowed to move things down; it is not allowed
     to change where content sits across the page. Separating the two turns
     "the hash differs" into something you can act on. */
  const index = rows => rows.reduce((m, r) => ((m[r.key] = m[r.key] || []).push(r), m), {});
  const ia = index(A), ib = index(B);
  const horizontal = [], vertical = [], removed = [], added = [];

  for (const k of Object.keys(ia)) {
    const a = ia[k], b = ib[k] || [];
    for (let i = 0; i < a.length; i++) {
      if (!b[i]) { removed.push(a[i]); continue; }
      if (a[i].left !== b[i].left || a[i].w !== b[i].w) {
        horizontal.push({ k, from: a[i].left + '+' + a[i].w, to: b[i].left + '+' + b[i].w });
      } else if (a[i].top !== b[i].top || a[i].h !== b[i].h) {
        vertical.push({ k, from: a[i].top + '+' + a[i].h, to: b[i].top + '+' + b[i].h });
      }
    }
  }
  for (const k of Object.keys(ib)) {
    const a = ia[k] || [], b = ib[k];
    for (let i = a.length; i < b.length; i++) added.push(b[i]);
  }

  const tally = rows => {
    const m = {};
    rows.forEach(r => { const k = r.tag + (r.cls ? '.' + r.cls.split(' ')[0] : r.id ? '#' + r.id : ''); m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((x, y) => y[1] - x[1]);
  };

  console.log('\nDIFFERENT');
  console.log('  horizontal (left/width): ' + horizontal.length + '   <-- reflow; usually the one that matters');
  horizontal.slice(0, 20).forEach(m => console.log('      ' + m.k + '   ' + m.from + ' -> ' + m.to));
  console.log('  vertical (top/height):   ' + vertical.length);
  vertical.slice(0, 10).forEach(m => console.log('      ' + m.k + '   ' + m.from + ' -> ' + m.to));
  console.log('  removed: ' + removed.length);
  tally(removed).slice(0, 12).forEach(([k, n]) => console.log('      ' + n + 'x  ' + k));
  console.log('  added:   ' + added.length);
  tally(added).slice(0, 12).forEach(([k, n]) => console.log('      ' + n + 'x  ' + k));
  return 1;
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

if (cmd === 'snap' && positional[1]) {
  snap(positional[1], opts).catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'diff' && positional[1] && positional[2]) {
  process.exit(diff(positional[1], positional[2]));
} else {
  console.error('usage:\n' +
    '  node geometry.js snap <out.txt> [--root DIR] [--viewport 390x844]\n' +
    '  node geometry.js diff <a.txt> <b.txt>');
  process.exit(2);
}
