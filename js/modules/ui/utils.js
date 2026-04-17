/**
 * Core UI Utilities
 * Extracted from monolithic app.v12.js for isolated modularity & testing.
 */

export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function showToast(message, type = 'info', duration = 4500) {
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

export function showConfirm(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;`;
    
    overlay.innerHTML = `
        <div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:1.5rem;width:90%;max-width:360px;box-shadow:var(--shadow-lg);animation:slideUpFade 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
            <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;color:var(--text-main);">
                <div style="background:var(--bg-hover);padding:0.5rem;border-radius:50%;color:var(--primary);display:flex;">
                    <i class="ph-duotone ph-question" style="font-size:1.5rem;"></i>
                </div>
                <h3 style="font-size:1.1rem;font-weight:600;margin:0;">Confirm Action</h3>
            </div>
            <p style="color:var(--text-muted);font-size:0.95rem;margin-bottom:1.5rem;line-height:1.5;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>
            <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                <button id="cancelBtn" class="btn btn-secondary shadow-hover" style="flex:1;">Cancel</button>
                <button id="confirmBtn" class="btn btn-primary shadow-hover" style="flex:1;">Confirm</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    document.getElementById('confirmBtn').addEventListener('click', () => {
        overlay.remove();
        if (onConfirm) onConfirm();
    });
    
    document.getElementById('cancelBtn').addEventListener('click', () => {
        overlay.remove();
        if (onCancel) onCancel();
    });
}
