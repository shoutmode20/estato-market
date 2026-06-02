const CACHE_NAME = 'estato-v16.0';
const IMG_CACHE_NAME = 'estato-images-v1';
const ASSETS = [
    './',
    './index.html',
    './css/styles.css',
    './js/config.js',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-database-compat.js',
    './dist/auctions-5U2BI5PZ.js',
    './dist/bundle.min.js',
    './dist/chunk-JEB5J5IO.js',
    './dist/chunk-WD42TXT6.js',
    './dist/crm-YETSDAY6.js',
    './dist/dashboard-H4HIVRPR.js',
    './dist/main.js',
    './dist/messaging-SPBI5MS2.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME && key !== IMG_CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // ── Cross-origin image caching (Google Drive, Unsplash, etc.) ──
    // Use stale-while-revalidate: serve cached image instantly, then update cache in background
    const isImage = event.request.destination === 'image'
        || /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(url.pathname)
        || url.hostname.includes('googleusercontent.com')
        || url.hostname.includes('drive.google.com')
        || url.hostname.includes('unsplash.com');

    if (isImage && url.origin !== location.origin) {
        event.respondWith(
            caches.open(IMG_CACHE_NAME).then(async (cache) => {
                const cached = await cache.match(event.request);
                const fetchPromise = fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.ok) {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(() => cached); // If network fails, fall back to cache

                return cached || fetchPromise;
            })
        );
        return;
    }

    // ── Same-origin: Cache-first for static assets ──
    if (url.origin === location.origin) {
        event.respondWith(
            caches.match(event.request).then((res) => {
                return res || fetch(event.request);
            })
        );
        return;
    }

    // ── Other cross-origin (CDN scripts, fonts): Stale-while-revalidate ──
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);
            const fetchPromise = fetch(event.request).then((response) => {
                if (response && response.ok) {
                    cache.put(event.request, response.clone());
                }
                return response;
            }).catch(() => cached);

            return cached || fetchPromise;
        })
    );
});
