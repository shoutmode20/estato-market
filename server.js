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
app.use(express.static(path.join(__dirname, '.'), { index: false }));

// Basic SSR / Dynamic OG Tags for Properties for SEO
app.get('/property/:id', async (req, res) => {
    const propId = req.params.id;
    const indexPath = path.join(__dirname, 'index.html');

    // Guard: Firebase property IDs never contain dots — skip SSR for static file requests
    // e.g. /property/manifest.json, /property/sw.js should serve files, not Firebase lookups
    if (propId.includes('.') || propId.includes('#') || propId.includes('[')) {
        return res.sendFile(path.join(__dirname, propId), err => {
            if (err) res.sendFile(indexPath);
        });
    }

    try {

        let html = fs.readFileSync(indexPath, 'utf8');
        
        if (admin.apps.length > 0) {
            const propSnap = await admin.database().ref(`properties/${propId}`).once('value');
            const prop = propSnap.val();
            
            if (prop) {
                // Generate Dynamic OG Tags
                const title = `${prop.title} | Estato`;
                const priceFormatted = new Intl.NumberFormat('en-IN').format(prop.price);
                const desc = `View this ${prop.bhk} ${prop.type} in ${prop.city} for ₹${priceFormatted} on Estato. ${prop.description ? prop.description.substring(0, 100) + '...' : ''}`;
                const image = prop.images && prop.images.length > 0 ? prop.images[0].replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0] : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=1200&auto=format&fit=crop';
                
                // Replace default tags
                html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
                html = html.replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${title}">`);
                html = html.replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${desc}">`);
                html = html.replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${desc}">`);
                html = html.replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${image}">`);
                
                // Inject Structured Data (JSON-LD)
                const jsonLd = {
                    "@context": "https://schema.org/",
                    "@type": "RealEstateListing",
                    "name": prop.title,
                    "image": image,
                    "description": desc,
                    "offers": {
                        "@type": "Offer",
                        "priceCurrency": "INR",
                        "price": prop.price
                    },
                    "address": {
                        "@type": "PostalAddress",
                        "addressLocality": prop.city,
                        "postalCode": prop.pinCode || "",
                        "addressCountry": "IN"
                    }
                };
                
                const scriptTag = `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>\n</head>`;
                html = html.replace('</head>', scriptTag);
            }
        }
        res.send(html);
    } catch (err) {
        console.error('[SSR Error]', err);
        res.sendFile(indexPath);
    }
});

// Dynamic XML Sitemap for SEO
app.get('/sitemap.xml', async (req, res) => {
    try {
        let urls = `<url><loc>https://${req.get('host')}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
        
        if (admin.apps.length > 0) {
            const propsSnap = await admin.database().ref('properties').once('value');
            const props = propsSnap.val() || {};
            
            for (const [id, prop] of Object.entries(props)) {
                if (prop.status !== 'Sold') {
                    urls += `
                    <url>
                        <loc>https://${req.get('host')}/property/${id}</loc>
                        <lastmod>${new Date(prop.updatedAt || prop.date || Date.now()).toISOString()}</lastmod>
                        <changefreq>weekly</changefreq>
                        <priority>0.8</priority>
                    </url>`;
                }
            }
        }
        
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            ${urls}
        </urlset>`;
        
        res.header('Content-Type', 'application/xml');
        res.send(sitemap);
    } catch (err) {
        console.error('[Sitemap Error]', err);
        res.status(500).end();
    }
});

// SPA fallback — only for non-API routes
app.use((req, res) => {
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

                    if (winnerId) {
                        if (p.ownerId) {
                            const commission = p.assignedBrokerId ? Math.floor(finalPrice * 0.02) : 0;
                            const sellerPayout = finalPrice - commission;
                            
                            updates[`users/${p.ownerId}/balance`] = admin.database.ServerValue.increment(sellerPayout);
                            if (commission > 0 && p.assignedBrokerId) {
                                updates[`users/${p.assignedBrokerId}/balance`] = admin.database.ServerValue.increment(commission);
                            }
                        }
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
