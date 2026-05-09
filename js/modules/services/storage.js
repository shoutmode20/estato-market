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
const storage = (typeof firebase !== 'undefined') ? firebase.storage() : null;
const provider = (typeof firebase !== 'undefined') ? new firebase.auth.GoogleAuthProvider() : null;
if (provider) provider.addScope('https://www.googleapis.com/auth/drive.file');


// Firebase offline persistence is handled automatically by the SDK.
// keepSynced() was removed — it is not available in the current Firebase SDK version
// and was crashing the storage module at boot, causing all property listeners to fail.

// Store OAuth Credential Memory
let _driveAccessToken = sessionStorage.getItem('estato_drive_token');

// In-memory state cache — single source of truth
let _memCache = {
    _lastUpdated: 0,
    currentUser: null,
    properties: [],
    cities: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Pune'],
    favorites: [],
    inquiries: [],
    notifications: [],
    activities: [],
    reviews: [],
    recentViews: [],
    users: []
};

let _syncCallback = null;
let _globalListenersActive = false; // Guard: prevent stacking duplicate global listeners
let _initializedUid = null;        // Track which user the user-specific listeners are for
let _initializedRole = null;       // Track the role for role-specific listeners
let _isSubmittingBid = false;       // Local lock to prevent duplicate submissions
let _dataChangeListeners = [];

// Tracks every active Firebase .on() listener so they can be cleanly removed on logout.
// Without this, each logout+re-login stacks another layer of duplicate listeners.
let _listenerHandles = []; // [{ target: refOrQuery, handler: Function }]

function _trackListener(target, handler, errHandler = null) {
    target.on('value', handler, (err) => {
        if (errHandler) errHandler(err);
        else console.warn("[Storage] Unhandled Listener Error:", err.message);
    });
    _listenerHandles.push({ target, handler });
}

// Local formatter for notification messages
const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
});

// ─── Private State Management ──────────────────────────────────────
function _setState(updates) {
    Object.assign(_memCache, updates);
    _memCache._lastUpdated = Date.now();
    
    // Invalidate/Sync to LocalStorage for persistence
    // We store the relevant pieces of state to allow instant startup
    const cacheData = {
        _lastUpdated: _memCache._lastUpdated,
        currentUser: _memCache.currentUser,
        properties: _memCache.properties,
        cities: _memCache.cities,
        favorites: _memCache.favorites,
        notifications: _memCache.notifications,
        recentViews: _memCache.recentViews
    };
    
    try {
        localStorage.setItem('estato_cache_v12', JSON.stringify(cacheData));
        
        // Individual legacy keys for backward compatibility or simple reads
        if (updates.favorites) _syncToLocal('favorites', updates.favorites);
        if (updates.currentUser) _syncToLocal('currentUser', updates.currentUser);
    } catch (e) {
        console.warn("[Storage] Cache sync failed (likely quota exceeded):", e);
    }
    
    EstatoStorage.notifyListeners();
}

/**
 * Centralized RBAC Guard.
 * @param {string} action - Action name (e.g., 'CREATE_PROPERTY')
 * @param {string|null} propertyId - Optional property ID for ownership checks
 * @returns {boolean}
 */
function _can(action, propertyId = null) {
    const user = _memCache.currentUser;
    if (!user) return false;

    const role = user.role;
    const isAdmin = role === 'Admin';
    const isSeller = role === 'Seller';
    const isBuyer = role === 'Buyer';
    const isBroker = role === 'Broker';

    switch (action) {
        case 'CREATE_PROPERTY':
            return isAdmin || isSeller || isBroker;
            
        case 'MODIFY_PROPERTY':
        case 'DELETE_PROPERTY':
            if (isAdmin) return true;
            if (!(isSeller || isBroker) || !propertyId) return false;
            const prop = _memCache.properties.find(p => p.id === propertyId);
            // Allow if owner, OR if the property has no owner (legacy fallback)
            return prop && (!prop.ownerId || prop.ownerId === user.id);

        case 'APPROVE_PROPERTY':
        case 'MANAGE_USERS':
        case 'ADMIN_ONLY':
            return isAdmin;

        case 'PLACE_BID':
            return isAdmin || isBuyer || isBroker;

        default:
            return false;
    }
}

/**
 * Loads data from localStorage if it's less than 10 minutes old.
 * @returns {boolean} True if valid cache was loaded.
 */
function _loadFromPersistentCache() {
    try {
        const raw = localStorage.getItem('estato_cache_v12');
        if (!raw) return false;

        const cache = JSON.parse(raw);
        const now = Date.now();
        const tenMinutes = 10 * 60 * 1000;

        if (now - (cache._lastUpdated || 0) < tenMinutes) {
            console.log("[Storage] Loading valid cache (Age: " + Math.round((now - cache._lastUpdated)/1000) + "s)");
            Object.assign(_memCache, cache);
            return true;
        } else {
            console.log("[Storage] Cache expired. Clearing...");
            localStorage.removeItem('estato_cache_v12');
            return false;
        }
    } catch (e) {
        console.error("[Storage] Failed to load cache:", e);
        return false;
    }
}

function _syncToLocal(key, data) {
    try {
        localStorage.setItem(`estato_${key}_v12`, JSON.stringify(data));
    } catch (e) {
        console.warn(`[Storage] LocalSync failed for ${key}:`, e.message);
    }
}

// ─── Cloud Sync: Debounced Write Queue ─────────────────────────────────────
// All routine writes are batched here and flushed as a single atomic
// Firebase multi-path update(), preventing partial writes and redundant calls.

const _cloudWriteQueue = new Map(); // path -> data (null = delete)
const _rollbackSnapshot = new Map(); // Stores a memCache key snapshot for rollback
let _cloudFlushTimer = null;
const CLOUD_DEBOUNCE_MS = 500;

/**
 * Queue a path for cloud write. Null data = delete the path.
 * @param {string} path - Firebase path
 * @param {*} data - Data to write, or null to remove
 */
function _queueCloudWrite(path, data) {
    _cloudWriteQueue.set(path, data);
    if (_cloudFlushTimer) clearTimeout(_cloudFlushTimer);
    _cloudFlushTimer = setTimeout(_flushCloudQueue, CLOUD_DEBOUNCE_MS);
}

/**
 * Flush all queued writes to Firebase as a single atomic multi-path update.
 * Removes are handled separately since update() cannot set a path to null.
 */
async function _flushCloudQueue() {
    if (!db || _cloudWriteQueue.size === 0) return;
    _cloudFlushTimer = null;

    // Snapshot and clear queue atomically
    const ops = new Map(_cloudWriteQueue);
    _cloudWriteQueue.clear();

    const batchUpdates = {};
    const removes = [];

    for (const [path, data] of ops.entries()) {
        if (data === null || data === undefined) {
            removes.push(path);
        } else {
            batchUpdates[path] = data;
        }
    }

    if (_syncCallback) _syncCallback('syncing');
    try {
        const writes = [];
        if (Object.keys(batchUpdates).length > 0) {
            writes.push(db.ref('/').update(batchUpdates));
        }
        for (const path of removes) {
            writes.push(db.ref(path).remove());
        }
        await Promise.all(writes);
        if (_syncCallback) _syncCallback('synced');
    } catch (e) {
        console.error('[Storage] Cloud flush failed:', e);
        // Do NOT re-queue — this would cause an infinite retry loop.
        // Firebase realtime listeners will reconcile the correct server state.
        if (_syncCallback) _syncCallback('error');
    }
}

/**
 * For immediate (non-debounced) cloud operations like transactions.
 * Use sparingly — prefer `_queueCloudWrite` for regular mutations.
 */
async function _syncToCloud(path, data, type = 'update') {
    if (!db) return;
    try {
        if (type === 'set') {
            await db.ref(path).set(data);
        } else if (type === 'remove') {
            await db.ref(path).remove();
        } else {
            await db.ref(path).update(data);
        }
        return true;
    } catch (e) {
        console.error(`[Storage] CloudSync failed for ${path}:`, e.message);
        throw e;
    }
}

// ─── Public Storage API ───────────────────────────────────────────
export const EstatoStorage = {
    getCurrentUser() { return _memCache.currentUser; },
    _syncToCloud,

    async initDrive(syncCb) {
        _syncCallback = syncCb;
        return true;
    },
    async checkAuth() {
        // Attempt to pre-load from cache for instant UI
        _loadFromPersistentCache();

        try {
            const rawUser = localStorage.getItem('estato_currentUser_v12');
            if (rawUser) {
                const user = JSON.parse(rawUser);
                _memCache.currentUser = user;
                this.loadAllData();
                return user;
            }
        } catch (e) {
            console.warn('[Storage] Failed to read cached user:', e);
        }
        return null;
    },

    /** Central Login Entry Point */
    async loginWithGoogle(selectedRole = 'Seller', silent = false) {
        try {
            if (_syncCallback) _syncCallback('syncing');
            let user = auth.currentUser;

            if (!user && silent) {
                await new Promise((resolve, reject) => {
                    const unsub = auth.onAuthStateChanged(u => {
                        unsub();
                        if (u) resolve(u); else reject(new Error('no_session'));
                    });
                });
                user = auth.currentUser;
            } else if (!user || !silent) {
                const provider = new firebase.auth.GoogleAuthProvider();
                provider.addScope('https://www.googleapis.com/auth/drive.file');
                
                const result = await firebase.auth().signInWithPopup(provider);
                
                // On fresh login, clear old cache to ensure no data mixing
                if (!user) localStorage.removeItem('estato_cache_v12');
                
                user = result.user;
                if (result.credential && result.credential.accessToken) {
                    _driveAccessToken = result.credential.accessToken;
                    sessionStorage.setItem('estato_drive_token', _driveAccessToken);
                    console.log("[Storage] Drive Access Token acquired and cached.");
                }
            }

            if (!user) {
                throw new Error("Login failed or cancelled.");
            }

            // 1. Fetch User Identity and Setup Role
            let userRef = db.ref('users/' + user.uid);
            let userSnap = await userRef.get();
            let roleToUse = selectedRole;

            // If user requested Admin, hitting the `/api/make-admin` route first is mandatory
            if (selectedRole === 'Admin') {
                const idToken = await (async () => { try { return await user.getIdToken(); } catch(e) { return 'mock-token-' + user.uid; } })();
                const adminReq = await fetch('/api/make-admin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + idToken
                    }
                });
                
                if (!adminReq.ok) {
                    const errorText = await adminReq.json().catch(() => ({}));
                    throw new Error(errorText.error || "Admin Registration failed: Access Denied.");
                }
            }

            let dbUserData = {};
            if (!userSnap.exists()) {
                // First time sign-up — initialize all fields including reputation
                dbUserData = {
                    id: user.uid,
                    name: user.displayName,
                    email: user.email,
                    picture: user.photoURL,
                    role: selectedRole,
                    balance: 100000,
                    reputation: 5.0,
                    strikes: 0,
                    isBanned: false
                };
                await userRef.set(dbUserData);
            } else {
                // Welcome back — read full profile from DB
                dbUserData = userSnap.val();
                roleToUse = dbUserData.role || selectedRole;
                
                // Allow users to seamlessly switch roles from the login screen
                if (selectedRole && selectedRole !== 'Admin' && roleToUse !== selectedRole) {
                    roleToUse = selectedRole;
                    await userRef.child('role').set(roleToUse);
                }
            }

            // 1.1 Handle Virtual Wallet Balance (for existing users who predate wallet)
            let balance = dbUserData.balance;
            if (balance === undefined) {
                balance = 100000;
                await db.ref('users/' + user.uid + '/balance').set(balance);
            }

            // Hydrate full user profile including auction-safety fields
            const recentViews = JSON.parse(localStorage.getItem(`estato_recent_v1_${user.uid}`) || '[]');
            _setState({
                currentUser: {
                    id: user.uid,
                    name: user.displayName,
                    email: user.email,
                    picture: user.photoURL,
                    role: roleToUse,
                    balance: Number(balance),
                    reputation: dbUserData.reputation !== undefined ? dbUserData.reputation : 5.0,
                    strikes: dbUserData.strikes || 0,
                    isBanned: dbUserData.isBanned || false
                },
                recentViews
            });

            // 2. Hydrate Global Data (Properties are shared for all!)
            await this.loadAllData();

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.warn('[Estato Firebase] Auth Flow interrupted:', e.message);
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    },

    async loadAllData() {
        const uid = _memCache.currentUser ? _memCache.currentUser.id : null;
        const role = _memCache.currentUser ? _memCache.currentUser.role : 'Guest';
        const self = this;

        console.log(`[Estato Firebase] loadAllData triggered (UID: ${uid}, Role: ${role})`);
        if (!db) return;

        // 1. Initialize Global Listeners (Only Once per session)
        if (!_globalListenersActive) {
            _globalListenersActive = true;
            console.log("[Estato Firebase] Initializing Global Real-time Listeners...");

            // Latest 100 Properties — increased from 20 to prevent seller listings vanishing
            _trackListener(db.ref('properties').limitToLast(100), (snap) => {
                const data = snap.val();
                const latestBatch = data ? Object.values(data) : [];
                self.mergeProperties(latestBatch);
            }, (err) => console.error("[Storage] Property Listener Error:", err.message));

            // Platform activity feed
            _trackListener(db.ref('activities').orderByChild('timestamp').limitToLast(100), (snap) => {
                _setState({ activities: snap.exists() ? Object.values(snap.val()).reverse() : [] });
            }, (err) => console.error("[Storage] Activity Listener Error:", err.message));

            // Reviews
            _trackListener(db.ref('reviews'), (snap) => {
                _setState({ reviews: snap.exists() ? Object.values(snap.val()) : [] });
            }, (err) => console.error("[Storage] Reviews Listener Error:", err.message));
        }

        // 2. Initialize User-Specific Listeners (Whenever UID or Role changes)
        if (uid && (_initializedUid !== uid || _initializedRole !== role)) {
            console.log(`[Estato Firebase] Initializing User-Specific Listeners for ${uid} (${role})...`);
            
            _initializedUid = uid;
            _initializedRole = role;

            // ── Seller/Broker: Always load ALL of the user's own listings ──────
            // This ensures a seller's properties are never hidden by the global limitToLast(100).
            if (role === 'Seller' || role === 'Broker' || role === 'Admin') {
                _trackListener(
                    db.ref('properties').orderByChild('ownerId').equalTo(uid),
                    (snap) => {
                        if (snap.exists()) {
                            const owned = Object.values(snap.val());
                            self.mergeProperties(owned);
                        }
                    },
                    (err) => console.error("[Storage] Owned Properties Listener Error:", err.message)
                );
            }

            // Favorites
            _trackListener(db.ref('favorites/' + uid), (snap) => {
                _setState({ favorites: snap.exists() ? (snap.val().ids || []) : [] });
            }, (err) => console.error("[Storage] Favorites Listener Error:", err.message));

            // Inquiries — Private isolated sync for all users
            const _inquiryCacheMap = new Map();
            const updateCache = () => {
                const inquiries = Array.from(_inquiryCacheMap.values())
                    .sort((a,b) => {
                        const getLatestDate = (inq) => {
                            if (inq.replies && inq.replies.length > 0) {
                                const last = inq.replies[inq.replies.length - 1];
                                return new Date(last.date || last.timestamp);
                            }
                            return new Date(inq.date || inq.timestamp);
                        };
                        return getLatestDate(b) - getLatestDate(a);
                    });
                _setState({ inquiries });
            };

            _trackListener(db.ref(`user_inquiries/${uid}`), (snap) => {
                if (!snap.exists()) {
                    _inquiryCacheMap.clear();
                    updateCache();
                    return;
                }
                const indexedIds = Object.keys(snap.val());
                for (const inqId of _inquiryCacheMap.keys()) {
                    if (!indexedIds.includes(inqId)) _inquiryCacheMap.delete(inqId);
                }
                indexedIds.forEach(inqId => {
                    if (!_inquiryCacheMap.has(inqId)) {
                        _trackListener(db.ref(`inquiries/${inqId}`), (inqSnap) => {
                            if (inqSnap.exists()) {
                                _inquiryCacheMap.set(inqId, { id: inqId, ...inqSnap.val() });
                            } else {
                                _inquiryCacheMap.delete(inqId);
                            }
                            updateCache();
                        }, (err) => console.error(`[Storage] Inquiry Detail Listener Error (${inqId}):`, err.message));
                    }
                });
            }, (err) => console.error("[Storage] Inquiry Index Listener Error:", err.message));

            // Personal notifications
            _trackListener(db.ref('notifications/' + uid), (snap) => {
                _setState({ notifications: snap.exists() ? (snap.val().items || []) : [] });
            }, (err) => console.error("[Storage] Notifications Listener Error:", err.message));

            // Admin-Only Users Listener
            if (role === 'Admin') {
                _trackListener(db.ref('users'), (snap) => {
                    const usersMap = snap.val() || {};
                    const usersList = Object.entries(usersMap).map(([id, u]) => ({ id, ...u }));
                    _setState({ users: usersList });
                }, (err) => console.error("[Storage] Admin Users Listener Error:", err.message));

                // Self-healing migration for Admins
                this._performInquiryMigration(uid, role);
            }
        }

        if (_syncCallback) _syncCallback('synced');
    },

    /**
     * One-time bridge to find legacy inquiries (created before the index)
     * and add them to the new user_inquiries index for the current user.
     */
    async _performInquiryMigration(uid, role) {
        try {
            console.log("[Storage] Starting Nuclear Discovery for legacy inquiries...");
            const snap = await db.ref('inquiries').once('value');
            if (!snap.exists()) return { count: 0, uid, sampleInq: 'none' };

            const allInquiries = snap.val();
            const indexUpdates = {};
            let count = 0;
            let sampleInq = null;

            Object.entries(allInquiries).forEach(([inqId, inq]) => {
                if (!sampleInq) sampleInq = { id: inqId, buyerId: inq.buyerId, ownerId: inq.ownerId };
                // If current user is a participant (Buyer or Owner)
                if (inq.buyerId === uid || inq.ownerId === uid) {
                    indexUpdates[inqId] = true;
                    count++;
                }
            });

            if (count > 0) {
                console.log(`[Storage] Nuclear Discovery found ${count} threads for ${uid}. Indexing now...`);
                await db.ref(`user_inquiries/${uid}`).update(indexUpdates);
            }

            return { count, uid, sampleInq };
        } catch (e) {
            console.warn("[Storage] Nuclear Discovery failed:", e.message);
            throw e;
        }
    },

    logout() {
        _driveAccessToken = null;

        // Detach every active Firebase .on() listener before signing out.
        // Without this, old listeners survive logout and double up on re-login.
        _listenerHandles.forEach(({ target, handler }) => {
            try { target.off('value', handler); } catch (e) {}
        });
        _listenerHandles = [];
        _globalListenersActive = false;
        _initializedUid = null;
        _initializedRole = null;

        _setState({ currentUser: null });
        auth.signOut();
    },

    getData() { return _memCache; },
    hasPendingSync() { return false; },
    async _flushPendingSync() { return true; }, // Stub for compatibility

    /** RESTORE DATA FROM BACKUP */
    async restoreData(data) {
        if (!_can('ADMIN_ONLY')) throw new Error("Access Denied: Administrative privileges required.");
        if (!data || typeof data !== 'object') return false;
        if (_syncCallback) _syncCallback('syncing');

        try {
            // Overwrite entire database (Careful!)
            await _syncToCloud('/', data, 'set');

            // Re-hydrate local cache
            _setState({ ...data });

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
            // Return an unsubscribe function
            return () => {
                _dataChangeListeners = _dataChangeListeners.filter(cb => cb !== callback);
            };
        }
        return () => {};
    },

    notifyListeners() {
        _dataChangeListeners.forEach(cb => cb(_memCache));
    },

    // ── Properties Logic ──
    getProperties() { return _memCache.properties; },
    getUsers() { return _memCache.users; },

    mergeProperties(newBatch) {
        const existing = new Map(_memCache.properties.map(p => [p.id, p]));
        newBatch.forEach(p => existing.set(p.id, p));

        // Recompute cities
        const propCities = _memCache.properties.map(p => p.city).filter(Boolean);
        const cities = [...new Set(['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Pune', ...propCities])];
        
        _setState({ 
            properties: Array.from(existing.values()).sort((a, b) => b.id.localeCompare(a.id)),
            cities
        });
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

    async verifyProperty(id) {
        if (!_can('ADMIN_ONLY')) throw new Error("Unauthorized: Only Admins can verify properties.");
        if (_syncCallback) _syncCallback('syncing');
        try {
            await _syncToCloud(`properties/${id}/isVerified`, true, 'set');
            const index = _memCache.properties.findIndex(p => p.id === id);
            if (index !== -1) {
                _memCache.properties[index].isVerified = true;
                this.notifyListeners();
            }
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("[Storage] Verification failed:", e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    getPropertyById(id) {
        return this.getProperties().find(p => p.id === id);
    },

    async recordView(propertyId) {
        const index = _memCache.properties.findIndex(p => p.id === propertyId);
        if (index === -1) return;

        const prop = { ..._memCache.properties[index] };
        prop.views = (prop.views || 0) + 1;

        // Update local state
        const properties = [..._memCache.properties];
        properties[index] = prop;
        _setState({ properties });

        // Debounced sync to cloud
        _queueCloudWrite('properties/' + propertyId + '/views', prop.views);
    },

    async addProperty(property) {
        if (!_can('CREATE_PROPERTY')) throw new Error("Access Denied: You do not have permission to list properties.");
        const user = _memCache.currentUser;
        property.id = 'prop_' + Date.now();
        property.ownerId = user.id;
        property.ownerName = user.name || 'Estato User';
        property.ownerPicture = user.picture || null;
        property.listedAt = new Date().toISOString();
        property.priceHistory = [{ price: property.price, date: new Date().toISOString() }];

        if (user.role !== 'Admin') property.status = 'Pending';

        // 1. memCache + localStorage — immediate
        const properties = [..._memCache.properties, property];
        const cities = [..._memCache.cities];
        if (property.city && !cities.includes(property.city)) cities.push(property.city);
        _setState({ properties, cities });

        // 2. Cloud — debounced
        _queueCloudWrite('properties/' + property.id, property);

        this.addNotification(`New property listed: ${property.title}`, 'new_listing', { id: property.id });
        this.logActivity('ADD_PROPERTY', `Added new ${property.category}: ${property.title}`);
        return property;
    },

    async updateProperty(updatedProp) {
        if (!_can('MODIFY_PROPERTY', updatedProp.id)) throw new Error("Access Denied: You do not have permission to edit this listing.");
        const index = _memCache.properties.findIndex(p => p.id === updatedProp.id);
        if (index === -1) return false;

        const prop = _memCache.properties[index];
        const user = _memCache.currentUser;

        if (updatedProp.price && Number(updatedProp.price) !== Number(prop.price)) {
            this.addNotification(`Price updated for ${prop.title}: ${currencyFormatter.format(updatedProp.price)}`, 'price_update', { id: prop.id });
            if (!prop.priceHistory) prop.priceHistory = [];
            prop.priceHistory.push({ price: Number(updatedProp.price), date: new Date().toISOString() });
        }

        // 1. memCache + localStorage — immediate
        const properties = [..._memCache.properties];
        properties[index] = { 
            ...prop, 
            ...updatedProp, 
            priceHistory: prop.priceHistory, 
            ownerId: prop.ownerId || user.id, // Auto-assign if legacy/missing
            ownerName: prop.ownerName || user.name || 'Estato User', 
            ownerPicture: prop.ownerPicture || user.picture || null, 
            listedAt: prop.listedAt || new Date().toISOString(), 
            updatedAt: new Date().toISOString() 
        };
        _setState({ properties });

        // 2. Cloud — debounced
        _queueCloudWrite('properties/' + updatedProp.id, properties[index]);

        this.logActivity('UPDATE_PROPERTY', `Updated ${prop.title} (${updatedProp.id})`);
        return true;
    },

    async deleteProperty(id) {
        if (!_can('DELETE_PROPERTY', id)) throw new Error("Access Denied: You do not have permission to delete this listing.");
        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        const prop = _memCache.properties[index];

        // 1. memCache + localStorage — immediate (optimistic)
        const properties = _memCache.properties.filter(p => p.id !== id);
        _setState({ properties });

        // 2. Cloud — debounced
        _queueCloudWrite('properties/' + id, null); // null = delete

        this.logActivity('DELETE_PROPERTY', `Archived listing: ${prop.title} (${id})`);

        if (_memCache.currentUser.role === 'Admin' && prop.ownerId !== _memCache.currentUser.id) {
            this.sendUserNotification(prop.ownerId, `Your listing "${prop.title}" was removed by an Admin.`, 'danger', { id });
        }
        return true;
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
        if (!_can('APPROVE_PROPERTY')) throw new Error("Access Denied: Administrative privileges required.");

        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        // 1. memCache + localStorage
        const properties = [..._memCache.properties];
        properties[index] = { ...properties[index], status: 'Available' };
        _setState({ properties });

        // 2. Cloud
        _queueCloudWrite('properties/' + id + '/status', 'Available');

        this.logActivity('APPROVE_PROPERTY', `Admin approved listing: ${properties[index].title}`);
        this.sendUserNotification(properties[index].ownerId, `Listing Approved: ${properties[index].title}`, 'success', { id });
        return true;
    },

    async rejectProperty(id, reason = 'Did not meet marketplace guidelines.') {
        if (!_can('APPROVE_PROPERTY')) throw new Error("Access Denied: Administrative privileges required.");

        const index = _memCache.properties.findIndex(p => p.id === id);
        if (index === -1) return false;

        // 1. memCache + localStorage
        const properties = [..._memCache.properties];
        properties[index] = { ...properties[index], status: 'Rejected', rejectionReason: reason };
        _setState({ properties });

        // 2. Cloud
        _queueCloudWrite('properties/' + id + '/status', 'Rejected');
        _queueCloudWrite('properties/' + id + '/rejectionReason', reason);

        this.logActivity('REJECT_PROPERTY', `Admin rejected listing: ${properties[index].title} — ${reason}`);
        this.sendUserNotification(properties[index].ownerId, `Listing Rejected: ${properties[index].title}. Reason: ${reason}`, 'danger', { id });
        return true;
    },


    // ── Favorites ──
    getFavorites() { return _memCache.favorites; },

    async toggleFavorite(id) {
        const favorites = [..._memCache.favorites];
        const index = favorites.indexOf(id);
        if (index === -1) favorites.push(id);
        else favorites.splice(index, 1);

        // 1. memCache + localStorage
        _setState({ favorites });

        // 2. Cloud
        _queueCloudWrite('favorites/' + _memCache.currentUser.id, { ids: favorites });
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
        inquiry.status = 'Unread';
        inquiry.pipelineStatus = 'New';

        const inquiries = [..._memCache.inquiries, inquiry];
        _setState({ inquiries });
        try {
            console.log(`[Sync] 📤 Outbound Inquiry: ${inquiry.id} to ${inquiry.ownerId}`);
            await _syncToCloud('inquiries/' + inquiry.id, inquiry, 'set');

            // Maintain a per-user index for privacy-compliant listings
            await _syncToCloud(`user_inquiries/${inquiry.buyerId}/${inquiry.id}`, true, 'set');
            await _syncToCloud(`user_inquiries/${inquiry.ownerId}/${inquiry.id}`, true, 'set');

            if (_syncCallback) _syncCallback('synced');
        } catch (e) {
            console.error("[Storage] Inquiry submission failed:", e.message);
            if (_syncCallback) _syncCallback('error');
        }
        return inquiry;
    },

    async addInquiryReply(inquiryId, replyPayload) {
        if (_syncCallback) _syncCallback('syncing');
        const index = _memCache.inquiries.findIndex(i => i.id === inquiryId);
        if (index === -1) return false;

        const inquiries = [..._memCache.inquiries];
        const inquiry = inquiries[index];
        if (!inquiry.replies) inquiry.replies = [];

        replyPayload.id = 'reply_' + Date.now();
        replyPayload.date = new Date().toISOString();
        inquiry.replies.push(replyPayload);

        // Update status for the other participants
        inquiry.status = 'Unread';
        _setState({ inquiries });

        try {
            console.log(`[Sync] 📤 Outbound Reply: ${inquiryId}`);
            /*
            // Add notification to the receiver (Independently handled to prevent hangs)
            try {
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
            } catch (notifErr) {
                console.warn("[Storage] Failed to send cross-user notification:", notifErr.message);
                // We DON'T fail the message send just because a notification failed
            }
            */

            if (_syncCallback) _syncCallback('synced');
        } catch (e) {
            console.error("[Storage] Messaging write failed:", e.message);
            if (_syncCallback) _syncCallback('error');
        }
        return replyPayload;
    },

    async deleteInquiry(id) {
        if (_syncCallback) _syncCallback('syncing');
        try {
            if (!auth.currentUser) throw new Error("Authentication required");
            const uid = auth.currentUser.uid;
            // Only remove from the private index. Do NOT delete the shared 'inquiries' node.
            await _syncToCloud(`user_inquiries/${uid}/${id}`, null, 'remove');
            
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("[Storage] Private deletion failed:", e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async purgeInquiryGlobal(id) {
        if (!_can('ADMIN_ONLY')) throw new Error("Access Denied: Administrative privileges required.");
        if (_syncCallback) _syncCallback('syncing');
        try {
            // 1. Remove from inquiries root
            await _syncToCloud(`inquiries/${id}`, null, 'remove');
            
            // 2. We don't necessarily have to find all user indexes to delete it (it will just fail silently when they try to load)
            // but we SHOULD remove it for the current admin too.
            const uid = auth.currentUser.uid;
            await _syncToCloud(`user_inquiries/${uid}/${id}`, null, 'remove');

            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("[Storage] Global purge failed:", e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async markInquiryRead(id) {
        const index = _memCache.inquiries.findIndex(i => i.id === id);
        if (index === -1) return false;
        if (_memCache.inquiries[index].status === 'Read') return true;

        const inquiries = [..._memCache.inquiries];
        inquiries[index].status = 'Read';
        _setState({ inquiries });
        try {
            await _syncToCloud(`inquiries/${id}/status`, 'Read', 'set');
            return true;
        } catch (e) {
            console.error("[Storage] Failed to mark inquiry read:", e.message);
            return false;
        }
    },

    async updateInquiryPipelineStatus(id, newStatus) {
        if (_syncCallback) _syncCallback('syncing');
        try {
            await _syncToCloud(`inquiries/${id}/pipelineStatus`, newStatus, 'set');
            // Local update (listeners will pick up the cloud change, but we can be optimistic)
            const index = _memCache.inquiries.findIndex(i => i.id === id);
            if (index !== -1) {
                _memCache.inquiries[index].pipelineStatus = newStatus;
                this.notifyListeners();
            }
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("[Storage] Pipeline status update failed:", e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async deleteInquiryReply(inquiryId, replyId) {
        if (_syncCallback) _syncCallback('syncing');
        try {
            const snap = await db.ref(`inquiries/${inquiryId}`).once('value');
            if (!snap.exists()) {
                if (_syncCallback) _syncCallback('synced');
                return false;
            }

            const inquiry = snap.val();
            
            // SPECIAL CASE: Root Message Deletion
            if (replyId === 'msg_root') {
                await db.ref(`inquiries/${inquiryId}/message`).set("[This message was deleted by the sender]");
                if (_syncCallback) _syncCallback('synced');
                return true;
            }

            // Standard Reply Deletion
            if (!inquiry.replies) {
                if (_syncCallback) _syncCallback('synced');
                return false;
            }

            // Remove the specific reply
            const filteredReplies = inquiry.replies.filter(r => r.id !== replyId);
            
            await db.ref(`inquiries/${inquiryId}/replies`).set(filteredReplies);
            
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error("[Storage] Reply deletion failed:", e.message);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
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
        const notifications = [notification, ..._memCache.notifications];
        _setState({ notifications });

        try {
            await _syncToCloud('notifications/' + _memCache.currentUser.id, { items: notifications }, 'set');
        } catch (e) { }
    },

    async markNotificationsRead() {
        const notifications = _memCache.notifications.map(n => ({ ...n, read: true }));
        _setState({ notifications });
        try {
            await _syncToCloud('notifications/' + _memCache.currentUser.id, { items: notifications }, 'set');
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

        let activities = [activity, ..._memCache.activities];
        if (activities.length > 100) activities = activities.slice(0, 100);
        _setState({ activities });

        try {
            await _syncToCloud('activities/' + activity.id, activity, 'set');
        } catch (e) { }
    },

    async logAudit(action, details, metadata = {}) {
        const user = _memCache.currentUser;
        if (!user || !window.firebase || !firebase.auth().currentUser) return;

        try {
            const idToken = await (async () => { try { return await firebase.auth().currentUser.getIdToken(); } catch(e) { return 'mock-token-' + firebase.auth().currentUser.uid; } })();
            fetch('/api/audit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({ action, details, metadata })
            }).catch(e => console.warn('[Storage] Audit background log failed:', e));
        } catch (err) {
            console.error('[Storage] Audit log preparation failed:', err);
        }
    },

    getStats() {
        const properties = this.getProperties();
        const user = this.getCurrentUser();
        if (!user) return { totalProperties: 0, totalCities: 0, forSale: 0, forRent: 0, totalValuation: 0, pendingCount: 0, availableCount: 0, avgPriceByCity: {}, typeDistribution: {} };

        const filtered = user.role === 'Admin' ? properties : properties.filter(p => p.ownerId === user.id);
        const stats = { 
            totalProperties: filtered.length, 
            totalValue: 0, 
            totalViews: 0,
            forSale: 0, 
            forRent: 0, 
            pendingCount: 0,
            availableCount: 0,
            activeAuctions: 0,
            totalBids: 0,
            cityData: {}, 
            typeDistribution: { 'Sale': 0, 'Rent': 0 } 
        };

        filtered.forEach(p => {
            stats.totalValue += (p.price || 0);
            stats.totalViews += (p.views || 0);
            if (p.type === 'Sale') stats.forSale++;
            if (p.type === 'Rent') stats.forRent++;
            if (p.status === 'Pending') stats.pendingCount++;
            if (p.status === 'Available') stats.availableCount++;

            if (p.bidding && p.bidding.enabled) {
                const now = new Date();
                const end = new Date(p.bidding.endTime);
                if (now < end) stats.activeAuctions++;
                if (p.bids) stats.totalBids += Object.keys(p.bids).length;
            }
            
            stats.typeDistribution[p.type] = (stats.typeDistribution[p.type] || 0) + 1;

            if (!stats.cityData[p.city]) stats.cityData[p.city] = { count: 0, total: 0 };
            stats.cityData[p.city].count++;
            stats.cityData[p.city].total += p.price;
        });

        const avgPriceByCity = {};
        for (const city in stats.cityData) avgPriceByCity[city] = Math.round(stats.cityData[city].total / stats.cityData[city].count);

        // Filter inquiries to only count those belonging to the current user
        const userInquiries = this.getInquiries().filter(i =>
            i.buyerId === user.id || i.ownerId === user.id
        );
        
        return {
            totalProperties: stats.totalProperties,
            totalInquiries: userInquiries.length,
            totalViews: stats.totalViews,
            conversionRate: stats.totalViews > 0 ? ((userInquiries.length / stats.totalViews) * 100).toFixed(1) : 0,
            totalCities: Object.keys(stats.cityData).length,
            forSale: stats.forSale,
            forRent: stats.forRent,
            totalValuation: stats.totalValue,
            marketAvg: stats.totalProperties > 0 ? Math.round(stats.totalValue / stats.totalProperties) : 0,
            pendingCount: stats.pendingCount,
            availableCount: stats.availableCount,
            activeAuctions: stats.activeAuctions,
            totalBids: stats.totalBids,
            avgPriceByCity: avgPriceByCity,
        };
    },
    getDashboardStats(uid) { return this.getStats(uid); },

    getBidsByProperty(propertyId) {
        const prop = this.getPropertyById(propertyId);
        if (!prop || !prop.bids) return [];
        return Object.values(prop.bids).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    },

    // ── Reviews Sync ──
    getReviewsByProperty(propertyId) {
        return _memCache.reviews.filter(r => r.propertyId === propertyId);
    },

    async addReview(propertyId, rating, comment) {
        const user = this.getCurrentUser();
        if (!user) throw new Error('You must be logged in to leave a review.');

        // Validate rating
        const ratingNum = Number(rating);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            throw new Error('Rating must be a number between 1 and 5.');
        }

        // Validate comment
        const trimmedComment = comment ? comment.trim() : '';
        if (!trimmedComment) {
            throw new Error('Please write a comment before submitting your review.');
        }

        // Prevent duplicate reviews (one per user per property)
        const existingReview = _memCache.reviews.find(
            r => r.propertyId === propertyId && r.userId === user.id
        );
        if (existingReview) {
            throw new Error('You have already reviewed this property.');
        }

        if (_syncCallback) _syncCallback('syncing');

        const review = {
            id: 'rev_' + Date.now(),
            propertyId,
            userId: user.id,
            userName: user.name,
            rating: ratingNum,
            comment: trimmedComment,
            date: new Date().toISOString()
        };

        const reviews = [..._memCache.reviews, review];
        _setState({ reviews });
        try {
            await _syncToCloud('reviews/' + review.id, review, 'set');
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

    // ── Recently Viewed ──
    getRecentViews() {
        return _memCache.recentViews;
    },

    addRecentView(userId, propertyId) {
        if (!userId || !propertyId) return;
        const current = [..._memCache.recentViews];
        const filtered = current.filter(id => id !== propertyId);
        const recentViews = [propertyId, ...filtered].slice(0, 10);
        
        _setState({ recentViews });
        _syncToLocal(`recent_v1_${userId}`, recentViews);
    },

    /**
     * Upload an image to Firebase Storage (Production Grade)
     * @param {File|Blob} file 
     * @returns {Promise<string>} Download URL
     */
    async uploadImage(file) {
        if (!storage) throw new Error("Firebase Storage is not initialized.");
        const user = _memCache.currentUser;
        if (!user) throw new Error("Authentication required to upload images.");

        const fileId = Date.now() + '_' + Math.random().toString(36).substring(7);
        const fileName = file.name || `image_${fileId}.jpg`;
        const storageRef = storage.ref(`properties/${user.id}/${fileName}`);

        if (_syncCallback) _syncCallback('syncing');

        try {
            const snapshot = await storageRef.put(file);
            const downloadUrl = await snapshot.ref.getDownloadURL();
            
            if (_syncCallback) _syncCallback('synced');
            console.log("[Storage] File secured in Firebase Storage:", downloadUrl);
            return downloadUrl;
        } catch (e) {
            console.error("[Storage] Firebase Upload failed:", e);
            if (_syncCallback) _syncCallback('error');
            throw new Error("Cloud Storage Failed: " + (e.message || "Unknown error"));
        }
    },

    // ── Google Drive Sync (Legacy/Fallback) ──
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
            const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
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

            if (!permRes.ok) {
                console.error("[Drive] Permission update failed:", await permRes.text());
                throw new Error("Failed to make the image public. Check your Drive permissions.");
            }

            // Use the high-performance thumbnail proxy (most reliable for direct <img> src)
            return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;

        } catch (e) {
            console.error("[Drive Logic Error]", e);
            if (e.message === 'Failed to fetch') {
                throw new Error("Failed to fetch: Service Worker or Network blocked the request. Please Hard Refresh (Ctrl+F5) and ensure your internet is stable.");
            }
            throw e;
        }
    },

    /**
     * Change the current user's role between Buyer and Seller.
     * Admins cannot change their own role — they must use the Firebase console.
     * This method centralises the DB write inside the storage layer,
     * removing the need for direct firebase.database() calls in app.v12.js.
     */
    async changeUserRole(newRole) {
        const user = _memCache.currentUser;
        if (!user) throw new Error('Not authenticated.');
        if (user.role === 'Admin') throw new Error('Admin role cannot be changed from the app.');
        if (newRole !== 'Buyer' && newRole !== 'Seller' && newRole !== 'Broker') throw new Error('Invalid role value.');

        if (_syncCallback) _syncCallback('syncing');
        try {
            await _syncToCloud('users/' + user.id + '/role', newRole, 'set');
            const currentUser = { ..._memCache.currentUser, role: newRole };
            _setState({ currentUser });
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    },

    // ── Bidding & Wallet System ──
    getWalletBalance() {
        return _memCache.currentUser ? (_memCache.currentUser.balance || 0) : 0;
    },

    async addFunds(amount) {
        const user = _memCache.currentUser;
        if (!user) throw new Error('Authentication required');
        const addAmount = Number(amount);
        if (isNaN(addAmount) || addAmount <= 0) throw new Error('Invalid amount');

        if (_syncCallback) _syncCallback('syncing');
        try {
            const newBalance = (user.balance || 0) + addAmount;
            await _syncToCloud(`users/${user.id}/balance`, newBalance, 'set');
            
            // 2. Log wallet transaction (Separate attempt, don't block balance update)
            try {
                if (db && firebase.auth().currentUser) {
                    const uid = firebase.auth().currentUser.uid;
                    await db.ref(`wallet_transactions/${uid}`).push({
                        type: 'DEPOSIT',
                        amount: addAmount,
                        direction: 'credit',
                        description: `Wallet top-up of ₹${addAmount.toLocaleString()}`,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (logErr) {
                console.warn('[Storage] Transaction logging failed, but balance was updated:', logErr.message);
            }
            const currentUser = { ..._memCache.currentUser, balance: newBalance };
            _setState({ currentUser });
            this.logActivity('WALLET_DEPOSIT', `Added \u20b9${addAmount.toLocaleString()} to wallet`);
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    },

    async getWalletTransactions() {
        const user = _memCache.currentUser;
        if (!user || !db) return [];
        try {
            const snap = await db.ref(`wallet_transactions/${user.id}`)
                .orderByChild('timestamp')
                .limitToLast(50)
                .once('value');
            if (!snap.exists()) return [];
            const raw = snap.val();
            // Convert Firebase object to array, sorted newest first
            return Object.entries(raw)
                .map(([key, val]) => ({ id: key, ...val }))
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        } catch (e) {
            console.warn('[Storage] getWalletTransactions failed:', e.message);
            return [];
        }
    },

    async payEntryFee(propertyId) {
        if (_syncCallback) _syncCallback('syncing');
        try {
            const idToken = await (async () => { 
                try { 
                    // Force refresh token to prevent 'expired' errors on Vercel
                    return await firebase.auth().currentUser.getIdToken(true); 
                } catch(e) { 
                    return 'mock-token-' + firebase.auth().currentUser.uid; 
                } 
            })();
            const res = await fetch('/api/bidding/entry', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({ propertyId })
            });

            const data = await res.json();
            if (!res.ok || data.error) {
                throw new Error(data.error || 'Failed to pay entry fee.');
            }
            
            this.logActivity('BID_ENTRY_FEE', `Paid entry fee for property.`);
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    },

    validateBid(propertyId, amount) {
        const user = _memCache.currentUser;
        const prop = this.getPropertyById(propertyId);
        if (!user) throw new Error('You must be logged in to place a bid.');
        if (user.isBanned) throw new Error('Your account is banned from participating in auctions.');
        if (!prop) throw new Error('Property not found.');

        const bidData = prop.bidding;
        if (!bidData || !bidData.enabled) throw new Error('Bidding is not active for this listing.');

        // 1. Time Validation
        const nowTs = Date.now();
        const startTs = new Date(bidData.startTime).getTime();
        const endTs = new Date(bidData.endTime).getTime();
        if (nowTs < startTs) throw new Error('Bidding has not started yet.');
        if (nowTs >= endTs) throw new Error('Bidding has already closed.');

        // 2. Entry Fee Validation
        const participants = bidData.participants || {};
        if (!participants[user.id]) throw new Error('You must pay the entry fee to place a bid.');

        // 3. Increment & Current High Bid Validation
        const currentHighest = Number(prop.highestBid || bidData.basePrice || 0);
        const minIncrement = Number(bidData.minIncrement || 10000);
        const bidAmount = Number(amount);

        if (isNaN(bidAmount) || bidAmount <= 0) throw new Error('Please enter a valid bid amount.');

        if (bidAmount < currentHighest + minIncrement) {
            throw new Error(`Minimum bid required is ₹${(currentHighest + minIncrement).toLocaleString()}.`);
        }

        // 4. Balance Validation
        if ((user.balance || 0) < bidAmount) {
            throw new Error(`Insufficient wallet balance. You need ₹${bidAmount.toLocaleString()} but currently have ₹${(user.balance || 0).toLocaleString()}.`);
        }

        return { bidAmount, currentHighest, bidData };
    },

    async placeBid(propertyId, amount) {
        if (_isSubmittingBid) throw new Error("A bid is already in progress. Please wait.");
        if (!_can('PLACE_BID')) throw new Error("Access Denied: Only verified Buyers can place bids.");
        
        const { bidAmount } = this.validateBid(propertyId, amount);

        _isSubmittingBid = true;
        if (_syncCallback) _syncCallback('syncing');

        try {
            const idToken = await (async () => { 
                try { 
                    // Force refresh token to prevent 'expired' errors on Vercel
                    return await firebase.auth().currentUser.getIdToken(true); 
                } catch(e) { 
                    return 'mock-token-' + firebase.auth().currentUser.uid; 
                } 
            })();
            const res = await fetch('/api/bidding/place', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({ propertyId, amount: bidAmount })
            });

            const data = await res.json();
            if (!res.ok || data.error) {
                this.logAudit('BID_FAILURE', data.error || 'Bid rejected.', { propertyId, amount });
                throw new Error(data.error || 'Bid rejected.');
            }
            
            this.logActivity('PLACE_BID', `Placed bid of ₹${bidAmount.toLocaleString()}`);
            this.logAudit('BID_SUCCESS', `Bid successfully placed`, { propertyId, amount });
            this.addNotification(`You placed a bid of ₹${bidAmount.toLocaleString()}`, 'success', { id: propertyId });
            
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error('[Storage] placeBid error:', e);
            if (_syncCallback) _syncCallback('error');
            throw e;
        } finally {
            _isSubmittingBid = false;
        }
    },

    async finalizeAuction(propertyId) {
        if (!_can('MODIFY_PROPERTY', propertyId)) return false;
        if (_syncCallback) _syncCallback('syncing');

        try {
            const idToken = await (async () => { 
                try { 
                    // Force refresh token to prevent 'expired' errors on Vercel
                    return await firebase.auth().currentUser.getIdToken(true); 
                } catch(e) { 
                    return 'mock-token-' + firebase.auth().currentUser.uid; 
                } 
            })();
            const res = await fetch('/api/bidding/finalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                body: JSON.stringify({ propertyId })
            });

            const data = await res.json();
            
            const p = this.getPropertyById(propertyId);
            if (p && p.bidding) {
                p.bidding.finalized = true;
                if (p.status !== 'Sold' && p.status !== 'PaymentPending') {
                    p.status = p.highestBidderId ? 'Sold' : 'Available';
                }
            }

            if (!res.ok || data.error) {
                if (res.status === 400 && data.error && data.error.includes('already finalized')) {
                    if (_syncCallback) _syncCallback('synced');
                    return true;
                }
                throw new Error(data.error || 'Failed to finalize auction.');
            }
            
            this.logActivity('AUCTION_FINALIZED', `Auction finalized via server API.`);
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error('[Storage] finalizeAuction error:', e);
            if (_syncCallback) _syncCallback('error');
            return false;
        }
    },

    async confirmAuctionPayment(propertyId) {
        if (_syncCallback) _syncCallback('syncing');

        try {
            const idToken = await (async () => { try { return await firebase.auth().currentUser.getIdToken(); } catch(e) { return 'mock-token-' + firebase.auth().currentUser.uid; } })();
            const res = await fetch('/api/bidding/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                body: JSON.stringify({ propertyId })
            });

            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to confirm payment.');
            
            this.logActivity('PAYMENT_CONFIRMED', `Payment confirmed via server API.`);
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error('[Storage] confirmAuctionPayment error:', e);
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    },

    async reportWinnerDefault(propertyId) {
        if (_syncCallback) _syncCallback('syncing');

        try {
            const idToken = await (async () => { try { return await firebase.auth().currentUser.getIdToken(); } catch(e) { return 'mock-token-' + firebase.auth().currentUser.uid; } })();
            const res = await fetch('/api/bidding/default', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                body: JSON.stringify({ propertyId })
            });

            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to report default.');
            
            this.logActivity('USER_STRIKE', `Winner default processed via server API.`);
            if (_syncCallback) _syncCallback('synced');
            return true;
        } catch (e) {
            console.error('[Storage] reportWinnerDefault error:', e);
            if (_syncCallback) _syncCallback('error');
            throw e;
        }
    }
};
window.EstatoStorage = EstatoStorage;

