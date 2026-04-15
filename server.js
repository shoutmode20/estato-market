const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // Parses JSON request bodies

// Initialize Firebase Admin
try {
    let serviceAccount;
    // Load credentials from the secure JSON file
    if (fs.existsSync('./serviceAccountKey.json')) {
        serviceAccount = require('./serviceAccountKey.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Fallback for cloud deployments (Render, Heroku)
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        throw new Error('Service Account Configuration not provided.');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // Since we are using RTDB, you should define your database URL (found in Firebase console)
        databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com` 
    });

    console.log('[Firebase Admin] Successfully initialized.');
} catch (error) {
    console.warn('[Firebase Admin] Initialization failed. API routes dependent on Admin SDK may fail:', error.message);
}

// ---------------------------------------------------------
// REST API Routes
// ---------------------------------------------------------

// Health / Status Check Endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        firebase_admin: admin.apps.length > 0 ? 'connected' : 'disconnected',
        message: 'Estato Node.js Hybrid Backend is running successfully.'
    });
});

// Example Authorized Route (Requires Firebase Admin)
app.get('/api/stats', async (req, res) => {
    try {
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });
        
        const db = admin.database();
        const usersSnap = await db.ref('users').once('value');
        const propertiesSnap = await db.ref('properties').once('value');
        
        res.json({
            total_users: usersSnap.numChildren(),
            total_properties: propertiesSnap.numChildren()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch platform stats directly via admin backend.' });
    }
});

// ---------------------------------------------------------
// Static Local Hosting
// ---------------------------------------------------------

// Serve all static files from this root directory
app.use(express.static(path.join(__dirname, '.')));

// Fallback to index.html for Single Page Applications (SPA)
app.use((req, res, next) => {
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
