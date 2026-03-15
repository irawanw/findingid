'use strict';
/**
 * Force-generate AI analysis for a single product, bypassing description length check.
 * Usage: node tools/force_analyze_product.js <product_id>
 */
require(__dirname + '/../backend/node_modules/dotenv').config({ path: __dirname + '/../backend/.env' });
const db  = require(__dirname + '/../backend/services/db');
const cfg = require(__dirname + '/../backend/config/config');

const productId = parseInt(process.argv[2]);
if (!productId) { console.error('Usage: node force_analyze_product.js <product_id>'); process.exit(1); }

const MODEL = process.env.VLLM_MODEL || cfg.VLLM?.MODEL || '';
const BASE  = process.env.VLLM_BASE_URL || cfg.VLLM?.BASE_URL || 'http://127.0.0.1:8001/v1';

async function main() {
  const [rows] = await db.query(
    `SELECT id, title, price, category, rating, sold_count, seller_name, seller_rating, location,
            description, specs, attributes_json, reviews_json
     FROM products WHERE id = ? AND is_active = 1 LIMIT 1`,
    [productId]
  );
  if (!rows.length) { console.error('Product not found:', productId); process.exit(1); }
  const p = rows[0];
  console.log(`[force-analyze] Product ${productId}: ${p.title}`);

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

  // Build attributes block — prefer attributes_json, fall back to specs
  let attributeBlock = '';
  try {
    const attrs = JSON.parse(p.attributes_json || '[]');
    if (attrs.length) attributeBlock = attrs.map(a => `- ${a.name}: ${a.value}`).join('\n');
  } catch (_) {}
  if (!attributeBlock && p.specs) attributeBlock = p.specs;

  // Description: if corrupted ([object Object]) use empty string
  const descText = (!p.description || p.description === '[object Object]') ? '' : p.description.slice(0, 800);

  const category = (p.category || '').toLowerCase();
  const isClothing = /pakaian|baju|kaos|celana|dress|fashion|clothing|sepatu|sandal|tas|aksesoris|jam tangan/.test(category);

  const analysisGuide = isClothing
    ? 'Paragraf 1 tentang material, kualitas bahan, dan konstruksi produk.\\n\\nParagraf 2 tentang desain, pilihan warna/ukuran, dan kesesuaian gaya.\\n\\nParagraf 3 tentang value for money, ketahanan, dan kualitas jahitan berdasarkan ulasan.\\n\\nParagraf 4 tentang panduan ukuran, perawatan, dan pertimbangan pembelian online.'
    : 'Paragraf 1 tentang kualitas dan fitur utama produk.\\n\\nParagraf 2 tentang material, konstruksi, atau kandungan yang relevan.\\n\\nParagraf 3 tentang value for money dan perbandingan dengan produk sejenis.\\n\\nParagraf 4 tentang pengalaman pembeli dan pertimbangan sebelum membeli.';

  const prompt = `Kamu adalah analis produk e-commerce Indonesia. Analisis produk berikut secara mendalam dan sesuai kategorinya, lalu balas HANYA dengan satu JSON valid — tidak ada teks, komentar, atau key tambahan di luar struktur JSON di bawah.

PENTING: Nilai "analysis" harus berupa SATU string tunggal yang berisi semua paragraf digabung dengan \\n\\n (bukan key terpisah).

Produk:
Nama: ${p.title}
Harga: Rp ${Number(p.price).toLocaleString('id-ID')}
Rating: ${p.rating}/5
Terjual: ${p.sold_count ? p.sold_count + '+' : 'N/A'}
Kategori: ${p.category || 'N/A'}${p.seller_name ? `\nPenjual: ${p.seller_name}${p.seller_rating ? ` (rating toko: ${p.seller_rating})` : ''}` : ''}${p.location ? `\nLokasi: ${p.location}` : ''}

${attributeBlock ? `Atribut & Spesifikasi:\n${attributeBlock}\n` : ''}${descText ? `Deskripsi:\n${descText}\n\n` : ''}Ulasan Pembeli:
${reviewText}

Format JSON yang harus dikembalikan (isi semua nilai, jangan ubah nama key):
{
  "summary": "2-3 kalimat ringkasan produk yang menarik dan informatif untuk calon pembeli",
  "analysis": "${analysisGuide} Gunakan <strong> untuk kata kunci penting.",
  "pros": ["kelebihan 1", "kelebihan 2", "kelebihan 3", "kelebihan 4", "kelebihan 5", "kelebihan 6"],
  "cons": ["kekurangan 1", "kekurangan 2", "kekurangan 3"],
  "verdict": "2-3 kalimat rekomendasi akhir yang jelas, actionable, dan menyebut untuk siapa produk ini cocok",
  "scores": { "value": 8.5, "quality": 8.0, "variety": 7.5, "satisfaction": 9.0 },
  "target_buyer": "Deskripsi spesifik siapa yang paling cocok membeli produk ini",
  "review_insight": "2-3 kalimat insight dari pola ulasan — apa yang konsisten dipuji, apa keluhan utama, dan implikasi bagi calon pembeli",
  "tech_specs": {}
}

Untuk "tech_specs", isi dengan atribut relevan seperti Material, Ukuran Tersedia, Berat, Negara Asal.`;

  console.log('[force-analyze] Calling LLM…');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '/no_think\nKamu adalah analis produk e-commerce Indonesia yang berpengalaman dan teknikal. Balas HANYA dengan JSON valid, tanpa teks tambahan.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 2500, temperature: 0.5, stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`vLLM HTTP ${res.status}`);
  const data = await res.json();
  let text = (data.choices?.[0]?.message?.content || '').trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (jsonMatch) text = jsonMatch[1].trim();

  const result = JSON.parse(text);
  result.generated_at = new Date().toISOString();

  await db.query(
    `UPDATE products SET ai_analysis = ?, ai_analysis_at = NOW() WHERE id = ?`,
    [JSON.stringify(result), productId]
  );
  console.log('[force-analyze] ✓ Saved analysis for product', productId);
  console.log('Summary:', result.summary);
  process.exit(0);
}

main().catch(e => { console.error('[force-analyze] ERROR:', e.message); process.exit(1); });
