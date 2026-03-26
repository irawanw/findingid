'use strict';
/**
 * GET /p/:id — Dynamic product detail page (SSR)
 *
 * Renders a full product page with AI analysis, reviews, and related products.
 * Falls back gracefully if ai_analysis is not yet generated.
 */
const express  = require('express');
const router   = express.Router();
const db       = require('../services/db');
const analysis = require('../services/productAnalysis');
const { bestVariantDiscount } = require('../services/discount');

function fmt(price) {
  return 'Rp ' + Number(price).toLocaleString('id-ID');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStars(rating, sz = 14) {
  const full  = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)));
  const empty = 5 - full;
  const on  = `<span style="color:#F59E0B;font-size:${sz}px">★</span>`;
  const off = `<span style="color:#E2E8F0;font-size:${sz}px">★</span>`;
  return on.repeat(full) + off.repeat(empty);
}

function scoreBar(label, score) {
  const pct = Math.round((score / 10) * 100);
  return `
  <div class="score-item">
    <div class="score-label-row">
      <span class="score-label">${escHtml(label)}</span>
      <span class="score-num">${score.toFixed(1)} / 10</span>
    </div>
    <div class="score-bar"><div class="score-fill" style="width:0%" data-w="${pct}%"></div></div>
  </div>`;
}

function reviewCard(rv, type) {
  const starCount = rv.star || 5;
  const starsHtml = renderStars(starCount, 11);
  // Parse "Key:value" lines into tags
  const lines = (rv.text || '').split('\n');
  const tags  = lines.filter(l => l.includes(':')).slice(0, 3)
    .map(l => `<span class="review-tag">${escHtml(l.trim())}</span>`).join('');
  const bodyLines = lines.filter(l => !l.includes(':') && l.trim()).join(' ').trim()
    || rv.text?.trim() || '';

  return `
  <div class="review-card ${type}">
    <div class="review-header">
      <span class="review-user">${escHtml(rv.user || 'Pembeli')}</span>
      <div>${starsHtml}</div>
    </div>
    ${tags ? `<div class="review-tags">${tags}</div>` : ''}
    <p class="review-text">${escHtml(bodyLines)}</p>
  </div>`;
}

function relatedCard(p) {
  const dest = p.affiliate_link || p.link || '#';
  const img  = p.image_url?.startsWith('/uploads')
    ? p.image_url
    : `https://via.placeholder.com/200x200/FFF8F3/F97316?text=Produk`;
  return `
  <a class="product-card" href="${escHtml(dest)}" target="_blank" rel="noopener">
    <img class="card-img" src="${escHtml(img)}" alt="${escHtml((p.title || '').slice(0, 60))}"
         loading="lazy" onerror="this.src='https://via.placeholder.com/200x200/FFF8F3/F97316?text=Produk'">
    <div class="card-body">
      <div class="card-title">${escHtml((p.title || '').slice(0, 70))}</div>
      <div class="card-meta">
        <span class="card-price">${fmt(p.price)}</span>
        <span class="card-rating"><span style="color:#F59E0B">★</span> ${Number(p.rating || 0).toFixed(1)}</span>
      </div>
    </div>
  </a>`;
}

function buildPriceChart(rows) {
  if (!rows || rows.length < 2) return '';
  const W = 800, H = 170, PL = 88, PR = 20, PT = 20, PB = 38;
  const CW = W - PL - PR, CH = H - PT - PB;
  const prices = rows.map(r => Number(r.price));
  const times  = rows.map(r => new Date(r.captured_at).getTime());
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pr = hi - lo || 1, tr = times[times.length-1] - times[0] || 1;
  const px = i => PL + (times[i] - times[0]) / tr * CW;
  const py = i => PT + (1 - (prices[i] - lo) / pr) * CH;
  const lineD = rows.map((_, i) => (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(i).toFixed(1)).join(' ');
  const areaD = `M${PL} ${PT+CH} ` + rows.map((_, i) => 'L'+px(i).toFixed(1)+' '+py(i).toFixed(1)).join(' ') + ` L${px(rows.length-1).toFixed(1)} ${PT+CH} Z`;
  const fmtK  = n => 'Rp ' + (n >= 1000000 ? (n/1000000).toFixed(1)+'jt' : n >= 1000 ? (n/1000).toFixed(0)+'k' : n.toFixed(0));
  const fmtD  = ms => { const d = new Date(ms); return d.getDate()+'/'+(d.getMonth()+1); };
  const last  = rows.length - 1;
  const mid   = Math.floor(last / 2);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">
  <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#F97316" stop-opacity=".22"/>
    <stop offset="100%" stop-color="#F97316" stop-opacity=".02"/>
  </linearGradient></defs>
  <path d="${areaD}" fill="url(#pg)"/>
  <line x1="${PL}" y1="${PT}" x2="${W-PR}" y2="${PT}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="${PL}" y1="${(PT+PT+CH)/2}" x2="${W-PR}" y2="${(PT+PT+CH)/2}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="${PL}" y1="${PT+CH}" x2="${W-PR}" y2="${PT+CH}" stroke="#E2E8F0" stroke-width="1"/>
  <text x="${PL-8}" y="${PT+4}" text-anchor="end" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtK(hi)}</text>
  <text x="${PL-8}" y="${(PT+PT+CH)/2+4}" text-anchor="end" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtK((hi+lo)/2)}</text>
  <text x="${PL-8}" y="${PT+CH+4}" text-anchor="end" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtK(lo)}</text>
  <path d="${lineD}" fill="none" stroke="#F97316" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${px(last).toFixed(1)}" cy="${py(last).toFixed(1)}" r="5" fill="#F97316" stroke="white" stroke-width="2.5"/>
  <text x="${PL}" y="${H-6}" text-anchor="middle" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtD(times[0])}</text>
  <text x="${px(mid).toFixed(1)}" y="${H-6}" text-anchor="middle" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtD(times[mid])}</text>
  <text x="${px(last).toFixed(1)}" y="${H-6}" text-anchor="end" font-size="11" fill="#94A3B8" font-family="JetBrains Mono,monospace">${fmtD(times[last])}</text>
</svg>`;
}

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/');

  try {
    // Fetch product
    const [rows] = await db.query(
      `SELECT id, title, price, category, rating, sold_count, sold_display, monthly_sold,
              description, reviews_json, ai_analysis, image_url, images_json,
              variation_images_json, affiliate_link, link, seller_rating, variants_json
       FROM products WHERE id = ? AND is_active = true LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.redirect('/');
    const p = rows[0];

    // Sold display: prefer stored display string ("10RB+"), else format the number
    const soldLabel = p.sold_display || (() => {
      const n = Number(p.sold_count);
      if (!n) return null;
      if (n >= 1000000) return `${Math.floor(n / 1000000)}JT+`;
      if (n >= 1000)    return `${Math.floor(n / 1000)}RB+`;
      return `${n}+`;
    })();

    // Parse AI analysis (may be null — page still works without it)
    let ai = null;
    try { ai = p.ai_analysis ? JSON.parse(p.ai_analysis) : null; } catch (_) {}

    // If no analysis yet, trigger background generation and show loading state
    if (!ai) {
      analysis.generateAndSave(id).catch(() => {});
    }

    // Parse variants — name is "Color,Size" or just "Name" for single-tier
    let variants = [];
    try { variants = JSON.parse(p.variants_json || '[]'); } catch (_) {}

    // Detect if variants are two-tier (Shopee "Color,Size" combined format).
    // Rules:
    //  1. Every variant name contains exactly one comma
    //  2. All right-hand parts (sizes) are identical across different left-hand parts (colors)
    //     i.e. same size options exist for each color → true combinatorial grid
    const isTwoTier = (() => {
      if (!variants.length) return false;
      // Every name must have a comma and neither half should be empty
      if (!variants.every(v => v.name && v.name.includes(','))) return false;
      // Split and verify the right-hand parts form a consistent size set
      const colors = new Set(), sizes = new Set();
      for (const v of variants) {
        const idx = v.name.indexOf(',');
        colors.add(v.name.slice(0, idx).trim());
        sizes.add(v.name.slice(idx + 1).trim());
      }
      // Must have >1 unique value on at least one side
      if (colors.size < 1 || sizes.size < 1) return false;
      // Sanity: total variants shouldn't massively exceed colors×sizes (allows gaps)
      if (variants.length > colors.size * sizes.size * 2) return false;
      return true;
    })();

    // Parse variation_images_json → name→localUrl lookup (authoritative cached images)
    let varImgLookup = {}; // colorName → local image path
    try {
      const vi = JSON.parse(p.variation_images_json || '[]');
      for (const item of vi) if (item.name && item.image_url) varImgLookup[item.name] = item.image_url;
    } catch (_) {}

    // Build tier maps
    // colorMap: { colorName → { image_url } }
    // sizeSet:  ordered unique sizes
    const colorMap  = new Map(); // color → {image_url}
    const sizeOrder = [];
    if (isTwoTier) {
      for (const v of variants) {
        const [color, size] = v.name.split(',');
        // Prefer variation_images_json (cached local), fall back to variants_json image_url
        const img = varImgLookup[color] || v.image_url || null;
        if (!colorMap.has(color)) colorMap.set(color, { image_url: img });
        else if (!colorMap.get(color).image_url && img) colorMap.get(color).image_url = img;
        if (!sizeOrder.includes(size)) sizeOrder.push(size);
      }
    }

    // Build ordered variation image list (for synced gallery + swatches)
    // varImgList: [{name, image_url}] in display order (two-tier = colors, single-tier = all variants)
    const varImgList = (() => {
      if (!Object.keys(varImgLookup).length) return [];
      if (isTwoTier) {
        return [...colorMap.entries()]
          .map(([name, meta]) => ({ name, image_url: meta.image_url }))
          .filter(v => v.image_url);
      }
      // Single-tier: use variant order, deduplicated by name
      const seen = new Set();
      return variants
        .map(v => ({ name: v.name, image_url: varImgLookup[v.name] || v.image_url }))
        .filter(v => v.image_url && !seen.has(v.name) && seen.add(v.name));
    })();

    // Gallery thumbnails: prefer variation images (correctly indexed), fall back to images_json
    const useVarGallery = varImgList.length > 0;
    let extraImages = [];
    if (useVarGallery) {
      // primary = first variation image; extra = rest (shown as thumbs)
      extraImages = varImgList.slice(1).map(v => ({ src: v.image_url, varName: v.name }));
    } else {
      try {
        const imgs = JSON.parse(p.images_json || '[]');
        extraImages = imgs.filter(u => u && u !== p.image_url).slice(0, 9).map(u => ({ src: u, varName: null }));
      } catch (_) {}
    }

    // Primary hero src
    const heroSrc = useVarGallery && varImgList[0]?.image_url
      ? varImgList[0].image_url
      : null; // falls through to imgSrc below

    // Price range from variants (or fall back to single price)
    const variantPrices = variants.map(v => v.price).filter(v => v > 0);
    const priceMin = variantPrices.length ? Math.min(...variantPrices) : Number(p.price);
    const priceMax = variantPrices.length ? Math.max(...variantPrices) : Number(p.price);
    const priceRangeHtml = priceMin === priceMax
      ? `<span class="price-main">${fmt(priceMin)}</span>`
      : `<span class="price-main">${fmt(priceMin)}</span><span class="price-sep">–</span><span class="price-main">${fmt(priceMax)}</span>`;

    // Best per-variant discount: compare each variant's price_before vs its own price only
    const bestDisc = bestVariantDiscount(p.variants_json);
    const discBadgeHtml = bestDisc
      ? `<span class="disc-pill">-${bestDisc.pct}%</span><span class="disc-was">${fmt(bestDisc.price_before)}</span>`
      : '';

    // Parse reviews
    let posReviews = [], negReviews = [];
    try {
      const rv = JSON.parse(p.reviews_json || '{}');
      posReviews = rv.positive || [];
      negReviews = rv.negative || [];
    } catch (_) {}

    // Price history (last 90 days)
    const [priceHistory] = await db.query(
      `SELECT price, captured_at FROM price_history
       WHERE product_id = ? ORDER BY captured_at ASC LIMIT 120`,
      [id]
    );

    // Related products (same category, not this product)
    const [related] = await db.query(
      `SELECT id, title, price, rating, image_url, affiliate_link, link
       FROM products
       WHERE is_active = true
         AND category = ?
         AND id != ?
         AND image_url IS NOT NULL
         AND rating >= 4.3
       ORDER BY sold_count DESC
       LIMIT 12`,
      [p.category || '', id]
    );

    const imgSrc = heroSrc
      || (p.image_url?.startsWith('/uploads')
        ? p.image_url
        : (p.image_url?.replace(/@resize_w\d+/, '@resize_w720') || `https://via.placeholder.com/500x500/FFF8F3/F97316?text=${encodeURIComponent(p.title?.slice(0,10) || 'Produk')}`));

    const affiliateDest = p.affiliate_link || p.link || '/';
    const metaTitle     = `${(p.title || '').slice(0, 60)} – Analisis AI | finding.id`;
    const metaDesc      = ai?.summary || `Review dan analisis AI untuk ${p.title}. Rating ${p.rating}/5, ${soldLabel ? soldLabel + ' terjual' : ''}.`;

    // Build price history section
    const phPrices = priceHistory.map(r => Number(r.price));
    const phMin = phPrices.length ? Math.min(...phPrices) : 0;
    const phMax = phPrices.length ? Math.max(...phPrices) : 0;
    const phCur = phPrices.length ? phPrices[phPrices.length - 1] : Number(p.price);
    const priceHistoryHtml = priceHistory.length >= 2 ? `
    <div class="section">
      <div class="section-head">
        <span class="section-title">Histori Harga</span>
        <span style="font-size:10px;color:var(--ink-4)">${priceHistory.length} data · ${(() => {
          const days = Math.round((new Date(priceHistory[priceHistory.length-1].captured_at) - new Date(priceHistory[0].captured_at)) / 86400000);
          return days + ' hari';
        })()}</span>
      </div>
      <div class="ai-card" style="padding:20px 24px 16px">
        <div style="display:flex;gap:28px;margin-bottom:18px;flex-wrap:wrap">
          <div>
            <div style="font-size:9px;font-weight:700;letter-spacing:.8px;color:var(--ink-4);text-transform:uppercase;margin-bottom:5px">Sekarang</div>
            <div style="font-size:20px;font-weight:700;color:var(--orange)">${fmt(phCur)}</div>
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;letter-spacing:.8px;color:#10B981;text-transform:uppercase;margin-bottom:5px">Terendah</div>
            <div style="font-size:20px;font-weight:700;color:#10B981">${fmt(phMin)}</div>
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;letter-spacing:.8px;color:#EF4444;text-transform:uppercase;margin-bottom:5px">Tertinggi</div>
            <div style="font-size:20px;font-weight:700;color:#EF4444">${fmt(phMax)}</div>
          </div>
          ${phCur <= phMin * 1.02 ? '<div style="align-self:center"><span style="background:#ECFDF5;color:#059669;font-size:10px;font-weight:700;padding:4px 12px;border-radius:20px;border:1px solid #A7F3D0">🔥 HARGA TERENDAH</span></div>' : ''}
        </div>
        ${buildPriceChart(priceHistory)}
      </div>
    </div>` : '';

    // Build score section
    const scoresHtml = ai?.scores ? `
    <div class="section">
      <div class="section-head">
        <span class="section-title">Skor Analisis</span>
        <span class="ai-badge">POWERED BY AI</span>
      </div>
      <div class="ai-card" style="padding:24px">
        <div class="score-grid" id="scoreGrid">
          ${scoreBar('Value for Money', ai.scores.value || 8)}
          ${scoreBar('Kualitas Produk', ai.scores.quality || 8)}
          ${scoreBar('Variasi Pilihan', ai.scores.variety || 8)}
          ${scoreBar('Kepuasan Pembeli', ai.scores.satisfaction || 8)}
        </div>
      </div>
    </div>` : '';

    // Build AI analysis section
    const aiHtml = ai ? `
    <div class="section">
      <div class="section-head">
        <span class="section-title">Analisis AI Mendalam</span>
        <span class="ai-badge">QWEN3.5-35B</span>
      </div>
      <div class="ai-card">
        <div class="ai-section">
          <div class="ai-section-label">01 — Ringkasan Produk</div>
          <p class="ai-text">${escHtml(ai.summary || '')}</p>
        </div>
        <div class="ai-section">
          <div class="ai-section-label">02 — Analisis Mendalam</div>
          <div class="ai-text">${(ai.analysis || '').split(/\n\n+/).map(para => `<p>${para.replace(/&lt;strong&gt;/g,'<strong>').replace(/&lt;\/strong&gt;/g,'</strong>')}</p>`).join('')}</div>
        </div>
        <div class="ai-section">
          <div class="ai-section-label">03 — Kelebihan & Kekurangan</div>
          <div class="pros-cons">
            <div class="pros-list">
              ${(ai.pros || []).map(p => `<div class="pro-item"><span class="pro-icon">✓</span><span>${escHtml(p)}</span></div>`).join('')}
            </div>
            <div class="cons-list">
              ${(ai.cons || []).map(c => `<div class="con-item"><span class="con-icon">✕</span><span>${escHtml(c)}</span></div>`).join('')}
            </div>
          </div>
        </div>
        ${ai.target_buyer ? `
        <div class="ai-section">
          <div class="ai-section-label">04 — Cocok Untuk Siapa?</div>
          <p class="ai-text">${escHtml(ai.target_buyer)}</p>
        </div>` : ''}
        <div class="ai-section">
          <div class="ai-section-label">${ai.target_buyer ? '05' : '04'} — Rekomendasi Akhir</div>
          <div class="verdict-box">${escHtml(ai.verdict || '')}</div>
        </div>
      </div>
    </div>` : `
    <div class="section">
      <div class="ai-card" style="padding:24px;text-align:center;color:var(--ink-4)">
        <div style="font-size:24px;margin-bottom:8px">⏳</div>
        <div style="font-size:13px">Analisis AI sedang disiapkan untuk produk ini. Cek kembali sebentar lagi.</div>
      </div>
    </div>`;

    // Build reviews section
    const hasReviews = posReviews.length || negReviews.length;
    const reviewsHtml = hasReviews ? `
    <div class="section">
      <div class="section-head">
        <span class="section-title">Ulasan Pembeli</span>
      </div>
      <div class="review-grid">
        <div>
          <div class="review-col-head good">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Ulasan Positif
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${posReviews.slice(0, 3).map(r => reviewCard(r, 'good')).join('') || '<p style="font-size:12px;color:var(--ink-4)">Belum ada ulasan positif.</p>'}
          </div>
        </div>
        <div>
          <div class="review-col-head bad">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Perlu Diperhatikan
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${negReviews.slice(0, 3).map(r => reviewCard(r, 'bad')).join('') || '<p style="font-size:12px;color:var(--ink-4)">Tidak ada keluhan yang tercatat.</p>'}
            ${ai?.review_insight ? `
            <div style="background:var(--orange-l);border:1px solid var(--orange-m);border-radius:10px;padding:14px 16px">
              <div style="font-size:10px;font-weight:700;color:var(--orange-d);letter-spacing:.5px;margin-bottom:8px">INSIGHT AI DARI ULASAN</div>
              <p style="font-size:12px;line-height:1.65;color:var(--ink-2)">${escHtml(ai.review_insight)}</p>
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>` : '';

    const relatedHtml = related.length ? `
    <div class="section">
      <div class="section-head"><span class="section-title">Produk Serupa</span></div>
      <div class="slider-wrap">
        <button class="slider-btn prev" id="sliderPrev" disabled>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="slider-track-outer">
          <div class="slider-track" id="sliderTrack">
            ${related.map(relatedCard).join('')}
          </div>
        </div>
        <button class="slider-btn next" id="sliderNext">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
    </div>` : '';

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(metaTitle)}</title>
<meta name="description" content="${escHtml(metaDesc.slice(0, 160))}">
<meta property="og:title" content="${escHtml(metaTitle)}">
<meta property="og:description" content="${escHtml(metaDesc.slice(0, 160))}">
<meta property="og:image" content="${escHtml(imgSrc)}">
<meta property="og:type" content="product">
<link rel="canonical" href="https://finding.id/p/${id}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--orange:#F97316;--orange-d:#EA580C;--orange-l:#FFF8F3;--orange-m:#FED7AA;--ink-1:#0F172A;--ink-2:#1E293B;--ink-3:#475569;--ink-4:#94A3B8;--bg:#FAFAFA;--line:#E2E8F0;--ok:#10B981;--radius:12px;--shadow:0 2px 12px rgba(0,0,0,.07);--shadow-lg:0 8px 32px rgba(0,0,0,.10)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--ink-2);min-height:100vh;padding-bottom:90px}
.nav{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100}
.nav-logo{font-size:18px;font-weight:700;color:var(--orange);text-decoration:none;letter-spacing:-.5px}
.nav-logo span{color:var(--ink-1)}
.nav-sep{color:var(--ink-4);font-size:12px}
.nav-crumb{font-size:11px;color:var(--ink-3)}
.nav-badge{margin-left:auto;background:var(--orange-l);color:var(--orange-d);font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid var(--orange-m);letter-spacing:.5px}
.container{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
.hero{display:grid;grid-template-columns:420px 1fr;gap:32px;margin-bottom:40px}
.hero-img-wrap{position:relative}
.hero-img{width:100%;max-height:500px;object-fit:contain;border-radius:var(--radius);background:var(--orange-l);display:block}
.hero-badge-hot{position:absolute;top:14px;left:14px;background:var(--orange);color:#fff;font-size:10px;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:.8px;text-transform:uppercase}
.hero-info{display:flex;flex-direction:column;gap:16px;padding-top:4px}
.category-tag{display:inline-flex;align-items:center;gap:6px;background:var(--orange-l);color:var(--orange-d);font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;border:1px solid var(--orange-m);width:fit-content}
.product-title{font-size:19px;font-weight:700;line-height:1.45;color:var(--ink-1);letter-spacing:-.3px}
.meta-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.rating-num{font-weight:700;font-size:14px;color:var(--ink-1);margin-left:2px}
.sold-count{font-size:12px;color:var(--ink-3)}
.halal-badge{background:#ECFDF5;color:#059669;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;border:1px solid #A7F3D0;letter-spacing:.5px}
.price-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.price-main{font-size:30px;font-weight:700;color:var(--orange);letter-spacing:-1px}
.disc-pill{background:#EF4444;color:#fff;font-size:13px;font-weight:700;padding:3px 8px;border-radius:6px;align-self:center}
.disc-was{font-size:15px;color:var(--ink-4);text-decoration:line-through;align-self:center}
.price-per{font-size:11px;color:var(--ink-3)}
.spec-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.spec-item{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 14px}
.spec-label{font-size:10px;color:var(--ink-4);margin-bottom:3px;letter-spacing:.5px;text-transform:uppercase}
.spec-value{font-size:13px;font-weight:600;color:var(--ink-1)}
.cta-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px 24px;background:linear-gradient(135deg,var(--orange),var(--orange-d));color:#fff;font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;border:none;border-radius:var(--radius);cursor:pointer;text-decoration:none;letter-spacing:.3px;box-shadow:0 4px 16px rgba(249,115,22,.35);transition:all .2s}
.cta-btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(249,115,22,.45)}
.cta-sub{text-align:center;font-size:10px;color:var(--ink-4);margin-top:8px}
.sticky-cta{position:fixed;bottom:0;left:0;right:0;z-index:200;background:rgba(255,255,255,0.95);backdrop-filter:blur(12px);border-top:1px solid var(--line);padding:12px 16px 16px;display:flex;flex-direction:column;align-items:center}
.sticky-cta .cta-btn{max-width:480px;width:100%;border-radius:14px}
.sticky-cta .cta-sub{margin-top:5px}
.section{margin-bottom:40px}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.section-title{font-size:16px;font-weight:700;color:var(--ink-1);letter-spacing:-.3px}
.ai-badge{display:flex;align-items:center;gap:5px;background:linear-gradient(135deg,#667EEA,#764BA2);color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.5px}
.ai-badge::before{content:'';width:6px;height:6px;background:#fff;border-radius:50%;animation:pulse-dot 1.5s ease-in-out infinite}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
.ai-card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.ai-section{padding:20px 24px;border-bottom:1px solid var(--line)}
.ai-section:last-child{border-bottom:none}
.ai-section-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--orange);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.ai-section-label::after{content:'';flex:1;height:1px;background:var(--orange-m)}
.ai-text{font-size:13px;line-height:1.75;color:var(--ink-2)}
.ai-text p{margin:0 0 15px 0}.ai-text p:last-child{margin-bottom:0}
.ai-text strong{color:var(--ink-1);font-weight:600}
.pros-cons{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pros-list,.cons-list{display:flex;flex-direction:column;gap:8px}
.pro-item,.con-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;color:var(--ink-2)}
.pro-icon{color:var(--ok);font-size:14px;flex-shrink:0;margin-top:1px}
.con-icon{color:#EF4444;font-size:14px;flex-shrink:0;margin-top:1px}
.verdict-box{background:linear-gradient(135deg,#FFF8F3,#FEF3C7);border:1px solid var(--orange-m);border-radius:10px;padding:16px 20px;font-size:13px;line-height:1.7;color:var(--ink-2)}
.verdict-box strong{color:var(--orange-d)}
.score-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.score-item{display:flex;flex-direction:column;gap:6px}
.score-label-row{display:flex;justify-content:space-between;align-items:center}
.score-label{font-size:11px;color:var(--ink-3);font-weight:500}
.score-num{font-size:12px;font-weight:700;color:var(--ink-1)}
.score-bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden}
.score-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--orange),var(--orange-d));transition:width 1s ease}
.review-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.review-col-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;font-weight:700;letter-spacing:.3px}
.review-col-head.good{color:var(--ok)}.review-col-head.bad{color:#EF4444}
.review-card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;transition:box-shadow .15s}
.review-card:hover{box-shadow:var(--shadow)}
.review-card.good{border-left:3px solid var(--ok)}.review-card.bad{border-left:3px solid #EF4444}
.review-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.review-user{font-size:11px;font-weight:600;color:var(--ink-2)}
.review-text{font-size:12px;line-height:1.65;color:var(--ink-3)}
.review-tag{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:10px;color:var(--ink-3);font-weight:500}
.review-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.slider-wrap{position:relative}
.slider-track-outer{overflow:hidden;border-radius:var(--radius)}
.slider-track{display:flex;gap:16px;transition:transform .4s cubic-bezier(.25,.8,.25,1);will-change:transform}
.product-card{flex:0 0 200px;background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);transition:all .2s;text-decoration:none;display:block}
.product-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);border-color:var(--orange-m)}
.card-img{width:100%;aspect-ratio:1;object-fit:cover;background:var(--orange-l);display:block}
.card-body{padding:12px}
.card-title{font-size:11px;font-weight:600;color:var(--ink-1);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:8px}
.card-meta{display:flex;align-items:center;justify-content:space-between}
.card-price{font-size:13px;font-weight:700;color:var(--orange)}
.card-rating{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--ink-3)}
.slider-btn{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;background:#fff;border:1px solid var(--line);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow);z-index:10;transition:all .15s;color:var(--ink-2)}
.slider-btn:hover{background:var(--orange);color:#fff;border-color:var(--orange)}
.slider-btn.prev{left:-18px}.slider-btn.next{right:-18px}
.slider-btn:disabled{opacity:.35;pointer-events:none}
.thumb-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.thumb{width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid var(--line);cursor:pointer;transition:border-color .15s;flex-shrink:0}
.thumb:hover,.thumb.active{border-color:var(--orange)}
.price-sep{font-size:20px;font-weight:400;color:var(--ink-4);margin:0 4px;align-self:center}
.variant-section{margin-top:4px;display:flex;flex-direction:column;gap:10px}
.variant-select{width:100%;padding:10px 36px 10px 14px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center;border:1.5px solid var(--line);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:var(--ink-2);cursor:pointer;appearance:none;outline:none;transition:border-color .15s}
.variant-select:hover,.variant-select:focus{border-color:var(--orange)}
.variant-group{}
.variant-group-label{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.variant-group-selected{font-weight:600;color:var(--ink-1);text-transform:none;letter-spacing:0;font-size:11px}
.color-swatches{display:flex;flex-wrap:wrap;gap:8px}
.color-swatch{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;position:relative}
.color-swatch-img{width:52px;height:52px;object-fit:cover;border-radius:8px;border:2px solid var(--line);transition:border-color .15s,transform .1s;background:var(--bg)}
.color-swatch-noimg{width:52px;height:52px;border-radius:8px;border:2px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:var(--ink-3);background:var(--bg);text-align:center;padding:2px;transition:border-color .15s;cursor:pointer}
.color-swatch-name{font-size:9px;color:var(--ink-4);font-weight:500;max-width:52px;text-align:center;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.color-swatch.selected .color-swatch-img,
.color-swatch.selected .color-swatch-noimg{border-color:var(--orange);box-shadow:0 0 0 2px var(--orange)}
.color-swatch.selected .color-swatch-name{color:var(--orange-d);font-weight:700}
.color-tick{position:absolute;top:2px;right:2px;width:14px;height:14px;background:var(--orange);border-radius:50%;display:none;align-items:center;justify-content:center}
.color-tick svg{display:block}
.color-swatch.selected .color-tick{display:flex}
.size-pills{display:flex;flex-wrap:wrap;gap:8px}
.size-pill{min-width:44px;padding:7px 12px;background:#fff;border:1.5px solid var(--line);border-radius:8px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:var(--ink-2);text-align:center;transition:border-color .15s,background .15s,color .15s}
.size-pill:hover{border-color:var(--orange);background:var(--orange-l)}
.size-pill.selected{border-color:var(--orange);background:var(--orange);color:#fff}
.size-pill.unavail{opacity:.4;cursor:not-allowed;pointer-events:none}
/* legacy fallback pills */
.variant-pills{display:flex;flex-wrap:wrap;gap:8px}
.variant-pill{display:flex;flex-direction:column;align-items:flex-start;background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:8px 12px;cursor:pointer;transition:border-color .15s,background .15s;min-width:90px}
.variant-pill:hover,.variant-pill.selected{border-color:var(--orange);background:var(--orange-l)}
.variant-thumb{width:48px;height:48px;object-fit:contain;border-radius:6px;background:var(--bg);margin-bottom:4px;display:block}
.variant-name{font-size:11px;font-weight:600;color:var(--ink-2);line-height:1.3}
.variant-price{font-size:13px;font-weight:700;color:var(--orange);margin-top:2px}
.variant-strike{font-size:10px;color:var(--ink-4);text-decoration:line-through;margin-top:1px}
@media(max-width:768px){
  .hero{grid-template-columns:1fr;gap:20px}
  .hero-img{max-height:360px}
  .score-grid,.pros-cons,.review-grid{grid-template-columns:1fr}
  .product-card{flex:0 0 160px}
  .price-main{font-size:24px}
}
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">finding<span>.id</span></a>
  <span class="nav-sep">/</span>
  <span class="nav-crumb">${escHtml(p.category || 'Produk')}</span>
  <span class="nav-badge">AI REVIEW</span>
</nav>
<div class="container">

  <!-- Hero -->
  <div class="hero">
    <div class="hero-img-wrap">
      <img class="hero-img" id="heroImg" src="${escHtml(imgSrc)}" alt="${escHtml((p.title || '').slice(0, 80))}"
           onerror="this.src='https://via.placeholder.com/460x460/FFF8F3/F97316?text=Produk'">
      ${soldLabel ? '<span class="hero-badge-hot">🔥 Terlaris</span>' : ''}
      ${(extraImages.length || useVarGallery) ? `
      <div class="thumb-row">
        <img class="thumb active" src="${escHtml(imgSrc)}" data-src="${escHtml(imgSrc)}"
             ${useVarGallery && varImgList[0] ? `data-varname="${escHtml(varImgList[0].name)}"` : ''}
             onclick="swapImg(this)">
        ${extraImages.map(e => `<img class="thumb" src="${escHtml(e.src)}" data-src="${escHtml(e.src)}"
             ${e.varName ? `data-varname="${escHtml(e.varName)}"` : ''}
             onclick="swapImg(this)" loading="lazy">`).join('')}
      </div>` : ''}
    </div>
    <div class="hero-info">
      <span class="category-tag">${escHtml(p.category || 'Produk')}</span>
      <h1 class="product-title">${escHtml(p.title || '')}</h1>
      <div class="meta-row">
        <div style="display:flex;align-items:center;gap:4px">
          ${renderStars(p.rating || 0, 14)}
          <span class="rating-num">${Number(p.rating || 0).toFixed(2)}</span>
        </div>
        ${soldLabel ? `<span class="sold-count">${soldLabel} terjual</span>` : ''}
        ${(() => {
          const cat = (p.category || '').toLowerCase();
          const isHalalCategory = /makanan|minuman|food|snack|kuliner|kosmetik|kecantikan|perawatan|skincare|beauty|sabun|parfum|lip|serum|toner|lotion|cream|moistur/.test(cat);
          return isHalalCategory && ai?.is_halal === true
            ? '<span class="halal-badge">✓ HALAL</span>'
            : '';
        })()}
      </div>
      <div class="price-row">
        ${priceRangeHtml}
        ${discBadgeHtml}
      </div>
      ${variants.length ? `
      <div class="variant-section" id="variantSection">
        ${isTwoTier ? `
        <div class="variant-group">
          <div class="variant-group-label">Warna</div>
          <select class="variant-select" id="selColor" onchange="onColorChange(this.value)">
            ${[...colorMap.keys()].map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="variant-group">
          <div class="variant-group-label">Ukuran</div>
          <select class="variant-select" id="selSize" onchange="onSizeChange(this.value)">
            ${sizeOrder.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')}
          </select>
        </div>
        ` : `
        <div class="variant-group">
          <div class="variant-group-label">Varian</div>
          <select class="variant-select" id="selVariant" onchange="onVariantChange(this.value)">
            ${variants.map(v => `<option value="${escHtml(v.name)}" data-price="${v.price||0}" data-img="${escHtml(varImgLookup[v.name]||v.image_url||'')}">
              ${escHtml(v.name)} — ${fmt(v.price||0)}${v.price_before && v.price_before > v.price ? ' (disc '+Math.round((1-v.price/v.price_before)*100)+'%)' : ''}</option>`).join('')}
          </select>
        </div>`}
      </div>
      <script id="variantData" type="application/json">${JSON.stringify(variants)}</script>
      <script id="variantImgMap" type="application/json">${JSON.stringify([...colorMap.entries()].map(([name,m])=>({name,img:m.image_url||''})))}</script>` : ''}
      <div class="spec-grid">
        <div class="spec-item">
          <div class="spec-label">Kategori</div>
          <div class="spec-value">${escHtml(p.category || '—')}</div>
        </div>
        <div class="spec-item">
          <div class="spec-label">Rating</div>
          <div class="spec-value">${Number(p.rating || 0).toFixed(2)} / 5.00</div>
        </div>
        <div class="spec-item">
          <div class="spec-label">Terjual</div>
          <div class="spec-value">${soldLabel || 'N/A'}</div>
        </div>
        <div class="spec-item">
          <div class="spec-label">Ulasan</div>
          <div class="spec-value">${posReviews.length + negReviews.length} dikumpulkan</div>
        </div>
      </div>
    </div>
  </div>

  ${priceHistoryHtml}
  ${scoresHtml}
  ${aiHtml}
  ${reviewsHtml}
  ${relatedHtml}

</div>
<script>
// ── Variant dropdown logic ────────────────────────────────────────
var _selColor = null, _variants = [], _colorImgMap = [];

(function initVariants() {
  var el = document.getElementById('variantData');
  if (!el) return;
  try { _variants = JSON.parse(el.textContent); } catch(e) {}
  var im = document.getElementById('variantImgMap');
  try { _colorImgMap = im ? JSON.parse(im.textContent) : []; } catch(e) {}

  var colorSel = document.getElementById('selColor');
  if (colorSel) { onColorChange(colorSel.value); return; }
  var varSel = document.getElementById('selVariant');
  if (varSel && varSel.options.length) onVariantChange(varSel.value);
})();

function onColorChange(color) {
  _selColor = color;
  var match = _colorImgMap.find(function(m){ return m.name === color; });
  if (match && match.img) swapHero(match.img);
  // Disable unavailable sizes
  var sizeSel = document.getElementById('selSize');
  if (sizeSel) {
    Array.from(sizeSel.options).forEach(function(opt) {
      opt.disabled = !_variants.some(function(v){ return v.name === color + ',' + opt.value; });
    });
    var first = Array.from(sizeSel.options).find(function(o){ return !o.disabled; });
    if (first) { sizeSel.value = first.value; onSizeChange(first.value); }
  }
}

function onSizeChange(size) {
  if (!_selColor) return;
  var v = _variants.find(function(v){ return v.name === _selColor + ',' + size; });
  if (v) setPriceDisplay(v);
}

function onVariantChange(name) {
  var sel = document.getElementById('selVariant');
  var opt = sel && Array.from(sel.options).find(function(o){ return o.value === name; });
  if (!opt) return;
  if (opt.dataset.img) swapHero(opt.dataset.img);
  var v = _variants.find(function(v){ return v.name === name; });
  if (v) setPriceDisplay(v);
}

function setPriceDisplay(v) {
  var priceEl = document.querySelector('.price-row');
  if (!priceEl || !v || !v.price) return;
  // Compare this variant's price_before vs its OWN price only
  var html = '<span class="price-main">Rp ' + Number(v.price).toLocaleString('id-ID') + '</span>';
  if (v.price_before && v.price_before > v.price) {
    var disc = Math.round((1 - v.price / v.price_before) * 100);
    html += '<span class="disc-pill">-' + disc + '%</span>';
    html += '<span class="disc-was">Rp ' + Number(v.price_before).toLocaleString('id-ID') + '</span>';
  }
  priceEl.innerHTML = html;
}

function swapHero(src) {
  var heroImg = document.getElementById('heroImg');
  if (heroImg) heroImg.src = src;
  document.querySelectorAll('.thumb').forEach(function(t){
    t.classList.toggle('active', t.dataset.src === src);
  });
}

// Thumbnail click → sync color dropdown
function swapImg(el) {
  swapHero(el.dataset.src);
  var varName = el.dataset.varname;
  if (!varName) return;
  var colorSel = document.getElementById('selColor');
  if (colorSel && Array.from(colorSel.options).some(function(o){ return o.value === varName; })) {
    colorSel.value = varName;
    onColorChange(varName);
  } else {
    var varSel = document.getElementById('selVariant');
    if (varSel && Array.from(varSel.options).some(function(o){ return o.value === varName; })) {
      varSel.value = varName;
      onVariantChange(varName);
    }
  }
}

// Score bar animation
(function(){
  var grid = document.getElementById('scoreGrid');
  if (!grid) return;
  var obs = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        document.querySelectorAll('.score-fill').forEach(function(el){
          setTimeout(function(){ el.style.width = el.dataset.w; }, 200);
        });
        obs.disconnect();
      }
    });
  }, { threshold: 0.3 });
  obs.observe(grid);
})();

// Slider
(function(){
  var track = document.getElementById('sliderTrack');
  if (!track) return;
  var btnPrev = document.getElementById('sliderPrev');
  var btnNext = document.getElementById('sliderNext');
  var CARD_W  = 216;
  var pos     = 0;
  function update(){
    var cards   = track.querySelectorAll('.product-card');
    var visible = Math.floor(track.parentElement.offsetWidth / CARD_W);
    var maxPos  = Math.max(0, cards.length - visible);
    pos = Math.min(Math.max(pos,0), maxPos);
    track.style.transform = 'translateX(-'+(pos*CARD_W)+'px)';
    btnPrev.disabled = pos===0;
    btnNext.disabled = pos>=maxPos;
  }
  btnPrev.addEventListener('click', function(){ pos--; update(); });
  btnNext.addEventListener('click', function(){ pos++; update(); });
  window.addEventListener('resize', update);
  update();
})();

</script>
<div class="sticky-cta">
  <a href="${escHtml(affiliateDest)}" target="_blank" rel="noopener" class="cta-btn">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
    Beli di Shopee
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
  </a>
  <p class="cta-sub">Link afiliasi · Tidak ada biaya tambahan untuk kamu</p>
</div>
</body>
</html>`;

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[productPage]', err.message);
    res.redirect('/');
  }
});

module.exports = router;
