#!/usr/bin/env node
/**
 * gen_short_script.js
 * Generate a YouTube Shorts script (75s, Indonesian Gen Z style) for a product.
 *
 * Usage:
 *   node tools/gen_short_script.js <product_id>
 *   node tools/gen_short_script.js 86558
 *
 * Output: JSON script written to scripts/short_<id>.json
 */
'use strict';
// Use backend's node_modules
const BACKEND = __dirname + '/../backend';
process.chdir(BACKEND);
require(BACKEND + '/node_modules/dotenv').config({ path: BACKEND + '/.env' });

const mysql  = require(BACKEND + '/node_modules/mysql2/promise');
const _axiosMod = require(BACKEND + '/node_modules/axios');
const axios  = _axiosMod.default || _axiosMod;
const fs     = require('fs');
const path   = require('path');

const DB = {
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'findingid',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'findingid',
};
const VLLM_URL = process.env.VLLM_BASE_URL || 'http://127.0.0.1:8001/v1';
const VLLM_MODEL = process.env.VLLM_MODEL || 'Qwen3.5-9B-UD-Q5_K_XL.gguf';

// ── Load product + price history from DB ──────────────────────────
async function loadProduct(id) {
  const conn = await mysql.createConnection(DB);
  const [rows] = await conn.execute(
    `SELECT id, title, price, rating, sold_count, sold_display, category,
            specs, description, attributes_json, variants_json, reviews_json,
            images_json, variation_images_json, link, ai_analysis
     FROM products WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length) { await conn.end(); throw new Error(`Product ${id} not found`); }

  // Price history: global min/max across all variants and time
  const [phRows] = await conn.execute(
    `SELECT MIN(price) as all_time_low, MAX(price) as all_time_high,
            MIN(captured_at) as first_seen, MAX(captured_at) as last_seen,
            COUNT(DISTINCT variant_name) as variant_count
     FROM price_history WHERE product_id = ?`,
    [id]
  );
  // Per-color current prices (latest per variant)
  const [varPrices] = await conn.execute(
    `SELECT variant_name, price, captured_at
     FROM price_history WHERE product_id = ?
     ORDER BY captured_at DESC`,
    [id]
  );
  await conn.end();

  const p = rows[0];
  for (const col of ['attributes_json','variants_json','reviews_json','images_json','variation_images_json','ai_analysis']) {
    if (p[col] && typeof p[col] === 'string') {
      try { p[col] = JSON.parse(p[col]); } catch (_) { p[col] = null; }
    }
  }

  // Attach price history summary
  p.price_history = phRows[0]?.all_time_low ? {
    low:        Number(phRows[0].all_time_low),
    high:       Number(phRows[0].all_time_high),
    first_seen: phRows[0].first_seen,
    last_seen:  phRows[0].last_seen,
  } : null;

  // Current cheapest/most expensive variant (dedupe by color — take first tier)
  const seenVariant = new Set();
  const latestPerVariant = [];
  for (const r of varPrices) {
    const key = r.variant_name;
    if (!seenVariant.has(key)) {
      seenVariant.add(key);
      latestPerVariant.push({ name: r.variant_name, price: Number(r.price) });
    }
  }
  p.current_variant_prices = latestPerVariant;

  return p;
}

// ── Build product context for LLM ─────────────────────────────────
function buildProductContext(p) {
  // Price range from live variant prices (most accurate)
  const variantPrices = (p.current_variant_prices || []).map(v => v.price).filter(Boolean);
  const priceMin = variantPrices.length ? Math.min(...variantPrices) : p.price;
  const priceMax = variantPrices.length ? Math.max(...variantPrices) : p.price;
  const priceRange = priceMin && priceMax && priceMin !== priceMax
    ? `Rp ${Number(priceMin).toLocaleString('id-ID')} – Rp ${Number(priceMax).toLocaleString('id-ID')}`
    : `Rp ${Number(priceMin || p.price).toLocaleString('id-ID')}`;

  // All-time low from price_history
  const allTimeLow = p.price_history?.low
    ? `Rp ${Number(p.price_history.low).toLocaleString('id-ID')}`
    : null;
  const allTimeHigh = p.price_history?.high
    ? `Rp ${Number(p.price_history.high).toLocaleString('id-ID')}`
    : null;

  // Colors from variants (dedupe first tier)
  const colorSet = new Set();
  if (p.variants_json?.length) {
    for (const v of p.variants_json) {
      const color = v.name?.includes(',') ? v.name.split(',')[0] : v.name;
      if (color) colorSet.add(color);
    }
  }
  const colors = [...colorSet].slice(0, 6);

  // Sizes from specs or variants
  const sizeMatch = (p.specs || '').match(/Ukuran\s*:\s*([^|]+)/);
  const sizes = sizeMatch ? sizeMatch[1].trim() : null;

  // Reviews
  const reviews = p.reviews_json;
  const posReview = reviews?.positive?.[0]?.text?.slice(0, 200);
  const negReview = reviews?.negative?.[0]?.text?.slice(0, 150);

  // Specs highlights
  const specHighlights = [];
  if (p.attributes_json?.length) {
    for (const a of p.attributes_json) {
      if (['Bahan','Acara','Tipe Ujung Sepatu','Tinggi Hak','Wide Fit'].includes(a.name)) {
        specHighlights.push(`${a.name}: ${a.value}`);
      }
    }
  }

  // Pros from AI analysis (already enriched)
  const aiPros = Array.isArray(p.ai_analysis?.pros) ? p.ai_analysis.pros : [];
  // Target buyer from AI analysis
  const targetBuyer = p.ai_analysis?.target_buyer || null;

  const lines = [
    `Nama Produk: ${p.title}`,
    `Kategori: ${p.category || '-'}`,
    `Harga saat ini (range varian): ${priceRange}`,
    allTimeLow && allTimeHigh && allTimeLow !== allTimeHigh
      ? `Riwayat harga nyata (price_history): terendah ${allTimeLow} – tertinggi ${allTimeHigh} (GUNAKAN INI, bukan harga coret Shopee yang sering tidak realistis)`
      : `Harga nyata dari riwayat: ${allTimeLow || priceRange}`,
    `Rating: ${p.rating}/5`,
    `Terjual: ${p.sold_count?.toLocaleString('id-ID')} produk`,
    colors.length ? `Warna tersedia: ${colors.join(', ')}` : null,
    sizes      ? `Ukuran: ${sizes}` : null,
    specHighlights.length ? `Spesifikasi: ${specHighlights.join(' | ')}` : null,
    p.description ? `Deskripsi singkat: ${p.description.slice(0, 300)}` : null,
    aiPros.length ? `Kelebihan produk (masukkan ke segmen features atau suited_for):\n${aiPros.map((pro, i) => `  ${i+1}. ${pro}`).join('\n')}` : null,
    targetBuyer ? `Target pembeli (dari AI analysis): ${targetBuyer}` : null,
    posReview  ? `Ulasan positif: "${posReview}"` : null,
    negReview  ? `Ulasan negatif: "${negReview}"` : null,
    `Link produk: https://finding.id/p/${p.id}`,
  ].filter(Boolean);

  return lines.join('\n');
}

// ── Call LLM ──────────────────────────────────────────────────────
// Qwen3.5 thinking model: real answer is in message.content when thinking is off.
// This llama.cpp build exposes reasoning_content separately; content may be empty
// when max_tokens is hit during thinking phase. Use thinking:false to suppress it.
// Strip lone UTF-16 surrogates that cause llama.cpp JSON parse errors
function sanitize(s) { return (s||'').replace(/[\uD800-\uDFFF]/g, ''); }

// ── Number to Indonesian words conversion ──────────────────────────
// Converts numbers to words to avoid TTS pronouncing them as Chinese/Thai/Mandarin
const ONES = ['','satu','dua','tiga','empat','lima','enam','tujuh','delapan','sembilan'];
const TEENS = ['sepuluh','sebeluh','dua belas','tiga belas','empat belas','lima belas','enam belas','tujuh belas','delapan belas','sembilan belas'];
const TENS = ['','sepuluh','dua puluh','tiga puluh','empat puluh','lima puluh','enam puluh','tujuh puluh','delapan puluh','sembilan puluh'];
const BIGS = ['','ribu','juta','miliar','triliun'];

function convertNumberToWords(numStr) {
  // Check decimal pattern FIRST: "4.88" (dot as decimal separator, fewer than 3 digits after)
  const decimalMatch = numStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch && decimalMatch[2].length < 3) {
    const whole = parseInt(decimalMatch[1], 10);
    const decimals = decimalMatch[2];
    const wholeWords = numToWords(whole);
    const decimalWords = decimals.split('').map(d => ONES[parseInt(d, 10)]).join(' ');
    return `${wholeWords} koma ${decimalWords}`;
  }
  
  // Convert Indonesian format numbers: remove dots and convert to words
  // Handle: "20.000", "100.000", "1.500", "1.000.000"
  const wholeNum = parseInt(numStr.replace(/\./g, ''), 10);
  if (!isNaN(wholeNum)) {
    return numToWords(wholeNum);
  }
  
  return numStr; // Return original if no match
}

function numToWords(n) {
  if (n < 10) return ONES[n];
  if (n === 1000) return 'seribu';
  if (n < 20) return TEENS[n - 10];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return numToWords(Math.floor(n / 100)) + ' ratus' + (n % 100 ? ' ' + numToWords(n % 100) : '');
  
  // Handle 1000-999999 range
  if (n < 1000000) {
    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    let result = '';
    if (thousands === 1) {
      result = 'seribu';
    } else {
      result = numToWords(thousands) + ' ribu';
    }
    if (remainder > 0) {
      result += ' ' + numToWords(remainder);
    }
    return result;
  }
  
  for (let i = BIGS.length - 1; i >= 2; i--) {
    const divisor = Math.pow(10, i * 3);
    if (n >= divisor) {
      const quotient = Math.floor(n / divisor);
      const remainder = n % divisor;
      if (remainder === 0) {
        return numToWords(quotient) + ' ' + BIGS[i];
      } else {
        return numToWords(quotient) + ' ' + BIGS[i] + ' ' + numToWords(remainder);
      }
    }
  }
  return n.toString();
}

function convertNumbersInText(text) {
  // First, protect product codes by marking them
  const protectedCodes = [];
  let codeIndex = 0;
  
  // Match patterns like ABC-123, SKU-4567, X5, A1B2C3
  text = text.replace(/([A-Za-z]+)-(\d+)|(\d+[A-Z])|([A-Z]\d+[A-Z])|([A-Z]+\d+[A-Z]+)/g, (match, group1, group2, group3, group4, group5) => {
    const code = group1 !== undefined ? `${group1}-${group2}` : 
                 group3 !== undefined ? group3 :
                 group4 !== undefined ? group4 : group5;
    const placeholder = `__PROTECTED_CODE_${codeIndex++}__`;
    protectedCodes.push({ placeholder, code });
    return placeholder;
  });
  
  // Now convert all regular numbers
  text = text.replace(/(\d{1,3}(?:\.\d{3})+|\d+\.\d+|\b\d+\b)(?![\w-])/g, (match) => {
    return convertNumberToWords(match);
  });
  
  // Restore protected codes
  for (const item of protectedCodes) {
    text = text.replace(item.placeholder, item.code);
  }
  
  return text;
}

async function callLLM(systemPrompt, userPrompt) {
  userPrompt = sanitize(userPrompt);
  const { data } = await axios.post(`${VLLM_URL}/chat/completions`, {
    model:       VLLM_MODEL,
    temperature: 0.75,
    max_tokens:  7500,
    messages: [
      { role: 'system',  content: systemPrompt },
      { role: 'user',    content: userPrompt   },
    ],
    chat_template_kwargs: { enable_thinking: false },
  }, { timeout: 120000 });

  const msg = data.choices?.[0]?.message || {};
  // This llama.cpp build puts thinking in reasoning_content, final answer in content.
  // When max_tokens is large enough for thinking to complete, content will have the JSON.
  // If content is empty (thinking ate all tokens), extract last JSON block from reasoning.
  let text = msg.content?.trim() || '';
  if (!text) {
    const thinking = msg.reasoning_content?.trim() || '';
    // Extract the last JSON object that appears in the reasoning (the drafted output)
    const matches = [...thinking.matchAll(/\{[\s\S]*?\}/g)];
    text = matches.length ? matches[matches.length - 1][0] : '';
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : text;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const productId = parseInt(process.argv[2], 10);
  if (!productId) {
    console.error('Usage: node gen_short_script.js <product_id>');
    process.exit(1);
  }

  console.log(`Loading product ${productId}...`);
  const p = await loadProduct(productId);
  console.log(`→ "${p.title}"`);

  const context = buildProductContext(p);
  console.log('\n── Product context ──\n' + context + '\n');

  const systemPrompt = `/no_think
Kamu adalah kreator konten YouTube Shorts profesional Indonesia spesialis video produk viral.
Tugas: buat script video ~60 detik (±130 kata narasi) dengan gaya Gen Z Indonesia yang asik, fun, dan cinematik.

FORMAT OUTPUT (JSON saja, tanpa teks lain):
{
  "title": "judul video menarik max 60 karakter",
  "hook_text": "teks overlay besar di awal (max 8 kata, bikin penasaran)",
  "estimated_duration": 60,
  "segments": [
    {
      "id": "hook",
      "start_s": 0,
      "duration_s": 5,
      "visual": "deskripsi visual/shot untuk editor (1 kalimat)",
      "narration": "teks narasi yang dibaca"
    },
    ...lebih banyak segmen...
  ],
  "cta": "teks call-to-action akhir video",
  "hashtags": ["#tag1","#tag2",...max 8 hashtag]
}

SEGMEN WAJIB (urutan, total ~60s):
1. hook (0-5s, 5s): pertanyaan atau pernyataan mengejutkan yang bikin stop scroll
2. reveal (5-15s, 10s): perkenalan produk + keunggulan utama
3. price_wow (15-25s, 10s): reveal harga yang bikin kaget, bandingkan dengan nilai yang didapat
4. features (25-42s, 17s): 3 fitur unggulan konkret dengan bahasa casual dan spesifik — gunakan poin dari "Kelebihan produk" di bawah
5. suited_for (42-52s, 10s): siapa yang paling cocok/butuh produk ini — buat skenario nyata: "kalau kamu sering...", "perfect buat yang...", "kalau aktivitas kamu..."
6. proof (52-57s, 5s): rating pasti + jumlah terjual + 1 kutipan frasa nyata dari pembeli (WAJIB pakai frasa "yang udah beli bilang..." atau "pembelinya pada ngomong..." — DILARANG pakai kata "review")
7. cta (57-60s, 3s): arahkan ke finding.id dengan gaya fun — contoh: "Penasaran sama detail lengkapnya? Cek di finding dot id ya bestie, review produk-nya ada di sana!" atau variasi kreatif lain

GAYA NARASI:
- Bahasa Indonesia gaul/Gen Z (pakai: nih, dong, banget, bestie, literally, which is, basically, no cap, so cute, super, worth it, next level, nggak, dll)
- Campurkan kata-kata English yang natural ala Jaksel: "literally so cute", "which is worth it banget", "basically next level", "no cap"
- Energetik, kasual, seperti ngobrol sama teman — fun dan playful
- Selipkan fakta spesifik (harga, berapa terjual, rating pasti)
- Kalimat pendek, ritme cepat

ATURAN PENULISAN WAJIB (JANGAN DILANGGAR):
1. DILARANG singkatan chatting — tulis kata lengkap: "lagi" bukan "lg", "dengan" bukan "dgn", "yang" bukan "yg", "tidak" bukan "tdk" — untuk gaya kasual pakai "nggak"
2. HARGA selalu dibulatkan dan pakai akhiran "-an" ala obrolan: "seratus delapan puluhan ribu" bukan "seratus delapan puluh delapan ribu", "enam puluhan ribu" bukan "enam puluh dua ribu", "satu jutaan" bukan "satu juta dua ratus ribu" — ini bikin lebih casual dan relatable. Angka NON-harga tetap ditulis kata-kata Indonesia biasa.
3. Kode model produk boleh tetap dalam bahasa Inggris/huruf latin (contoh: kode seri, nomor model) — sesuaikan dengan produk yang sedang diproses, jangan menyebut nama produk lain
4. Kutipan dari pembeli wajib spesifik — ambil frasa nyata dari data, bukan generik. JANGAN pakai kata "review" — pakai "yang udah beli bilang", "pembelinya bilang", "kata pembelinya", dll
5. Kalau ada keluhan ukuran di feedback negatif, address langsung: kasih tips ukuran atau klarifikasi fit-nya
6. DILARANG menyebut kata "review" di narasi segmen MANAPUN kecuali di segmen cta (hanya saat mengarahkan ke finding.id)
7. DILARANG menyebut "klik link deskripsi", "link di bawah", atau sejenisnya — arahkan SELALU ke "finding dot id" atau "finding.id"
8. PEMISAH CAPTION: gunakan " --- " (spasi-tiga-strip-spasi) HANYA untuk memisahkan kalimat yang BERBEDA isi/maknanya agar tampil sebagai caption TERPISAH di layar. JANGAN ulangi teks yang sama di kedua sisi ---. JANGAN duplikat narasi. Gunakan --- hanya saat ada pergantian ide/kalimat yang nyata. Contoh BENAR: "Ada yang bilang 'Emang boleh beli empat?' Ada yang bilang 'Ketiak jadi kering!' --- Tenang bestie, oles tipis saja ya!" Contoh SALAH (JANGAN LAKUKAN): "Klik link sekarang! --- Klik link sekarang!"`;

  const userPrompt = `Buat script YouTube Shorts untuk produk berikut:\n\n${context}`;

  console.log('Calling LLM...');
  const raw = await callLLM(systemPrompt, userPrompt);

  let script;
  try {
    if (!raw) throw new Error('Empty response from LLM');
    // Try direct parse first
    try {
      script = JSON.parse(raw);
    } catch (_) {
      // Truncated JSON — strip trailing incomplete token and close open brackets
      let fixed = raw.replace(/,\s*$/, '').replace(/[^}\]]*$/, '');
      const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
      const braces = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
      fixed += ']'.repeat(Math.max(0, opens)) + '}'.repeat(Math.max(0, braces));
      script = JSON.parse(fixed);
    }
  } catch (e) {
    console.error('Failed to parse LLM response as JSON:', e.message);
    console.log('Raw response:\n', raw);
    process.exit(1);
  }

  // Attach product metadata
  script.product_id           = p.id;
  script.product_title        = p.title;
  script.product_price        = p.price;
  script.product_rating       = p.rating;
  script.product_sold_display = p.sold_display || (p.sold_count ? p.sold_count.toLocaleString('id-ID') : '');
  script.product_images       = p.images_json || [];
  script.product_link         = `https://finding.id/p/${p.id}`;
  script.generated_at         = new Date().toISOString();

  // Convert numbers to words in all narration text to avoid TTS mispronunciation
  if (script.segments && Array.isArray(script.segments)) {
    for (const seg of script.segments) {
      if (seg.narration) {
        seg.narration = convertNumbersInText(seg.narration);
      }
      if (seg.caption) {
        seg.caption = convertNumbersInText(seg.caption);
      }
    }
  }

  const outDir  = path.join(__dirname, '../scripts');
  const outFile = path.join(outDir, `short_${p.id}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(script, null, 2));

  console.log(`\n✓ Script saved → ${outFile}`);
  console.log('\n── Generated Script ──');
  console.log(`Title: ${script.title}`);
  console.log(`Hook:  ${script.hook_text}`);
  console.log(`Duration: ~${script.estimated_duration}s`);
  console.log('\nSegments:');
  for (const seg of (script.segments || [])) {
    console.log(`  [${seg.start_s}s-${seg.start_s + seg.duration_s}s] ${seg.id.toUpperCase()}`);
    console.log(`    Visual: ${seg.visual}`);
    console.log(`    Narasi: ${seg.narration}\n`);
  }
  console.log(`CTA: ${script.cta}`);
  console.log(`Tags: ${script.hashtags?.join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
