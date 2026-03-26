'use strict';
/**
 * GET /deals — Products with price drops, sorted by biggest discount
 */
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmt(price) {
  return 'Rp ' + Number(price).toLocaleString('id-ID');
}

router.get('/', async (req, res) => {
  try {
    // Per-variant comparison: for each (product, variant) pair compare
    // MAX(price) vs MIN(price) for that SAME variant in price_history.
    // ROW_NUMBER picks the variant with the biggest drop per product.
    // Never compares variant A's peak vs variant B's lowest price.
    const [rows] = await db.query(
      `SELECT * FROM (
         SELECT
           p.id, p.title, p.image_url, p.rating,
           p.sold_count, p.category, p.source, p.affiliate_link, p.link,
           (p.ai_analysis IS NOT NULL) AS has_ai_page,
           agg.variant_name,
           agg.peak_price,
           agg.low_price AS cur_price,
           (agg.peak_price - agg.low_price)::numeric / agg.peak_price AS drop_pct,
           ROW_NUMBER() OVER (
             PARTITION BY p.id
             ORDER BY (agg.peak_price - agg.low_price)::numeric / agg.peak_price DESC
           ) AS rn
         FROM products p
         JOIN (
           SELECT
             ph.product_id,
             ph.variant_name,
             MAX(ph.price) AS peak_price,
             MIN(ph.price) AS low_price
           FROM price_history ph
           WHERE
             -- Skip null-variant rows when the product also has named variants
             -- (null variant = Shopee's displayed "default" price, not a real variant)
             NOT (ph.variant_name IS NULL AND EXISTS (
               SELECT 1 FROM price_history ph2
               WHERE ph2.product_id = ph.product_id AND ph2.variant_name IS NOT NULL
             ))
           GROUP BY ph.product_id, ph.variant_name
           HAVING
             MAX(ph.price) > MIN(ph.price)
             -- Require price history spanning at least 2 different days
             -- (same-day high/low = Shopee showing different variants, not a real drop)
             AND EXTRACT(EPOCH FROM (MAX(ph.captured_at) - MIN(ph.captured_at))) / 86400 >= 1
         ) agg ON agg.product_id = p.id
         WHERE p.is_active = true AND p.price > 0
           AND agg.peak_price > agg.low_price
           AND (agg.peak_price - agg.low_price)::numeric / agg.peak_price >= 0.05
       ) ranked
       WHERE rn = 1
       ORDER BY drop_pct DESC
       LIMIT 200`
    );

    if (!rows.length) {
      return res.type('text/html').send(emptyPage());
    }

    // Group by discount band
    const hot    = rows.filter(r => discPct(r) >= 0.30);
    const good   = rows.filter(r => discPct(r) >= 0.15 && discPct(r) < 0.30);
    const mild   = rows.filter(r => discPct(r) < 0.15);

    const sections = [
      { label: '🔥 Turun 30%+', items: hot,  id: 'hot' },
      { label: '💸 Turun 15–30%', items: good, id: 'good' },
      { label: '📉 Turun 5–15%', items: mild, id: 'mild' },
    ].filter(s => s.items.length);

    const toc = sections.map(s =>
      `<a class="toc-chip" href="#${s.id}">${s.label} <span class="toc-n">${s.items.length}</span></a>`
    ).join('');

    const sectHtml = sections.map(s => `
      <section class="deal-section" id="${s.id}">
        <h2 class="section-title">${s.label}</h2>
        <div class="deal-grid">${s.items.map(dealCard).join('')}</div>
      </section>`
    ).join('');

    res.setHeader('Cache-Control', 'no-store');
    res.type('text/html').send(page(rows.length, toc, sectHtml));
  } catch (err) {
    console.error('[deals]', err.message);
    res.status(500).send('Server error');
  }
});

function discPct(r) {
  return Number(r.drop_pct);
}

function dealCard(r) {
  const pct     = Math.round(discPct(r) * 100);
  const saved   = Number(r.peak_price) - Number(r.cur_price);
  const dest    = r.has_ai_page ? `/p/${r.id}` : (r.affiliate_link || r.link || '#');
  const img     = r.image_url
    ? `<img src="${escHtml(r.image_url)}" alt="${escHtml(r.title)}" loading="lazy" onerror="this.style.display='none'">`
    : '<div class="no-img">📦</div>';
  const src     = r.source === 'shopee' ? '🛍 Shopee' : '🛒 Tokopedia';
  const aiPin   = r.has_ai_page ? '<span class="ai-pin">✦ AI Review</span>' : '';
  // Show which variant the price drop belongs to (same variant compared)
  const varNote = r.variant_name
    ? `<div class="deal-variant">Varian: ${escHtml(r.variant_name)}</div>`
    : '';

  return `
  <a class="deal-card" href="${escHtml(dest)}">
    <div class="deal-img">${img}</div>
    <div class="disc-badge">-${pct}%</div>
    <div class="deal-body">
      ${aiPin}
      <div class="deal-title">${escHtml(r.title)}</div>
      ${varNote}
      <div class="deal-prices">
        <span class="price-now">${fmt(r.cur_price)}</span>
        <span class="price-was">${fmt(r.peak_price)}</span>
      </div>
      <div class="deal-saved">Hemat ${fmt(saved)}</div>
      <div class="deal-meta">
        ${r.rating ? `<span>⭐ ${Number(r.rating).toFixed(1)}</span>` : ''}
        ${r.sold_count ? `<span>${Number(r.sold_count).toLocaleString('id-ID')}+ terjual</span>` : ''}
        <span>${src}</span>
      </div>
    </div>
  </a>`;
}

function page(total, toc, sections) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deals & Price Drop — finding.id</title>
<meta name="description" content="${total} produk dengan penurunan harga terbaru. Temukan deal terbaik di Shopee dan Tokopedia.">
<link rel="canonical" href="https://finding.id/deals">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --orange:#F97316;--orange-d:#EA580C;
  --bg:#FFF8F3;--border:#FFE4CC;
  --text:#1A1A2E;--text-sub:#4A4A6A;--text-muted:#94A3B8;
  --green:#059669;--green-bg:#ECFDF5;--green-border:#A7F3D0;
  --radius:10px;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);min-height:100vh}

/* header */
.hdr{background:rgba(255,248,243,.97);border-bottom:1px solid var(--border);
  padding:0 20px;position:sticky;top:0;z-index:100}
.hdr-in{max-width:1100px;margin:0 auto;display:flex;align-items:center;
  justify-content:space-between;height:52px}
.logo{font-size:15px;font-weight:700;color:var(--orange);text-decoration:none;letter-spacing:-.5px}
.logo span{color:var(--text)}
.back{font-size:11px;color:var(--text-sub);text-decoration:none;border:1px solid var(--border);
  border-radius:6px;padding:5px 12px;transition:.15s}
.back:hover{color:var(--orange);border-color:var(--orange)}

/* hero */
.hero{max-width:1100px;margin:0 auto;padding:36px 20px 20px;text-align:center}
.hero-tag{display:inline-block;background:linear-gradient(135deg,var(--orange),var(--orange-d));
  color:#fff;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;
  border-radius:20px;padding:4px 14px;margin-bottom:14px}
.hero h1{font-size:clamp(20px,4vw,30px);font-weight:700;line-height:1.3;margin-bottom:8px}
.hero h1 em{color:var(--orange);font-style:normal}
.hero p{font-size:12px;color:var(--text-sub);max-width:420px;margin:0 auto 20px;line-height:1.7}

/* toc */
.toc{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;
  max-width:1100px;margin:0 auto 36px;padding:0 20px}
.toc-chip{font-size:11px;font-weight:600;background:#fff;border:1px solid var(--border);
  border-radius:20px;padding:5px 14px;color:var(--text-sub);text-decoration:none;
  display:flex;align-items:center;gap:6px;transition:.15s;white-space:nowrap}
.toc-chip:hover{background:var(--orange);color:#fff;border-color:var(--orange)}
.toc-n{background:rgba(0,0,0,.08);border-radius:10px;padding:1px 6px;font-size:10px}
.toc-chip:hover .toc-n{background:rgba(255,255,255,.25)}

/* sections */
.wrap{max-width:1100px;margin:0 auto;padding:0 20px 60px}
.deal-section{margin-bottom:44px}
.section-title{font-size:15px;font-weight:700;border-left:3px solid var(--orange);
  padding-left:12px;margin-bottom:18px}

/* grid */
.deal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:14px}

/* card */
.deal-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);
  text-decoration:none;color:inherit;display:flex;flex-direction:column;
  position:relative;overflow:hidden;transition:.15s}
.deal-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(249,115,22,.15);
  border-color:var(--orange)}
.deal-img{width:100%;aspect-ratio:1;overflow:hidden;background:#F8F8F8;
  display:flex;align-items:center;justify-content:center}
.deal-img img{width:100%;height:100%;object-fit:cover;transition:.2s}
.deal-card:hover .deal-img img{transform:scale(1.04)}
.no-img{font-size:32px;opacity:.3}

/* discount badge */
.disc-badge{position:absolute;top:8px;left:8px;
  background:linear-gradient(135deg,#DC2626,#EF4444);
  color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;
  padding:3px 9px;border-radius:6px;box-shadow:0 2px 8px rgba(220,38,38,.4)}

/* body */
.deal-body{padding:11px;display:flex;flex-direction:column;gap:5px;flex:1}
.ai-pin{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
  background:linear-gradient(135deg,#7C3AED,#9333EA);color:#fff;
  border-radius:4px;padding:2px 7px;display:inline-block;align-self:flex-start}
.deal-title{font-size:11px;color:var(--text);line-height:1.45;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.deal-prices{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-top:2px}
.price-now{font-size:14px;font-weight:700;color:var(--orange)}
.price-was{font-size:11px;color:var(--text-muted);text-decoration:line-through}
.deal-saved{font-size:10px;font-weight:600;color:var(--green);
  background:var(--green-bg);border:1px solid var(--green-border);
  border-radius:4px;padding:2px 7px;display:inline-block;align-self:flex-start}
.deal-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:10px;color:var(--text-muted);margin-top:2px}

/* footer */
.ftr{border-top:1px solid var(--border);padding:14px 20px;text-align:center;
  font-size:10px;color:var(--text-muted);letter-spacing:1px}
.ftr a{color:var(--orange);text-decoration:none}

@media(max-width:600px){
  .deal-grid{grid-template-columns:repeat(2,1fr)}
  .hero{padding:24px 16px 16px}
}
</style>
</head>
<body>

<header class="hdr">
  <div class="hdr-in">
    <a class="logo" href="/"><span>finding</span>.id</a>
    <a class="back" href="/">← Cari Produk</a>
  </div>
</header>

<div class="hero">
  <div class="hero-tag">📉 Price Drop</div>
  <h1>Harga <em>Turun</em> Sekarang</h1>
  <p>${total} produk dengan penurunan harga terdeteksi. Update otomatis setiap kali scraper berjalan.</p>
</div>

<div class="toc">${toc}</div>

<div class="wrap">${sections}</div>

<footer class="ftr">
  finding.id — <a href="/">Cari Produk</a> · <a href="/ai-review">AI Review</a>
</footer>

</body>
</html>`;
}

function emptyPage() {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
  <title>Deals — finding.id</title></head><body style="font-family:monospace;padding:40px;text-align:center">
  <h2>Belum ada price drop terdeteksi.</h2><p>Data akan muncul setelah scraper berjalan beberapa kali.</p>
  <a href="/">← Kembali</a></body></html>`;
}

module.exports = router;
