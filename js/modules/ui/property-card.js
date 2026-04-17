/**
 * Property Card Module
 * Isolated property card HTML generation, sorting, filtering, and "recently viewed" logic.
 * Extracted from the monolithic main.js for testability and maintainability.
 */

import { escapeHtml } from './utils.js';

// Property Category Metadata
const PROPERTY_METADATA = {
    'Apartment':  { icon: 'ph-buildings',   tags: ['High-rise', 'Security', 'Amenities'],       color: 'blue'   },
    'Villa':      { icon: 'ph-house-line',   tags: ['Private', 'Garden', 'Spacious'],            color: 'green'  },
    'Plot':       { icon: 'ph-map-trifold',  tags: ['Land', 'Investment', 'Customizable'],       color: 'orange' },
    'Commercial': { icon: 'ph-storefront',   tags: ['Retail', 'Office', 'High ROI'],             color: 'purple' }
};

/**
 * Apply sort order to a properties array (returns new sorted array without mutation).
 * @param {Array} properties
 * @param {string} sortMode - 'newest' | 'oldest' | 'price-low' | 'price-high'
 * @returns {Array}
 */
export function sortProperties(properties, sortMode = 'newest') {
    const arr = [...properties];
    switch (sortMode) {
        case 'oldest':     return arr.sort((a, b) => new Date(a.date) - new Date(b.date));
        case 'price-low':  return arr.sort((a, b) => a.price - b.price);
        case 'price-high': return arr.sort((a, b) => b.price - a.price);
        case 'newest':
        default:
            return arr.sort((a, b) => {
                const da = a.date ? new Date(a.date).getTime() : 0;
                const db = b.date ? new Date(b.date).getTime() : 0;
                return db - da;
            });
    }
}

/**
 * Apply RBAC filtering to a property list.
 * @param {Array} properties
 * @param {{ role: string, id: string }} currentUser
 * @returns {Array}
 */
export function filterByRole(properties, currentUser) {
    if (!currentUser) return [];
    const { role, id } = currentUser;
    if (role === 'Buyer') {
        return properties.filter(p => p.status === 'Available');
    } else if (role === 'Seller') {
        return properties.filter(p => p.status !== 'Pending' || p.ownerId === id);
    }
    // Admin sees all
    return properties;
}

/**
 * Apply text/filter bar criteria.
 * @param {Array} properties
 * @param {{ cityFilter, searchQuery, typeFilter, statusFilter, categoryFilter }} filters
 * @returns {Array}
 */
export function applyFilters(properties, { cityFilter, searchQuery, typeFilter, statusFilter, categoryFilter }) {
    let result = [...properties];
    if (cityFilter)      result = result.filter(p => p.city === cityFilter);
    if (typeFilter)      result = result.filter(p => p.type === typeFilter);
    if (statusFilter)    result = result.filter(p => p.status === statusFilter);
    if (categoryFilter)  result = result.filter(p => p.category === categoryFilter);
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        result = result.filter(p =>
            (p.title     && p.title.toLowerCase().includes(q))    ||
            (p.city      && p.city.toLowerCase().includes(q))     ||
            (p.address   && p.address.toLowerCase().includes(q)) ||
            (p.pinCode   && String(p.pinCode).includes(q))
        );
    }
    return result;
}

/**
 * Generate a property card HTML string.
 * Pure function: no DOM side-effects, fully testable.
 *
 * @param {object} prop            - Property data object
 * @param {object} currentUser     - { role, id }
 * @param {Array}  compareList     - Current compare list
 * @param {Array}  favorites       - Current favorites array of IDs
 * @param {object} ratingData      - { average, count } from EstatoStorage.getAverageRating()
 * @param {number} index           - Card animation delay index
 * @param {number|null} distance   - Distance in km (for radius search), or null
 * @param {Function} formatPrice   - Intl.NumberFormat.format()
 * @param {Function} formatImage   - window.formatEstatoImage()
 * @returns {string} HTML string
 */
export function generatePropertyCard(prop, { currentUser, compareList, favorites, ratingData, index = 0, distance = null, formatPrice, formatImage }) {
    const isSale = prop.type === 'Sale';
    const badgeClass = isSale ? 'sale' : 'rent';
    const isFav = favorites.includes(prop.id);
    const mapHref = `https://maps.google.com/?q=${encodeURIComponent((prop.address || '') + ', ' + (prop.city || ''))}`;

    const rawImgArray = (prop.images && prop.images.length > 0)
        ? prop.images
        : (prop.image && prop.image.length > 10 ? [prop.image] : ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?q=80&w=800&auto=format&fit=crop']);
    const images = rawImgArray.map(url => formatImage(url));

    const role = currentUser ? currentUser.role : 'Buyer';
    const userId = currentUser ? currentUser.id : null;
    const isOwner = (role === 'Seller' && prop.ownerId === userId) || role === 'Admin';

    const carouselHTML = `
        <div class="image-carousel">
            ${images.map(img => `<div class="carousel-slide"><img src="${img}" alt="${escapeHtml(prop.title)}" loading="lazy" onerror="this.onerror=null;this.src=window.ESTATO_DEFAULT_IMG;"></div>`).join('')}
        </div>
        ${images.length > 1 ? `
            <div class="carousel-indicators">
                ${images.map((_, i) => `<div class="carousel-dot ${i === 0 ? 'active' : ''}"></div>`).join('')}
            </div>
        ` : ''}
    `;

    const ratingHTML = ratingData && ratingData.count > 0 ? `
        <div class="rating-badge" title="${ratingData.average} average based on ${ratingData.count} reviews">
            <i class="ph-fill ph-star" style="color: #fbbf24;"></i>
            <span>${ratingData.average}</span>
            <span class="count">(${ratingData.count})</span>
        </div>
    ` : '';

    const meta = PROPERTY_METADATA[prop.category];

    return `
        <div class="property-card" style="animation-delay: ${index * 0.05}s" onclick="window.dispatchCardClick('${escapeHtml(prop.id)}')">
            <div class="card-img">
                ${carouselHTML}
                <div class="badges">
                    ${meta ? `<span class="badge" style="background: var(--${meta.color}); color: white;"><i class="${meta.icon}"></i> ${escapeHtml(prop.category)}</span>` : ''}
                    <span class="badge ${badgeClass}">${escapeHtml(prop.type)}</span>
                    <span class="badge" style="background: rgba(44,40,37,0.85); color: white;">${escapeHtml(prop.status)}</span>
                    ${distance !== null ? `<span class="badge" style="background: var(--success); color: white; border: none;"><i class="ph ph-navigation-arrow"></i> ${distance.toFixed(1)} km</span>` : ''}
                </div>
                ${ratingHTML}
                <button class="fav-float-btn compare-btn ${compareList.find(p => p.id === prop.id) ? 'active btn-primary' : ''}"
                    onclick="window.toggleCompare('${escapeHtml(prop.id)}', event)" title="Compare Property" style="right: 3.5rem;">
                    <i class="ph ph-scales"></i>
                </button>
                <button class="fav-float-btn fav-btn ${isFav ? 'active' : ''}" data-id="${escapeHtml(prop.id)}" title="Save to My Properties">
                    <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                </button>
            </div>
            <div class="card-content">
                <div class="card-price">
                    ${formatPrice(prop.price)}
                    <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 500;">${!isSale ? '/ mo' : ''}</span>
                </div>
                <div class="card-metrics">
                    <div class="metric"><i class="ph-duotone ph-bed"></i> ${escapeHtml(String(prop.bhk || 'N/A'))}</div>
                    <div class="metric"><i class="ph-duotone ph-ruler"></i> ${prop.area ? Number(prop.area).toLocaleString('en-IN') : '--'} sq.ft</div>
                </div>
                <div class="card-title">${escapeHtml(prop.title)}</div>
                ${prop.projectName ? `<div style="font-size: 0.75rem; color: var(--primary); font-weight: 700; text-transform: uppercase; margin-bottom: 0.25rem;"><i class="ph ph-buildings"></i> ${escapeHtml(prop.projectName)}</div>` : ''}
                <div class="card-location"><i class="ph ph-map-pin"></i> ${escapeHtml(prop.address)}, ${escapeHtml(prop.city)}</div>
                <div class="card-separator"></div>
                <div class="card-actions">
                    <button class="btn btn-secondary btn-icon shadow-hover pdf-btn" data-id="${escapeHtml(prop.id)}" title="Download Flyer">
                        <i class="ph ph-file-pdf"></i>
                    </button>
                    <button class="btn btn-secondary btn-icon shadow-hover reviews-btn" data-id="${escapeHtml(prop.id)}" title="See Reviews">
                        <i class="ph-duotone ph-star"></i>
                    </button>
                    <a href="${mapHref}" target="_blank" class="btn btn-secondary btn-icon shadow-hover" title="View on Map" onclick="event.stopPropagation()">
                        <i class="ph ph-map-pin-line"></i>
                    </a>
                    ${(role === 'Admin' && prop.status === 'Pending') ? `
                        <button class="btn approve-btn shadow-hover" data-id="${escapeHtml(prop.id)}" style="flex:1;background:var(--success);color:white;border:none;">
                            <i class="ph-fill ph-check-circle"></i> Approve
                        </button>
                        <button class="btn btn-danger reject-btn shadow-hover" data-id="${escapeHtml(prop.id)}" style="flex:1;">
                            <i class="ph-fill ph-x-circle"></i> Reject
                        </button>
                    ` : isOwner ? `
                        <button class="btn btn-secondary edit-btn shadow-hover" data-id="${escapeHtml(prop.id)}" style="flex:1;">Edit</button>
                        <button class="btn btn-danger btn-icon delete-btn shadow-hover" data-id="${escapeHtml(prop.id)}" title="Delete Listing">
                            <i class="ph ph-trash"></i>
                        </button>
                    ` : `
                        <button class="btn btn-secondary shadow-hover trend-btn" data-id="${escapeHtml(prop.id)}" title="Price History">
                            <i class="ph ph-chart-line"></i>
                        </button>
                        <button class="btn btn-primary shadow-hover contact-btn" data-id="${escapeHtml(prop.id)}"
                            data-owner="${escapeHtml(prop.ownerId)}" data-title="${escapeHtml(prop.title)}"
                            style="flex:1.2;" title="Message Seller Securely">
                            <i class="ph ph-envelope-simple"></i> Contact
                        </button>
                    `}
                </div>
            </div>
        </div>
    `;
}

/**
 * Get similar properties based on scoring algorithm.
 * @param {object} property - Reference property
 * @param {Array} allProperties - Full property list
 * @returns {Array} up to 4 scored similar properties
 */
export function getSimilarProperties(property, allProperties) {
    const scored = allProperties
        .filter(p => p.id !== property.id)
        .map(p => {
            let score = 0;
            if (p.category === property.category) score += 40;
            if (p.type === property.type) score += 30;
            if (p.bhk === property.bhk) score += 20;
            if (p.city === property.city) score += 50;
            if (p.projectName && property.projectName && p.projectName === property.projectName) score += 60;
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

export { PROPERTY_METADATA };
