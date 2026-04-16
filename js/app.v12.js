/* Estato V12.1 - Production - SEO & Pagination Enabled */
document.addEventListener('DOMContentLoaded', () => {

    // --- State and Cache ---
    let currentUser = null;
    let currentView = 'properties'; // Default fallback
    let currentFilterCity = null;
    let storageSubscribed = false;   // Guard: prevent duplicate EstatoStorage.subscribe() calls across re-auths

    let currentSort = 'newest';
    let currentTypeFilter = '';
    let currentStatusFilter = '';
    let currentCategoryFilter = '';

    window.formatEstatoImage = function(url) {
        if (!url || typeof url !== 'string') return url || '';
        return url.replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0];
    };

    window.ESTATO_DEFAULT_IMG = 'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?q=80&w=800&auto=format&fit=crop';

    let dashboardCharts = [];

    // V11 States
    let map = null;
    let mapLayerGroup = null;
    let markers = [];
    let isMapVisible = false;
    let compareList = JSON.parse(localStorage.getItem('estato_compare_v1') || '[]')
                        .map(id => EstatoStorage.getPropertyById(id))
                        .filter(p => p); 
    let modalMap = null;
    let modalMarker = null;

    // Radius Search States
    let currentRadiusCenter = null; // {lat, lng}
    let currentRadiusKm = 10;
    
    // --- Utilities ---
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    /** Sanitize any user-generated string before injecting into innerHTML to prevent Stored XSS */
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Non-blocking toast notification system.
     * Replaces all blocking alert() calls throughout the app.
     * @param {string} message - Text to display
     * @param {'info'|'success'|'danger'|'warning'} type - Visual style
     * @param {number} duration - Auto-dismiss delay in ms
     */
    function showToast(message, type = 'info', duration = 4500) {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            Object.assign(container.style, {
                position: 'fixed', bottom: '1.5rem', right: '1.5rem',
                zIndex: '99999', display: 'flex', flexDirection: 'column',
                gap: '0.5rem', maxWidth: '400px', pointerEvents: 'none'
            });
            document.body.appendChild(container);
        }
        const iconMap = { success: 'ph-check-circle', danger: 'ph-warning-circle', info: 'ph-info', warning: 'ph-warning' };
        const colorMap = { success: 'var(--success)', danger: 'var(--danger)', info: 'var(--primary)', warning: '#d97706' };
        const toast = document.createElement('div');
        toast.style.cssText = `background:var(--bg-surface);border:1px solid var(--border-color);border-left:4px solid ${colorMap[type]||colorMap.info};padding:1rem 1.25rem;border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);display:flex;align-items:flex-start;gap:0.75rem;pointer-events:all;animation:slideUpFade 0.3s ease-out;`;
        toast.innerHTML = `<i class="ph-fill ${iconMap[type]||iconMap.info}" style="color:${colorMap[type]||colorMap.info};font-size:1.2rem;flex-shrink:0;margin-top:1px;"></i><span style="font-size:0.88rem;color:var(--text-main);flex:1;line-height:1.5;">${escapeHtml(message)}</span><i class="ph ph-x" style="cursor:pointer;color:var(--text-muted);font-size:0.9rem;flex-shrink:0;" onclick="this.closest('div').remove()"></i>`;
        container.appendChild(toast);
        setTimeout(() => { if (toast.parentElement) toast.remove(); }, duration);
    }

    /**
     * Non-blocking confirm dialog. Replaces native confirm().
     * @param {string} message - Question to ask
     * @param {function} onConfirm - Called when user clicks confirm
     * @param {function} [onCancel] - Called when user clicks cancel
     */
    function showConfirm(message, onConfirm, onCancel) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;`;
        overlay.innerHTML = `
            <div style="background:var(--bg-surface);border-radius:var(--radius-md);padding:2rem;max-width:420px;width:90%;box-shadow:var(--shadow-lg);border:1px solid var(--border-color);">
                <div style="display:flex;align-items:flex-start;gap:1rem;margin-bottom:1.5rem;">
                    <i class="ph-fill ph-warning-circle" style="color:var(--danger);font-size:1.5rem;flex-shrink:0;margin-top:2px;"></i>
                    <p style="margin:0;color:var(--text-main);font-size:0.95rem;line-height:1.6;">${escapeHtml(message)}</p>
                </div>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                    <button id="_cancelBtn" style="padding:0.6rem 1.25rem;border-radius:var(--radius-sm);border:1px solid var(--border-color);background:var(--bg-main);color:var(--text-main);cursor:pointer;font-size:0.875rem;">Cancel</button>
                    <button id="_confirmBtn" style="padding:0.6rem 1.25rem;border-radius:var(--radius-sm);border:none;background:var(--danger);color:#fff;cursor:pointer;font-size:0.875rem;font-weight:600;">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#_confirmBtn').onclick = () => { overlay.remove(); onConfirm(); };
        overlay.querySelector('#_cancelBtn').onclick = () => { overlay.remove(); if (onCancel) onCancel(); };
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); if (onCancel) onCancel(); } };
    }

    /**
     * Non-blocking prompt dialog. Replaces native prompt().
     * @param {string} message - Label for the input
     * @param {function} callback - Called with the entered string, or null if cancelled
     */
    function showPrompt(message, callback) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;`;
        overlay.innerHTML = `
            <div style="background:var(--bg-surface);border-radius:var(--radius-md);padding:2rem;max-width:440px;width:90%;box-shadow:var(--shadow-lg);border:1px solid var(--border-color);">
                <p style="margin:0 0 1rem 0;color:var(--text-main);font-size:0.95rem;line-height:1.6;">${escapeHtml(message)}</p>
                <textarea id="_promptInput" rows="3" style="width:100%;padding:0.75rem;border:1px solid var(--border-color);border-radius:var(--radius-sm);font-size:0.875rem;background:var(--bg-main);color:var(--text-main);resize:vertical;box-sizing:border-box;" placeholder="Enter reason..."></textarea>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;margin-top:1rem;">
                    <button id="_promptCancel" style="padding:0.6rem 1.25rem;border-radius:var(--radius-sm);border:1px solid var(--border-color);background:var(--bg-main);color:var(--text-main);cursor:pointer;font-size:0.875rem;">Cancel</button>
                    <button id="_promptSubmit" style="padding:0.6rem 1.25rem;border-radius:var(--radius-sm);border:none;background:var(--danger);color:#fff;cursor:pointer;font-size:0.875rem;font-weight:600;">Submit</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#_promptInput');
        input.focus();
        overlay.querySelector('#_promptSubmit').onclick = () => { overlay.remove(); callback(input.value); };
        overlay.querySelector('#_promptCancel').onclick = () => { overlay.remove(); callback(null); };
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); callback(null); } };
    }

    // Property Category Static Metadata
    const PROPERTY_METADATA = {
        'Apartment': { icon: 'ph-buildings', tags: ['High-rise', 'Security', 'Amenities'], avgPriceRange: '₹50L - ₹5Cr', color: 'blue' },
        'Villa': { icon: 'ph-house-line', tags: ['Private', 'Garden', 'Spacious'], avgPriceRange: '₹3Cr - ₹20Cr', color: 'green' },
        'Plot': { icon: 'ph-map-trifold', tags: ['Land', 'Investment', 'Customizable'], avgPriceRange: '₹20L - ₹2Cr', color: 'orange' },
        'Commercial': { icon: 'ph-storefront', tags: ['Retail', 'Office', 'High ROI'], avgPriceRange: '₹1Cr - ₹10Cr', color: 'purple' }
    };

    // Filter Configuration
    const FILTER_CONFIG = {
        sortOptions: [
            { value: 'newest', label: 'Newest First' },
            { value: 'oldest', label: 'Oldest First' },
            { value: 'price-low', label: 'Price: Low to High' },
            { value: 'price-high', label: 'Price: High to Low' }
        ],
        types: ['Sale', 'Rent'],
        categories: Object.keys(PROPERTY_METADATA),
        statuses: ['Available', 'Pending', 'Rented', 'Sold'],
        bhkLayouts: ['Studio', '1 BHK', '2 BHK', '3 BHK', '4+ BHK']
    };

    // Generator Constants for Dummy Data
    const PROPERTY_GENERATOR_DATA = {
        adjectives: ['Modern', 'Luxurious', 'Cozy', 'Spacious', 'Urban', 'Serene', 'Elite', 'Prime', 'Royal', 'Elegant'],
        types: ['Penthouse', 'Apartment', 'Villa', 'Studio', 'Loft', 'Bungalow', 'Townhouse', 'Duplex'],
        features: ['Near Metro', 'Beachfront', 'City Center', 'Quiet Street', 'Park Facing', 'Mountain View', 'Riverside'],
        amenities: ['Pool', 'Gym', 'Garden', 'Balcony', 'Modular Kitchen', 'Italian Marble', 'Home Automation', '24/7 Security'],
        images: [
            'https://images.unsplash.com/photo-1560448204-61dc36dc98ce?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1460317442991-0ec209397118?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1600585154340-be6191bcbe10?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1599809275671-b5942cabc7a2?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&q=80&w=800',
            'https://images.unsplash.com/photo-1580587767303-9e99a63b3f9c?auto=format&fit=crop&q=80&w=800'
        ]
    };

    // City Geocoding Map — Top 50 Indian cities
    const CITY_COORDS = {
        'Mumbai': [19.0760, 72.8777],
        'Delhi': [28.6139, 77.2090],
        'Bangalore': [12.9716, 77.5946],
        'Chennai': [13.0827, 80.2707],
        'Pune': [18.5204, 73.8567],
        'Hyderabad': [17.3850, 78.4867],
        'Ahmedabad': [23.0225, 72.5714],
        'Kolkata': [22.5726, 88.3639],
        'Surat': [21.1702, 72.8311],
        'Jaipur': [26.9124, 75.7873],
        'Lucknow': [26.8467, 80.9462],
        'Kanpur': [26.4499, 80.3319],
        'Nagpur': [21.1458, 79.0882],
        'Indore': [22.7196, 75.8577],
        'Thane': [19.2183, 72.9781],
        'Bhopal': [23.2599, 77.4126],
        'Visakhapatnam': [17.6868, 83.2185],
        'Pimpri': [18.6279, 73.7997],
        'Patna': [25.5941, 85.1376],
        'Vadodara': [22.3072, 73.1812],
        'Ghaziabad': [28.6692, 77.4538],
        'Ludhiana': [30.9010, 75.8573],
        'Agra': [27.1767, 78.0081],
        'Nashik': [19.9975, 73.7898],
        'Faridabad': [28.4089, 77.3178],
        'Coimbatore': [11.0168, 76.9558],
        'Kochi': [9.9312, 76.2673],
        'Chandigarh': [30.7333, 76.7794],
        'Gurgaon': [28.4595, 77.0266],
        'Noida': [28.5355, 77.3910],
        'Rajkot': [22.3039, 70.8022],
        'Kalyan': [19.2403, 73.1305],
        'Vasai': [19.3919, 72.8397],
        'Varanasi': [25.3176, 82.9739],
        'Srinagar': [34.0837, 74.7973],
        'Aurangabad': [19.8762, 75.3433],
        'Dhanbad': [23.7957, 86.4304],
        'Amritsar': [31.6340, 74.8723],
        'Navi Mumbai': [19.0330, 73.0297],
        'Allahabad': [25.4358, 81.8463],
        'Howrah': [22.5958, 88.2636],
        'Ranchi': [23.3441, 85.3096],
        'Gwalior': [26.2124, 78.1772],
        'Jabalpur': [23.1815, 79.9864],
        'Vijayawada': [16.5062, 80.6480],
        'Jodhpur': [26.2389, 73.0243],
        'Madurai': [9.9252, 78.1198],
        'Raipur': [21.2514, 81.6296],
        'Kota': [25.2138, 75.8648],
        'Guwahati': [26.1445, 91.7362]
    };

    // --- DOM Elements ---
    const loginScreen = document.getElementById('loginScreen');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const appContainer = document.getElementById('appContainer');
    const syncBadge = document.getElementById('syncBadge');
    
    // Unified Auth DOM
    const googleLoginBtn = document.getElementById('googleLoginBtn');
    const loginRoleCards = document.querySelectorAll('#loginRoleSelector .role-card');
    const selectedRoleInput = document.getElementById('selectedRole');
    const loginErrorMsg = document.getElementById('loginErrorMsg');

    const navItems = document.querySelectorAll('.nav-item:not(.title-divider)');
    const viewContainer = document.getElementById('viewContainer');
    const searchInput = document.getElementById('searchInput');

    const propertyModal = document.getElementById('propertyModal');
    const openAddModalBtn = document.getElementById('openAddModalBtn');
    const mobileAddBtn = document.getElementById('mobileAddBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const cancelModalBtn = document.getElementById('cancelModalBtn');
    const propertyForm = document.getElementById('propertyForm');
    const modalTitle = document.getElementById('modalTitle');
    const citiesListDropdown = document.getElementById('citiesList');

    const propImageFile = document.getElementById('propImageFile');
    const propImageHidden = document.getElementById('propImage');
    const imagePreviewContainer = document.getElementById('imagePreviewContainer');

    // Notifications DOM
    const notifBell = document.getElementById('notificationBell');
    const notifBadge = document.getElementById('notifBadge');
    const notifDropdown = document.getElementById('notifDropdown');
    const notifList = document.getElementById('notifList');
    const markReadBtn = document.getElementById('markReadBtn');

    // Number Formatter
    const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

    // --- Sync Badge Updater ---
    function updateSyncBadge(state) {
        const badge = syncBadge;
        badge.className = 'sync-badge';
        if (state === 'syncing') {
            badge.classList.add('sync-syncing');
            badge.innerHTML = '<i class="ph ph-arrow-clockwise"></i><span>Saving...</span>';
        } else if (state === 'error') {
            badge.classList.add('sync-error');
            badge.innerHTML = '<i class="ph ph-warning"></i><span>Error</span>';
        } else if (state === 'offline') {
            badge.classList.add('sync-error');
            badge.innerHTML = '<i class="ph ph-wifi-slash"></i><span>Offline</span>';
        } else {
            badge.classList.add('sync-synced');
            badge.innerHTML = '<i class="ph ph-check-circle"></i><span>Synced</span>';
        }
    }

    // --- Online / Offline Handling ---
    window.addEventListener('online', async () => {
        console.log('[Estato] Back online — flushing pending sync...');
        updateSyncBadge('syncing');
        await EstatoStorage._flushPendingSync();
        updateSyncBadge('synced');
    });

    window.addEventListener('offline', () => {
        console.log('[Estato] Gone offline.');
        updateSyncBadge('offline');
    });

    // Handle SW Background Sync message (service worker -> app)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', async (event) => {
            if (event.data && event.data.type === 'SYNC_NOW') {
                await EstatoStorage._flushPendingSync();
                updateSyncBadge('synced');
            }
        });
    }

    // Set initial badge state based on current connectivity
    if (!navigator.onLine) updateSyncBadge('offline');

    // --- Radius Search Utilities ---
    // Implementation of Haversine formula for exact geospatial distance
    function getHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in kilometers
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    async function resolveLocationToCoords(locString) {
        // 1. Check if it's manual coords (lat, lng)
        const parts = locString.trim().split(',').map(p => parseFloat(p.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            return { lat: parts[0], lng: parts[1] };
        }

        const normalized = locString.trim().toLowerCase();
        
        // 2. Check static map first (case-insensitive)
        const localMatchKey = Object.keys(CITY_COORDS).find(k => k.toLowerCase() === normalized);
        if (localMatchKey) {
            return { lat: CITY_COORDS[localMatchKey][0], lng: CITY_COORDS[localMatchKey][1] };
        }

        // 3. Fallback to API (Nominatim)
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(normalized)}&limit=1`);
            const data = await res.json();
            if (data && data.length > 0) {
                return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
            }
        } catch (e) {
            console.error("Geocoding API failed:", e);
        }

        return null;
    }

    // --- Initialization ---
    console.log("Estato V12.1 (Production) Booting...");
    initApp();

    async function initApp() {
        console.log("Initializing App flow...");
        setupAuthListeners();

        // 1. Initialize GIS & Drive Engine
        try {
            await EstatoStorage.initDrive(updateSyncBadge);
            console.log("Drive Engine Initialized.");
        } catch (err) {
            console.error("Drive Engine Init Failed:", err);
            loginErrorMsg.textContent = "Sync Error: Could not connect to Google.";
        }

        // 2. Try silent/cached login to bypass screen if already connected in this session
        try {
            const ok = await EstatoStorage.loginWithGoogle(null, true); // silent = true
            if (ok) {
                checkAuth();
                return;
            }
        } catch(e) {}

        // 3. Fallback to login screen
        loginScreen.classList.remove('hidden');
    }

    // --- AUTHENTICATION ENGINE ---
    function checkAuth() {
        currentUser = EstatoStorage.getCurrentUser();
        if (currentUser) {
            loginScreen.classList.add('hidden');
            loadingOverlay.classList.add('hidden');
            appContainer.classList.remove('hidden');
            
            document.getElementById('headerGreetingText').textContent = `Hello, ${currentUser.name.split(' ')[0]}`;
            document.getElementById('headerRoleBadge').textContent = currentUser.role;

            applyRBACToDOM();
            
            currentView = (currentUser.role === 'Seller' || currentUser.role === 'Admin') ? 'dashboard' : 'properties';
            setActiveNav(currentView);
            
            setupAppListeners();
            renderView(currentView);
            renderNotifications();
            populateCitiesDatalist();

            // Real-time UI Sync — guard ensures we subscribe only once per session
            // even if checkAuth() is called again (e.g. after Drive re-auth).
            // The debounce collapses rapid simultaneous DB events into one render pass.
            if (!storageSubscribed) {
                storageSubscribed = true;
                const _debouncedRender = debounce(() => {
                    renderView(currentView, searchInput.value);
                    renderNotifications();
                    updateSeoMetadata();
                }, 150);
                EstatoStorage.subscribe(_debouncedRender);
            }
        } else {
            loginScreen.classList.remove('hidden');
            appContainer.classList.add('hidden');
        }
    }

    function setupAuthListeners() {
        console.log("Attaching Auth Listeners...");
        // Role Selector for first-time sign-in
        loginRoleCards.forEach(card => {
            card.addEventListener('click', () => {
                console.log("Role Card Selected:", card.getAttribute('data-role'));
                loginRoleCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                selectedRoleInput.value = card.getAttribute('data-role');
            });
        });

        // Unified Google Login
        if (googleLoginBtn) {
            googleLoginBtn.addEventListener('click', async () => {
                console.log("Google Login Button Clicked!");
                googleLoginBtn.disabled = true;
                googleLoginBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Authenticating...';

                try {
                    const role = selectedRoleInput.value;
                    const success = await EstatoStorage.loginWithGoogle(role, false);

                    if (success) {
                        loadingOverlay.classList.remove('hidden');
                        loginScreen.classList.add('hidden');
                        // Hydration delay for visual feedback of Drive sync
                        setTimeout(() => checkAuth(), 1500);
                    } else {
                        throw new Error('Login cancelled or failed.');
                    }
                } catch (err) {
                    loginErrorMsg.textContent = err.message;
                    loginErrorMsg.classList.add('active');
                    setTimeout(() => loginErrorMsg.classList.remove('active'), 4000);
                    googleLoginBtn.disabled = false;
                    googleLoginBtn.innerHTML = '<i class="ph ph-google-logo"></i> Sign in with Google';
                }
            });
        }
    }

    function applyRBACToDOM() {
        if (!currentUser) return; // Guard: auth may not have resolved yet
        const adminElements = document.querySelectorAll('.admin-only');
        const role = currentUser.role;

        if (role === 'Buyer') {
            adminElements.forEach(el => el.style.display = 'none');
        } else if (role === 'Seller' || role === 'Admin') {
            adminElements.forEach(el => el.style.display = '');
        }
    }


    // --- APP EVENT LISTENERS ---
    // Ensure we only mount these once during user session
    let listenersMounted = false;
    function setupAppListeners() {
        if (listenersMounted) return;
        listenersMounted = true;

        const mainContent = document.querySelector('.main-content');
        let isPaging = false;

        if (mainContent) {
            mainContent.addEventListener('scroll', async () => {
                if (currentView !== 'properties') return;
                if (isPaging) return;

                const { scrollTop, scrollHeight, clientHeight } = mainContent;
                if (scrollTop + clientHeight >= scrollHeight - 300) {
                    isPaging = true;
                    console.log("[Estato] Bottom reached, loading more...");
                    const loaded = await EstatoStorage.loadMoreProperties();
                    if (loaded) {
                        console.log("[Estato] Page loaded successfully");
                    }
                    isPaging = false;
                }
            });
        }

        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const view = item.getAttribute('data-view');
                if (view !== 'properties') {
                    currentFilterCity = null;
                    // Clear comparison state when leaving properties view
                    if (compareList.length > 0) {
                        compareList = [];
                        updateCompareTray();
                    }
                }
                setActiveNav(view);
                renderView(view);
            });
        });

        const debouncedSearch = debounce((query) => {
            if (currentView === 'properties') {
                renderProperties(currentFilterCity, query);
            } else if (query) {
                setActiveNav('properties');
                renderView('properties', query);
                searchInput.focus();
            }
        }, 300);

        searchInput.addEventListener('input', (e) => {
            debouncedSearch(e.target.value.trim().toLowerCase());
        });

        if(openAddModalBtn) openAddModalBtn.addEventListener('click', () => openModal());
        if(closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
        if(cancelModalBtn) cancelModalBtn.addEventListener('click', () => {
            propertyForm.reset();
            propImageFile.value = '';
            imagePreviewContainer.style.display = 'none';
            document.getElementById('propId').value = '';
            document.getElementById('propImage').value = '';
            closeModal();
        });

        // V11 View Toggles (Using Event Delegation for robust toggle)
        document.body.addEventListener('click', (e) => {
            const mapBtn = e.target.closest('#viewMapBtn');
            const gridBtn = e.target.closest('#viewGridBtn');
            
            if (mapBtn) {
                e.preventDefault();
                window.toggleMapView(true);
            }
            if (gridBtn) {
                e.preventDefault();
                window.toggleMapView(false);
            }
        });

        // Notification Listeners
        if (notifBell) {
            notifBell.addEventListener('click', (e) => {
                e.stopPropagation();
                notifDropdown.classList.toggle('hidden');
                if (!notifDropdown.classList.contains('hidden')) {
                    EstatoStorage.markNotificationsRead();
                }
            });
        }

        if (markReadBtn) {
            markReadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                EstatoStorage.markNotificationsRead();
            });
        }

        // Close notifications when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (notifDropdown && !notifDropdown.contains(e.target) && !notifBell.contains(e.target)) {
                notifDropdown.classList.add('hidden');
            }
        });

        // V11 Compare Actions removed. Handled via inline generic onclick attributes in HTML.
        
        // Inquiry Listeners
        const closeInquiryBtn = document.getElementById('closeInquiryBtn');
        const inquiryModal = document.getElementById('inquiryModal');
        const inquiryForm = document.getElementById('inquiryForm');

        // Reply Listeners
        const closeReplyBtn = document.getElementById('closeReplyBtn');
        const replyModal = document.getElementById('replyModal');
        const replyForm = document.getElementById('replyForm');

        if(closeReplyBtn) closeReplyBtn.addEventListener('click', () => replyModal.classList.remove('active'));
        if(replyForm) {
            replyForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('replyMessage').value.trim();
                if (!msg) {
                    showToast('Please write a message before sending.', 'warning');
                    return;
                }
                const inqId = document.getElementById('replyInqId').value;
                
                await EstatoStorage.addInquiryReply(inqId, {
                    senderId: currentUser.id,
                    senderName: currentUser.name,
                    senderRole: currentUser.role,
                    message: msg
                });

                replyModal.classList.remove('active');
                replyForm.reset();
            });
        }


        if(closeInquiryBtn) closeInquiryBtn.addEventListener('click', () => inquiryModal.classList.remove('active'));
        if(inquiryForm) {
            inquiryForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('inqMessage').value.trim();
                if (!msg) {
                    showToast('Please write a message before sending.', 'warning');
                    return;
                }
                const submitBtn = inquiryForm.querySelector('[type="submit"]');
                const origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
                if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Sending...'; }

                try {
                    await EstatoStorage.addInquiry({
                        propertyId: document.getElementById('inqPropertyId').value,
                        propertyTitle: document.getElementById('inqPropertyTitle').value,
                        ownerId: document.getElementById('inqOwnerId').value,
                        buyerId: currentUser.id,
                        buyerName: currentUser.name,
                        buyerEmail: currentUser.email,
                        buyerPhone: '',
                        message: msg,
                        status: 'Unread'
                    });

                    // Show inline success state
                    const modalBody = inquiryModal.querySelector('.modal-body');
                    const originalContent = modalBody.innerHTML;
                    modalBody.innerHTML = `
                        <div style="text-align: center; padding: 2rem 1rem;">
                            <div style="font-size: 3rem; color: var(--success); margin-bottom: 1rem;"><i class="ph-fill ph-check-circle"></i></div>
                            <h3 style="margin-bottom: 0.5rem;">Message Sent!</h3>
                            <p style="color: var(--text-muted);">The seller has been notified and will reply soon.</p>
                        </div>
                    `;
                    setTimeout(() => {
                        inquiryModal.classList.remove('active');
                        renderNotifications();
                        setTimeout(() => { modalBody.innerHTML = originalContent; }, 300);
                    }, 2000);
                } catch(err) {
                    // Handles rate-limit error from EstatoStorage.addInquiry()
                    showToast(err.message, 'warning', 6000);
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnHtml; }
                }
            });
        }

        const reviewModal = document.getElementById('reviewModal');
        const closeReviewBtn = document.getElementById('closeReviewBtn');
        const reviewForm = document.getElementById('reviewForm');
        const starInput = document.getElementById('starInput');
        const revRating = document.getElementById('revRating');

        if (closeReviewBtn) closeReviewBtn.onclick = () => reviewModal.classList.remove('active');

        // Star logic
        if (starInput) {
            const stars = starInput.querySelectorAll('i');
            stars.forEach(star => {
                star.onclick = () => {
                    const val = parseInt(star.getAttribute('data-value'));
                    revRating.value = val;
                    stars.forEach(s => {
                        const sVal = parseInt(s.getAttribute('data-value'));
                        if (sVal <= val) {
                            s.classList.add('ph-fill');
                            s.classList.remove('ph');
                        } else {
                            s.classList.remove('ph-fill');
                            s.classList.add('ph');
                        }
                    });
                };
            });
        }

        if (reviewForm) {
            reviewForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const propId = document.getElementById('revPropertyId').value;
                const rating = revRating.value;
                const comment = document.getElementById('revComment').value;

                EstatoStorage.addReview(propId, rating, comment);
                
                // Refresh Modal
                renderReviews(propId);
                reviewForm.reset();
                // Reset Stars to 5
                starInput.querySelectorAll('i').forEach(s => { s.classList.add('ph-fill'); s.classList.remove('ph'); });
                revRating.value = 5;
            });
        }

        let priceTrendChart = null;
        const priceModal = document.getElementById('priceModal');
        const closePriceBtn = document.getElementById('closePriceBtn');

        if (closePriceBtn) closePriceBtn.onclick = () => priceModal.classList.remove('active');

        window.openPriceHistoryModal = (id) => {
            const prop = EstatoStorage.getPropertyById(id);
            if (!prop) return;

            document.getElementById('priceModalTitle').textContent = prop.title;
            priceModal.classList.add('active');

            // Wait for modal transition to finish before rendering chart
            setTimeout(() => {
                const ctx = document.getElementById('priceTrendChart').getContext('2d');
                const history = prop.priceHistory || [{ price: prop.price, date: prop.date || new Date().toISOString() }];
                
                if (priceTrendChart) priceTrendChart.destroy();

                priceTrendChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: history.map(h => new Date(h.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
                        datasets: [{
                            label: 'Price Evolution',
                            data: history.map(h => h.price),
                            borderColor: '#ea580c',
                            backgroundColor: 'rgba(234, 88, 12, 0.1)',
                            borderWidth: 3,
                            fill: true,
                            tension: 0.4,
                            pointRadius: 6,
                            pointBackgroundColor: '#ea580c',
                            pointHoverRadius: 8
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return 'Price: ' + currencyFormatter.format(context.parsed.y);
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                ticks: {
                                    callback: function(value) {
                                        return currencyFormatter.format(value).replace(/\.00$/, '');
                                    }
                                },
                                grid: { color: 'rgba(0,0,0,0.05)' }
                            },
                            x: {
                                grid: { display: false }
                            }
                        }
                    }
                });
            }, 300);
        };
        
        propertyModal.addEventListener('click', (e) => {
            // Disabled closing on outside click to prevent accidental form wiping
        });

        propertyForm.addEventListener('submit', handleFormSubmit);

        function compressImage(file, maxWidth = 1200, quality = 0.75) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        let width = img.width, height = img.height;
                        if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
                        canvas.width = width; canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        resolve(canvas.toDataURL('image/jpeg', quality));
                    };
                    img.onerror = reject;
                    img.src = event.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        const dropzone = propImageFile.closest('label');
        if (dropzone) {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropzone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
            });
            dropzone.addEventListener('dragover', () => {
                dropzone.querySelector('div').style.borderColor = 'var(--primary)';
                dropzone.querySelector('div').style.background = 'var(--bg-active, rgba(234, 88, 12, 0.05))';
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.querySelector('div').style.borderColor = 'var(--border-color)';
                dropzone.querySelector('div').style.background = 'var(--bg-hover)';
            });
            dropzone.addEventListener('drop', (e) => {
                dropzone.querySelector('div').style.borderColor = 'var(--border-color)';
                dropzone.querySelector('div').style.background = 'var(--bg-hover)';
                if (e.dataTransfer && e.dataTransfer.files.length) {
                    propImageFile.files = e.dataTransfer.files;
                    propImageFile.dispatchEvent(new Event('change'));
                }
            });
        }

        window.renderImagePreviews = function() {
            let links = [];
            try { if (propImageHidden.value) links = JSON.parse(propImageHidden.value); } catch(e) {}
            
            imagePreviewContainer.innerHTML = '';
            if (links.length === 0) {
                imagePreviewContainer.style.display = 'none';
                return;
            }
            
            imagePreviewContainer.style.display = 'flex';
            links.forEach((link, index) => {
                const wrapper = document.createElement('div');
                Object.assign(wrapper.style, { position: 'relative', display: 'inline-block', flexShrink: '0', height: '100px', width: '120px' });
                
                const img = document.createElement('img');
                img.src = window.formatEstatoImage(link);
                img.onerror = function() { this.src = window.ESTATO_DEFAULT_IMG; };
                Object.assign(img.style, { height: '100%', width: '100%', objectFit: 'cover', borderRadius: '4px', border: '2px solid var(--border-color)' });
                
                const closeBtn = document.createElement('button');
                closeBtn.innerHTML = '<i class="ph ph-x"></i>';
                Object.assign(closeBtn.style, {
                    position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: '#fff', 
                    border: 'none', borderRadius: '50%', width: '24px', height: '24px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', zIndex: '10'
                });
                
                closeBtn.onclick = (ev) => {
                    ev.preventDefault();
                    links.splice(index, 1);
                    propImageHidden.value = JSON.stringify(links);
                    window.renderImagePreviews();
                };
                
                wrapper.appendChild(img);
                wrapper.appendChild(closeBtn);
                imagePreviewContainer.appendChild(wrapper);
            });
        };

        propImageFile.addEventListener('change', async (e) => {
            let existingLinks = [];
            try { if (propImageHidden.value) existingLinks = JSON.parse(propImageHidden.value); } catch(e) {}
            
            const maxAllowed = 5 - existingLinks.length;
            if (maxAllowed <= 0) {
                showToast('Max 5 images allowed.', 'warning');
                e.target.value = '';
                return;
            }
            
            const files = Array.from(e.target.files).slice(0, maxAllowed);
            if (files.length === 0) return;
            
            const submitBtn = propertyForm.querySelector('[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Processing...'; }
            
            try {
                for(let file of files) {
                    const link = await compressImage(file, 1000, 0.7);
                    existingLinks.push(link);
                }
                propImageHidden.value = JSON.stringify(existingLinks);
                window.renderImagePreviews();
                
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Save Property'; }
            } catch(error) {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Save Property'; }
                showToast('Failed to process image. Details: ' + error.message, 'danger');
            }
            
            propImageFile.value = '';
        });

        // ── Location: Use My GPS Position ──
        const useMyLocationBtn = document.getElementById('useMyLocationBtn');
        if (useMyLocationBtn) {
            useMyLocationBtn.addEventListener('click', () => {
                if (!navigator.geolocation) {
                    alert('Geolocation is not supported by your browser.');
                    return;
                }
                const origHtml = useMyLocationBtn.innerHTML;
                useMyLocationBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Locating...';
                useMyLocationBtn.disabled = true;
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        document.getElementById('propLat').value = pos.coords.latitude.toFixed(6);
                        document.getElementById('propLng').value = pos.coords.longitude.toFixed(6);
                        initModalMap(pos.coords.latitude, pos.coords.longitude);
                        reverseGeocode(pos.coords.latitude, pos.coords.longitude);
                        useMyLocationBtn.innerHTML = '<i class="ph ph-check"></i> Location Set!';
                        setTimeout(() => {
                            useMyLocationBtn.innerHTML = origHtml;
                            useMyLocationBtn.disabled = false;
                        }, 2000);
                    },
                    (err) => {
                        alert('Unable to retrieve location: ' + err.message + '\n\nTip: Make sure you allow location permission for this page.');
                        useMyLocationBtn.innerHTML = origHtml;
                        useMyLocationBtn.disabled = false;
                    },
                    { enableHighAccuracy: true, timeout: 10000 }
                );
            });
        }

        // ── Location: Search Place or Parse Google Maps URL ──
        const locSearchInput = document.getElementById('propLocationSearch');
        const locSearchBtn = document.getElementById('searchLocationBtn');
        
        async function handleLocationSearch() {
            if (!locSearchInput) return;
            let query = locSearchInput.value.trim();
            if (!query) return;
            
            locSearchInput.style.borderColor = 'var(--text-muted)';
            const helpText = document.getElementById('locationHelpText');
            if (helpText) helpText.innerHTML = '<i class="ph ph-spinner ph-spin"></i><span>Searching...</span>';
            
            // Check if user pasted a link instead of a query
            if (query.includes('http') || query.includes('goo.gl') || query.includes('@') || query.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/)) {
                // If it's a short URL, attempt to expand it via proxy
                if (query.includes('goo.gl') || query.includes('maps.app.goo.gl')) {
                    try {
                        locSearchInput.style.borderColor = 'orange'; // loading state visually
                        const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(query)}`);
                        const data = await res.json();
                        if (data && data.contents) {
                            const m1 = data.contents.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^\s"'>]+/i);
                            const m2 = data.contents.match(/URL='([^']+)'/i);
                            if (m1) query = m1[0];
                            else if (m2 && m2[1]) query = m2[1];
                        }
                    } catch (e) {
                        console.error('Failed to unshorten Maps URL', e);
                    }
                }

                // Try exact Google Maps patterns
                const patterns = [
                    /@(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/,
                    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
                    /[?&]ll=(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/,
                    /[?&]q=(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/,
                    /[?&]query=(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/,
                    /maps\/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/
                ];
                
                let lat = null, lng = null;
                for (const re of patterns) {
                    const m = query.match(re);
                    if (m) {
                        lat = m[1]; lng = m[2];
                        break;
                    }
                }

                // Fallback global search
                if (!lat || !lng) {
                    const genericMatch = query.match(/(-?\d{1,3}\.\d{3,10})[^\da-zA-Z]+(-?\d{1,3}\.\d{3,10})/);
                    if (genericMatch) {
                        lat = genericMatch[1];
                        lng = genericMatch[2];
                    }
                }

                if (lat && lng) {
                    finalizeLocationSelection(lat, lng, locSearchInput, helpText);
                    return;
                }
                
                // If link fails
                locSearchInput.style.borderColor = 'var(--danger)';
                if (helpText) helpText.innerHTML = '<i class="ph ph-warning-circle" style="color:var(--danger)"></i><span style="color:var(--danger)">Link extraction failed. Please search the name instead.</span>';
                if (query.includes('goo.gl')) {
                    alert("Shortened links like 'goo.gl' hide the exact coordinates inside Google's systems.\n\nTo fix this:\nType the name of the place and click Search instead!");
                }
                return;
            }
            
            // Forward Geocoding (Text Search)
            try {
                if (locSearchBtn) locSearchBtn.disabled = true;
                const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
                const data = await res.json();
                
                if (data && data.length > 0) {
                    const lat = data[0].lat;
                    const lon = data[0].lon;
                    finalizeLocationSelection(lat, lon, locSearchInput, helpText);
                } else {
                    // No results
                    locSearchInput.style.borderColor = 'var(--danger)';
                    if (helpText) helpText.innerHTML = '<i class="ph ph-warning-circle" style="color:var(--danger)"></i><span style="color:var(--danger)">Location not found. Try a different query.</span>';
                }
            } catch (err) {
                console.error("Search failed", err);
                locSearchInput.style.borderColor = 'var(--danger)';
                if (helpText) helpText.innerHTML = '<i class="ph ph-warning-circle" style="color:var(--danger)"></i><span style="color:var(--danger)">Search failed due to network error.</span>';
            } finally {
                if (locSearchBtn) locSearchBtn.disabled = false;
            }
        }

        function finalizeLocationSelection(lat, lng, inputEl, helpEl) {
            document.getElementById('propLat').value = Number(lat).toFixed(6);
            document.getElementById('propLng').value = Number(lng).toFixed(6);
            initModalMap(lat, lng);
            reverseGeocode(lat, lng); // Will autofill Address, City, PIN natively
            
            inputEl.style.borderColor = 'var(--success)';
            inputEl.value = ''; // clear input to show success
            if (helpEl) helpEl.innerHTML = '<i class="ph ph-check" style="color:var(--success)"></i><span style="color:var(--success)">Location Found & Form Auto-Filled!</span>';
        }

        if (locSearchBtn) {
            locSearchBtn.addEventListener('click', handleLocationSearch);
        }
        if (locSearchInput) {
            let debounceTimer;
            locSearchInput.addEventListener('input', () => {
                const val = locSearchInput.value.trim();
                const suggBox = document.getElementById('locationSuggestions');
                
                // Instantly parse pasted links
                if (val.includes('http') || val.includes('goo.gl') || val.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/)) {
                    if (suggBox) suggBox.style.display = 'none';
                    handleLocationSearch();
                    return;
                }
                
                clearTimeout(debounceTimer);
                if (val.length < 3) {
                    if (suggBox) suggBox.style.display = 'none';
                    return;
                }
                
                debounceTimer = setTimeout(async () => {
                    try {
                        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&addressdetails=1&limit=5`);
                        const results = await res.json();
                        if (suggBox) {
                            suggBox.innerHTML = '';
                            if (results && results.length > 0) {
                                results.forEach(r => {
                                    const li = document.createElement('li');
                                    li.style.padding = '0.75rem 1rem';
                                    li.style.cursor = 'pointer';
                                    li.style.borderBottom = '1px solid var(--border-color)';
                                    li.style.color = 'var(--text-main)';
                                    li.style.transition = 'background 0.2s';
                                    
                                    const nameParts = r.display_name.split(',');
                                    const title = nameParts[0].trim();
                                    const subtitle = nameParts.slice(1).join(',').trim();
                                    
                                    li.innerHTML = `<div style="font-weight: 600; font-size: 0.9rem;">${title}</div><div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${subtitle}</div>`;
                                    
                                    li.onmouseover = () => li.style.backgroundColor = 'var(--bg-hover)';
                                    li.onmouseout = () => li.style.backgroundColor = 'transparent';
                                    li.onclick = () => {
                                        locSearchInput.value = title;
                                        suggBox.style.display = 'none';
                                        finalizeLocationSelection(r.lat, r.lon, locSearchInput, document.getElementById('locationHelpText'));
                                    };
                                    suggBox.appendChild(li);
                                });
                                suggBox.style.display = 'block';
                            } else {
                                suggBox.style.display = 'none';
                            }
                        }
                    } catch(e) {
                        console.error('Autocomplete failed', e);
                    }
                }, 600); // 600ms debounce
            });
            locSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const suggBox = document.getElementById('locationSuggestions');
                    if (suggBox) suggBox.style.display = 'none';
                    handleLocationSearch();
                }
            });
            
            // Close suggestions when clicking outside
            document.addEventListener('click', (e) => {
                const suggBox = document.getElementById('locationSuggestions');
                if (suggBox && !locSearchInput.contains(e.target) && !suggBox.contains(e.target)) {
                    suggBox.style.display = 'none';
                }
            });
        }
    }

    function setActiveNav(view) {
        navItems.forEach(n => n.classList.remove('active'));
        const target = document.querySelector(`[data-view="${view}"]`);
        if (target) target.classList.add('active');
    }

    // --- Core Rendering Engine ---
    function renderView(viewName, searchQuery = '') {
        currentView = viewName;
        window.scrollTo(0, 0);

        // Clean up Leaflet map instance when navigating away from properties
        // (the DOM node will be destroyed, so we must destroy the map object too)
        if (viewName !== 'properties' && map) {
            map.remove();
            map = null;
            markers = [];
            isMapVisible = false;
            // Reset the view toggle buttons to Grid state
            const gridBtn = document.getElementById('viewGridBtn');
            const mapBtn = document.getElementById('viewMapBtn');
            if (gridBtn) { gridBtn.classList.add('active'); }
            if (mapBtn) { mapBtn.classList.remove('active'); }
        }

        viewContainer.innerHTML = '';
        if (viewName !== 'properties') searchInput.value = '';
        dashboardCharts.forEach(c => c.destroy());
        dashboardCharts = [];

        // RBAC View Security Check
        if(currentUser && currentUser.role === 'Buyer' && (viewName === 'dashboard' || viewName === 'cities')) {
            renderProperties(); // Fallback secure redirect
            return;
        }

        switch(viewName) {
            case 'dashboard': renderDashboard(); break;
            case 'cities': renderCities(); break;
            case 'messages': renderMessages(); break;
            case 'properties': renderProperties(currentFilterCity, searchQuery); break;
            case 'watchlist': renderSavedProperties(); break;
            case 'profile': renderProfile(); break;
            default: renderProperties();
        }
    }

    // --- Developer Tools: Property Generator ---
    function generateDummyProperty() {
        const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
        
        const city = rand(Object.keys(CITY_COORDS));
        const category = rand(FILTER_CONFIG.categories);
        const type = rand(FILTER_CONFIG.types);
        const status = 'Available';
        const bhk = rand(FILTER_CONFIG.bhkLayouts);
        
        const adj = rand(PROPERTY_GENERATOR_DATA.adjectives);
        const pType = rand(PROPERTY_GENERATOR_DATA.types);
        const feat = rand(PROPERTY_GENERATOR_DATA.features);
        
        const title = `${adj} ${bhk} ${pType} ${feat}`;
        
        // Base price logic: Studio ~20L, 1BHK ~40L, 2BHK ~70L, 3BHK ~1.2Cr, 4+BHK ~2.5Cr
        let basePrice = 2000000;
        if (bhk === '1 BHK') basePrice = 4500000;
        if (bhk === '2 BHK') basePrice = 8500000;
        if (bhk === '3 BHK') basePrice = 16000000;
        if (bhk === '4+ BHK') basePrice = 35000000;
        
        // Category Multiplier
        if (category === 'Villa') basePrice *= 2;
        if (category === 'Plot') basePrice *= 0.6;
        if (category === 'Commercial') basePrice *= 1.5;
        
        // Random variance +/- 15%
        const price = Math.round(basePrice * (0.85 + Math.random() * 0.3));
        
        const area = (bhk === 'Studio' ? 400 : bhk === '1 BHK' ? 650 : bhk === '2 BHK' ? 1100 : bhk === '3 BHK' ? 1800 : 2800) + Math.round(Math.random() * 200);
        
        const address = `${Math.floor(Math.random() * 900) + 100}, ${feat} Road, ${city}`;
        const description = `This ${adj.toLowerCase()} ${category.toLowerCase()} offers premium ${rand(PROPERTY_GENERATOR_DATA.amenities).toLowerCase()} and ${rand(PROPERTY_GENERATOR_DATA.amenities).toLowerCase()}. Located in the heart of ${city}, it's perfect for those seeking a ${feat.toLowerCase()} lifestyle. Internal area is approx ${area} sq.ft.`;
        
        // Pick 2 random images
        const images = [];
        const pool = [...PROPERTY_GENERATOR_DATA.images];
        for(let i=0; i<2; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            images.push(pool.splice(idx, 1)[0]);
        }
        
        return {
            title,
            city,
            address,
            price,
            type,
            status,
            category,
            bhk,
            area,
            description,
            images,
            ownerId: currentUser.id, // Generated by current admin
            date: new Date().toISOString()
        };
    }

    async function seedDummyData(count = 10) {
        const seedBtn = document.getElementById('seedDataBtn');
        const originalHtml = seedBtn.innerHTML;
        seedBtn.disabled = true;
        seedBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Seeding...';
        
        try {
            for (let i = 0; i < count; i++) {
                const prop = generateDummyProperty();
                await EstatoStorage.addProperty(prop);
            }
            showToast(`Successfully seeded ${count} listings!`, 'success');
            renderView('dashboard'); // Refresh stats
        } catch (err) {
            console.error("Seeding failed:", err);
            showToast('Seeding failed. Check console for details.', 'danger');
        } finally {
            seedBtn.innerHTML = originalHtml;
            seedBtn.disabled = false;
        }
    }

    // --- Views ---
    function renderDashboard() {
        const stats = EstatoStorage.getStats();
        // Seller sees only their own, Admin sees all
        const allProps = EstatoStorage.getProperties();
        let recentProps = allProps;
        if (!currentUser) return;
        if (currentUser.role === 'Seller') {
            recentProps = recentProps.filter(p => p.ownerId === currentUser.id);
        }
        recentProps = recentProps.slice(-3).reverse();

        let html = `
            <div class="section-header">
                <h2>My Listings Performance</h2>
                <div style="color: var(--text-muted); font-weight: 500;">
                    ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </div>
            </div>

            <div class="dashboard-valuation">
                <h4>Total Valuation of My Listings</h4>
                <p>${currencyFormatter.format(stats.totalValue)}</p>
            </div>

            <div class="stats-grid">
                <div class="stat-card surface-panel"><div class="stat-icon"><i class="ph ph-buildings"></i></div><div class="stat-info"><h4>My Properties</h4><p>${stats.totalProperties}</p></div></div>
                <div class="stat-card surface-panel"><div class="stat-icon"><i class="ph ph-map-pin"></i></div><div class="stat-info"><h4>Cities Covered</h4><p>${stats.totalCities}</p></div></div>
                <div class="stat-card surface-panel"><div class="stat-icon" style="background: #ecfdf5; color: #10b981;"><i class="ph ph-tag"></i></div><div class="stat-info"><h4>For Sale</h4><p>${stats.forSale}</p></div></div>
                <div class="stat-card surface-panel"><div class="stat-icon" style="background: #fdf2f8; color: #db2777;"><i class="ph ph-key"></i></div><div class="stat-info"><h4>For Rent</h4><p>${stats.forRent}</p></div></div>
            </div>

            <!-- Analytics Grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
                <div class="chart-container surface-panel" style="height: 350px;">
                    <h4 style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px;">Properties per Region</h4>
                    <div style="flex: 1; min-height: 0;"><canvas id="cityCountChart"></canvas></div>
                </div>
                <div class="chart-container surface-panel" style="height: 350px;">
                    <h4 style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px;">Avg Price per Region</h4>
                    <div style="flex: 1; min-height: 0;"><canvas id="cityPriceChart"></canvas></div>
                </div>
                <div class="chart-container surface-panel" style="height: 350px; display: flex; flex-direction: column;">
                    <h4 style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px;">Type Distribution</h4>
                    <div style="flex: 1; min-height: 0;"><canvas id="typeDistChart"></canvas></div>
                </div>
            </div>

            <div class="section-header" style="margin-top: 2rem;">
                <h3>Recent Listings</h3>
            </div>
            <div class="grid-layout">
                ${recentProps.length ? recentProps.map((p, i) => generatePropertyCard(p, i)).join('') : '<div class="empty-state"><p>No properties found.</p></div>'}
            </div>

            ${currentUser.role === 'Admin' ? `
                <div class="section-header" style="margin-top: 3rem;">
                    <h3><i class="ph-duotone ph-clock"></i> Pending Approvals</h3>
                </div>
                ${allProps.filter(p => p.status === 'Pending').length > 0 ? `
                <div class="recent-scroll-container" style="display: flex; gap: 1rem; overflow-x: auto; padding-bottom: 1.5rem; margin-bottom: 2rem;">
                    ${allProps.filter(p => p.status === 'Pending').map((p, i) => `<div style="min-width: 300px;">${generatePropertyCard(p, i)}</div>`).join('')}
                </div>
                ` : `
                <div class="surface-panel" style="padding: 2rem; text-align: center; border: 1px dashed var(--border-color); color: var(--text-muted); margin-bottom: 2rem;">
                    <i class="ph-duotone ph-check-circle" style="font-size: 3rem; color: var(--success); margin-bottom: 1rem;"></i>
                    <p>All caught up! There are no listings pending approval.</p>
                </div>
                `}
                <div class="card-separator"></div>

                <div class="section-header" style="margin-top: 2rem;">
                    <h3>Developer & Admin Tools</h3>
                </div>
                <div class="surface-panel" style="padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; border: 1px dashed var(--border-color); background: var(--bg-hover); margin-bottom: 1rem;">
                    <div>
                        <h4 style="margin: 0 0 5px 0;">Property Data Generator</h4>
                        <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">Instantly seed 1 realistic, high-quality property listing for testing.</p>
                    </div>
                    <button class="btn btn-secondary shadow-hover" id="seedDataBtn" style="background: white; border: 1px solid var(--border-color);">
                        <i class="ph ph-database"></i> Seed 1 Property
                    </button>
                </div>

                <div class="surface-panel" style="padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; border: 1px dashed var(--border-color); background: var(--bg-hover);">
                    <div>
                        <h4 style="margin: 0 0 5px 0;">Data Portability</h4>
                        <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">Backup your entire marketplace state or restore from a previous JSON dump.</p>
                    </div>
                    <div style="display: flex; gap: 0.75rem;">
                        <button class="btn btn-secondary shadow-hover" id="backupDataBtn" style="background: white; border: 1px solid var(--border-color);">
                            <i class="ph ph-download"></i> Backup Data
                        </button>
                        <button class="btn btn-secondary shadow-hover" id="restoreDataBtn" style="background: white; border: 1px solid var(--border-color);">
                            <i class="ph ph-upload"></i> Restore Data
                        </button>
                    </div>
                    <input type="file" id="restoreFilePicker" accept=".json" style="display: none;">
                </div>
            ` : ''}
        `;

        if (currentUser.role === 'Admin') {
            html += renderAdminActivityFeed();
        }

        viewContainer.innerHTML = html;
        attachCardListeners();

        // Admin Tools listener
        const seedBtnDashboard = document.getElementById('seedDataBtn');
        if (seedBtnDashboard) seedBtnDashboard.addEventListener('click', () => seedDummyData(1));

        const backupBtn = document.getElementById('backupDataBtn');
        if (backupBtn) backupBtn.addEventListener('click', () => exportBackup());

        const restoreBtn = document.getElementById('restoreDataBtn');
        const restoreInput = document.getElementById('restoreFilePicker');
        if (restoreBtn && restoreInput) {
            restoreBtn.addEventListener('click', () => restoreInput.click());
            restoreInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) handleRestore(file);
            });
        }

        // Initialize Charts
        const cityLabels = Object.keys(stats.avgPriceByCity);
        const cityCounts = cityLabels.map(city => {
            const props = EstatoStorage.getProperties().filter(p => p.city === city);
            return (currentUser.role === 'Seller') ? props.filter(p => p.ownerId === currentUser.id).length : props.length;
        });

        // 1. City Count Chart
        const ctxCount = document.getElementById('cityCountChart');
        if (ctxCount) {
            dashboardCharts.push(new Chart(ctxCount, {
                type: 'bar',
                data: {
                    labels: cityLabels,
                    datasets: [{
                        label: 'Listings',
                        data: cityCounts,
                        backgroundColor: '#ea580c',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { stepSize: 1, color: '#7d746d' }, grid: { color: '#e5e0d8' } },
                        x: { ticks: { color: '#7d746d' }, grid: { display: false } }
                    }
                }
            }));
        }

        // 2. City Price Chart
        const ctxPrice = document.getElementById('cityPriceChart');
        if (ctxPrice) {
            dashboardCharts.push(new Chart(ctxPrice, {
                type: 'bar',
                data: {
                    labels: cityLabels,
                    datasets: [{
                        label: 'Avg Price',
                        data: Object.values(stats.avgPriceByCity),
                        backgroundColor: '#0ea5e9',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { 
                        legend: { display: false },
                        tooltip: {
                            callbacks: { label: (ctx) => currencyFormatter.format(ctx.raw) }
                        }
                    },
                    scales: {
                        y: { 
                            beginAtZero: true, 
                            ticks: { 
                                color: '#7d746d',
                                callback: (val) => val >= 10000000 ? (val/10000000).toFixed(1) + ' Cr' : val >= 100000 ? (val/100000).toFixed(0) + ' L' : val
                            }, 
                            grid: { color: '#e5e0d8' } 
                        },
                        x: { ticks: { color: '#7d746d' }, grid: { display: false } }
                    }
                }
            }));
        }

        // 3. Type Distribution Chart
        const ctxType = document.getElementById('typeDistChart');
        if (ctxType) {
            dashboardCharts.push(new Chart(ctxType, {
                type: 'doughnut',
                data: {
                    labels: ['Sale', 'Rent'],
                    datasets: [{
                        data: [stats.forSale, stats.forRent],
                        backgroundColor: ['#ea580c', '#db2777'],
                        borderWidth: 0,
                        hoverOffset: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom', labels: { usePointStyle: true, padding: 20 } }
                    },
                    cutout: '70%'
                }
            }));
        }

        // Admin Tools Listeners
        const seedBtn = document.getElementById('seedDataBtn');
        if (seedBtn) {
            seedBtn.addEventListener('click', () => seedDummyData(1));
        }
    }

    function renderCities() {
        const properties = EstatoStorage.getProperties();
        const cities = EstatoStorage.getCities();
        
        let html = `<div class="section-header"><h2>Service Regions</h2></div><div class="grid-layout">`;

        if (cities.length === 0) {
            html += `<div class="empty-state"><p>No regions active yet. Add a property to begin.</p></div>`;
        } else {
            cities.forEach(city => {
                const cityProps = properties.filter(p => p.city === city);
                const count = cityProps.length;
                
                // Show city cards if Admin OR if Seller has listings in that city
                const hasListings = currentUser.role === 'Admin' || cityProps.some(p => p.ownerId === currentUser.id);
                
                if (hasListings) {
                    html += `
                        <div class="city-card surface-panel shadow-hover" data-city="${city}">
                            <i class="ph-duotone ph-buildings"></i>
                            <h3>${city}</h3>
                            <p class="badge" style="background: var(--bg-main);">${count} Global Listings</p>
                        </div>
                    `;
                }
            });
        }

        html += `</div>`;
        viewContainer.innerHTML = html;

        document.querySelectorAll('.city-card').forEach(card => {
            card.addEventListener('click', (e) => {
                currentFilterCity = e.currentTarget.getAttribute('data-city');
                setActiveNav('properties');
                renderView('properties');
            });
        });
    }

    function renderSavedProperties() {
        let properties = EstatoStorage.getProperties();
        const favs = EstatoStorage.getFavorites();
        properties = properties.filter(p => favs.includes(p.id));

        let html = `<div class="section-header"><h2>Saved Properties</h2></div><div class="grid-layout">`;

        if (properties.length === 0) {
            html += `<div class="empty-state" style="grid-column: 1 / -1;"><i class="ph-duotone ph-heart-break"></i><p>No saved properties yet.</p></div>`;
        } else {
            html += properties.map((p, i) => generatePropertyCard(p, i)).join('');
        }

        html += `</div>`;
        viewContainer.innerHTML = html;
        attachCardListeners();
    }

    function renderProperties(cityFilter = null, searchQuery = '') {
        let properties = EstatoStorage.getProperties();

        // RBAC Filtering (Fraud Prevention Sandbox)
        if (currentUser.role === 'Buyer') {
            properties = properties.filter(p => p.status === 'Available');
        } else if (currentUser.role === 'Seller') {
            properties = properties.filter(p => p.status !== 'Pending' || p.ownerId === currentUser.id);
        }
        // Admin sees all, including all Pending listings

        if (cityFilter) properties = properties.filter(p => p.city === cityFilter);
        
        if (searchQuery) {
            const keywords = searchQuery.toLowerCase().split(/\s+/).filter(x => x);
            properties = properties.filter(p => {
                const combinedText = `${p.id} ${p.title} ${p.city} ${p.address} ${p.description || ''} ${p.bhk || ''}`.toLowerCase();
                // Smart Match: All keywords must be present in the combined text (Logical AND)
                return keywords.every(kw => combinedText.includes(kw));
            });
        }
        
        if (currentTypeFilter) properties = properties.filter(p => p.type === currentTypeFilter);
        if (currentStatusFilter) properties = properties.filter(p => p.status === currentStatusFilter);
        if (currentCategoryFilter) properties = properties.filter(p => p.category === currentCategoryFilter);
 
        // Radius Filtering
        if (currentRadiusCenter) {
            // Use a local Map keyed by property ID to avoid mutating the in-memory cache objects
            if (!renderProperties._distanceCache) renderProperties._distanceCache = new Map();
            const dCache = renderProperties._distanceCache;
            const cacheKey = `${currentRadiusCenter.lat},${currentRadiusCenter.lng}`;

            properties = properties.filter(p => {
                const lat = p.lat || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][0] : null);
                const lng = p.lng || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][1] : null);
                if (lat === null || lng === null) return false;

                const key = `${cacheKey}:${p.id}`;
                if (!dCache.has(key)) {
                    dCache.set(key, getHaversineDistance(currentRadiusCenter.lat, currentRadiusCenter.lng, lat, lng));
                }
                p._distanceKm = dCache.get(key); // Ephemeral — only used this render pass
                return p._distanceKm <= currentRadiusKm;
            });
        }

        // Use a shallow copy before sorting to avoid mutating the in-memory cache array
        properties = [...properties];
        if (currentRadiusCenter) {
            // Priority sort by proximity if radius active
            properties.sort((a, b) => (a._distanceKm || 0) - (b._distanceKm || 0));
        } else if (currentSort === 'price-low') {
            properties.sort((a, b) => a.price - b.price);
        } else if (currentSort === 'price-high') {
            properties.sort((a, b) => b.price - a.price);
        } else if (currentSort === 'oldest') {
            // Oldest first - Sort by numeric part of ID ascending
            properties.sort((a, b) => {
                const idA = a.id ? a.id.replace('prop_', '') : '0';
                const idB = b.id ? b.id.replace('prop_', '') : '0';
                return idA.localeCompare(idB); // Ascending
            });
        } else {
            // Newest first (default) - Sort by numeric part of ID descending
            properties.sort((a, b) => {
                const idA = a.id ? a.id.replace('prop_', '') : '0';
                const idB = b.id ? b.id.replace('prop_', '') : '0';
                return idB.localeCompare(idA); // Descending
            });
        }

        let headerText = cityFilter ? `Listings in ${cityFilter}` : 'All Featured Listings';

        let html = `
            ${(!cityFilter && !searchQuery && !currentRadiusCenter && !currentTypeFilter && !currentStatusFilter && !currentCategoryFilter) ? renderRecentlyViewed() : ''}
            <div class="section-header" style="flex-direction: column; align-items: flex-start;">
                <h2>${headerText} 
                    ${cityFilter ? `<button class="btn btn-secondary btn-sm" id="clearCityFilterBtn" style="margin-left: 1rem; padding: 0.25rem 0.75rem;"><i class="ph ph-x"></i> Clear Region</button>` : ''}
                </h2>
                
                <div class="filters-toolbar">
                    <select id="sortSelect">
                        ${FILTER_CONFIG.sortOptions.map(opt => `<option value="${opt.value}" ${currentSort === opt.value ? 'selected' : ''}>Sort: ${opt.label}</option>`).join('')}
                    </select>
                    <select id="typeSelect">
                        <option value="">Filter: All Types</option>
                        ${FILTER_CONFIG.types.map(t => `<option value="${t}" ${currentTypeFilter === t ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <select id="categorySelect">
                        <option value="">Filter: All Categories</option>
                        ${FILTER_CONFIG.categories.map(cat => `<option value="${cat}" ${currentCategoryFilter === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                    </select>
                    <select id="statusSelect">
                        <option value="">Filter: All Status</option>
                        ${FILTER_CONFIG.statuses.map(s => `<option value="${s}" ${currentStatusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                    <div style="position: relative; display: inline-flex; gap: 2px;">
                        <button id="exportPdfBtn" class="btn btn-secondary shadow-hover" style="padding: 0.5rem 0.85rem; font-size: 0.85rem;" title="Export filtered listings as PDF">
                            <i class="ph ph-file-pdf"></i> PDF
                        </button>
                        <button id="exportCsvBtn" class="btn btn-secondary shadow-hover" style="padding: 0.5rem 0.85rem; font-size: 0.85rem;" title="Export filtered listings as CSV">
                            <i class="ph ph-file-csv"></i> CSV
                        </button>
                    </div>
                </div>

                <div class="radius-toolbar" style="margin-top: 1rem; padding: 0.75rem 1rem; background: var(--bg-surface); border-radius: var(--radius-md); border: 1px solid var(--border-color); display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; width: 100%;">
                    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; flex: 1.5; min-width: 300px;">
                        <div style="position: relative; flex: 1;">
                            <i class="ph ph-map-pin" style="position: absolute; left: 0.75rem; top: 50%; translate: 0 -50%; color: var(--text-muted);"></i>
                            <input type="text" id="radiusLocInput" placeholder="Enter city or lat,lng..." value="${currentRadiusCenter ? (Object.keys(CITY_COORDS).find(k => CITY_COORDS[k][0] === currentRadiusCenter.lat) || `${currentRadiusCenter.lat.toFixed(4)},${currentRadiusCenter.lng.toFixed(4)}`) : ''}" style="width: 100%; padding: 0.5rem 0.75rem 0.5rem 2.25rem; font-size: 0.85rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-main);">
                        </div>
                        <button class="btn ${currentRadiusCenter ? 'btn-primary' : 'btn-secondary'} btn-sm shadow-hover" id="nearMeBtn" title="Use My Current GPS Location" style="white-space: nowrap;">
                            <i class="ph ph-gps"></i>
                        </button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 250px;">
                        <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">Radius:</span>
                        <input type="range" id="radiusRange" min="1" max="100" value="${currentRadiusKm}" style="flex: 1; accent-color: var(--primary); cursor: pointer;">
                        <span style="font-size: 0.85rem; font-weight: 700; color: var(--primary); min-width: 55px; text-align: right;">${currentRadiusKm} km</span>
                    </div>
                    ${currentRadiusCenter ? `<button class="btn btn-danger btn-sm shadow-hover" id="clearRadiusBtn" title="Remove Radius Filter"><i class="ph ph-trash"></i></button>` : ''}
                </div>
            </div>
            <div id="propertiesGrid" class="grid-layout">
        `;

        if (properties.length === 0) {
            html += `<div class="empty-state" style="grid-column: 1 / -1;"><i class="ph-duotone ph-magnifying-glass"></i><p>No properties found matching criteria.</p></div>`;
        } else {
            html += properties.map((p, i) => generatePropertyCard(p, i, (currentRadiusCenter && typeof p._distanceKm === 'number') ? p._distanceKm : null)).join('');
        }

        // Close the grid div
        html += `</div>`;

        // Always include mapContainer so #propertiesGrid + #mapContainer are in the DOM
        // for toggleMapView() to find them after every render
        html += `
            <div id="mapContainer" class="${isMapVisible ? '' : 'hidden'}" style="width: 100%; height: calc(100vh - 200px); border-radius: var(--radius-lg); overflow: hidden; margin-top: 1rem;">
                <div id="leafletMap" style="width: 100%; height: 100%; min-height: 500px;"></div>
            </div>
        `;

        if (currentUser.role === 'Admin') {
            html += renderAdminActivityFeed();
        }

        viewContainer.innerHTML = html;

        // --- Recommendation Engine Injection ---
        if (searchQuery && properties.length === 1 && !cityFilter && !currentRadiusCenter) {
            const sourceProp = properties[0];
            // Only show recommendations if the search query matches the property ID exactly (Detail View)
            if (searchQuery.toLowerCase() === sourceProp.id.toLowerCase()) {
                const similarProps = getSimilarProperties(sourceProp); // Pass object, not ID string
                if (similarProps.length > 0) {
                    const recSection = document.createElement('div');
                    recSection.className = 'recommendations-section';
                    recSection.style.marginTop = '3rem';
                    recSection.style.paddingTop = '2rem';
                    recSection.style.borderTop = '1px solid var(--border-color)';
                    
                    recSection.innerHTML = `
                        <div class="section-header" style="margin-bottom: 1.5rem;">
                            <h3 style="font-size: 1.25rem; display: flex; align-items: center; gap: 0.75rem;">
                                <i class="ph-duotone ph-sparkle" style="color: var(--primary);"></i> Similar Properties You Might Like
                            </h3>
                            <p style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.25rem;">Hand-picked based on location, price, and category.</p>
                        </div>
                        <div class="grid-layout" style="margin-top: 1rem;">
                            ${similarProps.map((p, i) => generatePropertyCard(p, i)).join('')}
                        </div>
                    `;
                    viewContainer.appendChild(recSection);
                    // Re-attach listeners ONLY for the new cards in the recommendations section
                    attachCardListeners(recSection);
                }
            }
        }

        // The old Leaflet map instance referenced a destroyed DOM node — remove it
        if (map) { map.remove(); map = null; markers = []; }

        // If user was in map view before the re-render (e.g. changed filter/sort)
        // re-initialize the map in the fresh #leafletMap node
        if (isMapVisible) {
            document.getElementById('propertiesGrid').classList.add('hidden');
            setTimeout(() => { initMap(); if (map) map.invalidateSize(); }, 100);
        }

        if (cityFilter) {
            document.getElementById('clearCityFilterBtn').addEventListener('click', () => {
                currentFilterCity = null;
                renderView('properties', searchInput.value);
            });
        }

        ['sortSelect', 'typeSelect', 'statusSelect', 'categorySelect'].forEach(id => {
            const el = document.getElementById(id);
            if(el) {
                el.addEventListener('change', (e) => {
                    if(id === 'sortSelect') currentSort = e.target.value;
                    if(id === 'typeSelect') currentTypeFilter = e.target.value;
                    if(id === 'statusSelect') currentStatusFilter = e.target.value;
                    if(id === 'categorySelect') currentCategoryFilter = e.target.value;
                    renderView('properties', searchInput.value); 
                });
            }
        });

        // Export Listeners — properties array is closed over from this render call
        const exportPdfBtn = document.getElementById('exportPdfBtn');
        const exportCsvBtn = document.getElementById('exportCsvBtn');
        if (exportPdfBtn) exportPdfBtn.addEventListener('click', () => exportToPDF(properties));
        if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportToCSV(properties));
 
        // Radius Search Listeners
        const nearMeBtn = document.getElementById('nearMeBtn');
        const radiusRange = document.getElementById('radiusRange');
        const clearRadiusBtn = document.getElementById('clearRadiusBtn');
        const radiusLocInput = document.getElementById('radiusLocInput');

        if (nearMeBtn) {
            nearMeBtn.addEventListener('click', () => {
                if (navigator.geolocation) {
                    nearMeBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Locating...';
                    navigator.geolocation.getCurrentPosition((pos) => {
                        currentRadiusCenter = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                        renderView('properties', searchInput.value);
                    }, (err) => {
                        showToast('Location access denied. Enter a city or coordinates manually.', 'warning');
                        renderView('properties', searchInput.value);
                    });
                } else {
                    showToast('Geolocation is not supported by your browser.', 'warning');
                }
            });
        }

        if (radiusLocInput) {
            radiusLocInput.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    const originalText = e.target.value;
                    e.target.value = 'Searching...';
                    e.target.disabled = true;

                    const coords = await resolveLocationToCoords(originalText);
                    
                    e.target.value = originalText;
                    e.target.disabled = false;
                    e.target.focus();

                    if (coords) {
                        currentRadiusCenter = coords;
                        renderView('properties', searchInput.value);
                    } else {
                        showToast("Location not found. Try a city name like 'Mumbai' or coordinates like '19.07,72.87'", 'warning');
                    }
                }
            });
        }

        if (radiusRange) {
            radiusRange.addEventListener('input', (e) => {
                currentRadiusKm = parseInt(e.target.value);
                // Update label only during drag for performance, then re-render on change or debounced
                e.target.nextElementSibling.textContent = `${currentRadiusKm} km`;
            });
            radiusRange.addEventListener('change', () => {
                renderView('properties', searchInput.value);
            });
        }

        if (clearRadiusBtn) {
            clearRadiusBtn.addEventListener('click', () => {
                currentRadiusCenter = null;
                renderView('properties', searchInput.value);
            });
        }

        attachCardListeners();
    }

    function renderProfile() {
        let html = `
            <div class="section-header"><h2>Your Google Account</h2></div>
            
            <div class="settings-card surface-panel profile-card">
                <div class="avatar-large" style="width: 120px; height: 120px; border-radius: 50%; border: 4px solid var(--primary); overflow: hidden; margin-bottom: 1.5rem;">
                    <img src="${currentUser.picture}" alt="${currentUser.name}" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <h3>${currentUser.name}</h3>
                <p style="color: var(--text-muted); margin-bottom: 1rem;">${currentUser.email}</p>
                <div style="margin-top: 1rem;"><span class="badge sale" style="padding: 0.5rem 1rem; font-size: 0.9rem;">Verified ${currentUser.role} Account</span></div>
                
                        <div style="margin-top: 1.5rem; width: 100%; max-width: 300px; display: flex; flex-direction: column; gap: 0.75rem;">
                    ${currentUser.role !== 'Admin' ? `
                    <button class="btn btn-secondary w-full shadow-hover" id="changeRoleBtn" style="border: 1px solid var(--primary); color: var(--primary);">
                        <i class="ph ph-shuffle"></i> Switch to ${currentUser.role === 'Buyer' ? 'Seller' : 'Buyer'} Account
                    </button>` : `
                    <div style="font-size:0.8rem;color:var(--text-muted);text-align:center;"><i class="ph ph-lock-key"></i> Admin role cannot be changed here</div>`}
                    <button class="btn btn-secondary w-full shadow-hover" id="logoutBtn" style="border: 1px solid var(--border-color);">
                        <i class="ph ph-sign-out"></i> Switch Account / Logout
                    </button>
                </div>
            </div>
        `;
        
        if (currentUser.role === 'Seller' || currentUser.role === 'Admin') {
            html += `
                <div class="settings-card surface-panel" style="margin-top: 2rem;">
                    <h3>Drive Data Export</h3>
                    <p>Download a local JSON backup of your synced Google Drive data.</p>
                    <button class="btn btn-secondary shadow-hover" id="exportDataBtn"><i class="ph ph-download-simple"></i> Download estato_data.json</button>
                </div>
            `;
        }

        viewContainer.innerHTML = html;

        document.getElementById('logoutBtn').addEventListener('click', () => {
             EstatoStorage.logout();
             location.reload();
        });

        // Role Change Button
        const changeRoleBtn = document.getElementById('changeRoleBtn');
        if (changeRoleBtn) {
            changeRoleBtn.addEventListener('click', () => {
                const newRole = currentUser.role === 'Buyer' ? 'Seller' : 'Buyer';
                showConfirm(
                    `Switch your account to ${newRole}?\n\n` +
                    (newRole === 'Seller'
                        ? 'As a Seller, you can list properties and manage inquiries from buyers.'
                        : 'As a Buyer, you can browse listings, save favorites, and send inquiries.'),
                    async () => {
                        changeRoleBtn.disabled = true;
                        changeRoleBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Switching...';
                        try {
                            const db = firebase.database();
                            await db.ref('users/' + currentUser.id + '/role').set(newRole);
                            currentUser.role = newRole;
                            showToast(`Role switched to ${newRole}! Reloading...`, 'success');
                            setTimeout(() => location.reload(), 1500);
                        } catch (e) {
                            console.error('[Estato] Role change failed:', e);
                            showToast('Failed to switch role. Please try again.', 'danger');
                            changeRoleBtn.disabled = false;
                            changeRoleBtn.innerHTML = `<i class="ph ph-shuffle"></i> Switch to ${newRole} Account`;
                        }
                    }
                );
            });
        }

        if (document.getElementById('exportDataBtn')) {
            document.getElementById('exportDataBtn').addEventListener('click', () => {
                const dataStr = JSON.stringify(EstatoStorage.getData(), null, 2);
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(dataBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `estato_drive_backup_${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
            });
        }
    }

    function renderMessages() {
        let inquiries = EstatoStorage.getInquiries();
        
        // Security: Prevent Admins from arbitrarily reading direct buyer-seller messages.
        // Both Sellers and Admins only read inquiries bound to properties they explicitly own.
        if (currentUser.role !== 'Buyer') {
            inquiries = inquiries.filter(inq => inq.ownerId === currentUser.id);
        }
        
        inquiries = [...inquiries].reverse(); // Shallow copy to avoid mutating the live _memCache array
        
        let headerText = currentUser.role === 'Buyer' ? 'My Inquiries' : 'Inbound Leads';
        let html = `<div class="section-header"><h2>${headerText}</h2></div>`;
        
        if (inquiries.length === 0) {
            html += `<div class="empty-state"><i class="ph-duotone ph-envelope-open" style="font-size: 4rem; color: #cbd5e1; margin-bottom: 1rem; display: block;"></i><p>No messages yet. Keep publishing great listings to attract buyers!</p></div>`;
        } else {
            html += `<div class="analytics-grid" style="grid-template-columns: 1fr;">`;
            html += inquiries.map(inq => {
                let repliesHtml = '';
                if (inq.replies && inq.replies.length > 0) {
                    repliesHtml = '<div class="chat-history" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">';
                    inq.replies.forEach(reply => {
                        const isMe = reply.senderId === currentUser.id;
                        repliesHtml += `
                            <div style="display: flex; gap: 0.75rem; flex-direction: ${isMe ? 'row-reverse' : 'row'}; align-items: flex-end;">
                                <div class="avatar" style="width: 30px; height: 30px; min-width: 30px; background: var(--border-color); display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.8rem; font-weight: bold; color: var(--text-main);">${reply.senderName.charAt(0)}</div>
                                <div style="background: ${isMe ? 'var(--primary-light)' : 'var(--bg-main)'}; color: ${isMe ? 'var(--primary)' : 'var(--text-main)'}; padding: 0.75rem 1rem; border-radius: 1rem; border-bottom-${isMe ? 'right' : 'left'}-radius: 0; font-size: 0.9rem; border: 1px solid ${isMe ? 'rgba(234, 88, 12, 0.2)' : 'var(--border-color)'}; max-width: 80%;">
                                    <div style="font-weight: bold; font-size: 0.75rem; margin-bottom: 0.25rem;">${escapeHtml(reply.senderName)} <span style="font-weight: normal; color: var(--text-muted); margin-left: 0.5rem;">${new Date(reply.date).toLocaleString('en-IN', { timeStyle: 'short', dateStyle: 'short'})}</span></div>
                                    ${escapeHtml(reply.message)}
                                </div>
                            </div>
                        `;
                    });
                    repliesHtml += '</div>';
                }

                return `
                <div class="message-card surface-panel">
                    <div class="message-header">
                        <div class="message-buyer">
                            <div class="avatar" style="background: var(--primary-light); color: var(--primary); width: 45px; height: 45px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 700;">${inq.buyerName.charAt(0)}</div>
                            <div>
                                <h4 style="margin: 0; font-size: 1.1rem;">${escapeHtml(inq.buyerName)}</h4>
                                <p style="margin: 2px 0 0 0; font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(inq.buyerEmail)}</p>
                            </div>
                        </div>
                        <div style="display: flex; gap: 0.75rem; align-items: center;">
                            <div class="message-property"><i class="ph-duotone ph-buildings"></i> ${escapeHtml(inq.propertyTitle)}</div>
                            <button class="btn btn-icon shadow-hover open-reply-btn" data-id="${inq.id}" title="Reply in Chat" style="background: var(--primary-light); color: var(--primary); display: inline-flex; align-items: center; justify-content: center;">
                                <i class="ph ph-chat-text"></i>
                            </button>
                            <button class="btn btn-icon btn-danger-soft delete-inq-btn shadow-hover" data-id="${inq.id}" title="Delete Inquiry">
                                <i class="ph ph-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="message-body" style="background: var(--bg-hover); padding: 1.25rem; border-radius: var(--radius-sm); margin: 1rem 0; border-left: 4px solid var(--primary); font-style: italic; color: var(--text-main);">
                        "${escapeHtml(inq.message)}"
                    </div>
                    ${repliesHtml}
                    <div style="text-align: right; font-size: 0.8rem; color: var(--text-muted); font-weight: 500; margin-top: 1rem;">
                        <i class="ph ph-clock"></i> Started: ${new Date(inq.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                </div>
            `}).join('');
            html += `</div>`;
        }
        viewContainer.innerHTML = html;
        
        document.querySelectorAll('.open-reply-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const inqId = e.currentTarget.getAttribute('data-id');
                document.getElementById('replyInqId').value = inqId;
                document.getElementById('replyModal').classList.add('active');
            });
        });

        document.querySelectorAll('.delete-inq-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const inqId = e.currentTarget.getAttribute('data-id');
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i>';
                showConfirm('Delete this inquiry? This cannot be undone.', () => {
                    EstatoStorage.deleteInquiry(inqId);
                    renderMessages();
                }, () => {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="ph ph-trash"></i>';
                });
            });
        });
    }


    window.openReviewModal = (id) => {
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop) return;
        document.getElementById('revPropertyId').value = id;
        renderReviews(id);
        document.getElementById('reviewModal').classList.add('active');
    };

    function renderReviews(id) {
        const container = document.getElementById('reviewList');
        const reviews = EstatoStorage.getReviewsByProperty(id);
        
        if (reviews.length === 0) {
            container.innerHTML = `<div class="empty-state" style="padding: 2rem;"><p>No reviews yet. Be the first to share your thoughts!</p></div>`;
            return;
        }

        container.innerHTML = reviews.reverse().map(rev => `
            <div class="review-item" style="border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <div class="avatar" style="width: 35px; height: 35px; font-size: 0.8rem;">${rev.userName.charAt(0)}</div>
                        <div>
                            <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-main);">${escapeHtml(rev.userName)}</div>
                            <div style="font-size: 0.8rem; color: var(--text-muted);">${new Date(rev.date).toLocaleDateString()}</div>
                        </div>
                    </div>
                    <div style="color: #fbbf24; font-size: 0.9rem;">
                        ${Array(5).fill(0).map((_, i) => `<i class="${i < rev.rating ? 'ph-fill' : 'ph'} ph-star"></i>`).join('')}
                    </div>
                </div>
                <p style="margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">${escapeHtml(rev.comment)}</p>
            </div>
        `).join('');
    }

    // --- Component Generators ---
    function generatePropertyCard(prop, index = 0, distance = null) {
        const isSale = prop.type === 'Sale';
        const badgeClass = isSale ? 'sale' : 'rent';
        
        const favs = EstatoStorage.getFavorites();
        const isFav = favs.includes(prop.id);
        const mapHref = `https://maps.google.com/?q=${encodeURIComponent(prop.address + ', ' + prop.city)}`;
        
        const rawImgArray = (prop.images && prop.images.length > 0) ? prop.images : (prop.image && prop.image.length > 10 ? [prop.image] : ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?q=80&w=800&auto=format&fit=crop']);
        const images = rawImgArray.map(url => window.formatEstatoImage(url));
            
        // RBAC Context Rendering: Seller sees own, Admin sees all
        const role = currentUser ? currentUser.role : 'Buyer';
        const userId = currentUser ? currentUser.id : null;
        const isOwnerOfListing = (role === 'Seller' && prop.ownerId === userId) || role === 'Admin';

        const carouselHTML = `
            <div class="image-carousel">
                ${images.map(img => `<div class="carousel-slide"><img src="${img}" alt="${prop.title}" loading="lazy" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;"></div>`).join('')}
            </div>
            ${images.length > 1 ? `
                <div class="carousel-indicators">
                    ${images.map((_, i) => `<div class="carousel-dot ${i===0?'active':''}"></div>`).join('')}
                </div>
            ` : ''}
        `;

        const ratingData = EstatoStorage.getAverageRating(prop.id);
        const ratingHTML = ratingData.count > 0 ? `
            <div class="rating-badge" title="${ratingData.average} average based on ${ratingData.count} reviews">
                <i class="ph-fill ph-star" style="color: #fbbf24;"></i>
                <span>${ratingData.average}</span>
                <span class="count">(${ratingData.count})</span>
            </div>
        ` : '';

        return `
            <div class="property-card" style="animation-delay: ${index * 0.05}s" onclick="window.dispatchCardClick('${prop.id}')">
                <div class="card-img">
                    ${carouselHTML}
                    <div class="badges">
                        ${prop.category ? `<span class="badge" style="background: var(--${PROPERTY_METADATA[prop.category]?.color || 'primary'}); color: white;"><i class="${PROPERTY_METADATA[prop.category]?.icon || 'ph-house'}"></i> ${prop.category}</span>` : ''}
                        <span class="badge ${badgeClass}">${prop.type}</span>
                        <span class="badge" style="background: rgba(44,40,37,0.85); color: white;">${prop.status}</span>
                        ${distance !== null ? `<span class="badge" style="background: var(--success); color: white; border: none;"><i class="ph ph-navigation-arrow"></i> ${distance.toFixed(1)} km</span>` : ''}
                    </div>
                    ${ratingHTML}
                    <button class="fav-float-btn compare-btn ${compareList.find(p => p.id === prop.id) ? 'active btn-primary' : ''}" onclick="window.toggleCompare('${prop.id}', event)" title="Compare Property" style="right: 3.5rem;">
                        <i class="ph ph-scales"></i>
                    </button>
                    <button class="fav-float-btn fav-btn ${isFav ? 'active' : ''}" data-id="${prop.id}" title="Save to My Properties">
                        <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                    </button>
                </div>
                <div class="card-content">
                    <div class="card-price">
                        ${currencyFormatter.format(prop.price)}
                        <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 500;">${!isSale ? '/ mo' : ''}</span>
                    </div>
                    
                    <div class="card-metrics">
                        <div class="metric"><i class="ph-duotone ph-bed"></i> ${prop.bhk || 'N/A'}</div>
                        <div class="metric"><i class="ph-duotone ph-ruler"></i> ${prop.area ? prop.area.toLocaleString('en-IN') : '--'} sq.ft</div>
                    </div>

                    <div class="card-title">${escapeHtml(prop.title)}</div>
                    ${prop.projectName ? `<div style="font-size: 0.75rem; color: var(--primary); font-weight: 700; text-transform: uppercase; margin-bottom: 0.25rem;"><i class="ph ph-buildings"></i> ${escapeHtml(prop.projectName)}</div>` : ''}
                    <div class="card-location"><i class="ph ph-map-pin"></i> ${escapeHtml(prop.address)}, ${escapeHtml(prop.city)}</div>
                    
                    <div class="card-separator"></div>
                    
                    <div class="card-actions">
                        <button class="btn btn-secondary btn-icon shadow-hover pdf-btn" data-id="${prop.id}" title="Download Flyer">
                            <i class="ph ph-file-pdf"></i>
                        </button>
                        <button class="btn btn-secondary btn-icon shadow-hover reviews-btn" data-id="${prop.id}" title="See Reviews">
                            <i class="ph-duotone ph-star"></i>
                        </button>
                        <a href="${mapHref}" target="_blank" class="btn btn-secondary btn-icon shadow-hover" title="View on Map" onclick="event.stopPropagation()">
                            <i class="ph ph-map-pin-line"></i>
                        </a>
                        ${(role === 'Admin' && prop.status === 'Pending') ? `
                            <button class="btn approve-btn shadow-hover" data-id="${prop.id}" style="flex: 1; background: var(--success); color: white; border: none;"><i class="ph-fill ph-check-circle"></i> Approve</button>
                            <button class="btn btn-danger reject-btn shadow-hover" data-id="${prop.id}" style="flex: 1;"><i class="ph-fill ph-x-circle"></i> Reject</button>
                        ` : isOwnerOfListing ? `
                            <button class="btn btn-secondary edit-btn shadow-hover" data-id="${prop.id}" style="flex: 1;">Edit</button>
                            <button class="btn btn-danger btn-icon delete-btn shadow-hover" data-id="${prop.id}" title="Delete Listing"><i class="ph ph-trash"></i></button>
                        ` : `
                            <button class="btn btn-secondary shadow-hover trend-btn" data-id="${prop.id}" title="Price History"><i class="ph ph-chart-line"></i></button>
                            <button class="btn btn-primary shadow-hover contact-btn" data-id="${prop.id}" data-owner="${prop.ownerId}" data-title="${escapeHtml(prop.title)}" style="flex: 1.2;" title="Message Seller Securely"><i class="ph ph-envelope-simple"></i> Contact</button>
                        `}
                    </div>
                </div>
            </div>
        `;
    }

    function renderRecentlyViewed() {
        if (!currentUser) return '';
        const recentIds = EstatoStorage.getRecentViews(currentUser.id);
        if (recentIds.length === 0) return '';

        const properties = recentIds
            .map(id => EstatoStorage.getPropertyById(id))
            .filter(p => p); // Remove nulls if a property was deleted

        if (properties.length === 0) return '';

        return `
            <div class="section-header" style="margin-top: 0.5rem; margin-bottom: 1rem;">
                <h3 style="font-size: 1.1rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.5rem;">
                    <i class="ph-duotone ph-clock-counter-clockwise"></i> Recently Viewed
                </h3>
            </div>
            <div class="recent-scroll-container" style="display: flex; gap: 1rem; overflow-x: auto; padding-bottom: 1.5rem; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; margin-bottom: 2rem;">
                ${properties.map(p => `
                    <div style="min-width: 200px; max-width: 200px; flex-shrink: 0; scroll-snap-align: start;">
                        <div class="surface-panel shadow-hover" style="border-radius: var(--radius-md); overflow: hidden; height: 100%; cursor: pointer; border: 1px solid var(--border-color);" onclick="window.dispatchCardClick('${p.id}')">
                            <img src="${window.formatEstatoImage((p.images && p.images.length > 0) ? p.images[0] : (p.image || window.ESTATO_DEFAULT_IMG))}" style="width: 100%; height: 100px; object-fit: cover;" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">
                            <div style="padding: 0.75rem 0.5rem;">
                                <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-main); margin-bottom: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.title}</div>
                                <div style="font-size: 0.8rem; color: var(--primary); font-weight: 700;">${currencyFormatter.format(p.price)}</div>
                                <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">${p.city}</div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function getSimilarProperties(property) {
        const all = EstatoStorage.getProperties().filter(p => p.id !== property.id);
        
        const scored = all.map(p => {
            let score = 0;
            if (p.category === property.category) score += 40;
            if (p.type === property.type) score += 30;
            if (p.bhk === property.bhk) score += 20;
            if (p.city === property.city) score += 50;
            
            // Project bonus
            if (p.projectName && property.projectName && p.projectName === property.projectName) score += 60;

            // Recency weighting
            const hoursOld = (Date.now() - (p.date ? new Date(p.date).getTime() : 0)) / (1000 * 3600);
            if (hoursOld < 24) score += 15;
            else if (hoursOld < 168) score += 5;

            return { prop: p, score };
        });

        return scored
            .filter(item => item.score > 50)
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map(item => item.prop);
    }

    // --- Export Functions ---
    function exportToCSV(properties) {
        if (!properties || properties.length === 0) {
            alert('No properties to export.');
            return;
        }
        const headers = ['Title', 'City', 'Address', 'PIN', 'Type', 'Status', 'BHK', 'Area (sq.ft)', 'Price (INR)', 'Description'];
        const rows = properties.map(p => [
            `"${(p.title || '').replace(/"/g, '""')}"`,
            `"${p.city || ''}"`,
            `"${(p.address || '').replace(/"/g, '""')}"`,
            `"${p.pinCode || ''}"`,
            p.type || '',
            p.status || '',
            `"${p.bhk || ''}"`,
            p.area || 0,
            p.price || 0,
            `"${(p.description || '').replace(/"/g, '""')}"`
        ]);

        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `estato_listings_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportToPDF(properties) {
        if (!properties || properties.length === 0) {
            alert('No properties to export.');
            return;
        }

        const { jsPDF } = window.jspdf;
        if (!jsPDF) {
            alert('PDF library not loaded. Please check your connection.');
            return;
        }

        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();

        // Header
        doc.setFillColor(234, 88, 12);
        doc.rect(0, 0, pageW, 18, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Estato — Property Listings Export', 14, 12);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, pageW - 14, 12, { align: 'right' });

        // Table
        doc.autoTable({
            startY: 24,
            head: [['Title', 'City', 'Type', 'Status', 'BHK', 'Area (sq.ft)', 'Price']],
            body: properties.map(p => [
                p.title,
                p.city,
                p.type,
                p.status,
                p.bhk || 'N/A',
                p.area ? p.area.toLocaleString('en-IN') : '—',
                currencyFormatter.format(p.price)
            ]),
            headStyles: { fillColor: [234, 88, 12], textColor: 255, fontStyle: 'bold', fontSize: 9 },
            bodyStyles: { fontSize: 8, textColor: [44, 40, 37] },
            alternateRowStyles: { fillColor: [250, 247, 244] },
            columnStyles: { 6: { halign: 'right' } },
            margin: { left: 14, right: 14 },
            didDrawPage: (data) => {
                // Footer
                const pageNum = doc.internal.getCurrentPageInfo().pageNumber;
                doc.setFontSize(8);
                doc.setTextColor(150);
                doc.text(`Page ${pageNum}  •  Estato PWA`, pageW / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' });
            }
        });

        doc.save(`estato_listings_${new Date().toISOString().slice(0,10)}.pdf`);
    }

    async function reverseGeocode(lat, lng) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
            const data = await res.json();
            if (data && data.address) {
                const road = data.address.road || data.address.suburb || data.address.neighbourhood || '';
                const city = data.address.city || data.address.town || data.address.state_district || '';
                const postcode = data.address.postcode || '';
                
                if (road) document.getElementById('propAddress').value = road;
                if (city) document.getElementById('propCity').value = city;
                if (postcode) document.getElementById('propPinCode').value = postcode;
            }
        } catch (e) {
            console.error("Geocoding failed", e);
        }
    }

    function initModalMap(lat, lng) {
        const container = document.getElementById('modalMap');
        if (!container) return;

        container.style.display = 'block';

        const hasLocation = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
        const centerLat = hasLocation ? parseFloat(lat) : 20.5937;
        const centerLng = hasLocation ? parseFloat(lng) : 78.9629;
        const zoom = hasLocation ? 15 : 4;

        if (!modalMap) {
            modalMap = L.map('modalMap', { zoomControl: true }).setView([centerLat, centerLng], zoom);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; CartoDB',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(modalMap);

            // Click-to-pin: place / move marker on map click
            modalMap.on('click', (e) => {
                const newLat = e.latlng.lat.toFixed(6);
                const newLng = e.latlng.lng.toFixed(6);
                document.getElementById('propLat').value = newLat;
                document.getElementById('propLng').value = newLng;
                updateModalMarker(newLat, newLng);
                reverseGeocode(newLat, newLng);
                // Hide instruction tooltip once location is chosen
                const tip = document.getElementById('mapClickTip');
                if (tip) tip.style.display = 'none';
            });

            // Instructional overlay — shown only when no location is set yet
            if (!hasLocation) {
                const tip = document.createElement('div');
                tip.id = 'mapClickTip';
                tip.innerHTML = '<i class="ph ph-map-pin-line"></i>&nbsp;Click anywhere on the map to pin property location';
                Object.assign(tip.style, {
                    position: 'absolute', top: '10px', left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(234,88,12,0.92)', color: 'white',
                    padding: '6px 14px', borderRadius: '20px',
                    fontSize: '0.78rem', fontWeight: '600',
                    zIndex: '1000', pointerEvents: 'none',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                    whiteSpace: 'nowrap', letterSpacing: '0.01em',
                    animation: 'mapTipPulse 2s ease-in-out infinite'
                });
                container.style.position = 'relative';
                container.appendChild(tip);
            }
        } else {
            modalMap.setView([centerLat, centerLng], zoom);
            // Show/hide tip based on whether we have coords
            const tip = document.getElementById('mapClickTip');
            if (tip) tip.style.display = hasLocation ? 'none' : '';
        }

        setTimeout(() => { modalMap.invalidateSize(); }, 100);

        // Only place a marker when we have real coordinates
        if (hasLocation) {
            updateModalMarker(centerLat, centerLng);
        }
    }

    function updateModalMarker(lat, lng) {
        if (lat === null || lat === undefined || lng === null || lng === undefined) return;
        const fLat = parseFloat(lat);
        const fLng = parseFloat(lng);
        if (isNaN(fLat) || isNaN(fLng)) return;

        if (modalMarker) {
            modalMarker.setLatLng([fLat, fLng]);
            // Pan map to marker so user sees the pin
            if (modalMap) modalMap.panTo([fLat, fLng]);
        } else {
            if (!modalMap) return;
            modalMarker = L.marker([fLat, fLng], {
                draggable: true,
                title: 'Drag to fine-tune exact location'
            }).addTo(modalMap);

            // Drag end: sync inputs + reverse geocode
            modalMarker.on('dragend', (e) => {
                const pos = e.target.getLatLng();
                const newLat = pos.lat.toFixed(6);
                const newLng = pos.lng.toFixed(6);
                document.getElementById('propLat').value = newLat;
                document.getElementById('propLng').value = newLng;
                reverseGeocode(newLat, newLng);
            });

            // Drag start: show a helpful tooltip
            modalMarker.on('dragstart', () => {
                modalMarker.bindTooltip('Release to set location', {
                    permanent: true, className: 'map-drag-tooltip', offset: [0, -30]
                }).openTooltip();
            });
            modalMarker.on('dragend', () => {
                modalMarker.unbindTooltip();
            });
        }
    }

    // --- V11 Interactive Map Logic ---
    function initMap() {
        if (map) return;
        
        // Default to Mumbai or first city
        const center = CITY_COORDS[currentFilterCity] || [20.5937, 78.9629];
        const zoom = currentFilterCity ? 12 : 5;

        map = L.map('leafletMap').setView(center, zoom);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CartoDB',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);

        updateMapMarkers();
    }

    window.toggleMapView = function(showMap) {
        if (currentView !== 'properties') {
            console.warn('toggleMapView: currentView is', currentView, '— skipping');
            return;
        }

        isMapVisible = showMap;
        const grid    = document.getElementById('propertiesGrid');
        const mapCont = document.getElementById('mapContainer');
        const gridBtn = document.getElementById('viewGridBtn');
        const mapBtn  = document.getElementById('viewMapBtn');

        if (!grid)    { console.error('toggleMapView: #propertiesGrid not in DOM'); return; }
        if (!mapCont) { console.error('toggleMapView: #mapContainer not in DOM');   return; }

        // Use inline style so no CSS specificity can block us
        if (showMap) {
            grid.style.display    = 'none';
            mapCont.style.display = 'block';
            if (gridBtn) { gridBtn.classList.remove('active'); }
            if (mapBtn)  { mapBtn.classList.add('active'); }
            setTimeout(() => {
                initMap();
                if (map) map.invalidateSize();
                updateMapMarkers();
            }, 150);
        } else {
            grid.style.display    = '';
            mapCont.style.display = 'none';
            if (gridBtn) { gridBtn.classList.add('active'); }
            if (mapBtn)  { mapBtn.classList.remove('active'); }
        }
    }

    function updateMapMarkers() {
        if (!map) return;
        
        // Clear existing layer group instead of individual markers for performance
        if (mapLayerGroup) {
            map.removeLayer(mapLayerGroup);
        }
        mapLayerGroup = L.layerGroup().addTo(map);
        markers = [];
 
        let properties = EstatoStorage.getProperties();
        
        // RBAC Filtering (Fraud Prevention Sandbox)
        if (currentUser.role === 'Buyer') {
            properties = properties.filter(p => p.status === 'Available');
        } else if (currentUser.role === 'Seller') {
            properties = properties.filter(p => p.status !== 'Pending' || p.ownerId === currentUser.id);
        }

        // Apply Global Filters
        if (currentFilterCity) properties = properties.filter(p => p.city === currentFilterCity);
        if (searchInput.value) {
            const q = searchInput.value.toLowerCase();
            properties = properties.filter(p => p.title.toLowerCase().includes(q) || p.address.toLowerCase().includes(q));
        }
        if (currentTypeFilter) properties = properties.filter(p => p.type === currentTypeFilter);
        if (currentStatusFilter) properties = properties.filter(p => p.status === currentStatusFilter);

        // Apply Proximity Filter
        if (currentRadiusCenter) {
            if (!updateMapMarkers._distanceCache) updateMapMarkers._distanceCache = new Map();
            const dCache = updateMapMarkers._distanceCache;
            const cacheKey = `${currentRadiusCenter.lat},${currentRadiusCenter.lng}`;

            properties = properties.filter(p => {
                const lat = p.lat || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][0] : null);
                const lng = p.lng || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][1] : null);
                if (lat === null || lng === null) return false;

                const key = `${cacheKey}:${p.id}`;
                if (!dCache.has(key)) {
                    dCache.set(key, getHaversineDistance(currentRadiusCenter.lat, currentRadiusCenter.lng, lat, lng));
                }
                return dCache.get(key) <= currentRadiusKm;
            });
        }

        const bounds = [];
        properties.forEach(p => {
            // Use actual coords or fallback to city defaults with slight jitter if exact lat/lng missing
            const lat = p.lat || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][0] + (Math.random()-0.5)*0.01 : null);
            const lng = p.lng || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][1] + (Math.random()-0.5)*0.01 : null);
            
            if (!lat || !lng) return;

            const priceStr = p.price >= 10000000 ? (p.price/10000000).toFixed(1) + 'Cr' : (p.price/100000).toFixed(0) + 'L';
            const icon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div class="map-price-marker">${priceStr}</div>`,
                iconSize: [60, 30],
                iconAnchor: [30, 30]
            });
 
            const marker = L.marker([lat, lng], { icon });
            const firstImg = window.formatEstatoImage((p.images && p.images.length > 0) ? p.images[0] : (p.image || ''));
            const popupContent = `
                <div style="width: 200px; font-family: 'Outfit';">
                    ${firstImg ? `<img src="${firstImg}" style="width:100%; height:100px; object-fit:cover; border-radius:8px; margin-bottom:8px;" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">` : ''}
                    <h4 style="margin:0; font-size:1rem;">${p.title}</h4>
                    <p style="margin:4px 0; color:var(--primary); font-weight:700;">${currencyFormatter.format(p.price)}</p>
                    <button class="btn btn-primary btn-sm w-full" style="margin-top:8px;" onclick="window.dispatchCardClick('${p.id}')">View Details</button>
                </div>
            `;
            marker.bindPopup(popupContent);
            marker.addTo(mapLayerGroup);
            markers.push(marker);
            bounds.push([lat, lng]);
        });

        // Smart Zoom
        if (currentRadiusCenter) {
            // 1. Point to search center
            map.setView([currentRadiusCenter.lat, currentRadiusCenter.lng], 13);
            // 2. Add search center marker
            const centerMarker = L.circle([currentRadiusCenter.lat, currentRadiusCenter.lng], {
                radius: currentRadiusKm * 1000,
                color: '#ea580c',
                weight: 2,
                fillColor: '#ea580c',
                fillOpacity: 0.2
            }).addTo(mapLayerGroup);
                markers.push(centerMarker);
        } else if (bounds.length > 0 && !currentFilterCity) {
            map.fitBounds(bounds, { padding: [50, 50] });
        } else if (currentFilterCity) {
            map.setView(CITY_COORDS[currentFilterCity], 12);
        }
    }

    // --- V11 Comparison Logic ---
    function toggleCompare(id, event) {
        if (event) event.stopPropagation();
        
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop) return;

        const index = compareList.findIndex(p => p.id === id);

        if (index === -1) {
            if (compareList.length >= 3) {
                showToast("You can compare a maximum of 3 properties side-by-side.", "warning");
                return;
            }
            compareList.push(prop);
        } else {
            compareList.splice(index, 1);
        }
        updateCompareTray();
        saveCompareState();
    }

    function saveCompareState() {
        const ids = compareList.map(p => p.id);
        localStorage.setItem('estato_compare_v1', JSON.stringify(ids));
    }

    function updateCompareTray() {
        const tray = document.getElementById('compareTray');
        const count = document.getElementById('compareCount');
        const listTray = document.getElementById('compareListTray');
        const modal = document.getElementById('compareModal');
        const modalContent = modal?.querySelector('.modal');

        count.textContent = compareList.length;

        if (compareList.length > 0) {
            tray.classList.add('active');
            tray.style.transform = 'translateX(-50%) translateY(0)';
            listTray.innerHTML = compareList.map(p => `
                <div class="compare-pill">
                    <span>${p.title.substring(0, 15)}...</span>
                    <i class="ph ph-x-circle" style="cursor:pointer;" onclick="window.toggleCompare('${p.id}')"></i>
                </div>
            `).join('');
            listTray.innerHTML += `
                <button class="btn btn-icon btn-danger-soft" onclick="window.clearCompare()" title="Clear All Comparison" style="margin-left: 0.5rem;">
                    <i class="ph ph-trash"></i>
                </button>
            `;
        } else {
            tray.classList.remove('active');
            tray.style.transform = 'translateX(-50%) translateY(150%)';
        }
    }

    window.clearCompare = () => {
        compareList = [];
        saveCompareState();
        updateCompareTray();
    };

    function renderComparisonTable() {
        if (compareList.length < 2) {
            showToast("Please select at least 2 properties to compare.", "info");
            return;
        }

        const container = document.getElementById('comparisonTableContainer');
        const modal = document.getElementById('compareModal');
        const modalContent = modal.querySelector('.modal');
        if (modalContent) modalContent.classList.add('modal-lg');

        let html = `<div class="comparison-table-wrapper"><table class="comparison-table"><thead><tr><th>Feature</th>`;
        
        compareList.forEach(p => {
            const firstImg = window.formatEstatoImage((p.images && p.images.length > 0) ? p.images[0] : (p.image || ''));
            html += `
                <th class="prop-header">
                    ${firstImg ? `<img src="${firstImg}" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">` : ''}
                    <div style="font-weight:700; margin-top: 5px;">${p.title}</div>
                </th>
            `;
        });
        html += `</tr></thead><tbody>`;

        const rows = [
            { label: 'Price', key: 'price', icon: 'ph-tag', format: (v) => currencyFormatter.format(v), type: 'min' },
            { label: 'Area', key: 'area', icon: 'ph-ruler', format: (v) => v.toLocaleString() + ' sq.ft', type: 'max' },
            { label: 'Type', key: 'type', icon: 'ph-house-line' },
            { label: 'Layout', key: 'bhk', icon: 'ph-layout' },
            { label: 'Category', key: 'category', icon: 'ph-bookmarks' },
            { label: 'Status', key: 'status', icon: 'ph-info' },
            { label: 'City', key: 'city', icon: 'ph-map-pin' }
        ];

        rows.forEach(row => {
            // Calculate Highlight
            let bestVal = null;
            if (row.type === 'min') {
                bestVal = Math.min(...compareList.map(p => p[row.key]));
            } else if (row.type === 'max') {
                bestVal = Math.max(...compareList.map(p => p[row.key]));
            }

            // Check if there are differences in this row
            const values = compareList.map(p => String(p[row.key]));
            const hasDifference = new Set(values).size > 1;

            html += `<tr>
                <th style="background: var(--bg-hover); font-weight: 600; color: var(--text-muted);">
                    <i class="${row.icon}" style="margin-right: 8px;"></i>${row.label}
                </th>`;
            
            compareList.forEach(p => {
                const val = p[row.key];
                const isBest = bestVal !== null && val === bestVal && hasDifference;
                const style = isBest ? 'background: rgba(16, 185, 129, 0.1); color: #059669; font-weight: 700;' : (hasDifference ? 'background: rgba(234, 88, 12, 0.02);' : '');
                
                html += `<td style="${style}">
                    ${isBest ? '<i class="ph-fill ph-check-circle" style="margin-right: 4px;"></i>' : ''}
                    ${row.format ? row.format(val) : val}
                </td>`;
            });
            html += `</tr>`;
        });

        html += `</tbody></table></div>`;
        container.innerHTML = html;
        modal.classList.add('active');
        
        // Auto-clear background selection UI UX
        if (window.clearCompare) {
            window.clearCompare();
        }
    }

    // Expose to global for HTML string events
    window.toggleCompare = toggleCompare;
    window.renderComparisonTable = renderComparisonTable;
    window.dispatchCardClick = (id) => {
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop) return;

        // Track View
        if (currentUser) EstatoStorage.addRecentView(currentUser.id, id);

        window.openPropertyDetails(prop);
        updateSeoMetadata(prop);
    };

    window.openPropertyDetails = (prop) => {
        document.getElementById('detailsTitle').textContent = prop.title;
        document.getElementById('detailsLocation').innerHTML = `<i class="ph ph-map-pin"></i> ${escapeHtml(prop.address)}, ${escapeHtml(prop.city)}`;
        
        // Images
        const rawImgArray = (prop.images && prop.images.length > 0) ? prop.images : (prop.image && prop.image.length > 10 ? [prop.image] : ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?q=80&w=800&auto=format&fit=crop']);
        const images = rawImgArray.map(url => window.formatEstatoImage(url));
        const imgHtml = `
            <div style="position:relative; width:100%; height:300px; display:flex; overflow-x:auto; scroll-snap-type:x mandatory; gap:0.5rem; padding-bottom: 0.5rem;">
                ${images.map(img => `<img src="${img}" style="height:100%; min-width:100%; object-fit:cover; scroll-snap-align:start; border-radius:var(--radius-md);" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">`).join('')}
            </div>
        `;
        document.getElementById('detailsImageCarousel').innerHTML = imgHtml;

        // Metrics
        document.getElementById('detailsMetrics').innerHTML = `
            <div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-house-line" style="color:var(--primary); font-size:1.2rem;"></i> <strong>Type:</strong> ${prop.type}</div>
            <div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-list-dashes" style="color:var(--primary); font-size:1.2rem;"></i> <strong>Category:</strong> ${prop.category || 'N/A'}</div>
            <div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-bed" style="color:var(--primary); font-size:1.2rem;"></i> <strong>Layout:</strong> ${prop.bhk || 'N/A'}</div>
            <div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-ruler" style="color:var(--primary); font-size:1.2rem;"></i> <strong>Area:</strong> ${prop.area ? prop.area.toLocaleString() + ' sq.ft' : 'N/A'}</div>
            <div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-info" style="color:var(--primary); font-size:1.2rem;"></i> <strong>Status:</strong> ${prop.status}</div>
        `;

        // Lister
        const ownerName = prop.ownerName || 'Estato User';
        const ownerPicture = prop.ownerPicture || null;
        const listedAt = prop.listedAt ? new Date(prop.listedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
        const updatedAt = prop.updatedAt ? new Date(prop.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
        const avatarHtml = ownerPicture
            ? `<img src="${ownerPicture}" alt="${escapeHtml(ownerName)}" style="width:48px; height:48px; border-radius:50%; object-fit:cover; border: 2px solid var(--primary-light);" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex';">
               <div class="avatar" style="display:none;width:48px; height:48px; background:var(--primary-light); color:var(--primary); align-items:center; justify-content:center; border-radius:50%; font-weight:bold; font-size: 1.3rem; flex-shrink:0;">${ownerName.charAt(0).toUpperCase()}</div>`
            : `<div class="avatar" style="width:48px; height:48px; background:var(--primary-light); color:var(--primary); display:flex; align-items:center; justify-content:center; border-radius:50%; font-weight:bold; font-size: 1.3rem; flex-shrink:0;">${ownerName.charAt(0).toUpperCase()}</div>`;
        document.getElementById('detailsLister').innerHTML = `
            <div style="display:flex; align-items:center; gap:1rem;">
                <div style="flex-shrink:0; position:relative;">${avatarHtml}</div>
                <div style="min-width:0;">
                    <h5 style="margin:0 0 2px 0; font-size:1rem; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(ownerName)}</h5>
                    ${listedAt ? `<p style="margin:0; font-size:0.78rem; color:var(--text-muted);"><i class="ph ph-calendar-blank" style="margin-right:3px;"></i>Listed ${listedAt}</p>` : ''}
                    ${updatedAt ? `<p style="margin:2px 0 0 0; font-size:0.78rem; color:var(--text-muted);"><i class="ph ph-pencil-simple" style="margin-right:3px; color:var(--primary);"></i>Last updated ${updatedAt}</p>` : ''}
                </div>
            </div>
        `;

        // Description
        document.getElementById('detailsDescription').textContent = prop.description || 'No description provided for this listing.';

        // Ratings
        const reviews = EstatoStorage.getReviewsByProperty(prop.id);
        let ratingsHtml = '';
        if (reviews.length === 0) {
            ratingsHtml = `<div style="font-size:0.9rem; color:var(--text-muted); font-style:italic;">No ratings yet.</div>`;
        } else {
            const ratingData = EstatoStorage.getAverageRating(prop.id);
            ratingsHtml = `
                <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:1rem;">
                    <div style="font-size:1.5rem; font-weight:700; color:var(--text-main);">${ratingData.average}</div>
                    <div style="color:#fbbf24; font-size:1.2rem;">
                        <i class="ph-fill ph-star"></i>
                    </div>
                    <div style="font-size:0.9rem; color:var(--text-muted);">(${ratingData.count} ratings)</div>
                </div>
                <div style="display:flex; flex-direction:column; gap:0.75rem;">
                    ${reviews.slice(0, 3).map(rev => `
                        <div style="background:var(--bg-main); padding:0.75rem; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                            <div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;">
                                <span style="font-weight:600; font-size:0.85rem;">${escapeHtml(rev.userName)}</span>
                                <div style="color:#fbbf24; font-size:0.75rem;">${Array(5).fill(0).map((_, i) => `<i class="${i < rev.rating ? 'ph-fill' : 'ph'} ph-star"></i>`).join('')}</div>
                            </div>
                            <div style="font-size:0.85rem; color:var(--text-muted);">${escapeHtml(rev.comment)}</div>
                        </div>
                    `).join('')}
                    ${reviews.length > 3 ? `<div style="font-size:0.85rem; color:var(--primary); font-weight:600; margin-top:0.5rem; cursor:pointer;" onclick="window.openReviewModal('${prop.id}')">View all reviews...</div>` : ''}
                </div>
            `;
        }
        document.getElementById('detailsRatingsContainer').innerHTML = ratingsHtml;

        // Footer Price & Buttons
        document.getElementById('detailsPrice').innerHTML = `${currencyFormatter.format(prop.price)} <span style="font-size:1rem; color:var(--text-muted); font-weight:500;">${prop.type === 'Rent' ? '/ mo' : ''}</span>`;
        
        const role = currentUser ? currentUser.role : 'Buyer';
        const userId = currentUser ? currentUser.id : null;
        const isOwnerOfListing = (role === 'Seller' && prop.ownerId === userId) || role === 'Admin';
        const favs = EstatoStorage.getFavorites();
        const isFav = favs.includes(prop.id);

        let btnHtml = '';
        if (isOwnerOfListing) {
            btnHtml = ``;
        } else {
            btnHtml = `
                <button class="btn btn-secondary btn-icon shadow-hover fav-btn ${isFav ? 'active' : ''}" data-id="${prop.id}">
                    <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                </button>
                <button class="btn btn-primary shadow-hover contact-btn" data-id="${prop.id}" data-owner="${prop.ownerId}" data-title="${escapeHtml(prop.title)}" style="gap:0.5rem;"><i class="ph ph-envelope-simple"></i> Contact Seller</button>
            `;
        }
        document.getElementById('detailsActionBtns').innerHTML = btnHtml;

        // Attach local listeners for dynamic buttons inside modal
        const footerBtns = document.getElementById('detailsActionBtns');
        const contactBtn = footerBtns.querySelector('.contact-btn');
        if (contactBtn) {
            contactBtn.addEventListener('click', (e) => {
                document.getElementById('propertyDetailsModal').classList.remove('active');
                document.getElementById('inqPropertyId').value = prop.id;
                document.getElementById('inqOwnerId').value = prop.ownerId;
                document.getElementById('inqPropertyTitle').value = prop.title;
                document.getElementById('inquiryModal').classList.add('active');
            });
        }
        const favBtn = footerBtns.querySelector('.fav-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                EstatoStorage.toggleFavorite(prop.id);
                const isNowFav = EstatoStorage.getFavorites().includes(prop.id);
                favBtn.classList.toggle('active', isNowFav);
                favBtn.querySelector('i').className = isNowFav ? 'ph-fill ph-heart' : 'ph ph-heart';
                renderView(currentView, searchInput.value); // Re-render background grid silently
            });
        }

        document.getElementById('propertyDetailsModal').classList.add('active');
    };

    function attachCardListeners(parent = document) {
        parent.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                const prop = EstatoStorage.getPropertyById(id);
                if (prop) openModal(prop);
            });
        });

        parent.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                showConfirm('Delete this listing? This cannot be undone.', async () => {
                    const success = await EstatoStorage.deleteProperty(id);
                    if (!success) showToast('Unauthorized: You can only delete your own listings.', 'danger');
                });
            });
        });

        parent.querySelectorAll('.fav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                EstatoStorage.toggleFavorite(id);
            });
        });

        parent.querySelectorAll('.compare-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                toggleCompare(id);
                // Toggle active class visually immediately
                btn.classList.toggle('active');
                btn.classList.toggle('btn-primary');
            });
        });

        parent.querySelectorAll('.pdf-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const prop = EstatoStorage.getPropertyById(id);
                if (prop) await generateFlyer(prop);
            });
        });

        parent.querySelectorAll('.approve-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                showConfirm('Approve this listing for public view?', async () => {
                    const success = await EstatoStorage.approveProperty(id);
                    if (success) renderView(currentView, searchInput.value);
                });
            });
        });

        parent.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                showPrompt('Provide a reason for rejection (will be sent to the seller):', async (reason) => {
                    if (reason === null) return;
                    const success = await EstatoStorage.rejectProperty(id, reason.trim() || undefined);
                    if (success) renderView(currentView, searchInput.value);
                });
            });
        });

        parent.querySelectorAll('.contact-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const propId = e.currentTarget.getAttribute('data-id');
                const ownerId = e.currentTarget.getAttribute('data-owner');
                const title = e.currentTarget.getAttribute('data-title');
                
                document.getElementById('inqPropertyId').value = propId;
                document.getElementById('inqOwnerId').value = ownerId;
                document.getElementById('inqPropertyTitle').value = title;
                document.getElementById('inqPropNameDisplay').textContent = title;
                document.getElementById('inqMessage').value = '';
                
                document.getElementById('inquiryModal').classList.add('active');
            });
        });

        parent.querySelectorAll('.reviews-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const propId = e.currentTarget.getAttribute('data-id');
                window.openReviewModal(propId);
            });
        });

        parent.querySelectorAll('.trend-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const propId = e.currentTarget.getAttribute('data-id');
                window.openPriceHistoryModal(propId);
            });
        });

        // Carousel Dot Sync — updates the active indicator dot when user swipes
        document.querySelectorAll('.image-carousel').forEach(carousel => {
            const cardImg = carousel.closest('.card-img');
            if (!cardImg) return;
            const dots = cardImg.querySelectorAll('.carousel-dot');
            if (dots.length < 2) return;

            carousel.addEventListener('scroll', () => {
                const slideWidth = carousel.offsetWidth;
                const activeIndex = Math.round(carousel.scrollLeft / slideWidth);
                dots.forEach((dot, i) => dot.classList.toggle('active', i === activeIndex));
            }, { passive: true });
        });
    }

    // --- Modal Logic ---
    function openModal(property = null) {
        if (property) {
            // Editing: always reset to the loaded property
            propertyForm.reset();
            propImageFile.value = '';
            imagePreviewContainer.style.display = 'none';
            propImageHidden.value = '';
        } else {
            // Adding: Only reset if the OLD form was editing a specific property
            if (document.getElementById('propId').value !== '') {
                propertyForm.reset();
                propImageFile.value = '';
                imagePreviewContainer.style.display = 'none';
                propImageHidden.value = '';
                document.getElementById('propId').value = '';
            }
            // If propId is blank, we leave the fields intact intentionally so they don't vanish!
        }

        // Populate dynamic dropdowns from FILTER_CONFIG
        const populateSelect = (id, options, selectedValue) => {
            const select = document.getElementById(id);
            if (!select) return;
            select.innerHTML = options.map(opt => {
                const val = typeof opt === 'string' ? opt : opt.value;
                const label = typeof opt === 'string' ? opt : opt.label;
                return `<option value="${val}" ${val === selectedValue ? 'selected' : ''}>${label}</option>`;
            }).join('');
        };

        populateSelect('propType', FILTER_CONFIG.types, property ? property.type : 'Sale');
        populateSelect('propCategory', FILTER_CONFIG.categories, property ? property.category : 'Apartment');
        populateSelect('propStatus', FILTER_CONFIG.statuses, property ? property.status : 'Pending');
        populateSelect('propBhk', FILTER_CONFIG.bhkLayouts, property ? property.bhk : '2 BHK');

        // Hide Status dropdown entirely for Sellers
        if (currentUser && currentUser.role === 'Seller') {
            document.getElementById('propStatus').closest('.form-group').style.display = 'none';
        } else {
            document.getElementById('propStatus').closest('.form-group').style.display = 'block';
        }
        
        if (property) {
            modalTitle.textContent = 'Edit Listing';
            document.getElementById('propId').value = property.id;
            document.getElementById('propTitle').value = property.title;
            document.getElementById('propProjectName').value = property.projectName || '';
            document.getElementById('propCity').value = property.city;
            document.getElementById('propPrice').value = property.price;
            document.getElementById('propArea').value = property.area || '';
            document.getElementById('propAddress').value = property.address;
            document.getElementById('propDescription').value = property.description || '';
            
            const imgs = property.images && property.images.length > 0 ? property.images : (property.image ? [property.image] : []);
            propImageHidden.value = imgs.length > 0 ? JSON.stringify(imgs) : '';
            if (window.renderImagePreviews) window.renderImagePreviews();

            // Restore location fields
            document.getElementById('propPinCode').value = property.pinCode || '';
            document.getElementById('propLat').value = property.lat || '';
            document.getElementById('propLng').value = property.lng || '';
            const gLink = document.getElementById('propGoogleMapsLink');
            if (gLink) gLink.value = '';
        } else {
            modalTitle.textContent = 'Publish New Listing';
            document.getElementById('propId').value = '';
        }

        // Always scroll modal body back to top so Title + Image fields are visible
        const modalBody = propertyModal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;

        propertyModal.classList.add('active');
        
        const currentLat = document.getElementById('propLat').value;
        const currentLng = document.getElementById('propLng').value;
        setTimeout(() => {
            initModalMap(currentLat, currentLng);
        }, 150);
    }

    function closeModal() {
        propertyModal.classList.remove('active');
        // REMOVED propertyForm.reset() so half-filled forms don't vanish!
        // Clean up modal marker so next openModal() starts fresh
        // (the map instance is reused, but the marker state must reset)
        if (modalMarker && modalMap) {
            modalMap.removeLayer(modalMarker);
            modalMarker = null;
        }
        // Re-show the click-tip for the next time the modal is opened
        const tip = document.getElementById('mapClickTip');
        if (tip) tip.style.display = '';
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        
        const id = document.getElementById('propId').value;
        const title       = document.getElementById('propTitle').value.trim();
        const projectName = document.getElementById('propProjectName').value.trim();
        const city        = document.getElementById('propCity').value.trim();
        const address = document.getElementById('propAddress').value.trim();
        const price   = Number(document.getElementById('propPrice').value);
        const pinCode = document.getElementById('propPinCode').value.trim();
        const lat     = document.getElementById('propLat').value;
        const lng     = document.getElementById('propLng').value;

        if (!title || !city || !address || !price || !pinCode || !lat || !lng) {
            showToast('Please fill in all required fields: Title, City, Address, PIN Code, Price, and Location.', 'warning');
            return;
        }

        const newProperty = {
            id: id || undefined,
            title,
            projectName,
            city,
            price,
            pinCode,
            lat: Number(lat),
            lng: Number(lng),
            bhk: document.getElementById('propBhk').value,
            area: Number(document.getElementById('propArea').value) || 0,
            address,
            type: document.getElementById('propType').value,
            status: (currentUser && currentUser.role === 'Admin') ? document.getElementById('propStatus').value : 'Pending',
            category: document.getElementById('propCategory').value,
            description: document.getElementById('propDescription').value.trim(),
            images: document.getElementById('propImage').value ? JSON.parse(document.getElementById('propImage').value) : []
        };

        // Show loading state on the submit button to prevent double-submits
        const submitBtn = propertyForm.querySelector('[type="submit"]');
        const origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Saving...'; }

        try {
            if (id) {
                await EstatoStorage.updateProperty(newProperty);
                showToast('Listing updated successfully!', 'success');
            } else {
                await EstatoStorage.addProperty(newProperty);
                showToast(currentUser && currentUser.role === 'Admin' ? 'Listing published!' : 'Listing submitted for review!', 'success');
            }
            propertyForm.reset();
            closeModal();
            populateCitiesDatalist();
            setActiveNav('properties');
            currentFilterCity = null;
            currentSort = 'newest';
            currentTypeFilter = '';
            currentStatusFilter = '';
        } catch(err) {
            console.error('Form submit failed:', err);
            showToast('Error saving listing: ' + err.message, 'danger');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnHtml; }
        }
    }

    function populateCitiesDatalist() {
        const cities = EstatoStorage.getCities();
        citiesListDropdown.innerHTML = cities.map(c => `<option value="${c}">`).join('');
    }

    // --- Notifications ---
    function renderNotifications() {
        const notifs = EstatoStorage.getNotifications();
        const unreadCount = notifs.filter(n => !n.read).length;

        // Update Badge
        if (unreadCount > 0) {
            notifBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            notifBadge.classList.remove('hidden');
        } else {
            notifBadge.classList.add('hidden');
        }

        // Render List
        if (notifs.length === 0) {
            notifList.innerHTML = `<div class="empty-notif"><i class="ph-duotone ph-bell-slash"></i><p>No notifications yet</p></div>`;
            return;
        }

        notifList.innerHTML = notifs.map(n => {
            let iconClass = 'ph-info';
            if (n.type === 'price_update') iconClass = 'ph-tag';
            if (n.type === 'new_listing') iconClass = 'ph-house-line';

            return `
                <div class="notif-item ${n.read ? '' : 'unread'}" onclick="window.dispatchNotifClick('${n.meta ? n.meta.id : ''}')">
                    <div class="notif-icon"><i class="ph-duotone ${iconClass}"></i></div>
                    <div class="notif-content">
                        <p>${escapeHtml(n.message)}</p>
                        <span class="notif-time">${new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    window.dispatchNotifClick = (propertyId) => {
        if (propertyId) {
            const prop = EstatoStorage.getPropertyById(propertyId);
            if (prop) {
                if (currentUser) EstatoStorage.addRecentView(currentUser.id, propertyId);
                notifDropdown.classList.add('hidden');
                // Fallback to dispatchCardClick logic if openPropertyDetails missing
                window.dispatchCardClick(propertyId);
            }
        }
    };

    function renderAdminActivityFeed() {
        const activities = EstatoStorage.getActivities().slice(0, 15);
        
        const getActionStyle = (action) => {
            if (action.includes('ADD')) return { icon: 'ph-plus-circle', color: '#10b981' };
            if (action.includes('UPDATE')) return { icon: 'ph-pencil-line', color: '#3b82f6' };
            if (action.includes('DELETE')) return { icon: 'ph-trash', color: '#ef4444' };
            return { icon: 'ph-info', color: '#6b7280' };
        };

        const timeAgo = (date) => {
            const seconds = Math.floor((new Date() - new Date(date)) / 1000);
            if (seconds < 60) return 'Just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h ago`;
            return new Date(date).toLocaleDateString();
        };

        return `
            <div class="dashboard-card surface-panel" style="margin-top: 2rem; border-top: 3px solid var(--primary); padding: 1.5rem; border-radius: var(--radius-lg);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                    <h3 style="display: flex; align-items: center; gap: 0.75rem; margin: 0; font-size: 1.16rem; font-weight: 700;">
                        <i class="ph-duotone ph-clock-counter-clockwise" style="color: var(--primary);"></i> Platform Activity Feed
                    </h3>
                    <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; background: var(--bg-main); padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color);">Admin Audit</span>
                </div>
                
                <div class="activity-feed-container" style="max-height: 420px; overflow-y: auto; padding-right: 8px; scrollbar-gutter: stable;">
                    ${activities.length === 0 ? `
                        <div style="text-align: center; padding: 3rem 1.5rem; color: var(--text-muted);">
                            <i class="ph ph-mask-sad" style="font-size: 3rem; opacity: 0.2; margin-bottom: 1rem; display: block;"></i>
                            <p style="font-size: 0.95rem; font-weight: 500;">No activity records found.</p>
                        </div>
                    ` : activities.map(act => {
                        const style = getActionStyle(act.action);
                        return `
                            <div class="activity-item" style="display: flex; gap: 1.25rem; padding: 1.25rem; border-bottom: 1px solid var(--border-color); align-items: flex-start; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); border-radius: var(--radius-md); margin-bottom: 4px;">
                                <div style="background: ${style.color}15; color: ${style.color}; padding: 0.75rem; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 6px -1px ${style.color}10;">
                                    <i class="ph ${style.icon}" style="font-size: 1.4rem;"></i>
                                </div>
                                <div style="flex: 1; min-width: 0;">
                                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 4px;">
                                        <div style="font-weight: 700; font-size: 1rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                            ${escapeHtml(act.userName)}
                                            <span style="font-weight: 400; color: var(--text-muted); font-size: 0.8rem; background: var(--bg-main); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-color); margin-left: 6px;">${escapeHtml(act.role)}</span>
                                        </div>
                                        <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500; white-space: nowrap;">${timeAgo(act.timestamp)}</div>
                                    </div>
                                    <div style="font-size: 0.95rem; color: var(--text-main); line-height: 1.5; font-weight: 450;">${escapeHtml(act.details)}</div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // --- PDF Engine Snippet ---
    async function generateFlyer(prop) {
        const flyerId = 'tempFlyer_' + prop.id;
        const flyerDiv = document.createElement('div');
        flyerDiv.id = flyerId;
        Object.assign(flyerDiv.style, {
            position: 'absolute', left: '-9999px', top: '0', 
            width: '800px', padding: '50px', background: '#fdfbf7', 
            color: '#2c2825', fontFamily: 'Outfit, sans-serif'
        });
        
        // Use images[] array first (new format), fall back to legacy prop.image
        let imgUrl = (prop.images && prop.images.length > 0) ? prop.images[0] : (prop.image && prop.image.length > 10 ? prop.image : '');
        if (imgUrl) imgUrl = imgUrl.replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0];

        flyerDiv.innerHTML = `
            <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #ea580c; padding-bottom: 20px;">
                <h1 style="color: #ea580c; font-size: 38px; margin: 0; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    ESTATO <span style="color: #7d746d; font-weight: 300;">| PREMIUM LISTING</span>
                </h1>
            </div>
            ${imgUrl ? `<img src="${imgUrl}" style="width: 100%; height: 450px; object-fit: cover; border-radius: 16px; margin-bottom: 30px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1);" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">` : ''}
            
            <h2 style="font-size: 42px; margin: 0 0 10px 0; font-weight: 700;">${prop.title}</h2>
            <h3 style="color: #7d746d; font-size: 26px; margin: 0 0 30px 0; font-weight: 400;">${prop.address}, ${prop.city}</h3>
            
            <div style="display: flex; justify-content: space-between; background: #ffffff; border: 1px solid #e5e0d8; padding: 30px; border-radius: 16px; margin-bottom: 40px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
                <div style="font-size: 50px; font-weight: 800; color: #ea580c; letter-spacing: -1px;">
                    ${currencyFormatter.format(prop.price)} <span style="font-size: 24px; color: #7d746d; font-weight: 500;">${prop.type === 'Rent' ? '/ mo' : ''}</span>
                </div>
                <div style="align-self: center;">
                    <span style="background: #2c2825; color: #fff; padding: 8px 24px; border-radius: 8px; font-size: 24px; font-weight: 600; text-transform: uppercase;">${prop.status}</span>
                </div>
            </div>

            <div style="display: flex; justify-content: space-around; background: #ffffff; border: 1px solid #e5e0d8; padding: 30px; border-radius: 16px;">
                <div style="text-align: center;">
                    <div style="color: #7d746d; font-size: 18px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px;">Type</div>
                    <div style="font-size: 28px; font-weight: 600; color: #ea580c;">For ${prop.type}</div>
                </div>
                <div style="width: 1px; background: #e5e0d8;"></div>
                <div style="text-align: center;">
                    <div style="color: #7d746d; font-size: 18px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px;">Layout</div>
                    <div style="font-size: 28px; font-weight: 600;">${prop.bhk || 'N/A'}</div>
                </div>
                <div style="width: 1px; background: #e5e0d8;"></div>
                <div style="text-align: center;">
                    <div style="color: #7d746d; font-size: 18px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px;">Area</div>
                    <div style="font-size: 28px; font-weight: 600;">${prop.area ? prop.area.toLocaleString('en-IN') + ' sq.ft' : 'N/A'}</div>
                </div>
            </div>
        `;
        
        document.body.appendChild(flyerDiv);
        try {
            const canvas = await window.html2canvas(flyerDiv, { scale: 2, useCORS: true });
            const imgData = canvas.toDataURL('image/jpeg', 0.95);
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
            let yOffset = pdfHeight < pdf.internal.pageSize.getHeight() ? (pdf.internal.pageSize.getHeight() - pdfHeight) / 2 : 0;
            
            pdf.addImage(imgData, 'JPEG', 0, yOffset, pdfWidth, pdfHeight);
            pdf.save(`Estato_Flyer_${prop.title.replace(/[\s\W]+/g, '_')}.pdf`);
            
        } catch(e) {
            console.error('PDF Gen Error:', e);
            showToast('Error generating PDF flyer. Check console for details.', 'danger');
        } finally {
            document.body.removeChild(flyerDiv);
        }
    }

    updateCompareTray();

    /** ── Backup & Restore Logic ── **/
    function exportBackup() {
        try {
            const data = EstatoStorage.getData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const date = new Date().toISOString().split('T')[0];
            a.href = url;
            a.download = `estato_backup_${date}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Backup downloaded successfully!', 'success');
        } catch(e) {
            console.error('Backup failed:', e);
            showToast('Error generating backup file.', 'danger');
        }
    }

    async function handleRestore(file) {
        showConfirm('⚠️ WARNING: This will overwrite ALL current data. This action cannot be undone. Proceed?', async () => {
            const reader = new FileReader();
            reader.onload = async (e) => {
            try {
                const json = JSON.parse(e.target.result);
                const ok = await EstatoStorage.restoreData(json);
                if (ok) {
                    showToast('Restoration successful! Reloading now...', 'success');
                    setTimeout(() => location.reload(), 1500);
                } else {
                    showToast('Restore failed: Unauthorized or invalid backup file.', 'danger');
                }
            } catch(err) {
                console.error('Restore failed:', err);
                showToast('Restore failed: ' + err.message, 'danger');
            }
        };
        reader.onerror = () => showToast('Error reading backup file.', 'danger');
            reader.readAsText(file);
        }); // end showConfirm
    }

    function updateSeoMetadata(prop = null) {
        const titleTag = document.title;
        const metaDesc = document.querySelector('meta[name="description"]');
        let schemaScript = document.getElementById('seo-json-ld');
        
        if (!schemaScript) {
            schemaScript = document.createElement('script');
            schemaScript.id = 'seo-json-ld';
            schemaScript.type = 'application/ld+json';
            document.head.appendChild(schemaScript);
        }

        if (prop) {
            const title = `${prop.title} | Estato V12.1`;
            const desc = `${prop.type} in ${prop.city} - ${prop.bhk} BHK, ${prop.area} sqft. ${prop.description.substring(0, 100)}...`;
            
            document.title = title;
            if (metaDesc) metaDesc.setAttribute('content', desc);

            // Rich Snippet (RealEstateListing)
            const ld = {
                "@context": "https://schema.org/",
                "@type": "RealEstateListing",
                "name": prop.title,
                "description": prop.description,
                "datePosted": prop.date || new Date().toISOString(),
                "price": prop.price,
                "priceCurrency": "INR",
                "address": {
                    "@type": "PostalAddress",
                    "addressLocality": prop.city,
                    "streetAddress": prop.address
                },
                "numberOfRooms": prop.rooms || prop.bhk,
                "floorSize": {
                    "@type": "QuantitativeValue",
                    "value": prop.area,
                    "unitCode": "FTK"
                }
            };
            schemaScript.textContent = JSON.stringify(ld);
        } else {
            document.title = "Estato V12.1 | Premium Real Estate Marketplace";
            if (metaDesc) metaDesc.setAttribute('content', "Estato V12.1 — The definitive premium real estate marketplace. Real-time listings, proximity search, and seamless secure property management.");
            schemaScript.textContent = JSON.stringify({
                "@context": "https://schema.org",
                "@type": "WebSite",
                "name": "Estato",
                "url": window.location.origin
            });
        }
    }

    // Expose to global if needed
    window.reauthorizeDrive = async () => {
        const user = EstatoStorage.getCurrentUser();
        const success = await EstatoStorage.loginWithGoogle(user ? user.role : 'Seller', false);
        if (success) {
            alert('Re-authorization successful! You can now upload images.');
            // Refresh preview area if it showed the error
            if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        } else {
            alert('Authorization failed. Please ensure popups are allowed.');
        }
    };

    window.updateSeoMetadata = updateSeoMetadata;
});
