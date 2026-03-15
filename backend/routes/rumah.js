'use strict';
/**
 * /rumah — Property section for finding.id
 *
 * Routes:
 *   GET /rumah                              → homepage HTML (SSR, Redis 10min)
 *   GET /rumah/search                       → JSON search (paginated)
 *   GET /rumah/p/:id                        → property detail page (SSR, Redis 1hr)
 *   GET /rumah/:province/:city              → city listing page (SSR, Redis 10min)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const cache   = require('../services/cache');

// ── Category mapping ──────────────────────────────────────────
const CAT_NAME = {
  1: 'Rumah',
  2: 'Apartemen',
  3: 'Tanah',
  4: 'Kost',
  5: 'Ruko',
  6: 'Lainnya',
};

const CAT_ICON = {
  1: '🏠',
  2: '🏢',
  3: '🌱',
  4: '🛏️',
  5: '🏪',
  6: '🏗️',
};

// ── Helpers ───────────────────────────────────────────────────

/**
 * Format IDR price.
 * Data has two representations:
 *   - large values (>= 100_000) already in full IDR  → e.g. 450_000_000
 *   - small values (< 100_000) in "juta" units       → e.g. 450 means Rp 450 jt
 */
function fmtPrice(raw) {
  if (!raw || raw <= 0) return 'Harga Nego';
  let n = Number(raw);
  // Normalize: values < 100_000 are stored as juta
  if (n < 100000) n = n * 1_000_000;

  if (n >= 1_000_000_000) {
    const m = n / 1_000_000_000;
    return `Rp ${m % 1 === 0 ? m : m.toFixed(2).replace(/\.?0+$/, '')} M`;
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `Rp ${m % 1 === 0 ? m : m.toFixed(0)} Jt`;
  }
  return `Rp ${n.toLocaleString('id-ID')}`;
}

/** URL-safe slug */
function toSlug(str) {
  return (str || '').toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Reverse slug → fuzzy match in DB via LIKE */
function fromSlug(slug) {
  return slug.replace(/-/g, ' ');
}

/** HTML escape */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shared HTML head / navbar */
function htmlHead(title, desc, canonical = '') {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono',monospace;background:#FFF8F3;color:#1a1a1a;min-height:100vh}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}

/* Navbar */
.nav{background:#fff;border-bottom:2px solid #F97316;padding:12px 20px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(249,115,22,.08)}
.nav-logo{font-weight:700;font-size:20px;color:#F97316;letter-spacing:-1px}
.nav-logo span{color:#1a1a1a}
.nav-back{font-size:13px;color:#666;display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #eee;border-radius:6px;transition:all .15s}
.nav-back:hover{border-color:#F97316;color:#F97316}
.nav-section{font-size:13px;color:#F97316;font-weight:600;margin-left:auto}

/* Layout */
.container{max-width:1200px;margin:0 auto;padding:24px 20px}
.page-hero{background:linear-gradient(135deg,#F97316,#EA580C);color:#fff;padding:48px 20px;text-align:center}
.page-hero h1{font-size:clamp(24px,5vw,42px);font-weight:700;margin-bottom:12px;letter-spacing:-1px}
.page-hero p{font-size:16px;opacity:.9;max-width:560px;margin:0 auto 28px}

/* Search form */
.search-box{background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 24px rgba(249,115,22,.12);max-width:800px;margin:-28px auto 0}
.search-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.search-row:last-child{margin-bottom:0}
.form-input,.form-select{font-family:inherit;font-size:14px;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;outline:none;transition:border-color .15s;flex:1;min-width:140px}
.form-input:focus,.form-select:focus{border-color:#F97316}
.btn-search{font-family:inherit;font-size:14px;font-weight:600;padding:10px 24px;background:#F97316;color:#fff;border:none;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .15s}
.btn-search:hover{background:#EA580C}

/* Grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;margin-top:28px}
.grid-3{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}

/* Card */
.card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);transition:transform .15s,box-shadow .15s;display:flex;flex-direction:column}
.card:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(249,115,22,.14)}
.card-img{width:100%;height:180px;object-fit:cover;background:#f3f4f6}
.card-img-placeholder{width:100%;height:180px;background:linear-gradient(135deg,#FEF3EC,#FFF8F3);display:flex;align-items:center;justify-content:center;font-size:48px}
.card-body{padding:16px;flex:1;display:flex;flex-direction:column}
.card-cat{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;background:#FFF0E8;color:#EA580C;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
.card-title{font-size:14px;font-weight:600;line-height:1.4;margin-bottom:10px;color:#1a1a1a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-price{font-size:17px;font-weight:700;color:#F97316;margin-bottom:10px}
.card-specs{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#666;margin-bottom:10px}
.card-spec{display:flex;align-items:center;gap:3px}
.card-city{font-size:12px;color:#888;margin-top:auto}
.card-city span{background:#f3f4f6;padding:2px 8px;border-radius:20px}

/* Detail page */
.detail-grid{display:grid;grid-template-columns:1fr 360px;gap:28px;align-items:start}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:24px}
.gallery img,.gallery .gallery-placeholder{width:100%;height:160px;object-fit:cover;border-radius:8px;background:#f3f4f6}
.gallery img:first-child,.gallery .gallery-placeholder:first-child{grid-column:span 3;height:280px}
.gallery .gallery-placeholder{display:flex;align-items:center;justify-content:center;font-size:40px}
.detail-title{font-size:24px;font-weight:700;margin-bottom:12px;line-height:1.3}
.detail-price{font-size:32px;font-weight:700;color:#F97316;margin-bottom:20px}
.specs-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:24px}
.spec-item{background:#FFF8F3;border:1px solid #FDE8D5;border-radius:10px;padding:14px;text-align:center}
.spec-item .spec-val{font-size:20px;font-weight:700;color:#F97316}
.spec-item .spec-lbl{font-size:12px;color:#888;margin-top:2px}
.desc-box{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;line-height:1.7;font-size:14px;color:#444;white-space:pre-wrap;word-break:break-word}
.sidebar-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:16px}
.sidebar-card h3{font-size:15px;font-weight:700;margin-bottom:14px;color:#1a1a1a}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px}
.info-row:last-child{border-bottom:none}
.info-row .lbl{color:#888}
.info-row .val{font-weight:600;text-align:right}
.badge-source{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#FFF0E8;border:1px solid #FDE8D5;border-radius:8px;font-size:13px;color:#EA580C;font-weight:600;margin-top:8px}
.badge-source a{color:#EA580C;text-decoration:underline}

/* Province links */
.province-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:24px}
.province-card{background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;padding:16px 20px;transition:all .15s;cursor:pointer}
.province-card:hover{border-color:#F97316;background:#FFF8F3;transform:translateY(-1px)}
.province-card .prov-name{font-weight:700;font-size:14px;margin-bottom:4px}
.province-card .prov-cnt{font-size:12px;color:#888}

/* Stats */
.stats-row{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin:24px 0 0}
.stat-item{background:rgba(255,255,255,.2);border-radius:12px;padding:14px 24px;text-align:center}
.stat-item .stat-val{font-size:28px;font-weight:700}
.stat-item .stat-lbl{font-size:12px;opacity:.85;margin-top:2px}

/* Listing + sidebar layout */
.listing-layout{display:grid;grid-template-columns:240px 1fr;gap:24px;align-items:start}
.filter-sidebar{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;position:sticky;top:72px}
.filter-sidebar h3{font-size:14px;font-weight:700;margin-bottom:14px;color:#1a1a1a}
.filter-group{margin-bottom:18px}
.filter-group label{display:block;font-size:12px;color:#888;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.filter-group .form-select,.filter-group .form-input{width:100%;font-size:13px}
.btn-filter{font-family:inherit;font-size:13px;font-weight:600;padding:10px;width:100%;background:#F97316;color:#fff;border:none;border-radius:8px;cursor:pointer;margin-top:4px}
.btn-filter:hover{background:#EA580C}
.btn-clear{font-family:inherit;font-size:12px;padding:8px;width:100%;background:#f3f4f6;color:#666;border:none;border-radius:8px;cursor:pointer;margin-top:6px}
.btn-clear:hover{background:#e5e7eb}

/* Pagination */
.pagination{display:flex;gap:6px;justify-content:center;margin-top:32px;flex-wrap:wrap}
.page-btn{font-family:inherit;font-size:13px;font-weight:600;padding:8px 14px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;transition:all .15s}
.page-btn:hover,.page-btn.active{border-color:#F97316;background:#F97316;color:#fff}
.page-btn:disabled{opacity:.4;cursor:default}

/* Section headings */
.section-title{font-size:20px;font-weight:700;margin:32px 0 16px;letter-spacing:-.5px}
.section-title span{color:#F97316}

/* Related */
.related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px}

/* Footer */
.footer{background:#1a1a1a;color:#999;text-align:center;padding:24px;font-size:13px;margin-top:60px}
.footer a{color:#F97316}

/* Breadcrumb */
.breadcrumb{font-size:13px;color:#888;margin-bottom:20px}
.breadcrumb a{color:#F97316}
.breadcrumb span{margin:0 6px}

/* Mobile */
@media(max-width:768px){
  .detail-grid{grid-template-columns:1fr}
  .listing-layout{grid-template-columns:1fr}
  .filter-sidebar{position:static}
  .gallery{grid-template-columns:1fr 1fr}
  .gallery img:first-child,.gallery .gallery-placeholder:first-child{grid-column:span 2;height:220px}
  .specs-grid{grid-template-columns:repeat(2,1fr)}
  .search-row{flex-direction:column}
}
</style>
</head>
<body>`;
}

function htmlNav(section = 'Properti') {
  return `
<nav class="nav">
  <a href="/" class="nav-logo">finding<span>.id</span></a>
  <a href="/" class="nav-back">← finding.id</a>
  <span class="nav-section">${esc(section)}</span>
</nav>`;
}

function htmlFoot() {
  return `
<footer class="footer">
  <p>© 2025 <a href="/">finding.id</a> — AI-powered property search Indonesia · Data: 99.co</p>
</footer>
</body></html>`;
}

/** Render a property card (list/grid) */
function propertyCard(r) {
  const slug    = `${toSlug(r.province)}/${toSlug(r.city)}`;
  const catName = CAT_NAME[r.category] || 'Properti';
  const catIcon = CAT_ICON[r.category] || '🏠';
  const imgHtml = r.thumbnail
    ? `<img class="card-img" src="${esc(r.thumbnail)}" alt="${esc(r.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholderHtml = `<div class="card-img-placeholder" style="${r.thumbnail ? 'display:none' : ''}">🏠</div>`;

  const specsHtml = [];
  if (r.bed  > 0) specsHtml.push(`<span class="card-spec">🛏️ ${r.bed} KT</span>`);
  if (r.bath > 0) specsHtml.push(`<span class="card-spec">🚿 ${r.bath} KM</span>`);
  if (r.builtup > 0) specsHtml.push(`<span class="card-spec">📐 ${r.builtup}m²</span>`);

  return `
<a href="/rumah/p/${r.rumah_id}" class="card">
  ${imgHtml}${placeholderHtml}
  <div class="card-body">
    <span class="card-cat">${catIcon} ${esc(catName)}</span>
    <div class="card-title">${esc(r.title)}</div>
    <div class="card-price">${fmtPrice(r.price)}</div>
    ${specsHtml.length ? `<div class="card-specs">${specsHtml.join('')}</div>` : ''}
    <div class="card-city"><span>📍 ${esc(r.city)}, ${esc(r.province)}</span></div>
  </div>
</a>`;
}

// ── Homepage: GET /rumah ───────────────────────────────────────
router.get('/', async (req, res) => {
  const cacheKey = 'rumah:homepage:v1';
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(cached);
    }

    // Featured listings (top hits)
    const [featured] = await db.query(
      `SELECT rumah_id, province, city, title, price, bed, bath, builtup, size, category, thumbnail
       FROM rumah WHERE published=1 ORDER BY hits DESC, rumah_id DESC LIMIT 12`
    );

    // Province list with counts
    const [provinces] = await db.query(
      `SELECT province, COUNT(*) as cnt FROM rumah WHERE published=1 GROUP BY province ORDER BY cnt DESC`
    );

    // Stats
    const [[stats]] = await db.query(
      `SELECT COUNT(*) as total, COUNT(DISTINCT city) as cities, COUNT(DISTINCT province) as provs FROM rumah WHERE published=1`
    );

    const provinceOptions = provinces.map(p =>
      `<option value="${esc(p.province)}">${esc(p.province)} (${p.cnt})</option>`
    ).join('');

    const catOptions = Object.entries(CAT_NAME).map(([k, v]) =>
      `<option value="${k}">${v}</option>`
    ).join('');

    const provinceCards = provinces.map(p => `
<a href="/rumah/${toSlug(p.province)}" class="province-card">
  <div class="prov-name">📍 ${esc(p.province)}</div>
  <div class="prov-cnt">${p.cnt.toLocaleString('id-ID')} properti</div>
</a>`).join('');

    const featuredCards = featured.map(propertyCard).join('');

    const html = htmlHead(
      'Cari Properti Indonesia — finding.id',
      'Temukan rumah, apartemen, tanah, dan kost di seluruh Indonesia. Data real dari 99.co, dicari mudah dengan finding.id.',
      'https://finding.id/rumah'
    ) + htmlNav('Properti') + `

<div class="page-hero">
  <h1>🏠 Cari Properti</h1>
  <p>Rumah, apartemen, tanah & kost di seluruh Indonesia. ${Number(stats.total).toLocaleString('id-ID')} listing tersedia.</p>
  <div class="stats-row">
    <div class="stat-item"><div class="stat-val">${Number(stats.total).toLocaleString('id-ID')}</div><div class="stat-lbl">Total Listing</div></div>
    <div class="stat-item"><div class="stat-val">${stats.cities}</div><div class="stat-lbl">Kota</div></div>
    <div class="stat-item"><div class="stat-val">${stats.provs}</div><div class="stat-lbl">Provinsi</div></div>
  </div>
</div>

<div class="container">
  <div class="search-box">
    <form action="/rumah/search" method="get" id="rumah-search-form">
      <div class="search-row">
        <input class="form-input" type="text" name="q" placeholder="Cari properti... (contoh: rumah 3 kamar Jakarta)" style="flex:2">
        <select class="form-select" name="province" id="prov-select" onchange="filterCities(this.value)">
          <option value="">Semua Provinsi</option>
          ${provinceOptions}
        </select>
        <select class="form-select" name="city" id="city-select">
          <option value="">Semua Kota</option>
        </select>
      </div>
      <div class="search-row">
        <select class="form-select" name="category">
          <option value="">Semua Tipe</option>
          ${catOptions}
        </select>
        <select class="form-select" name="bed">
          <option value="">Kamar Tidur</option>
          <option value="1">1 KT</option>
          <option value="2">2 KT</option>
          <option value="3">3 KT</option>
          <option value="4">4+ KT</option>
        </select>
        <input class="form-input" type="number" name="min_price" placeholder="Harga Min (Jt)" min="0">
        <input class="form-input" type="number" name="max_price" placeholder="Harga Max (Jt)" min="0">
        <button class="btn-search" type="submit">🔍 Cari</button>
      </div>
    </form>
  </div>

  <div class="section-title">🔥 Properti <span>Populer</span></div>
  <div class="grid grid-3">${featuredCards}</div>

  <div class="section-title">📍 Cari per <span>Provinsi</span></div>
  <div class="province-grid">${provinceCards}</div>
</div>

<script>
const cityData = {};
async function filterCities(province) {
  const sel = document.getElementById('city-select');
  sel.innerHTML = '<option value="">Semua Kota</option>';
  if (!province) return;
  if (cityData[province]) {
    cityData[province].forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    return;
  }
  const r = await fetch('/rumah/search?province=' + encodeURIComponent(province) + '&_cities=1');
  const j = await r.json();
  cityData[province] = j.cities || [];
  cityData[province].forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
}
// Pre-populate city if province already selected
window.addEventListener('DOMContentLoaded', () => {
  const ps = document.getElementById('prov-select').value;
  if (ps) filterCities(ps);
});
</script>
` + htmlFoot();

    await cache.set(cacheKey, html, 600);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[rumah] homepage error:', err.message);
    res.status(500).send('Server error');
  }
});

// ── JSON Search: GET /rumah/search ────────────────────────────
router.get('/search', async (req, res) => {
  // City list helper for province dropdown
  if (req.query._cities === '1') {
    const province = (req.query.province || '').trim();
    if (!province) return res.json({ cities: [] });
    try {
      const [rows] = await db.query(
        `SELECT DISTINCT city FROM rumah WHERE published=1 AND province=? ORDER BY city ASC`,
        [province]
      );
      return res.json({ cities: rows.map(r => r.city) });
    } catch {
      return res.json({ cities: [] });
    }
  }

  const q         = (req.query.q         || '').trim();
  const province  = (req.query.province  || '').trim();
  const city      = (req.query.city      || '').trim();
  const minPrice  = parseInt(req.query.min_price) || 0;
  const maxPrice  = parseInt(req.query.max_price) || 0;
  const bed       = parseInt(req.query.bed)       || 0;
  const category  = parseInt(req.query.category)  || 0;
  const page      = Math.max(1, parseInt(req.query.page) || 1);
  const limit     = 20;
  const offset    = (page - 1) * limit;

  // For HTML search results page redirect
  if (req.headers.accept && req.headers.accept.includes('text/html') && !req.query._json) {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(`/rumah/results?${qs}`);
  }

  const conditions = ['published=1'];
  const params     = [];

  if (q) {
    conditions.push('(title LIKE ? OR description LIKE ? OR address LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (province) { conditions.push('province=?'); params.push(province); }
  if (city)     { conditions.push('city=?');     params.push(city); }
  if (category) { conditions.push('category=?'); params.push(category); }
  if (bed === 4) { conditions.push('bed >= 4');  }
  else if (bed > 0) { conditions.push('bed=?'); params.push(bed); }

  // Price filter — handle dual representation
  if (minPrice > 0) {
    // min_price is in juta from form → compare against DB value
    // DB stores either full IDR or "juta" unit — use threshold 100000
    conditions.push('(CASE WHEN price < 100000 THEN price ELSE price/1000000 END) >= ?');
    params.push(minPrice);
  }
  if (maxPrice > 0) {
    conditions.push('(CASE WHEN price < 100000 THEN price ELSE price/1000000 END) <= ?');
    params.push(maxPrice);
  }

  const where = conditions.join(' AND ');

  try {
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM rumah WHERE ${where}`, params
    );

    const [rows] = await db.query(
      `SELECT rumah_id, province, city, title, price, bed, bath, builtup, size, category, thumbnail, hits
       FROM rumah WHERE ${where} ORDER BY hits DESC, rumah_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      total,
      page,
      pages: Math.ceil(total / limit),
      results: rows.map(r => ({
        id:        r.rumah_id,
        title:     r.title,
        price:     r.price,
        price_fmt: fmtPrice(r.price),
        bed:       r.bed,
        bath:      r.bath,
        builtup:   r.builtup,
        size:      r.size,
        category:  r.category,
        cat_name:  CAT_NAME[r.category] || 'Properti',
        province:  r.province,
        city:      r.city,
        thumbnail: r.thumbnail,
        url:       `/rumah/p/${r.rumah_id}`,
      })),
    });
  } catch (err) {
    console.error('[rumah] search error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Detail page: GET /rumah/p/:id ─────────────────────────────
router.get('/p/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/rumah');

  const cacheKey = `rumah:detail:${id}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(cached);
    }

    const [[r]] = await db.query(
      `SELECT * FROM rumah WHERE rumah_id=? AND published=1 LIMIT 1`, [id]
    );
    if (!r) return res.status(404).redirect('/rumah');

    // Related listings
    const [related] = await db.query(
      `SELECT rumah_id, province, city, title, price, bed, bath, builtup, size, category, thumbnail
       FROM rumah WHERE published=1 AND city=? AND category=? AND rumah_id!=? ORDER BY hits DESC LIMIT 6`,
      [r.city, r.category, id]
    );

    // Parse pictures
    let pics = [];
    try { pics = JSON.parse(r.pictures || '[]'); } catch {}
    if (!Array.isArray(pics)) pics = [];
    if (r.thumbnail && !pics.includes(r.thumbnail)) pics.unshift(r.thumbnail);
    pics = pics.slice(0, 6);

    const catName = CAT_NAME[r.category] || 'Properti';
    const catIcon = CAT_ICON[r.category] || '🏠';

    // Gallery
    const galleryItems = pics.length
      ? pics.map((src, i) =>
          `<img src="${esc(src)}" alt="${esc(r.title)} foto ${i+1}" loading="lazy" onerror="this.style.display='none'">`
        ).join('')
      : `<div class="gallery-placeholder">🏠</div>`;

    // Specs
    const specItems = [];
    if (r.bed  > 0)    specItems.push({ val: r.bed,          lbl: 'Kamar Tidur',  icon: '🛏️' });
    if (r.bath > 0)    specItems.push({ val: r.bath,         lbl: 'Kamar Mandi',  icon: '🚿' });
    if (r.builtup > 0) specItems.push({ val: `${r.builtup}m²`, lbl: 'Luas Bangunan', icon: '📐' });
    if (r.size > 0)    specItems.push({ val: `${r.size}m²`,    lbl: 'Luas Tanah',    icon: '🌱' });

    const specsHtml = specItems.map(s => `
<div class="spec-item">
  <div class="spec-val">${s.icon} ${esc(String(s.val))}</div>
  <div class="spec-lbl">${s.lbl}</div>
</div>`).join('');

    // Info rows
    const infoRows = [];
    if (r.tenure) infoRows.push({ lbl: 'Sertifikat', val: r.tenure });
    if (r.type)   infoRows.push({ lbl: 'Tipe', val: r.type });
    if (r.address) infoRows.push({ lbl: 'Alamat', val: r.address });
    if (r.city)   infoRows.push({ lbl: 'Kota', val: r.city });
    if (r.province) infoRows.push({ lbl: 'Provinsi', val: r.province });
    if (r.name)   infoRows.push({ lbl: 'Nama Perumahan', val: r.name });

    const infoHtml = infoRows.map(row => `
<div class="info-row">
  <span class="lbl">${esc(row.lbl)}</span>
  <span class="val">${esc(row.val)}</span>
</div>`).join('');

    const relatedHtml = related.map(propertyCard).join('');

    // Schema.org JSON-LD
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'RealEstateListing',
      name: r.title,
      description: (r.description || '').slice(0, 500),
      url: `https://finding.id/rumah/p/${id}`,
      image: pics[0] || '',
      offers: {
        '@type': 'Offer',
        price: r.price || 0,
        priceCurrency: 'IDR',
        availability: 'https://schema.org/InStock',
      },
      address: {
        '@type': 'PostalAddress',
        addressLocality: r.city,
        addressRegion: r.province,
        addressCountry: 'ID',
      },
    };

    const html = htmlHead(
      `${r.title} — Rp ${fmtPrice(r.price)} | finding.id`,
      `${catName} di ${r.city}, ${r.province}. ${r.bed ? r.bed+' KT, ' : ''}${r.bath ? r.bath+' KM. ' : ''}${fmtPrice(r.price)}. Lihat detail properti di finding.id.`,
      `https://finding.id/rumah/p/${id}`
    ) + `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` +
    htmlNav('Properti') + `

<div class="container">
  <div class="breadcrumb">
    <a href="/rumah">Properti</a>
    <span>›</span>
    <a href="/rumah/${toSlug(r.province)}/${toSlug(r.city)}">${esc(r.city)}</a>
    <span>›</span>
    <span>${esc(catName)}</span>
  </div>

  <div class="detail-grid">
    <div>
      <div class="gallery">${galleryItems}</div>
      <div class="detail-title">${esc(r.title)}</div>
      <div class="detail-price">${fmtPrice(r.price)}</div>
      ${specItems.length ? `<div class="specs-grid">${specsHtml}</div>` : ''}
      ${r.description ? `
      <div class="section-title" style="margin-top:0">Deskripsi</div>
      <div class="desc-box">${esc(r.description)}</div>` : ''}
    </div>

    <div>
      <div class="sidebar-card">
        <h3>${catIcon} ${esc(catName)}</h3>
        ${infoHtml}
        ${r.url ? `<div style="margin-top:12px"><div class="badge-source">🔗 Sumber: <a href="${esc(r.url)}" target="_blank" rel="nofollow noopener">99.co</a></div></div>` : ''}
      </div>
      ${r.phone ? `
      <div class="sidebar-card">
        <h3>📞 Hubungi Penjual</h3>
        <p style="font-size:14px;font-weight:700;color:#F97316">${esc(r.phone)}</p>
      </div>` : ''}
    </div>
  </div>

  ${related.length ? `
  <div class="section-title">🏡 Properti <span>Serupa</span></div>
  <div class="related-grid">${relatedHtml}</div>` : ''}
</div>
` + htmlFoot();

    await cache.set(cacheKey, html, 3600);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[rumah] detail error:', err.message);
    res.status(500).send('Server error');
  }
});

// ── Province page: GET /rumah/:province ───────────────────────
router.get('/:province', async (req, res, next) => {
  const provSlug = req.params.province;
  // Guard against sub-routes bleeding through
  if (['search', 'results', 'p', 'api'].includes(provSlug)) return next();

  const provName = fromSlug(provSlug);
  const cacheKey = `rumah:prov:${provSlug}:v1`;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(cached);
    }

    // Find actual province name (case-insensitive)
    const [[provRow]] = await db.query(
      `SELECT province, COUNT(*) as cnt FROM rumah WHERE published=1 AND province LIKE ? GROUP BY province LIMIT 1`,
      [`%${provName}%`]
    );
    if (!provRow) return res.redirect('/rumah');

    const realProv = provRow.province;

    // Cities in province
    const [cities] = await db.query(
      `SELECT city, COUNT(*) as cnt FROM rumah WHERE published=1 AND province=? GROUP BY city ORDER BY cnt DESC`,
      [realProv]
    );

    const cityCards = cities.map(c => `
<a href="/rumah/${toSlug(realProv)}/${toSlug(c.city)}" class="province-card">
  <div class="prov-name">🏙️ ${esc(c.city)}</div>
  <div class="prov-cnt">${c.cnt} properti</div>
</a>`).join('');

    const html = htmlHead(
      `Properti di ${realProv} — finding.id`,
      `Cari rumah, apartemen, dan properti di ${realProv}. ${provRow.cnt} listing tersedia. Temukan properti impian Anda di finding.id.`,
      `https://finding.id/rumah/${toSlug(realProv)}`
    ) + htmlNav('Properti') + `

<div class="page-hero">
  <h1>📍 ${esc(realProv)}</h1>
  <p>${provRow.cnt} properti tersedia · ${cities.length} kota</p>
</div>

<div class="container">
  <div class="breadcrumb">
    <a href="/rumah">Properti</a>
    <span>›</span>
    <span>${esc(realProv)}</span>
  </div>

  <div class="section-title">🏙️ Pilih <span>Kota</span></div>
  <div class="province-grid">${cityCards}</div>
</div>
` + htmlFoot();

    await cache.set(cacheKey, html, 600);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[rumah] province page error:', err.message);
    res.status(500).send('Server error');
  }
});

// ── City listing: GET /rumah/:province/:city ──────────────────
router.get('/:province/:city', async (req, res) => {
  const provSlug = req.params.province;
  const citySlug = req.params.city;
  const provName = fromSlug(provSlug);
  const cityName = fromSlug(citySlug);

  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const category = parseInt(req.query.category) || 0;
  const bed      = parseInt(req.query.bed)      || 0;
  const minPrice = parseInt(req.query.min_price) || 0;
  const maxPrice = parseInt(req.query.max_price) || 0;
  const limit    = 20;
  const offset   = (page - 1) * limit;

  const hasFilters = category || bed || minPrice || maxPrice;
  const cacheKey   = hasFilters
    ? null
    : `rumah:city:${provSlug}:${citySlug}:p${page}:v1`;

  try {
    if (cacheKey) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(cached);
      }
    }

    // Resolve actual names
    const [[match]] = await db.query(
      `SELECT province, city FROM rumah WHERE published=1 AND province LIKE ? AND city LIKE ? LIMIT 1`,
      [`%${provName}%`, `%${cityName}%`]
    );
    if (!match) return res.redirect('/rumah');

    const realProv = match.province;
    const realCity = match.city;

    // Build conditions
    const conditions = ['published=1', 'province=?', 'city=?'];
    const params     = [realProv, realCity];

    if (category) { conditions.push('category=?'); params.push(category); }
    if (bed === 4) { conditions.push('bed >= 4'); }
    else if (bed > 0) { conditions.push('bed=?'); params.push(bed); }
    if (minPrice > 0) {
      conditions.push('(CASE WHEN price < 100000 THEN price ELSE price/1000000 END) >= ?');
      params.push(minPrice);
    }
    if (maxPrice > 0) {
      conditions.push('(CASE WHEN price < 100000 THEN price ELSE price/1000000 END) <= ?');
      params.push(maxPrice);
    }

    const where = conditions.join(' AND ');

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM rumah WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT rumah_id, province, city, title, price, bed, bath, builtup, size, category, thumbnail
       FROM rumah WHERE ${where} ORDER BY hits DESC, rumah_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    // Pagination
    const paginationBtns = [];
    if (page > 1) paginationBtns.push(`<a href="?page=${page-1}${buildQS(req.query,'page')}" class="page-btn">← Prev</a>`);
    const start = Math.max(1, page - 2);
    const end   = Math.min(totalPages, page + 2);
    for (let i = start; i <= end; i++) {
      paginationBtns.push(`<a href="?page=${i}${buildQS(req.query,'page')}" class="page-btn${i===page?' active':''}">${i}</a>`);
    }
    if (page < totalPages) paginationBtns.push(`<a href="?page=${page+1}${buildQS(req.query,'page')}" class="page-btn">Next →</a>`);

    const catOptions = Object.entries(CAT_NAME).map(([k, v]) =>
      `<option value="${k}"${category===Number(k)?' selected':''}>${v}</option>`
    ).join('');

    const listingCards = rows.map(propertyCard).join('');

    const qsBase = `province=${encodeURIComponent(realProv)}&city=${encodeURIComponent(realCity)}`;

    const html = htmlHead(
      `Properti di ${realCity}, ${realProv} — finding.id`,
      `${total} properti dijual di ${realCity}, ${realProv}. Rumah, apartemen, tanah & kost. Temukan properti impian Anda di finding.id.`,
      `https://finding.id/rumah/${toSlug(realProv)}/${toSlug(realCity)}`
    ) + htmlNav('Properti') + `

<div class="page-hero" style="padding:32px 20px">
  <h1>🏠 Properti di ${esc(realCity)}</h1>
  <p>${esc(realProvince(realProv))} · ${total.toLocaleString('id-ID')} properti tersedia</p>
</div>

<div class="container">
  <div class="breadcrumb">
    <a href="/rumah">Properti</a>
    <span>›</span>
    <a href="/rumah/${toSlug(realProv)}">${esc(realProv)}</a>
    <span>›</span>
    <span>${esc(realCity)}</span>
  </div>

  <div class="listing-layout">
    <aside class="filter-sidebar">
      <h3>🔍 Filter</h3>
      <form method="get">
        <div class="filter-group">
          <label>Tipe Properti</label>
          <select class="form-select" name="category">
            <option value="">Semua</option>
            ${catOptions}
          </select>
        </div>
        <div class="filter-group">
          <label>Kamar Tidur</label>
          <select class="form-select" name="bed">
            <option value="">Semua</option>
            <option value="1"${bed===1?' selected':''}>1 KT</option>
            <option value="2"${bed===2?' selected':''}>2 KT</option>
            <option value="3"${bed===3?' selected':''}>3 KT</option>
            <option value="4"${bed===4?' selected':''}>4+ KT</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Harga Min (Jt)</label>
          <input class="form-input" type="number" name="min_price" value="${minPrice||''}" placeholder="0">
        </div>
        <div class="filter-group">
          <label>Harga Max (Jt)</label>
          <input class="form-input" type="number" name="max_price" value="${maxPrice||''}" placeholder="9999">
        </div>
        <button class="btn-filter" type="submit">Terapkan Filter</button>
        <a href="/rumah/${toSlug(realProv)}/${toSlug(realCity)}" class="btn-clear" style="display:block;text-align:center;padding:8px;background:#f3f4f6;border-radius:8px;font-size:12px;margin-top:6px;color:#666">Reset Filter</a>
      </form>
    </aside>

    <div>
      <p style="font-size:13px;color:#888;margin-bottom:16px">${total.toLocaleString('id-ID')} properti ditemukan · Halaman ${page} dari ${totalPages}</p>
      <div class="grid">${listingCards || '<p style="color:#888;padding:24px">Tidak ada properti ditemukan.</p>'}</div>
      ${paginationBtns.length ? `<div class="pagination">${paginationBtns.join('')}</div>` : ''}
    </div>
  </div>
</div>
` + htmlFoot();

    if (cacheKey) await cache.set(cacheKey, html, 600);
    res.setHeader('Cache-Control', hasFilters ? 'no-store' : 'public, max-age=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[rumah] city page error:', err.message);
    res.status(500).send('Server error');
  }
});

/** Build query string excluding a key */
function buildQS(query, exclude) {
  const parts = Object.entries(query)
    .filter(([k]) => k !== exclude)
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.join('');
}

/** Tiny helper to avoid "realProvince is not defined" */
function realProvince(p) { return p; }

module.exports = router;
