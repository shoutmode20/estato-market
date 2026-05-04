const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
    });
}

const db = admin.database();

async function checkAuctions() {
    console.log('--- CHECKING ACTIVE AUCTIONS ---');
    const snap = await db.ref('properties').once('value');
    const props = snap.val();
    
    if (!props) {
        console.log('No properties found.');
        process.exit(0);
    }

    for (const [id, p] of Object.entries(props)) {
        if (p.bidding && p.bidding.enabled) {
            console.log(`\nProperty: ${id} (${p.title})`);
            console.log(`Status: ${p.status}`);
            console.log(`Participants: ${p.bidding.participants ? Object.keys(p.bidding.participants).length : 0}`);
            console.log(`Highest Bid: ${p.highestBid || 'None'}`);
            console.log(`Highest Bidder: ${p.highestBidderId || 'None'}`);
            console.log(`Bidding Data:`, JSON.stringify(p.bidding, null, 2));
        }
    }
    
    process.exit(0);
}

checkAuctions().catch(err => {
    console.error(err);
    process.exit(1);
});
