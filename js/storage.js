// ================================================================
// V12.1 — Firebase Auth & Realtime Database Storage Engine
// Estato | Premium Real Estate Marketplace
// ================================================================

// Initialize Firebase using global config injected by config.js
// Guard: If SDK or Config is missing, skip Firebase initialization
if (typeof firebase === 'undefined' || !window.firebaseConfig) {
    console.error("[Estato] Firebase SDK or Config is missing. App will run in limited offline mode.");
}

// Initialize Firebase if not already initialized
if (typeof firebase !== 'undefined' && !firebase.apps.length && window.firebaseConfig) {
    firebase.initializeApp(window.firebaseConfig);
}

const db = (typeof firebase !== 'undefined') ? firebase.database() : null;
const auth = (typeof firebase !== 'undefined') ? firebase.auth() : null;
const provider = (typeof firebase !== 'undefined') ? new firebase.auth.GoogleAuthProvider() : null;
if (provider) provider.addScope('https://www.googleapis.com/auth/drive.file');


// Enable Firebase Realtime Database Persistence
try {
    if (db) db.ref().keepSynced(true);
} catch (e) {
    console.warn("Persistence failed to initialize:", e);
}

// Store OAuth Credential Memory
let _driveAccessToken = null;

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
let _listenersInitialized = false;  // Guard: prevent stacking duplicate realtime listeners on re-auth
let _dataChangeListeners = [];

// Local formatter for notification messages
const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
});

// ─── Public Storage API ───────────────────────────────────────────
var EstatoStorage = {
    getCurrentUser() { return _memCache.currentUser; },

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
                            if (u) resolve(u); else reject(new Error('no_session'));
                        });
                    });
                    user = auth.currentUser;
                } else {
                    const result = await auth.signInWithPopup(provider);
                    user = result.user;
                    if (result.credential && result.credential.accessToken) {
                        _driveAccessToken = result.credential.accessToken;
                    }
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
        } catch (e) {
            console.warn('[Estato Firebase] Auth Flow interrupted:', e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async loadAllData() {
        if (_listenersInitialized) {
            console.log('[Estato Firebase] Listeners already active — skipping re-init to prevent stacking.');
            return;
        }
        _listenersInitialized = true;
        const uid = _memCache.currentUser.id;
        const role = _memCache.currentUser.role;

        console.log("[Estato Firebase] Initializing Real-time Listeners...");
        if (!db) return;

        try {
            // 1. Listen for Latest Properties (Real-time sync for the first batch)
            db.ref('properties').limitToLast(20).on('value', (snap) => {
                const data = snap.val();
                const latestBatch = data ? Object.values(data) : [];
                this.mergeProperties(latestBatch);

                this.notifyListeners();
            });

            // 2. Listen for user-specific favorites
            db.ref('favorites/' + uid).on('value', (snap) => {
                _memCache.favorites = snap.exists() ? (snap.val().ids || []) : [];
                this.notifyListeners();
            });

            // 3. Listen for inquiries
            db.ref('inquiries').on('value', (snap) => {
                if (snap.exists()) {
                    const allInquiries = Object.values(snap.val());
                    if (role === 'Admin') {
                        _memCache.inquiries = allInquiries;
                    } else if (role === 'Seller') {
                        _memCache.inquiries = allInquiries.filter(i => i.ownerId === uid);
                    } else {
                        _memCache.inquiries = allInquiries.filter(i => i.buyerId === uid);
                    }
                } else {
                    _memCache.inquiries = [];
                }
                this.notifyListeners();
            });

            // 4. Listen for personal notifications
            db.ref('notifications/' + uid).on('value', (snap) => {
                _memCache.notifications = snap.exists() ? (snap.val().items || []) : [];
                this.notifyListeners();
            });

            // 5. Listen for platform activities (Limit to latest 100)
            db.ref('activities').orderByChild('timestamp').limitToLast(100).on('value', (snap) => {
                if (snap.exists()) {
                    _memCache.activities = Object.values(snap.val()).reverse(); // Newest first
                } else {
                    _memCache.activities = [];
                }
                this.notifyListeners();
            });

            // 6. Listen for reviews
            db.ref('reviews').on('value', (snap) => {
                _memCache.reviews = snap.exists() ? Object.values(snap.val()) : [];
                this.notifyListeners();
            });

        } catch (e) {
            console.error("[Estato Firebase] Failed to initialize listeners", e);
        }
    },

    logout() {
        _driveAccessToken = null;          // Clear OAuth token so it can't be reused after session ends
        _listenersInitialized = false;     // Allow fresh listener registration on next login
        auth.signOut();
        _memCache.currentUser = null;
    },

    getData() { return _memCache; },
    hasPendingSync() { return false; },
    async _flushPendingSync() { return true; }, // Stub for compatibility

    /** RESTORE DATA FROM BACKUP */
    async restoreData(data) {
        if (!data || typeof data !== 'object') return false;
        // Security: Enforce admin-only restore on the client side
        // (Firebase rules will also block non-admin writes at each child path)
        if (!_memCache.currentUser || _memCache.currentUser.role !== 'Admin') {
            console.error('[Estato] Unauthorized: restoreData() is restricted to Admins.');
            return false;
        }
        if (_syncCallback) _syncCallback('syncing');

        try {
            // Overwrite entire database (Careful!)
            await db.ref().set(data);

            // Re-hydrate local cache
            _memCache = { ..._memCache, ...data };
            this.notifyListeners();

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("Restore failed:", e);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    /** UI SUBSCRIPTION MECHANISM */
    subscribe(callback) {
        if (typeof callback === 'function') {
            _dataChangeListeners.push(callback);
        }
    },

    notifyListeners() {
        _dataChangeListeners.forEach(cb => cb(_memCache));
    },

    // ── Properties Logic ──
    getProperties() { return _memCache.properties; },

    mergeProperties(newBatch) {
        const existing = new Map(_memCache.properties.map(p => [p.id, p]));
        newBatch.forEach(p => existing.set(p.id, p));

        // Sort by date/ID descending
        _memCache.properties = Array.from(existing.values())
            .sort((a, b) => b.id.localeCompare(a.id));

        // Recompute cities
        const propCities = _memCache.properties.map(p => p.city).filter(Boolean);
        _memCache.cities = [...new Set(['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Pune', ...propCities])];
    },

    async loadMoreProperties() {
        if (_memCache.properties.length === 0) return;

        // Get the oldest ID we have (they are sorted descending)
        const oldestId = _memCache.properties[_memCache.properties.length - 1].id;
        console.log("[Storage] Fetching properties before:", oldestId);

        try {
            const snap = await db.ref('properties')
                .orderByKey()
                .endBefore(oldestId)
                .limitToLast(20)
                .get();

            if (snap.exists()) {
                const data = snap.val();
                this.mergeProperties(Object.values(data));
                this.notifyListeners();
                return true;
            }
            return false;
        } catch (e) {
            console.error("[Storage] Paginated fetch failed:", e);
            return false;
        }
    },

    getPropertyById(id) {
        return this.getProperties().find(p => p.id === id);
    },

    async addProperty(property) {
        if (_syncCallback) _syncCallback('syncing');
        property.id = 'prop_' + Date.now();
        property.ownerId = _memCache.currentUser.id;
        property.ownerName = _memCache.currentUser.name || 'Estato User';
        property.ownerPicture = _memCache.currentUser.picture || null;
        property.listedAt = new Date().toISOString();
        property.priceHistory = [{ price: property.price, date: new Date().toISOString() }];

        // Enforce Pending status for new listings (Fraud Prevention)
        if (_memCache.currentUser.role !== 'Admin') {
            property.status = 'Pending';
        }

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
        } catch (e) {
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

            // Optimistic update — snapshot for rollback if Firebase write fails
            const _updateBackup = { ...prop, priceHistory: prop.priceHistory ? [...prop.priceHistory] : [] };
            _memCache.properties[index] = { ...prop, ...updatedProp, priceHistory: prop.priceHistory, ownerId: prop.ownerId, ownerName: prop.ownerName, ownerPicture: prop.ownerPicture, listedAt: prop.listedAt, updatedAt: new Date().toISOString() };

            try {
                await db.ref('properties/' + updatedProp.id).update(_memCache.properties[index]);
                this.logActivity('UPDATE_PROPERTY', `Updated ${prop.title} (${updatedProp.id})`);
                if (_syncCallback) _syncCallback('synced');
            } catch (e) {
                console.error('[Estato] updateProperty write failed, rolling back:', e);
                // Rollback optimistic update so UI stays in sync with DB
                _memCache.properties[index] = _updateBackup;
                this.notifyListeners();
                if (_syncCallback) _syncCallback('error');
            }
            return true;
        }
        return false;
    },

    async deleteProperty(id) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        const prop = _memCache.properties[index];
        const isAuthorized = _memCache.currentUser && (_memCache.currentUser.role === 'Admin' || prop.ownerId === _memCache.currentUser.id);
        if (!isAuthorized) return false;

        // Snapshot the property for rollback before the optimistic delete
        const _deleteBackup = { ...prop };
        _memCache.properties.splice(index, 1);
        try {
            await db.ref('properties/' + id).remove();
            this.logActivity('DELETE_PROPERTY', `Archived listing: ${prop.title} (${id})`);

            // If Admin deleted someone else's property, notify them
            if (_memCache.currentUser.role === 'Admin' && prop.ownerId !== _memCache.currentUser.id) {
                await this.sendUserNotification(prop.ownerId, `Your listing "${prop.title}" was removed by an Admin.`, 'danger', { id: id });
            }

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error('[Estato] deleteProperty write failed, rolling back:', e);
            // Rollback: re-insert the property at its original position
            _memCache.properties.splice(index, 0, _deleteBackup);
            this.notifyListeners();
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async sendUserNotification(userId, message, type = 'info', meta = {}) {
        try {
            const snapshot = await db.ref('notifications/' + userId).get();
            let items = snapshot.val()?.items || [];
            items.unshift({
                id: 'notif_' + Date.now(),
                message,
                type,
                meta,
                timestamp: new Date().toISOString(),
                read: false
            });
            await db.ref('notifications/' + userId).set({ items });
        } catch (e) {
            console.error("Failed to send remote notification", e);
        }
    },

    async approveProperty(id) {
        if (_syncCallback) _syncCallback('syncing');
        if (_memCache.currentUser.role !== 'Admin') return false;

        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        _memCache.properties[index].status = 'Available';

        try {
            await db.ref('properties/' + id).update({ status: 'Available' });
            this.logActivity('APPROVE_PROPERTY', `Admin approved listing: ${_memCache.properties[index].title}`);
            // Force notification to the Seller (Owner)
            await this.sendUserNotification(_memCache.properties[index].ownerId, `Listing Approved: ${_memCache.properties[index].title}`, 'success', { id: id });
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error(e);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async rejectProperty(id, reason = 'Did not meet marketplace guidelines.') {
        if (_syncCallback) _syncCallback('syncing');
        if (_memCache.currentUser.role !== 'Admin') return false;

        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        _memCache.properties[index].status = 'Rejected';

        try {
            await db.ref('properties/' + id).update({ status: 'Rejected' });
            this.logActivity('REJECT_PROPERTY', `Admin rejected listing: ${_memCache.properties[index].title}`);
            // Force notification to the Seller (Owner)
            await this.sendUserNotification(_memCache.properties[index].ownerId, `Your listing "${_memCache.properties[index].title}" was rejected. Reason: ${reason}`, 'warning', { id: id });

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error(e);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
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
        } catch (e) {
            if (_syncCallback) _syncCallback('error');
        }
    },

    // ── Cities / CRM ──
    getCities() { return _memCache.cities; },
    getInquiries() { return _memCache.inquiries; },

    async addInquiry(inquiry) {
        if (_syncCallback) _syncCallback('syncing');

        // Rate limiting: one inquiry per buyer per property to prevent spam
        const duplicate = _memCache.inquiries.find(i =>
            i.buyerId === inquiry.buyerId && i.propertyId === inquiry.propertyId
        );
        if (duplicate) {
            if (_syncCallback) _syncCallback('synced');
            throw new Error('You have already sent an inquiry for this property. Check your Messages tab for any reply.');
        }

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
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) { }
    },

    async markNotificationsRead() {
        _memCache.notifications.forEach(n => n.read = true);
        try {
            await db.ref('notifications/' + _memCache.currentUser.id).set({ items: _memCache.notifications });
        } catch (e) { }
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
        } catch (e) { }
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
        } catch (e) {
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
        try { return JSON.parse(localStorage.getItem(`estato_recent_v1_${userId}`) || '[]'); } catch (e) { return []; }
    },

    addRecentView(userId, propertyId) {
        if (!userId || !propertyId) return;
        try {
            const current = this.getRecentViews(userId);
            const filtered = current.filter(id => id !== propertyId);
            const updated = [propertyId, ...filtered].slice(0, 10);
            localStorage.setItem(`estato_recent_v1_${userId}`, JSON.stringify(updated));
        } catch (e) { }
    },

    // ── Google Drive Sync ──
    async uploadImageToDrive(file) {
        if (!_driveAccessToken) {
            throw new Error("No Google Drive access token. Please re-login to authorize Drive access.");
        }

        try {
            // STEP 1: Simple Media Upload (Raw file body)
            // This is the most compatible way to send binary data to Google
            const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=media', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + _driveAccessToken,
                    'Content-Type': file.type || 'image/jpeg'
                },
                body: file
            });

            if (!uploadRes.ok) {
                const errorData = await uploadRes.json().catch(() => ({ error: { message: "Media Upload Failed" } }));
                throw new Error(`Media Upload Failed: ${errorData.error ? errorData.error.message : uploadRes.statusText}`);
            }

            const driveFile = await uploadRes.json();
            const fileId = driveFile.id;

            // STEP 2: Metadata Update (PATCH)
            // Now that the file exists, we set its name and ensure it's in the root
            const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=root&fields=id,webViewLink,webContentLink`, {
                method: 'PATCH',
                headers: {
                    'Authorization': 'Bearer ' + _driveAccessToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: file.name || 'estato_property_image.jpg'
                })
            });

            if (!metaRes.ok) {
                console.warn("[Drive] Metadata update failed, but media was uploaded.");
            }

            const data = await metaRes.json();

            // STEP 3: Permissions Update (Public Reader)
            await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + _driveAccessToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    role: 'reader',
                    type: 'anyone'
                })
            });

            // Use the Google Drive thumbnail API for direct, guaranteed image rendering in DOM <img> tags
            return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;

        } catch (e) {
            console.error("[Drive Logic Error]", e);
            if (e.message === 'Failed to fetch') {
                throw new Error("Failed to fetch: Service Worker or Network blocked the request. Please Hard Refresh (Ctrl+F5) and ensure your internet is stable.");
            }
            throw e;
        }
    }
};
window.EstatoStorage = EstatoStorage;

