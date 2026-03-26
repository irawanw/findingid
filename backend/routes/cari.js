'use strict';
/**
 * GET /cari/:slug
 *
 * SSR landing pages for SEO. Each slug maps to a category + query.
 * Returns full HTML with real product data baked in — Google indexes it.
 * The finding.id SPA boots on top for interactivity.
 *
 * Examples:
 *   /cari/laptop-murah      → top laptops sorted by price
 *   /cari/handphone-gaming  → top gaming phones
 *   /cari/hp-samsung        → Samsung phones
 */

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const path    = require('path');
const fs      = require('fs');

// ── Slug → query/category mapping ─────────────────────────────
const SLUGS = {
  // Laptop
  'laptop-murah':          { q: 'laptop murah',          cat: 'Laptop',     title: 'Laptop Murah Terbaik',              desc: 'Rekomendasi laptop murah berkualitas dari Shopee. Harga, rating, dan ulasan real — dianalisis AI.' },
  'laptop-gaming':         { q: 'laptop gaming',          cat: 'Laptop',     title: 'Laptop Gaming Terbaik',             desc: 'Laptop gaming terbaik di kelasnya. Performa tinggi, harga terjangkau — rekomendasi AI finding.id.' },
  'laptop-mahasiswa':      { q: 'laptop mahasiswa',       cat: 'Laptop',     title: 'Laptop untuk Mahasiswa',            desc: 'Laptop ringan dan hemat untuk mahasiswa. Cek rekomendasi terbaik berdasarkan rating dan harga.' },
  'laptop-bisnis':         { q: 'laptop bisnis',          cat: 'Laptop',     title: 'Laptop Bisnis & Kerja',             desc: 'Laptop untuk kerja dan bisnis. Rekomendasi terpercaya dari AI finding.id.' },

  // Handphone
  'handphone-murah':       { q: 'handphone murah',        cat: 'Handphone',  title: 'Handphone Murah Terbaik',           desc: 'HP murah dengan spesifikasi terbaik. AI finding.id merekomendasikan berdasarkan data nyata Shopee.' },
  'handphone-gaming':      { q: 'handphone gaming',       cat: 'Handphone',  title: 'HP Gaming Terbaik',                 desc: 'HP gaming performa tinggi harga terjangkau. Cek rekomendasi AI finding.id.' },
  'hp-samsung':            { q: 'hp samsung',             cat: 'Handphone',  title: 'HP Samsung Terbaik',                desc: 'Rekomendasi HP Samsung terbaik dari Shopee. Harga dan rating real, dianalisis AI.' },
  'hp-xiaomi':             { q: 'hp xiaomi',              cat: 'Handphone',  title: 'HP Xiaomi Terbaik',                 desc: 'HP Xiaomi & Redmi terbaik untuk semua budget. Rekomendasi AI finding.id.' },
  'hp-oppo':               { q: 'hp oppo',                cat: 'Handphone',  title: 'HP OPPO Terbaik',                   desc: 'HP OPPO dan Reno terbaik di Shopee. Data real, rekomendasi AI.' },
  'hp-realme':             { q: 'hp realme',              cat: 'Handphone',  title: 'HP Realme Terbaik',                 desc: 'HP Realme terbaik untuk gaming dan daily use. Cek di finding.id.' },
  'iphone-murah':          { q: 'iphone murah',           cat: 'Handphone',  title: 'iPhone Harga Terbaik',              desc: 'iPhone dengan harga terbaik di Shopee. Rekomendasi berdasarkan data real.' },

  // Elektronik
  'headset-gaming':        { q: 'headset gaming',         cat: null,         title: 'Headset Gaming Terbaik',            desc: 'Headset gaming terbaik untuk PS5, Xbox, dan PC. Rekomendasi AI finding.id.' },
  'earphone-murah':        { q: 'earphone murah',         cat: null,         title: 'Earphone & TWS Murah',              desc: 'Earphone dan TWS murah berkualitas. Cek rekomendasi terbaik dari finding.id.' },
  'smartwatch-murah':      { q: 'smartwatch murah',       cat: null,         title: 'Smartwatch Murah Terbaik',          desc: 'Smartwatch dengan fitur lengkap harga murah. Rekomendasi AI based on data Shopee.' },
  'powerbank-terbaik':     { q: 'powerbank terbaik',      cat: null,         title: 'Powerbank Terbaik & Terlaris',      desc: 'Powerbank kapasitas besar dengan fast charging. Rekomendasi terpercaya dari finding.id.' },
  'keyboard-gaming':       { q: 'keyboard gaming',        cat: 'Aksesoris Komputer', title: 'Keyboard Gaming Terbaik',   desc: 'Keyboard gaming mechanical & membrane terbaik. Rekomendasi AI finding.id.' },
  'monitor-gaming':        { q: 'monitor gaming',         cat: null,         title: 'Monitor Gaming Terbaik',            desc: 'Monitor gaming 144Hz, 165Hz, 4K terbaik untuk PC dan PS5.' },

  // Rumah tangga
  'rice-cooker-terbaik':   { q: 'rice cooker terbaik',   cat: 'Peralatan Rumah Tangga', title: 'Rice Cooker Terbaik',   desc: 'Rice cooker terbaik dan hemat listrik. Rekomendasi berdasarkan rating dan penjualan Shopee.' },
  'vacuum-cleaner':        { q: 'vacuum cleaner',         cat: 'Peralatan Rumah Tangga', title: 'Vacuum Cleaner Terbaik', desc: 'Vacuum cleaner kuat dan ringan untuk rumah. Rekomendasi AI finding.id.' },
  'blender-murah':         { q: 'blender murah',          cat: 'Peralatan Rumah Tangga', title: 'Blender Murah Terbaik', desc: 'Blender murah kuat untuk dapur. Rekomendasi terbaik dari finding.id.' },

  // Fashion & lainnya
  'sepatu-pria':           { q: 'sepatu pria',            cat: 'Sepatu & Tas', title: 'Sepatu Pria Terlaris',          desc: 'Sepatu pria terlaris dan terbaik di Shopee. Rekomendasi AI berdasarkan rating nyata.' },
  'tas-wanita':            { q: 'tas wanita',             cat: 'Sepatu & Tas', title: 'Tas Wanita Terbaik',            desc: 'Tas wanita stylish dan berkualitas. Cek rekomendasi terbaik dari finding.id.' },
  'skincare-terbaik':      { q: 'skincare terbaik',       cat: 'Kecantikan & Perawatan', title: 'Skincare Terbaik Indonesia', desc: 'Skincare terbaik untuk semua jenis kulit. Data real dari Shopee, dianalisis AI.' },
  'parfum-pria':           { q: 'parfum pria',            cat: 'Kecantikan & Perawatan', title: 'Parfum Pria Terbaik',  desc: 'Parfum pria tahan lama dengan harga terjangkau. Rekomendasi finding.id.' },

  // ── Lebaran / Idul Fitri 2025 ──────────────────────────────────────────────
  'baju-koko':             { q: 'baju koko',              cat: null,           title: 'Baju Koko Lebaran Terbaik 2025', desc: 'Koleksi baju koko lebaran pria terbaik dan terlaris. Model modern & klasik, harga terjangkau. Rekomendasi AI finding.id.' },
  'baju-koko-pria':        { q: 'baju koko pria',         cat: null,           title: 'Baju Koko Pria Lebaran 2025',   desc: 'Baju koko pria untuk sholat Ied dan silaturahmi. Cek pilihan terlaris di Shopee, dianalisis AI.' },
  'baju-lebaran-anak':     { q: 'baju lebaran anak',      cat: null,           title: 'Baju Lebaran Anak Terbaik',     desc: 'Baju lebaran anak lucu dan berkualitas. Model terbaru 2025, harga terjangkau. Rekomendasi finding.id.' },
  'baju-couple-lebaran':   { q: 'baju couple lebaran',    cat: null,           title: 'Baju Couple Lebaran 2025',      desc: 'Baju couple lebaran keluarga dan pasangan. Desain kompak dan serasi untuk Idul Fitri 2025.' },
  'mukena-lebaran':        { q: 'mukena cantik',          cat: null,           title: 'Mukena Cantik Lebaran 2025',    desc: 'Mukena cantik untuk sholat Ied dan ibadah. Bahan premium, model terbaru 2025 terlaris di Shopee.' },
  'sarung-lebaran':        { q: 'sarung pria',            cat: null,           title: 'Sarung Pria Lebaran Terbaik',   desc: 'Sarung pria berkualitas untuk sholat Ied. Motif klasik dan modern, harga terjangkau.' },
  'peci-kopiah':           { q: 'peci kopiah',            cat: null,           title: 'Peci & Kopiah Lebaran Terbaik', desc: 'Peci dan kopiah pria untuk lebaran. Pilihan terlaris dan terrating di Shopee 2025.' },
  'kue-lebaran':           { q: 'kue lebaran',            cat: null,           title: 'Kue Lebaran Terlaris 2025',     desc: 'Kue lebaran terlaris: nastar, kastengel, putri salju, dan kue kering lainnya. Rekomendasi terbaik finding.id.' },
  'nastar-lebaran':        { q: 'nastar kue lebaran',     cat: null,           title: 'Nastar Lebaran Terenak & Terlaris', desc: 'Nastar nanas premium terlaris untuk lebaran. Pilihan toples dan gift box. Data real Shopee.' },
  'hampers-lebaran':       { q: 'hampers lebaran',        cat: null,           title: 'Hampers Lebaran 2025 Terbaik',  desc: 'Hampers lebaran eksklusif untuk keluarga, relasi, dan klien. Pilihan premium dan ekonomis terlaris di Shopee.' },
  'parcel-lebaran':        { q: 'parcel lebaran',         cat: null,           title: 'Parcel Lebaran Terlaris 2025',  desc: 'Parcel lebaran siap kirim untuk hadiah Idul Fitri. Berbagai pilihan isi dan harga.' },
  'amplop-lebaran':        { q: 'amplop lebaran',         cat: null,           title: 'Amplop Lebaran & THR Terbaik',  desc: 'Amplop lebaran cantik untuk berbagi THR. Desain islami dan lucu, cocok untuk anak-anak.' },
  'karpet-sajadah':        { q: 'sajadah karpet',         cat: null,           title: 'Sajadah & Karpet Masjid Lebaran', desc: 'Sajadah tebal dan karpet masjid untuk lebaran. Bahan nyaman, motif islami terlaris di Shopee.' },
  'parfum-lebaran':        { q: 'parfum lebaran',         cat: null,           title: 'Parfum Lebaran & Minyak Wangi',  desc: 'Parfum dan minyak wangi untuk lebaran. Aroma tahan lama, pilihan pria dan wanita terlaris.' },
  'sepatu-lebaran':        { q: 'sepatu lebaran',         cat: null,           title: 'Sepatu Lebaran Terlaris 2025',  desc: 'Sepatu baru untuk lebaran pria, wanita, dan anak. Model terbaru, nyaman dipakai seharian.' },
};

// ── Price formatter ────────────────────────────────────────────
function fmtPrice(p) {
  const n = parseFloat(p);
  if (!n) return '-';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

// ── Build star HTML ───────────────────────────────────────────
function stars(r) {
  const n = parseFloat(r) || 0;
  const full = Math.floor(n);
  const half = n - full >= 0.4 ? 1 : 0;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - half);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Route handler ─────────────────────────────────────────────
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;
  const def = SLUGS[slug];

  if (!def) {
    return res.status(404).sendFile(path.join(__dirname, '../../index.html'));
  }

  // Query top products for this category
  let products = [];
  try {
    let sql, params;
    if (def.cat) {
      sql    = `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url
                FROM products
                WHERE is_active = true AND category = ?
                  AND title LIKE ?
                ORDER BY (rating * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
                LIMIT 9`;
      params = [def.cat, `%${def.q.split(' ')[0]}%`];
    } else {
      sql    = `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url
                FROM products
                WHERE is_active = true
                  AND (title LIKE ? OR title LIKE ?)
                ORDER BY (rating * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
                LIMIT 9`;
      const kw = def.q.split(' ');
      params = [`%${kw[0]}%`, `%${kw.join('%')}%`];
    }
    const [rows] = await db.query(sql, params);
    products = rows;
  } catch (err) {
    console.error('[cari] db error:', err.message);
  }

  // Build product cards HTML
  const cardHtml = products.map((p, i) => `
    <a class="cari-card" href="${p.affiliate_link || p.link || `/go/${p.id}`}" target="_blank" rel="noopener noreferrer sponsored">
      <div class="cari-card-img">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="${i < 3 ? 'eager' : 'lazy'}">` : '📦'}
      </div>
      <div class="cari-card-body">
        <div class="cari-card-title">${esc(p.title)}</div>
        <div class="cari-card-price">${fmtPrice(p.price)}</div>
        <div class="cari-card-meta">
          <span class="cari-stars" aria-label="Rating ${p.rating}">${stars(p.rating)}</span>
          <span>${parseFloat(p.rating)||'-'}/5</span>
          ${p.sold_count ? `<span>· ${Number(p.sold_count).toLocaleString('id-ID')} terjual</span>` : ''}
        </div>
      </div>
    </a>`).join('');

  const noProducts = products.length === 0;
  const productCount = products.length;
  const avgPrice = products.length
    ? Math.round(products.filter(p => p.price > 0).reduce((s, p) => s + parseFloat(p.price), 0)
        / products.filter(p => p.price > 0).length)
    : 0;
  const avgPriceFmt = avgPrice ? fmtPrice(avgPrice) : null;

  // Schema.org ItemList for Google Rich Results
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
    "name": "${esc(def.title)}",
    "description": "${esc(def.desc)}",
    "numberOfItems": ${productCount},
    "itemListElement": [
    ${schemaItems}
    ]
  }
  </script>` : '';

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(def.title)} — finding.id</title>
<meta name="description" content="${esc(def.desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://finding.id/cari/${slug}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://finding.id/cari/${slug}">
<meta property="og:title" content="${esc(def.title)} — finding.id">
<meta property="og:description" content="${esc(def.desc)}">
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
    <h1>${esc(def.title)}</h1>
    <p>${esc(def.desc)}</p>
    ${productCount > 0 ? `<div class="cari-stats">
      <span class="cari-stat">📦 ${productCount} produk ditemukan</span>
      ${avgPriceFmt ? `<span class="cari-stat">💰 Rata-rata ${avgPriceFmt}</span>` : ''}
      <span class="cari-stat">✅ Data dari Shopee</span>
    </div>` : ''}
  </div>

  ${productCount > 0 ? `
  <p class="cari-section-title">Produk Terlaris & Terrating</p>
  <div class="cari-grid">${cardHtml}</div>
  ` : `<div class="cari-empty">
    <p>🔍 Sedang mengumpulkan data produk untuk kategori ini.</p>
  </div>`}

  <div class="cari-ai-box">
    <h2>🤖 Mau rekomendasi yang lebih personal?</h2>
    <p>Ceritakan kebutuhanmu — budget, kegunaan, atau merek favorit — AI finding.id akan carikan yang paling cocok.</p>
    <a href="/?q=${encodeURIComponent(def.q)}" class="cari-cta">Tanya AI finding.id →</a>
  </div>
</main>

</body>
</html>`;

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.type('html').send(html);
});

module.exports = router;
module.exports.SLUGS = SLUGS;
