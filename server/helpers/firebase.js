const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

try {
    let serviceAccount;
    // Note: Since this file is now in server/helpers/, we check the root level
    const localKeyPath = path.join(__dirname, '../../serviceAccountKey.json');
    
    if (fs.existsSync(localKeyPath)) {
        serviceAccount = require(localKeyPath);
        console.log('[Firebase Admin] Initializing via local serviceAccountKey.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('[Firebase Admin] Initializing via FIREBASE_SERVICE_ACCOUNT environment variable');
    } else {
        console.warn('[Firebase Admin] MISSING CONFIG: No serviceAccountKey.json found and environment variable is empty.');
    }

    if (serviceAccount && admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
        });
        console.log('[Firebase Admin] Successfully initialized.');
    }
} catch (error) {
    console.error('[Firebase Admin Error]', error.message);
}

module.exports = admin;
