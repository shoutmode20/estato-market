const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
});

const db = admin.database();

// Target: Arpit Tripathi (Buyer)
const uid = 't9NJpHaaYpcizTZTXBVAa4Z3iSk2';
const sampleInqId = 'inq_1775221030799'; // This exists in the DB

async function inject() {
    console.log(`Checking if inquiry ${sampleInqId} exists...`);
    const inq = await db.ref(`inquiries/${sampleInqId}`).get();
    if (!inq.exists()) {
        console.error('Sample inquiry does not exist. Update the script with a valid ID.');
        process.exit(1);
    }

    console.log(`Injecting index for UID: ${uid} -> ${sampleInqId}`);
    await db.ref(`user_inquiries/${uid}/${sampleInqId}`).set(true);
    
    console.log('Injection successful. Please check the "Messages" tab in the app.');
    process.exit(0);
}

inject().catch(console.error);
