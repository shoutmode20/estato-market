const CACHE_NAME = 'estato-v12.4';
const ASSETS = [
    './',
    './index.html',
    './index.css',
    './js/app.v12.js',
    './js/storage.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // STRICT BYPASS: Only cache GET requests from our own origin
    // This ensures POST uploads and external APIs (Google Drive) are never intercepted by the cache logic
    if (event.request.method !== 'GET' || url.origin.includes('googleapis.com')) {
        return; 
    }

    event.respondWith(
        caches.match(event.request).then((res) => {
            return res || fetch(event.request);
        })
    );
});
