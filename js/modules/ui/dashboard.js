import { escapeHtml } from './utils.js';

export function renderDashboard(ctx) {
    const { 
        currentUser, EstatoStorage, viewContainer, dashboardCharts = [],
        currencyFormatter, generatePropertyCard, Chart, attachCardListeners,
        seedDummyData, exportBackup, handleRestore, renderAdminActivityFeed
    } = ctx;

    // Clear existing charts
    dashboardCharts.forEach(chunk => chunk.destroy());
    dashboardCharts.length = 0;

    const stats = EstatoStorage.getDashboardStats(currentUser.role === 'Admin' ? null : currentUser.id);

    let html = `
        <div class="section-header" style="margin-bottom: 2rem;">
            <h2>Market Overview</h2>
            <p>Real-time insights and analytics for your portfolio.</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon"><i class="ph-duotone ph-buildings"></i></div>
                <div class="stat-info">
                    <h4>Total Listings</h4>
                    <p>${stats.totalProperties}</p>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon"><i class="ph-duotone ph-currency-inr"></i></div>
                <div class="stat-info">
                    <h4>${currentUser.role === 'Admin' ? 'Market Avg' : 'Portfolio Avg'}</h4>
                    <p style="font-size: 1.25rem;">${currencyFormatter.format(stats.marketAvg || 0)} <small>Total</small></p>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon" style="background: var(--danger-light); color: var(--danger);"><i class="ph-duotone ph-house-line"></i></div>
                <div class="stat-info">
                    <h4>Pending Approvals</h4>
                    <p>${stats.pendingCount}</p>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon" style="background: var(--success-light); color: var(--success);"><i class="ph-duotone ph-check-circle"></i></div>
                <div class="stat-info">
                    <h4>Available</h4>
                    <p>${stats.availableCount}</p>
                </div>
            </div>
        </div>

        <div class="dashboard-valuation">
            <h4>Total Portfolio Valuation</h4>
            <p>${currencyFormatter.format(stats.totalValuation)}</p>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 3rem;">
            <div class="surface-panel" style="height: 350px;">
                <h4 style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.9rem;">LISTINGS DEPLOYMENT BY CITY</h4>
                <canvas id="cityCountChart"></canvas>
            </div>
            <div class="surface-panel" style="height: 350px;">
                <h4 style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.9rem;">AVERAGE VALUATION BY CITY (INR)</h4>
                <canvas id="cityPriceChart"></canvas>
            </div>
        </div>

        ${(currentUser.role === 'Admin') ? `
            <div class="admin-approval-section" style="margin-bottom: 3rem; animation: fadeIn 0.4s ease-out;">
                <div class="section-header" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--danger);">
                            <i class="ph ph-list-checks"></i> Queue for Verification
                        </h3>
                        <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Please review and authorize the following listings.</p>
                    </div>
                </div>

                ${(() => {
                    const pendingItems = EstatoStorage.getProperties().filter(p => p.status === 'Pending');
                    if (pendingItems.length === 0) {
                        return `
                            <div class="empty-state surface-panel" style="padding: 3rem; text-align: center; border: 1px dashed var(--border-color); background: var(--bg-hover);">
                                <i class="ph ph-check-circle" style="font-size: 2.5rem; color: var(--success); opacity: 0.6; margin-bottom: 1rem;"></i>
                                <h4 style="margin: 0; color: var(--text-muted);">All caught up! No pending approvals.</h4>
                            </div>
                        `;
                    }
                    
                    // Show only first 3 in dashboard for performance/clutter
                    const slice = pendingItems.slice(0, 3);
                    return `
                        <div class="admin-queue-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem;">
                            ${slice.map(p => generatePropertyCard(p)).join('')}
                        </div>
                        ${pendingItems.length > 3 ? `
                            <div style="text-align: center; margin-top: 1.5rem;">
                                <button class="btn btn-secondary shadow-hover" onclick="window.renderProperties('Properties'); document.getElementById('statusSelect').value='Pending'; document.getElementById('statusSelect').dispatchEvent(new Event('change'));">
                                    View All ${pendingItems.length} Pending Listings <i class="ph ph-arrow-right"></i>
                                </button>
                            </div>
                        ` : ''}
                    `;
                })()}
            </div>

            <div class="section-header" style="margin-bottom: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 3rem;">
                <h2 style="color: var(--danger);">Admin Zone</h2>
                <p>System configuration and batch operations.</p>
            </div>
            <div style="display: grid; gap: 1.5rem;">
                <div class="surface-panel" style="padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; border: 1px dashed var(--border-color); background: var(--bg-hover);">
                    <div>
                        <h4 style="margin: 0 0 5px 0;">Data Portability</h4>
                        <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">Backup your entire marketplace state or restore from a previous JSON dump.</p>
                    </div>
                    <div style="display: flex; gap: 0.75rem;">
                        <button class="btn btn-secondary shadow-hover" id="backupDataBtn" style="background: white; border: 1px solid var(--border-color);">
                            <i class="ph ph-download"></i> Backup Data
                        </button>
                        <button class="btn btn-secondary shadow-hover" id="restoreDataBtn" style="background: white; border: 1px solid var(--border-color);">
                            <i class="ph ph-upload"></i> Restore Data
                        </button>
                    </div>
                    <input type="file" id="restoreFilePicker" accept=".json" style="display: none;">
                </div>
            </div>

            ` : ''}
    `;

    // Admin Activity feed insertion
    if (currentUser.role === 'Admin' && renderAdminActivityFeed) {
        html += renderAdminActivityFeed();
    }

    viewContainer.innerHTML = html;
    if (attachCardListeners) attachCardListeners();

    // Admin Tools listener
    const seedBtnDashboard = document.getElementById('seedDataBtn');
    if (seedBtnDashboard) seedBtnDashboard.addEventListener('click', () => seedDummyData && seedDummyData(1));

    const backupBtn = document.getElementById('backupDataBtn');
    if (backupBtn) backupBtn.addEventListener('click', () => exportBackup && exportBackup());

    const restoreBtn = document.getElementById('restoreDataBtn');
    const restoreInput = document.getElementById('restoreFilePicker');
    if (restoreBtn && restoreInput) {
        restoreBtn.addEventListener('click', () => restoreInput.click());
        restoreInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleRestore && handleRestore(file);
        });
    }

    // Initialize Charts
    const cityLabels = Object.keys(stats.avgPriceByCity);
    const cityCounts = cityLabels.map(city => {
        const props = EstatoStorage.getProperties().filter(p => p.city === city);
        return (currentUser.role === 'Seller') ? props.filter(p => p.ownerId === currentUser.id).length : props.length;
    });

    // 1. City Count Chart
    const ctxCount = document.getElementById('cityCountChart');
    if (ctxCount && Chart) {
        dashboardCharts.push(new Chart(ctxCount, {
            type: 'bar',
            data: {
                labels: cityLabels,
                datasets: [{
                    label: 'Listings',
                    data: cityCounts,
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
        }));
    }

    // 2. City Price Chart
    const ctxPrice = document.getElementById('cityPriceChart');
    if (ctxPrice && Chart) {
        dashboardCharts.push(new Chart(ctxPrice, {
            type: 'bar',
            data: {
                labels: cityLabels,
                datasets: [{
                    label: 'Avg Price',
                    data: Object.values(stats.avgPriceByCity),
                    backgroundColor: '#0ea5e9',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: (c) => currencyFormatter.format(c.raw) }
                    }
                },
                scales: {
                    y: { 
                        beginAtZero: true, 
                        ticks: { 
                            color: '#7d746d',
                            callback: (val) => val >= 10000000 ? (val/10000000).toFixed(1) + ' Cr' : val >= 100000 ? (val/100000).toFixed(0) + ' L' : val
                        }, 
                        grid: { color: '#e5e0d8' } 
                    },
                    x: { ticks: { color: '#7d746d' }, grid: { display: false } }
                }
            }
        }));
    }
}
