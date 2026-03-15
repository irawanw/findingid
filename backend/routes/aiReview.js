'use strict';
/**
 * GET /ai-review — Listing page: products with AI analysis, grouped by category
 */
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(price) {
  return 'Rp ' + Number(price).toLocaleString('id-ID');
}

function renderStars(rating) {
  const full  = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)));
  const empty = 5 - full;
  const on  = '<span style="color:#F59E0B">★</span>';
  const off = '<span style="color:#CBD5E1">★</span>';
  return on.repeat(full) + off.repeat(empty);
}

// Map granular DB categories → broad display buckets
const CAT_MAP = [
  { bucket: '📱 Handphone & Gadget',   match: /handphone|samsung|xiaomi|apple|iphone|oppo|vivo|infinix|realme|smartphone|smartwatch|fitness.tracker|modem|router|speaker|baterai|powerbank|earphone|headset|tablet/i },
  { bucket: '🖥️ Elektronik Rumah',     match: /tv|televisi|mesin.cuci|kulkas|ac|pendingin|kompor|setrika|blender|dispenser|rice.cooker|vacuum|kipas|penghemat.listrik|listrik/i },
  { bucket: '💄 Kecantikan & Skincare', match: /kecantikan|skincare|pelembab|foundation|lipstik|serum|sunscreen|sabun|shampo|rambut|perawatan|deodoran|parfum|korset|kosmetik|make.?up/i },
  { bucket: '👗 Fashion & Sepatu',      match: /pakaian|fashion|baju|kaos|celana|jaket|dress|sneakers|sepatu|sandal|tas|dompet|jam.tangan|topi|inner|korset/i },
  { bucket: '🍜 Makanan & Minuman',     match: /makanan|minuman|snack|kopi|teh|suplemen|vitamin|susu|nutrisi/i },
  { bucket: '👶 Bayi & Anak',           match: /bayi|anak|stroller|asi|pompa|popok|mainan|perlengkapan.bayi/i },
  { bucket: '🏠 Rumah & Perabot',       match: /rumah.tangga|perabot|furnitur|matras|bantal|kasur|lampu|dapur|meja|kursi|rak|cermin|dekorasi/i },
];

function normCat(raw) {
  if (!raw) return 'Lainnya';
  for (const { bucket, match } of CAT_MAP) {
    if (match.test(raw)) return bucket;
  }
  return 'Lainnya';
}

// Slug-friendly category anchor
function catSlug(raw) {
  return (raw || 'lainnya')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, title, price, image_url, rating, sold_count, category, source, ai_analysis_at
       FROM products
       WHERE is_active = 1 AND ai_analysis IS NOT NULL
       ORDER BY category ASC, ai_analysis_at DESC
       LIMIT 1000`
    );

    // Group by normalised broad category
    const catMap = new Map();
    for (const p of rows) {
      const key = normCat(p.category);
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key).push(p);
    }

    // Sort: defined buckets first (by CAT_MAP order), then Lainnya last
    const bucketOrder = CAT_MAP.map(c => c.bucket);
    const sorted = [...catMap.entries()].sort((a, b) => {
      const ai = bucketOrder.indexOf(a[0]);
      const bi = bucketOrder.indexOf(b[0]);
      if (ai === -1 && bi === -1) return a[0].localeCompare(b[0], 'id');
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const totalCount = rows.length;

    // Build category TOC
    const toc = sorted.map(([cat]) => `
      <a class="toc-chip" href="#${catSlug(cat)}">${escHtml(cat)}</a>
    `).join('');

    // Build category sections
    const sections = sorted.map(([cat, products]) => {
      const cards = products.map(p => {
        const img = p.image_url
          ? `<img src="${escHtml(p.image_url)}" alt="${escHtml(p.title)}" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="card-no-img">📦</div>`;
        const sold = p.sold_count ? `${p.sold_count}+ terjual` : '';
        const src  = p.source === 'shopee' ? '🛍 Shopee' : '🛒 Tokopedia';
        return `
        <a class="ar-card" href="/p/${p.id}">
          <div class="ar-card-img">${img}</div>
          <div class="ar-card-body">
            <div class="ar-card-badge">✦ AI Review</div>
            <div class="ar-card-title">${escHtml(p.title)}</div>
            <div class="ar-card-meta">
              <span class="ar-stars">${renderStars(p.rating)}</span>
              ${sold ? `<span class="ar-sold">${escHtml(sold)}</span>` : ''}
            </div>
            <div class="ar-card-price">${fmt(p.price)}</div>
            <div class="ar-card-source">${src}</div>
          </div>
        </a>`;
      }).join('');

      return `
      <section class="ar-section" id="${catSlug(cat)}">
        <h2 class="ar-section-title">${escHtml(cat)} <span class="ar-count">${products.length}</span></h2>
        <div class="ar-grid">${cards}</div>
      </section>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Produk — finding.id</title>
<meta name="description" content="${totalCount} produk dengan analisis AI mendalam dari finding.id. Temukan review jujur, kelebihan, kekurangan, dan rekomendasi cerdas.">
<link rel="canonical" href="https://finding.id/ai-review">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --orange:#F97316;--orange-d:#EA580C;
  --bg:#FFF8F3;--border:#FFE4CC;
  --text:#1A1A2E;--text-sub:#4A4A6A;--text-muted:#94A3B8;
  --radius:10px;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);min-height:100vh}

/* ── Header ── */
.ar-header{
  background:rgba(255,248,243,.97);
  border-bottom:1px solid var(--border);
  padding:0 20px;
  position:sticky;top:0;z-index:100;
}
.ar-header-inner{
  max-width:1100px;margin:0 auto;
  display:flex;align-items:center;justify-content:space-between;
  height:52px;
}
.ar-logo{
  font-size:15px;font-weight:700;color:var(--orange);
  text-decoration:none;letter-spacing:-0.5px;
}
.ar-logo span{color:var(--text)}
.ar-nav-home{
  font-size:11px;color:var(--text-sub);text-decoration:none;
  border:1px solid var(--border);border-radius:6px;
  padding:5px 12px;transition:all .15s;
}
.ar-nav-home:hover{color:var(--orange);border-color:var(--orange)}

/* ── Hero ── */
.ar-hero{
  max-width:1100px;margin:0 auto;
  padding:40px 20px 24px;
  text-align:center;
}
.ar-hero-tag{
  display:inline-block;
  background:linear-gradient(135deg,#7C3AED,#9333EA);
  color:#fff;font-size:10px;font-weight:700;letter-spacing:1.5px;
  text-transform:uppercase;border-radius:20px;padding:4px 14px;
  margin-bottom:16px;
}
.ar-hero h1{font-size:clamp(20px,4vw,32px);font-weight:700;line-height:1.3;margin-bottom:10px}
.ar-hero h1 span{color:var(--orange)}
.ar-hero p{font-size:13px;color:var(--text-sub);max-width:500px;margin:0 auto 24px;line-height:1.7}

/* ── TOC chips ── */
.toc-wrap{
  display:flex;flex-wrap:wrap;justify-content:center;gap:8px;
  max-width:1100px;margin:0 auto 40px;padding:0 20px;
}
.toc-chip{
  font-size:11px;font-weight:600;
  background:#fff;border:1px solid var(--border);border-radius:20px;
  padding:5px 14px;color:var(--text-sub);text-decoration:none;
  transition:all .15s;white-space:nowrap;
}
.toc-chip:hover{background:var(--orange);color:#fff;border-color:var(--orange)}

/* ── Sections ── */
.ar-sections{max-width:1100px;margin:0 auto;padding:0 20px 60px}
.ar-section{margin-bottom:48px}
.ar-section-title{
  font-size:15px;font-weight:700;color:var(--text);
  border-left:3px solid var(--orange);padding-left:12px;
  margin-bottom:20px;display:flex;align-items:center;gap:10px;
}
.ar-count{
  font-size:11px;font-weight:600;color:var(--orange);
  background:rgba(249,115,22,.1);border-radius:10px;
  padding:2px 8px;
}

/* ── Grid ── */
.ar-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(190px,1fr));
  gap:16px;
}

/* ── Card ── */
.ar-card{
  background:#fff;border:1px solid var(--border);border-radius:var(--radius);
  text-decoration:none;color:inherit;
  display:flex;flex-direction:column;
  transition:transform .15s,box-shadow .15s,border-color .15s;
  overflow:hidden;
}
.ar-card:hover{
  transform:translateY(-3px);
  box-shadow:0 8px 24px rgba(249,115,22,.15);
  border-color:var(--orange);
}
.ar-card-img{
  width:100%;aspect-ratio:1/1;overflow:hidden;
  background:#F8F8F8;display:flex;align-items:center;justify-content:center;
}
.ar-card-img img{width:100%;height:100%;object-fit:cover;transition:transform .2s}
.ar-card:hover .ar-card-img img{transform:scale(1.04)}
.ar-card-no-img{font-size:32px;opacity:.3}
.ar-card-body{padding:12px;display:flex;flex-direction:column;gap:6px;flex:1}
.ar-card-badge{
  font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
  background:linear-gradient(135deg,#7C3AED,#9333EA);
  color:#fff;border-radius:4px;padding:2px 7px;
  display:inline-block;align-self:flex-start;
}
.ar-card-title{
  font-size:11px;color:var(--text);line-height:1.5;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.ar-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ar-stars{font-size:11px}
.ar-sold{font-size:10px;color:var(--text-muted)}
.ar-card-price{font-size:13px;font-weight:700;color:var(--orange)}
.ar-card-source{font-size:10px;color:var(--text-muted)}

/* ── Footer ── */
.ar-footer{
  border-top:1px solid var(--border);
  padding:16px 20px;
  text-align:center;
  font-size:10px;color:var(--text-muted);letter-spacing:1px;
}
.ar-footer a{color:var(--orange);text-decoration:none}

@media(max-width:600px){
  .ar-grid{grid-template-columns:repeat(2,1fr)}
  .ar-hero{padding:28px 16px 16px}
}
</style>
</head>
<body>

<header class="ar-header">
  <div class="ar-header-inner">
    <a class="ar-logo" href="/"><span>finding</span>.id</a>
    <a class="ar-nav-home" href="/">← Cari Produk</a>
  </div>
</header>

<div class="ar-hero">
  <div class="ar-hero-tag">✦ AI Review</div>
  <h1>Review <span>AI</span> untuk<br>Produk Terbaik Indonesia</h1>
  <p>${totalCount} produk telah dianalisis oleh AI kami — kelebihan, kekurangan, skor, dan rekomendasi jujur.</p>
</div>

<div class="toc-wrap">${toc}</div>

<div class="ar-sections">${sections}</div>

<footer class="ar-footer">
  finding.id &mdash; AI Marketplace Intelligence &mdash;
  <a href="/">Cari Produk</a>
</footer>

</body>
</html>`;

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/html').send(html);
  } catch (err) {
    console.error('[ai-review] error:', err.message);
    res.status(500).send('Server error');
  }
});

module.exports = router;
