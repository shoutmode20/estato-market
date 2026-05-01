import { generatePropertyCard } from './property-card.js';

export function renderAuctions(ctx) {
    const { currentUser, EstatoStorage, viewContainer, attachCardListeners } = ctx;
    
    let html = `
        <div class="section-header" style="margin-bottom: 2rem;">
            <h2>My Auctions & Bids</h2>
            <p>Manage your active bids, property auctions, and payment statuses.</p>
        </div>
    `;

    const allProps = EstatoStorage.getProperties();
    let relevantProps = [];

    const isAuctionProperty = (p) => {
        // An auction property is one with bidding explicitly enabled,
        // or one that went through an auction (has bids, winner, or is Sold/PaymentPending with auction data)
        return (
            (p.bidding && p.bidding.enabled) ||
            p.winnerId ||
            (p.bids && Object.keys(p.bids).length > 0) ||
            (p.bidding && p.bidding.finalized)
        );
    };

    if (currentUser.role === 'Buyer') {
        relevantProps = allProps.filter(p => {
            if (!isAuctionProperty(p)) return false;
            const joined = p.bidding && p.bidding.participants && p.bidding.participants[currentUser.id];
            const won = p.winnerId === currentUser.id;
            const bidPlaced = p.bids && Object.values(p.bids).some(b => b.userId === currentUser.id);
            return joined || won || bidPlaced;
        });
    } else if (currentUser.role === 'Seller') {
        relevantProps = allProps.filter(p => p.ownerId === currentUser.id && isAuctionProperty(p));
    } else {
        relevantProps = allProps.filter(p => isAuctionProperty(p));
    }

    if (relevantProps.length === 0) {
        html += `
            <div class="empty-state surface-panel" style="padding: 4rem; text-align: center; border: 1px dashed var(--border-color); background: var(--bg-hover); border-radius: var(--radius-lg);">
                <i class="ph-duotone ph-gavel" style="font-size: 4rem; color: var(--text-muted); opacity: 0.5; margin-bottom: 1rem;"></i>
                <h4 style="margin: 0; color: var(--text-main); font-size: 1.25rem;">No auction activity found.</h4>
                <p style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.95rem;">${currentUser.role === 'Buyer' ? 'Explore properties and join an auction to see them here.' : 'You have no active auctions for your listings.'}</p>
            </div>
        `;
    } else {
        html += `
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem;">
                ${relevantProps.map(p => generatePropertyCard(p)).join('')}
            </div>
        `;
    }

    viewContainer.innerHTML = html;
    if (attachCardListeners) attachCardListeners();
}
