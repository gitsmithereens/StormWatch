// StormWatch service worker — caches only the app SHELL (this page + its CDN libraries),
// so a cold load with no connectivity still opens. It deliberately does NOT touch
// requests to weather/radar APIs (api.weather.gov, spc.noaa.gov, mesonet.agron.iastate.edu,
// tidesandcurrents.noaa.gov, blitzortung, etc.) — the page's own JS already has a more
// careful, alert-expiry-aware caching strategy for that live data via localStorage.
const CACHE_NAME = 'stormwatch-shell-v2';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/lucide@1.8.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

const SHELL_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(SHELL_URLS.map(u => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  if (url.origin === self.location.origin) return true;
  return SHELL_HOSTS.includes(url.hostname);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only handle the app shell. Everything else (live weather/radar data) passes through
  // untouched, so the page's existing fetch/cache/fallback logic keeps working exactly
  // as it already does.
  if (event.request.method !== 'GET' || !isShellRequest(url)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(resp => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached); // offline and not cached — nothing more we can do
      // Stale-while-revalidate: serve cache immediately if we have it, refresh in background.
      return cached || networkFetch;
    })
  );
});
