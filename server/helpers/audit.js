const admin = require('./firebase');

async function writeAuditLog(req, action, details, metadata = {}) {
    if (admin.apps.length === 0) return;
    
    const sanitizedMetadata = {};
    Object.keys(metadata).forEach(key => {
        if (metadata[key] !== undefined) {
            sanitizedMetadata[key] = metadata[key];
        }
    });

    const entry = {
        timestamp: new Date().toISOString(),
        userId: req.user ? req.user.uid : 'system',
        userEmail: req.user ? req.user.email : 'system',
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

async function writeWalletTransaction(userId, type, amount, description, meta = {}) {
    try {
        if (admin.apps.length === 0) return;
        const db = admin.database();
        const sanitized = {};
        Object.keys(meta).forEach(k => { if (meta[k] !== undefined) sanitized[k] = meta[k]; });
        
        const entry = {
            type,
            amount: Number(amount),
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

module.exports = { writeAuditLog, writeWalletTransaction };
