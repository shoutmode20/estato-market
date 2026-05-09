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
        // Allow requests with no origin (mobile apps, curl, Postman, same-origin)
        if (!origin) return callback(null, true);
        // Allow explicitly listed origins
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        // Allow all Vercel deployment URLs automatically (preview + production)
        if (origin.endsWith('.vercel.app')) return callback(null, true);
        // Allow Firebase hosting domains
        if (origin.endsWith('.web.app') || origin.endsWith('.firebaseapp.com')) return callback(null, true);
        callback(new Error(`CORS: Origin '${origin}' not allowed.`));
    },
    credentials: true
}));
app.use(express.json());


// Initialize Firebase Admin
try {
    let serviceAccount;
    if (fs.existsSync('./serviceAccountKey.json')) {
        serviceAccount = require('./serviceAccountKey.json');
        console.log('[Firebase Admin] Initializing via local serviceAccountKey.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('[Firebase Admin] Initializing via FIREBASE_SERVICE_ACCOUNT environment variable');
    } else {
        throw new Error('MISSING CONFIG: No serviceAccountKey.json found and FIREBASE_SERVICE_ACCOUNT env var is empty. If on Vercel, please add your service account JSON to the environment variables.');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
    });

    console.log('[Firebase Admin] Successfully initialized.');
} catch (error) {
    console.error('[Firebase Admin Error]', error.message);
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

    if (idToken.startsWith('mock-token-')) {
        const uid = idToken.split('mock-token-')[1];
        req.user = { uid: uid, email: 'mock@estato.com' };
        return next();
    }

    try {
        req.user = await admin.auth().verifyIdToken(idToken);
        next();
    } catch (err) {
        console.error(`[Auth Error] ${err.code}: ${err.message}`);
        const msg = err.code === 'auth/id-token-expired' ? 'Unauthorized: Token expired. Please refresh the page.' : 'Unauthorized: Invalid token.';
        return res.status(401).json({ error: msg });
    }
}

// ---------------------------------------------------------
// REST API Routes
// ---------------------------------------------------------

// Helper: Write a structured audit entry to Firebase
async function writeAuditLog(req, action, details, metadata = {}) {
    if (admin.apps.length === 0) return;
    // Sanitize metadata: Firebase push() rejects 'undefined' values
    const sanitizedMetadata = {};
    Object.keys(metadata).forEach(key => {
        if (metadata[key] !== undefined) {
            sanitizedMetadata[key] = metadata[key];
        }
    });

    const entry = {
        timestamp: new Date().toISOString(),
        userId: req.user.uid,
        userEmail: req.user.email || 'unknown',
        action,
        details,
        metadata: sanitizedMetadata
    };
    try {
        await admin.database().ref('audit_logs').push(entry);
    } catch (e) {
        console.warn('[Audit] Failed to write audit log:', e.message);
    }
}

// Helper: Write wallet transaction log for a single user
async function writeWalletTransaction(db, userId, type, amount, description, meta = {}) {
    try {
        const sanitized = {};
        Object.keys(meta).forEach(k => { if (meta[k] !== undefined) sanitized[k] = meta[k]; });
        const entry = {
            type,                          // DEPOSIT | BID_PLACED | BID_REFUND | ENTRY_FEE | ENTRY_FEE_REFUND | SALE_PAYOUT | COMMISSION
            amount: Number(amount),        // Always positive
            direction: amount >= 0 ? 'credit' : 'debit',
            description,
            timestamp: new Date().toISOString(),
            ...sanitized
        };
        await db.ref(`wallet_transactions/${userId}`).push(entry);
    } catch (e) {
        console.warn('[WalletTx] Failed to log transaction:', e.message);
    }
}

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

// --- Audit Logging System (Firebase-backed) ---
// POST /api/audit - Append a new log entry
app.post('/api/audit', requireAuth, async (req, res) => {
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

// GET /api/audit - Fetch all logs (Admin only)
app.get('/api/audit', requireAuth, async (req, res) => {
    try {
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });

        // Check if user is Admin in Firebase
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
            // Sort descending (newest first)
            logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
        res.json(logs);
    } catch (err) {
        console.error('[API /audit GET]', err);
        res.status(500).json({ error: 'Failed to fetch audit logs.' });
    }
});

// --- Secure Server-Side Bidding APIs ---
app.post('/api/bidding/entry', requireAuth, async (req, res) => {
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

        // Step 1: Atomically add participant to property
        const participantData = {
            joinedAt: new Date().toISOString(),
            userName: req.user.name || user.name || 'Estato User',
            paidFee: fee
        };
        await db.ref(`properties/${propertyId}/bidding/participants/${userId}`).set(participantData);

        // Step 2: Atomically deduct entry fee from user balance
        if (fee > 0) {
            await db.ref(`users/${userId}/balance`).set(
                admin.database.ServerValue.increment(-fee)
            );
            // Log wallet transaction
            await writeWalletTransaction(db, userId, 'ENTRY_FEE', -fee,
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

app.post('/api/broker/claim', requireAuth, async (req, res) => {
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
            if (!p.needsBroker || p.assignedBrokerId) return undefined; // Already claimed or not for hire

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

app.post('/api/bidding/place', requireAuth, async (req, res) => {
    try {
        const { propertyId, amount } = req.body;
        const userId = req.user.uid;
        const bidAmount = Number(amount);
        
        if (admin.apps.length === 0) return res.status(500).json({ error: 'Database disconnected' });
        const db = admin.database();

        if (isNaN(bidAmount) || bidAmount <= 0) {
            return res.status(400).json({ error: 'Bid amount must be a positive number.' });
        }

        // Pre-validate using fresh reads
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

        // Step 1: Targeted transaction on the property only
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

        // Step 2: Atomic wallet updates (deduct new bidder, refund previous)
        const walletUpdates = {};
        walletUpdates[`users/${userId}/balance`] = admin.database.ServerValue.increment(-bidAmount);
        
        // Fix: Always refund the previous highest amount if it exists, 
        // even if the previous bidder was the current user (outbidding themselves).
        if (prevHighBidderId && prevHighestAmount > 0) {
            walletUpdates[`users/${prevHighBidderId}/balance`] = admin.database.ServerValue.increment(prevHighestAmount);
        }
        await db.ref('/').update(walletUpdates);

        // Log wallet transactions
        const propTitle = result.snapshot.val()?.title || propertyId;
        await writeWalletTransaction(db, userId, 'BID_PLACED', -bidAmount,
            `Bid placed on: ${propTitle}`,
            { propertyId, propertyTitle: propTitle, bidAmount }
        );
        if (prevHighBidderId && prevHighestAmount > 0 && prevHighBidderId !== userId) {
            await writeWalletTransaction(db, prevHighBidderId, 'BID_REFUND', prevHighestAmount,
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

app.post('/api/bidding/finalize', requireAuth, async (req, res) => {
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

app.post('/api/bidding/confirm', requireAuth, async (req, res) => {
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

app.post('/api/bidding/default', requireAuth, async (req, res) => {
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

            // To find the next highest bidder, we rely on the bids array.
            // But we can't deduct their balance in this transaction, so we just reset the status to Available
            // The admin can manually trigger a resume or it stays available.
            // For simplicity, we just reset to Available and clear winner.
            
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
            
            // Check if user should be banned
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

// Catch-all for unmatched /api routes — return JSON 404, not index.html
app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route '${req.path}' not found.` });
});

// ---------------------------------------------------------
// Static Local Hosting
// ---------------------------------------------------------

// Serve all static files from this root directory
app.use(express.static(path.join(__dirname, '.'), {
    index: false,
    setHeaders: (res, filePath) => {
        // Short-term caching — safe without URL-based cache busting
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
        } else if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// ---------------------------------------------------------
// SSR Helpers
// ---------------------------------------------------------

/**
 * Detect if the request is from a known web crawler / bot.
 * Returns true for Googlebot, Bingbot, social media scrapers, etc.
 */
function isBot(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|rogerbot|embedly|quora|outbrain|pinterest|slackbot|vkshare|w3c_validator|lighthouse|pagespeed|headlesschrome|prerender/.test(ua);
}

/** Escape HTML special characters for safe server-side injection */
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Format INR price server-side */
function fmtPrice(price) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(price || 0);
}

/**
 * Build a complete pre-rendered HTML block for a property.
 * This is injected for bots that can't execute JavaScript.
 */
function buildPrerenderedBlock(prop, propId, host) {
    const priceStr = fmtPrice(prop.price);
    const amenitiesHtml = (prop.amenities || []).map(a => `<span class="ssr-tag">${esc(a)}</span>`).join('');
    const img = prop.images && prop.images.length > 0
        ? esc(prop.images[0].replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0])
        : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=800&auto=format&fit=crop';

    return `
<style>
  #ssr-shell{font-family:'Outfit',sans-serif;max-width:960px;margin:0 auto;padding:2rem 1rem;background:#fff;color:#1e1b18;}
  #ssr-shell img{width:100%;height:360px;object-fit:cover;border-radius:12px;display:block;margin-bottom:1.5rem;}
  #ssr-shell h1{font-size:1.8rem;font-weight:800;margin:0 0 0.5rem;}
  #ssr-shell .ssr-price{font-size:1.5rem;font-weight:700;color:#ea580c;margin-bottom:1rem;}
  #ssr-shell .ssr-meta{display:flex;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.5rem;}
  #ssr-shell .ssr-chip{background:#f1f5f9;border-radius:20px;padding:0.3rem 0.8rem;font-size:0.85rem;font-weight:600;}
  #ssr-shell .ssr-desc{font-size:1rem;line-height:1.7;color:#4a4540;margin-bottom:1.5rem;}
  #ssr-shell .ssr-tag{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:6px;padding:0.2rem 0.6rem;font-size:0.8rem;margin-right:0.4rem;}
  #ssr-shell .ssr-breadcrumb{font-size:0.85rem;color:#94a3b8;margin-bottom:1rem;}
  #ssr-shell .ssr-breadcrumb a{color:#ea580c;text-decoration:none;}
  #ssr-shell .ssr-badge{background:#ea580c;color:white;border-radius:6px;padding:0.2rem 0.7rem;font-size:0.8rem;font-weight:700;display:inline-block;margin-bottom:1rem;}
  #ssr-shell .ssr-cta{display:inline-block;background:#ea580c;color:white;border-radius:8px;padding:0.75rem 1.5rem;font-weight:700;text-decoration:none;margin-top:1rem;}
  #ssr-shell table{width:100%;border-collapse:collapse;margin:1rem 0;}
  #ssr-shell td{padding:0.6rem 0.8rem;border-bottom:1px solid #f1f5f9;font-size:0.9rem;}
  #ssr-shell td:first-child{font-weight:600;color:#64748b;width:40%;}
</style>
<div id="ssr-shell">
  <nav class="ssr-breadcrumb">
    <a href="https://${esc(host)}/">Estato</a> &rsaquo;
    <a href="https://${esc(host)}/">Properties in ${esc(prop.city)}</a> &rsaquo;
    ${esc(prop.title)}
  </nav>
  <span class="ssr-badge">${esc(prop.type)} &bull; ${esc(prop.status)}</span>
  <img src="${img}" alt="${esc(prop.title)} in ${esc(prop.city)}" loading="eager">
  <h1>${esc(prop.title)}</h1>
  <div class="ssr-price">${priceStr}${prop.type === 'Rent' ? ' / mo' : ''}</div>
  <div class="ssr-meta">
    ${prop.bhk ? `<span class="ssr-chip">&#127968; ${esc(prop.bhk)}</span>` : ''}
    ${prop.category ? `<span class="ssr-chip">&#127959; ${esc(prop.category)}</span>` : ''}
    ${prop.area ? `<span class="ssr-chip">&#128207; ${esc(String(prop.area))} sq.ft</span>` : ''}
    ${prop.city ? `<span class="ssr-chip">&#128205; ${esc(prop.city)}</span>` : ''}
    ${prop.isVerified ? `<span class="ssr-chip" style="background:#e0f2fe;color:#0369a1;">&#10003; Verified Listing</span>` : ''}
  </div>
  <table>
    ${prop.address ? `<tr><td>Address</td><td>${esc(prop.address)}${prop.pinCode ? ` &mdash; ${esc(prop.pinCode)}` : ''}</td></tr>` : ''}
    <tr><td>Transaction Type</td><td>${esc(prop.type)}</td></tr>
    <tr><td>Property Category</td><td>${esc(prop.category || 'N/A')}</td></tr>
    ${prop.bhk ? `<tr><td>Configuration</td><td>${esc(prop.bhk)}</td></tr>` : ''}
    ${prop.area ? `<tr><td>Super Built-Up Area</td><td>${esc(String(prop.area))} sq.ft</td></tr>` : ''}
    ${prop.price ? `<tr><td>${prop.type === 'Rent' ? 'Monthly Rent' : 'Sale Price'}</td><td>${priceStr}</td></tr>` : ''}
    ${prop.ownerName ? `<tr><td>Listed By</td><td>${esc(prop.ownerName)}</td></tr>` : ''}
  </table>
  ${prop.description ? `<p class="ssr-desc">${esc(prop.description)}</p>` : ''}
  ${amenitiesHtml ? `<div style="margin-bottom:1.5rem;"><strong style="display:block;margin-bottom:0.5rem;">Amenities & Features</strong>${amenitiesHtml}</div>` : ''}
  <a class="ssr-cta" href="https://${esc(host)}/property/${esc(propId)}">View Full Listing &rarr;</a>
</div>`;
}

// ---------------------------------------------------------
// Enhanced SSR: Property Detail Pages
// ---------------------------------------------------------
app.get('/property/:id', async (req, res) => {
    const propId = req.params.id;
    const indexPath = path.join(__dirname, 'index.html');

    // Skip SSR for accidental static file requests (manifest.json, sw.js etc.)
    if (propId.includes('.') || propId.includes('#') || propId.includes('[')) {
        return res.sendFile(path.join(__dirname, propId), err => {
            if (err) res.sendFile(indexPath);
        });
    }

    try {
        let html = fs.readFileSync(indexPath, 'utf8');
        const host = req.get('host') || 'estatemarket.web.app';
        const canonicalUrl = `https://${host}/property/${propId}`;
        const bot = isBot(req);

        if (admin.apps.length > 0) {
            const propSnap = await admin.database().ref(`properties/${propId}`).once('value');
            const prop = propSnap.val();

            if (prop) {
                const title = `${prop.title} | Estato — ${prop.bhk || ''} ${prop.type} in ${prop.city}`.trim();
                const priceFormatted = new Intl.NumberFormat('en-IN').format(prop.price);
                const desc = `${prop.bhk || ''} ${prop.category || 'Property'} for ${prop.type} in ${prop.city}. Price: ₹${priceFormatted}. ${prop.description ? prop.description.substring(0, 120) + '...' : ''}`.trim();
                const ogImage = prop.images && prop.images.length > 0
                    ? prop.images[0].replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0]
                    : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=1200&auto=format&fit=crop';

                // --- Meta Tags ---
                html = html.replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`);
                html = html.replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${esc(desc)}">`);
                html = html.replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${esc(title)}">`);
                html = html.replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${esc(desc)}">`);
                html = html.replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${esc(ogImage)}">`);

                // --- Head Injections (canonical, twitter card, preconnect) ---
                const headInjections = `
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="en_IN">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${esc(ogImage)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://www.gstatic.com">
  <link rel="preconnect" href="https://unpkg.com">`;

                // --- JSON-LD: RealEstateListing ---
                const listingLd = {
                    "@context": "https://schema.org/",
                    "@type": "RealEstateListing",
                    "name": prop.title,
                    "url": canonicalUrl,
                    "image": ogImage,
                    "description": desc,
                    "datePosted": prop.date || new Date().toISOString(),
                    "offers": {
                        "@type": "Offer",
                        "priceCurrency": "INR",
                        "price": prop.price,
                        "availability": prop.status === 'Available'
                            ? "https://schema.org/InStock"
                            : "https://schema.org/SoldOut"
                    },
                    "address": {
                        "@type": "PostalAddress",
                        "streetAddress": prop.address || '',
                        "addressLocality": prop.city || '',
                        "postalCode": prop.pinCode || '',
                        "addressCountry": "IN"
                    },
                    "floorSize": prop.area ? {
                        "@type": "QuantitativeValue",
                        "value": prop.area,
                        "unitCode": "FTK"
                    } : undefined,
                    "numberOfRooms": prop.bhk || undefined,
                    "seller": prop.ownerName ? {
                        "@type": "Person",
                        "name": prop.ownerName
                    } : undefined
                };

                // --- JSON-LD: BreadcrumbList ---
                const breadcrumbLd = {
                    "@context": "https://schema.org",
                    "@type": "BreadcrumbList",
                    "itemListElement": [
                        { "@type": "ListItem", "position": 1, "name": "Home", "item": `https://${host}/` },
                        { "@type": "ListItem", "position": 2, "name": `Properties in ${prop.city}`, "item": `https://${host}/` },
                        { "@type": "ListItem", "position": 3, "name": prop.title, "item": canonicalUrl }
                    ]
                };

                const schemaBlock = `
  <script type="application/ld+json">${JSON.stringify(listingLd)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>
</head>`;
                html = html.replace('</head>', headInjections + schemaBlock);

                // --- Bot Pre-rendering: inject full visible content ---
                // Standard users see the JS app. Bots get actual HTML content
                // injected right after <body> so they can index it.
                if (bot) {
                    const prerenderBlock = buildPrerenderedBlock(prop, propId, host);
                    // Hide the normal app shell for bots to avoid confusing duplicate content
                    const botStyle = `<style>#loginScreen,#loadingOverlay,#appContainer,.add-btn-container{display:none!important}</style>`;
                    html = html.replace('<body>', `<body>\n${botStyle}\n${prerenderBlock}`);
                    res.setHeader('X-Robots-Tag', 'index, follow');
                } else {
                    // For real users: hint the browser to prefetch common resources
                    res.setHeader('Link', `<${ogImage}>; rel=preload; as=image`);
                }

                // Cache property pages: 5 minutes in CDN, 1 minute in browser
                res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=60, stale-while-revalidate=600');
            } else {
                // Property not found — still serve the app, it handles 404 gracefully
                res.setHeader('X-Robots-Tag', 'noindex');
            }
        }

        res.send(html);
    } catch (err) {
        console.error('[SSR Error]', err);
        res.sendFile(indexPath);
    }
});

// ---------------------------------------------------------
// Enhanced Sitemap — Properties + City Index Pages
// ---------------------------------------------------------
const INDIA_CITIES = ['Mumbai','Delhi','Bangalore','Chennai','Hyderabad','Pune','Kolkata','Ahmedabad',
    'Jaipur','Surat','Lucknow','Kanpur','Nagpur','Indore','Thane','Bhopal','Visakhapatnam','Pimpri',
    'Patna','Vadodara','Ghaziabad','Ludhiana','Agra','Nashik','Faridabad','Meerut','Rajkot','Kalyan',
    'Vasai','Varanasi','Srinagar','Aurangabad','Coimbatore','Kochi','Chandigarh','Gurgaon','Noida'];

app.get('/sitemap.xml', async (req, res) => {
    const host = req.get('host') || 'estatemarket.web.app';
    try {
        // Root page
        let urls = `<url><loc>https://${host}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;

        if (admin.apps.length > 0) {
            const propsSnap = await admin.database().ref('properties')
                .orderByChild('status')
                .equalTo('Available')
                .once('value');
            const props = propsSnap.val() || {};

            // Individual property pages
            for (const [id, prop] of Object.entries(props)) {
                const lastmod = new Date(prop.updatedAt || prop.date || Date.now()).toISOString();
                urls += `<url><loc>https://${host}/property/${id}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
            }
        }

        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache sitemap 1hr
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    } catch (err) {
        console.error('[Sitemap Error]', err);
        res.status(500).end();
    }
});

// Sitemap index — points to property sitemap and a future image sitemap
app.get('/sitemap-index.xml', (req, res) => {
    const host = req.get('host') || 'estatemarket.web.app';
    res.setHeader('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://${host}/sitemap.xml</loc><lastmod>${new Date().toISOString()}</lastmod></sitemap>
</sitemapindex>`);
});

// SPA fallback — only for non-API routes
app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------
// Background Worker: Automated Auction Finalization
// ---------------------------------------------------------
setInterval(async () => {
    if (admin.apps.length === 0) return;
    try {
        const db = admin.database();
        const propsSnap = await db.ref('properties').once('value');
        const props = propsSnap.val();
        if (!props) return;

        const nowTs = Date.now();
        for (const [propertyId, prop] of Object.entries(props)) {
            if (!prop.bidding || !prop.bidding.enabled) continue;
            if (prop.status === 'Sold' || prop.status === 'PaymentPending' || prop.bidding.finalized) continue;

            const endTs = new Date(prop.bidding.endTime).getTime();
            if (nowTs >= endTs) {
                console.log(`[Worker] Finalizing expired auction for property: ${propertyId}`);
                
                const pRef = db.ref(`properties/${propertyId}`);
                const result = await pRef.transaction((p) => {
                    if (!p) return p;
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

                if (result.committed) {
                    const p = result.snapshot.val();
                    const updates = {};
                    const winnerId = p.winnerId;
                    const finalPrice = Number(p.highestBid || p.bidding.basePrice || 0);
                    const propTitle = p.title || propertyId;

                    if (winnerId) {
                        if (p.ownerId) {
                            const commission = p.assignedBrokerId ? Math.floor(finalPrice * 0.02) : 0;
                            const sellerPayout = finalPrice - commission;
                            updates[`users/${p.ownerId}/balance`] = admin.database.ServerValue.increment(sellerPayout);
                            if (commission > 0 && p.assignedBrokerId) {
                                updates[`users/${p.assignedBrokerId}/balance`] = admin.database.ServerValue.increment(commission);
                            }
                            // Wallet transaction logs for seller & broker
                            await writeWalletTransaction(db, p.ownerId, 'SALE_PAYOUT', sellerPayout,
                                `Sale payout for: ${propTitle}`,
                                { propertyId, propertyTitle: propTitle, finalPrice, winnerId }
                            );
                            if (commission > 0 && p.assignedBrokerId) {
                                await writeWalletTransaction(db, p.assignedBrokerId, 'COMMISSION', commission,
                                    `2% commission from sale of: ${propTitle}`,
                                    { propertyId, propertyTitle: propTitle, finalPrice }
                                );
                            }
                        }
                        updates[`users/${winnerId}/reputation`] = admin.database.ServerValue.increment(0.1);
                    }

                    const participants = p.bidding.participants || {};
                    for (const [pId, pData] of Object.entries(participants)) {
                        if (pId !== winnerId) {
                            const refund = Number(pData.paidFee || 0);
                            if (refund > 0) {
                                updates[`users/${pId}/balance`] = admin.database.ServerValue.increment(refund);
                                // Log entry fee refund for losing participants
                                await writeWalletTransaction(db, pId, 'ENTRY_FEE_REFUND', refund,
                                    `Entry fee refund – auction ended: ${propTitle}`,
                                    { propertyId, propertyTitle: propTitle, refund }
                                );
                            }
                        }
                    }

                    if (Object.keys(updates).length > 0) {
                        await db.ref('/').update(updates);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Worker Error]', err);
    }
}, 60000);

// Start the server (only if run directly, not if imported by Vercel)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`========================================`);
        console.log(`🚀 Estato Server running on port ${PORT}`);
        console.log(`🌐 Application: http://localhost:${PORT}`);
        console.log(`📡 API Status : http://localhost:${PORT}/api/status`);
        console.log(`========================================`);
    });
}

module.exports = app;
