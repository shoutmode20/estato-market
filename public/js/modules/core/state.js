/**
 * Core Application State
 * Centralizes what used to be loosely floating globals in app.v12.js
 */

export const State = {
    currentUser: null,
    currentView: 'properties', // Default
    currentFilterCity: null,
    currentSort: 'newest',
    currentTypeFilter: '',
    currentStatusFilter: '',
    currentCategoryFilter: '',

    // V11 States
    map: null,
    mapLayerGroup: null,
    markers: [],
    isMapVisible: false,
    
    // Compare Engine
    compareList: [],
    compareRestored: false,

    // Modal maps
    modalMap: null,
    modalMarker: null,

    // Radius Search
    currentRadiusCenter: null, // {lat, lng}
    currentRadiusKm: 10,
    renderDistanceMap: new Map(),

    dashboardCharts: []
};

// Unified Setter API for reactive updates if needed later
export function updateState(key, value) {
    if (Object.prototype.hasOwnProperty.call(State, key)) {
        State[key] = value;
    } else {
        console.warn(`[Estato State] Unknown key: ${key}`);
    }
}
