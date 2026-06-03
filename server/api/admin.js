const express = require('express');
const router = express.Router();
const admin = require('../helpers/firebase');
const { requireAuth } = require('../middleware/auth');

// --- Platform Status ---
router.get('/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        firebase_admin: admin.apps.length > 0 ? 'connected' : 'disconnected',
        message: 'Estato Node.js Hybrid Backend is running successfully.'
    });
});

// --- Platform Stats ---
router.get('/stats', requireAuth, async (req, res) => {
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

// --- Admin Role Assignment ---
router.post('/make-admin', requireAuth, async (req, res) => {
    try {
        const allowedStr = process.env.ADMIN_EMAILS || 'your-email@example.com'; 
        const allowedEmails = allowedStr.split(',').map(e => e.trim().toLowerCase());
        const userEmail = req.user.email ? req.user.email.toLowerCase() : '';

        if (!allowedEmails.includes(userEmail)) {
            return res.status(403).json({ error: 'Access Denied: Your email is not authorized for Admin registration.' });
        }

        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });

        const db = admin.database();
        await db.ref('users/' + req.user.uid + '/role').set('Admin');

        res.json({ success: true, message: 'Admin role granted securely.' });
    } catch (err) {
        console.error('[API /make-admin]', err);
        res.status(500).json({ error: 'Failed to assign Admin role.' });
    }
});

// --- Audit Logs ---
router.post('/audit', requireAuth, async (req, res) => {
    try {
        const { action, details, metadata } = req.body;
        const logEntry = {
            timestamp: new Date().toISOString(),
            userId: req.user.uid,
            userEmail: req.user.email,
            action,
            details,
            metadata: metadata || {}
        };

        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });
        await admin.database().ref('audit_logs').push(logEntry);
        res.json({ success: true });
    } catch (err) {
        console.error('[API /audit POST]', err);
        res.status(500).json({ error: 'Failed to record audit log.' });
    }
});

router.get('/audit', requireAuth, async (req, res) => {
    try {
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });

        const userSnap = await admin.database().ref(`users/${req.user.uid}`).once('value');
        const userData = userSnap.val();
        
        if (!userData || userData.role !== 'Admin') {
            return res.status(403).json({ error: 'Access Denied: Admin privileges required.' });
        }

        const logsSnap = await admin.database().ref('audit_logs').orderByChild('timestamp').once('value');
        const logsData = logsSnap.val();
        let logs = [];
        if (logsData) {
            logs = Object.values(logsData);
            logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
        res.json(logs);
    } catch (err) {
        console.error('[API /audit GET]', err);
        res.status(500).json({ error: 'Failed to fetch audit logs.' });
    }
});

module.exports = router;
