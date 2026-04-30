require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');

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

    const rules = fs.readFileSync('database.rules.json', 'utf8');

    admin.database().setRules(rules)
        .then(() => {
            console.log("Firebase Database Rules successfully deployed!");
            process.exit(0);
        })
        .catch((error) => {
            console.error("Error deploying rules:", error);
            process.exit(1);
        });
} catch (err) {
    console.error("Setup error:", err);
    process.exit(1);
}
