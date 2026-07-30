/* Second Brain service worker — makes the app installable and offline-capable.
   (The praze-brain-v1 cache name is a legacy internal namespace — keep it.)
   Network-first for the app's own files so an online device always gets the
   latest build; the cache is the offline fallback. Cross-origin requests
   (Google Fonts, the Claude API) are never touched — they pass straight to
   the network, so an offline device just loses fonts and AI, not the app. */

var CACHE = 'praze-brain-v1';

// Relative to the SW scope (the folder holding brain.html), so it works both
// at a domain root and under a project subpath like /praze-website/.
var CORE = [
  './brain.html',
  './styles.css',
  './brain.css',
  './brain-ai.js',
  './brain-graph.js',
  './brain.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  // self-hosted fonts: precached so a cold offline load renders in the real
  // typefaces rather than falling back to system fonts
  './fonts/archivo-black-400.woff2',
  './fonts/inter-latin.woff2',
  './fonts/space-mono-400.woff2',
  './fonts/space-mono-700.woff2'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // best-effort precache; a single 404 must not fail the whole install
    return Promise.all(CORE.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // only same-origin GETs are ours to cache; everything else (POST to Claude,
  // cross-origin fonts) goes to the network untouched
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      // refresh the cache with the fresh copy (clone before the body is read)
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // offline: serve cache, falling back to the app shell for navigations
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./brain.html');
      });
    })
  );
});
