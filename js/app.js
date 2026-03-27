document.addEventListener('DOMContentLoaded', () => {

    // --- State and Cache ---
    let currentUser = null;
    let currentView = 'properties'; // Default fallback
    let currentFilterCity = null;

    let currentSort = 'newest';
    let currentTypeFilter = '';
    let currentStatusFilter = '';

    let dashboardChart = null;

    // V11 States
    let map = null;
    let markers = [];
    let isMapVisible = false;
    let compareList = []; // Array of property objects
    
    // City Geocoding Map — 25 major Indian cities
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
        'Noida': [28.5355, 77.3910]
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
            badge.innerHTML = '<i class="ph ph-warning"></i><span>Offline</span>';
        } else {
            badge.classList.add('sync-synced');
            badge.innerHTML = '<i class="ph ph-check-circle"></i><span>Synced</span>';
        }
    }

    // --- Initialization ---
    console.log("Estato V11.2 Booting...");
    initApp();

    async function initApp() {
        console.log("Initializing App flow...");
        setupAuthListeners();

        // 1. Initialize GIS & Drive Engine
        try {
            await Storage.initDrive(updateSyncBadge);
            console.log("Drive Engine Initialized.");
        } catch (err) {
            console.error("Drive Engine Init Failed:", err);
            loginErrorMsg.textContent = "Sync Error: Could not connect to Google.";
        }

        // 2. Try silent/cached login to bypass screen if already connected in this session
        try {
            const ok = await Storage.loginWithGoogle(null, true); // silent = true
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
        currentUser = Storage.getCurrentUser();
        if (currentUser) {
            loginScreen.classList.add('hidden');
            loadingOverlay.classList.add('hidden');
            appContainer.classList.remove('hidden');
            
            document.getElementById('headerGreetingText').textContent = `Hello, ${currentUser.name.split(' ')[0]}`;
            document.getElementById('headerRoleBadge').textContent = currentUser.role;

            applyRBACToDOM();
            
            currentView = currentUser.role === 'Owner' ? 'dashboard' : 'properties';
            setActiveNav(currentView);
            
            setupAppListeners();
            renderView(currentView);
            populateCitiesDatalist();
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
                    const success = await Storage.loginWithGoogle(role, false);

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
        // Enforce strict element removal based on Role
        const adminElements = document.querySelectorAll('.admin-only');
        if (currentUser.role === 'Buyer') {
            adminElements.forEach(el => el.style.display = 'none');
        } else {
            // Restore for Owners who just logged in
            adminElements.forEach(el => el.style.display = '');
        }
    }


    // --- APP EVENT LISTENERS ---
    // Ensure we only mount these once during user session
    let listenersMounted = false;
    function setupAppListeners() {
        if (listenersMounted) return;
        listenersMounted = true;

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

        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim().toLowerCase();
            if (currentView === 'properties') {
                renderProperties(currentFilterCity, query);
            } else if (query) {
                setActiveNav('properties');
                renderView('properties', query);
                searchInput.focus();
            }
        });

        if(openAddModalBtn) openAddModalBtn.addEventListener('click', () => openModal());
        if(mobileAddBtn) mobileAddBtn.addEventListener('click', () => openModal());
        if(closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
        if(cancelModalBtn) cancelModalBtn.addEventListener('click', closeModal);

        // V11 View Toggles (Using Event Delegation for robust toggle)
        document.body.addEventListener('click', (e) => {
            const mapBtn = e.target.closest('#viewMapBtn');
            const gridBtn = e.target.closest('#viewGridBtn');
            
            if (mapBtn) toggleMapView(true);
            if (gridBtn) toggleMapView(false);
        });

        // V11 Compare Actions
        document.getElementById('clearCompareBtn').addEventListener('click', () => {
            compareList = [];
            updateCompareTray();
        });
        document.getElementById('startCompareBtn').addEventListener('click', renderComparisonTable);
        document.getElementById('closeCompareModal').addEventListener('click', () => {
            document.getElementById('compareModal').classList.remove('active');
        });
        
        // Inquiry Listeners
        const closeInquiryBtn = document.getElementById('closeInquiryBtn');
        const inquiryModal = document.getElementById('inquiryModal');
        const inquiryForm = document.getElementById('inquiryForm');

        if(closeInquiryBtn) closeInquiryBtn.addEventListener('click', () => inquiryModal.classList.remove('active'));
        if(inquiryForm) {
            inquiryForm.addEventListener('submit', (e) => {
                e.preventDefault();
                Storage.addInquiry({
                    propertyId: document.getElementById('inqPropertyId').value,
                    propertyTitle: document.getElementById('inqPropertyTitle').value,
                    ownerId: document.getElementById('inqOwnerId').value,
                    buyerId: currentUser.id,
                    buyerName: currentUser.name,
                    buyerEmail: currentUser.email,
                    buyerPhone: '', // Not provided by basic Google scope
                    message: document.getElementById('inqMessage').value,
                    status: 'Unread'
                });
                inquiryModal.classList.remove('active');
                alert('Success! Your inquiry has been sent to the House Owner.');
            });
        }
        
        propertyModal.addEventListener('click', (e) => {
            if (e.target === propertyModal) closeModal();
        });

        propertyForm.addEventListener('submit', handleFormSubmit);

        propImageFile.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files).slice(0, 5); // Max 5 images
            if (files.length > 0) {
                imagePreviewContainer.innerHTML = '';
                imagePreviewContainer.style.display = 'flex';
                const base64Array = [];
                
                for(let file of files) {
                    const base64Str = await processImageFileAsync(file);
                    base64Array.push(base64Str);
                    const img = document.createElement('img');
                    img.src = base64Str;
                    Object.assign(img.style, { height: '100%', width: '120px', objectFit: 'cover', borderRadius: '4px' });
                    imagePreviewContainer.appendChild(img);
                }
                propImageHidden.value = JSON.stringify(base64Array);
            } else {
                imagePreviewContainer.style.display = 'none';
                propImageHidden.value = '';
            }
        });
    }

    function setActiveNav(view) {
        navItems.forEach(n => n.classList.remove('active'));
        const target = document.querySelector(`[data-view="${view}"]`);
        if (target) target.classList.add('active');
    }

    function processImageFileAsync(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (e) => {
                const img = new Image();
                img.src = e.target.result;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const MAX_WIDTH = 800;
                    let width = img.width;
                    let height = img.height;
                    if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.8));
                };
            };
        });
    }

    // --- Core Rendering Engine ---
    function renderView(viewName, searchQuery = '') {
        currentView = viewName;

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
        if (dashboardChart) { dashboardChart.destroy(); dashboardChart = null; }

        // RBAC View Security Check
        if(currentUser.role === 'Buyer' && (viewName === 'dashboard' || viewName === 'cities' || viewName === 'messages')) {
            renderProperties(); // Fallback secure redirect
            return;
        }

        switch(viewName) {
            case 'dashboard': renderDashboard(); break;
            case 'cities': renderCities(); break;
            case 'messages': renderMessages(); break;
            case 'properties': renderProperties(currentFilterCity, searchQuery); break;
            case 'watchlist': renderWatchlist(); break;
            case 'profile': renderProfile(); break;
            default: renderProperties();
        }
    }

    // --- Views ---
    function renderDashboard() {
        const stats = Storage.getStats();
        // Owners only see their own properties in recent
        let recentProps = Storage.getProperties().filter(p => p.ownerId === currentUser.id).slice(-3).reverse();

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
                <div class="stat-card surface-panel"><div class="stat-icon"><i class="ph ph-tag"></i></div><div class="stat-info"><h4>For Sale</h4><p>${stats.forSale}</p></div></div>
                <div class="stat-card surface-panel"><div class="stat-icon"><i class="ph ph-key"></i></div><div class="stat-info"><h4>For Rent</h4><p>${stats.forRent}</p></div></div>
            </div>

            <div class="chart-container surface-panel">
                <canvas id="cityChart"></canvas>
            </div>

            <div class="section-header"><h3>Recently Added by Me</h3></div>
            <div class="grid-layout">
                ${recentProps.length ? recentProps.map(p => generatePropertyCard(p)).join('') : '<div class="empty-state"><p>No properties found.</p></div>'}
            </div>
        `;

        viewContainer.innerHTML = html;
        attachCardListeners();

        const properties = Storage.getProperties().filter(p => p.ownerId === currentUser.id);
        const cityCounts = {};
        properties.forEach(p => cityCounts[p.city] = (cityCounts[p.city] || 0) + 1);

        const ctx = document.getElementById('cityChart');
        if (ctx) {
            dashboardChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Object.keys(cityCounts),
                    datasets: [{
                        label: 'My Properties per Region',
                        data: Object.values(cityCounts),
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
            });
        }
    }

    function renderCities() {
        const properties = Storage.getProperties();
        const cities = Storage.getCities();
        
        let html = `<div class="section-header"><h2>Service Regions</h2></div><div class="grid-layout">`;

        if (cities.length === 0) {
            html += `<div class="empty-state"><p>No regions active yet. Add a property to begin.</p></div>`;
        } else {
            cities.forEach(city => {
                const count = properties.filter(p => p.city === city).length;
                html += `
                    <div class="city-card surface-panel shadow-hover" data-city="${city}">
                        <i class="ph-duotone ph-buildings"></i>
                        <h3>${city}</h3>
                        <p class="badge" style="background: var(--bg-main);">${count} Global Listings</p>
                    </div>
                `;
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

    function renderWatchlist() {
        let properties = Storage.getProperties();
        const favs = Storage.getFavorites();
        properties = properties.filter(p => favs.includes(p.id));

        let html = `<div class="section-header"><h2>My Watchlist</h2></div><div class="grid-layout">`;

        if (properties.length === 0) {
            html += `<div class="empty-state" style="grid-column: 1 / -1;"><i class="ph-duotone ph-heart-break"></i><p>No favorites saved yet.</p></div>`;
        } else {
            html += properties.map(p => generatePropertyCard(p)).join('');
        }

        html += `</div>`;
        viewContainer.innerHTML = html;
        attachCardListeners();
    }

    function renderProperties(cityFilter = null, searchQuery = '') {
        let properties = Storage.getProperties();

        if (cityFilter) properties = properties.filter(p => p.city === cityFilter);
        if (searchQuery) {
            const lowerQ = searchQuery.toLowerCase();
            properties = properties.filter(p => 
                p.title.toLowerCase().includes(lowerQ) || 
                p.city.toLowerCase().includes(lowerQ) ||
                p.address.toLowerCase().includes(lowerQ)
            );
        }
        if (currentTypeFilter) properties = properties.filter(p => p.type === currentTypeFilter);
        if (currentStatusFilter) properties = properties.filter(p => p.status === currentStatusFilter);

        // Use a shallow copy before sorting to avoid mutating the in-memory cache array
        properties = [...properties];
        if (currentSort === 'price-low') {
            properties.sort((a, b) => a.price - b.price);
        } else if (currentSort === 'price-high') {
            properties.sort((a, b) => b.price - a.price);
        } else {
            properties.reverse(); // Newest first (array is in insertion order)
        }

        let headerText = cityFilter ? `Listings in ${cityFilter}` : 'All Featured Listings';

        let html = `
            <div class="section-header" style="flex-direction: column; align-items: flex-start;">
                <h2>${headerText} 
                    ${cityFilter ? `<button class="btn btn-secondary btn-sm" id="clearCityFilterBtn" style="margin-left: 1rem; padding: 0.25rem 0.75rem;"><i class="ph ph-x"></i> Clear Region</button>` : ''}
                </h2>
                
                <div class="filters-toolbar">
                    <select id="sortSelect">
                        <option value="newest" ${currentSort === 'newest' ? 'selected' : ''}>Sort: Newest First</option>
                        <option value="price-low" ${currentSort === 'price-low' ? 'selected' : ''}>Price: Low to High</option>
                        <option value="price-high" ${currentSort === 'price-high' ? 'selected' : ''}>Price: High to Low</option>
                    </select>
                    <select id="typeSelect">
                        <option value="">Filter: All Types</option>
                        <option value="Sale" ${currentTypeFilter === 'Sale' ? 'selected' : ''}>Sale</option>
                        <option value="Rent" ${currentTypeFilter === 'Rent' ? 'selected' : ''}>Rent</option>
                    </select>
                    <select id="statusSelect">
                        <option value="">Filter: All Status</option>
                        <option value="Available" ${currentStatusFilter === 'Available' ? 'selected' : ''}>Available</option>
                        <option value="Sold" ${currentStatusFilter === 'Sold' ? 'selected' : ''}>Sold</option>
                        <option value="Rented" ${currentStatusFilter === 'Rented' ? 'selected' : ''}>Rented</option>
                    </select>
                </div>
            </div>
            <div id="propertiesGrid" class="grid-layout">
        `;

        if (properties.length === 0) {
            html += `<div class="empty-state" style="grid-column: 1 / -1;"><i class="ph-duotone ph-magnifying-glass"></i><p>No properties found matching criteria.</p></div>`;
        } else {
            html += properties.map(p => generatePropertyCard(p)).join('');
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

        viewContainer.innerHTML = html;

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

        ['sortSelect', 'typeSelect', 'statusSelect'].forEach(id => {
            const el = document.getElementById(id);
            if(el) {
                el.addEventListener('change', (e) => {
                    if(id === 'sortSelect') currentSort = e.target.value;
                    if(id === 'typeSelect') currentTypeFilter = e.target.value;
                    if(id === 'statusSelect') currentStatusFilter = e.target.value;
                    renderView('properties', searchInput.value); 
                });
            }
        });

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
                
                <div style="margin-top: 3rem; width: 100%; max-width: 300px;">
                    <button class="btn btn-secondary w-full shadow-hover" id="logoutBtn" style="border: 1px solid var(--border-color);">
                        <i class="ph ph-sign-out"></i> Switch Account / Logout
                    </button>
                </div>
            </div>
        `;
        
        if (currentUser.role === 'Owner') {
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
             Storage.logout();
             location.reload(); // Hard reload to clear session
        });

        if (document.getElementById('exportDataBtn')) {
            document.getElementById('exportDataBtn').addEventListener('click', () => {
                const dataStr = JSON.stringify(Storage.getData(), null, 2);
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
        const inquiries = Storage.getInquiries().filter(inq => inq.ownerId === currentUser.id).reverse();
        
        let html = `<div class="section-header"><h2>Inbox & Buyer Leads</h2></div>`;
        
        if (inquiries.length === 0) {
            html += `<div class="empty-state"><i class="ph-duotone ph-envelope-open" style="font-size: 4rem; color: #cbd5e1; margin-bottom: 1rem; display: block;"></i><p>No messages yet. Keep publishing great listings to attract buyers!</p></div>`;
        } else {
            html += inquiries.map(inq => `
                <div class="message-card">
                    <div class="message-header">
                        <div class="message-buyer">
                            <div class="avatar">${inq.buyerName.charAt(0)}</div>
                            <div>
                                <h4>${inq.buyerName}</h4>
                                <p>${inq.buyerEmail} &bull; ${inq.buyerPhone}</p>
                            </div>
                        </div>
                        <div class="message-property"><i class="ph-duotone ph-buildings"></i> ${inq.propertyTitle}</div>
                    </div>
                    <div class="message-body">
                        "${inq.message}"
                    </div>
                    <div style="text-align: right; font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">
                        Received: ${new Date(inq.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                </div>
            `).join('');
        }
        viewContainer.innerHTML = html;
    }

    // --- Component Generators ---
    function generatePropertyCard(prop) {
        const isSale = prop.type === 'Sale';
        const badgeClass = isSale ? 'sale' : 'rent';
        
        const favs = Storage.getFavorites();
        const isFav = favs.includes(prop.id);
        const mapHref = `https://maps.google.com/?q=${encodeURIComponent(prop.address + ', ' + prop.city)}`;
        
        const images = (prop.images && prop.images.length > 0) ? prop.images : (prop.image && prop.image.length > 10 ? [prop.image] : ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?q=80&w=800&auto=format&fit=crop']);
            
        // RBAC Context Rendering: Only Owner sees Edit/Delete buttons securely
        const isOwnerOfListing = currentUser.role === 'Owner' && prop.ownerId === currentUser.id;

        const carouselHTML = `
            <div class="image-carousel">
                ${images.map(img => `<div class="carousel-slide"><img src="${img}" alt="${prop.title}" loading="lazy"></div>`).join('')}
            </div>
            ${images.length > 1 ? `
                <div class="carousel-indicators">
                    ${images.map((_, i) => `<div class="carousel-dot ${i===0?'active':''}"></div>`).join('')}
                </div>
            ` : ''}
        `;

        return `
            <div class="property-card">
                <div class="card-img">
                    ${carouselHTML}
                    <div class="badges">
                        <span class="badge ${badgeClass}">${prop.type}</span>
                        <span class="badge" style="background: rgba(44,40,37,0.85); color: white;">${prop.status}</span>
                    </div>
                    <button class="fav-float-btn fav-btn ${isFav ? 'active' : ''}" data-id="${prop.id}" title="Toggle Watchlist">
                        <i class="ph ${isFav ? 'ph-heart-fill' : 'ph-heart'}"></i>
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

                    <div class="card-title">${prop.title}</div>
                    <div class="card-location"><i class="ph ph-map-pin"></i> ${prop.address}, ${prop.city}</div>
                    
                    <div class="card-separator"></div>
                    
                    <div class="card-actions">
                        <button class="btn btn-secondary btn-icon shadow-hover pdf-btn" data-id="${prop.id}" title="Download Flyer">
                            <i class="ph ph-file-pdf"></i>
                        </button>
                        <a href="${mapHref}" target="_blank" class="btn btn-secondary btn-icon shadow-hover" title="View on Map">
                            <i class="ph ph-map-pin-line"></i>
                        </a>
                        ${isOwnerOfListing ? `
                            <button class="btn btn-secondary edit-btn shadow-hover" data-id="${prop.id}" style="flex: 1;">Edit</button>
                            <button class="btn btn-danger btn-icon delete-btn shadow-hover" data-id="${prop.id}" title="Delete Listing"><i class="ph ph-trash"></i></button>
                        ` : `
                            <button class="btn btn-secondary btn-icon shadow-hover compare-btn ${compareList.some(cp=>cp.id===prop.id)?'btn-primary active':''}" data-id="${prop.id}" title="Compare Side-by-Side">
                                <i class="ph ph-intersect"></i>
                            </button>
                            <button class="btn btn-primary shadow-hover contact-btn" data-id="${prop.id}" data-owner="${prop.ownerId}" data-title="${prop.title}" style="flex: 1;" title="Message Owner Securely"><i class="ph ph-envelope-simple"></i> Contact</button>
                        `}
                    </div>
                </div>
            </div>
        `;
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

    function toggleMapView(showMap) {
        if (currentView !== 'properties') return;

        isMapVisible = showMap;
        let grid = document.getElementById('propertiesGrid');
        let mapCont = document.getElementById('mapContainer');
        const gridBtn = document.getElementById('viewGridBtn');
        const mapBtn = document.getElementById('viewMapBtn');

        // If map was toggled before properties were fully rendered, bail out
        if (!grid || !mapCont) return;

        if (showMap) {
            grid.classList.add('hidden');
            mapCont.classList.remove('hidden');
            if (gridBtn) gridBtn.classList.remove('active');
            if (mapBtn) mapBtn.classList.add('active');
            
            // Wait for DOM then init/invalidate
            setTimeout(() => {
                initMap();
                if (map) map.invalidateSize();
                updateMapMarkers();
            }, 100);
        } else {
            grid.classList.remove('hidden');
            mapCont.classList.add('hidden');
            if (gridBtn) gridBtn.classList.add('active');
            if (mapBtn) mapBtn.classList.remove('active');
        }
    }

    function updateMapMarkers() {
        if (!map) return;
        
        // Clear existing
        markers.forEach(m => map.removeLayer(m));
        markers = [];

        const properties = Storage.getProperties();
        const filtered = properties.filter(p => {
            const matchesCity = !currentFilterCity || p.city === currentFilterCity;
            const matchesSearch = !searchInput.value || p.title.toLowerCase().includes(searchInput.value.toLowerCase());
            return matchesCity && matchesSearch;
        });

        const bounds = [];

        filtered.forEach(p => {
            // Jitter coordinates slightly if they land in same city center for prototype
            const base = CITY_COORDS[p.city] || [20, 78];
            const lat = base[0] + (Math.random() - 0.5) * 0.05;
            const lng = base[1] + (Math.random() - 0.5) * 0.05;
            
            const priceStr = p.price >= 10000000 ? (p.price/10000000).toFixed(1) + 'Cr' : (p.price/100000).toFixed(0) + 'L';
            
            const icon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div class="map-price-marker">${priceStr}</div>`,
                iconSize: [60, 30],
                iconAnchor: [30, 30]
            });

            const marker = L.marker([lat, lng], { icon }).addTo(map);
            
            const firstImg = (p.images && p.images.length > 0) ? p.images[0] : (p.image || '');
            const popupContent = `
                <div style="width: 200px; font-family: 'Outfit';">
                    ${firstImg ? `<img src="${firstImg}" style="width:100%; height:100px; object-fit:cover; border-radius:8px; margin-bottom:8px;">` : ''}
                    <h4 style="margin:0; font-size:1rem;">${p.title}</h4>
                    <p style="margin:4px 0; color:var(--primary); font-weight:700;">${currencyFormatter.format(p.price)}</p>
                    <button class="btn btn-primary btn-sm w-full" style="margin-top:8px;" onclick="window.dispatchCardClick('${p.id}')">View Details</button>
                </div>
            `;
            marker.bindPopup(popupContent);
            markers.push(marker);
            bounds.push([lat, lng]);
        });

        if (bounds.length > 0 && !currentFilterCity) {
            map.fitBounds(bounds, { padding: [50, 50] });
        } else if (currentFilterCity) {
            map.setView(CITY_COORDS[currentFilterCity], 12);
        }
    }

    // --- V11 Comparison Logic ---
    function toggleCompare(id) {
        const prop = Storage.getPropertyById(id);
        const index = compareList.findIndex(p => p.id === id);

        if (index === -1) {
            if (compareList.length >= 3) {
                alert("You can compare a maximum of 3 properties side-by-side.");
                return;
            }
            compareList.push(prop);
        } else {
            compareList.splice(index, 1);
        }
        updateCompareTray();
    }

    function updateCompareTray() {
        const tray = document.getElementById('compareTray');
        const count = document.getElementById('compareCount');
        const listTray = document.getElementById('compareListTray');

        count.textContent = compareList.length;

        if (compareList.length > 0) {
            tray.classList.add('active');
            listTray.innerHTML = compareList.map(p => `
                <div class="compare-pill">
                    <span>${p.title.substring(0, 15)}...</span>
                    <i class="ph ph-x-circle" style="cursor:pointer;" onclick="window.toggleCompare('${p.id}')"></i>
                </div>
            `).join('');
        } else {
            tray.classList.remove('active');
        }
    }

    function renderComparisonTable() {
        if (compareList.length < 2) {
            alert("Please select at least 2 properties to compare.");
            return;
        }

        const container = document.getElementById('comparisonTableContainer');
        const modal = document.getElementById('compareModal');

        let html = `<table class="comparison-table"><thead><tr><th>Feature</th>`;
        
        compareList.forEach(p => {
            const firstImg = (p.images && p.images.length > 0) ? p.images[0] : (p.image || '');
            html += `
                <th class="prop-header">
                    ${firstImg ? `<img src="${firstImg}">` : ''}
                    <div style="font-weight:700;">${p.title}</div>
                </th>
            `;
        });
        html += `</tr></thead><tbody>`;

        const rows = [
            { label: 'Price', key: 'price', format: (v) => currencyFormatter.format(v) },
            { label: 'Type', key: 'type' },
            { label: 'Layout', key: 'bhk' },
            { label: 'Area', key: 'area', format: (v) => v + ' sq.ft' },
            { label: 'Status', key: 'status' },
            { label: 'City', key: 'city' }
        ];

        rows.forEach(row => {
            html += `<tr><th>${row.label}</th>`;
            compareList.forEach(p => {
                const val = p[row.key];
                html += `<td>${row.format ? row.format(val) : val}</td>`;
            });
            html += `</tr>`;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;
        modal.classList.add('active');
    }

    // Expose to global for HTML string events
    window.toggleCompare = toggleCompare;
    window.dispatchCardClick = (id) => {
        const view = 'properties'; 
        setActiveNav(view);
        renderView(view, id); // Use ID as search to focus it
    };

    function attachCardListeners() {
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const prop = Storage.getPropertyById(id);
                if (prop) openModal(prop);
            });
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (confirm('Are you sure you want to delete this listing?')) {
                    const success = Storage.deleteProperty(e.currentTarget.getAttribute('data-id'));
                    if(success) {
                        renderView(currentView, searchInput.value); 
                        populateCitiesDatalist(); 
                    } else {
                        alert("Unauthorized Action");
                    }
                }
            });
        });

        document.querySelectorAll('.fav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                Storage.toggleFavorite(id);
                renderView(currentView, searchInput.value);
            });
        });

        document.querySelectorAll('.compare-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                toggleCompare(id);
                // Toggle active class visually immediately
                btn.classList.toggle('active');
                btn.classList.toggle('btn-primary');
            });
        });

        document.querySelectorAll('.pdf-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const prop = Storage.getPropertyById(id);
                if (prop) {
                    const btnIcon = e.currentTarget.querySelector('i');
                    btnIcon.className = 'ph ph-spinner ph-spin'; 
                    await generateFlyer(prop);
                    btnIcon.className = 'ph ph-file-pdf'; 
                }
            });
        });

        document.querySelectorAll('.contact-btn').forEach(btn => {
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
        propertyForm.reset();
        propImageFile.value = '';
        imagePreviewContainer.style.display = 'none';
        propImageHidden.value = '';
        
        if (property) {
            modalTitle.textContent = 'Edit Listing';
            document.getElementById('propId').value = property.id;
            document.getElementById('propTitle').value = property.title;
            document.getElementById('propCity').value = property.city;
            document.getElementById('propPrice').value = property.price;
            document.getElementById('propBhk').value = property.bhk || '2 BHK';
            document.getElementById('propArea').value = property.area || '';
            document.getElementById('propAddress').value = property.address;
            document.getElementById('propType').value = property.type;
            document.getElementById('propStatus').value = property.status;
            
            const imgs = property.images && property.images.length > 0 ? property.images : (property.image ? [property.image] : []);
            if (imgs.length > 0) {
                propImageHidden.value = JSON.stringify(imgs);
                imagePreviewContainer.innerHTML = '';
                imagePreviewContainer.style.display = 'flex';
                imgs.forEach(imgData => {
                    const img = document.createElement('img');
                    img.src = imgData;
                    Object.assign(img.style, { height: '100%', width: '120px', objectFit: 'cover', borderRadius: '4px' });
                    imagePreviewContainer.appendChild(img);
                });
            }
        } else {
            modalTitle.textContent = 'Publish New Listing';
            document.getElementById('propId').value = '';
            document.getElementById('propType').value = 'Sale';
            document.getElementById('propStatus').value = 'Available';
            document.getElementById('propBhk').value = 'Studio';
        }

        // Always scroll modal body back to top so Title + Image fields are visible
        const modalBody = propertyModal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;

        propertyModal.classList.add('active');
    }

    function closeModal() {
        propertyModal.classList.remove('active');
        propertyForm.reset();
    }

    function handleFormSubmit(e) {
        e.preventDefault();
        
        const id = document.getElementById('propId').value;
        const newProperty = {
            id: id || undefined,
            title: document.getElementById('propTitle').value,
            city: document.getElementById('propCity').value,
            price: Number(document.getElementById('propPrice').value),
            bhk: document.getElementById('propBhk').value,
            area: Number(document.getElementById('propArea').value),
            address: document.getElementById('propAddress').value,
            type: document.getElementById('propType').value,
            status: document.getElementById('propStatus').value,
            images: document.getElementById('propImage').value ? JSON.parse(document.getElementById('propImage').value) : []
        };

        if (id) {
            Storage.updateProperty(newProperty);
        } else {
            Storage.addProperty(newProperty);
        }

        closeModal();
        populateCitiesDatalist();
        
        setActiveNav('properties');
        currentFilterCity = null; 
        currentSort = 'newest';
        currentTypeFilter = '';
        currentStatusFilter = '';
        renderView('properties');
    }

    function populateCitiesDatalist() {
        const cities = Storage.getCities();
        citiesListDropdown.innerHTML = cities.map(c => `<option value="${c}">`).join('');
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
        const imgUrl = (prop.images && prop.images.length > 0) ? prop.images[0] : (prop.image && prop.image.length > 10 ? prop.image : '');

        flyerDiv.innerHTML = `
            <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #ea580c; padding-bottom: 20px;">
                <h1 style="color: #ea580c; font-size: 38px; margin: 0; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    ESTATO <span style="color: #7d746d; font-weight: 300;">| PREMIUM LISTING</span>
                </h1>
            </div>
            ${imgUrl ? `<img src="${imgUrl}" style="width: 100%; height: 450px; object-fit: cover; border-radius: 16px; margin-bottom: 30px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1);">` : ''}
            
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
            alert("Error generating PDF flyer.");
        } finally {
            document.body.removeChild(flyerDiv);
        }
    }

});
