/* Shared plumbing for the verification suites.
 *
 * The app has no build step and no dependencies; that is deliberate and must
 * stay true. So npm lives in test/ only — nothing here is needed to run,
 * serve or ship the app itself.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// test/lib/harness.js -> repo root
const ROOT = path.resolve(__dirname, '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

/* A static server over the repo root. Suites need a real http origin: the app
   keys everything off localStorage, and file:// gives an opaque origin. */
function serve(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'brain.html';
    const file = path.join(ROOT, rel);
    // never serve outside the repo, however the path was spelled
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

/* Assertions. Deliberately not an assert library: a suite should report every
   failure in one run, not die on the first one. */
function makeChecker() {
  const state = { pass: 0, fail: 0 };
  function check(name, ok, detail) {
    if (ok) { state.pass++; console.log('  PASS  ' + name); }
    else {
      state.fail++;
      console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail));
    }
  }
  check.summary = function (title) {
    console.log('\n' + title + ': ' + state.pass + ' passed, ' + state.fail + ' failed');
    return state.fail;
  };
  return check;
}

/* Seeds the store directly. Callers MUST page.reload() afterwards — setting
   location.hash from the same page is a same-document navigation and does not
   re-run the app, which has caught out several test-writing passes. */
function seedScript(opts) {
  const o = opts || {};
  return `(() => {
    const now = Date.now();
    const notes = [];
    for (let i = 0; i < ${o.notes === undefined ? 2 : o.notes}; i++) {
      notes.push({ id: 'seed' + i, title: 'Seed ' + i, body: 'protein training content ' + i,
        tags: [], pinned: false, kind: 'idea', createdAt: now - i * 1000, updatedAt: now - i * 1000 });
    }
    localStorage.setItem('praze.brain.v1', JSON.stringify({
      schemaVersion: 2, rev: 1, notes, goals: [], todos: []
    }));
    localStorage.setItem('praze.brain.onboarded', '1');
    ${o.theme ? `localStorage.setItem('praze.brain.theme', ${JSON.stringify(o.theme)});` : ''}
  })()`;
}

const PHONE = { width: 390, height: 844 };

module.exports = { ROOT, serve, makeChecker, seedScript, PHONE };
