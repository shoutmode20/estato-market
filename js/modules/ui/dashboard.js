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

    const stats = EstatoStorage.getStats(currentUser.role === 'Admin' ? null : currentUser.id);

    const isBroker = currentUser.role === 'Broker';
    const brokerCommission = stats.totalValuation * 0.02; // 2% commission assumption
    
    let html = `
        <div class="section-header" style="margin-bottom: 2rem;">
            <h2>Market Overview</h2>
            <p>Real-time insights and analytics for your portfolio.</p>
        </div>

        ${(isBroker && (!currentUser.verification || currentUser.verification.status !== 'Approved')) ? `
        <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 1.5rem; border-radius: var(--radius-md); margin-bottom: 2rem; display: flex; align-items: center; justify-content: space-between;">
            <div>
                <h4 style="color: #92400e; margin: 0; display: flex; align-items: center; gap: 0.5rem;"><i class="ph-fill ph-warning-circle"></i> Verification Required</h4>
                <p style="color: #b45309; margin: 0; font-size: 0.9rem;">To receive your "Verified Broker" badge, please submit your RERA or State License number.</p>
            </div>
            ${(currentUser.verification && currentUser.verification.status === 'Pending') ? `
                <span class="badge badge-warning" style="padding: 0.5rem 1rem;">Verification Pending</span>
            ` : `
                <button class="btn btn-secondary btn-sm" style="background: white; border-color: #fde68a; color: #92400e;" onclick="window.openBrokerVerification()">Verify Now</button>
            `}
        </div>
        ` : ''}

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon"><i class="ph-duotone ph-buildings"></i></div>
                <div class="stat-info">
                    <h4>Total Listings</h4>
                    <p>${stats.totalProperties}</p>
                </div>
            </div>
            ${isBroker ? `
            <div class="stat-card">
                <div class="stat-icon" style="background: #eff6ff; color: #3b82f6;"><i class="ph-duotone ph-users"></i></div>
                <div class="stat-info">
                    <h4>Total Clients</h4>
                    <p>${stats.totalProperties === 0 ? 0 : Math.floor(stats.totalProperties * 0.75) + 1}</p>
                </div>
            </div>
            ` : `
            <div class="stat-card">
                <div class="stat-icon"><i class="ph-duotone ph-currency-inr"></i></div>
                <div class="stat-info">
                    <h4>${currentUser.role === 'Admin' ? 'Market Avg' : 'Portfolio Avg'}</h4>
                    <p style="font-size: clamp(1rem, 2vw, 1.25rem); word-break: break-word; overflow-wrap: break-word;">${currencyFormatter.format(stats.marketAvg || 0)} <br><small style="font-size: 0.8rem;">Total</small></p>
                </div>
            </div>
            `}
            <div class="stat-card">
                <div class="stat-icon" style="background: var(--danger-light); color: var(--danger);"><i class="ph-duotone ph-house-line"></i></div>
                <div class="stat-info">
                    <h4>Pending Approvals</h4>
                    <p>${stats.pendingCount}</p>
                </div>
            </div>
            <div class="stat-card" style="background: var(--primary-light); border: 1px solid var(--primary); cursor: pointer;" onclick="window.openWalletModal()">
                <div class="stat-icon" style="background: white; color: var(--primary);"><i class="ph-duotone ph-wallet"></i></div>
                <div class="stat-info">
                    <h4>Wallet Balance</h4>
                    <p style="font-size: clamp(1rem, 2vw, 1.25rem); word-break: break-word; overflow-wrap: break-word;">${currencyFormatter.format(EstatoStorage.getWalletBalance())}</p>
                </div>
            </div>
            ${(currentUser.role === 'Admin' || currentUser.role === 'Seller' || isBroker) ? `
            <div class="stat-card" style="background: #fef2f2; border: 1px solid #fee2e2;">
                <div class="stat-icon" style="background: white; color: #dc2626;"><i class="ph-duotone ph-gavel"></i></div>
                <div class="stat-info">
                    <h4>Active Auctions</h4>
                    <p style="font-size: 1.25rem;">${stats.activeAuctions || 0}</p>
                </div>
            </div>
            <div class="stat-card" style="background: #f0fdf4; border: 1px solid #dcfce7;">
                <div class="stat-icon" style="background: white; color: #16a34a;"><i class="ph-duotone ph-chart-line-up"></i></div>
                <div class="stat-info">
                    <h4>Total Bids</h4>
                    <p style="font-size: 1.25rem;">${stats.totalBids || 0}</p>
                </div>
            </div>
            ` : ''}
        </div>

        <div class="dashboard-valuation">
            <h4>${isBroker ? 'Est. Commission Pipeline (2%)' : 'Total Portfolio Valuation'}</h4>
            <p style="font-size: clamp(1.2rem, 3vw, 2.5rem); font-weight: 800; color: var(--primary); word-break: break-word; overflow-wrap: break-word;">${currencyFormatter.format(isBroker ? brokerCommission : stats.totalValuation)}</p>
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

        <!-- NEW: My Listings Preview Secion -->
        <div class="user-listings-section" style="margin-bottom: 3rem; animation: fadeIn 0.4s ease-out;">
            <div class="section-header" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border-color); padding-top: 2rem;">
                <div>
                    <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--primary);">
                        <i class="ph ph-house-line"></i> My Managed Listings
                    </h3>
                    <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Quick overview of your current active portfolio.</p>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="window.viewMyListings()">
                    View All My Listings <i class="ph ph-arrow-right"></i>
                </button>
            </div>

            ${(() => {
                const myItems = EstatoStorage.getProperties().filter(p => p.ownerId === currentUser.id);
                if (myItems.length === 0) {
                    return `
                        <div class="empty-state surface-panel" style="padding: 2.5rem; text-align: center; border: 1px dashed var(--border-color); background: var(--bg-hover);">
                            <i class="ph ph-buildings" style="font-size: 2rem; color: var(--text-muted); opacity: 0.4; margin-bottom: 1rem;"></i>
                            <h4 style="margin: 0; color: var(--text-muted);">You haven't listed any properties yet.</h4>
                            <button class="btn btn-primary btn-sm" style="margin-top: 1rem;" onclick="window.openModal()">Add First Listing</button>
                        </div>
                    `;
                }
                
                // Show only first 4 in dashboard for performance/clutter
                const slice = myItems.slice(0, 4);
                return `
                    <div class="admin-queue-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem;">
                        ${slice.map(p => generatePropertyCard(p)).join('')}
                    </div>
                `;
            })()}
        </div>

        ${(currentUser.role === 'Seller' || currentUser.role === 'Admin') ? `
        <!-- NEW: My Properties in Auction (For Sellers) -->
        <div class="user-auctions-section" style="margin-bottom: 3rem; animation: fadeIn 0.4s ease-out;">
            <div class="section-header" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border-color); padding-top: 2rem;">
                <div>
                    <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: #f97316;">
                        <i class="ph ph-gavel"></i> My Properties in Auction
                    </h3>
                    <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Monitor and manage your active auction listings.</p>
                </div>
            </div>

            ${(() => {
                const myAuctions = EstatoStorage.getProperties().filter(p => p.ownerId === currentUser.id && p.bidding?.enabled);
                if (myAuctions.length === 0) {
                    return `
                        <div class="empty-state surface-panel" style="padding: 2rem; text-align: center; background: var(--bg-hover); border-radius: var(--radius-md);">
                            <p style="color: var(--text-muted); margin: 0;">You don't have any properties currently in auction.</p>
                        </div>
                    `;
                }
                
                return `
                    <div class="admin-queue-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem;">
                        ${myAuctions.map(p => generatePropertyCard(p)).join('')}
                    </div>
                `;
            })()}
        </div>
        ` : ''}

        <!-- NEW: My Active Bids Section (For Buyers) -->
        <div class="active-bids-section" style="margin-bottom: 3rem; animation: fadeIn 0.4s ease-out;">
            <div class="section-header" style="margin-bottom: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 2rem;">
                <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: #ef4444;">
                    <i class="ph ph-gavel"></i> My Active Auction Bids
                </h3>
                <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Auctions you are currently participating in.</p>
            </div>

            ${(() => {
                const properties = EstatoStorage.getProperties();
                const myBids = properties.filter(p => {
                    const participants = p.bidding?.participants || {};
                    return !!participants[currentUser.id];
                });

                if (myBids.length === 0) {
                    return `
                        <div class="empty-state surface-panel" style="padding: 2rem; text-align: center; background: var(--bg-hover); border-radius: var(--radius-md);">
                            <p style="color: var(--text-muted); margin: 0;">You haven't joined any auctions yet.</p>
                        </div>
                    `;
                }

                return `
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem;">
                        ${myBids.map(p => generatePropertyCard(p)).join('')}
                    </div>
                `;
            })()}
        </div>

        ${(currentUser.role === 'Admin') ? `
            <div class="admin-approval-section" style="margin-bottom: 3rem; animation: fadeIn 0.4s ease-out;">
                <!-- Broker Verification Queue -->
                <div class="surface-panel" style="padding: 2rem; margin-bottom: 2rem; border-left: 5px solid var(--primary); background: var(--bg-hover);">
                    <div class="section-header" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between;">
                        <div>
                            <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--primary);">
                                <i class="ph ph-shield-check"></i> Broker Verification Queue
                            </h3>
                            <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Review professional credentials and grant "Verified" badges.</p>
                        </div>
                    </div>

                    ${(() => {
                        const pendingBrokers = EstatoStorage.getUsers().filter(u => u.role === 'Broker' && u.verification && u.verification.status === 'Pending');
                        if (pendingBrokers.length === 0) {
                            return `<p style="text-align: center; color: var(--text-muted); font-size: 0.9rem;">No pending broker verifications.</p>`;
                        }
                        return `
                            <div style="display: grid; gap: 1rem;">
                                ${pendingBrokers.map(u => `
                                    <div class="surface-panel" style="padding: 1rem 1.5rem; display: flex; align-items: center; justify-content: space-between; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                                        <div style="display: flex; align-items: center; gap: 1rem;">
                                            <div style="width: 40px; height: 40px; background: var(--primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800;">
                                                ${(u.name || 'B').charAt(0)}
                                            </div>
                                            <div>
                                                <div style="font-weight: 600;">${escapeHtml(u.name || 'Unknown')}</div>
                                                <div style="font-size: 0.75rem; color: var(--text-muted);">License: <span style="color: var(--text-main); font-family: monospace;">${escapeHtml(u.verification.license)}</span></div>
                                                <div style="font-size: 0.75rem; color: var(--text-muted);">Agency: <span style="color: var(--text-main);">${escapeHtml(u.verification.agency)}</span> | Exp: <span style="color: var(--text-main);">${u.verification.experience}y</span></div>
                                            </div>
                                        </div>
                                        <div style="display: flex; gap: 0.5rem;">
                                            <button class="btn btn-secondary btn-sm approve-broker-btn" data-uid="${u.id}" style="background: var(--success); color: white; border: none;">Approve</button>
                                            <button class="btn btn-secondary btn-sm reject-broker-btn" data-uid="${u.id}" style="background: var(--danger); color: white; border: none;">Reject</button>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        `;
                    })()}
                </div>

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
                                <button class="btn btn-secondary shadow-hover" onclick="document.querySelector('[data-view=\\'properties\\']').click(); document.getElementById('statusSelect').value='Pending'; document.getElementById('statusSelect').dispatchEvent(new Event('change'));">
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
