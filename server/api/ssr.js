const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const admin = require('../helpers/firebase');

// --- SSR Helpers ---
function isBot(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|rogerbot|embedly|quora|outbrain|pinterest|slackbot|vkshare|w3c_validator|lighthouse|pagespeed|headlesschrome|prerender/.test(ua);
}

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtPrice(price) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(price || 0);
}

function buildPrerenderedBlock(prop, propId, host) {
    const priceStr = fmtPrice(prop.price);
    const amenitiesHtml = (prop.amenities || []).map(a => `<span class="ssr-tag">${esc(a)}</span>`).join('');
    const img = prop.images && prop.images.length > 0
        ? esc(prop.images[0].replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0])
        : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=800&auto=format&fit=crop';

    return `
<style>
  #ssr-shell{font-family:'Outfit',sans-serif;max-width:960px;margin:0 auto;padding:2rem 1rem;background:#fff;color:#1e1b18;}
  #ssr-shell img{width:100%;height:360px;object-fit:cover;border-radius:12px;display:block;margin-bottom:1.5rem;}
  #ssr-shell h1{font-size:1.8rem;font-weight:800;margin:0 0 0.5rem;}
  #ssr-shell .ssr-price{font-size:1.5rem;font-weight:700;color:#ea580c;margin-bottom:1rem;}
  #ssr-shell .ssr-meta{display:flex;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.5rem;}
  #ssr-shell .ssr-chip{background:#f1f5f9;border-radius:20px;padding:0.3rem 0.8rem;font-size:0.85rem;font-weight:600;}
  #ssr-shell .ssr-desc{font-size:1rem;line-height:1.7;color:#4a4540;margin-bottom:1.5rem;}
  #ssr-shell .ssr-tag{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:6px;padding:0.2rem 0.6rem;font-size:0.8rem;margin-right:0.4rem;}
  #ssr-shell .ssr-breadcrumb{font-size:0.85rem;color:#94a3b8;margin-bottom:1rem;}
  #ssr-shell .ssr-breadcrumb a{color:#ea580c;text-decoration:none;}
  #ssr-shell .ssr-badge{background:#ea580c;color:white;border-radius:6px;padding:0.2rem 0.7rem;font-size:0.8rem;font-weight:700;display:inline-block;margin-bottom:1rem;}
  #ssr-shell .ssr-cta{display:inline-block;background:#ea580c;color:white;border-radius:8px;padding:0.75rem 1.5rem;font-weight:700;text-decoration:none;margin-top:1rem;}
  #ssr-shell table{width:100%;border-collapse:collapse;margin:1rem 0;}
  #ssr-shell td{padding:0.6rem 0.8rem;border-bottom:1px solid #f1f5f9;font-size:0.9rem;}
  #ssr-shell td:first-child{font-weight:600;color:#64748b;width:40%;}
</style>
<div id="ssr-shell">
  <nav class="ssr-breadcrumb"><a href="https://${esc(host)}/">Estato</a> &rsaquo; <a href="https://${esc(host)}/">Properties in ${esc(prop.city)}</a> &rsaquo; ${esc(prop.title)}</nav>
  <span class="ssr-badge">${esc(prop.type)} &bull; ${esc(prop.status)}</span>
  <img src="${img}" alt="${esc(prop.title)} in ${esc(prop.city)}" loading="eager">
  <h1>${esc(prop.title)}</h1>
  <div class="ssr-price">${priceStr}${prop.type === 'Rent' ? ' / mo' : ''}</div>
  <div class="ssr-meta">
    ${prop.bhk ? `<span class="ssr-chip">&#127968; ${esc(prop.bhk)}</span>` : ''}
    ${prop.category ? `<span class="ssr-chip">&#127959; ${esc(prop.category)}</span>` : ''}
    ${prop.area ? `<span class="ssr-chip">&#128207; ${esc(String(prop.area))} sq.ft</span>` : ''}
    ${prop.city ? `<span class="ssr-chip">&#128205; ${esc(prop.city)}</span>` : ''}
  </div>
  <table>
    ${prop.address ? `<tr><td>Address</td><td>${esc(prop.address)}${prop.pinCode ? ` &mdash; ${esc(prop.pinCode)}` : ''}</td></tr>` : ''}
    <tr><td>Transaction Type</td><td>${esc(prop.type)}</td></tr>
    <tr><td>Property Category</td><td>${esc(prop.category || 'N/A')}</td></tr>
    ${prop.bhk ? `<tr><td>Configuration</td><td>${esc(prop.bhk)}</td></tr>` : ''}
    ${prop.area ? `<tr><td>Super Built-Up Area</td><td>${esc(String(prop.area))} sq.ft</td></tr>` : ''}
    ${prop.ownerName ? `<tr><td>Listed By</td><td>${esc(prop.ownerName)}</td></tr>` : ''}
  </table>
  ${prop.description ? `<p class="ssr-desc">${esc(prop.description)}</p>` : ''}
  ${amenitiesHtml ? `<div style="margin-bottom:1.5rem;"><strong style="display:block;margin-bottom:0.5rem;">Amenities & Features</strong>${amenitiesHtml}</div>` : ''}
  <a class="ssr-cta" href="https://${esc(host)}/property/${esc(propId)}">View Full Listing &rarr;</a>
</div>`;
}

// --- SSR Route ---
router.get('/:id', async (req, res) => {
    const propId = req.params.id;
    // Priority: use the path defined by the environment (dev or prod) in server.js
    const indexPath = req.indexPath || path.join(__dirname, '../../public/index.html'); 

    if (propId.includes('.') || propId.includes('#') || propId.includes('[')) {
        return res.sendFile(path.join(__dirname, '../../public', propId), err => {
            if (err) res.sendFile(indexPath);
        });
    }

    try {
        if (!fs.existsSync(indexPath)) return res.status(500).send('Production index.html missing. Please run build.');
        let html = fs.readFileSync(indexPath, 'utf8');
        const host = req.get('host') || 'estatemarket.web.app';
        const canonicalUrl = `https://${host}/property/${propId}`;
        const bot = isBot(req);

        if (admin.apps.length > 0) {
            const propSnap = await admin.database().ref(`properties/${propId}`).once('value');
            const prop = propSnap.val();

            if (prop) {
                const title = `${prop.title} | Estato — ${prop.bhk || ''} ${prop.type} in ${prop.city}`.trim();
                const priceFormatted = new Intl.NumberFormat('en-IN').format(prop.price);
                const desc = `${prop.bhk || ''} ${prop.category || 'Property'} for ${prop.type} in ${prop.city}. Price: ₹${priceFormatted}. ${prop.description ? prop.description.substring(0, 120) + '...' : ''}`.trim();
                const ogImage = prop.images && prop.images.length > 0
                    ? prop.images[0].replace('thumbnail?id=', 'uc?export=view&id=').split('&sz=')[0]
                    : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?q=80&w=1200&auto=format&fit=crop';

                html = html.replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`);
                html = html.replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${esc(desc)}">`);
                html = html.replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${esc(title)}">`);
                html = html.replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${esc(desc)}">`);
                html = html.replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${esc(ogImage)}">`);

                if (bot) {
                    const ssrContent = buildPrerenderedBlock(prop, propId, host);
                    html = html.replace('<div id="viewContainer" class="view-content"></div>', `<div id="viewContainer" class="view-content">${ssrContent}</div>`);
                }
            }
        }
        res.send(html);
    } catch (err) {
        console.error('[SSR Error]', err);
        res.sendFile(indexPath);
    }
});

module.exports = router;
