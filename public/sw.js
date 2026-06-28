const CACHE_NAME = 'subbot-v8';
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
      url.pathname.startsWith('/charge-mode') ||
      url.pathname.startsWith('/push')) {
    return;
  }

  // Stale-while-revalidate for shell assets — serve cached, refresh in background
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const fetched = fetch(e.request).then(resp => {
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fetched;
      })
    )
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

// ── Push Notifications ───────────────────────────────────────────────────

// Stored subscription data from popup.js
let renewalSubs = [];

// Handle push events (future server-side push support)
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'SubBot', {
      body: data.body || 'You have a subscription update',
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: data.tag || 'subbot-push',
      data: { url: data.url || '/' },
    })
  );
});

// Handle notification clicks — open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'nav', screen: 'alerts' });
      } else {
        self.clients.openWindow(url);
      }
    })
  );
});

// Receive subscription data from popup.js
self.addEventListener('message', e => {
  if (e.data?.type === 'schedule-renewals') {
    renewalSubs = e.data.subs || [];
    checkRenewals();
  }
  if (e.data?.type === 'budget-exceeded') {
    self.registration.showNotification(e.data.title || 'SubBot · Budget Exceeded', {
      body: e.data.body || 'Monthly spend has passed your budget',
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: 'budget-exceeded',
      data: { url: '/' },
    });
  }
});

// Check renewals and fire OS notifications
function checkRenewals() {
  if (!renewalSubs.length) return;
  const now = new Date();
  const notified = new Set(JSON.parse(self._notifiedKeys || '[]'));

  renewalSubs.forEach(sub => {
    if (!sub.next_renewal || sub.status !== 'active') return;
    const days = Math.ceil((new Date(sub.next_renewal) - now) / 86400000);
    const key = `${sub.id || sub.name}-${sub.next_renewal}-${days}`;

    if (notified.has(key)) return;
    if (days < 0 || days > 3) return;

    let body;
    if (days === 0) body = `${sub.name} renews TODAY — ${sub.currency || '$'}${sub.monthly_cost}/mo`;
    else if (days === 1) body = `${sub.name} renews TOMORROW — ${sub.currency || '$'}${sub.monthly_cost}/mo`;
    else body = `${sub.name} renews in ${days} days — ${sub.currency || '$'}${sub.monthly_cost}/mo`;

    self.registration.showNotification('SubBot · Renewal Alert', {
      body,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: `renewal-${sub.id || sub.name}-${days}`,
      data: { url: '/' },
      renotify: true,
    });

    notified.add(key);
  });

  self._notifiedKeys = JSON.stringify([...notified]);
}

// Check renewals every hour
setInterval(checkRenewals, 60 * 60 * 1000);
