/* Screenshots a view at a phone viewport, light and dark. Not a test — a way
   to actually look at a change, which caught more than one thing assertions
   alone did not.

   Run:  node screenshot.js [hash] [outPrefix]
   e.g.  node screenshot.js dashboard dash
*/
const { chromium } = require('playwright');
const { serve, seedScript, PHONE } = require('./lib/harness');

const PORT = 8132;
const hash = process.argv[2] || 'dashboard';
const prefix = process.argv[3] || hash;

(async () => {
  const server = await serve(PORT);
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto('http://localhost:' + PORT + '/brain.html');
    await page.evaluate(seedScript({ theme }));
    await page.reload();                       // reload, never hash-nav
    if (hash !== 'dashboard') {
      await page.evaluate(h => { location.hash = h; }, '#' + hash);
    }
    await page.waitForTimeout(500);            // let fonts settle before shooting
    await page.screenshot({ path: prefix + '-' + theme + '.png' });
    await ctx.close();
    console.log('wrote ' + prefix + '-' + theme + '.png');
  }
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
