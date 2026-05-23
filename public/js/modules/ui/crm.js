import { EstatoStorage } from '../services/storage.js';
import { escapeHtml, showToast } from './utils.js';

/**
 * CRM / Lead Pipeline Module for Estato
 * Renders a Kanban board for Brokers and Sellers to manage inquiries.
 */

export function renderCRM(container) {
    const user = EstatoStorage.getCurrentUser();
    if (!user || (user.role !== 'Seller' && user.role !== 'Broker' && user.role !== 'Admin')) {
        container.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);">Access restricted to Sellers and Brokers.</div>';
        return;
    }

    const inquiries = EstatoStorage.getInquiries().filter(inq => {
        // If Admin, show all. If Seller/Broker, show inquiries for THEIR properties.
        if (user.role === 'Admin') return true;
        return inq.ownerId === user.id;
    });

    const stages = [
        { id: 'New', label: 'New Leads', icon: 'ph-sparkle', color: 'var(--primary)' },
        { id: 'Contacted', label: 'Contacted', icon: 'ph-phone-call', color: '#3b82f6' },
        { id: 'Negotiating', label: 'Negotiating', icon: 'ph-handshake', color: '#f59e0b' },
        { id: 'Closed', label: 'Closed / Won', icon: 'ph-check-circle', color: 'var(--success)' }
    ];

    container.innerHTML = `
        <div class="section-header" style="margin-bottom: 2rem;">
            <div>
                <h2 style="font-size: 1.75rem; color: var(--text-main);">Lead Pipeline</h2>
                <p style="color: var(--text-muted); font-size: 0.95rem;">Manage your property inquiries through the sales funnel.</p>
            </div>
            <div style="display: flex; gap: 0.75rem;">
                <div class="badge" style="background: var(--bg-hover); color: var(--text-muted); padding: 0.5rem 1rem; border-radius: 20px;">
                    <i class="ph ph-users"></i> ${inquiries.length} Total Leads
                </div>
            </div>
        </div>

        <div class="crm-kanban" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; align-items: start;">
            ${stages.map(stage => renderCRMColumn(stage, inquiries)).join('')}
        </div>
    `;

    // Attach listeners
    attachCRMListeners(container);
}

function renderCRMColumn(stage, allInquiries) {
    const stageInquiries = allInquiries.filter(i => (i.pipelineStatus || 'New') === stage.id);
    
    return `
        <div class="crm-column" data-stage="${stage.id}" style="background: var(--bg-hover); border-radius: var(--radius-md); padding: 1rem; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 1rem; min-height: 500px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 0.75rem; border-bottom: 2px solid ${stage.color};">
                <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--text-main); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em;">
                    <i class="ph ${stage.icon}" style="color: ${stage.color}; font-size: 1.1rem;"></i>
                    ${stage.label}
                </div>
                <span class="badge" style="background: white; color: var(--text-muted); font-size: 0.75rem;">${stageInquiries.length}</span>
            </div>
            
            <div class="crm-cards" style="display: flex; flex-direction: column; gap: 0.75rem;">
                ${stageInquiries.length === 0 
                    ? `<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.85rem; border:1px dashed var(--border-color); border-radius:var(--radius-sm);">No leads here</div>`
                    : stageInquiries.map(renderCRMCard).join('')
                }
            </div>
        </div>
    `;
}

function renderCRMCard(inq) {
    const lastActivity = inq.replies && inq.replies.length > 0 
        ? new Date(inq.replies[inq.replies.length - 1].date).toLocaleDateString()
        : new Date(inq.date).toLocaleDateString();

    const currencyFormatter = new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
    });

    const prop = EstatoStorage.getPropertyById(inq.propertyId);
    const price = prop ? currencyFormatter.format(prop.price) : 'N/A';

    return `
        <div class="crm-card surface-panel shadow-sm" data-id="${inq.id}" style="padding: 1rem; cursor: pointer; transition: all 0.2s ease; border-left: 4px solid var(--primary);">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <strong style="font-size: 0.95rem; color: var(--text-main);">${escapeHtml(inq.buyerName)}</strong>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${lastActivity}</span>
            </div>
            
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                <i class="ph ph-house" style="margin-right: 4px;"></i> ${escapeHtml(inq.propertyTitle)}
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
                <span style="font-weight: 700; color: var(--primary); font-size: 0.85rem;">${price}</span>
                <div style="display: flex; gap: 0.25rem;">
                    <button class="btn btn-sm btn-secondary move-btn" data-id="${inq.id}" title="Move Stage">
                        <i class="ph ph-arrows-left-right"></i>
                    </button>
                    <button class="btn btn-sm btn-primary view-inq-btn" data-id="${inq.id}" title="Open Chat">
                        <i class="ph ph-chat-centered-text"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function attachCRMListeners(container) {
    container.querySelectorAll('.crm-card').forEach(card => {
        card.addEventListener('mouseenter', () => card.style.transform = 'translateY(-2px)');
        card.addEventListener('mouseleave', () => card.style.transform = 'translateY(0)');
    });

    container.querySelectorAll('.view-inq-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            // Logic to open messages with this inquiry
            if (window.openInquiryChat) window.openInquiryChat(id);
        });
    });

    container.querySelectorAll('.move-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            showMoveMenu(btn, id);
        });
    });
}

function showMoveMenu(anchor, inqId) {
    const stages = [
        { id: 'New', label: 'Move to New', icon: 'ph-sparkle' },
        { id: 'Contacted', label: 'Move to Contacted', icon: 'ph-phone-call' },
        { id: 'Negotiating', label: 'Move to Negotiating', icon: 'ph-handshake' },
        { id: 'Closed', label: 'Move to Closed', icon: 'ph-check-circle' }
    ];

    const menu = document.createElement('div');
    menu.className = 'surface-panel shadow-lg';
    menu.style.cssText = `
        position: fixed;
        z-index: 10000;
        min-width: 180px;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        padding: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    `;

    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 5) + 'px';
    menu.style.left = (rect.left + window.scrollX - 140) + 'px';

    menu.innerHTML = stages.map(s => `
        <button class="btn btn-ghost w-full stage-option" data-stage="${s.id}" style="justify-content: flex-start; gap: 0.75rem; font-size: 0.85rem; padding: 0.6rem 0.8rem;">
            <i class="ph ${s.icon}"></i> ${s.label}
        </button>
    `).join('');

    document.body.appendChild(menu);

    const closeMenu = () => menu.remove();
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);

    menu.querySelectorAll('.stage-option').forEach(opt => {
        opt.addEventListener('click', async () => {
            const newStatus = opt.getAttribute('data-stage');
            const success = await EstatoStorage.updateInquiryPipelineStatus(inqId, newStatus);
            if (success) {
                showToast(`Lead moved to ${newStatus}`, 'success');
                // Re-render handled by storage subscription in main.js
            }
            closeMenu();
        });
    });
}
