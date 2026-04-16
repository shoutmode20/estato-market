require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Allowed origins for CORS — add your production domain here when deploying
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.PRODUCTION_ORIGIN  // Set via env var for production deployments
].filter(Boolean);

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman) or from allowed list
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: Origin '${origin}' not allowed.`));
        }
    },
    credentials: true
}));
app.use(express.json());

// Initialize Firebase Admin
try {
    let serviceAccount;
    if (fs.existsSync('./serviceAccountKey.json')) {
        serviceAccount = require('./serviceAccountKey.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        throw new Error('Service Account Configuration not provided.');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
    });

    console.log('[Firebase Admin] Successfully initialized.');
} catch (error) {
    console.warn('[Firebase Admin] Initialization failed. API routes dependent on Admin SDK may fail:', error.message);
}

// ---------------------------------------------------------
// Auth Middleware — verifies Firebase ID token from Authorization header
// ---------------------------------------------------------
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        req.user = await admin.auth().verifyIdToken(idToken);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
    }
}

// ---------------------------------------------------------
// REST API Routes
// ---------------------------------------------------------

// Health / Status Check Endpoint (public)
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        firebase_admin: admin.apps.length > 0 ? 'connected' : 'disconnected',
        message: 'Estato Node.js Hybrid Backend is running successfully.'
    });
});

// Platform Stats — requires a valid Firebase auth token
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });

        const db = admin.database();
        const [usersSnap, propertiesSnap] = await Promise.all([
            db.ref('users').once('value'),
            db.ref('properties').once('value')
        ]);

        res.json({
            total_users: usersSnap.numChildren(),
            total_properties: propertiesSnap.numChildren()
        });
    } catch (err) {
        console.error('[API /stats]', err);
        res.status(500).json({ error: 'Failed to fetch platform stats.' });
    }
});

// Admin Registration Endpoint — strictly requires authorized email
app.post('/api/make-admin', requireAuth, async (req, res) => {
    try {
        // In production, set ADMIN_EMAILS in your environment variables as a comma-separated list.
        // e.g. ADMIN_EMAILS="admin@example.com,ceo@example.com"
        const allowedStr = process.env.ADMIN_EMAILS || 'your-email@example.com'; 
        const allowedEmails = allowedStr.split(',').map(e => e.trim().toLowerCase());
        const userEmail = req.user.email ? req.user.email.toLowerCase() : '';

        if (!allowedEmails.includes(userEmail)) {
            return res.status(403).json({ error: 'Access Denied: Your email is not authorized for Admin registration.' });
        }

        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });

        const db = admin.database();
        // Forcefully write the Admin role using the Admin SDK (bypassing client rule blocks)
        await db.ref('users/' + req.user.uid + '/role').set('Admin');

        res.json({ success: true, message: 'Admin role granted securely.' });
    } catch (err) {
        console.error('[API /make-admin]', err);
        res.status(500).json({ error: 'Failed to assign Admin role.' });
    }
});

// Catch-all for unmatched /api routes — return JSON 404, not index.html
app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route '${req.path}' not found.` });
});

// ---------------------------------------------------------
// Static Local Hosting
// ---------------------------------------------------------

// Serve all static files from this root directory
app.use(express.static(path.join(__dirname, '.')));

// SPA fallback — only for non-API routes
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Estato Server running on port ${PORT}`);
    console.log(`🌐 Application: http://localhost:${PORT}`);
    console.log(`📡 API Status : http://localhost:${PORT}/api/status`);
    console.log(`========================================`);
});
