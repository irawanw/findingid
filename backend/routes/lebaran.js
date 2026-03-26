'use strict';
/**
 * Lebaran / Idul Fitri 2025 SEO hub pages
 *
 *   GET /lebaran               → Hub: persiapan belanja lebaran + kategori + produk unggulan
 *   GET /tips-mudik-lebaran    → Tips & trik mudik + persiapan lebaran (content SEO)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

function fmtPrice(p) {
  const n = parseFloat(p);
  if (!n) return '-';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stars(r) {
  const n = parseFloat(r) || 0;
  const full = Math.floor(n);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// ── Shared CSS ─────────────────────────────────────────────────────────────
const SHARED_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono',monospace,sans-serif;background:#FFF8F3;color:#1a1a1a;line-height:1.6}
a{color:inherit;text-decoration:none}
.lb-header{background:#fff;border-bottom:2px solid #F97316;padding:12px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100}
.lb-logo{font-weight:700;color:#F97316;font-size:18px}
.lb-back{color:#888;font-size:12px}
.lb-back:hover{color:#F97316}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
.lb-hero{background:linear-gradient(135deg,#F97316 0%,#EA580C 50%,#C2410C 100%);color:#fff;padding:48px 20px 40px;text-align:center}
.lb-hero-emoji{font-size:52px;margin-bottom:12px;display:block}
.lb-hero h1{font-size:clamp(22px,5vw,36px);font-weight:700;margin-bottom:10px;line-height:1.2}
.lb-hero p{font-size:14px;opacity:.9;max-width:600px;margin:0 auto 20px;line-height:1.7}
.lb-hero-badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.lb-badge{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600}
.lb-section{padding:32px 0 0}
.lb-section-title{font-size:13px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-bottom:16px}
.lb-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:32px}
.lb-cat-card{background:#fff;border:1.5px solid #FFD4A8;border-radius:14px;padding:16px 12px;text-align:center;transition:transform .15s,box-shadow .15s;cursor:pointer}
.lb-cat-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(249,115,22,.18);border-color:#F97316}
.lb-cat-card .icon{font-size:28px;margin-bottom:6px;display:block}
.lb-cat-card .name{font-size:11px;font-weight:700;color:#333;line-height:1.3}
.lb-cat-card .hint{font-size:10px;color:#999;margin-top:2px}
.lb-products{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:32px}
.lb-prod-card{background:#fff;border:1px solid #ffe4cc;border-radius:12px;overflow:hidden;transition:transform .15s,box-shadow .15s}
.lb-prod-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(249,115,22,.15)}
.lb-prod-img{aspect-ratio:1;overflow:hidden;background:#f5f5f5;display:flex;align-items:center;justify-content:center;font-size:28px}
.lb-prod-img img{width:100%;height:100%;object-fit:cover}
.lb-prod-body{padding:9px;display:flex;flex-direction:column;gap:3px}
.lb-prod-title{font-size:10px;line-height:1.4;color:#333;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.lb-prod-price{font-size:12px;font-weight:700;color:#F97316}
.lb-prod-meta{font-size:9px;color:#aaa}
.lb-stars{color:#f59e0b;font-size:9px}
.lb-cta-box{background:#fff;border:2px solid #F97316;border-radius:16px;padding:24px;text-align:center;margin:0 0 32px}
.lb-cta-box h2{font-size:17px;color:#1a1a1a;margin-bottom:8px}
.lb-cta-box p{font-size:13px;color:#666;margin-bottom:16px}
.lb-btn{display:inline-block;background:linear-gradient(135deg,#F97316,#EA580C);color:#fff;padding:12px 28px;border-radius:12px;font-size:14px;font-weight:700;font-family:inherit}
.lb-btn:hover{background:linear-gradient(135deg,#EA580C,#C2410C)}
.lb-tips{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:32px}
.lb-tip-card{background:#fff;border:1px solid #ffe4cc;border-radius:14px;padding:20px}
.lb-tip-card .tip-num{font-size:24px;font-weight:700;color:#F97316;margin-bottom:6px}
.lb-tip-card h3{font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:6px}
.lb-tip-card p{font-size:12px;color:#666;line-height:1.6}
.lb-faq{margin-bottom:32px}
.lb-faq-item{background:#fff;border:1px solid #ffe4cc;border-radius:12px;padding:16px 20px;margin-bottom:8px}
.lb-faq-item h3{font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:6px}
.lb-faq-item p{font-size:12px;color:#666;line-height:1.6}
.lb-internal{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
.lb-link-chip{background:#FFF3EB;border:1px solid #FFD4A8;border-radius:20px;padding:5px 14px;font-size:11px;font-weight:600;color:#C2410C}
.lb-link-chip:hover{background:#F97316;color:#fff;border-color:#F97316}
footer.lb-footer{background:#fff;border-top:1px solid #ffe4cc;padding:20px;text-align:center;font-size:11px;color:#aaa;margin-top:20px}
@media(max-width:480px){.lb-cats{grid-template-columns:repeat(3,1fr)}.lb-products{grid-template-columns:repeat(2,1fr)}}
`;

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">`;

// ── /lebaran — Hub page ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  // Fetch top products for key Lebaran categories
  let products = [];
  try {
    const [rows] = await db.query(`
      SELECT id, title, price, rating, sold_count, link, affiliate_link, image_url
      FROM products
      WHERE is_active = true
        AND (
          title LIKE '%baju koko%' OR title LIKE '%mukena%' OR
          title LIKE '%nastar%'    OR title LIKE '%kue lebaran%' OR
          title LIKE '%hampers lebaran%' OR title LIKE '%sarung pria%' OR
          title LIKE '%baju lebaran%' OR title LIKE '%parcel lebaran%'
        )
      ORDER BY (rating * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
      LIMIT 12
    `);
    products = rows;
  } catch (_) {}

  const cardHtml = products.map((p, i) => `
    <a class="lb-prod-card" href="${esc(p.affiliate_link || p.link || `/go/${p.id}`)}" target="_blank" rel="noopener sponsored">
      <div class="lb-prod-img">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="${i < 4 ? 'eager' : 'lazy'}" width="150" height="150">` : '🎁'}
      </div>
      <div class="lb-prod-body">
        <div class="lb-prod-title">${esc(p.title)}</div>
        <div class="lb-prod-price">${fmtPrice(p.price)}</div>
        <div class="lb-prod-meta">
          <span class="lb-stars">${stars(p.rating)}</span>
          ${p.sold_count ? `${Number(p.sold_count).toLocaleString('id-ID')} terjual` : ''}
        </div>
      </div>
    </a>`).join('');

  const schemaItems = products.slice(0, 5).map((p, i) => `{
      "@type": "ListItem",
      "position": ${i + 1},
      "name": "${esc(p.title)}",
      "url": "https://finding.id/go/${p.id}"
    }`).join(',\n    ');

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Persiapan Lebaran 2025 — Belanja Hemat Idul Fitri | finding.id</title>
<meta name="description" content="Panduan lengkap belanja lebaran 2025: baju koko, mukena, kue lebaran, hampers, dan hadiah Idul Fitri terbaik. Rekomendasi AI dari data nyata Shopee.">
<meta name="keywords" content="lebaran 2025, belanja lebaran, baju koko lebaran, kue lebaran, hampers lebaran, idul fitri 2025, persiapan lebaran, belanja ied fitri">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://finding.id/lebaran">
<meta property="og:type" content="website">
<meta property="og:url" content="https://finding.id/lebaran">
<meta property="og:title" content="Persiapan Belanja Lebaran 2025 — finding.id">
<meta property="og:description" content="Rekomendasi produk lebaran terlaris: baju koko, mukena, kue lebaran, hampers Idul Fitri. Data nyata Shopee, dianalisis AI.">
<meta property="og:image" content="https://finding.id/og-image.png">
<meta name="theme-color" content="#F97316">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Persiapan Belanja Lebaran 2025 — finding.id",
  "description": "Panduan lengkap belanja lebaran 2025: baju koko, mukena, kue lebaran, hampers Idul Fitri terlaris.",
  "url": "https://finding.id/lebaran",
  "publisher": { "@type": "Organization", "name": "finding.id", "url": "https://finding.id" },
  "breadcrumb": {
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "finding.id", "item": "https://finding.id" },
      { "@type": "ListItem", "position": 2, "name": "Lebaran 2025", "item": "https://finding.id/lebaran" }
    ]
  }
}
</script>
${products.length ? `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Produk Lebaran Terlaris 2025",
  "numberOfItems": ${products.length},
  "itemListElement": [${schemaItems}]
}
</script>` : ''}
<style>${SHARED_CSS}</style>
${FONT_LINK}
</head>
<body>

<header class="lb-header">
  <a href="/" class="lb-logo">finding.id</a>
  <a href="/" class="lb-back">← Cari produk lain</a>
</header>

<div class="lb-hero">
  <span class="lb-hero-emoji">🌙</span>
  <h1>Persiapan Belanja Lebaran 2025</h1>
  <p>Rekomendasi produk Idul Fitri terlaris dan terbaik — baju koko, mukena, kue lebaran, hampers, dan lebih banyak lagi. Data real dari Shopee, dianalisis AI finding.id.</p>
  <div class="lb-hero-badges">
    <span class="lb-badge">🤖 Rekomendasi AI</span>
    <span class="lb-badge">📊 Data Real Shopee</span>
    <span class="lb-badge">✅ Idul Fitri 2025</span>
    <span class="lb-badge">🚚 Siap Kirim</span>
  </div>
</div>

<div class="wrap">

  <div class="lb-section">
    <div class="lb-section-title">🛍️ Kategori Belanja Lebaran</div>
    <div class="lb-cats">
      <a href="/cari/baju-koko" class="lb-cat-card"><span class="icon">👕</span><div class="name">Baju Koko</div><div class="hint">Pria dewasa</div></a>
      <a href="/cari/mukena-lebaran" class="lb-cat-card"><span class="icon">🧕</span><div class="name">Mukena</div><div class="hint">Sholat Ied</div></a>
      <a href="/cari/baju-lebaran-anak" class="lb-cat-card"><span class="icon">👶</span><div class="name">Baju Anak</div><div class="hint">Putra putri</div></a>
      <a href="/cari/baju-couple-lebaran" class="lb-cat-card"><span class="icon">👫</span><div class="name">Couple</div><div class="hint">Keluarga</div></a>
      <a href="/cari/kue-lebaran" class="lb-cat-card"><span class="icon">🍪</span><div class="name">Kue Lebaran</div><div class="hint">Nastar, kastengel</div></a>
      <a href="/cari/hampers-lebaran" class="lb-cat-card"><span class="icon">🎁</span><div class="name">Hampers</div><div class="hint">Hadiah Ied</div></a>
      <a href="/cari/sarung-lebaran" class="lb-cat-card"><span class="icon">🧣</span><div class="name">Sarung</div><div class="hint">Pria dewasa</div></a>
      <a href="/cari/peci-kopiah" class="lb-cat-card"><span class="icon">🧢</span><div class="name">Peci & Kopiah</div><div class="hint">Sholat Ied</div></a>
      <a href="/cari/amplop-lebaran" class="lb-cat-card"><span class="icon">✉️</span><div class="name">Amplop THR</div><div class="hint">Untuk anak</div></a>
      <a href="/cari/parcel-lebaran" class="lb-cat-card"><span class="icon">📦</span><div class="name">Parcel</div><div class="hint">Siap kirim</div></a>
      <a href="/cari/sepatu-lebaran" class="lb-cat-card"><span class="icon">👟</span><div class="name">Sepatu Baru</div><div class="hint">Pria & wanita</div></a>
      <a href="/cari/parfum-lebaran" class="lb-cat-card"><span class="icon">🌸</span><div class="name">Parfum</div><div class="hint">Wangi seharian</div></a>
    </div>
  </div>

  ${products.length ? `
  <div class="lb-section">
    <div class="lb-section-title">⭐ Produk Lebaran Terlaris</div>
    <div class="lb-products">${cardHtml}</div>
  </div>` : ''}

  <div class="lb-cta-box">
    <h2>🤖 Bingung mau beli apa untuk lebaran?</h2>
    <p>Ceritakan budgetmu dan untuk siapa — AI finding.id akan carikan produk yang paling pas dan terlaris.</p>
    <a href="/?q=rekomendasi+baju+lebaran+2025" class="lb-btn">Tanya AI Sekarang →</a>
  </div>

  <div class="lb-section">
    <div class="lb-section-title">💡 Tips Belanja Lebaran Hemat</div>
    <div class="lb-tips">
      <div class="lb-tip-card">
        <div class="tip-num">01</div>
        <h3>Belanja H-14 agar aman</h3>
        <p>Pesan baju koko, mukena, dan hampers minimal 2 minggu sebelum lebaran untuk menghindari kehabisan stok dan keterlambatan pengiriman.</p>
      </div>
      <div class="lb-tip-card">
        <div class="tip-num">02</div>
        <h3>Bandingkan harga via AI</h3>
        <p>Gunakan finding.id untuk membandingkan harga dari ribuan penjual Shopee sekaligus. AI kami menganalisis rating dan penjualan nyata — bukan iklan.</p>
      </div>
      <div class="lb-tip-card">
        <div class="tip-num">03</div>
        <h3>Cek ukuran sebelum beli</h3>
        <p>Baju koko dan baju lebaran anak sering habis di ukuran M dan L. Pesan lebih awal dan pastikan cek tabel ukuran dari penjual.</p>
      </div>
      <div class="lb-tip-card">
        <div class="tip-num">04</div>
        <h3>Hampers bisa dipesan custom</h3>
        <p>Banyak penjual di Shopee menerima pesanan hampers custom. Cari dengan kata kunci "hampers lebaran custom" untuk pilihan yang lebih personal.</p>
      </div>
      <div class="lb-tip-card">
        <div class="tip-num">05</div>
        <h3>Kue lebaran pesan toples</h3>
        <p>Nastar dan kastengel dalam toples lebih tahan lama dan lebih higienis. Pilih yang berrating tinggi dengan banyak ulasan pembeli.</p>
      </div>
      <div class="lb-tip-card">
        <div class="tip-num">06</div>
        <h3>Mudik? Beli oleh-oleh online</h3>
        <p>Daripada bawa bawaan berat, pesan oleh-oleh dan kue lebaran online dan kirim langsung ke kampung halaman — lebih praktis dan hemat tenaga.</p>
      </div>
    </div>
  </div>

  <div class="lb-section">
    <div class="lb-section-title">❓ FAQ Belanja Lebaran</div>
    <div class="lb-faq">
      <div class="lb-faq-item">
        <h3>Kapan waktu terbaik belanja lebaran online?</h3>
        <p>Idealnya H-14 sampai H-7 sebelum lebaran. Terlalu mepet risiko kehabisan stok atau pengiriman tidak tepat waktu, terutama menjelang libur Idul Fitri.</p>
      </div>
      <div class="lb-faq-item">
        <h3>Berapa budget wajar untuk baju koko lebaran?</h3>
        <p>Baju koko berkualitas di Shopee berkisar antara Rp 100.000–Rp 350.000. Untuk yang premium dengan bahan katun premium atau tenun bisa lebih dari Rp 500.000.</p>
      </div>
      <div class="lb-faq-item">
        <h3>Hampers lebaran apa yang paling laris?</h3>
        <p>Hampers berisi kue kering, sirup, dan makanan ringan paling laris karena cocok untuk semua kalangan. Hampers premium dengan kurma dan cokelat impor juga populer untuk relasi bisnis.</p>
      </div>
      <div class="lb-faq-item">
        <h3>Bagaimana cara cari produk lebaran terbaik?</h3>
        <p>Ketik kebutuhan kamu di finding.id — misalnya "baju koko untuk ayah budget 200 ribu" — dan AI kami akan analisis ribuan produk Shopee untuk memberikan rekomendasi terbaik.</p>
      </div>
    </div>
  </div>

  <div class="lb-section">
    <div class="lb-section-title">🔗 Artikel Terkait</div>
    <div class="lb-internal">
      <a href="/tips-mudik-lebaran" class="lb-link-chip">🚗 Tips Mudik Lebaran 2025</a>
      <a href="/cari/baju-koko" class="lb-link-chip">👕 Baju Koko Terbaik</a>
      <a href="/cari/kue-lebaran" class="lb-link-chip">🍪 Kue Lebaran</a>
      <a href="/cari/hampers-lebaran" class="lb-link-chip">🎁 Hampers Lebaran</a>
      <a href="/cari/mukena-lebaran" class="lb-link-chip">🧕 Mukena Cantik</a>
      <a href="/cari/nastar-lebaran" class="lb-link-chip">🍩 Nastar Terenak</a>
      <a href="/cari/sepatu-lebaran" class="lb-link-chip">👟 Sepatu Lebaran</a>
      <a href="/cari/parfum-lebaran" class="lb-link-chip">🌸 Parfum Lebaran</a>
    </div>
  </div>

</div>

<footer class="lb-footer">
  <p>© 2025 <a href="/" style="color:#F97316;font-weight:700">finding.id</a> — Asisten Belanja AI Indonesia</p>
  <p style="margin-top:4px">Data produk dari Shopee · Dianalisis oleh AI · Update harian</p>
</footer>

</body>
</html>`;

  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
  res.type('html').send(html);
});

// ── /tips-mudik-lebaran ────────────────────────────────────────────────────
router.get('/tips-mudik', async (req, res) => {
  // Fetch travel/mudik related products
  let products = [];
  try {
    const [rows] = await db.query(`
      SELECT id, title, price, rating, sold_count, link, affiliate_link, image_url
      FROM products
      WHERE is_active = true
        AND (
          title LIKE '%bantal leher%'  OR title LIKE '%bantal travel%' OR
          title LIKE '%power bank%'    OR title LIKE '%powerbank%'     OR
          title LIKE '%koper%'         OR title LIKE '%tas travel%'    OR
          title LIKE '%obat mabuk%'    OR title LIKE '%travel pillow%'
        )
      ORDER BY (rating * 0.5 + LN(1 + COALESCE(sold_count,0)) * 0.5) DESC
      LIMIT 8
    `);
    products = rows;
  } catch (_) {}

  const cardHtml = products.map((p, i) => `
    <a class="lb-prod-card" href="${esc(p.affiliate_link || p.link || `/go/${p.id}`)}" target="_blank" rel="noopener sponsored">
      <div class="lb-prod-img">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="${i < 4 ? 'eager' : 'lazy'}" width="150" height="150">` : '🧳'}
      </div>
      <div class="lb-prod-body">
        <div class="lb-prod-title">${esc(p.title)}</div>
        <div class="lb-prod-price">${fmtPrice(p.price)}</div>
        <div class="lb-prod-meta"><span class="lb-stars">${stars(p.rating)}</span> ${p.sold_count ? Number(p.sold_count).toLocaleString('id-ID') + ' terjual' : ''}</div>
      </div>
    </a>`).join('');

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tips Mudik Lebaran 2025 — Panduan Lengkap Perjalanan Aman & Nyaman | finding.id</title>
<meta name="description" content="Tips mudik lebaran 2025 lengkap: persiapan kendaraan, perlengkapan mudik, jadwal berangkat terbaik, tips agar tidak macet, dan rekomendasi produk mudik terlaris.">
<meta name="keywords" content="tips mudik lebaran 2025, mudik lebaran aman, persiapan mudik, tips mudik lebaran, perlengkapan mudik, mudik idul fitri 2025, jadwal mudik lebaran">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://finding.id/tips-mudik-lebaran">
<meta property="og:type" content="article">
<meta property="og:url" content="https://finding.id/tips-mudik-lebaran">
<meta property="og:title" content="Tips Mudik Lebaran 2025 — Panduan Lengkap | finding.id">
<meta property="og:description" content="Panduan lengkap mudik lebaran 2025: persiapan, perlengkapan, dan tips agar perjalanan aman dan nyaman.">
<meta property="og:image" content="https://finding.id/og-image.png">
<meta name="theme-color" content="#F97316">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Tips Mudik Lebaran 2025",
  "description": "Panduan lengkap mudik lebaran 2025 agar perjalanan aman, nyaman, dan bebas macet.",
  "url": "https://finding.id/tips-mudik-lebaran",
  "step": [
    {"@type":"HowToStep","position":1,"name":"Cek kondisi kendaraan","text":"Servis kendaraan minimal H-7 sebelum mudik: oli, ban, rem, dan aki."},
    {"@type":"HowToStep","position":2,"name":"Pilih waktu berangkat","text":"Berangkat dini hari atau malam hari untuk hindari puncak kemacetan."},
    {"@type":"HowToStep","position":3,"name":"Siapkan perlengkapan perjalanan","text":"Bawa bantal leher, obat mabuk, powerbank, dan snack untuk perjalanan jauh."},
    {"@type":"HowToStep","position":4,"name":"Patuhi aturan contraflow","text":"Cek informasi contraflow tol dari Korlantas Polri dan siapkan rute alternatif."},
    {"@type":"HowToStep","position":5,"name":"Istirahat setiap 2 jam","text":"Jangan memaksakan diri. Rest area di tol biasanya ramai, istirahat di luar tol bisa jadi pilihan."}
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Kapan waktu terbaik mudik lebaran 2025 agar tidak macet?",
      "acceptedAnswer": {"@type": "Answer", "text": "Berangkat H-5 atau H-6 sebelum lebaran (sekitar 2-3 hari sebelum puncak arus mudik) adalah pilihan terbaik. Atau berangkat dini hari antara pukul 00.00-04.00 untuk hindari kemacetan puncak."}
    },
    {
      "@type": "Question",
      "name": "Apa saja yang wajib dibawa saat mudik lebaran?",
      "acceptedAnswer": {"@type": "Answer", "text": "Wajib bawa: dokumen kendaraan (STNK, SIM), obat-obatan pribadi, obat mabuk perjalanan, powerbank, bantal leher, snack dan air minum, uang tunai cukup, dan charger kendaraan."}
    },
    {
      "@type": "Question",
      "name": "Bagaimana cara menghindari macet saat mudik lebaran?",
      "acceptedAnswer": {"@type": "Answer", "text": "Pantau info contraflow dari Korlantas, berangkat di luar jam puncak (hindari pukul 06.00-10.00), gunakan aplikasi navigasi real-time, dan siapkan rute alternatif non-tol."}
    }
  ]
}
</script>
<style>${SHARED_CSS}
.article-body{background:#fff;border:1px solid #ffe4cc;border-radius:16px;padding:28px;margin-bottom:24px}
.article-body h2{font-size:16px;font-weight:700;color:#1a1a1a;margin:20px 0 10px;padding-top:4px;border-top:1px solid #f0e0d0}
.article-body h2:first-child{margin-top:0;border-top:none;padding-top:0}
.article-body p{font-size:12px;color:#555;line-height:1.8;margin-bottom:10px}
.article-body ul{padding-left:18px;margin-bottom:10px}
.article-body ul li{font-size:12px;color:#555;line-height:1.8;margin-bottom:4px}
.article-body strong{color:#1a1a1a}
.article-body .highlight{background:#FFF3EB;border-left:3px solid #F97316;padding:10px 14px;border-radius:0 8px 8px 0;margin:12px 0;font-size:12px;color:#7C2D12}
.checklist{list-style:none;padding:0}
.checklist li::before{content:"✅ ";font-size:11px}
</style>
${FONT_LINK}
</head>
<body>

<header class="lb-header">
  <a href="/" class="lb-logo">finding.id</a>
  <a href="/lebaran" class="lb-back">← Lebaran 2025</a>
</header>

<div class="lb-hero" style="background:linear-gradient(135deg,#1e40af,#1d4ed8,#2563eb)">
  <span class="lb-hero-emoji">🚗</span>
  <h1>Tips Mudik Lebaran 2025</h1>
  <p>Panduan lengkap agar perjalanan mudik Idul Fitri 2025 aman, nyaman, dan bebas stres — dari persiapan hingga tiba di kampung halaman.</p>
  <div class="lb-hero-badges">
    <span class="lb-badge">🗓️ Idul Fitri 2025</span>
    <span class="lb-badge">🛣️ Tips Tol & Macet</span>
    <span class="lb-badge">🧳 Perlengkapan Mudik</span>
  </div>
</div>

<div class="wrap">

  <div style="margin-top:28px" class="article-body">

    <h2>📅 Kapan Waktu Terbaik Mudik 2025?</h2>
    <p>Idul Fitri 2025 diperkirakan jatuh pada <strong>30-31 Maret 2025</strong>. Puncak arus mudik biasanya terjadi <strong>H-3 dan H-2</strong>, yaitu 27-28 Maret. Untuk menghindari kemacetan paling parah:</p>
    <ul>
      <li><strong>Ideal: berangkat H-5 atau H-6</strong> (24-25 Maret) — jalanan masih relatif lengang</li>
      <li><strong>Alternatif: dini hari pukul 00.00–04.00</strong> — volume kendaraan paling rendah</li>
      <li><strong>Hindari: Jumat sore H-3</strong> — ini puncak kemacetan terberat</li>
    </ul>
    <div class="highlight">💡 <strong>Pro tip:</strong> Kombinasi berangkat H-5 pagi hari adalah pilihan terbaik — tidak terlalu kepagian namun menghindari puncak arus mudik.</div>

    <h2>🔧 Persiapan Kendaraan Sebelum Mudik</h2>
    <p>Cek kondisi kendaraan minimal <strong>H-7 sebelum berangkat</strong> agar sempat diperbaiki jika ada masalah:</p>
    <ul class="checklist">
      <li>Ganti oli mesin dan filter</li>
      <li>Cek tekanan dan kondisi ban (termasuk ban cadangan)</li>
      <li>Cek kondisi rem dan kampas</li>
      <li>Cek aki — pastikan daya cukup untuk perjalanan jauh</li>
      <li>Cek level air radiator dan minyak rem</li>
      <li>Pastikan lampu depan, belakang, dan sein berfungsi normal</li>
      <li>Pastikan wiper berfungsi baik (antisipasi hujan)</li>
    </ul>

    <h2>🧳 Perlengkapan Mudik yang Wajib Dibawa</h2>
    <p>Jangan sampai ada yang tertinggal. Siapkan daftar ini sehari sebelum berangkat:</p>
    <ul class="checklist">
      <li>Dokumen: SIM, STNK, KTP</li>
      <li>Obat-obatan: obat mabuk, paracetamol, antasida, plester</li>
      <li>Powerbank berkapasitas besar (min. 10.000 mAh)</li>
      <li>Bantal leher untuk penumpang</li>
      <li>Snack dan air minum cukup untuk perjalanan</li>
      <li>Charger dan kabel USB cadangan</li>
      <li>Uang tunai (ada daerah yang belum bisa QRIS)</li>
      <li>Masker dan hand sanitizer</li>
      <li>Tas mudik yang ringan dan mudah dibawa</li>
    </ul>

    <h2>🛣️ Tips Hindari Macet di Jalan Tol</h2>
    <p>Kemacetan mudik lebaran di tol trans-Jawa bisa mencapai puluhan kilometer. Berikut cara mengatasinya:</p>
    <ul>
      <li><strong>Pantau info contraflow</strong> dari akun resmi Korlantas Polri (@ntmc_polri) dan JASA MARGA</li>
      <li><strong>Gunakan Waze atau Google Maps real-time</strong> untuk memantau kepadatan</li>
      <li><strong>Siapkan rute alternatif</strong> melalui jalur pantura atau jalur selatan sebagai cadangan</li>
      <li><strong>Isi e-toll sebelum berangkat</strong> — jangan mengisi di gerbang tol saat arus padat</li>
      <li><strong>Berhenti di rest area awal</strong> — rest area KM 57 ke atas biasanya lebih padat dari yang lebih awal</li>
    </ul>
    <div class="highlight">⚠️ <strong>Penting:</strong> Jangan memaksakan berkendara lebih dari 4 jam tanpa istirahat. Microsleep menjadi penyebab utama kecelakaan saat mudik.</div>

    <h2>🏥 Tips Kesehatan Selama Perjalanan</h2>
    <ul>
      <li>Istirahat minimal <strong>15-20 menit setiap 2 jam</strong> berkendara</li>
      <li>Minum air cukup — dehidrasi memperburuk kantuk</li>
      <li>Hindari makan berlebihan di rest area — dapat menyebabkan kantuk</li>
      <li>Jika mengantuk <strong>jangan dipaksakan</strong> — tidur sejenak 20 menit sangat membantu</li>
      <li>Bawa obat mabuk untuk penumpang yang rentan mabuk perjalanan</li>
    </ul>

    <h2>📦 Oleh-oleh & Bawaan Mudik</h2>
    <p>Daripada membawa bawaan berlebihan yang menyulitkan perjalanan, <strong>pesan oleh-oleh dan kue lebaran secara online</strong> dan kirim langsung ke kampung halaman. Lebih praktis, lebih hemat tenaga, dan biasanya harga lebih murah dari toko fisik.</p>
    <div class="highlight">💡 Gunakan finding.id untuk mencari "nastar toples", "hampers lebaran", atau "kue kering lebaran" dan bandingkan ratusan pilihan dari Shopee sekaligus.</div>

  </div>

  ${products.length ? `
  <div class="lb-section">
    <div class="lb-section-title">🧳 Produk Mudik Terlaris di Shopee</div>
    <div class="lb-products">${cardHtml}</div>
  </div>` : ''}

  <div class="lb-cta-box">
    <h2>🤖 Cari perlengkapan mudik yang tepat?</h2>
    <p>Tanya AI finding.id — "powerbank untuk mudik budget 200 ribu" atau "bantal leher terbaik" — dan dapatkan rekomendasi dari data nyata Shopee.</p>
    <a href="/?q=perlengkapan+mudik+lebaran" class="lb-btn">Tanya AI finding.id →</a>
  </div>

  <div class="lb-section">
    <div class="lb-section-title">🔗 Artikel Terkait</div>
    <div class="lb-internal">
      <a href="/lebaran" class="lb-link-chip">🌙 Persiapan Lebaran 2025</a>
      <a href="/cari/baju-koko" class="lb-link-chip">👕 Baju Koko Lebaran</a>
      <a href="/cari/hampers-lebaran" class="lb-link-chip">🎁 Hampers Lebaran</a>
      <a href="/cari/kue-lebaran" class="lb-link-chip">🍪 Kue Lebaran</a>
      <a href="/cari/baju-lebaran-anak" class="lb-link-chip">👶 Baju Lebaran Anak</a>
    </div>
  </div>

</div>

<footer class="lb-footer">
  <p>© 2025 <a href="/" style="color:#F97316;font-weight:700">finding.id</a> — Asisten Belanja AI Indonesia</p>
</footer>

</body>
</html>`;

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.type('html').send(html);
});

module.exports = router;
