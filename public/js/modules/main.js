import { EstatoStorage } from './services/storage.js';
import { escapeHtml, showToast, showConfirm, debounce } from './ui/utils.js';
import { State, updateState } from './core/state.js';
import {
    initMap, destroyMap, updateMapMarkers, toggleMapView, getIsMapVisible,
    initModalMap, updateModalMarker, destroyModalMap, reverseGeocode, CITY_COORDS,
    initDetailsMap
} from './ui/map-engine.js';
import {
    generatePropertyCard as coreGenerateCard, sortProperties, filterByRole, applyFilters,
    getSimilarProperties as coreSimilarProps, PROPERTY_METADATA
} from './ui/property-card.js';
import { renderDashboard as externalRenderDashboard } from './ui/dashboard.js';
import { renderMessages as externalRenderMessages } from './ui/messaging.js';
import { renderAuctions as externalRenderAuctions } from './ui/auctions.js';
import { renderCRM as externalRenderCRM } from './ui/crm.js';
import { initForms } from './ui/forms.js';

/* Estato V12.1 - Production - SEO & Pagination Enabled */
document.addEventListener('DOMContentLoaded', () => {

    // --- State and Cache ---
    let currentUser = null;
    let currentView = 'properties'; // Default fallback
    let currentFilterCity = null;
    let storageSubscribed = false;   // Guard: prevent duplicate EstatoStorage.subscribe() calls across re-auths
    let countdownInterval = null;

    // --- Global Utility Exposure ---
    window.setActiveNav = function(view) {
        const navItems = document.querySelectorAll('.nav-item:not(.title-divider)');
        navItems.forEach(n => n.classList.remove('active'));
        const target = document.querySelector(`[data-view="${view}"]`);
        if (target) target.classList.add('active');
    };

    // Debounce guards: prevent auction functions being called multiple times
    // per second from the 1s timer loop while Firebase write is in-flight.
    const _pendingFinalizations = new Set();
    const _pendingDefaults = new Set();

    let currentSort = 'newest';
    let currentTypeFilter = '';
    let currentStatusFilter = '';
    let currentCategoryFilter = '';

    window.formatEstatoImage = function(url) {
        if (!url || typeof url !== 'string') return url || '';
        // High-performance thumbnail format (Priority)
        if (url.includes('thumbnail?id=')) return url;
        // Standard UC format
        if (url.includes('drive.google.com/uc?id=')) return url;
        // New robust proxy format
        if (url.includes('googleusercontent.com')) return url;
        
        // Legacy drive links cleanup
        if (url.includes('drive.google.com')) {
            const fileId = url.split('id=')[1]?.split('&')[0];
            if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
        }
        return url;
    };

    window.ESTATO_DEFAULT_IMG = 'https://placehold.co/800x600/f1f5f9/64748b?text=No+Image+Available';

    let dashboardCharts = [];

    // V11 States — map instance vars kept here; map-engine.js owns its own private copies
    let map = null;
    let mapLayerGroup = null;
    let markers = [];
    let isMapVisible = false;
    let modalMap = null;
    let modalMarker = null;

    // Radius Search States
    let currentRadiusCenter = null; // {lat, lng}
    let currentRadiusKm = 10;

    // Compare & distance
    let compareList = [];
    let _compareRestored = false;
    let _renderDistanceMap = new Map();

    // --- CRITICAL: Register global stubs early ---
    // These are referenced in dynamically-rendered HTML onclick attributes.
    // They MUST be on window before renderView() is called, which happens in checkAuth() at line ~452.

    function _syncCompareIcons() {
        document.querySelectorAll('.compare-btn').forEach(btn => {
            const btnId = btn.getAttribute('data-id');
            const isSelected = compareList.some(p => p.id === btnId);
            btn.classList.toggle('selected', isSelected);
        });
    }

    window.toggleCompare = function(id, event) {
        if (event) { event.stopPropagation(); event.stopImmediatePropagation(); }
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop) { console.warn('[Compare] Property not found:', id); return; }
        const index = compareList.findIndex(p => p.id === id);
        if (index === -1) {
            if (compareList.length >= 3) {
                showToast('You can compare up to 3 properties at a time.', 'warning');
                return;
            }
            compareList.push(prop);
            showToast(`"${prop.title.substring(0, 25)}" added to compare.`, 'success');
        } else {
            compareList.splice(index, 1);
            showToast(`"${prop.title.substring(0, 25)}" removed from compare.`, 'info');
        }
        _updateCompareTray();
        _syncCompareIcons();
        localStorage.setItem('estato_compare_v1', JSON.stringify(compareList.map(p => p.id)));
    };

    window.clearCompare = function() {
        compareList = [];
        localStorage.setItem('estato_compare_v1', '[]');
        _updateCompareTray();
        _syncCompareIcons();
    };

    window.showToast = showToast;
    window.showConfirm = showConfirm;

    window.viewMyListings = function() {
        if (!currentUser) return;
        currentFilterCity = null;
        currentRadiusCenter = null;
        currentTypeFilter = '';
        currentStatusFilter = '';
        currentCategoryFilter = '';
        
        window.setActiveNav('properties');
        searchInput.value = 'My Listings';
        renderView('properties', 'My Listings');
        window.scrollTo(0, 0);
    };

    window.clearAllFilters = function() {
        currentFilterCity = null;
        currentRadiusCenter = null;
        currentTypeFilter = '';
        currentStatusFilter = '';
        currentCategoryFilter = '';
        currentSort = 'newest';
        
        // Also clear advanced filters if the function is loaded
        if (typeof window.clearAdvancedFilters === 'function') {
            window.clearAdvancedFilters(false);
        }
        
        if (searchInput) searchInput.value = '';
        const radiusLocInput = document.getElementById('radiusLocInput');
        if (radiusLocInput) radiusLocInput.value = '';
        
        renderView('properties');
        showToast('All filters cleared.', 'info');
    };

    // ── Saved Search Alerts ──────────────────────────────────────────────────
    window.toggleSaveSearch = function() {
        const searchQuery    = searchInput ? searchInput.value : '';
        const savedSearches  = JSON.parse(localStorage.getItem('estato_saved_searches') || '[]');
        const key = JSON.stringify({ q: searchQuery || '', city: currentFilterCity || '', type: currentTypeFilter || '' });
        const idx = savedSearches.findIndex(s => s.key === key);
        if (idx > -1) {
            savedSearches.splice(idx, 1);
            localStorage.setItem('estato_saved_searches', JSON.stringify(savedSearches));
            showToast('Search alert removed.', 'info');
        } else {
            const label = [searchQuery, currentFilterCity, currentTypeFilter].filter(Boolean).join(' · ') || 'All Properties';
            // Pre-fill notifiedIds with existing matches so we only alert on NEW properties later
            const existingMatches = EstatoStorage.getProperties().filter(p => p.status === 'Available').filter(p => {
                const text = `${p.title} ${p.city} ${p.address} ${p.pinCode || ''} ${p.description || ''}`.toLowerCase();
                return (!searchQuery || text.includes(searchQuery.toLowerCase()))
                    && (!currentFilterCity || p.city === currentFilterCity)
                    && (!currentTypeFilter || p.type === currentTypeFilter);
            }).map(p => p.id);
            
            savedSearches.push({ key, label, savedAt: Date.now(), notifiedIds: existingMatches });
            localStorage.setItem('estato_saved_searches', JSON.stringify(savedSearches));
            showToast(`🔔 Alert saved for "${label}". You'll be notified when new matches arrive.`, 'success');
        }
        // Re-render to update button state
        renderView('properties', searchInput ? searchInput.value : '');
    };

    function checkSavedSearchAlerts() {
        if (!currentUser) return;
        const savedSearches = JSON.parse(localStorage.getItem('estato_saved_searches') || '[]');
        if (!savedSearches.length) return;
        const allProps = EstatoStorage.getProperties().filter(p => p.status === 'Available');
        let updated = false;
        savedSearches.forEach(ss => {
            const { q, city, type } = JSON.parse(ss.key);
            const matches = allProps.filter(p => {
                const text = `${p.title} ${p.city} ${p.address} ${p.pinCode || ''} ${p.description || ''}`.toLowerCase();
                return (!q || text.includes(q.toLowerCase()))
                    && (!city || p.city === city)
                    && (!type || p.type === type);
            });
            const newMatches = matches.filter(p => !(ss.notifiedIds || []).includes(p.id));
            if (newMatches.length > 0) {
                const msg = `🔔 ${newMatches.length} new match${newMatches.length > 1 ? 'es' : ''} for your saved search "${ss.label}"!`;
                showToast(msg, 'success');
                // Make it persistent in the notification center
                newMatches.forEach(p => {
                    EstatoStorage.addNotification(`Matching property found: ${p.title} in ${p.city}`, 'saved_search_match', { id: p.id });
                });
                ss.notifiedIds = [...(ss.notifiedIds || []), ...newMatches.map(p => p.id)];
                updated = true;
            }
        });
        if (updated) localStorage.setItem('estato_saved_searches', JSON.stringify(savedSearches));
    }

    window.applySavedSearch = function(idx) {
        const searches = JSON.parse(localStorage.getItem('estato_saved_searches') || '[]');
        const s = searches[idx];
        if (!s) return;
        const { q, city, type } = JSON.parse(s.key);
        
        if (searchInput) searchInput.value = q || '';
        currentFilterCity = city || null;
        currentTypeFilter = type || '';
        
        renderView('properties', q || '');
        showToast(`Applied search: ${s.label}`, 'info');
    };

    window.deleteSavedSearch = function(idx) {
        const searches = JSON.parse(localStorage.getItem('estato_saved_searches') || '[]');
        if (idx > -1) {
            searches.splice(idx, 1);
            localStorage.setItem('estato_saved_searches', JSON.stringify(searches));
            showToast('Search alert deleted.', 'info');
            if (currentView === 'dashboard') renderView('dashboard');
        }
    };

    window.clearAllSavedSearches = function() {
        showConfirm('Are you sure you want to delete all saved search alerts?', () => {
            localStorage.removeItem('estato_saved_searches');
            showToast('All search alerts cleared.', 'info');
            if (currentView === 'dashboard') renderView('dashboard');
        });
    };
    // ────────────────────────────────────────────────────────────────────────

    window.renderComparisonTable = function() {
        if (compareList.length < 2) {
            showToast('Please select at least 2 properties to compare.', 'info');
            return;
        }
        const container = document.getElementById('comparisonTableContainer');
        const modal = document.getElementById('compareModal');
        if (!container || !modal) return;

        const currFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
        let html = `<div class="comparison-table-wrapper"><table class="comparison-table"><thead><tr><th>Feature</th>`;
        compareList.forEach(p => {
            const img = window.formatEstatoImage((p.images && p.images.length > 0) ? p.images[0] : (p.image || ''));
            html += `<th class="prop-header">${img ? `<img src="${img}" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">` : ''}<div style="font-weight:700;margin-top:5px;">${p.title}</div></th>`;
        });
        html += `</tr></thead><tbody>`;
        const rows = [
            { label: 'Price',    key: 'price',    icon: 'ph-tag',       format: v => currFmt.format(v), type: 'min' },
            { label: 'Area',     key: 'area',     icon: 'ph-ruler',     format: v => v != null ? Number(v).toLocaleString() + ' sq.ft' : 'N/A', type: 'max' },
            { label: 'Type',     key: 'type',     icon: 'ph-house-line' },
            { label: 'Layout',   key: 'bhk',      icon: 'ph-layout' },
            { label: 'Category', key: 'category', icon: 'ph-bookmarks' },
            { label: 'Status',   key: 'status',   icon: 'ph-info' },
            { label: 'City',     key: 'city',     icon: 'ph-map-pin' }
        ];
        rows.forEach(row => {
            let bestVal = null;
            if (row.type === 'min') bestVal = Math.min(...compareList.map(p => p[row.key]));
            else if (row.type === 'max') bestVal = Math.max(...compareList.map(p => p[row.key]));
            const values = compareList.map(p => String(p[row.key]));
            const hasDiff = new Set(values).size > 1;
            html += `<tr><th style="background:var(--bg-hover);font-weight:600;color:var(--text-muted);"><i class="${row.icon}" style="margin-right:8px;"></i>${row.label}</th>`;
            compareList.forEach(p => {
                const val = p[row.key];
                const isBest = bestVal !== null && val === bestVal && hasDiff;
                const style = isBest ? 'background:rgba(16,185,129,0.1);color:#059669;font-weight:700;' : (hasDiff ? 'background:rgba(234,88,12,0.02);' : '');
                html += `<td style="${style}">${isBest ? '<i class="ph-fill ph-check-circle" style="margin-right:4px;color:#059669;"></i>' : ''}${row.format ? row.format(val) : (val ?? 'N/A')}</td>`;
            });
            html += `</tr>`;
        });
        html += `</tbody></table></div>`;
        container.innerHTML = html;
        modal.classList.add('active');

        // Clear compare state & lights after opening the table
        compareList = [];
        localStorage.setItem('estato_compare_v1', '[]');
        _updateCompareTray();
        _syncCompareIcons();
    };

    function _updateCompareTray() {
        const tray = document.getElementById('compareTray');
        const count = document.getElementById('compareCount');
        const listTray = document.getElementById('compareListTray');
        if (!tray || !count || !listTray) return;
        count.textContent = compareList.length;
        if (compareList.length > 0) {
            tray.classList.add('active');
            listTray.innerHTML = compareList.map(p =>
                `<div style="background:rgba(255,255,255,0.15);padding:0.25rem 0.75rem;border-radius:20px;font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;border:1px solid rgba(255,255,255,0.2);">
                    <span style="white-space:nowrap;">${(p.title || 'Property').substring(0, 20)}</span>
                    <i class="ph ph-x" style="cursor:pointer;color:#ff8080;font-size:0.9rem;" onclick="window.toggleCompare('${p.id}',event)"></i>
                </div>`
            ).join('') + `<button onclick="window.clearCompare()" style="background:rgba(255,255,255,0.1);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:50%;width:28px;height:28px;min-width:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Clear all"><i class="ph ph-trash" style="font-size:0.9rem;pointer-events:none;"></i></button>`;
        } else {
            tray.classList.remove('active');
            listTray.innerHTML = '';
        }
    }


     /**
      * Non-blocking prompt dialog. Replaces native prompt().
      */
    function showPrompt(message, onConfirm, onCancel) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;`;
        
        overlay.innerHTML = `
            <div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:1.5rem;width:90%;max-width:360px;box-shadow:var(--shadow-lg);animation:slideUpFade 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;color:var(--text-main);">
                    <div style="background:var(--bg-hover);padding:0.5rem;border-radius:50%;color:var(--primary);display:flex;">
                        <i class="ph-duotone ph-chat-text" style="font-size:1.5rem;"></i>
                    </div>
                    <h3 style="font-size:1.1rem;font-weight:600;margin:0;">Input Required</h3>
                </div>
                <p style="color:var(--text-muted);font-size:0.95rem;margin-bottom:1rem;">${escapeHtml(message)}</p>
                <textarea id="promptInput" style="width:100%;min-height:80px;padding:0.75rem;border-radius:var(--radius-sm);border:1px solid var(--border-color);background:var(--bg-main);color:var(--text-main);font-family:inherit;margin-bottom:1.5rem;" placeholder="Type here..."></textarea>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                    <button id="promptCancelBtn" class="btn btn-secondary shadow-hover" style="flex:1;">Cancel</button>
                    <button id="promptConfirmBtn" class="btn btn-primary shadow-hover" style="flex:1;">Submit</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        const input = document.getElementById('promptInput');
        if (input) input.focus();
        
        document.getElementById('promptConfirmBtn').addEventListener('click', () => {
            const val = input.value.trim();
            overlay.remove();
            if (onConfirm) onConfirm(val);
        });
        
        document.getElementById('promptCancelBtn').addEventListener('click', () => {
            overlay.remove();
            if (onCancel) onCancel();
        });
    }

    function getHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    // (Removed duplicate resolveLocationToCoords function)

    function getSimilarProperties(property) {
        return coreSimilarProps(property, EstatoStorage.getProperties());
    }

    // --- Utilities (Imported via ES6 Modules) ---

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
        'Commercial': { icon: 'ph-storefront', tags: ['Retail', 'Office', 'High ROI'], avgPriceRange: '₹1Cr - ₹10Cr', color: 'purple' },
        'Other': { icon: 'ph-dots-three', tags: ['Custom', 'Unique'], avgPriceRange: 'Varied', color: 'gray' }
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
        statuses: ['Available', 'Rented', 'Sold'],
        bhkLayouts: ['N/A', 'Studio', '1 BHK', '2 BHK', '3 BHK', '4+ BHK']
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

    let formApi = null;
    setTimeout(() => {
        formApi = initForms({
            currentUser, EstatoStorage, FILTER_CONFIG, propertyForm, propertyModal,
            modalTitle, propImageFile, imagePreviewContainer, propImageHidden,
            renderView, currentView, searchInput, citiesListDropdown
        });
        window.openModal = formApi.openModal;
        window.closeModal = formApi.closeModal;
        window.openBrokerVerification = () => {
            document.getElementById('brokerVerificationModal').classList.add('active');
        };

        const verificationForm = document.getElementById('brokerVerificationForm');
        if (verificationForm) {
            verificationForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const license = document.getElementById('brokerLicense').value;
                const agency = document.getElementById('brokerAgency').value;
                const experience = document.getElementById('brokerExperience').value;
                
                try {
                    const verificationData = {
                        license,
                        agency,
                        experience,
                        status: 'Pending',
                        submittedAt: new Date().toISOString()
                    };
                    
                    await EstatoStorage._syncToCloud(`users/${currentUser.id}/verification`, verificationData, 'set');
                    
                    // Update local state
                    currentUser.verification = verificationData;
                    
                    document.getElementById('brokerVerificationModal').classList.remove('active');
                    showToast('Verification submitted successfully! Our team will review it.', 'success');
                    
                    // Refresh view
                    if (currentView === 'dashboard') renderView('dashboard');
                } catch (err) {
                    showToast('Failed to submit verification.', 'danger');
                }
            });
        }

        propertyForm.addEventListener('submit', formApi.handleFormSubmit);
        formApi.populateCitiesDatalist();
    }, 500);

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

    // Theme Toggle Logic
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const authThemeToggleBtn = document.getElementById('authThemeToggleBtn');
    
    const updateThemeUI = () => {
        const isDark = document.body.classList.contains('dark-mode');
        
        // Sidebar Toggle
        const icon = document.getElementById('themeToggleIcon');
        const text = document.getElementById('themeToggleText');
        if (icon && text) {
            icon.className = isDark ? 'ph ph-sun' : 'ph ph-moon';
            text.textContent = isDark ? 'Light Mode' : 'Dark Mode';
        }
        
        // Auth Overlay Toggle
        const authIcon = document.getElementById('authThemeToggleIcon');
        if (authIcon) {
            authIcon.className = isDark ? 'ph ph-sun' : 'ph ph-moon';
        }
    };
    
    const handleThemeToggle = () => {
        const isDark = document.body.classList.toggle('dark-mode');
        localStorage.setItem('estato_theme', isDark ? 'dark' : 'light');
        updateThemeUI();
    };

    if (themeToggleBtn) themeToggleBtn.addEventListener('click', handleThemeToggle);
    if (authThemeToggleBtn) authThemeToggleBtn.addEventListener('click', handleThemeToggle);
    
    // Initialize UI state
    updateThemeUI();

    // Number Formatter
    const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

    // --- Sync Badge Updater ---
    let _syncErrorTimeout = null;
    function updateSyncBadge(state, msg = '') {
        const badge = syncBadge;
        badge.className = 'sync-badge';
        
        if (_syncErrorTimeout) {
            clearTimeout(_syncErrorTimeout);
            _syncErrorTimeout = null;
        }

        if (state === 'syncing') {
            badge.classList.add('sync-syncing');
            badge.innerHTML = '<i class="ph ph-arrow-clockwise"></i><span>Saving...</span>';
            badge.title = 'Syncing changes to cloud...';
        } else if (state === 'error') {
            badge.classList.add('sync-error');
            badge.innerHTML = '<i class="ph ph-warning"></i><span>Error</span>';
            badge.title = msg ? `Sync Error: ${msg}` : 'A background sync failed. Check console.';
            
            // Auto-clear error after 5 seconds if everything else is fine
            _syncErrorTimeout = setTimeout(() => {
                if (navigator.onLine) updateSyncBadge('synced');
            }, 5000);
        } else if (state === 'offline') {
            badge.classList.add('sync-error');
            badge.innerHTML = '<i class="ph ph-wifi-slash"></i><span>Offline</span>';
            badge.title = 'You are currently offline.';
        } else {
            badge.classList.add('sync-synced');
            badge.innerHTML = '<i class="ph ph-check-circle"></i><span>Synced</span>';
            badge.title = 'All data is synced and up to date.';
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

        // 3. Fallback to API (Nominatim) with Indian context for much better accuracy
        try {
            // Append India if it's not in the string to help OpenStreetMap
            let searchQuery = normalized;
            if (!searchQuery.includes('india')) {
                searchQuery += ', India';
            }
            
            // Use countrycodes=in to restrict results to India
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&countrycodes=in&limit=1`);
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

        // 3. Fallback to Guest Mode instead of login screen
        checkAuth();
    }

    // --- AUTHENTICATION ENGINE ---
    function checkAuth() {
        currentUser = EstatoStorage.getCurrentUser();
        
        if (currentUser) {
            loginScreen.classList.add('hidden');
            loadingOverlay.classList.add('hidden');
            appContainer.classList.remove('hidden');
            // Ensure auth card is visible for next time
            const authCard = loginScreen.querySelector('.auth-card');
            if (authCard) authCard.style.display = 'block';
        } else {
            // Guest / Unauthenticated path
            loginScreen.classList.remove('hidden');
            loadingOverlay.classList.add('hidden');
            appContainer.classList.add('hidden');

            // --- Brochure Deep-Link Mode ---
            if (window.location.pathname.startsWith('/property/')) {
                const propId = window.location.pathname.split('/property/')[1];
                const authCard = loginScreen.querySelector('.auth-card');
                if (authCard) authCard.style.display = 'none';

                // Show a lightweight loading indicator while Firebase fetches the property
                loginScreen.insertAdjacentHTML('beforeend', `
                    <div id="brochureLoadingMsg" style="
                        position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
                        color: white; text-align: center; font-family: inherit; z-index: 9999;">
                        <div style="width:48px;height:48px;border:4px solid rgba(255,255,255,0.3);
                             border-top:4px solid white;border-radius:50%;
                             animation:spin 1s linear infinite;margin:0 auto 1rem;"></div>
                        <p style="margin:0;font-size:1rem;opacity:0.85;">Loading property...</p>
                    </div>`);

                // Load public property data, then open the modal when ready
                EstatoStorage.loadAllData();

                let _guestUnsubscribe = null;
                let _guestOpened = false;

                const _tryOpenGuestProperty = async () => {
                    if (_guestOpened) return;
                    
                    let p = EstatoStorage.getPropertyById(propId);
                    
                    // If not in cache, actively fetch the specific property from Firebase
                    if (!p) {
                        try {
                            const snap = await firebase.database().ref(`properties/${propId}`).once('value');
                            if (snap.exists()) {
                                p = snap.val();
                                p.id = propId; // Ensure ID is attached
                            }
                        } catch (err) {
                            console.error("Direct fetch failed. Firebase rules might block access:", err);
                        }
                    }

                    if (!p) return; // Data not yet loaded or doesn't exist
                    if (!window.openPropertyDetails) return; // Function not yet defined

                    _guestOpened = true;
                    try {
                        window.openPropertyDetails(p, true);
                        const loadMsg = document.getElementById('brochureLoadingMsg');
                        if (loadMsg) loadMsg.remove();
                    } catch (e) {
                        console.error("Brochure error:", e);
                        const loadMsg = document.getElementById('brochureLoadingMsg');
                        if (loadMsg) loadMsg.innerHTML = `<p style="color:red;opacity:0.8;">Error loading property: ${e.message}</p>`;
                    }
                    if (_guestUnsubscribe) _guestUnsubscribe();
                };

                // Subscribe to storage updates (fires when Firebase data arrives)
                EstatoStorage.subscribe(_tryOpenGuestProperty);

                // Poll every 200ms as a safety net for script initialization timing
                const _guestPollInterval = setInterval(() => {
                    _tryOpenGuestProperty();
                    if (_guestOpened) clearInterval(_guestPollInterval);
                }, 200);

                // Timeout after 10s to show an error
                setTimeout(() => {
                    if (!_guestOpened) {
                        clearInterval(_guestPollInterval);
                        const loadMsg = document.getElementById('brochureLoadingMsg');
                        if (loadMsg) loadMsg.innerHTML = `<p style="color:white;opacity:0.8;">Property not found or unavailable.</p><button onclick="location.href='/'" style="margin-top:1rem;padding:0.5rem 1.5rem;border-radius:8px;border:none;background:var(--primary,#ea580c);color:white;cursor:pointer;font-size:1rem;">Go to Estato</button>`;
                    }
                }, 10000);
            } else {
                // Normal login screen for root URL
                const authCard = loginScreen.querySelector('.auth-card');
                if (authCard) authCard.style.display = 'block';
                EstatoStorage.loadAllData();
            }
        }

        if (currentUser) {
            // Global Ban Check
            if (currentUser.isBanned) {
                Swal.fire({
                    icon: 'error',
                    title: 'Account Banned',
                    text: 'Your account has been permanently suspended due to repeated auction defaults (3 strikes).',
                    confirmButtonText: 'Understood',
                    allowOutsideClick: false
                }).then(() => {
                    location.reload();
                });
                return;
            }
            
            const rep = (currentUser.reputation === undefined) ? 5.0 : currentUser.reputation;
            const repFormatted = parseFloat(rep).toFixed(1);
            document.getElementById('headerGreetingText').innerHTML = `Hello, ${currentUser.name.split(' ')[0]} <span style="font-size: 0.85rem; color: #fbbf24; margin-left: 0.5rem; background: rgba(0,0,0,0.05); padding: 0.2rem 0.5rem; border-radius: 20px; border: 1px solid rgba(0,0,0,0.05);"><i class="ph-fill ph-star"></i> ${repFormatted}</span>`;
            document.getElementById('headerRoleBadge').textContent = currentUser.role;
            document.getElementById('walletBadge').style.display = 'flex';
        }

        applyRBACToDOM();
        
        currentView = currentUser ? ((currentUser.role === 'Seller' || currentUser.role === 'Broker' || currentUser.role === 'Admin') ? 'dashboard' : 'properties') : 'properties';
        window.setActiveNav(currentView);
            
            setupAppListeners();
            renderView(currentView);
            renderNotifications();
            if (formApi && typeof formApi.populateCitiesDatalist === 'function') formApi.populateCitiesDatalist();
            // Check for new matching properties against any saved search alerts (delayed so data loads first)
            setTimeout(() => checkSavedSearchAlerts(), 2000);

            // Start Reliable Real-time Countdown Timers
            if (countdownInterval) clearInterval(countdownInterval);
            countdownInterval = setInterval(() => {
                updateAllCountdowns();
            }, 500); // 500ms for better responsiveness
            updateAllCountdowns(); // Initial immediate run

            // Real-time UI Sync — guard ensures we subscribe only once per session
            // even if checkAuth() is called again (e.g. after Drive re-auth).
            // The debounce collapses rapid simultaneous DB events into one render pass.
            if (!storageSubscribed) {
                storageSubscribed = true;
                const _debouncedGlobalUpdate = debounce(() => {
                    console.log("[Estato] Global real-time sync triggered.");
                    
                    // 1. App-wide state sync
                    const updatedUser = EstatoStorage.getCurrentUser();
                    if (updatedUser) {
                        currentUser = updatedUser;
                        updateWalletUI(); // Sync top bar and other global wallet UI
                    }

                    // 2. Component-specific targeted syncs
                    syncActiveBidModal();

                    // 3. View-specific re-renders — skip if any modal is currently open
                    // to prevent the property grid from rebuilding behind the open modal
                    const anyModalOpen = document.querySelector('.modal-overlay.active');
                    if (!anyModalOpen) {
                        if (!_compareRestored && EstatoStorage.getProperties().length > 0) {
                            _compareRestored = true;
                            const savedIds = JSON.parse(localStorage.getItem('estato_compare_v1') || '[]');
                            const restored = savedIds
                                .map(id => EstatoStorage.getPropertyById(id))
                                .filter(Boolean);
                            if (restored.length > 0) {
                                compareList = restored;
                                updateCompareTray();
                            }
                        }
                        
                        renderView(currentView, searchInput ? searchInput.value : '');
                        renderNotifications();
                        updateSidebarBadges();
                        updateSeoMetadata();
                    } else {
                        // Modal is open: only sync badges and notifications, don't rebuild grid
                        renderNotifications();
                        updateSidebarBadges();
                    }
                    
                    // Check for newly matched saved searches after data sync
                    checkSavedSearchAlerts();
                    
                    // History API Routing: Open property if URL path is /property/:id
                    // Guard: Only open if no modal is currently active to prevent constant reloading on sync
                    if (!anyModalOpen && window.location.pathname.startsWith('/property/')) {
                        const pathParts = window.location.pathname.split('/property/');
                        if (pathParts.length > 1 && pathParts[1]) {
                            const p = EstatoStorage.getPropertyById(pathParts[1]);
                            if (p && document.getElementById('propertyDetailsModal')) {
                                window.openPropertyDetails(p, true); // true = skip pushState
                            }
                        }
                    }
                }, 150);
                
                EstatoStorage.subscribe(_debouncedGlobalUpdate);
            }
    }

    function setupAuthListeners() {
        console.log("Attaching Auth Listeners...");
        const loginRoleCardsLocal = document.querySelectorAll('#loginRoleSelector .role-card');
        const googleLoginBtnLocal = document.getElementById('googleLoginBtn');
        const selectedRoleInputLocal = document.getElementById('selectedRole');

        if (loginRoleCardsLocal.length > 0) {
            loginRoleCardsLocal.forEach(card => {
                card.onclick = () => { // Using onclick for better debugging/capture
                    console.log("Role Card Selected:", card.getAttribute('data-role'));
                    loginRoleCardsLocal.forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                    
                    const selected = card.getAttribute('data-role');
                    if (selectedRoleInputLocal) selectedRoleInputLocal.value = selected;
                };
            });
        }

        // Unified Google Login
        if (googleLoginBtnLocal) {
            googleLoginBtnLocal.onclick = async () => {
                const role = selectedRoleInputLocal ? selectedRoleInputLocal.value : 'Seller';

                console.log("Google Login Button Clicked!");
                googleLoginBtnLocal.disabled = true;
                googleLoginBtnLocal.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Authenticating...';

                try {
                    await EstatoStorage.loginWithGoogle(role, false);
                    loadingOverlay.classList.remove('hidden');
                    loginScreen.classList.add('hidden');
                    // Hydration delay for visual feedback of Drive sync
                    setTimeout(() => checkAuth(), 1500);
                } catch (err) {
                    if (loginErrorMsg) {
                        loginErrorMsg.textContent = err.message;
                        loginErrorMsg.classList.add('active');
                        setTimeout(() => loginErrorMsg.classList.remove('active'), 4000);
                    }
                    googleLoginBtnLocal.disabled = false;
                    googleLoginBtnLocal.innerHTML = '<i class="ph ph-google-logo"></i> Sign in with Google';
                }
            };
        }
    }
    
    function applyRBACToDOM() {
        if (!currentUser) return; // Guard: auth may not have resolved yet
        const adminElements = document.querySelectorAll('.admin-only');
        const role = currentUser.role;

        if (role === 'Buyer') {
            adminElements.forEach(el => {
                if (el.getAttribute('data-view') === 'messages') el.style.display = 'flex'; // Buyers always see messages
                else el.style.display = 'none';
            });
        } else if (role === 'Seller') {
            adminElements.forEach(el => {
                const view = el.getAttribute('data-view');
                if (view === 'audit-logs' || view === 'crm') el.style.display = 'none';
                else el.style.display = 'flex';
            });
        } else if (role === 'Broker') {
            adminElements.forEach(el => {
                if (el.getAttribute('data-view') === 'audit-logs') el.style.display = 'none';
                else el.style.display = 'flex';
            });
        } else if (role === 'Admin') {
            adminElements.forEach(el => el.style.display = 'flex');
        }
    }


    function updateSidebarBadges() {
        if (!currentUser) return;
        const count = EstatoStorage.getInquiries((currentUser.role === 'Seller' || currentUser.role === 'Broker' || currentUser.role === 'Admin') ? currentUser.id : null)
            .filter(inq => inq.status === 'Unread')
            .length;

        const badge = document.getElementById('msgBadge');
        if (badge) {
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
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
                }
                window.setActiveNav(view);
                renderView(view);
            });
        });

        const debouncedSearch = debounce((query) => {
            if (currentView === 'properties') {
                renderProperties(currentFilterCity, query);
            } else if (query) {
                window.setActiveNav('properties');
                renderView('properties', query);
                searchInput.focus();
            }
        }, 300);

        searchInput.addEventListener('input', (e) => {
            debouncedSearch(e.target.value.trim().toLowerCase());
        });

        if(openAddModalBtn) openAddModalBtn.addEventListener('click', () => window.openModal());
        if(mobileAddBtn) mobileAddBtn.addEventListener('click', () => window.openModal());
        if(closeModalBtn) closeModalBtn.addEventListener('click', window.closeModal);
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

        // History API Listener for Back/Forward navigation
        window.addEventListener('popstate', (e) => {
            if (window.location.pathname === '/' || window.location.pathname === '') {
                document.getElementById('propertyDetailsModal').classList.remove('active');
            } else if (window.location.pathname.startsWith('/property/')) {
                const pid = window.location.pathname.split('/property/')[1];
                if (pid) {
                    const p = EstatoStorage.getPropertyById(pid);
                    if (p) window.openPropertyDetails(p, true);
                }
            }
        });



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
                const submitBtn = replyForm.querySelector('[type="submit"]');
                const origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
                
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Saving...';
                }

                // Safety timeout to prevent permanent hang
                const timeoutId = setTimeout(() => {
                    if (submitBtn && submitBtn.disabled) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = origBtnHtml;
                        showToast("Message send timed out. Please check your connection.", "error");
                    }
                }, 10000);

                try {
                    await EstatoStorage.addInquiryReply(inqId, {
                        senderId: currentUser.id,
                        senderName: currentUser.name,
                        senderRole: currentUser.role,
                        message: msg
                    });
                    
                    clearTimeout(timeoutId);
                    replyModal.classList.remove('active');
                    replyForm.reset();
                    showToast("Reply sent successfully.");
                } catch (err) {
                    clearTimeout(timeoutId);
                    console.error("[Inquiry] Reply failed:", err);
                    showToast(err.message || 'Failed to send reply.', 'danger');
                } finally {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = origBtnHtml;
                    }
                }
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
                
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Sending...';
                }

                // Safety timeout
                const timeoutId = setTimeout(() => {
                    if (submitBtn && submitBtn.disabled) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = origBtnHtml;
                        showToast("Inquiry timed out. Please check your connection.", "error");
                    }
                }, 10000);

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

                    clearTimeout(timeoutId);

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
                    clearTimeout(timeoutId);
                    showToast(err.message, 'warning', 6000);
                } finally {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = origBtnHtml;
                    }
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
            reviewForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const propId = document.getElementById('revPropertyId').value;
                const rating = revRating.value;
                const comment = document.getElementById('revComment').value;

                try {
                    await EstatoStorage.addReview(propId, rating, comment);
                    // Refresh the review list in the modal
                    renderReviews(propId);
                    reviewForm.reset();
                    // Reset Stars to 5
                    starInput.querySelectorAll('i').forEach(s => { s.classList.add('ph-fill'); s.classList.remove('ph'); });
                    revRating.value = 5;
                    showToast('Review submitted! Thank you.', 'success');
                } catch (err) {
                    showToast(err.message, 'warning');
                }
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

        function dataURLtoFile(dataurl, filename) {
            let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
                bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
            while(n--) u8arr[n] = bstr.charCodeAt(n);
            return new File([u8arr], filename, {type:mime});
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
            if (!propImageHidden) return;
            try { if (propImageHidden.value) links = JSON.parse(propImageHidden.value); } catch(e) { console.error("Preview parse error", e); }
            
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
            
            const processFiles = async () => {
                try {
                    for(let file of files) {
                        // Extreme compression for Safe-Mode (600px, 0.5 quality)
                        // This keeps the file size ~30KB, allowing multiple images in the database.
                        const compressedBase64 = await compressImage(file, 600, 0.5);
                        
                        existingLinks.push(compressedBase64);
                        propImageHidden.value = JSON.stringify(existingLinks);
                        window.renderImagePreviews();
                        showToast(`Processed ${file.name}`, 'info');
                    }
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Save Property'; }
                    showToast('Images ready for saving.', 'success');
                } catch(error) {
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Save Property'; }
                    showToast('Processing failed: ' + error.message, 'danger');
                }
            };
            
            await processFiles();
            propImageFile.value = '';
        });

        // ── Location: Use My GPS Position ──
        const useMyLocationBtn = document.getElementById('useMyLocationBtn');
        if (useMyLocationBtn) {
            useMyLocationBtn.addEventListener('click', () => {
                if (!navigator.geolocation) {
                    showToast('Geolocation is not supported by your browser.', 'warning');
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
                        showToast('Unable to retrieve location: ' + err.message + ' — Ensure location permission is allowed for this page.', 'warning');
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
                    showToast("Shortened URLs (goo.gl) hide coordinates. Type the place name and click Search instead.", 'info');
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
        if (currentUser) {
            const role = currentUser.role;
            if (role === 'Buyer' && (viewName === 'dashboard' || viewName === 'cities' || viewName === 'crm')) {
                renderProperties(); 
                return;
            }
            if (role === 'Seller' && viewName === 'crm') {
                renderDashboard();
                return;
            }
        }

        switch(viewName) {
            case 'dashboard': renderDashboard(); break;
            case 'cities': renderCities(); break;
            case 'messages': renderMessages(); break;
            case 'crm': externalRenderCRM(viewContainer); break;
            case 'properties': renderProperties(currentFilterCity, searchQuery); break;
            case 'watchlist': renderSavedProperties(); break;
            case 'auctions': renderAuctions(); break;
            case 'profile': renderProfile(); break;
            case 'audit-logs': renderAuditLogs(); break;
            default: renderProperties();
        }
    }

    // --- Admin Audit Logs View ---
    async function renderAuditLogs() {
        if (!currentUser || currentUser.role !== 'Admin') {
            showToast("Access Denied", "error");
            renderProperties();
            return;
        }

        viewContainer.innerHTML = `
            <div class="section-header" style="margin-bottom: 2rem;">
                <h2>System Audit Logs</h2>
                <p>Track all critical system and bidding events.</p>
            </div>
            <div style="text-align: center; padding: 3rem; color: var(--text-light);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 1rem;"></i>
                <p>Loading audit logs...</p>
            </div>
        `;

        try {
            let token = 'mock-token-' + currentUser.id;
            if (window.firebase && firebase.auth().currentUser) {
                try {
                    token = await firebase.auth().currentUser.getIdToken();
                } catch(e) {}
            }
            const res = await fetch('/api/audit', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Failed to fetch');

            if (data.length === 0) {
                viewContainer.innerHTML = `
                    <div class="section-header" style="margin-bottom: 2rem;">
                        <h2>System Audit Logs</h2>
                        <p>Track all critical system and bidding events.</p>
                    </div>
                    <div class="empty-state">
                        <i class="fa-solid fa-clipboard-list"></i>
                        <h3>No Audit Logs Found</h3>
                        <p>There are no recorded events yet.</p>
                    </div>
                `;
                return;
            }

            let logsHtml = data.map(log => {
                const date = new Date(log.timestamp).toLocaleString();
                return `
                    <div style="background: var(--bg-surface); padding: 1.5rem; border-radius: var(--radius-md); margin-bottom: 1rem; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 0.5rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 600; color: var(--primary-color); font-size: 1.1rem;">${log.action}</span>
                            <span style="font-size: 0.85rem; color: var(--text-light);"><i class="fa-regular fa-clock"></i> ${date}</span>
                        </div>
                        <p style="color: var(--text-main); font-size: 0.95rem;">${log.details}</p>
                        <div style="font-size: 0.85rem; color: var(--text-light); background: var(--bg-main); padding: 0.75rem; border-radius: var(--radius-sm); font-family: monospace;">
                            <strong>User:</strong> ${log.userEmail} (${log.userId})<br>
                            ${log.metadata ? `<strong>Metadata:</strong> ${JSON.stringify(log.metadata)}` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            viewContainer.innerHTML = `
                <div class="section-header" style="margin-bottom: 2rem;">
                    <h2>System Audit Logs</h2>
                    <p>Track all critical system and bidding events.</p>
                </div>
                <div class="audit-logs-container">
                    ${logsHtml}
                </div>
            `;
        } catch (err) {
            console.error("[Audit Logs]", err);
            viewContainer.innerHTML = `
                <div class="section-header" style="margin-bottom: 2rem;">
                    <h2>System Audit Logs</h2>
                </div>
                <div class="empty-state">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #ef4444;"></i>
                    <h3>Error Loading Logs</h3>
                    <p>${err.message}</p>
                </div>
            `;
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
        const viewContainer = document.getElementById('viewContainer');
        externalRenderDashboard({
            currentUser, EstatoStorage, viewContainer, dashboardCharts, currencyFormatter,
            generatePropertyCard, Chart: window.Chart, attachCardListeners,
            seedDummyData: window.seedDummyData, exportBackup, handleRestore, renderAdminActivityFeed
        });
    }
    function renderAuctions() {
        const viewContainer = document.getElementById('viewContainer');
        externalRenderAuctions({
            currentUser, EstatoStorage, viewContainer, attachCardListeners,
            generatePropertyCard
        });
    }
    function renderCities() {
        const properties = EstatoStorage.getProperties();
        
        // Dynamically derive city list from actual properties + defaults
        const defaultCities = EstatoStorage.getCities() || [];
        const activeCities = [...new Set(properties.map(p => p.city))].filter(Boolean);
        const allUniqueCities = [...new Set([...defaultCities, ...activeCities])].sort();
        
        let html = `<div class="section-header"><h2>Service Regions</h2><p>Overview of active property markets.</p></div><div class="grid-layout">`;

        if (allUniqueCities.length === 0) {
            html += `<div class="empty-state"><p>No regions active yet. Add a property to begin.</p></div>`;
        } else {
            allUniqueCities.forEach(city => {
                const cityProps = properties.filter(p => p.city === city);
                const globalCount = cityProps.length;
                const myCount = cityProps.filter(p => p.ownerId === currentUser.id).length;
                
                // Visible if Admin, OR if there's at least one listing globally
                if (currentUser.role === 'Admin' || currentUser.role === 'Broker' || globalCount > 0) {
                    html += `
                        <div class="city-card surface-panel shadow-hover" data-city="${city}" style="position: relative; overflow: hidden;">
                            <div style="position: absolute; top: 10px; right: 10px; opacity: 0.1; font-size: 3rem; transform: rotate(-15deg);">
                                <i class="ph ph-map-pin"></i>
                            </div>
                            <h3 style="margin-bottom: 0.5rem; color: var(--primary);">${city}</h3>
                            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                                <span class="badge" style="background: var(--bg-hover); color: var(--text-main); font-size: 0.75rem;">
                                    ${globalCount} Market Total
                                </span>
                                ${myCount > 0 ? `
                                    <span class="badge" style="background: var(--primary-light); color: var(--primary); font-size: 0.75rem; border: 1px solid var(--primary);">
                                        ${myCount} My Listings
                                    </span>
                                ` : ''}
                            </div>
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
                window.setActiveNav('properties');
                renderView('properties');
            });
        });
    }

    window.verifyPropertyListing = async (id, event) => {
        if (event) event.stopPropagation();
        try {
            const success = await EstatoStorage.verifyProperty(id);
            if (success) {
                showToast('Property verified successfully!', 'success');
                // The modal content will re-render if we reopen it, 
                // but since data synced, closing it is safest.
                document.getElementById('propertyDetailsModal').classList.remove('active');
            }
        } catch (err) {
            showToast(err.message, 'danger');
        }
    };

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

    let advancedFilters = { amenities: [], priceMin: null, priceMax: null };

    window.applyAdvancedFilters = () => {
        advancedFilters.amenities = Array.from(document.querySelectorAll('.filter-amenity:checked')).map(cb => cb.value);
        advancedFilters.priceMin = document.getElementById('filterPriceMin').value ? Number(document.getElementById('filterPriceMin').value) : null;
        advancedFilters.priceMax = document.getElementById('filterPriceMax').value ? Number(document.getElementById('filterPriceMax').value) : null;
        renderView('properties', searchInput.value);
    };

    window.clearAdvancedFilters = (doRender = true) => {
        document.querySelectorAll('.filter-amenity').forEach(cb => cb.checked = false);
        const minInput = document.getElementById('filterPriceMin');
        const maxInput = document.getElementById('filterPriceMax');
        if (minInput) minInput.value = '';
        if (maxInput) maxInput.value = '';
        advancedFilters = { amenities: [], priceMin: null, priceMax: null };
        if (doRender) renderView('properties', searchInput ? searchInput.value : '');
    };

    function renderProperties(cityFilter = null, searchQuery = '') {
        let properties = EstatoStorage.getProperties();

        // RBAC Filtering (Fraud Prevention Sandbox)
        if (!currentUser) return; // Guard: wait for auth to complete before rendering
        if (currentUser.role === 'Buyer') {
            properties = properties.filter(p => p.status !== 'Pending');
        } else if (currentUser.role === 'Seller' || currentUser.role === 'Broker') {
            properties = properties.filter(p => p.status !== 'Pending' || p.ownerId === currentUser.id);
        }
        // Admin sees all, including all Pending listings

        if (cityFilter) properties = properties.filter(p => p.city === cityFilter);
        
        if (searchQuery) {
            const queryLower = searchQuery.toLowerCase();
            if (queryLower === 'my listings' && currentUser) {
                properties = properties.filter(p => p.ownerId === currentUser.id);
            } else {
                const keywords = queryLower.split(/\s+/).filter(x => x);
                properties = properties.filter(p => {
                    const combinedText = `${p.id} ${p.ownerId || ''} ${p.title} ${p.city} ${p.address} ${p.pinCode || ''} ${p.projectName || ''} ${p.description || ''} ${p.bhk || ''}`.toLowerCase();
                    // Smart Match: All keywords must be present in the combined text (Logical AND)
                    return keywords.every(kw => combinedText.includes(kw));
                });
            }
        }
        
        // Advanced Filters
        if (advancedFilters.priceMin !== null) properties = properties.filter(p => p.price >= advancedFilters.priceMin);
        if (advancedFilters.priceMax !== null) properties = properties.filter(p => p.price <= advancedFilters.priceMax);
        if (advancedFilters.amenities && advancedFilters.amenities.length > 0) {
            properties = properties.filter(p => {
                if (!p.amenities) return false;
                return advancedFilters.amenities.every(amenity => p.amenities.includes(amenity));
            });
        }
        
        if (currentTypeFilter) {
            if (currentTypeFilter === 'Auction') {
                properties = properties.filter(p => p.bidding && p.bidding.enabled);
            } else {
                properties = properties.filter(p => p.type === currentTypeFilter);
            }
        }
        if (currentStatusFilter) properties = properties.filter(p => p.status === currentStatusFilter);
        if (currentCategoryFilter) properties = properties.filter(p => p.category === currentCategoryFilter);
 
        // Radius Filtering
        if (currentRadiusCenter) {
            // _renderDistanceMap holds km distances per property for this render pass.
            // We intentionally do NOT write to the property object (p._distanceKm) because
            // the same object lives in _memCache.properties and would contaminate Firebase writes.
            _renderDistanceMap.clear();
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
                _renderDistanceMap.set(p.id, dCache.get(key)); // Isolated from cache object
                return _renderDistanceMap.get(p.id) <= currentRadiusKm;
            });
        }

        // Use a shallow copy before sorting to avoid mutating the in-memory cache array
        properties = [...properties];
        if (currentRadiusCenter) {
            // Priority sort by proximity if radius active
            properties.sort((a, b) => (_renderDistanceMap.get(a.id) || 0) - (_renderDistanceMap.get(b.id) || 0));
        } else if (currentSort === 'price-low') {
            properties.sort((a, b) => a.price - b.price);
        } else if (currentSort === 'price-high') {
            properties.sort((a, b) => b.price - a.price);
        } else if (currentSort === 'oldest') {
            // Oldest first — parse the timestamp portion of the ID as a Number to avoid
            // localeCompare string collation bugs if the ID format ever changes.
            properties.sort((a, b) => {
                const idA = Number(a.id ? a.id.replace('prop_', '') : 0);
                const idB = Number(b.id ? b.id.replace('prop_', '') : 0);
                return idA - idB; // Ascending
            });
        } else {
            // Newest first (default)
            properties.sort((a, b) => {
                const idA = Number(a.id ? a.id.replace('prop_', '') : 0);
                const idB = Number(b.id ? b.id.replace('prop_', '') : 0);
                return idB - idA; // Descending
            });
        }

        let headerText = cityFilter ? `Listings in ${cityFilter}` : 'All Featured Listings';
        if (searchQuery && searchQuery !== 'My Listings') headerText = `Results for "${searchQuery}"`;

        // Saved Search: show banner when an active search/filter exists
        const hasActiveSearch = !!(searchQuery || cityFilter || currentTypeFilter);
        const savedSearches = JSON.parse(localStorage.getItem('estato_saved_searches') || '[]');
        const currentSearchKey = JSON.stringify({ q: searchQuery || '', city: cityFilter || '', type: currentTypeFilter || '' });
        const alreadySaved = savedSearches.some(s => s.key === currentSearchKey);

        let html = `
            ${(!cityFilter && !searchQuery && !currentRadiusCenter && !currentTypeFilter && !currentStatusFilter && !currentCategoryFilter) ? renderRecentlyViewed() : ''}
            <div class="section-header" style="flex-direction: column; align-items: flex-start;">
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:0.5rem;">
                    <h2 style="margin:0;">${headerText}
                        ${cityFilter ? `<button class="btn btn-secondary btn-sm" id="clearCityFilterBtn" style="margin-left: 1rem; padding: 0.25rem 0.75rem;"><i class="ph ph-x"></i> Clear Region</button>` : ''}
                    </h2>
                    ${hasActiveSearch && currentUser ? `
                    <button id="saveSearchBtn" class="btn btn-sm shadow-hover" style="background:${alreadySaved ? 'var(--bg-hover)' : 'var(--primary)'}; color:${alreadySaved ? 'var(--text-muted)' : 'white'}; font-size:0.8rem; white-space:nowrap;" onclick="window.toggleSaveSearch()">
                        <i class="ph ph-${alreadySaved ? 'bell-slash' : 'bell'}"></i>
                        ${alreadySaved ? 'Remove Alert' : 'Save Search & Get Alerts'}
                    </button>` : ''}
                </div>
                <div class="filters-toolbar">
                    <select id="sortSelect">
                        ${FILTER_CONFIG.sortOptions.map(opt => `<option value="${opt.value}" ${currentSort === opt.value ? 'selected' : ''}>Sort: ${opt.label}</option>`).join('')}
                    </select>
                    <select id="typeSelect">
                        <option value="">Filter: All Types</option>
                        ${FILTER_CONFIG.types.map(t => `<option value="${t}" ${currentTypeFilter === t ? 'selected' : ''}>${t}</option>`).join('')}
                        <option value="Auction" ${currentTypeFilter === 'Auction' ? 'selected' : ''}>Auctions</option>
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
            html += `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 4rem 2rem;">
                    <i class="ph-duotone ph-magnifying-glass" style="font-size: 4rem; color: var(--text-muted); opacity: 0.5;"></i>
                    <h3 style="margin-top: 1.5rem; font-weight: 600;">No properties found</h3>
                    <p style="color: var(--text-muted); margin-bottom: 2rem;">Try adjusting your filters or location to find more results.</p>
                    <button class="btn btn-primary shadow-hover" onclick="window.clearAllFilters()">
                        <i class="ph ph-arrow-counter-clockwise"></i> Clear All Filters
                    </button>
                </div>
            `;
        } else {
            html += properties.map((p, i) => generatePropertyCard(p, i, (currentRadiusCenter && _renderDistanceMap.has(p.id)) ? _renderDistanceMap.get(p.id) : null)).join('');
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
        initBiddingOrchestration();
    }


    // ── Bidding & Wallet Orchestration ──
    function initBiddingOrchestration() {
        // 6. View Full History Interaction
        window.viewFullHistory = (propId) => {
            const prop = EstatoStorage.getPropertyById(propId);
            if (!prop) return;
            const bids = EstatoStorage.getBidsByProperty(propId);
            if (bids.length === 0) return;

            const list = document.getElementById('fullBidHistoryList');
            const modal = document.getElementById('bidHistoryModal');
            
            if (list && modal) {
                list.innerHTML = bids.slice().reverse().map(bid => `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem; background: var(--bg-main); border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <div style="width: 32px; height: 32px; border-radius: 50%; background: var(--primary); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem;">
                                ${bid.userName.charAt(0)}
                            </div>
                            <div>
                                <div style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(bid.userName)}</div>
                                <div style="font-size: 0.75rem; color: var(--text-muted);">${new Date(bid.timestamp).toLocaleString()}</div>
                            </div>
                        </div>
                        <div style="font-weight: 700; color: var(--text-main);">${currencyFormatter.format(bid.amount)}</div>
                    </div>
                `).join('');
                
                modal.classList.add('active');
            }
        };

        // 1. Global UI Sync (Initial)
        updateWalletUI();

        // 3. Start Global Countdown Manager
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(updateAllCountdowns, 1000);

        // 4. Global Modal Events
        const payFeeBtn = document.getElementById('payFeeBtn');
        if (payFeeBtn) {
            payFeeBtn.onclick = async () => {
                const propId = document.getElementById('bidPropertyId').value;
                payFeeBtn.disabled = true;
                payFeeBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Processing...';
                try {
                    await EstatoStorage.payEntryFee(propId);
                    showToast('Entry fee paid! You can now place bids.', 'success');
                    window.openBidModal(propId); // Refresh modal state
                } catch (e) {
                    showToast(e.message, 'danger');
                    payFeeBtn.disabled = false;
                    payFeeBtn.innerHTML = '<i class="ph ph-credit-card"></i> Pay Entry Fee & Join';
                }
            };
        }

        const bidForm = document.getElementById('bidForm');
        if (bidForm) {
            bidForm.onsubmit = async (e) => {
                e.preventDefault();
                const propId = document.getElementById('bidPropertyId').value;
                const amount = document.getElementById('bidAmountInput').value;
                const submitBtn = bidForm.querySelector('button[type="submit"]');
                
                try {
                    // Pre-validation for instant feedback
                    EstatoStorage.validateBid(propId, amount);

                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Placing Bid...';
                    
                    await EstatoStorage.placeBid(propId, amount);
                    showToast('Bid placed successfully!', 'success');
                    document.getElementById('bidModal').classList.remove('active');
                } catch (err) {
                    showToast(err.message, 'danger');
                } finally {
                    // Always reset button so user can bid again without reload
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="ph ph-gavel"></i> Confirm Bid';
                }
            };
        }

        // Wallet button listeners are now handled via global event delegation

    }

    function updateWalletUI() {
        const walletValue = document.getElementById('walletValue');
        const walletBalanceDisplay = document.getElementById('walletBalanceDisplay');
        const balance = EstatoStorage.getWalletBalance();
        const formatted = currencyFormatter.format(balance);
        
        if (walletValue) walletValue.textContent = formatted;
        if (walletBalanceDisplay) walletBalanceDisplay.textContent = formatted;
    }

    window.openWalletModal = () => {
        updateWalletUI();
        // Always open on Top-up tab by default
        window.switchWalletTab('topup');
        document.getElementById('walletModal').classList.add('active');
    };

    window.switchWalletTab = (tab) => {
        const panels = { topup: 'walletPanelTopup', history: 'walletPanelHistory' };
        const tabs   = { topup: 'walletTabTopup',   history: 'walletTabHistory'   };
        Object.keys(panels).forEach(key => {
            const panel = document.getElementById(panels[key]);
            const btn   = document.getElementById(tabs[key]);
            if (!panel || !btn) return;
            const active = key === tab;
            panel.style.display = active ? '' : 'none';
            btn.style.color = active ? 'var(--primary)' : 'var(--text-muted)';
            btn.style.borderBottom = active ? '3px solid var(--primary)' : '3px solid transparent';
        });
        if (tab === 'history') window.loadWalletTransactions();
    };

    window.loadWalletTransactions = async () => {
        const list  = document.getElementById('walletTransactionList');
        const badge = document.getElementById('txCountBadge');
        if (!list) return;

        list.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1.5rem 0;font-size:0.85rem;"><i class="ph ph-spinner ph-spin"></i> Loading...</p>`;

        try {
            const txs = await EstatoStorage.getWalletTransactions();
            if (badge) badge.textContent = `${txs.length} record${txs.length !== 1 ? 's' : ''}`;

            if (txs.length === 0) {
                list.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem 0;font-size:0.85rem;"><i class="ph ph-clock-clockwise" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No transactions yet.</p>`;
                return;
            }

            const typeConfig = {
                'DEPOSIT':          { label: 'Wallet Top-up',      icon: 'ph-arrow-circle-down',  color: '#16a34a' },
                'BID_PLACED':       { label: 'Bid Placed',          icon: 'ph-gavel',              color: '#dc2626' },
                'BID_REFUND':       { label: 'Outbid Refund',       icon: 'ph-arrow-circle-up',    color: '#16a34a' },
                'ENTRY_FEE':        { label: 'Auction Entry Fee',   icon: 'ph-ticket',             color: '#dc2626' },
                'ENTRY_FEE_REFUND': { label: 'Entry Fee Refund',    icon: 'ph-arrow-circle-up',    color: '#16a34a' },
                'SALE_PAYOUT':      { label: 'Sale Payout',         icon: 'ph-currency-inr',       color: '#16a34a' },
                'COMMISSION':       { label: 'Broker Commission',   icon: 'ph-handshake',          color: '#16a34a' },
            };

            list.innerHTML = txs.map(tx => {
                const cfg      = typeConfig[tx.type] || { label: tx.type, icon: 'ph-swap', color: '#6b7280' };
                const isCredit = tx.direction === 'credit' || Number(tx.amount) > 0;
                const absAmt   = Math.abs(tx.amount);
                const amtStr   = currencyFormatter.format(absAmt);
                const dateStr  = new Date(tx.timestamp).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
                return `
                    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;border-radius:var(--radius-sm);background:var(--bg-hover);border:1px solid var(--border-color);">
                        <div style="width:36px;height:36px;border-radius:50%;background:${isCredit ? '#dcfce7' : '#fee2e2'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="ph-fill ${cfg.icon}" style="color:${cfg.color};font-size:1rem;"></i>
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${cfg.label}</div>
                            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(tx.description || '')}">${escapeHtml(tx.description || '')}</div>
                        </div>
                        <div style="text-align:right;flex-shrink:0;">
                            <div style="font-weight:700;font-size:0.9rem;color:${isCredit ? '#16a34a' : '#dc2626'};">${isCredit ? '+' : '-'}${amtStr}</div>
                            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:1px;">${dateStr}</div>
                        </div>
                    </div>`;
            }).join('');
        } catch (err) {
            list.innerHTML = `<p style="text-align:center;color:var(--danger);padding:1rem 0;font-size:0.85rem;">Failed to load transactions.</p>`;
        }
    };


    // --- Global Wallet Event Delegation ---
    document.body.addEventListener('click', async (e) => {
        // Preset Add Funds Buttons
        const presetBtn = e.target.closest('.add-funds-btn');
        if (presetBtn) {
            const amount = presetBtn.getAttribute('data-amount');
            try {
                await EstatoStorage.addFunds(amount);
                showToast(`₹${Number(amount).toLocaleString()} added to your wallet!`, 'success');
            } catch (err) {
                showToast('Failed to add funds.', 'danger');
            }
            return;
        }

        // Custom Add Funds Button
        const customBtn = e.target.closest('#addCustomFundsBtn');
        if (customBtn) {
            const customAmountInput = document.getElementById('customAmountInput');
            const amount = parseInt(customAmountInput.value);
            if (isNaN(amount) || amount <= 0 || amount % 1000 !== 0) {
                showToast('Please enter a valid amount (multiple of ₹1,000).', 'warning');
                return;
            }
            customBtn.disabled = true;
            customBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Processing...';
            try {
                await EstatoStorage.addFunds(amount);
                showToast(`₹${amount.toLocaleString()} added to your wallet!`, 'success');
                customAmountInput.value = '';
            } catch (err) {
                showToast('Failed to add funds.', 'danger');
            } finally {
                customBtn.disabled = false;
                customBtn.innerHTML = 'Add Funds';
            }
        }
    });

    window.openBidModal = (id) => {
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop || !prop.bidding || (!prop.bidding.enabled && !prop.bidding.finalized)) return;

        document.getElementById('bidPropertyId').value = id;
        document.getElementById('bidPropTitle').textContent = prop.title;
        
        const currentHighest = Number(prop.highestBid || prop.bidding.basePrice || 0);
        document.getElementById('currentHighBid').textContent = currencyFormatter.format(currentHighest);
        document.getElementById('minNextBid').textContent = currencyFormatter.format(currentHighest + (prop.bidding.minIncrement || 10000));
        document.getElementById('bidAmountInput').value = currentHighest + (prop.bidding.minIncrement || 10000);

        const feeSection = document.getElementById('feePaymentSection');
        const bidSection = document.getElementById('bidPlacementSection');
        const isFinalized = prop.bidding.finalized || prop.status === 'Sold' || prop.status === 'PaymentPending';

        if (isFinalized) {
            // Auction is over — hide bidding UI, show results banner
            feeSection.classList.add('hidden');
            bidSection.classList.add('hidden');

            // Inject or update a results banner
            let resultsBanner = document.getElementById('auctionResultsBanner');
            if (!resultsBanner) {
                resultsBanner = document.createElement('div');
                resultsBanner.id = 'auctionResultsBanner';
                feeSection.parentNode.insertBefore(resultsBanner, feeSection);
            }
            const winnerName = prop.winnerName || prop.highestBidderName || 'No bids placed';
            const hadWinner = !!prop.winnerId;
            resultsBanner.style.cssText = 'display:block; text-align:center; padding:1.5rem; background:' + (hadWinner ? 'rgba(22,163,74,0.08)' : 'var(--bg-hover)') + '; border:1px solid ' + (hadWinner ? '#bbf7d0' : 'var(--border-color)') + '; border-radius:var(--radius-md); margin-bottom:1rem;';
            resultsBanner.innerHTML = hadWinner
                ? `<div style="font-size:2rem;margin-bottom:0.5rem;">🏆</div>
                   <div style="font-weight:800;font-size:1rem;color:#16a34a;">Auction Closed</div>
                   <div style="font-size:0.85rem;color:var(--text-muted);margin-top:0.4rem;">Winner: <strong style="color:var(--text-main);">${escapeHtml(winnerName)}</strong></div>
                   <div style="font-size:0.85rem;color:var(--text-muted);margin-top:0.2rem;">Final Price: <strong style="color:var(--primary);">${currencyFormatter.format(currentHighest)}</strong></div>`
                : `<div style="font-size:2rem;margin-bottom:0.5rem;">🔨</div>
                   <div style="font-weight:800;font-size:1rem;color:var(--text-muted);">Auction Ended</div>
                   <div style="font-size:0.85rem;color:var(--text-muted);margin-top:0.4rem;">No bids were placed.</div>`;
        } else {
            // Hide results banner if present
            const existing = document.getElementById('auctionResultsBanner');
            if (existing) existing.style.display = 'none';

            // Check entry fee participation
            const participants = prop.bidding.participants || {};
            const feePaid = !!participants[currentUser.id];
            if (feePaid) {
                feeSection.classList.add('hidden');
                bidSection.classList.remove('hidden');
            } else {
                feeSection.classList.remove('hidden');
                bidSection.classList.add('hidden');
                document.getElementById('bidEntryFeeAmount').textContent = currencyFormatter.format(prop.bidding.entryFee || 5000);
            }
            renderBidSuggestions(currentHighest + (prop.bidding.minIncrement || 10000));
        }

        document.getElementById('bidModal').classList.add('active');
        updateAllCountdowns();
        renderBidHistory(prop);

        // Always reset submit button state when modal opens to allow repeat bidding
        const bidForm = document.getElementById('bidForm');
        if (bidForm) {
            const submitBtn = bidForm.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="ph ph-gavel"></i> Confirm Bid';
            }
        }
    };

    function renderBidHistory(prop) {
        const timeline = document.getElementById('bidHistoryTimeline');
        const badge = document.getElementById('bidCountBadge');
        if (!timeline) return;

        const bids = prop.bids ? Object.values(prop.bids) : [];
        const sortedBids = bids.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const isFinalized = prop.bidding && (prop.bidding.finalized || prop.status === 'Sold' || prop.status === 'PaymentPending');

        if (badge) badge.textContent = `${sortedBids.length} Bids`;

        if (sortedBids.length === 0) {
            timeline.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">No bids were placed.</p>';
            return;
        }

        timeline.innerHTML = sortedBids.map((bid, i) => {
            const isTopBid   = i === 0;
            const isWinner   = isFinalized && isTopBid;
            const timeStr    = new Date(bid.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const accentColor  = isWinner ? '#16a34a' : 'var(--primary)';
            const bgColor      = isWinner ? 'rgba(22,163,74,0.06)' : (isTopBid ? 'rgba(234,88,12,0.05)' : 'var(--bg-main)');
            const borderColor  = isWinner ? '#bbf7d0' : (isTopBid ? 'var(--primary)' : 'var(--border-color)');
            const statusLabel  = isWinner
                ? `<span style="display:block;font-size:0.65rem;color:#16a34a;font-weight:800;text-transform:uppercase;margin-bottom:2px;">🏆 Winner</span>`
                : (isTopBid && !isFinalized
                    ? `<span style="display:block;font-size:0.65rem;color:var(--primary);font-weight:800;text-transform:uppercase;margin-bottom:2px;">Leading</span>`
                    : '');

            return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem;border-radius:var(--radius-sm);background:${bgColor};border:1px solid ${borderColor};border-left:3px solid ${accentColor};">
                    <div>
                        <div style="font-weight:700;font-size:0.95rem;color:var(--text-main);">${currencyFormatter.format(bid.amount)}</div>
                        <div style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(bid.userName)}</div>
                    </div>
                    <div style="text-align:right;">
                        ${statusLabel}
                        <div style="font-size:0.75rem;color:var(--text-muted);opacity:0.8;">${timeStr}</div>
                    </div>
                </div>`;
        }).join('');
    }

    function renderBidSuggestions(minNext) {
        const container = document.getElementById('bidSuggestions');
        if (!container) return;
        
        // Suggest minNext rounded up to nearest 1k, and then +10k, +50k, +100k increments
        const baseSuggestion = Math.ceil(minNext / 1000) * 1000;
        const increments = [0, 10000, 50000, 100000];
        const suggestions = increments.map(inc => baseSuggestion + inc);

        container.innerHTML = suggestions.map(amt => `
            <button type="button" class="bid-suggest-chip" data-amount="${amt}" style="padding: 0.5rem 0.9rem; border-radius: 20px; border: 1px solid var(--border-color); background: var(--bg-main); color: var(--primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                ₹${amt.toLocaleString()}
            </button>
        `).join('');

        container.querySelectorAll('.bid-suggest-chip').forEach(chip => {
            chip.onclick = () => {
                const amount = chip.getAttribute('data-amount');
                const input = document.getElementById('bidAmountInput');
                if (input) {
                    input.value = amount;
                    // Trigger simple scale animation on input
                    input.style.transform = 'scale(1.05)';
                    setTimeout(() => input.style.transform = 'scale(1)', 200);
                }
            };
        });
    }

    function syncActiveBidModal() {
        const modal = document.getElementById('bidModal');
        if (!modal || !modal.classList.contains('active')) return;

        const propId = document.getElementById('bidPropertyId')?.value;
        if (!propId) return;

        const prop = EstatoStorage.getPropertyById(propId);
        if (!prop || !prop.bidding) return;

        const currentHighest = Number(prop.highestBid || prop.bidding.basePrice || 0);
        const minNext = currentHighest + (prop.bidding.minIncrement || 10000);
        const highBidEl = document.getElementById('currentHighBid');
        const minNextEl = document.getElementById('minNextBid');

        if (highBidEl) highBidEl.textContent = currencyFormatter.format(currentHighest);
        if (minNextEl) minNextEl.textContent = currencyFormatter.format(minNext);
        
        // Refresh suggestions and history to match new highest bid
        renderBidSuggestions(minNext);
        renderBidHistory(prop);

        // If auction ended or prop sold, close modal automatically
        if (prop.status === 'Sold' || prop.bidding.finalized) {
            modal.classList.remove('active');
            showToast('This auction has concluded.', 'info');
        }
    }

    function updateAllCountdowns() {
        const timers = document.querySelectorAll('.auction-timer, .countdown-timer');
        const nowTs = Date.now();
        const now = new Date(nowTs);

        timers.forEach(timer => {
            const propId = timer.getAttribute('data-id') || timer.getAttribute('data-prop-id');
            const endTimeStr = timer.getAttribute('data-end') || timer.getAttribute('data-end-time');
            const startTimeStr = timer.getAttribute('data-start-time');
            
            if (!propId || !endTimeStr) return;

            const endTimeTs = new Date(endTimeStr).getTime();
            const startTimeTs = startTimeStr ? new Date(startTimeStr).getTime() : null;
            const isPaymentTimer = timer.classList.contains('payment-timer');

            let statusText = '';
            let timerColor = isPaymentTimer ? 'inherit' : 'var(--danger)';

            const prop = EstatoStorage.getPropertyById(propId);

            if (startTimeTs && nowTs < startTimeTs) {
                const diff = startTimeTs - nowTs;
                statusText = 'Starts in: ' + formatTimeDiff(diff);
                timerColor = 'var(--primary)';
            } else if (nowTs >= endTimeTs) {
                statusText = isPaymentTimer ? 'Expired' : 'Auction Closed';
                timerColor = 'var(--text-muted)';
                
                // --- Atomic UI Disabling ---
                // Stop bidding exactly at end time by disabling buttons in DOM
                const bidBtn = document.querySelector(`.bid-btn[data-id="${propId}"]`);
                if (bidBtn && !bidBtn.disabled) {
                    bidBtn.disabled = true;
                    bidBtn.innerHTML = '<i class="ph ph-clock"></i> Closed';
                    bidBtn.classList.add('btn-disabled');
                }

                // Trigger finalization if auction ended but not yet finalized
                if (prop && prop.status !== 'Sold' && prop.status !== 'PaymentPending' && !prop.bidding.finalized) {
                    if (!_pendingFinalizations.has(propId)) {
                        _pendingFinalizations.add(propId);
                        // Immediately patch local cache so the 1s timer loop doesn't re-trigger finalize
                        prop.bidding.finalized = true;
                        EstatoStorage.finalizeAuction(propId).finally(() => _pendingFinalizations.delete(propId));
                    }
                }

                // Monitor Payment Pending Window (if this is the deadline timer)
                if (prop && prop.status === 'PaymentPending' && prop.bidding.paymentDeadline) {
                    const deadlineTs = new Date(prop.bidding.paymentDeadline).getTime();
                    if (nowTs >= deadlineTs) {
                        if (!_pendingDefaults.has(propId)) {
                            console.log(`[Timer] Payment deadline expired for ${propId}. Triggering default.`);
                            _pendingDefaults.add(propId);
                            // Immediately patch local status so timer doesn't re-trigger on next tick
                            prop.status = 'Available';
                            EstatoStorage.reportWinnerDefault(propId).finally(() => _pendingDefaults.delete(propId));
                        }
                    }
                }
            } else {
                const diff = endTimeTs - nowTs;
                const prefix = isPaymentTimer ? 'Payment: ' : '';
                statusText = prefix + formatTimeDiff(diff) + (isPaymentTimer ? '' : ' left');
            }

            // Efficiency: Only update DOM if text actually changed
            const displayEl = timer.querySelector('.timer-display') || timer;
            if (displayEl.textContent !== statusText) {
                displayEl.textContent = statusText;
                if (!isPaymentTimer) timer.style.color = timerColor;
            }

            // Also update the timer inside properties details if it matches
            const detailTimer = document.getElementById('bidTimeLeft');
            if (detailTimer && propId === document.getElementById('bidPropertyId')?.value) {
                if (detailTimer.textContent !== statusText) {
                    detailTimer.textContent = statusText;
                    detailTimer.style.color = timerColor;
                }
            }
        });
    }

    function formatTimeDiff(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
        
        if (currentUser.role === 'Seller' || currentUser.role === 'Broker' || currentUser.role === 'Admin') {
            const allProps = EstatoStorage.getProperties();
            const myProps = allProps.filter(p => p.ownerId === currentUser.id);
            const allInquiries = EstatoStorage.getInquiries ? EstatoStorage.getInquiries() : [];
            const myInquiries = allInquiries.filter(inq => inq.ownerId === currentUser.id || myProps.some(p => p.id === inq.propertyId));
            const totalViews = myProps.reduce((sum, p) => sum + (p.views || 0), 0);
            const totalInq = myInquiries.length;
            const activeListings = myProps.filter(p => p.status === 'Available').length;
            const pendingListings = myProps.filter(p => p.status === 'Pending').length;

            html += `
                <div class="settings-card surface-panel" style="margin-top: 2rem;">
                    <h3 style="margin-bottom: 1.5rem; display:flex; align-items:center; gap:0.5rem;"><i class="ph-duotone ph-chart-bar" style="color:var(--primary);"></i> My Listing Analytics</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                        <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1rem; text-align:center;">
                            <div style="font-size:2rem; font-weight:800; color:var(--primary);">${myProps.length}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted);">Total Listings</div>
                        </div>
                        <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1rem; text-align:center;">
                            <div style="font-size:2rem; font-weight:800; color:#10b981;">${activeListings}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted);">Active</div>
                        </div>
                        <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1rem; text-align:center;">
                            <div style="font-size:2rem; font-weight:800; color:#f59e0b;">${pendingListings}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted);">Pending Review</div>
                        </div>
                        <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1rem; text-align:center;">
                            <div style="font-size:2rem; font-weight:800; color:#6366f1;">${totalInq}</div>
                            <div style="font-size:0.8rem; color:var(--text-muted);">Total Inquiries</div>
                        </div>
                    </div>
                    ${myProps.length > 0 ? `
                    <h4 style="font-size:0.85rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); margin-bottom:0.75rem;">Per-Listing Breakdown</h4>
                    <div style="display:flex; flex-direction:column; gap:0.5rem;">
                        ${myProps.slice(0, 5).map(p => {
                            const propInq = myInquiries.filter(inq => inq.propertyId === p.id).length;
                            const statusColor = p.status === 'Available' ? '#10b981' : p.status === 'Pending' ? '#f59e0b' : '#6b7280';
                            return `
                            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem 1rem; background:var(--bg-main); border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="flex:1; min-width:0;">
                                    <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(p.title)}</div>
                                    <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(p.city)}</div>
                                </div>
                                <div style="display:flex; gap:1rem; align-items:center; flex-shrink:0;">
                                    <span style="font-size:0.75rem; color:var(--text-muted);"><i class="ph ph-envelope-simple"></i> ${propInq} inquiries</span>
                                    <span style="font-size:0.75rem; padding:0.2rem 0.5rem; border-radius:20px; background:${statusColor}20; color:${statusColor}; font-weight:600;">${p.status}</span>
                                </div>
                            </div>`;
                        }).join('')}
                        ${myProps.length > 5 ? `<div style="font-size:0.85rem; color:var(--primary); text-align:center; padding:0.75rem; cursor:pointer; font-weight:600; border-radius:var(--radius-sm); transition:background 0.2s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'" onclick="window.viewMyListings()">+ ${myProps.length - 5} more listings. Click to view all.</div>` : ''}
                    </div>` : `<p style="color:var(--text-muted); font-size:0.9rem;">No listings yet. Add your first property to see analytics.</p>`}
                </div>
            `;

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
             if (countdownInterval) clearInterval(countdownInterval);
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
                            // Use EstatoStorage.changeUserRole() — keeps all DB writes
                            // inside the storage abstraction instead of calling firebase.database() directly.
                            await EstatoStorage.changeUserRole(newRole);
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

    function renderMessages(targetInquiryId = null) {
        externalRenderMessages({
            currentUser,
            EstatoStorage,
            viewContainer
        }, targetInquiryId);
    }

    window.openInquiryChat = function(id) {
        currentView = 'messages';
        window.setActiveNav('messages');
        renderMessages(id);
    };


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

    // --- Component Generators (Bridged to pure ES6 modules) ---
    function generatePropertyCard(prop, index = 0, distance = null) {
        return coreGenerateCard(prop, {
            currentUser,
            compareList,
            favorites: EstatoStorage.getFavorites(),
            ratingData: EstatoStorage.getAverageRating(prop.id),
            index,
            distance,
            formatPrice: (p) => currencyFormatter.format(p),
            formatImage: window.formatEstatoImage
        });
    }

    function renderRecentlyViewed() {
        if (!currentUser) return '';
        const recentIds = EstatoStorage.getRecentViews(currentUser.id);
        if (recentIds.length === 0) return '';

        const properties = recentIds
            .map(id => EstatoStorage.getPropertyById(id))
            .filter(p => p);

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
        return coreSimilarProps(property, EstatoStorage.getProperties());
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
            showToast('No properties to export.', 'info');
            return;
        }

        const { jsPDF } = window.jspdf;
        if (!jsPDF) {
            showToast('PDF library not loaded. Please check your internet connection.', 'danger');
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

    // Legacy map functions removed in favor of modular map-engine.js


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

    // window.toggleMapView is bridged from the map-engine module
    window.toggleMapView = function(showMap) {
        isMapVisible = showMap;
        toggleMapView(showMap, {
            filterCity: currentFilterCity,
            currentView,
            onInitMap: () => initMap(currentFilterCity),
            onUpdateMarkers: () => {
                const props = _getFilteredProperties();
                updateMapMarkers(props, currentFilterCity, currentRadiusCenter, currentRadiusKm,
                    null, (p) => currencyFormatter.format(p), window.formatEstatoImage);
            }
        });
    };

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
        } else if (currentUser.role === 'Seller' || currentUser.role === 'Broker') {
            properties = properties.filter(p => p.status !== 'Pending' || p.ownerId === currentUser.id);
        }

        // Apply Global Filters
        if (currentFilterCity) properties = properties.filter(p => p.city === currentFilterCity);
        if (searchInput.value) {
            const q = searchInput.value.toLowerCase();
            properties = properties.filter(p => p.title.toLowerCase().includes(q) || p.address.toLowerCase().includes(q));
        }
        if (currentTypeFilter) {
            if (currentTypeFilter === 'Auction') {
                properties = properties.filter(p => p.bidding && p.bidding.enabled);
            } else {
                properties = properties.filter(p => p.type === currentTypeFilter);
            }
        }
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

    // --- V11 Comparison Logic (delegates to early-registered window functions) ---
    function toggleCompare(id, event) {
        // Delegate to the canonical window.toggleCompare registered at the top
        window.toggleCompare(id, event);
    }

    function syncCompareButtons() {
        _syncCompareIcons();
    }

    function saveCompareState() {
        const ids = compareList.map(p => p.id);
        localStorage.setItem('estato_compare_v1', JSON.stringify(ids));
    }

    function updateCompareTray() {
        _updateCompareTray();
    }

    window.clearCompare = () => {
        compareList = [];
        saveCompareState();
        updateCompareTray();
        _syncCompareIcons();
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
            { label: 'Area', key: 'area', icon: 'ph-ruler', format: (v) => v != null ? Number(v).toLocaleString() + ' sq.ft' : 'N/A', type: 'max' },
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
    // NOTE: window.toggleCompare and window.renderComparisonTable are registered early (line ~62)
    // to ensure they exist before the first renderView() call. DO NOT re-assign them here.
    window.dispatchCardClick = (id) => {
        const prop = EstatoStorage.getPropertyById(id);
        if (!prop) return;

        // Track View
        if (currentUser) EstatoStorage.addRecentView(currentUser.id, id);

        window.openPropertyDetails(prop);
        updateSeoMetadata(prop);
    };

    window.closePropertyDetailsModal = () => {
        document.getElementById('propertyDetailsModal').classList.remove('active');
        window.history.pushState({}, '', '/');
    };

    window.calculateEMI = () => {
        const price = parseFloat(document.getElementById('calcPrice').value) || 0;
        const downPayment = parseFloat(document.getElementById('calcDownPayment').value) || 0;
        const rate = parseFloat(document.getElementById('calcInterestRate').value) || 0;
        const years = parseFloat(document.getElementById('calcTenure').value) || 0;
        
        const principal = price - downPayment;
        const monthlyRate = rate / 12 / 100;
        const months = years * 12;
        
        let emi = 0;
        if (principal > 0 && monthlyRate > 0 && months > 0) {
            emi = principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);
        }
        
        const resEl = document.getElementById('calcEmiResult');
        if (resEl) resEl.textContent = currencyFormatter.format(emi);
    };


    window.openPropertyDetails = (prop, skipPushState = false) => {
        if (!skipPushState) {
            window.history.pushState({ propId: prop.id }, '', '/property/' + prop.id);
        }
        
        // Record view for analytics
        EstatoStorage.recordView(prop.id);

        // Populate Calculators
        const calcPrice = document.getElementById('calcPrice');
        const emiSection = document.getElementById('emiCalculatorSection');
        
        if (emiSection) {
            emiSection.style.display = prop.type === 'Rent' ? 'none' : 'block';
        }
        
        if (calcPrice) calcPrice.value = prop.price;

        // Initial calculations
        setTimeout(async () => {
            if (prop.type !== 'Rent') window.calculateEMI();
            
            // Map & POI Intelligence (Free Alternative using OpenStreetMap/Overpass)
            let lat = prop.lat, lng = prop.lng;
            if (!lat || !lng) {
                const coords = await resolveLocationToCoords(`${prop.address}, ${prop.city}`);
                if (coords) { lat = coords.lat; lng = coords.lng; }
            }
            initDetailsMap(lat, lng, prop.title);
        }, 100);

        document.getElementById('detailsTitle').textContent = prop.title;
        document.getElementById('detailsLocation').innerHTML = `<i class="ph ph-map-pin"></i> ${escapeHtml(prop.address)}, ${escapeHtml(prop.city)}`;
        
        // Images
        const rawImgArray = (prop.images && prop.images.length > 0) ? prop.images : (prop.image && prop.image.length > 10 ? [prop.image] : [window.ESTATO_DEFAULT_IMG]);
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
            ${prop.address ? `<div style="display:flex; align-items:flex-start; gap:0.5rem; grid-column: 1 / -1;"><i class="ph-duotone ph-map-pin" style="color:var(--primary); font-size:1.2rem; margin-top:2px; flex-shrink:0;"></i> <span><strong>Address:</strong> ${escapeHtml(prop.address)}${prop.pinCode ? ` &mdash; <span style="font-family:monospace; background:var(--bg-hover); padding:1px 6px; border-radius:4px; font-size:0.85rem;">${escapeHtml(prop.pinCode)}</span>` : ''}</span></div>` : ''}
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

        // Amenities block (injected dynamically after description)
        let amenitiesSection = document.getElementById('detailsAmenitiesSection');
        if (!amenitiesSection) {
            amenitiesSection = document.createElement('div');
            amenitiesSection.id = 'detailsAmenitiesSection';
            document.getElementById('detailsDescription').parentElement.after(amenitiesSection);
        }
        if (prop.amenities && prop.amenities.length > 0) {
            const amenityMap = {
                Furnished:  { icon: 'ph-couch',        label: 'Furnished' },
                Pool:       { icon: 'ph-waves',         label: 'Swimming Pool' },
                Gym:        { icon: 'ph-barbell',       label: 'Gymnasium' },
                Parking:    { icon: 'ph-car',           label: 'Reserved Parking' },
                Security:   { icon: 'ph-shield-check',  label: '24/7 Security' },
                PetFriendly:{ icon: 'ph-paw-print',     label: 'Pet Friendly' }
            };
            amenitiesSection.innerHTML = `
                <div style="margin-bottom: 2rem;">
                    <h4 style="font-size: 1.1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; color: var(--text-main);">Amenities & Features</h4>
                    <div style="display: flex; flex-wrap: wrap; gap: 0.75rem;">
                        ${prop.amenities.map(a => {
                            const m = amenityMap[a] || { icon: 'ph-check-circle', label: a };
                            return `<span style="display:flex; align-items:center; gap:0.5rem; padding:0.5rem 1rem; background:var(--bg-hover); border:1px solid var(--border-color); border-radius:var(--radius-sm); font-size:0.9rem; font-weight:500;"><i class="ph ${m.icon}" style="color:var(--primary);"></i>${m.label}</span>`;
                        }).join('')}
                    </div>
                </div>`;
        } else {
            amenitiesSection.innerHTML = '';
        }

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
        const ratingsContainer = document.getElementById('detailsRatingsContainer');
        if (ratingsContainer) ratingsContainer.innerHTML = ratingsHtml;
 
        // NEW: Bidding Activity
        let biddingHtml = '';
        if (prop.bidding && prop.bidding.enabled) {
            const bids = EstatoStorage.getBidsByProperty(prop.id) || [];
            biddingHtml = `
                <div style="margin-top: 2rem; border-top: 1px solid var(--border-color); padding-top: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                        <h4 style="font-size: 1.1rem; color: var(--text-main); margin: 0;">Bidding Activity</h4>
                        ${bids.length > 0 ? `<button class="btn btn-secondary btn-sm" onclick="window.viewFullHistory('${prop.id}')">View All Bids</button>` : ''}
                    </div>
                    <div id="detailsBidHistory" style="display: flex; flex-direction: column; gap: 0.75rem;">
                        ${bids.slice().reverse().slice(0, 3).map(bid => `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: var(--bg-hover); border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
                                <div style="display: flex; align-items: center; gap: 0.75rem;">
                                    <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--primary-light); color: var(--primary); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.7rem;">
                                        ${bid.userName.charAt(0)}
                                    </div>
                                    <span style="font-size: 0.85rem; font-weight: 600;">${escapeHtml(bid.userName)}</span>
                                </div>
                                <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-main);">${currencyFormatter.format(bid.amount)}</div>
                            </div>
                        `).join('') || '<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem;">No bids placed yet.</p>'}
                    </div>
                </div>
            `;
        }
        
        // Find or create bidding container in modal
        let bContainer = document.getElementById('detailsBiddingSection');
        if (!bContainer) {
            bContainer = document.createElement('div');
            bContainer.id = 'detailsBiddingSection';
            if (ratingsContainer) ratingsContainer.after(bContainer);
        }
        bContainer.innerHTML = biddingHtml;

        // Footer Price & Buttons
        if (prop.bidding && prop.bidding.enabled) {
            const currentHighest = prop.highestBid || prop.bidding.basePrice || prop.price;
            document.getElementById('detailsPrice').innerHTML = `
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 2px;">Highest Bid</div>
                ${currencyFormatter.format(currentHighest)}
            `;
        } else {
            document.getElementById('detailsPrice').innerHTML = `${currencyFormatter.format(prop.price)} <span style="font-size:1rem; color:var(--text-muted); font-weight:500;">${prop.type === 'Rent' ? '/ mo' : ''}</span>`;
        }
        
        // Populate Calculator
        const calcPriceEl = document.getElementById('calcPrice');
        if (calcPriceEl) {
            calcPriceEl.value = prop.price || 0;
            document.getElementById('calcDownPayment').value = (prop.price || 0) * 0.2; // 20% default down payment
            if (window.calculateEMI) window.calculateEMI();
        }
        
        const role = currentUser ? currentUser.role : 'Buyer';
        const userId = currentUser ? currentUser.id : null;
        const isOwnerOfListing = (role === 'Seller' && prop.ownerId === userId) || role === 'Admin';
        const favs = EstatoStorage.getFavorites();
        const isFav = favs.includes(prop.id);

        let btnHtml = '';
        if (isOwnerOfListing) {
            btnHtml = ``;
        } else if (!currentUser) {
            // Guest/Brochure Mode buttons
            btnHtml = `
                <button class="btn btn-secondary btn-icon shadow-hover share-btn" data-id="${prop.id}" data-title="${escapeHtml(prop.title)}" title="Share Property">
                    <i class="ph ph-share-network"></i>
                </button>
                <button class="btn btn-primary shadow-hover guest-login-btn" style="flex: 1.5; gap: 0.5rem;">
                    <i class="ph ph-lock-key"></i> Sign In
                </button>
            `;
        } else if (prop.bidding && prop.bidding.enabled) {
            btnHtml = `
                <button class="btn btn-secondary btn-icon shadow-hover share-btn" data-id="${prop.id}" data-title="${escapeHtml(prop.title)}" title="Share Property">
                    <i class="ph ph-share-network"></i>
                </button>
                <button class="btn btn-secondary btn-icon shadow-hover fav-btn ${isFav ? 'active' : ''}" data-id="${prop.id}">
                    <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                </button>
                <button class="btn btn-primary shadow-hover bid-btn" data-id="${prop.id}" style="gap:0.5rem; flex: 1.5;">
                    <i class="ph ph-gavel"></i> Place Bid
                </button>
            `;
        } else {
            btnHtml = `
                <button class="btn btn-secondary btn-icon shadow-hover share-btn" data-id="${prop.id}" data-title="${escapeHtml(prop.title)}" title="Share Property">
                    <i class="ph ph-share-network"></i>
                </button>
                <button class="btn btn-secondary btn-icon shadow-hover fav-btn ${isFav ? 'active' : ''}" data-id="${prop.id}">
                    <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                </button>
                <button class="btn btn-primary shadow-hover contact-btn" data-id="${prop.id}" data-owner="${prop.ownerId}" data-title="${escapeHtml(prop.title)}" style="gap:0.5rem;"><i class="ph ph-envelope-simple"></i> Contact Seller</button>
            `;
        }
        document.getElementById('detailsActionBtns').innerHTML = btnHtml;

        // Attach local listeners for dynamic buttons inside modal
        const footerBtns = document.getElementById('detailsActionBtns');
        
        const guestLoginBtn = footerBtns.querySelector('.guest-login-btn');
        if (guestLoginBtn) {
            guestLoginBtn.addEventListener('click', () => {
                window.closePropertyDetailsModal();
                const loginScreen = document.getElementById('loginScreen');
                if (loginScreen) {
                    loginScreen.classList.remove('hidden');
                    const authCard = loginScreen.querySelector('.auth-card');
                    if (authCard) {
                        authCard.style.display = 'block';
                        authCard.style.animation = 'slideUpFade 0.4s ease forwards';
                    }
                }
            });
        }
        
        const bidBtn = footerBtns.querySelector('.bid-btn');
        if (bidBtn) {
            bidBtn.addEventListener('click', () => {
                if (!currentUser) { loginScreen.classList.remove('hidden'); window.closePropertyDetailsModal(); return; }
                window.openBidModal(prop.id);
            });
        }
        
        const contactBtn = footerBtns.querySelector('.contact-btn');
        if (contactBtn) {
            contactBtn.addEventListener('click', (e) => {
                if (!currentUser) { loginScreen.classList.remove('hidden'); window.closePropertyDetailsModal(); return; }
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
                if (!currentUser) { loginScreen.classList.remove('hidden'); window.closePropertyDetailsModal(); return; }
                EstatoStorage.toggleFavorite(prop.id);
                const isNowFav = EstatoStorage.getFavorites().includes(prop.id);
                favBtn.classList.toggle('active', isNowFav);
                favBtn.querySelector('i').className = isNowFav ? 'ph-fill ph-heart' : 'ph ph-heart';
                renderView(currentView, searchInput.value); // Re-render background grid silently
            });
        }
        
        const shareBtn = footerBtns.querySelector('.share-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', async (e) => {
                const id = shareBtn.getAttribute('data-id');
                const title = shareBtn.getAttribute('data-title');
                const url = window.location.origin + '/property/' + id;
                const msg = `Check out this property on Estato: ${title}\n${url}`;
                if (navigator.share) {
                    try {
                        await navigator.share({ title: 'Estato Property', text: msg, url });
                    } catch (err) { /* cancelled */ }
                } else {
                    // Show mini share menu
                    const existing = document.getElementById('sharePopover');
                    if (existing) existing.remove();
                    const pop = document.createElement('div');
                    pop.id = 'sharePopover';
                    pop.style.cssText = 'position:fixed;bottom:5rem;right:2rem;background:var(--bg-surface);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:1rem;z-index:9999;box-shadow:var(--shadow-lg);display:flex;flex-direction:column;gap:0.75rem;min-width:200px;';
                    pop.innerHTML = `
                        <strong style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">Share via</strong>
                        <a href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" style="display:flex;align-items:center;gap:0.75rem;text-decoration:none;color:var(--text-main);font-weight:600;"><i class="ph ph-whatsapp-logo" style="font-size:1.4rem;color:#25D366;"></i>WhatsApp</a>
                        <a href="mailto:?subject=${encodeURIComponent('Property on Estato: ' + title)}&body=${encodeURIComponent(msg)}" style="display:flex;align-items:center;gap:0.75rem;text-decoration:none;color:var(--text-main);font-weight:600;"><i class="ph ph-envelope" style="font-size:1.4rem;color:var(--primary);"></i>Email</a>
                        <button onclick="navigator.clipboard.writeText('${url}').then(()=>window.showToast('Link copied!','success'));document.getElementById('sharePopover').remove();" style="display:flex;align-items:center;gap:0.75rem;background:none;border:none;cursor:pointer;font-weight:600;color:var(--text-main);padding:0;"><i class="ph ph-link" style="font-size:1.4rem;color:var(--text-muted);"></i>Copy Link</button>
                        <button onclick="document.getElementById('sharePopover').remove()" style="font-size:0.8rem;background:none;border:none;cursor:pointer;color:var(--text-muted);text-align:right;">✕ Close</button>
                    `;
                    document.body.appendChild(pop);
                }
            });
        }

        // Populate Bidding History
        const bidHistorySection = document.getElementById('detailsBidHistorySection');
        if (prop.bidding && prop.bidding.enabled && bidHistorySection) {
            bidHistorySection.style.display = 'block';
            const bidList = document.getElementById('bidHistoryList');
            const bids = prop.bids ? Object.values(prop.bids).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)) : [];
            
            document.getElementById('bidCountBadge').textContent = `${bids.length} bid${bids.length !== 1 ? 's' : ''}`;

            if (bids.length === 0) {
                bidList.innerHTML = `<p style="font-size:0.85rem; color:var(--text-muted); font-style:italic;">No bids placed yet. Be the first!</p>`;
            } else {
                bidList.innerHTML = bids.slice(0, 5).map(bid => `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-main); padding:0.6rem 0.85rem; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                        <div>
                            <div style="font-weight:600; font-size:0.85rem; color:var(--text-main);">${escapeHtml(bid.userName)}</div>
                            <div style="font-size:0.7rem; color:var(--text-muted);">${new Date(bid.timestamp).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</div>
                        </div>
                        <div style="font-weight:700; color:var(--success); font-size:0.9rem;">${currencyFormatter.format(bid.amount)}</div>
                    </div>
                `).join('');
                
                if (bids.length > 5) {
                    bidList.innerHTML += `<p style="font-size:0.78rem; color:var(--primary); text-align:center; margin-top:0.25rem;">+ ${bids.length - 5} more bids</p>`;
                }
            }
        } else if (bidHistorySection) {
            bidHistorySection.style.display = 'none';
        }

        // Note: initDetailsMap is already called asynchronously at the start of this function
        // so we don't need to call it again here.

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

        parent.querySelectorAll('.hire-broker-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                showConfirm('Send this listing to the Broker Lead Pool? A professional will contact you to manage this sale.', async () => {
                    await EstatoStorage._syncToCloud(`properties/${id}/needsBroker`, true, 'set');
                    showToast('Assistance Requested! Brokers can now view your listing.', 'success');
                });
            });
        });

        parent.querySelectorAll('.claim-listing-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                showConfirm('Claim this listing? You will be assigned as the managing broker and receive a 2% commission upon successful sale.', async () => {
                    try {
                        const token = await firebase.auth().currentUser.getIdToken();
                        const resp = await fetch('/api/broker/claim', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ propertyId: id })
                        });
                        const data = await resp.json();
                        if (data.success) {
                            showToast('Listing Claimed! It is now in your managed portfolio.', 'success');
                        } else {
                            showToast(data.error || 'Claim failed', 'danger');
                        }
                    } catch (err) {
                        showToast('Communication error with server.', 'danger');
                    }
                });
            });
        });

        parent.querySelectorAll('.approve-broker-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const uid = e.target.getAttribute('data-uid');
                showConfirm('Approve this broker for verification?', async () => {
                    await EstatoStorage._syncToCloud(`users/${uid}/verification/status`, 'Approved', 'set');
                    showToast('Broker Verified Successfully!', 'success');
                });
            });
        });

        parent.querySelectorAll('.reject-broker-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const uid = e.target.getAttribute('data-uid');
                showConfirm('Reject this broker verification request?', async () => {
                    await EstatoStorage._syncToCloud(`users/${uid}/verification/status`, 'Rejected', 'set');
                    showToast('Broker verification rejected.', 'warning');
                });
            });
        });

        parent.querySelectorAll('.fav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!currentUser) { loginScreen.classList.remove('hidden'); return; }
                const id = e.currentTarget.getAttribute('data-id');
                
                // Immediate visual feedback for better perceived performance
                const icon = btn.querySelector('i');
                const isNowFav = btn.classList.toggle('active');
                if (icon) {
                    icon.className = isNowFav ? 'ph-fill ph-heart' : 'ph ph-heart';
                }
                
                EstatoStorage.toggleFavorite(id);
            });
        });

        parent.querySelectorAll('.compare-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                toggleCompare(id, e);
            });
        });

        parent.querySelectorAll('.bid-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!currentUser) { loginScreen.classList.remove('hidden'); return; }
                const id = e.currentTarget.getAttribute('data-id');
                window.openBidModal(id);
            });
        });

        parent.querySelectorAll('.pdf-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const prop = EstatoStorage.getPropertyById(id);
                if (prop) await generateFlyer(prop);
            });
        });

        parent.querySelectorAll('.share-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.getAttribute('data-id');
                const title = e.currentTarget.getAttribute('data-title');
                const url = window.location.origin + '/property/' + id;
                if (navigator.share) {
                    try {
                        await navigator.share({ title: 'Estato Property', text: 'Check out this amazing property: ' + title, url: url });
                    } catch (err) { console.log('Share error:', err); }
                } else {
                    navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard!', 'success'))
                    .catch(() => showToast('Failed to copy link.', 'danger'));
                }
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
    // --- Notifications ---
    function renderNotifications() {
        const notifs = EstatoStorage.getNotifications();
        const unreadCount = notifs.filter(n => !n.read).length;

        // Update Badge
        const notifBadge = document.getElementById('notifBadge');
        if (notifBadge) {
            if (unreadCount > 0) {
                notifBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                notifBadge.classList.remove('hidden');
            } else {
                notifBadge.classList.add('hidden');
            }
        }

        // Render List
        const notifList = document.getElementById('notifList');
        if (notifList) {
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
        const stats = EstatoStorage.getStats();
        
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
            <div class="dashboard-valuation">
             <h3><i class="ph ph-envelope-simple-open" style="color:var(--primary);"></i> Recent Platform Inquiries</h3>
             <div class="surface-panel" style="padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 2rem;">
                 ${(stats && stats.totalInquiries > 0) ? `
                     <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                         ${(EstatoStorage.getInquiries() || []).slice(0, 3).map(inq => `
                             <div class="clickable-stat" onclick="document.querySelector('.nav-item[data-view=\\'messages\\']')?.click()" style="padding: 0.75rem; background: var(--bg-hover); border-radius: 8px; border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                                 <div>
                                     <div style="font-weight: 700; font-size: 0.9rem;">${escapeHtml(inq.buyerName)} <span style="font-weight: 400; color: var(--text-muted); font-size: 0.75rem;">re: ${escapeHtml(inq.propertyTitle)}</span></div>
                                     <div style="font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px;">${escapeHtml(inq.message)}</div>
                                 </div>
                                 <span class="badge badge-secondary">${inq.status}</span>
                             </div>
                         `).join('')}
                         <button class="btn btn-secondary w-full" style="margin-top: 0.5rem;" onclick="document.querySelector('.nav-item[data-view=\\'messages\\']')?.click()">View All Messages</button>
                     </div>
                 ` : `
                     <div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
                         <i class="ph ph-envelope-simple-slash" style="font-size: 2rem; opacity: 0.5;"></i>
                         <p>No platform inquiries yet.</p>
                     </div>
                 `}
             </div>
        </div>
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
            showToast('Re-authorization successful! You can now upload images.', 'success');
            if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
            return true;
        } else {
            showToast('Authorization failed. Please ensure popups are allowed for this page.', 'danger');
            return false;
        }
    };

    window.updateSeoMetadata = updateSeoMetadata;
});
