const express = require('express');
const router = express.Router();
const admin = require('../helpers/firebase');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog, writeWalletTransaction } = require('../helpers/audit');

// --- Join Auction ---
router.post('/entry', requireAuth, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const userId = req.user.uid;
        
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });
        const db = admin.database();

        const [userSnap, propSnap] = await Promise.all([
            db.ref(`users/${userId}`).once('value'),
            db.ref(`properties/${propertyId}`).once('value')
        ]);

        const user = userSnap.val();
        const prop = propSnap.val();

        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.isBanned) return res.status(403).json({ error: 'Your account is banned due to multiple auction defaults.' });
        if (!prop || !prop.bidding || !prop.bidding.enabled) {
            return res.status(400).json({ error: 'Bidding is not enabled for this property.' });
        }
        if (prop.ownerId === userId) {
            return res.status(403).json({ error: 'You cannot participate in an auction for your own property.' });
        }
        if (prop.bidding.participants && prop.bidding.participants[userId]) {
            return res.json({ success: true, message: 'Already joined.' });
        }

        const fee = Number(prop.bidding.entryFee || 0);
        if ((user.balance || 0) < fee) {
            return res.status(400).json({ error: `Insufficient balance. Entry fee is ₹${fee.toLocaleString()}.` });
        }

        const participantData = {
            joinedAt: new Date().toISOString(),
            userName: req.user.name || user.name || 'Estato User',
            paidFee: fee
        };
        await db.ref(`properties/${propertyId}/bidding/participants/${userId}`).set(participantData);

        if (fee > 0) {
            await db.ref(`users/${userId}/balance`).set(
                admin.database.ServerValue.increment(-fee)
            );
            await writeWalletTransaction(userId, 'ENTRY_FEE', -fee,
                `Entry fee paid for auction: ${prop.title || propertyId}`,
                { propertyId, propertyTitle: prop.title || propertyId }
            );
        }

        writeAuditLog(req, 'AUCTION_ENTRY_FEE_PAID', `User joined auction for property ${propertyId}`, { propertyId, fee });
        res.json({ success: true });
    } catch (err) {
        console.error('[API /bidding/entry]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Place Bid ---
router.post('/place', requireAuth, async (req, res) => {
    try {
        const { propertyId, amount } = req.body;
        const userId = req.user.uid;
        const bidAmount = Number(amount);
        
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });
        const db = admin.database();

        if (isNaN(bidAmount) || bidAmount <= 0) {
            return res.status(400).json({ error: 'Bid amount must be a positive number.' });
        }

        const [userSnap, propSnap] = await Promise.all([
            db.ref(`users/${userId}`).once('value'),
            db.ref(`properties/${propertyId}`).once('value')
        ]);
        const userData = userSnap.val();
        const propData = propSnap.val();

        if (!userData || userData.isBanned) return res.status(403).json({ error: 'Access denied.' });
        if (!propData || !propData.bidding || !propData.bidding.enabled || propData.ownerId === userId) {
            return res.status(400).json({ error: 'Invalid auction.' });
        }
        if (!propData.bidding.participants || !propData.bidding.participants[userId]) {
            return res.status(400).json({ error: 'You must join the auction first.' });
        }
        const nowTs = Date.now();
        const startTs = new Date(propData.bidding.startTime).getTime();
        const endTs = new Date(propData.bidding.endTime).getTime();
        if (nowTs < startTs) return res.status(400).json({ error: 'Auction has not started yet.' });
        if (nowTs >= endTs) return res.status(400).json({ error: 'Auction has already ended.' });

        const currentHighest = Number(propData.highestBid || propData.bidding.basePrice || 0);
        const minIncrement = Number(propData.bidding.minIncrement || 10000);
        if (bidAmount < currentHighest + minIncrement) {
            return res.status(400).json({ error: `Minimum bid is ₹${(currentHighest + minIncrement).toLocaleString('en-IN')}.` });
        }
        if ((userData.balance || 0) < bidAmount) {
            return res.status(400).json({ error: 'Insufficient wallet balance to place this bid.' });
        }

        const prevHighBidderId = propData.highestBidderId;
        const prevHighestAmount = currentHighest;
        const bidderName = req.user.name || userData.name || 'Estato User';
        const nowIso = new Date(nowTs).toISOString();

        const pRef = db.ref(`properties/${propertyId}`);
        const result = await pRef.transaction((p) => {
            if (!p) return p;
            if (!p.bidding || !p.bidding.enabled || p.ownerId === userId) return undefined;
            const pEndTs = new Date(p.bidding.endTime).getTime();
            if (nowTs >= pEndTs) return undefined;
            const pHighest = Number(p.highestBid || p.bidding.basePrice || 0);
            if (bidAmount < pHighest + Number(p.bidding.minIncrement || 10000)) return undefined;

            p.highestBid = bidAmount;
            p.highestBidderId = userId;
            p.highestBidderName = bidderName;
            if (!p.bids) p.bids = {};
            p.bids['bid_' + nowTs] = { userId, userName: bidderName, amount: bidAmount, timestamp: nowIso };

            const remainingSecs = (pEndTs - nowTs) / 1000;
            if (remainingSecs > 0 && remainingSecs < 30) {
                p.bidding.endTime = new Date(pEndTs + 60000).toISOString();
            }
            return p;
        });

        if (!result.committed) {
            return res.status(400).json({ error: 'Bid rejected: You were outbid or auction ended.' });
        }

        const walletUpdates = {};
        walletUpdates[`users/${userId}/balance`] = admin.database.ServerValue.increment(-bidAmount);
        if (prevHighBidderId && prevHighestAmount > 0) {
            walletUpdates[`users/${prevHighBidderId}/balance`] = admin.database.ServerValue.increment(prevHighestAmount);
        }
        await db.ref('/').update(walletUpdates);

        const propTitle = result.snapshot.val()?.title || propertyId;
        await writeWalletTransaction(userId, 'BID_PLACED', -bidAmount,
            `Bid placed on: ${propTitle}`,
            { propertyId, propertyTitle: propTitle, bidAmount }
        );
        if (prevHighBidderId && prevHighestAmount > 0 && prevHighBidderId !== userId) {
            await writeWalletTransaction(prevHighBidderId, 'BID_REFUND', prevHighestAmount,
                `Outbid refund for: ${propTitle}`,
                { propertyId, propertyTitle: propTitle, refundAmount: prevHighestAmount }
            );
        }

        writeAuditLog(req, 'BID_PLACED', `User placed bid of ₹${bidAmount.toLocaleString('en-IN')} on property ${propertyId}`, { propertyId, bidAmount, prevHighBidderId, prevHighestAmount });
        res.json({ success: true });
    } catch (err) {
        console.error('[API /bidding/place]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Finalize Auction ---
router.post('/finalize', requireAuth, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const db = admin.database();

        const pRef = db.ref(`properties/${propertyId}`);
        const result = await pRef.transaction((p) => {
            if (!p) return p;
            if (!p.bidding || !p.bidding.enabled) return undefined;
            if (p.status === 'Sold' || p.status === 'PaymentPending' || p.bidding.finalized) return undefined;

            const winnerId = p.highestBidderId;
            p.status = winnerId ? 'Sold' : 'Available';
            p.bidding.finalized = true;
            p.winnerId = winnerId || null;
            p.winnerName = p.highestBidderName || 'No Bids';
            
            if (winnerId) {
                p.bidding.paymentFinalizedAt = new Date().toISOString();
            }
            return p;
        });

        if (!result.committed) return res.status(400).json({ error: 'Finalize failed or already finalized.' });

        const p = result.snapshot.val();
        const updates = {};
        const winnerId = p.winnerId;
        const finalPrice = Number(p.highestBid || p.bidding.basePrice || 0);

        if (winnerId) {
            if (p.ownerId) updates[`users/${p.ownerId}/balance`] = admin.database.ServerValue.increment(finalPrice);
            updates[`users/${winnerId}/reputation`] = admin.database.ServerValue.increment(0.1);
        }

        const participants = p.bidding.participants || {};
        for (const [pId, pData] of Object.entries(participants)) {
            if (pId !== winnerId) {
                const refund = Number(pData.paidFee || 0);
                if (refund > 0) updates[`users/${pId}/balance`] = admin.database.ServerValue.increment(refund);
            }
        }

        if (Object.keys(updates).length > 0) {
            await db.ref('/').update(updates);
        }

        writeAuditLog(req, 'AUCTION_FINALIZED', `Auction finalized for property ${propertyId}. Winner: ${p.winnerId || 'None'}`, { propertyId, winnerId: p.winnerId, finalPrice: p.highestBid });
        res.json({ success: true });
    } catch (err) {
        console.error('[API finalize]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Confirm Payment ---
router.post('/confirm', requireAuth, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const db = admin.database();

        const pRef = db.ref(`properties/${propertyId}`);
        const result = await pRef.transaction((p) => {
            if (!p) return p;
            if (p.status !== 'PaymentPending') return undefined;

            p.status = 'Sold';
            p.bidding.paymentFinalizedAt = new Date().toISOString();
            return p;
        });

        if (!result.committed) return res.status(400).json({ error: 'Confirm failed.' });

        const p = result.snapshot.val();
        if (p.winnerId) {
            await db.ref(`users/${p.winnerId}/reputation`).set(admin.database.ServerValue.increment(0.1));
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API confirm]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Process Default (Non-payment) ---
router.post('/default', requireAuth, async (req, res) => {
    try {
        const { propertyId } = req.body;
        const db = admin.database();

        const pRef = db.ref(`properties/${propertyId}`);
        const result = await pRef.transaction((p) => {
            if (!p) return p;
            if ((p.status !== 'Sold' && p.status !== 'PaymentPending') || !p.winnerId) return undefined;

            const winnerId = p.winnerId;
            const defaulted = p.bidding.defaultedBidders || [];
            if (!defaulted.includes(winnerId)) defaulted.push(winnerId);
            p.bidding.defaultedBidders = defaulted;
            
            p.status = 'Available';
            p.bidding.finalized = false;
            p.winnerId = null;
            p.winnerName = null;

            return p;
        });

        if (!result.committed) return res.status(400).json({ error: 'Default processing failed.' });

        const p = result.snapshot.val();
        const defaultedBidders = p.bidding.defaultedBidders || [];
        const lastDefaultedId = defaultedBidders[defaultedBidders.length - 1];

        if (lastDefaultedId) {
            const updates = {};
            updates[`users/${lastDefaultedId}/strikes`] = admin.database.ServerValue.increment(1);
            updates[`users/${lastDefaultedId}/reputation`] = admin.database.ServerValue.increment(-1.0);
            await db.ref('/').update(updates);
            
            const userSnap = await db.ref(`users/${lastDefaultedId}`).once('value');
            const userData = userSnap.val();
            if (userData && userData.strikes >= 3) {
                await db.ref(`users/${lastDefaultedId}/isBanned`).set(true);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API default]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
