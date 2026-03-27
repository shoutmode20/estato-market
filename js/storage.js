// ================================================================
// V10.1 — Unified Google Identity & Drive Storage Engine
// Estato | Premium Real Estate Marketplace
// ================================================================

const CLIENT_ID = '736980714234-3v1kjt5sn4doqtv06b280k38j821p3ec.apps.googleusercontent.com';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const DRIVE_FILE_NAME = 'estato_data.json';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const USERINFO_API = 'https://www.googleapis.com/oauth2/v3/userinfo';

// In-memory cache
let _memCache = null;
let _driveFileId = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _tokenClient = null;
let _syncCallback = null;
let _pendingSync = false;
let _saveTimeout = null;

const LS_SNAPSHOT_KEY = 'estato_offline_snapshot';
const LS_TIMESTAMP_KEY = 'estato_offline_snapshot_timestamp';
const LS_FILEID_KEY   = 'estato_offline_snapshot_fileid';
const LS_PENDING_KEY  = 'estato_pending_sync';
const CACHE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ─── Offline & Cache Helpers ─────────────────────────────────────
function _saveLocalSnapshot() {
    try {
        localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(_memCache));
        localStorage.setItem(LS_TIMESTAMP_KEY, Date.now().toString());
        if (_driveFileId) localStorage.setItem(LS_FILEID_KEY, _driveFileId);
    } catch(e) { console.warn('[Estato] localStorage full, snapshot skipped.'); }
}

function _loadLocalSnapshot(checkExpiry = false) {
    try {
        if (checkExpiry) {
            const time = parseInt(localStorage.getItem(LS_TIMESTAMP_KEY) || '0', 10);
            if (Date.now() - time > CACHE_EXPIRY_MS) return null; // Cache expired
        }
        const raw = localStorage.getItem(LS_SNAPSHOT_KEY);
        if (raw) {
            _driveFileId = localStorage.getItem(LS_FILEID_KEY) || _driveFileId;
            return JSON.parse(raw);
        }
        return null;
    } catch(e) { return null; }
}

async function _flushPendingSync() {
    if (!localStorage.getItem(LS_PENDING_KEY)) return;
    console.log('[Estato] Back online — flushing pending Drive sync...');
    await DriveEngine.saveToDrive();
    localStorage.removeItem(LS_PENDING_KEY);
    _pendingSync = false;
}

// Local formatter for notification messages
const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
});

// ─── Default Seed Data ───────────────────────────────────────────
const defaultData = {
    cities: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Pune'],
    properties: [
        {
            id: 'prop_1',
            ownerId: 'system_admin',
            title: 'Sea-Facing Luxury Penthouse',
            city: 'Mumbai',
            lat: 19.0760,
            lng: 72.8777,
            price: 55000000,
            address: '10 Marine Drive, Mumbai 400020',
            type: 'Sale',
            status: 'Available',
            category: 'Apartment',
            bhk: '4+ BHK',
            area: 3200,
            images: [
                'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?q=80&w=800&auto=format&fit=crop',
                'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=800&auto=format&fit=crop',
                'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?q=80&w=800&auto=format&fit=crop'
            ]
        }
    ],
    favorites: [],
    inquiries: [],
    notifications: [],
    activities: []
};

// ─── Drive & Identity REST Helpers ────────────────────────────────
async function _googleRequest(url, options = {}) {
    if (!_accessToken) throw new Error('NOT_AUTHENTICATED');
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': 'Bearer ' + _accessToken,
            ...options.headers
        }
    });
    if (res.status === 401) throw new Error('TOKEN_EXPIRED');
    return res;
}

async function _findFile() {
    const query = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const res = await _googleRequest(`${DRIVE_API}/files?q=${query}&fields=files(id,name)&spaces=drive`);
    const data = await res.json();
    return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

async function _downloadFile(fileId) {
    const res = await _googleRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
    return await res.json();
}

async function _createFile(content) {
    const meta = JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' });
    const body = JSON.stringify(content);
    const form = new FormData();
    form.append('metadata', new Blob([meta], { type: 'application/json' }));
    form.append('media', new Blob([body], { type: 'application/json' }));
    const res = await _googleRequest(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
        { method: 'POST', body: form }
    );
    const data = await res.json();
    return data.id;
}

async function _updateFile(fileId, content) {
    await _googleRequest(
        `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(content)
        }
    );
}

// ─── Drive & Auth Engine ──────────────────────────────────────────
const DriveEngine = {
    init(syncCb) {
        _syncCallback = syncCb;
        return new Promise((resolve) => {
            const tryInit = () => {
                if (window.google && window.google.accounts) {
                    _tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: CLIENT_ID,
                        scope: DRIVE_SCOPES,
                        callback: () => {} 
                    });
                    resolve(true);
                } else {
                    setTimeout(tryInit, 150);
                }
            };
            tryInit();
        });
    },

    isConnected() { return !!_accessToken; },

    requestToken(silent = false) {
        return new Promise((resolve, reject) => {
            _tokenClient.callback = (resp) => {
                if (resp.error) { reject(new Error(resp.error)); return; }
                _accessToken = resp.access_token;
                // GIS tokens are valid for 3600s; store with a safe 5-min early-expiry buffer
                _tokenExpiry = Date.now() + ((resp.expires_in || 3600) - 300) * 1000;
                sessionStorage.setItem('estato_token', _accessToken);
                sessionStorage.setItem('estato_token_expiry', String(_tokenExpiry));
                resolve(resp.access_token);
            };
            _tokenClient.requestAccessToken({ prompt: silent ? '' : 'select_account' });
        });
    },

    isTokenValid() {
        return !!_accessToken && Date.now() < _tokenExpiry;
    },

    async fetchProfile() {
        const res = await _googleRequest(USERINFO_API);
        const profile = await res.json();
        return {
            id: profile.sub,
            name: profile.name,
            email: profile.email,
            picture: profile.picture
        };
    },

    async loadFromDrive() {
        try {
            // Smart Cache Check: valid cache? skip Drive fetch!
            const validCache = _loadLocalSnapshot(true);
            if (validCache && navigator.onLine) {
                _memCache = validCache;
                console.log('[Estato] Using valid local cache, skipping Drive fetch.');
                return true;
            }

            console.log('[Estato] Cache missed or expired, fetching from Drive...');
            _driveFileId = await _findFile();
            if (_driveFileId) {
                _memCache = await _downloadFile(_driveFileId);
            } else {
                _memCache = JSON.parse(JSON.stringify(defaultData));
                _driveFileId = await _createFile(_memCache);
            }
            _saveLocalSnapshot(); // Update cache & timestamp on successful load
            return true;
        } catch(e) {
            console.error('[Estato] Drive sync error:', e.message);
            if (e.message === 'TOKEN_EXPIRED') _accessToken = null;
            // Graceful offline fallback: restore last known snapshot (ignoring expiry)
            const snapshot = _loadLocalSnapshot(false);
            if (snapshot) {
                _memCache = snapshot;
                console.warn('[Estato] Offline mode — using local snapshot.');
                if (_syncCallback) _syncCallback('offline');
            }
            return !!snapshot;
        }
    },

    async saveToDrive() {
        if (!_accessToken || !_memCache) return;
        if (_syncCallback) _syncCallback('syncing');
        try {
            if (_driveFileId) {
                await _updateFile(_driveFileId, _memCache);
            } else {
                _driveFileId = await _createFile(_memCache);
            }
            if (_syncCallback) _syncCallback('synced');
        } catch(e) {
            console.error('[Estato] Save error:', e.message);
            if (_syncCallback) _syncCallback('error');
            if (e.message === 'TOKEN_EXPIRED') _accessToken = null;
        }
    }
};

// ─── Public Storage API ───────────────────────────────────────────
const Storage = {
    async initDrive(syncCb) {
        return DriveEngine.init(syncCb);
    },

    /** Central Login Entry Point */
    async loginWithGoogle(selectedRole = 'Seller', silent = false) {
        try {
            // Restore token from session if silent
            if (silent) {
                const cachedToken = sessionStorage.getItem('estato_token');
                const cachedExpiry = parseInt(sessionStorage.getItem('estato_token_expiry') || '0', 10);
                if (cachedToken && Date.now() < cachedExpiry) {
                    _accessToken = cachedToken;
                    _tokenExpiry = cachedExpiry;
                } else {
                    // Token missing or expired — clear stale session data
                    sessionStorage.removeItem('estato_token');
                    sessionStorage.removeItem('estato_token_expiry');
                    return false;
                }
            } else {
                await DriveEngine.requestToken(false);
            }

            // 1. Fetch User Identity
            const profile = await DriveEngine.fetchProfile();
            
            // 2. Hydrate Data from Drive
            await DriveEngine.loadFromDrive();

            // 3. Setup Current User
            // For demo/testing purposes, always respect the UI selectedRole if provided.
            // If silent login (selectedRole is null), fallback to their cached role.
            const existingUser = _memCache.currentUser && _memCache.currentUser.id === profile.id ? _memCache.currentUser : null;
            const roleToUse = selectedRole || (existingUser ? existingUser.role : 'Buyer');
            
            _memCache.currentUser = {
                ...profile,
                role: roleToUse
            };

            // Persist for session restoration
            localStorage.setItem('estato_user_role', _memCache.currentUser.role);

            this._save();
            return true;
        } catch(e) {
            console.warn('[Estato] Auth Flow interrupted:', e.message);
            return false;
        }
    },

    logout() {
        if (_memCache) _memCache.currentUser = null;
        _accessToken = null;
        _tokenExpiry = 0;
        sessionStorage.removeItem('estato_token');
        sessionStorage.removeItem('estato_token_expiry');
        localStorage.removeItem('estato_user_role');
        // Note: we intentionally do NOT call _save() here because the token is
        // already cleared — saveToDrive() would silently skip anyway.
    },

    getCurrentUser() {
        return _memCache ? _memCache.currentUser : null;
    },

    getData() { return _memCache; },

    /** Flush any pending Drive saves queued while offline */
    async _flushPendingSync() { return _flushPendingSync(); },

    /** True when the last save was deferred due to being offline */
    hasPendingSync() { return _pendingSync || !!localStorage.getItem(LS_PENDING_KEY); },

    _save() {
        _saveLocalSnapshot(); // Always persist locally first (UI updates instantly)
        
        if (!navigator.onLine) {
            // Mark as pending; service worker background sync will retry
            localStorage.setItem(LS_PENDING_KEY, '1');
            _pendingSync = true;
            if (_syncCallback) _syncCallback('offline');
            // Register Background Sync if supported
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(reg => {
                    if (reg.sync) reg.sync.register('estato-drive-sync').catch(() => {});
                });
            }
            return;
        }

        // Write-Behind Cache: Debounce Drive writes by 2 seconds
        if (_saveTimeout) clearTimeout(_saveTimeout);
        
        // Let the UI know we are queuing a save (debounced)
        if (_syncCallback) _syncCallback('syncing');

        _saveTimeout = setTimeout(() => {
            DriveEngine.saveToDrive();
        }, 2000);
    },

    // ── Properties Logic ──
    getProperties() { return _memCache ? _memCache.properties : []; },

    getPropertyById(id) {
        return this.getProperties().find(p => p.id === id);
    },

    addProperty(property) {
        const data = _memCache;
        property.id = 'prop_' + Date.now();
        property.ownerId = data.currentUser.id;
        
        // Initialize Price History
        property.priceHistory = [{
            price: property.price,
            date: new Date().toISOString()
        }];

        data.properties.push(property);
        if (property.city && !data.cities.includes(property.city)) {
            data.cities.push(property.city);
        }
        
        this.addNotification(`New property listed: ${property.title}`, 'new_listing', { id: property.id });
        
        this.logActivity('ADD_PROPERTY', `Added new ${property.category}: ${property.title}`);

        this._save();
        return property;
    },

    updateProperty(updatedProp) {
        const data = _memCache;
        const index = data.properties.findIndex(p => p.id === updatedProp.id);
        if (index !== -1) {
            const prop = data.properties[index];
            const user = data.currentUser;
            
            // Security: Only owner or admin can update
            const isAuthorized = user && (user.role === 'Admin' || prop.ownerId === user.id);
            if (!isAuthorized) {
                console.error("Unauthorized update attempt");
                return false;
            }

            // Trigger price update notification & history log
            if (updatedProp.price && Number(updatedProp.price) !== Number(prop.price)) {
                this.addNotification(`Price updated for ${prop.title}: ${currencyFormatter.format(updatedProp.price)}`, 'price_update', { id: prop.id });
                
                if (!prop.priceHistory) prop.priceHistory = [];
                prop.priceHistory.push({
                    price: Number(updatedProp.price),
                    date: new Date().toISOString()
                });
            }

            // Preserve ownerId and history across updates
            data.properties[index] = {
                ...prop,
                ...updatedProp,
                priceHistory: prop.priceHistory,
                ownerId: prop.ownerId
            };

            this.logActivity('UPDATE_PROPERTY', `Updated ${prop.title} (${updatedProp.id})`);

            this._save();
            return true;
        }
        return false;
    },

    deleteProperty(id) {
        const data = _memCache;
        const prop = data.properties.find(p => p.id === id);
        if (!prop) return false;
        
        // RBAC: owner can delete their own, Admin can delete ANY
        const isAuthorized = data.currentUser && (data.currentUser.role === 'Admin' || prop.ownerId === data.currentUser.id);
        if (!isAuthorized) return false;
        
        data.properties = data.properties.filter(p => p.id !== id);
        
        this.logActivity('DELETE_PROPERTY', `Deleted property: ${prop.title} (${id})`);

        this._save();
        return true;
    },

    // ── Favorites ──
    getFavorites() { 
        if (!_memCache || !_memCache.favorites) return [];
        return _memCache.favorites; 
    },

    toggleFavorite(id) {
        if (!_memCache) return;
        if (!_memCache.favorites) _memCache.favorites = [];
        const index = _memCache.favorites.indexOf(id);
        if (index === -1) _memCache.favorites.push(id);
        else _memCache.favorites.splice(index, 1);
        this._save();
    },

    // ── Cities / CRM ──
    getCities() { return _memCache ? _memCache.cities : []; },
    getInquiries() { return _memCache ? _memCache.inquiries : []; },
    addInquiry(inquiry) {
        if (!_memCache.inquiries) _memCache.inquiries = [];
        inquiry.id = 'inq_' + Date.now();
        inquiry.date = new Date().toISOString();
        inquiry.read = false;
        
        _memCache.inquiries.push(inquiry);
        
        // Trigger automated notification for the Seller
        this.addNotification(
            `New Inquiry alert for ${inquiry.propertyTitle} from ${inquiry.buyerName}`, 
            'new_inquiry', 
            { id: inquiry.propertyId, ownerId: inquiry.ownerId }
        );

        this._save();
        return inquiry;
    },

    deleteInquiry(id) {
        if (!_memCache.inquiries) return false;
        const index = _memCache.inquiries.findIndex(i => i.id === id);
        if (index === -1) return false;
        
        _memCache.inquiries.splice(index, 1);
        this._save();
        return true;
    },

    // ── Notifications ──
    getNotifications() {
        if (!_memCache || !_memCache.notifications) return [];
        return _memCache.notifications;
    },

    addNotification(message, type = 'info', meta = {}) {
        if (!_memCache) return;
        if (!_memCache.notifications) _memCache.notifications = [];
        
        const notification = {
            id: 'notif_' + Date.now(),
            message,
            type,
            meta,
            timestamp: new Date().toISOString(),
            read: false
        };
        
        _memCache.notifications.unshift(notification); // Newest first
        this._save();
    },

    markNotificationsRead() {
        if (!_memCache || !_memCache.notifications) return;
        _memCache.notifications.forEach(n => n.read = true);
        this._save();
    },

    // ── Activity Logging ──
    getActivities() {
        if (!_memCache || !_memCache.activities) return [];
        return _memCache.activities;
    },

    logActivity(action, details) {
        if (!_memCache) return;
        if (!_memCache.activities) _memCache.activities = [];
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
        
        // Keep only last 100 activities
        if (_memCache.activities.length > 100) {
            _memCache.activities = _memCache.activities.slice(0, 100);
        }

        this._save();
    },

    getStats() {
        const properties = this.getProperties();
        const user = this.getCurrentUser();
        if (!user) return { totalProperties: 0, totalCities: 0, forSale: 0, forRent: 0, totalValue: 0, avgPriceByCity: {}, typeDistribution: {} };
        
        // Admin sees everything, Seller sees only their own
        const filtered = user.role === 'Admin' ? properties : properties.filter(p => p.ownerId === user.id);
        
        const stats = {
            totalProperties: filtered.length,
            totalValue: 0,
            forSale: 0,
            forRent: 0,
            cityData: {}, // { city: { count: 0, total: 0 } }
            typeDistribution: { 'Sale': 0, 'Rent': 0 }
        };

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
        for (const city in stats.cityData) {
            avgPriceByCity[city] = Math.round(stats.cityData[city].total / stats.cityData[city].count);
        }

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
        if (!_memCache || !_memCache.reviews) return [];
        return _memCache.reviews.filter(r => r.propertyId === propertyId);
    },

    addReview(propertyId, rating, comment) {
        if (!_memCache) return;
        if (!_memCache.reviews) _memCache.reviews = [];
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
        this._save();
        return review;
    },

    getAverageRating(propertyId) {
        const reviews = this.getReviewsByProperty(propertyId);
        if (reviews.length === 0) return { average: 0, count: 0 };
        const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
        return {
            average: (sum / reviews.length).toFixed(1),
            count: reviews.length
        };
    },

    // ── Recently Viewed (LocalStorage Only) ──
    getRecentViews(userId) {
        if (!userId) return [];
        try {
            const data = localStorage.getItem(`estato_recent_v1_${userId}`);
            return data ? JSON.parse(data) : [];
        } catch(e) { return []; }
    },

    addRecentView(userId, propertyId) {
        if (!userId || !propertyId) return;
        try {
            const current = this.getRecentViews(userId);
            const filtered = current.filter(id => id !== propertyId);
            const updated = [propertyId, ...filtered].slice(0, 10);
            localStorage.setItem(`estato_recent_v1_${userId}`, JSON.stringify(updated));
        } catch(e) { console.warn('[Storage] Recent view save failed:', e); }
    },

    /** Full System Restore (Admins Only) */
    restoreData(newData) {
        if (!newData || typeof newData !== 'object') throw new Error('Invalid data format');
        
        // Validation: Required root arrays
        const required = ['properties', 'users', 'cities', 'favorites', 'inquiries', 'notifications', 'activities'];
        const missing = required.filter(key => !Array.isArray(newData[key]) && key !== 'users'); // users is optional if relying on Drive auth
        
        if (missing.includes('properties')) throw new Error('Backup is missing property database');

        // Preserve current user to prevent session hijacking via restore
        const currentUser = _memCache ? _memCache.currentUser : (newData.currentUser || null);
        
        _memCache = {
            ...newData,
            currentUser: currentUser // Ensure person restoring stays logged in
        };

        console.log('[Estato] Full system restore successful. Syncing...');
        this._save();
        return true;
    }
};
