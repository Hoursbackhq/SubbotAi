const CACHE_NAME = 'subbot-v3';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/popup.js',
  '/tailwind.js',
  '/tailwind-config.js',
  '/manifest.json',
];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch — cache-first for static, network-only for API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-only for API calls
  if (url.pathname.startsWith('/subs') ||
      url.pathname.startsWith('/scan') ||
      url.pathname.startsWith('/vault') ||
      url.pathname.startsWith('/charge') ||
      url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/history') ||
      url.pathname.startsWith('/decisions') ||
      url.pathname.startsWith('/gooddollar') ||
      url.pathname.startsWith('/audit') ||
      url.pathname.startsWith('/export') ||
      url.pathname.startsWith('/budget') ||
      url.pathname.startsWith('/add-sub') ||
      url.pathname.startsWith('/negotiate') ||
      url.pathname.startsWith('/balance') ||
      url.pathname.startsWith('/deduct') ||
      url.pathname.startsWith('/sync') ||
      url.pathname.startsWith('/log-decision') ||
      url.pathname.startsWith('/charge-mode')) {
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// Listen for periodic sync
self.addEventListener('periodicsync', e => {
  if (e.tag === 'refresh-data') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'refresh-data' }));
      })
    );
  }
});
