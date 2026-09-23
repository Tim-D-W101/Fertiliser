/*
 * Offline shell — the same approach as Tikita.
 *
 * Every same-origin request is network-first with a short timeout, falling
 * back to the cache. Online, the tablet always opens the newest deployed
 * version; on a bad signal, or none, it falls back to the last cached copy
 * after NETWORK_TIMEOUT rather than hanging.
 *
 * Bump CACHE when the asset list below changes.
 */
var CACHE = 'fertiliser-v1';
var NETWORK_TIMEOUT = 2500;

var ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './xlsx.js',
  './sync.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function networkFirst(request, cacheKey) {
  return new Promise(function (resolve) {
    var settled = false;

    function settle(response) {
      if (settled || !response) return false;
      settled = true;
      resolve(response);
      return true;
    }

    var timer = setTimeout(function () {
      if (settled) return;
      caches.match(cacheKey).then(settle);
    }, NETWORK_TIMEOUT);

    fetch(request).then(function (response) {
      clearTimeout(timer);
      if (response && response.status === 200 && response.type === 'basic') {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(cacheKey, copy); });
      }
      settle(response);
    }).catch(function () {
      clearTimeout(timer);
      caches.match(cacheKey).then(function (hit) {
        if (!settle(hit)) {
          settled = true;
          resolve(Response.error());
        }
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // A navigation may arrive as '/', '/index.html' or a deep link; they all
  // resolve to the one shell document in the cache.
  var cacheKey = (request.mode === 'navigate') ? './index.html' : request;
  event.respondWith(networkFirst(request, cacheKey));
});
