/* Android back button — the layer stack and the history entry behind it.
 *
 * The design (HANDOVER.md §5): while anything dismissible is open, the app
 * holds ONE spare history entry. Back consumes it, closes the topmost layer,
 * and immediately takes a fresh one if another layer is underneath. Depth does
 * not matter — `syncBackGuard` is idempotent, so three stacked panels still
 * cost exactly one entry.
 *
 * That gives a leak invariant that is actually measurable:
 *
 *     history.length must never exceed baseline + 1, for ANY sequence of
 *     opens and closes, however deep or however repeated.
 *
 * The other half is the race the original build was written to avoid: the
 * spare entry is NEVER popped asynchronously on close. An early version called
 * history.back() when a panel closed, which raced setView's hash push and
 * silently undid tab navigation. setView instead reuses the entry via
 * location.replace. §5 is explicit that this must not be "simplified", so the
 * ordering is exercised directly below rather than only the simple case.
 *
 * Run:  node verify-back.js
 */
const { chromium } = require('playwright');
const { serve, makeChecker, PHONE } = require('./lib/harness');

const PORT = 8137;
const check = makeChecker();

// a real 1x1 jpeg so the photo viewer has something to open
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
      { id: 'n1', title: 'First', body: 'one', tags: ['a'], pinned: false, kind: 'idea',
        createdAt: now - 3000, updatedAt: now - 3000 },
      { id: 'n2', title: 'Second', body: 'two', tags: ['a'], pinned: false, kind: 'idea',
        createdAt: now - 2000, updatedAt: now - 2000 },
      { id: 'd1', title: '', body: 'a day', tags: [], pinned: false, kind: 'diary',
        photo: photo, createdAt: now - 1000, updatedAt: now - 1000 }
    ],
    goals: [{ id: 'g1', title: 'A goal', target: 5, progress: 1, createdAt: now, completedAt: null }],
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
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(SEED, JPEG);
  await page.reload();                       // reload, never hash-nav
  await page.waitForSelector('.tabs');
  await page.waitForTimeout(700);            // let the photo migration settle

  console.log('\nBack button @ ' + PHONE.width + 'x' + PHONE.height);

  const hist = () => page.evaluate(() => history.length);
  const hash = () => page.evaluate(() => location.hash);
  // history.back() is async; popstate lands on a later task
  const back = async () => {
    await page.evaluate(() => history.back());
    await page.waitForTimeout(300);
  };
  const forward = async () => {
    await page.evaluate(() => history.forward());
    await page.waitForTimeout(300);
  };
  const open = () => page.evaluate(() => ({
    settings: !document.getElementById('settings-panel').hidden,
    palette: !document.getElementById('palette').hidden,
    photo: !document.getElementById('photo-view').hidden,
    graphSettings: !document.getElementById('graph-settings-panel').hidden,
    dump: !document.getElementById('dump-overlay').hidden,
    editor: !!document.querySelector('.note--editing'),
    confirm: !!document.querySelector('[data-action="delete-yes"], [data-action="goal-del-yes"]'),
    todoDue: !!document.querySelector('.todo__due-input'),
    select: !!document.querySelector('.note--selectable')
  }));
  const anyOpen = async () => Object.values(await open()).some(Boolean);

  const goTab = async (v) => {
    await page.evaluate(t => { location.hash = '#' + t; }, v);
    await page.waitForTimeout(250);
  };

  /* Park the cursor at the TIP of the history stack before measuring growth.
     This matters more than it looks: after any back() the cursor sits mid-stack,
     and a pushState there reuses a forward slot instead of extending, so
     history.length does not move and a leak assertion silently measures
     nothing. A mutation test caught exactly that — a deliberately leaking build
     passed until this was added. A real hash change truncates the forward
     entries and puts us back on the tip. */
  const toTip = async (tab) => {
    await goTab(tab === 'ideas' ? 'clips' : 'ideas');
    await goTab(tab);
  };

  /* ---------- 1. each layer closes via back, and costs exactly one entry ---- */
  const layers = [
    { name: 'settings', tab: 'ideas', openIt: async () => page.click('#settings-toggle') },
    { name: 'palette', tab: 'ideas', openIt: async () => page.keyboard.press('Control+k') },
    { name: 'editor', tab: 'ideas', openIt: async () => page.click('.note[data-id="n1"] [data-action="edit"]') },
    { name: 'confirm', tab: 'ideas', openIt: async () => page.click('.note[data-id="n1"] [data-action="delete-ask"]') },
    { name: 'select', tab: 'ideas', openIt: async () => page.click('#select-toggle') },
    { name: 'todoDue', tab: 'todos', openIt: async () => page.click('[data-action="todo-due-ask"]') },
    { name: 'photo', tab: 'diary', openIt: async () => page.click('[data-action="photo-open"]') },
    { name: 'graphSettings', tab: 'graph', openIt: async () => page.click('#graph-settings-toggle') }
  ];

  for (const l of layers) {
    await toTip(l.tab);
    const base = await hist();
    await l.openIt();
    await page.waitForTimeout(300);
    const afterOpen = await open();
    const grew = (await hist()) - base;
    check(l.name + ': opens', afterOpen[l.name] === true, JSON.stringify(afterOpen));
    // A ceiling, not an exact count: after an earlier back() the cursor sits
    // mid-stack, so pushState reuses the forward slot and length does not grow
    // at all. Growth of 0 is correct. What proves an entry is actually held is
    // the behavioural pair below — back closes the layer instead of the tab.
    check(l.name + ': costs at most one history entry', grew <= 1, 'grew by ' + grew);

    await back();
    const afterBack = await open();
    check(l.name + ': back closes it', afterBack[l.name] === false, JSON.stringify(afterBack));
    check(l.name + ': back did not change tab', (await hash()) === '#' + l.tab, await hash());
  }

  /* ---------- 2. stacked layers peel off topmost-first, still one entry ----- */
  await toTip('ideas');
  const stackBase = await hist();
  await page.click('.note[data-id="n1"] [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(250);
  const stacked = await open();
  check('stack: both editor and palette are open', stacked.editor && stacked.palette,
    JSON.stringify(stacked));
  check('stack: two layers still cost at most one entry',
    (await hist()) - stackBase <= 1, 'grew by ' + ((await hist()) - stackBase));

  await back();
  const afterFirst = await open();
  check('stack: back closes the TOPMOST layer first (palette, not editor)',
    afterFirst.palette === false && afterFirst.editor === true, JSON.stringify(afterFirst));
  check('stack: a fresh entry is held for the layer underneath — still no leak',
    (await hist()) - stackBase <= 1, 'grew by ' + ((await hist()) - stackBase));

  await back();
  const afterSecond = await open();
  check('stack: the next back closes the layer underneath',
    afterSecond.editor === false, JSON.stringify(afterSecond));
  check('stack: nothing is left open', !(await anyOpen()));

  /* ---------- 3. THE RACE ----------
     Closing a layer through its own UI must not pop the entry asynchronously.
     The original bug: setView closed the panel and pushed a hash while a
     history.back() was still in flight, and the landing pop silently undid the
     tab switch. So: open a panel, switch tab, and confirm the tab switch both
     happens AND survives — checked again after a delay, because a stray
     history.back() lands a beat later, which is exactly why it was missed. */
  await toTip('ideas');
  const raceBase = await hist();
  await page.click('#settings-toggle');
  await page.waitForTimeout(250);
  check('race: settings is open before the tab switch', (await open()).settings);

  await page.click('.tabs__tab[data-view="diary"]');
  await page.waitForTimeout(300);
  const immediate = await hash();
  check('race: the tab switch happened', immediate === '#diary', immediate);
  check('race: switching tabs closed the panel', !(await open()).settings);

  await page.waitForTimeout(700);            // long enough for a stray pop to land
  const settled = await hash();
  check('race: the tab switch SURVIVES — no async pop undid it',
    settled === '#diary', 'ended on ' + settled);
  check('race: the panel entry was reused, not stacked on top of',
    (await hist()) - raceBase <= 1, 'grew by ' + ((await hist()) - raceBase));

  /* The user-visible cost of stacking a tab on top of the spare entry rather
     than reusing it: the stranded entry sits between the two tabs, and the
     second back press lands on it and does nothing. Counting entries can miss
     this depending on where the cursor sits; walking back twice cannot. */
  await goTab('todos');
  await goTab('ideas');                      // history: … todos, ideas
  await page.click('#settings-toggle');
  await page.waitForTimeout(250);
  await page.click('.tabs__tab[data-view="diary"]');
  await page.waitForTimeout(400);
  await back();
  check('race: one back returns to the tab we left', (await hash()) === '#ideas', await hash());
  await back();
  check('race: the next back moves on — no stranded entry to waste a press on',
    (await hash()) === '#todos', 'ended on ' + (await hash()));

  /* ---------- 4. closing by UI leaves no dead back press ----------
     After a UI close the spare entry is deliberately still there — popping it
     eagerly is the race above. It must be consumed harmlessly: one back press
     should perform one real navigation, not be swallowed. */
  await goTab('ideas');
  await goTab('diary');                      // give ourselves a tab to go back to
  await page.click('#settings-toggle');
  await page.waitForTimeout(250);
  await page.click('#settings-toggle');      // close it again by its own button
  await page.waitForTimeout(250);
  check('ui-close: the panel is closed', !(await open()).settings);
  await back();
  check('ui-close: a single back press still navigates — no dead press',
    (await hash()) === '#ideas', 'ended on ' + (await hash()));

  /* ---------- 5. repeated cycles do not leak ---------- */
  await goTab('ideas');
  const cycleBase = await hist();
  let worstGrowth = 0;
  for (let i = 0; i < 5; i++) {
    await page.click('#settings-toggle');
    await page.waitForTimeout(180);
    worstGrowth = Math.max(worstGrowth, (await hist()) - cycleBase);
    await back();
    worstGrowth = Math.max(worstGrowth, (await hist()) - cycleBase);
  }
  check('cycles: five open/close rounds never exceed baseline + 1',
    worstGrowth <= 1, 'worst growth ' + worstGrowth);
  check('cycles: nothing left open at the end', !(await anyOpen()));
  check('cycles: still on the same tab', (await hash()) === '#ideas', await hash());

  /* ---------- 6. mixed sequence, opened and closed different ways ---------- */
  await goTab('ideas');
  const mixBase = await hist();
  await page.click('#select-toggle');                                  // open by button
  await page.waitForTimeout(150);
  await page.click('#settings-toggle');                                // stack a panel
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+k');                              // stack another
  await page.waitForTimeout(200);
  const deep = (await hist()) - mixBase;
  check('mixed: three stacked layers still cost one entry', deep <= 1, 'grew by ' + deep);
  await page.keyboard.press('Escape');                                 // close one by UI
  await page.waitForTimeout(200);
  await back();                                                        // close one by back
  await page.waitForTimeout(150);
  await back();                                                        // and the last
  await page.waitForTimeout(150);
  const mixGrowth = (await hist()) - mixBase;
  check('mixed: closing by UI and by back in the same sequence does not leak',
    mixGrowth <= 1, 'grew by ' + mixGrowth);
  check('mixed: still on the same tab', (await hash()) === '#ideas', await hash());

  /* ---------- 7. tab routing is unaffected when nothing is open ---------- */
  check('routing: nothing is open before the routing checks', !(await anyOpen()));
  await goTab('ideas');
  await page.click('.tabs__tab[data-view="todos"]');
  await page.waitForTimeout(250);
  await page.click('.tabs__tab[data-view="clips"]');
  await page.waitForTimeout(250);
  check('routing: tab clicks move the hash', (await hash()) === '#clips', await hash());
  await back();
  check('routing: back walks to the previous tab', (await hash()) === '#todos', await hash());
  await back();
  check('routing: back again walks one further', (await hash()) === '#ideas', await hash());

  /* ---------- 8. forward navigation still works ---------- */
  await forward();
  check('forward: returns to the tab we came back from',
    (await hash()) === '#todos', await hash());
  await forward();
  check('forward: and forward again', (await hash()) === '#clips', await hash());
  check('forward: no layer was opened by any of that', !(await anyOpen()));

  /* ---------- 9. the brain dump overlay ----------
     Its own context, because SpeechRecognition has to be stubbed before load.
     Asserts wiring only — §10 is emphatic that a green mock proves nothing
     about the real engine. */
  const dumpCtx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  await dumpCtx.addInitScript(() => {
    window.SpeechRecognition = function () {
      this.start = function () {}; this.stop = function () {};
      this.abort = function () {}; this.addEventListener = function () {};
    };
  });
  const dp = await dumpCtx.newPage();
  await dp.goto(url);
  await dp.evaluate(SEED, JPEG);
  await dp.reload();
  await dp.evaluate(() => { location.hash = '#ideas'; });
  await dp.waitForSelector('#dump-btn');
  const dumpBase = await dp.evaluate(() => history.length);
  await dp.click('#dump-btn');
  await dp.waitForSelector('#dump-overlay:not([hidden])');
  check('dump: opens', await dp.evaluate(() => !document.getElementById('dump-overlay').hidden));
  check('dump: costs exactly one history entry',
    (await dp.evaluate(() => history.length)) - dumpBase === 1);
  await dp.evaluate(() => history.back());
  await dp.waitForTimeout(300);
  check('dump: back closes the overlay',
    await dp.evaluate(() => document.getElementById('dump-overlay').hidden));
  check('dump: back did not leave the ideas tab',
    (await dp.evaluate(() => location.hash)) === '#ideas');
  await dumpCtx.close();

  await browser.close();
  server.close();
  process.exit(check.summary('back') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
