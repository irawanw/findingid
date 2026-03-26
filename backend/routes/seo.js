'use strict';
/**
 * Programmatic SEO pages — Day 15-17
 *
 * GET /top/:slug  — best products under a price ceiling
 *                   e.g. /top/laptop-5jt, /top/laptop-gaming-10jt
 *
 * GET /best/:slug — best-rated products in a category (no price filter)
 *                   e.g. /best/laptop, /best/handphone
 *
 * Quality gate: <meta name="robots" content="noindex"> when < 5 products.
 * Internal links: related price tiers + sibling categories.
 * Schema.org ItemList for Google Rich Results.
 * seo_pages table tracking (async, non-blocking).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const path    = require('path');

// ── Category slug map ──────────────────────────────────────────
// Longer slugs MUST come before shorter ones — parseTopSlug() tries longest first.
const CAT_MAP = {
  'laptop-gaming':   { cat: 'Laptop',                  keyword: 'gaming',                                              label: 'Laptop Gaming' },
  'laptop':          { cat: 'Laptop',                  keyword: ['laptop', 'notebook', 'macbook', 'chromebook'],       label: 'Laptop' },
  'handphone':       { cat: 'Handphone',               keyword: ['samsung', 'xiaomi', 'oppo', 'vivo', 'realme', 'iphone', 'nokia', 'infinix', 'poco', 'redmi', 'galaxy', 'handphone', ' hp ', 'smartphone'], minPrice: 300000, label: 'Handphone' },
  'hp':              { cat: 'Handphone',               keyword: ['samsung', 'xiaomi', 'oppo', 'vivo', 'realme', 'iphone', 'nokia', 'infinix', 'poco', 'redmi', 'galaxy', 'handphone', ' hp ', 'smartphone'], minPrice: 300000, label: 'HP' },
  'tablet':          { cat: 'Tablet',                  keyword: ['tablet', 'ipad', 'tab '],   exclude: ['casing', 'case for', 'case ipad', 'case tab', 'ipad case', 'tab case', 'acrylic case', ' case ', 'cover for', 'softcase', 'hardcase', 'keyboard case', 'keyboard cover', 'yfold', 'danycase', 'pencil holder'], label: 'Tablet' },
  'monitor':         { cat: 'Monitor',                 keyword: null,                                                  label: 'Monitor' },
  'headphone':       { cat: 'Perangkat Audio',         keyword: 'headphone',                                          label: 'Headphone' },
  'earphone':        { cat: 'Perangkat Audio',         keyword: 'earphone',                                           label: 'Earphone & TWS' },
  'speaker':         { cat: 'Perangkat Audio',         keyword: 'speaker',                                            label: 'Speaker' },
  'kulkas':          { cat: 'Peralatan Rumah Tangga',  keyword: 'kulkas',                                             label: 'Kulkas' },
  'mesin-cuci':      { cat: 'Peralatan Rumah Tangga',  keyword: 'mesin cuci',                                         label: 'Mesin Cuci' },
  'tv':              { cat: 'TV & Perangkat Hiburan',  keyword: 'tv',                                                 label: 'TV' },
  'keyboard':        { cat: 'Aksesoris Komputer',      keyword: ['keyboard mechanical', 'keyboard gaming', 'keyboard wireless', 'keyboard bluetooth', 'keyboard usb'], label: 'Keyboard' },
  'mouse':           { cat: 'Aksesoris Komputer',      keyword: 'mouse',                                              label: 'Mouse' },
  'skincare':        { cat: 'Kecantikan & Perawatan',  keyword: ['serum', 'sunscreen', 'toner', 'skincare', 'essence', 'face wash', 'pembersih wajah', 'micellar', 'pelembab wajah', 'krim wajah'], exclude: ['sabun mandi', 'body wash', 'sampo', 'shampoo', 'deodorant', 'sabun cuci', 'deterjen'], label: 'Skincare' },
  'sepatu':          { cat: 'Sepatu & Tas',            keyword: 'sepatu',                                             label: 'Sepatu' },
  'gpu':             { cat: 'Komponen Komputer',       keyword: ['gpu', 'vga card', 'rtx ', 'gtx ', 'radeon rx', 'geforce', 'rx 6', 'rx 7', 'arc a'], exclude: ['fullset', 'full set', 'pc gaming', 'komputer gaming', 'laptop gaming', 'laptop ', 'core i3', 'core i5', 'core i7', 'core i9', 'soldering', 'kursi', 'gaming chair'], label: 'GPU / VGA Card' },
  'ssd':             { cat: 'Komponen Komputer',       keyword: 'ssd',                                                label: 'SSD' },
  'printer':         { cat: 'Printer & Scanner',       keyword: null,                                                 label: 'Printer' },
  'smartwatch':      { cat: 'Smartwatch & Aksesoris', keyword: null,                                                  label: 'Smartwatch' },
  'powerbank':       { cat: 'Aksesoris Handphone',    keyword: 'powerbank',                                           label: 'Powerbank' },
  'casing-hp':       { cat: 'Aksesoris Handphone',    keyword: 'casing',                                             label: 'Casing HP' },
};

// Price tiers used for related link generation and sitemap
const PRICE_SUFFIXES = ['500rb', '1jt', '2jt', '3jt', '5jt', '10jt', '15jt', '20jt'];

// ── Price helpers ──────────────────────────────────────────────
function parsePrice(s) {
  const m = String(s || '').match(/^(\d+(?:[.,]\d+)?)(jt|juta|rb|ribu|k)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(',', '.'));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'jt' || unit === 'juta') return Math.round(num * 1_000_000);
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') return Math.round(num * 1_000);
  return Math.round(num);
}

function fmtPriceLabel(s) {
  const n = parsePrice(s);
  if (!n) return s;
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `Rp ${Number.isInteger(v) ? v : v.toLocaleString('id-ID')} Juta`;
  }
  return `Rp ${(n / 1_000).toLocaleString('id-ID')} Ribu`;
}

function parseTopSlug(slug) {
  // Try longest cat slugs first to avoid partial matches (laptop-gaming before laptop)
  const catSlugs = Object.keys(CAT_MAP).sort((a, b) => b.length - a.length);
  for (const cs of catSlugs) {
    if (slug.startsWith(cs + '-')) {
      const priceSuffix = slug.slice(cs.length + 1);
      const price = parsePrice(priceSuffix);
      if (price && price >= 50_000) {
        return { catSlug: cs, priceSuffix, price };
      }
    }
  }
  return null;
}

// ── Keyword SQL builder (supports string or string[], plus exclude[]) ──
function keywordSql(keyword, exclude) {
  let clause = '';
  const params = [];

  if (keyword) {
    const kws = Array.isArray(keyword) ? keyword : [keyword];
    clause += ' AND (' + kws.map(() => 'title LIKE ?').join(' OR ') + ')';
    kws.forEach(k => params.push(`%${k}%`));
  }

  if (exclude && exclude.length) {
    exclude.forEach(e => {
      clause += ' AND title NOT LIKE ?';
      params.push(`%${e}%`);
    });
  }

  return { clause, params };
}

// ── HTML helpers ───────────────────────────────────────────────
function fmtPrice(p) {
  const n = parseFloat(p);
  if (!n) return '-';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function stars(r) {
  const n = parseFloat(r) || 0;
  const full = Math.floor(n);
  const half = n - full >= 0.4 ? 1 : 0;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - half);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── seo_pages tracking (async, non-blocking) ─────────────────
async function trackPage(urlPath, pageType, title, productCount) {
  try {
    await db.query(
      `INSERT INTO seo_pages
         (url_path, page_type, title, product_count, quality_score, is_indexable, generated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON CONFLICT (url_path) DO UPDATE SET
         title         = EXCLUDED.title,
         product_count = EXCLUDED.product_count,
         quality_score = EXCLUDED.quality_score,
         is_indexable  = EXCLUDED.is_indexable,
         updated_at    = NOW()`,
      [
        urlPath, pageType, title, productCount,
        productCount >= 5 ? true : false,
        productCount >= 5 ? true : false,
      ]
    );
  } catch (_) {}
}

// ── Shared HTML renderer ──────────────────────────────────────
function renderPage({ title, desc, products, relatedLinks, canonicalUrl, searchQ }) {
  const indexable = products.length >= 5;
  const robotsMeta = indexable ? 'index, follow' : 'noindex, follow';

  const cardHtml = products.map((p, i) => `
    <a class="cari-card" href="${p.affiliate_link ? esc(p.affiliate_link) : `/go/${p.id}`}" target="_blank" rel="noopener noreferrer sponsored">
      <div class="cari-card-img">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="${i < 3 ? 'eager' : 'lazy'}">` : '📦'}
      </div>
      <div class="cari-card-body">
        <div class="cari-card-title">${esc(p.title)}</div>
        <div class="cari-card-price">${fmtPrice(p.price)}</div>
        <div class="cari-card-meta">
          <span class="cari-stars">${stars(p.rating)}</span>
          <span>${parseFloat(p.rating) || '-'}/5</span>
          ${p.sold_count ? `<span>· ${Number(p.sold_count).toLocaleString('id-ID')} terjual</span>` : ''}
        </div>
      </div>
    </a>`).join('');

  const schemaItems = products.slice(0, 5).map((p, i) => `{
      "@type": "ListItem",
      "position": ${i + 1},
      "name": "${esc(p.title)}",
      "url": "https://finding.id/go/${p.id}"
    }`).join(',\n    ');

  const schemaJson = products.length ? `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "${esc(title)}",
    "description": "${esc(desc)}",
    "numberOfItems": ${products.length},
    "itemListElement": [
    ${schemaItems}
    ]
  }
  </script>` : '';

  const priceNums = products.filter(p => parseFloat(p.price) > 0).map(p => parseFloat(p.price));
  const avgPrice = priceNums.length ? priceNums.reduce((a, b) => a + b, 0) / priceNums.length : 0;
  const avgPriceFmt = avgPrice ? fmtPrice(avgPrice) : null;

  const relatedHtml = relatedLinks.length ? `
  <nav class="cari-related">
    <p class="cari-section-title">Halaman terkait</p>
    <div class="cari-related-links">
      ${relatedLinks.map(l => `<a href="${esc(l.url)}" class="cari-related-link">${esc(l.label)}</a>`).join('')}
    </div>
  </nav>` : '';

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — finding.id</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${robotsMeta}">
<link rel="canonical" href="${esc(canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonicalUrl)}">
<meta property="og:title" content="${esc(title)} — finding.id">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://finding.id/og-image.png">
<meta name="theme-color" content="#F97316">
${schemaJson}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono',monospace,sans-serif;background:#FFF8F3;color:#1a1a1a}
.cari-header{background:#fff;border-bottom:1px solid #ffe4cc;padding:12px 20px;display:flex;align-items:center;gap:12px}
.cari-logo{font-weight:700;color:#F97316;font-size:18px;text-decoration:none}
.cari-back{color:#666;font-size:13px;text-decoration:none}
.cari-back:hover{color:#F97316}
.cari-hero{padding:32px 20px 20px;max-width:900px;margin:0 auto}
.cari-hero h1{font-size:clamp(18px,4vw,28px);font-weight:700;color:#1a1a1a;margin-bottom:8px}
.cari-hero p{color:#666;font-size:14px;line-height:1.6}
.cari-stats{display:flex;gap:16px;margin-top:12px;flex-wrap:wrap}
.cari-stat{background:#FFF3EB;border:1px solid #FFD4A8;border-radius:8px;padding:6px 12px;font-size:12px;color:#C2410C;font-weight:600}
.cari-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;max-width:900px;margin:0 auto;padding:0 20px 20px}
.cari-card{display:flex;flex-direction:column;background:#fff;border:1px solid #ffe4cc;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .15s,box-shadow .15s}
.cari-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(249,115,22,.15)}
.cari-card-img{aspect-ratio:1;overflow:hidden;background:#f5f5f5;display:flex;align-items:center;justify-content:center;font-size:32px}
.cari-card-img img{width:100%;height:100%;object-fit:cover}
.cari-card-body{padding:10px;flex:1;display:flex;flex-direction:column;gap:4px}
.cari-card-title{font-size:11px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:#333}
.cari-card-price{font-size:13px;font-weight:700;color:#F97316}
.cari-card-meta{font-size:10px;color:#888;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.cari-stars{color:#f59e0b;font-size:10px;letter-spacing:-1px}
.cari-cta{background:linear-gradient(135deg,#F97316,#EA580C);color:#fff;border:none;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;width:100%;max-width:400px;display:block;text-align:center;text-decoration:none;margin:8px auto 0}
.cari-cta:hover{background:linear-gradient(135deg,#EA580C,#C2410C)}
.cari-ai-box{background:#fff;border:1px solid #ffe4cc;border-radius:16px;padding:20px;max-width:900px;margin:0 auto 24px;text-align:center}
.cari-ai-box h2{font-size:16px;color:#333;margin-bottom:8px}
.cari-ai-box p{font-size:13px;color:#666;margin-bottom:16px}
.cari-section-title{font-size:14px;font-weight:700;color:#666;max-width:900px;margin:0 auto 12px;padding:0 20px;text-transform:uppercase;letter-spacing:.5px}
.cari-empty{text-align:center;padding:40px 20px;color:#999;max-width:900px;margin:0 auto}
.cari-related{max-width:900px;margin:0 auto 32px;padding:0 20px}
.cari-related-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.cari-related-link{background:#fff;border:1px solid #ffe4cc;border-radius:8px;padding:6px 12px;font-size:12px;color:#C2410C;text-decoration:none;font-weight:600}
.cari-related-link:hover{background:#FFF3EB}
@media(max-width:480px){.cari-grid{grid-template-columns:repeat(2,1fr)}}
</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body>

<header class="cari-header">
  <a href="/" class="cari-logo">finding.id</a>
  <a href="/" class="cari-back">← Cari produk lain</a>
</header>

<main>
  <div class="cari-hero">
    <h1>${esc(title)}</h1>
    <p>${esc(desc)}</p>
    ${products.length > 0 ? `<div class="cari-stats">
      <span class="cari-stat">📦 ${products.length} produk ditemukan</span>
      ${avgPriceFmt ? `<span class="cari-stat">💰 Rata-rata ${avgPriceFmt}</span>` : ''}
      <span class="cari-stat">✅ Data dari Shopee</span>
    </div>` : ''}
  </div>

  ${products.length > 0 ? `
  <p class="cari-section-title">Produk Terlaris & Terrating</p>
  <div class="cari-grid">${cardHtml}</div>
  ` : `<div class="cari-empty">
    <p>🔍 Sedang mengumpulkan data produk untuk kategori ini.</p>
  </div>`}

  ${relatedHtml}

  <div class="cari-ai-box">
    <h2>🤖 Mau rekomendasi yang lebih personal?</h2>
    <p>Ceritakan kebutuhanmu — budget, kegunaan, atau merek favorit — AI finding.id akan carikan yang paling cocok.</p>
    <a href="/?q=${encodeURIComponent(searchQ)}" class="cari-cta">Tanya AI finding.id →</a>
  </div>
</main>

</body>
</html>`;
}

// ── GET /top/:slug ─────────────────────────────────────────────
router.get('/top/:slug', async (req, res) => {
  const { slug } = req.params;
  const parsed = parseTopSlug(slug);
  if (!parsed) return res.status(404).sendFile(path.join(__dirname, '../../index.html'));

  const { catSlug, priceSuffix, price } = parsed;
  const catDef = CAT_MAP[catSlug];
  const priceLabelFmt = fmtPriceLabel(priceSuffix);
  const title = `${catDef.label} Terbaik di Bawah ${priceLabelFmt}`;
  const desc  = `Rekomendasi ${catDef.label} terbaik dengan harga di bawah ${priceLabelFmt}. ` +
                `Data real dari Shopee, dianalisis AI finding.id berdasarkan rating dan jumlah penjualan.`;
  const canonicalUrl = `https://finding.id/top/${slug}`;

  let products = [];
  try {
    const { clause: keywordClause, params: keywordParams } = keywordSql(catDef.keyword, catDef.exclude);
    const minPrice = catDef.minPrice || 50000;
    const [rows] = await db.query(
      `SELECT id, title, price, rating, sold_count, link, affiliate_link, image_url
       FROM products
       WHERE is_active = true AND category = ? AND price BETWEEN ? AND ?
         ${keywordClause}
       ORDER BY (COALESCE(rating,0) * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
       LIMIT 20`,
      [catDef.cat, minPrice, price, ...keywordParams]
    );
    products = rows;
  } catch (err) {
    console.error('[seo/top] db error:', err.message);
  }

  // Related: best page + nearby price tiers
  const relatedLinks = [
    { url: `/best/${catSlug}`, label: `${catDef.label} Terbaik (semua harga)` },
    ...PRICE_SUFFIXES
      .filter(ps => ps !== priceSuffix)
      .filter(ps => { const p2 = parsePrice(ps); return p2 >= price * 0.2 && p2 <= price * 3; })
      .slice(0, 5)
      .map(ps => ({ url: `/top/${catSlug}-${ps}`, label: `${catDef.label} < ${fmtPriceLabel(ps)}` })),
  ];

  setImmediate(() => trackPage(`/top/${slug}`, 'top', title, products.length));

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.type('html').send(renderPage({ title, desc, products, relatedLinks, canonicalUrl, searchQ: `${catDef.label} harga di bawah ${priceLabelFmt}` }));
});

// ── GET /best/:slug ────────────────────────────────────────────
router.get('/best/:slug', async (req, res) => {
  const { slug } = req.params;
  const catDef = CAT_MAP[slug];
  if (!catDef) return res.status(404).sendFile(path.join(__dirname, '../../index.html'));

  const title = `${catDef.label} Terbaik di Indonesia`;
  const desc  = `Rekomendasi ${catDef.label} terbaik berdasarkan rating dan penjualan tertinggi di Shopee. ` +
                `Dipilih dan dianalisis AI finding.id untuk kamu.`;
  const canonicalUrl = `https://finding.id/best/${slug}`;

  let products = [];
  try {
    const { clause: keywordClause, params: keywordParams } = keywordSql(catDef.keyword, catDef.exclude);
    const minPrice = catDef.minPrice || 50000;
    const [rows] = await db.query(
      `SELECT id, title, price, rating, sold_count, link, affiliate_link, image_url
       FROM products
       WHERE is_active = true AND category = ? AND price >= ?
         ${keywordClause}
       ORDER BY (COALESCE(rating,0) * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
       LIMIT 20`,
      [catDef.cat, minPrice, ...keywordParams]
    );
    products = rows;
  } catch (err) {
    console.error('[seo/best] db error:', err.message);
  }

  // Related: price tiers for this cat + sibling /best pages
  const priceTiers = PRICE_SUFFIXES.slice(0, 5).map(ps => ({
    url:   `/top/${slug}-${ps}`,
    label: `${catDef.label} < ${fmtPriceLabel(ps)}`,
  }));

  const siblings = Object.entries(CAT_MAP)
    .filter(([s]) => s !== slug)
    .slice(0, 4)
    .map(([s, d]) => ({ url: `/best/${s}`, label: `${d.label} Terbaik` }));

  const relatedLinks = [...priceTiers, ...siblings];

  setImmediate(() => trackPage(`/best/${slug}`, 'best', title, products.length));

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.type('html').send(renderPage({ title, desc, products, relatedLinks, canonicalUrl, searchQ: `${catDef.label} terbaik` }));
});

module.exports = router;
module.exports.CAT_MAP = CAT_MAP;
module.exports.PRICE_SUFFIXES = PRICE_SUFFIXES;
