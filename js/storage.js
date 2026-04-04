// ================================================================
// V12.1 — Firebase Auth & Realtime Database Storage Engine
// Estato | Premium Real Estate Marketplace
// ================================================================

const firebaseConfig = {
    apiKey: "AIzaSyB4nGqV9xPiF5W13npX8tjTHXv_Bosj2PU",
    authDomain: "estato-marketplace.firebaseapp.com",
    databaseURL: "https://estato-marketplace-default-rtdb.firebaseio.com/",
    projectId: "estato-marketplace",
    storageBucket: "estato-marketplace.firebasestorage.app",
    messagingSenderId: "186201359877",
    appId: "1:186201359877:web:7a9a50e18327f75ab0fe6c",
    measurementId: "G-QD2GP8TXDZ"
};

// Initialize Firebase if not already initialized
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const db = firebase.database();
const auth = firebase.auth();
const provider = new firebase.auth.GoogleAuthProvider();

// In-memory cache for instant UI rendering
let _memCache = {
    currentUser: null,
    properties: [],
    cities: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Pune'],
    favorites: [],
    inquiries: [],
    notifications: [],
    activities: [],
    reviews: []
};

let _syncCallback = null;

// Local formatter for notification messages
const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
});

// ─── Public Storage API ───────────────────────────────────────────
const Storage = {
    async initDrive(syncCb) {
        _syncCallback = syncCb;
        return true;
    },

    /** Central Login Entry Point */
    async loginWithGoogle(selectedRole = 'Seller', silent = false) {
        try {
            if (_syncCallback) _syncCallback('syncing');
            let user = auth.currentUser;
            
            if (!user) {
                if (silent) {
                    await new Promise((resolve, reject) => {
                        const unsub = auth.onAuthStateChanged(u => {
                            unsub();
                            if(u) resolve(u); else reject(new Error('no_session'));
                        });
                    });
                    user = auth.currentUser;
                } else {
                    const result = await auth.signInWithPopup(provider);
                    user = result.user;
                }
            }

            if (!user) {
                throw new Error("Login failed or cancelled.");
            }

            // 1. Fetch User Identity and Setup Role
            let userRef = db.ref('users/' + user.uid);
            let userSnap = await userRef.get();
            let roleToUse = selectedRole;
            
            if (!userSnap.exists()) {
                // First time sign-up
                await userRef.set({
                    id: user.uid,
                    name: user.displayName,
                    email: user.email,
                    picture: user.photoURL,
                    role: selectedRole
                });
            } else {
                // Welcome back!
                const data = userSnap.val();
                roleToUse = data.role || selectedRole;
            }

            _memCache.currentUser = {
                id: user.uid,
                name: user.displayName,
                email: user.email,
                picture: user.photoURL,
                role: roleToUse
            };

            // 2. Hydrate Global Data (Properties are shared for all!)
            await this.loadAllData();

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch(e) {
            console.warn('[Estato Firebase] Auth Flow interrupted:', e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async loadAllData() {
        const uid = _memCache.currentUser.id;
        const role = _memCache.currentUser.role;
        
        try {
            // Load properties (Global)
            const propsSnap = await db.ref('properties').get();
            if (propsSnap.exists()) {
                const propsData = propsSnap.val();
                _memCache.properties = Object.values(propsData);
            } else {
                _memCache.properties = [];
            }
            
            // Recompute cities
            const propCities = _memCache.properties.map(p => p.city).filter(Boolean);
            _memCache.cities = [...new Set([..._memCache.cities, ...propCities])];

            // Load user-specific favorites
            const favSnap = await db.ref('favorites/' + uid).get();
            _memCache.favorites = favSnap.exists() ? (favSnap.val().ids || []) : [];

            // Load inquiries
            const inqSnap = await db.ref('inquiries').get();
            if (inqSnap.exists()) {
                const allInquiries = Object.values(inqSnap.val());
                if (role === 'Admin') {
                    _memCache.inquiries = allInquiries;
                } else if (role === 'Owner' || role === 'Seller') {
                    _memCache.inquiries = allInquiries.filter(i => i.ownerId === uid);
                } else {
                    _memCache.inquiries = allInquiries.filter(i => i.buyerId === uid);
                }
            } else {
                _memCache.inquiries = [];
            }

            // Load personal notifications
            const notifSnap = await db.ref('notifications/' + uid).get();
            _memCache.notifications = notifSnap.exists() ? (notifSnap.val().items || []) : [];

            // Load platform activities
            const actSnap = await db.ref('activities').orderByChild('timestamp').limitToLast(100).get();
            if (actSnap.exists()) {
                _memCache.activities = Object.values(actSnap.val()).reverse(); // Newest first
            } else {
                _memCache.activities = [];
            }
            
            // Load reviews
            const revSnap = await db.ref('reviews').get();
            if (revSnap.exists()) {
                _memCache.reviews = Object.values(revSnap.val());
            } else {
                _memCache.reviews = [];
            }

        } catch(e) {
            console.error("[Estato Firebase] Failed to hydrate data", e);
        }
    },

    logout() {
        auth.signOut();
        _memCache.currentUser = null;
    },

    getCurrentUser() { return _memCache.currentUser; },
    getData() { return _memCache; },
    hasPendingSync() { return false; },

    // ── Properties Logic ──
    getProperties() { return _memCache.properties; },

    getPropertyById(id) {
        return this.getProperties().find(p => p.id === id);
    },

    async addProperty(property) {
        if (_syncCallback) _syncCallback('syncing');
        property.id = 'prop_' + Date.now();
        property.ownerId = _memCache.currentUser.id;
        property.priceHistory = [{ price: property.price, date: new Date().toISOString() }];

        // Optimistic UI Update
        _memCache.properties.push(property);
        if (property.city && !_memCache.cities.includes(property.city)) {
            _memCache.cities.push(property.city);
        }

        try {
            await db.ref('properties/' + property.id).set(property);
            this.addNotification(`New property listed: ${property.title}`, 'new_listing', { id: property.id });
            this.logActivity('ADD_PROPERTY', `Added new ${property.category}: ${property.title}`);
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            console.error(e);
            if (_syncCallback) _syncCallback('error');
        }
        return property;
    },

    async updateProperty(updatedProp) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.properties.findIndex(p => p.id === updatedProp.id);
        if (index !== -1) {
            const prop = _memCache.properties[index];
            const user = _memCache.currentUser;
            
            const isAuthorized = user && (user.role === 'Admin' || prop.ownerId === user.id);
            if (!isAuthorized) return false;

            if (updatedProp.price && Number(updatedProp.price) !== Number(prop.price)) {
                this.addNotification(`Price updated for ${prop.title}: ${currencyFormatter.format(updatedProp.price)}`, 'price_update', { id: prop.id });
                if (!prop.priceHistory) prop.priceHistory = [];
                prop.priceHistory.push({ price: Number(updatedProp.price), date: new Date().toISOString() });
            }

            // Optimistic update
            _memCache.properties[index] = { ...prop, ...updatedProp, priceHistory: prop.priceHistory, ownerId: prop.ownerId };

            try {
                await db.ref('properties/' + updatedProp.id).update(_memCache.properties[index]);
                this.logActivity('UPDATE_PROPERTY', `Updated ${prop.title} (${updatedProp.id})`);
                if (_syncCallback) _syncCallback('synced');
            } catch(e) {
                console.error(e);
                if (_syncCallback) _syncCallback('error');
            }
            return true;
        }
        return false;
    },

    async deleteProperty(id) {
        if (_syncCallback) _syncCallback('syncing');
        const prop = _memCache.properties.find(p => p.id === id);
        if (!prop) return false;
        
        const isAuthorized = _memCache.currentUser && (_memCache.currentUser.role === 'Admin' || prop.ownerId === _memCache.currentUser.id);
        if (!isAuthorized) return false;
        
        _memCache.properties = _memCache.properties.filter(p => p.id !== id);
        
        try {
            await db.ref('properties/' + id).remove();
            this.logActivity('DELETE_PROPERTY', `Deleted property: ${prop.title} (${id})`);
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            console.error(e);
            if (_syncCallback) _syncCallback('error');
        }
        return true;
    },

    // ── Favorites ──
    getFavorites() { return _memCache.favorites; },

    async toggleFavorite(id) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.favorites.indexOf(id);
        if (index === -1) _memCache.favorites.push(id);
        else _memCache.favorites.splice(index, 1);
        
        try {
            await db.ref('favorites/' + _memCache.currentUser.id).set({ ids: _memCache.favorites });
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            if (_syncCallback) _syncCallback('error');
        }
    },

    // ── Cities / CRM ──
    getCities() { return _memCache.cities; },
    getInquiries() { return _memCache.inquiries; },
    
    async addInquiry(inquiry) {
        if (_syncCallback) _syncCallback('syncing');
        inquiry.id = 'inq_' + Date.now();
        inquiry.date = new Date().toISOString();
        inquiry.read = false;
        
        _memCache.inquiries.push(inquiry);
        
        try {
            await db.ref('inquiries/' + inquiry.id).set(inquiry);
            
            // Add notification to the seller
            const notifRef = db.ref('notifications/' + inquiry.ownerId);
            const docSnap = await notifRef.get();
            let items = docSnap.exists() ? docSnap.val().items : [];
            items.unshift({
                id: 'notif_' + Date.now(),
                message: `New Inquiry alert for ${inquiry.propertyTitle} from ${inquiry.buyerName}`,
                type: 'new_inquiry',
                meta: { id: inquiry.propertyId, ownerId: inquiry.ownerId },
                timestamp: new Date().toISOString(),
                read: false
            });
            await notifRef.set({ items: items });
            
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            if (_syncCallback) _syncCallback('error');
        }
        return inquiry;
    },

    async addInquiryReply(inquiryId, replyPayload) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.inquiries.findIndex(i => i.id === inquiryId);
        if (index === -1) return false;

        const inquiry = _memCache.inquiries[index];
        if (!inquiry.replies) inquiry.replies = [];
        
        replyPayload.id = 'reply_' + Date.now();
        replyPayload.date = new Date().toISOString();
        inquiry.replies.push(replyPayload);

        try {
            await db.ref('inquiries/' + inquiryId + '/replies').set(inquiry.replies);
            
            // Add notification to the receiver
            const receiverId = replyPayload.senderRole === 'Buyer' ? inquiry.ownerId : inquiry.buyerId;
            const notifRef = db.ref('notifications/' + receiverId);
            const docSnap = await notifRef.get();
            let items = docSnap.exists() ? docSnap.val().items : [];
            items.unshift({
                id: 'notif_' + Date.now(),
                message: `New reply on inquiry for ${inquiry.propertyTitle} from ${replyPayload.senderName}`,
                type: 'new_reply',
                meta: { id: inquiry.propertyId, inquiryId: inquiry.id },
                timestamp: new Date().toISOString(),
                read: false
            });
            await notifRef.set({ items: items });

            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            if (_syncCallback) _syncCallback('error');
        }
        return replyPayload;
    },

    async deleteInquiry(id) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.inquiries.findIndex(i => i.id === id);
        if (index === -1) return false;
        
        _memCache.inquiries.splice(index, 1);
        try {
            await db.ref('inquiries/' + id).remove();
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            if (_syncCallback) _syncCallback('error');
        }
        return true;
    },

    // ── Notifications ──
    getNotifications() { return _memCache.notifications; },

    async addNotification(message, type = 'info', meta = {}) {
        const notification = {
            id: 'notif_' + Date.now(),
            message,
            type,
            meta,
            timestamp: new Date().toISOString(),
            read: false
        };
        _memCache.notifications.unshift(notification);
        
        try {
            await db.ref('notifications/' + _memCache.currentUser.id).set({ items: _memCache.notifications });
        } catch(e) {}
    },

    async markNotificationsRead() {
        _memCache.notifications.forEach(n => n.read = true);
        try {
            await db.ref('notifications/' + _memCache.currentUser.id).set({ items: _memCache.notifications });
        } catch(e) {}
    },

    // ── Activity Logging ──
    getActivities() { return _memCache.activities; },

    async logActivity(action, details) {
        const user = this.getCurrentUser();
        if (!user) return;

        const activity = {
            id: 'act_' + Date.now() + Math.random().toString(36).substr(2, 5),
            userId: user.id,
            userName: user.name,
            role: user.role,
            action,
            details,
            timestamp: new Date().toISOString()
        };

        _memCache.activities.unshift(activity);
        if (_memCache.activities.length > 100) _memCache.activities = _memCache.activities.slice(0, 100);

        try {
            await db.ref('activities/' + activity.id).set(activity);
        } catch(e) {}
    },

    getStats() {
        const properties = this.getProperties();
        const user = this.getCurrentUser();
        if (!user) return { totalProperties: 0, totalCities: 0, forSale: 0, forRent: 0, totalValue: 0, avgPriceByCity: {}, typeDistribution: {} };
        
        const filtered = user.role === 'Admin' ? properties : properties.filter(p => p.ownerId === user.id);
        const stats = { totalProperties: filtered.length, totalValue: 0, forSale: 0, forRent: 0, cityData: {}, typeDistribution: { 'Sale': 0, 'Rent': 0 } };

        filtered.forEach(p => {
            stats.totalValue += p.price;
            if (p.type === 'Sale') stats.forSale++;
            if (p.type === 'Rent') stats.forRent++;
            stats.typeDistribution[p.type] = (stats.typeDistribution[p.type] || 0) + 1;

            if (!stats.cityData[p.city]) stats.cityData[p.city] = { count: 0, total: 0 };
            stats.cityData[p.city].count++;
            stats.cityData[p.city].total += p.price;
        });

        const avgPriceByCity = {};
        for (const city in stats.cityData) avgPriceByCity[city] = Math.round(stats.cityData[city].total / stats.cityData[city].count);

        return {
            totalProperties: stats.totalProperties,
            totalCities: Object.keys(stats.cityData).length,
            forSale: stats.forSale,
            forRent: stats.forRent,
            totalValue: stats.totalValue,
            avgPriceByCity: avgPriceByCity,
            typeDistribution: stats.typeDistribution
        };
    },

    // ── Reviews Sync ──
    getReviewsByProperty(propertyId) {
        return _memCache.reviews.filter(r => r.propertyId === propertyId);
    },

    async addReview(propertyId, rating, comment) {
        if (_syncCallback) _syncCallback('syncing');
        const user = this.getCurrentUser();
        if (!user) return;

        const review = {
            id: 'rev_' + Date.now(),
            propertyId,
            userId: user.id,
            userName: user.name,
            rating: Number(rating),
            comment: comment.trim(),
            date: new Date().toISOString()
        };

        _memCache.reviews.push(review);
        try {
            await db.ref('reviews/' + review.id).set(review);
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            if (_syncCallback) _syncCallback('error');
        }
        return review;
    },

    getAverageRating(propertyId) {
        const reviews = this.getReviewsByProperty(propertyId);
        if (reviews.length === 0) return { average: 0, count: 0 };
        const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
        return { average: (sum / reviews.length).toFixed(1), count: reviews.length };
    },

    // ── Recently Viewed (LocalStorage Only) ──
    getRecentViews(userId) {
        if (!userId) return [];
        try { return JSON.parse(localStorage.getItem(`estato_recent_v1_${userId}`) || '[]'); } catch(e) { return []; }
    },

    addRecentView(userId, propertyId) {
        if (!userId || !propertyId) return;
        try {
            const current = this.getRecentViews(userId);
            const filtered = current.filter(id => id !== propertyId);
            const updated = [propertyId, ...filtered].slice(0, 10);
            localStorage.setItem(`estato_recent_v1_${userId}`, JSON.stringify(updated));
        } catch(e) {}
    }
};
