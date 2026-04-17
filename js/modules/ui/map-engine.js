/**
 * Map Engine Module
 * Isolated Leaflet.js logic extracted from the monolithic main.js.
 * Handles the main property listing map, modal add/edit maps, and marker management.
 *
 * NOTE: Requires `L` (Leaflet) to be globally available via the CDN script in index.html.
 * NOTE: Requires `EstatoStorage` and utility/state imports from main.js context.
 */

import { escapeHtml } from './utils.js';

// ─── Private State ─────────────────────────────────────────────────────────

let _map = null;
let _mapLayerGroup = null;
let _markers = [];
let _modalMap = null;
let _modalMarker = null;
let _isMapVisible = false;

// City Geocoding (local fallback before Nominatim API)
const CITY_COORDS = {
    'Mumbai': [19.0760, 72.8777], 'Delhi': [28.6139, 77.2090],
    'Bangalore': [12.9716, 77.5946], 'Chennai': [13.0827, 80.2707],
    'Pune': [18.5204, 73.8567], 'Hyderabad': [17.3850, 78.4867],
    'Ahmedabad': [23.0225, 72.5714], 'Kolkata': [22.5726, 88.3639],
    'Surat': [21.1702, 72.8311], 'Jaipur': [26.9124, 75.7873],
    'Lucknow': [26.8467, 80.9462], 'Kanpur': [26.4499, 80.3319],
    'Nagpur': [21.1458, 79.0882], 'Indore': [22.7196, 75.8577],
    'Thane': [19.2183, 72.9781], 'Bhopal': [23.2599, 77.4126],
    'Gurgaon': [28.4595, 77.0266], 'Noida': [28.5355, 77.3910],
    'Chandigarh': [30.7333, 76.7794], 'Kochi': [9.9312, 76.2673],
    'Coimbatore': [11.0168, 76.9558], 'Navi Mumbai': [19.0330, 73.0297],
};

// ─── Main Listing Map ───────────────────────────────────────────────────────

/**
 * Initialize the main Leaflet map in #leafletMap container.
 * @param {string|null} filterCity - City to center the map on
 */
export function initMap(filterCity = null) {
    if (_map) return;
    const center = CITY_COORDS[filterCity] || [20.5937, 78.9629];
    const zoom = filterCity ? 12 : 5;
    _map = L.map('leafletMap').setView(center, zoom);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(_map);
}

/**
 * Destroys and clears the map instance. Call when navigating away.
 */
export function destroyMap() {
    if (_map) {
        _map.remove();
        _map = null;
        _mapLayerGroup = null;
        _markers = [];
    }
}

/**
 * Update all markers on the listing map based on filtered properties.
 * @param {Array} properties - Already filtered property list to display
 * @param {string|null} filterCity
 * @param {object|null} radiusCenter - {lat, lng} if radius search is active
 * @param {number} radiusKm
 * @param {Function} onMarkerClick - Callback when a marker popup "View Details" is clicked (receives property id)
 * @param {Function} formatPrice
 * @param {Function} formatImage
 */
export function updateMapMarkers(properties, filterCity, radiusCenter, radiusKm, onMarkerClick, formatPrice, formatImage) {
    if (!_map) return;

    if (_mapLayerGroup) _map.removeLayer(_mapLayerGroup);
    _mapLayerGroup = L.layerGroup().addTo(_map);
    _markers = [];

    const bounds = [];

    properties.forEach(p => {
        const lat = p.lat || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][0] + (Math.random() - 0.5) * 0.01 : null);
        const lng = p.lng || (CITY_COORDS[p.city] ? CITY_COORDS[p.city][1] + (Math.random() - 0.5) * 0.01 : null);
        if (!lat || !lng) return;

        const priceStr = p.price >= 10000000
            ? (p.price / 10000000).toFixed(1) + 'Cr'
            : (p.price / 100000).toFixed(0) + 'L';

        const icon = L.divIcon({
            className: 'custom-div-icon',
            html: `<div class="map-price-marker">${escapeHtml(priceStr)}</div>`,
            iconSize: [60, 30],
            iconAnchor: [30, 30]
        });

        const marker = L.marker([lat, lng], { icon });
        const firstImg = formatImage((p.images && p.images.length > 0) ? p.images[0] : (p.image || ''));
        const popupContent = `
            <div style="width: 200px; font-family: 'Outfit';">
                ${firstImg ? `<img src="${firstImg}" style="width:100%; height:100px; object-fit:cover; border-radius:8px; margin-bottom:8px;" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;">` : ''}
                <h4 style="margin:0; font-size:1rem;">${escapeHtml(p.title)}</h4>
                <p style="margin:4px 0; color:var(--primary); font-weight:700;">${formatPrice(p.price)}</p>
                <button class="btn btn-primary btn-sm w-full" style="margin-top:8px;" onclick="window.dispatchCardClick('${escapeHtml(p.id)}')">View Details</button>
            </div>
        `;
        marker.bindPopup(popupContent);
        marker.addTo(_mapLayerGroup);
        _markers.push(marker);
        bounds.push([lat, lng]);
    });

    // Smart zoom based on context
    if (radiusCenter) {
        _map.setView([radiusCenter.lat, radiusCenter.lng], 13);
        L.circle([radiusCenter.lat, radiusCenter.lng], {
            radius: radiusKm * 1000,
            color: '#ea580c',
            weight: 2,
            fillColor: '#ea580c',
            fillOpacity: 0.2
        }).addTo(_mapLayerGroup);
    } else if (bounds.length > 0 && !filterCity) {
        _map.fitBounds(bounds, { padding: [50, 50] });
    } else if (filterCity && CITY_COORDS[filterCity]) {
        _map.setView(CITY_COORDS[filterCity], 12);
    }
}

/**
 * Toggle between map and grid view.
 */
export function toggleMapView(showMap, { filterCity, currentView, onInitMap, onUpdateMarkers }) {
    if (currentView !== 'properties') return;

    _isMapVisible = showMap;
    const grid    = document.getElementById('propertiesGrid');
    const mapCont = document.getElementById('mapContainer');
    const gridBtn = document.getElementById('viewGridBtn');
    const mapBtn  = document.getElementById('viewMapBtn');

    if (!grid || !mapCont) return;

    if (showMap) {
        grid.style.display    = 'none';
        mapCont.style.display = 'block';
        if (gridBtn) gridBtn.classList.remove('active');
        if (mapBtn)  mapBtn.classList.add('active');
        setTimeout(() => {
            if (onInitMap) onInitMap();
            if (_map) _map.invalidateSize();
            if (onUpdateMarkers) onUpdateMarkers();
        }, 150);
    } else {
        grid.style.display    = '';
        mapCont.style.display = 'none';
        if (gridBtn) gridBtn.classList.add('active');
        if (mapBtn)  mapBtn.classList.remove('active');
    }
}

export function getIsMapVisible() { return _isMapVisible; }
export function getMap() { return _map; }

// ─── Modal Map (Add / Edit Property) ───────────────────────────────────────

/**
 * Initializes or updates the property add/edit modal's embedded map.
 * @param {number|null} lat
 * @param {number|null} lng
 */
export function initModalMap(lat, lng) {
    const container = document.getElementById('modalMap');
    if (!container) return;
    container.style.display = 'block';

    const hasLocation = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
    const centerLat = hasLocation ? parseFloat(lat) : 20.5937;
    const centerLng = hasLocation ? parseFloat(lng) : 78.9629;
    const zoom = hasLocation ? 15 : 4;

    if (!_modalMap) {
        _modalMap = L.map('modalMap', { zoomControl: true }).setView([centerLat, centerLng], zoom);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CartoDB',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(_modalMap);

        _modalMap.on('click', (e) => {
            const newLat = e.latlng.lat.toFixed(6);
            const newLng = e.latlng.lng.toFixed(6);
            const latInput = document.getElementById('propLat');
            const lngInput = document.getElementById('propLng');
            if (latInput) latInput.value = newLat;
            if (lngInput) lngInput.value = newLng;
            updateModalMarker(newLat, newLng);
            reverseGeocode(newLat, newLng);
            const tip = document.getElementById('mapClickTip');
            if (tip) tip.style.display = 'none';
        });

        if (!hasLocation) {
            const tip = document.createElement('div');
            tip.id = 'mapClickTip';
            tip.innerHTML = '<i class="ph ph-map-pin-line"></i>&nbsp;Click to pin property location';
            Object.assign(tip.style, {
                position: 'absolute', top: '10px', left: '50%',
                transform: 'translateX(-50%)', background: 'rgba(234,88,12,0.92)',
                color: 'white', padding: '6px 14px', borderRadius: '20px',
                fontSize: '0.78rem', fontWeight: '600', zIndex: '1000',
                pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                whiteSpace: 'nowrap', animation: 'mapTipPulse 2s ease-in-out infinite'
            });
            container.style.position = 'relative';
            container.appendChild(tip);
        }
    } else {
        _modalMap.setView([centerLat, centerLng], zoom);
        const tip = document.getElementById('mapClickTip');
        if (tip) tip.style.display = hasLocation ? 'none' : '';
    }

    setTimeout(() => { _modalMap.invalidateSize(); }, 100);
    if (hasLocation) updateModalMarker(centerLat, centerLng);
}

/**
 * Place or move the draggable map marker in the modal map.
 */
export function updateModalMarker(lat, lng) {
    if (lat === null || lat === undefined || lng === null || lng === undefined) return;
    const fLat = parseFloat(lat);
    const fLng = parseFloat(lng);
    if (isNaN(fLat) || isNaN(fLng)) return;

    if (_modalMarker) {
        _modalMarker.setLatLng([fLat, fLng]);
        if (_modalMap) _modalMap.panTo([fLat, fLng]);
    } else {
        if (!_modalMap) return;
        _modalMarker = L.marker([fLat, fLng], { draggable: true, title: 'Drag to fine-tune location' }).addTo(_modalMap);

        _modalMarker.on('dragend', (e) => {
            const pos = e.target.getLatLng();
            const newLat = pos.lat.toFixed(6);
            const newLng = pos.lng.toFixed(6);
            const latInput = document.getElementById('propLat');
            const lngInput = document.getElementById('propLng');
            if (latInput) latInput.value = newLat;
            if (lngInput) lngInput.value = newLng;
            reverseGeocode(newLat, newLng);
        });

        _modalMarker.on('dragstart', () => {
            _modalMarker.bindTooltip('Release to set location', {
                permanent: true, className: 'map-drag-tooltip', offset: [0, -30]
            }).openTooltip();
        });
        _modalMarker.on('dragend', () => { _modalMarker.unbindTooltip(); });
    }
}

/**
 * Destroy modal map on close so it can be re-initialized cleanly next time.
 */
export function destroyModalMap() {
    if (_modalMap) {
        _modalMap.remove();
        _modalMap = null;
        _modalMarker = null;
    }
}

// ─── Private Helpers ───────────────────────────────────────────────────────

export async function reverseGeocode(lat, lng) {
    if (!lat || !lng) return;

    const helpText = document.getElementById('locationHelpText');
    if (helpText) helpText.innerHTML = '<i class="ph ph-spinner ph-spin"></i><span> Looking up address...</span>';

    console.log(`[MapEngine Geocoding] Fetching for ${lat}, ${lng}`);

    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
            { headers: { 'User-Agent': 'Estato-Marketplace-App/1.0' } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (!data || !data.address) {
            console.warn('[MapEngine Geocoding] No address in response', data);
            return;
        }

        const addr = data.address;
        console.log('[MapEngine Geocoding] Address data:', addr);

        // --- Road / Street ---
        const road = addr.road || addr.suburb || addr.neighbourhood || addr.pedestrian || addr.square || '';

        // --- City: try every possible field Nominatim may use for Indian addresses ---
        let city = addr.city || addr.town || addr.village || addr.suburb ||
                   addr.city_district || addr.district || addr.state_district || addr.county || '';
        // Final fallback: extract from display_name (3rd from end is usually the city)
        if (!city && data.display_name) {
            const parts = data.display_name.split(',');
            if (parts.length > 3) city = parts[parts.length - 3].trim();
        }

        // --- PIN Code: use postcode field first, then scan full address string ---
        let postcode = addr.postcode || '';
        if (!postcode && data.display_name) {
            const pinMatch = data.display_name.match(/\b\d{6}\b/);
            if (pinMatch) postcode = pinMatch[0];
        }

        // --- Fill form fields ---
        const addressEl = document.getElementById('propAddress');
        const cityEl    = document.getElementById('propCity');
        const pinEl     = document.getElementById('propPinCode');

        if (addressEl && road) {
            addressEl.value = road;
            addressEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (cityEl && city) {
            cityEl.value = city;
            cityEl.dispatchEvent(new Event('input',  { bubbles: true }));
            cityEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (pinEl && postcode) {
            const cleanPin = postcode.match(/\d{6}/);
            if (cleanPin) {
                pinEl.value = cleanPin[0];
                pinEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        if (helpText) {
            if (city && postcode) {
                helpText.innerHTML = `<i class="ph ph-check-circle" style="color:var(--success)"></i><span style="color:var(--success)"> Auto-filled: ${city} (${postcode})</span>`;
            } else {
                helpText.innerHTML = '<i class="ph ph-info" style="color:var(--warning)"></i><span> Coordinates pinned. Please verify City &amp; PIN manually.</span>';
            }
        }

        console.log(`[MapEngine Geocoding] Done — Road: ${road}, City: ${city}, PIN: ${postcode}`);
    } catch (e) {
        console.error('[MapEngine Geocoding] Failed:', e);
        if (helpText) helpText.innerHTML = '<i class="ph ph-warning-circle" style="color:var(--danger)"></i><span style="color:var(--danger)"> Geocoding failed. Please enter details manually.</span>';
    }
}

export { CITY_COORDS };
