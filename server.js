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

        const userSnap = await db.ref(`users/${userId}`).once('value');
        const user = userSnap.val();
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.isBanned) return res.status(403).json({ error: 'Your account is banned due to multiple auction defaults.' });

        const propSnap = await db.ref(`properties/${propertyId}`).once('value');
        const prop = propSnap.val();
        if (!prop || !prop.bidding || !prop.bidding.enabled) {
            return res.status(400).json({ error: 'Bidding is not enabled for this property.' });
        }
        if (prop.ownerId === userId) {
            return res.status(403).json({ error: 'You cannot participate in an auction for your own property.' });
        }

        const fee = Number(prop.bidding.entryFee || 0);
        if (prop.bidding.participants && prop.bidding.participants[userId]) {
            return res.json({ success: true, message: 'Already joined.' });
        }

        if ((user.balance || 0) < fee) {
            return res.status(400).json({ error: `Insufficient balance. Entry fee is ₹${fee.toLocaleString()}.` });
        }

        // Atomic Transaction for Entry Fee
        const result = await db.ref('/').transaction((root) => {
            if (!root) return undefined;
            if (!root.users || !root.users[userId] || root.users[userId].balance < fee) return undefined;
            
            root.users[userId].balance -= fee;
            
            if (!root.properties[propertyId].bidding.participants) {
                root.properties[propertyId].bidding.participants = {};
            }
            root.properties[propertyId].bidding.participants[userId] = {
                joinedAt: new Date().toISOString(),
                userName: req.user.name || user.name || 'Estato User',
                paidFee: fee
            };
            return root;
        });

        if (!result.committed) {
            return res.status(500).json({ error: 'Failed to join auction. Please try again.' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API /bidding/entry]', err);
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

        if (isNaN(bidAmount) || bidAmount <= 0 || bidAmount % 10000 !== 0) {
            return res.status(400).json({ error: 'Bid amount must be a positive multiple of ₹10,000.' });
        }

        const result = await db.ref('/').transaction((root) => {
            if (!root) return undefined;
            const prop = root.properties ? root.properties[propertyId] : null;
            if (!prop || !prop.bidding || !prop.bidding.enabled || prop.ownerId === userId) return undefined;

            const bidData = prop.bidding;
            const participants = bidData.participants || {};
            if (!participants[userId]) return undefined;

            const nowTs = Date.now();
            const startTs = new Date(bidData.startTime).getTime();
            const endTs = new Date(bidData.endTime).getTime();
            if (nowTs < startTs || nowTs >= endTs) return undefined;

            const currentHighest = Number(prop.highestBid || bidData.basePrice || 0);
            const minIncrement = Number(bidData.minIncrement || 10000);
            if (bidAmount < currentHighest + minIncrement) return undefined;

            const currentUserData = root.users[userId];
            if (!currentUserData || currentUserData.balance < bidAmount || currentUserData.isBanned) return undefined;

            currentUserData.balance -= bidAmount;

            let prevHighBidderId = prop.highestBidderId;
            let prevHighestAmount = currentHighest;
            if (prevHighBidderId && prevHighBidderId !== userId && root.users[prevHighBidderId]) {
                root.users[prevHighBidderId].balance += prevHighestAmount;
            }

            prop.highestBid = bidAmount;
            prop.highestBidderId = userId;
            prop.highestBidderName = req.user.name || currentUserData.name || 'Estato User';
            
            if (!prop.bids) prop.bids = {};
            prop.bids['bid_' + nowTs] = {
                userId: userId,
                userName: prop.highestBidderName,
                amount: bidAmount,
                timestamp: new Date(nowTs).toISOString()
            };

            const remainingSecs = (endTs - nowTs) / 1000;
            if (remainingSecs > 0 && remainingSecs < 30) {
                prop.bidding.endTime = new Date(endTs + 60000).toISOString();
            }

            return root;
        });

        if (!result.committed) {
            return res.status(400).json({ error: 'Bid rejected: Auction ended, you were outbid, or insufficient funds.' });
        }

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

        const result = await db.ref('/').transaction((root) => {
            if (!root) return undefined;
            const p = root.properties ? root.properties[propertyId] : null;
            if (!p || !p.bidding || !p.bidding.enabled) return undefined;
            if (p.status === 'Sold' || p.status === 'PaymentPending' || p.bidding.finalized) return undefined;

            const winnerId = p.highestBidderId;
            const finalPrice = p.highestBid || p.bidding.basePrice;
            
            p.status = winnerId ? 'Sold' : 'Available';
            p.bidding.finalized = true;
            p.winnerId = winnerId || null;
            p.winnerName = p.highestBidderName || 'No Bids';
            
            if (winnerId) {
                p.bidding.paymentFinalizedAt = new Date().toISOString();
                if (root.users[p.ownerId]) root.users[p.ownerId].balance += finalPrice;
                if (root.users[winnerId]) root.users[winnerId].reputation = Math.min(5.0, (root.users[winnerId].reputation || 5.0) + 0.1);
            }

            const participants = p.bidding.participants || {};
            for (const [pId, pData] of Object.entries(participants)) {
                if (pId !== winnerId) {
                    const refund = Number(pData.paidFee || 0);
                    if (refund > 0 && root.users[pId]) root.users[pId].balance += refund;
                }
            }
            return root;
        });

        if (!result.committed) return res.status(400).json({ error: 'Finalize failed.' });
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

        const result = await db.ref('/').transaction((root) => {
            if (!root) return undefined;
            const p = root.properties ? root.properties[propertyId] : null;
            if (!p || p.status !== 'PaymentPending') return undefined;

            p.status = 'Sold';
            p.bidding.paymentFinalizedAt = new Date().toISOString();
            if (p.winnerId && root.users[p.winnerId]) {
                root.users[p.winnerId].reputation = Math.min(5.0, (root.users[p.winnerId].reputation || 5.0) + 0.1);
            }
            return root;
        });

        if (!result.committed) return res.status(400).json({ error: 'Confirm failed.' });
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

        const result = await db.ref('/').transaction((root) => {
            if (!root) return undefined;
            const p = root.properties ? root.properties[propertyId] : null;
            if (!p || (p.status !== 'Sold' && p.status !== 'PaymentPending') || !p.winnerId) return undefined;

            const winnerId = p.winnerId;
            const defaulted = p.bidding.defaultedBidders || [];
            if (!defaulted.includes(winnerId)) defaulted.push(winnerId);
            p.bidding.defaultedBidders = defaulted;

            if (root.users[winnerId]) {
                root.users[winnerId].strikes = (root.users[winnerId].strikes || 0) + 1;
                root.users[winnerId].isBanned = root.users[winnerId].strikes >= 3;
                root.users[winnerId].reputation = Math.max(0.0, (root.users[winnerId].reputation || 5.0) - 1.0);
            }

            const bids = p.bids ? Object.values(p.bids) : [];
            bids.sort((a, b) => b.amount - a.amount);

            let nextFound = false;
            for (const bid of bids) {
                if (defaulted.includes(bid.userId)) continue;
                const u = root.users[bid.userId];
                if (u && !u.isBanned && (u.balance || 0) >= bid.amount) {
                    p.status = 'PaymentPending';
                    p.highestBid = bid.amount;
                    p.highestBidderId = bid.userId;
                    p.highestBidderName = bid.userName;
                    p.winnerId = bid.userId;
                    p.winnerName = bid.userName;
                    p.bidding.paymentDeadline = new Date(Date.now() + 24 * 3600000).toISOString();
                    u.balance -= bid.amount;
                    nextFound = true;
                    break;
                }
            }

            if (!nextFound) {
                p.status = 'Available';
                p.bidding.finalized = false;
                p.winnerId = null;
                p.winnerName = null;
            }

            return root;
        });

        if (!result.committed) return res.status(400).json({ error: 'Default processing failed.' });
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
                
                await db.ref('/').transaction((root) => {
                    if (!root) return undefined;
                    const p = root.properties ? root.properties[propertyId] : null;
                    if (!p || p.status === 'Sold' || p.status === 'PaymentPending' || p.bidding.finalized) return undefined;

                    const winnerId = p.highestBidderId;
                    const finalPrice = p.highestBid || p.bidding.basePrice;
                    
                    p.status = winnerId ? 'Sold' : 'Available';
                    p.bidding.finalized = true;
                    p.winnerId = winnerId || null;
                    p.winnerName = p.highestBidderName || 'No Bids';
                    
                    if (winnerId) {
                        p.bidding.paymentFinalizedAt = new Date().toISOString();
                        if (root.users[p.ownerId]) root.users[p.ownerId].balance += finalPrice;
                        if (root.users[winnerId]) root.users[winnerId].reputation = Math.min(5.0, (root.users[winnerId].reputation || 5.0) + 0.1);
                    }

                    const participants = p.bidding.participants || {};
                    for (const [pId, pData] of Object.entries(participants)) {
                        if (pId !== winnerId) {
                            const refund = Number(pData.paidFee || 0);
                            if (refund > 0 && root.users[pId]) root.users[pId].balance += refund;
                        }
                    }
                    return root;
                });
            }
        }
    } catch (err) {
        console.error('[Worker Error]', err);
    }
}, 60000);

// Start the server
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Estato Server running on port ${PORT}`);
    console.log(`🌐 Application: http://localhost:${PORT}`);
    console.log(`📡 API Status : http://localhost:${PORT}/api/status`);
    console.log(`========================================`);
});
