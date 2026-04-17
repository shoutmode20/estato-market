const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
});

const db = admin.database();

async function diagnose() {
    console.log('--- FETCHING INQUIRIES ---');
    const inqSnap = await db.ref('inquiries').limitToLast(5).once('value');
    if (!inqSnap.exists()) {
        console.log('No inquiries found in database.');
    } else {
        console.log('Found inquiries:', inqSnap.numChildren());
        console.log(JSON.stringify(inqSnap.val(), null, 2));
    }

    console.log('\n--- FETCHING SAMPLE USER_INQUIRIES ---');
    const indexSnap = await db.ref('user_inquiries').limitToLast(10).once('value');
    if (indexSnap.exists()) {
        console.log('Sample user_inquiries index:', JSON.stringify(indexSnap.val(), null, 2));
    }

    console.log('\n--- FETCHING SAMPLE USERS ---');
    const userSnap = await db.ref('users').limitToLast(3).once('value');
    if (userSnap.exists()) {
        console.log('Sample Users:', JSON.stringify(userSnap.val(), null, 2));
    }

    process.exit(0);
}

diagnose().catch(err => {
    console.error(err);
    process.exit(1);
});
