const CACHE_NAME = 'estato-v1';
const ASSETS = [
    './',
    './index.html',
    './index.css',
    './js/app.v12.js',
    './js/storage.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (event) => {
    event.respondWith(caches.match(event.request).then((res) => res || fetch(event.request)));
});
