/**
 * Property Card Module
 * Isolated property card HTML generation, sorting, filtering, and "recently viewed" logic.
 * Extracted from the monolithic main.js for testability and maintainability.
 */

import { escapeHtml, formatIndianPrice, getTimeAgo } from './utils.js';

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
        : (prop.image && prop.image.length > 10 ? [prop.image] : [window.ESTATO_DEFAULT_IMG]);
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
                    <span class="badge" style="background: ${prop.status === 'PaymentPending' ? '#fbbf24' : 'rgba(44,40,37,0.85)'}; color: ${prop.status === 'PaymentPending' ? 'var(--text-main)' : 'white'};">
                        ${prop.status === 'PaymentPending' ? '<i class="ph-fill ph-clock-countdown"></i> Payment Pending' : escapeHtml(prop.status)}
                    </span>
                    ${prop.winnerName ? `<span class="badge" style="background: var(--primary); color: white;"><i class="ph-fill ph-trophy"></i> Winner: ${escapeHtml(prop.winnerName)}</span>` : ''}
                    ${(prop.bidding && (prop.bidding.enabled || prop.bidding.finalized)) ? `<span class="badge" style="background: #ef4444; color: white;"><i class="ph-fill ph-gavel"></i> Auction</span>` : ''}
                    ${prop.bidding && prop.bidding.participants && Object.keys(prop.bidding.participants).length >= 3 ? `<span class="badge" style="background: linear-gradient(135deg, #f97316, #ef4444); color: white; box-shadow: 0 0 10px rgba(239, 68, 68, 0.4); border: none;"><i class="ph-fill ph-fire"></i> Hot Bid</span>` : ''}
                    ${distance !== null ? `<span class="badge" style="background: var(--success); color: white; border: none;"><i class="ph ph-navigation-arrow"></i> ${distance.toFixed(1)} km</span>` : ''}
                </div>
                ${ratingHTML}
                ${prop.bidding && prop.bidding.enabled && prop.status !== 'Sold' && prop.status !== 'PaymentPending' ? `
                    <div class="auction-timer" data-id="${prop.id}" data-end="${prop.bidding.endTime}" data-start-time="${prop.bidding.startTime}" style="position: absolute; bottom: 0.75rem; left: 0.75rem; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); color: white; padding: 0.4rem 0.75rem; border-radius: 20px; font-size: 0.8rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; z-index: 5;">
                        <i class="ph-fill ph-timer" style="color: #fbbf24;"></i>
                        <span class="timer-display">Loading...</span>
                    </div>
                ` : ''}
                ${prop.status === 'PaymentPending' && prop.bidding && prop.bidding.paymentDeadline ? `
                    <div class="auction-timer payment-timer" data-id="${prop.id}" data-end="${prop.bidding.paymentDeadline}" style="position: absolute; bottom: 0.75rem; left: 0.75rem; background: rgba(251, 191, 36, 0.9); backdrop-filter: blur(4px); color: var(--text-main); padding: 0.4rem 0.75rem; border-radius: 20px; font-size: 0.8rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem; z-index: 5; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
                        <i class="ph-fill ph-hourglass-high"></i>
                        <span class="timer-display">Payment: Loading...</span>
                    </div>
                ` : ''}
                ${!(prop.bidding && prop.bidding.enabled) ? `
                <button class="fav-float-btn compare-btn ${compareList.find(p => p.id === prop.id) ? 'selected' : ''}"
                    data-id="${escapeHtml(prop.id)}"
                    onclick="window.toggleCompare('${escapeHtml(prop.id)}', event); event.stopImmediatePropagation(); return false;" title="Add to Compare" aria-label="Add to Compare" style="right: 3.5rem;">
                    <i class="ph ph-scales"></i>
                </button>
                ` : ''}
                <button class="fav-float-btn fav-btn ${isFav ? 'active' : ''}" data-id="${escapeHtml(prop.id)}" title="Save to My Properties" aria-label="${isFav ? 'Remove from My Properties' : 'Save to My Properties'}">
                    <i class="${isFav ? 'ph-fill ph-heart' : 'ph ph-heart'}"></i>
                </button>
            </div>
            <div class="card-content">
                <div class="card-price">
                    ${prop.bidding && prop.bidding.enabled ? `
                        <span style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 2px;">Highest Bid</span>
                        ${formatIndianPrice(prop.highestBid || prop.bidding.basePrice || prop.price)}
                    ` : formatIndianPrice(prop.price)}
                    <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 500;">${!isSale && !(prop.bidding && prop.bidding.enabled) ? '/ mo' : ''}</span>
                </div>
                ${prop.bidding && prop.bidding.enabled && prop.status !== 'Sold' && prop.status !== 'PaymentPending' ? `
                    <div class="auction-timer" style="font-size: 0.85rem; color: var(--danger); font-weight: 700; margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
                        <i class="ph-fill ph-clock"></i>
                        <span class="countdown-timer" data-prop-id="${prop.id}" data-end-time="${prop.bidding.endTime}" data-start-time="${prop.bidding.startTime}">Loading Timer...</span>
                    </div>
                ` : ''}
                <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.3rem;">
                    <i class="ph ph-calendar-blank"></i> Listed ${getTimeAgo(prop.listedAt || prop.date || (prop.id && prop.id.includes('_') ? Number(prop.id.split('_')[1]) : null))}
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
                    <button class="btn btn-secondary btn-icon shadow-hover share-btn" data-id="${escapeHtml(prop.id)}" data-title="${escapeHtml(prop.title)}" title="Share Property" aria-label="Share Property">
                        <i class="ph ph-share-network"></i>
                    </button>
                    <button class="btn btn-secondary btn-icon shadow-hover pdf-btn" data-id="${escapeHtml(prop.id)}" title="Download Flyer" aria-label="Download Flyer">
                        <i class="ph ph-file-pdf"></i>
                    </button>
                    <button class="btn btn-secondary btn-icon shadow-hover reviews-btn" data-id="${escapeHtml(prop.id)}" title="See Reviews" aria-label="See Reviews">
                        <i class="ph-duotone ph-star"></i>
                    </button>
                    <a href="${mapHref}" target="_blank" class="btn btn-secondary btn-icon shadow-hover" title="View on Map" aria-label="View on Map" onclick="event.stopPropagation()">
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
                        ${(!prop.assignedBrokerId && !prop.needsBroker) ? `
                            <button class="btn btn-secondary hire-broker-btn shadow-hover" data-id="${escapeHtml(prop.id)}" style="flex:1;" title="Get professional help to sell faster">
                                <i class="ph ph-handshake"></i> Hire Broker
                            </button>
                        ` : prop.needsBroker ? `
                            <div class="badge badge-warning" style="flex:1; padding: 0.5rem; text-align:center;">Broker Requested</div>
                        ` : `
                            <div class="badge badge-success" style="flex:1; padding: 0.5rem; text-align:center;"><i class="ph ph-user-check"></i> Managed</div>
                        `}
                        <button class="btn btn-danger btn-icon delete-btn shadow-hover" data-id="${escapeHtml(prop.id)}" title="Delete Listing" aria-label="Delete Listing">
                            <i class="ph ph-trash"></i>
                        </button>
                    ` : (role === 'Broker' && prop.needsBroker && !prop.assignedBrokerId) ? `
                        <button class="btn btn-primary claim-listing-btn shadow-hover" data-id="${escapeHtml(prop.id)}" style="flex:1; background: var(--primary);">
                            <i class="ph ph-magnifying-glass-plus"></i> Claim Listing (2% Comm.)
                        </button>
                    ` : prop.bidding && prop.bidding.enabled && prop.status !== 'Sold' && prop.status !== 'PaymentPending' ? `
                        <button class="btn btn-primary shadow-hover bid-btn" data-id="${escapeHtml(prop.id)}"
                            style="flex:1;" title="Place a bid on this property">
                            <i class="ph ph-gavel"></i> Bid Now
                        </button>
                    ` : prop.bidding && (prop.bidding.enabled || prop.bidding.finalized) ? `
                        <button class="btn btn-secondary shadow-hover bid-btn" data-id="${escapeHtml(prop.id)}"
                            style="flex:1;" title="View auction results and history">
                            <i class="ph ph-scroll"></i> View Results
                        </button>
                    ` : `
                        <button class="btn btn-secondary shadow-hover trend-btn" data-id="${escapeHtml(prop.id)}" title="Price History" aria-label="Price History">
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
