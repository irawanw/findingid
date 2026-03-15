'use strict';
/**
 * Product AI Analysis Generator
 *
 * Generates a structured JSON analysis for a product using vLLM.
 * Stores result in products.ai_analysis + products.ai_analysis_at.
 * Fire-and-forget safe — all errors are caught and logged.
 */
const db   = require('./db');
const cfg  = require('../config/config');

const MODEL = process.env.VLLM_MODEL || cfg.VLLM?.MODEL || '';
const BASE  = process.env.VLLM_BASE_URL || cfg.VLLM?.BASE_URL || 'http://127.0.0.1:8001/v1';

/**
 * Generate and save AI analysis for a product.
 * @param {number} productId
 * @returns {Promise<object|null>} parsed analysis or null on failure
 */
async function generateAndSave(productId) {
  try {
    // Fetch product
    const [rows] = await db.query(
      `SELECT id, title, price, category, rating, sold_count, seller_name, seller_rating, location,
              description, specs, attributes_json, reviews_json, ai_analysis
       FROM products WHERE id = ? AND is_active = 1 LIMIT 1`,
      [productId]
    );
    if (!rows.length) return null;

    const p = rows[0];

    // Skip if already generated recently (within 7 days)
    if (p.ai_analysis) {
      try {
        const existing = JSON.parse(p.ai_analysis);
        if (existing?.generated_at) {
          const age = Date.now() - new Date(existing.generated_at).getTime();
          if (age < 7 * 24 * 60 * 60 * 1000) return existing;
        }
      } catch (_) {}
    }

    // Skip if not enough data to analyse
    // Allow generation with reviews alone (description may be null for some scraped products)
    const hasReviewsData = p.reviews_json && p.reviews_json.length > 100;
    const hasDescData    = p.description && p.description.length >= 30;
    if (!hasDescData && !hasReviewsData) return null;

    // Parse reviews
    let positiveReviews = [], negativeReviews = [];
    try {
      const rv = JSON.parse(p.reviews_json || '{}');
      positiveReviews = rv.positive || [];
      negativeReviews = rv.negative || [];
    } catch (_) {}

    const reviewText = [
      ...positiveReviews.slice(0, 3).map(r => `[${r.star}★ ${r.user}]: ${r.text}`),
      ...negativeReviews.slice(0, 2).map(r => `[${r.star}★ ${r.user}]: ${r.text}`),
    ].join('\n') || 'Tidak ada ulasan';

    // Build attributes block from attributes_json or fall back to specs string
    let attributeBlock = '';
    try {
      const attrs = JSON.parse(p.attributes_json || '[]');
      if (attrs.length) {
        attributeBlock = attrs.map(a => `- ${a.name}: ${a.value}`).join('\n');
      }
    } catch (_) {}
    if (!attributeBlock && p.specs) attributeBlock = p.specs;

    // Detect category type for context-aware prompt instructions
    const category = (p.category || '').toLowerCase();
    const needsHalal   = /makanan|minuman|food|snack|kuliner|kosmetik|kecantikan|perawatan|skincare|beauty|sabun|parfum|lip|serum|toner|lotion|cream|moistur/.test(category);
    const isFood       = /makanan|minuman|food|snack|kuliner|kopi|teh|bumbu|frozen/.test(category);
    const isSkincare   = /kosmetik|kecantikan|perawatan|skincare|beauty|sabun|parfum|lip|serum|toner|lotion|cream|moistur|sunscreen/.test(category);
    const isClothing   = /pakaian|baju|kaos|celana|dress|fashion|clothing|sepatu|sandal|tas|aksesoris|jam tangan/.test(category);
    const isElectronics = /elektronik|gadget|smartphone|laptop|komputer|ac|kulkas|tv|audio|kamera|printer|hp|tablet/.test(category);

    // Tailor analysis instructions per product type
    let analysisGuide;
    if (isFood) {
      analysisGuide = 'Paragraf 1 tentang rasa, aroma, dan tekstur berdasarkan deskripsi dan ulasan.\\n\\nParagraf 2 tentang bahan, kandungan, dan keamanan konsumsi.\\n\\nParagraf 3 tentang value for money dan perbandingan porsi/harga.\\n\\nParagraf 4 tentang kemasan, ketahanan produk, dan pengalaman membeli online.';
    } else if (isSkincare) {
      analysisGuide = 'Paragraf 1 tentang kandungan aktif dan manfaat utama berdasarkan deskripsi.\\n\\nParagraf 2 tentang tekstur, cara pemakaian, dan kesesuaian jenis kulit.\\n\\nParagraf 3 tentang efektivitas berdasarkan ulasan pembeli dan value for money.\\n\\nParagraf 4 tentang keamanan, sertifikasi, dan pertimbangan bagi pengguna baru.';
    } else if (isClothing) {
      analysisGuide = 'Paragraf 1 tentang material, kualitas bahan, dan konstruksi produk.\\n\\nParagraf 2 tentang desain, pilihan warna/ukuran, dan kesesuaian gaya.\\n\\nParagraf 3 tentang value for money, ketahanan, dan kualitas jahitan berdasarkan ulasan.\\n\\nParagraf 4 tentang panduan ukuran, perawatan, dan pertimbangan pembelian online.';
    } else if (isElectronics) {
      analysisGuide = 'Paragraf 1 tentang spesifikasi teknis utama dan performa.\\n\\nParagraf 2 tentang teknologi unggulan, fitur, dan material.\\n\\nParagraf 3 tentang value for money dibanding kompetitor sekelas.\\n\\nParagraf 4 tentang garansi, purna jual, dan pertimbangan praktis.';
    } else {
      analysisGuide = 'Paragraf 1 tentang kualitas dan fitur utama produk.\\n\\nParagraf 2 tentang material, konstruksi, atau kandungan yang relevan.\\n\\nParagraf 3 tentang value for money dan perbandingan dengan produk sejenis.\\n\\nParagraf 4 tentang pengalaman pembeli dan pertimbangan sebelum membeli.';
    }

    const techSpecsGuide = isFood
      ? 'isi dengan atribut relevan seperti Berat Bersih, Komposisi utama, Masa Kadaluarsa, Sertifikasi'
      : isSkincare
        ? 'isi dengan atribut relevan seperti Volume/Berat, Kandungan Aktif, Jenis Kulit, Sertifikasi BPOM'
        : isClothing
          ? 'isi dengan atribut relevan seperti Material, Ukuran Tersedia, Berat, Negara Asal'
          : 'isi dengan atribut teknis paling relevan (maks 6 pasang)';

    const prompt = `Kamu adalah analis produk e-commerce Indonesia. Analisis produk berikut secara mendalam dan sesuai kategorinya, lalu balas HANYA dengan satu JSON valid — tidak ada teks, komentar, atau key tambahan di luar struktur JSON di bawah.

PENTING: Nilai "analysis" harus berupa SATU string tunggal yang berisi semua paragraf digabung dengan \\n\\n (bukan key terpisah). JANGAN buat key baru seperti "paragraf_2", "design", "value", "guidance", atau nama lain — semua paragraf harus masuk ke dalam nilai key "analysis" saja.

Produk:
Nama: ${p.title}
Harga: Rp ${Number(p.price).toLocaleString('id-ID')}
Rating: ${p.rating}/5
Terjual: ${p.sold_count ? p.sold_count + '+' : 'N/A'}
Kategori: ${p.category || 'N/A'}${p.seller_name ? `\nPenjual: ${p.seller_name}${p.seller_rating ? ` (rating toko: ${p.seller_rating})` : ''}` : ''}${p.location ? `\nLokasi: ${p.location}` : ''}

${attributeBlock ? `Atribut & Spesifikasi:\n${attributeBlock}\n` : ''}
Deskripsi:
${(p.description || '').slice(0, 800)}

Ulasan Pembeli:
${reviewText}

Format JSON yang harus dikembalikan (isi semua nilai, jangan ubah nama key):
{
  "summary": "2-3 kalimat ringkasan produk yang menarik dan informatif untuk calon pembeli",
  "analysis": "${analysisGuide} Gunakan <strong> untuk kata kunci penting.",
  "pros": ["kelebihan 1", "kelebihan 2", "kelebihan 3", "kelebihan 4", "kelebihan 5", "kelebihan 6"],
  "cons": ["kekurangan 1", "kekurangan 2", "kekurangan 3"],
  "verdict": "2-3 kalimat rekomendasi akhir yang jelas, actionable, dan menyebut untuk siapa produk ini cocok",
  "scores": {
    "value": 8.5,
    "quality": 8.0,
    "variety": 7.5,
    "satisfaction": 9.0
  },
  "target_buyer": "Deskripsi spesifik siapa yang paling cocok membeli produk ini",
  "review_insight": "2-3 kalimat insight dari pola ulasan — apa yang konsisten dipuji, apa keluhan utama, dan implikasi bagi calon pembeli",
  "tech_specs": {}${needsHalal ? `,\n  "is_halal": false` : ''}
}

Untuk "tech_specs", ${techSpecsGuide}.`;

    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       MODEL,
        messages: [
          { role: 'system', content: '/no_think\nKamu adalah analis produk e-commerce Indonesia yang berpengalaman dan teknikal. Balas HANYA dengan JSON valid, tanpa teks tambahan.' },
          { role: 'user',   content: prompt.replace(/[\uD800-\uDFFF]/g, '') },
        ],
        max_tokens:  3000,
        temperature: 0.5,
        stream:      false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) throw new Error(`vLLM HTTP ${res.status}`);
    const data = await res.json();
    let text = (data.choices?.[0]?.message?.content || '').trim();

    // Strip think blocks if any leaked through
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Extract JSON from response (model sometimes wraps in ```json)
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ||
                      text.match(/```\s*([\s\S]*?)```/) ||
                      text.match(/(\{[\s\S]*\})/);
    if (jsonMatch) text = jsonMatch[1].trim();

    const analysis = JSON.parse(text);
    analysis.generated_at = new Date().toISOString();

    // Save to DB
    await db.query(
      `UPDATE products SET ai_analysis = ?, ai_analysis_at = NOW() WHERE id = ?`,
      [JSON.stringify(analysis), productId]
    );

    console.log(`[analysis] generated for product ${productId} (${p.title.slice(0, 50)})`);
    return analysis;

  } catch (err) {
    console.error(`[analysis] failed for product ${productId}:`, err.message);
    return null;
  }
}

module.exports = { generateAndSave };
