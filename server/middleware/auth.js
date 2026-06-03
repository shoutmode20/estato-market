const admin = require('../helpers/firebase');

async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header.' });
    }
    const idToken = authHeader.split('Bearer ')[1];

    // Support for mock tokens in dev/tests
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

module.exports = { requireAuth };
