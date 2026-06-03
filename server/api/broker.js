const express = require('express');
const router = express.Router();
const admin = require('../helpers/firebase');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../helpers/audit');

router.post('/claim', requireAuth, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const userId = req.user.uid;
        
        const db = admin.database();
        const userSnap = await db.ref(`users/${userId}`).once('value');
        const user = userSnap.val();

        if (!user || user.role !== 'Broker') {
            return res.status(403).json({ error: 'Only Brokers can claim listings.' });
        }

        const propRef = db.ref(`properties/${propertyId}`);
        const result = await propRef.transaction((p) => {
            if (!p) return p;
            if (!p.needsBroker || p.assignedBrokerId) return undefined; 

            p.assignedBrokerId = userId;
            p.needsBroker = false;
            return p;
        });

        if (!result.committed) {
            return res.status(400).json({ error: 'Claim failed: Listing may have already been claimed or no longer needs a broker.' });
        }

        writeAuditLog(req, 'BROKER_CLAIMED_LISTING', `Broker ${userId} claimed listing ${propertyId}`, { propertyId });
        res.json({ success: true });
    } catch (err) {
        console.error('[API /broker/claim]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
