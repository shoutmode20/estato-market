const CACHE_NAME = 'estato-v12.7';
const ASSETS = [
    './',
    './index.html',
    './css/styles.css',
    './js/config.js',
    './js/app.v12.js?v=12.7',
    './js/storage.js?v=12.7',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.9.0/firebase-database-compat.js',
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'
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
    // This ensures POST uploads and ALL external APIs (Google Drive, Nominatim Location Search, Unsplash) go through Network
    if (event.request.method !== 'GET' || url.origin !== location.origin) {
        return; 
    }

    event.respondWith(
        caches.match(event.request).then((res) => {
            return res || fetch(event.request);
        })
    );
});
