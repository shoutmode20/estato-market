require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('./server/helpers/firebase');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS Configuration ---
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.PRODUCTION_ORIGIN
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        if (origin.endsWith('.vercel.app') || origin.endsWith('.web.app') || origin.endsWith('.firebaseapp.com')) return callback(null, true);
        callback(new Error(`CORS: Origin '${origin}' not allowed.`));
    },
    credentials: true
}));

app.use(express.json());

// --- Security Headers (Helmet-Lite) ---
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Enable HSTS in production
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

const isProd = process.env.NODE_ENV === 'production';
const staticDir = isProd ? 'public' : 'src';

// --- Static Asset Serving ---
app.use(express.static(path.join(__dirname, staticDir), {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=300');
        } else if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// Add a special route for /dist when in dev mode (since dist is in root, not src)
if (!isProd) {
    app.use('/dist', express.static(path.join(__dirname, 'dist')));
}

// --- Route Mounting ---
app.use('/api', require('./server/api/admin'));
app.use('/api/bidding', require('./server/api/bidding'));
app.use('/api/broker', require('./server/api/broker'));
app.use('/property', (req, res, next) => {
    // Pass the correct index path to the SSR module
    req.indexPath = path.join(__dirname, staticDir, 'index.html');
    next();
}, require('./server/api/ssr'));

// --- Catch-all / Global Handlers ---
app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route '${req.path}' not found.` });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, staticDir, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 Estato Server v12.1 is running at http://localhost:${PORT}`);
    console.log(`📂 Serving static assets from: ${path.join(__dirname, 'public')}\n`);
});

module.exports = app;
