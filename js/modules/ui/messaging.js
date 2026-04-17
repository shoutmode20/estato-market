import { escapeHtml, showConfirm } from './utils.js';

export function renderMessages(ctx) {
    const { currentUser, EstatoStorage, viewContainer } = ctx;
    const inquiries = EstatoStorage.getInquiries(currentUser.role === 'Seller' ? currentUser.id : null);

    let html = `
        <div class="section-header">
            <div>
                <h2>Internal Messaging</h2>
                <p>Direct inquiries and communication thread.</p>
            </div>
        </div>
    `;

    if (inquiries.length === 0) {
        html += `
            <div class="empty-state surface-panel" style="padding: 4rem 2rem; text-align: center;">
                <i class="ph-duotone ph-chat-centered-slash" style="font-size: 3.5rem; color: var(--text-muted); opacity: 0.5; margin-bottom: 1.5rem;"></i>
                <h3 style="margin-bottom: 0.5rem;">No conversations yet</h3>
                <p style="color: var(--text-muted);">When buyers inquire about your listings, they'll appear here.</p>
            </div>
        `;
    } else {
        html += `
            <div class="message-threads" style="display: flex; flex-direction: column; gap: 1.5rem;">
                ${inquiries.map(inq => {
            const thread = [
                { 
                    id: 'msg_root',
                    senderId: inq.buyerId, 
                    senderName: inq.buyerName, 
                    senderRole: 'Buyer', 
                    message: inq.message, 
                    date: inq.date || inq.timestamp 
                },
                ...(inq.replies || []).map(r => ({ ...r, date: r.date || r.timestamp }))
            ];

            return `
                        <div class="surface-panel shadow-sm message-card ${inq.status === 'Unread' ? 'unread-glow' : ''}" style="padding: 1.5rem; transition: transform 0.2s;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem;">
                                <div style="display: flex; gap: 1rem; align-items: center;">
                                    <div class="avatar" style="background: var(--primary-light); color: var(--primary); font-weight: 700;">${inq.buyerName.charAt(0)}</div>
                                    <div>
                                        <h4 style="margin: 0; font-size: 1rem;">${escapeHtml(inq.buyerName)}</h4>
                                        <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted);">${inq.buyerEmail}</p>
                                    </div>
                                </div>
                                <div style="text-align: right;">
                                    <span class="badge ${inq.status === 'Unread' ? 'badge-primary' : 'badge-secondary'}" style="margin-bottom: 4px;">${inq.status}</span>
                                    <div style="font-size: 0.75rem; color: var(--text-muted);">Re: ${escapeHtml(inq.propertyTitle)}</div>
                                </div>
                            </div>
                            
                            <div class="thread-container" style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem; background: var(--bg-hover); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                ${thread.map(msg => {
                const isMe = (currentUser.id === msg.senderId);
                return `
                                        <div style="display: flex; flex-direction: column; align-items: ${isMe ? 'flex-end' : 'flex-start'}; position: relative; group;">
                                            <div class="message-bubble" style="max-width: 85%; padding: 0.75rem 1rem; border-radius: ${isMe ? '15px 15px 2px 15px' : '15px 15px 15px 2px'}; background: ${isMe ? 'var(--primary)' : 'white'}; color: ${isMe ? 'white' : 'var(--text-main)'}; border: ${isMe ? 'none' : '1px solid var(--border-color)'}; font-size: 0.92rem; line-height: 1.5; box-shadow: 0 1px 2px rgba(0,0,0,0.05); position: relative;">
                                                ${escapeHtml(msg.message)}
                                                ${isMe ? `
                                                    <button class="msg-delete-btn" data-inq-id="${inq.id}" data-msg-id="${msg.id}" title="Delete Message" style="position: absolute; top: -8px; left: -20px; background: var(--surface); border: 1px solid var(--border-color); border-radius: 50%; width: 21px; height: 21px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--danger); font-size: 0.75rem; opacity: 0; transition: opacity 0.2s; z-index: 10;"><i class="ph ph-x"></i></button>
                                                ` : ''}
                                            </div>
                                            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px; padding: 0 4px;">
                                                ${msg.senderName} • ${new Date(msg.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                    `;
            }).join('')}
                            </div>

                            <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
                                <button class="btn btn-secondary shadow-hover thread-delete-btn" data-id="${inq.id}" title="Delete Entire Conversation" style="padding: 0.5rem; color: var(--danger);"><i class="ph ph-trash"></i></button>
                                <button class="btn btn-primary shadow-hover thread-reply-btn" data-id="${inq.id}" data-buyer="${inq.buyerName}" style="gap: 0.5rem; font-size: 0.85rem; padding: 0.5rem 1.25rem;"><i class="ph ph-arrow-bend-up-left"></i> Reply</button>
                            </div>
                        </div>
                    `;
        }).join('')}
                </div>
                
                <style>
                    .message-bubble:hover .msg-delete-btn { opacity: 1 !important; }
                </style>
            `;
    }

    viewContainer.innerHTML = html;

    // Attach listeners
    viewContainer.querySelectorAll('.thread-reply-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const inqId = btn.getAttribute('data-id');
            const buyer = btn.getAttribute('data-buyer');
            
            const inqIdInput = document.getElementById('replyInqId');
            const targetEl = document.getElementById('replyTargetName');
            
            if (inqIdInput) inqIdInput.value = inqId;
            if (targetEl) targetEl.textContent = buyer;
            
            document.getElementById('replyModal').classList.add('active');
            setTimeout(() => document.getElementById('replyMessage').focus(), 300);
        });
    });

    viewContainer.querySelectorAll('.thread-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const inqId = btn.getAttribute('data-id');
            showConfirm('Remove this conversation from your view? (It will still be visible to the other person)', async () => {
                await EstatoStorage.deleteInquiry(inqId);
            });
        });
    });

    viewContainer.querySelectorAll('.msg-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const inqId = btn.getAttribute('data-inq-id');
            const msgId = btn.getAttribute('data-msg-id');
            const confirmMsg = msgId === 'msg_root' 
                ? 'Delete the starting message? This will clear the inquiry text for everyone.' 
                : 'Delete this message for everyone?';
            
            showConfirm(confirmMsg, async () => {
                if (msgId === 'msg_root') {
                    // Specific handling for root message clear (Optional, we could just block it)
                    // For now, we'll implement a 'deleteInquiryReply' style for it too if needed.
                    // But we'll stick to our plan.
                    await EstatoStorage.deleteInquiryReply(inqId, msgId);
                } else {
                    await EstatoStorage.deleteInquiryReply(inqId, msgId);
                }
            });
        });
    });
}
