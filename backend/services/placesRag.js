'use strict';
const axios    = require('axios');
const db       = require('./db');
const cache    = require('./cache');
const cfg      = require('../config/config');
const { v4: uuidv4 } = require('uuid');
const notifier = require('./notifier');

// ================================================================
// Places RAG — mirrors rag.js but for Google Maps data
//
// Qdrant folder:  findingid_places
// MySQL table:    places
// RAG service:    same 127.0.0.1:8002 (shared infra)
// ================================================================

const PLACES_FOLDER = 'findingid_places';
const SCORE_GOOD    = 0.65;
const SCORE_WEAK    = 0.50;

const ragHttp = axios.create({
  baseURL: cfg.RAG.URL,
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Connected extension SSE clients ─────────────────────────────
const jobListeners = new Set();
notifier.on('job:maps', (job) => {
  for (const res of jobListeners) {
    try { res.write(`data: ${JSON.stringify({ job })}\n\n`); } catch (_) {}
  }
  console.log(`[places] pushed maps job "${job.query}" to ${jobListeners.size} extension(s)`);
});

// ── Retrieve places from Qdrant + MySQL ──────────────────────────
async function retrieve(query) {
  let places   = [];
  let bestScore = 0;
  let hasIndex  = false;

  // 1. Qdrant vector search
  try {
    const resp = await ragHttp.post('/products/query', {
      folder: PLACES_FOLDER,
      query,
      top_k: cfg.RAG.TOP_K,
    });
    const hits = resp.data?.products || [];
    hasIndex   = resp.data?.has_index ?? hits.length > 0;
    if (hits.length) bestScore = hits[0].score || 0;

    if (hits.length > 0) {
      // Hydrate from MySQL by name
      const names = hits.map(h => h.product_name);
      const ph    = names.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT id, name, category, rating, reviews_count, address, phone, website,
                has_wa, lat, lng, hours_json, images_json, about, maps_url, updated_at
         FROM places
         WHERE name IN (${ph}) AND name != ''
         ORDER BY FIELD(name, ${ph})`,
        [...names, ...names]
      );
      const scoreMap = Object.fromEntries(hits.map(h => [h.product_name, h.score]));
      places = rows.map(r => ({ ...r, _score: scoreMap[r.name] ?? 0 }))
                   .sort((a, b) => b._score - a._score);
    }
  } catch (e) {
    console.warn('[places] Qdrant query failed:', e.message);
  }

  // 2. FULLTEXT fallback if Qdrant empty or weak
  if (bestScore < SCORE_WEAK || places.length < 3) {
    try {
      const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
      const ftQuery = tokens.map(t => `+${t}*`).join(' ');
      const [ftRows] = await db.query(
        `SELECT id, name, category, rating, reviews_count, address, phone, website,
                has_wa, lat, lng, hours_json, images_json, about, maps_url, updated_at
         FROM places
         WHERE name != ''
           AND MATCH(name, category, address, about) AGAINST (? IN BOOLEAN MODE)
         ORDER BY rating DESC, reviews_count DESC
         LIMIT ?`,
        [ftQuery, cfg.RAG.TOP_K]
      );
      if (ftRows.length > 0) {
        const existingIds = new Set(places.map(p => p.id));
        const extras = ftRows
          .filter(r => !existingIds.has(r.id))
          .map(r => ({ ...r, _score: 0.45 }));
        places = [...places, ...extras].slice(0, cfg.RAG.TOP_K);
        if (!bestScore) bestScore = extras.length ? 0.45 : 0;
      }
    } catch (e) {
      console.warn('[places] FULLTEXT fallback failed:', e.message);
    }
  }

  const context       = buildContext(places, query);
  const needsScraping = bestScore < SCORE_WEAK || places.length < 3;

  return { docs: places, context, needsScraping, bestScore, hasIndex };
}

// ── Create a maps scraping job ───────────────────────────────────
async function createMapsJob(query, priority = 1) {
  // Parse "keyword di city" or "keyword city" patterns
  const cityMatch  = query.match(/\b(?:di|in|at|near|dekat)\s+(.+)$/i);
  const city       = cityMatch ? cityMatch[1].trim() : '';
  const keyword    = cityMatch ? query.replace(cityMatch[0], '').trim() : query;

  const id        = uuidv4();
  const expiresAt = new Date(Date.now() + 300_000); // 5 min TTL

  try {
    await db.query(
      `INSERT INTO maps_jobs (id, keyword, city, query, priority, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id=id`,
      [id, keyword, city, query, priority, expiresAt]
    );
    const job = { id, type: 'maps', keyword, city, query, priority };
    notifier.emit('job:maps', job);
    console.log(`[places] created maps job: "${query}" (keyword="${keyword}" city="${city}")`);
    return id;
  } catch (e) {
    console.error('[places] createMapsJob error:', e.message);
    return null;
  }
}

// ── RAG indexing ─────────────────────────────────────────────────
async function indexPlaces(places) {
  if (!places?.length) return;
  const payload = places.map(p => ({
    id:          p.id,
    name:        p.name,
    category:    p.category || '',
    price:       null,
    description: [p.about, p.address, p.category].filter(Boolean).join(' | ').slice(0, 500),
    specs:       p.hours_json ? JSON.stringify(p.hours_json) : null,
  }));

  await ragHttp.post('/products/index', { folder: PLACES_FOLDER, products: payload });

  const ids = places.map(p => p.id).filter(Boolean);
  if (ids.length) {
    await db.query(
      `UPDATE places SET rag_indexed_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    ).catch(e => console.error('[places] rag_indexed_at update failed:', e.message));
  }
}

async function indexPendingPlaces() {
  const [rows] = await db.query(
    `SELECT id, name, category, about, address, hours_json
     FROM places
     WHERE name != '' AND rag_indexed_at IS NULL
     ORDER BY id ASC
     LIMIT 500`
  );
  if (!rows.length) return { indexed: 0 };
  await indexPlaces(rows);
  console.log(`[places] indexPendingPlaces: indexed ${rows.length} places`);
  return { indexed: rows.length };
}

// ── Build LLM context ─────────────────────────────────────────────
function buildContext(places, query) {
  if (!places.length) return `Tidak ada tempat relevan ditemukan untuk: "${query}".`;

  const lines = places.map((p, i) => {
    const parts = [
      `[${i + 1}] ${p.name}`,
      `    Kategori: ${p.category || '—'} | Rating: ${p.rating ? `${p.rating}/5 (${Number(p.reviews_count||0).toLocaleString()} ulasan)` : '—'}`,
      `    Alamat: ${p.address || '—'}`,
    ];
    if (p.phone)   parts.push(`    Telepon: ${p.phone}${p.has_wa ? ' (WA)' : ''}`);
    if (p.website) parts.push(`    Website: ${p.website.replace(/^https?:\/\//, '')}`);
    if (p.about)   parts.push(`    Info: ${String(p.about).slice(0, 200)}`);
    if (p.hours_json) {
      try {
        const h = typeof p.hours_json === 'string' ? JSON.parse(p.hours_json) : p.hours_json;
        if (h?.length) parts.push(`    Jam: ${h.slice(0,3).map(d => `${d.day}: ${d.hours}`).join(', ')}`);
      } catch (_) {}
    }
    parts.push(`    [ref:${p.id}]`);
    return parts.join('\n');
  });

  return `Data tempat dari Google Maps:\n\n${lines.join('\n\n')}`;
}

// ── Build vLLM messages ───────────────────────────────────────────
function buildMessages(query, context) {
  const systemPrompt = `/no_think
Kamu adalah finding.id Places, asisten pencarian tempat AI untuk Indonesia.
WAJIB jawab dalam Bahasa Indonesia. Jangan gunakan bahasa lain.

JIKA DATA TEMPAT TERSEDIA:
- Rekomendasikan TOP 3 terbaik. Tulis dengan format bernomor: 1. 2. 3.
- Per tempat tulis dalam urutan ini:
  a) Nama + kategori + rating + jumlah ulasan
  b) Alamat lengkap
  c) Kelebihan utama: 1-2 kalimat konkret (apa yang membuatnya unggul)
  d) Cocok untuk: siapa yang sebaiknya ke sini
- Jika ada nomor WA: sebutkan "Bisa hubungi via WhatsApp"
- Di akhir tulis 1 kalimat perbandingan ketiga tempat.
- Jangan tampilkan ID angka di teks — hanya di baris TEMPAT.

JIKA DATA KOSONG ATAU BELUM CUKUP:
- "Data tempat sedang kami kumpulkan dari Google Maps..."
- Berikan 2-3 tips umum tentang kategori tempat ini.

Maksimal 500 kata. Padat, bantu pengguna benar-benar memutuskan.

WAJIB: Setelah merekomendasikan, SELALU akhiri responsmu dengan satu baris ini persis:
TEMPAT:xxx,yyy,zzz
Contoh (jika ref tempat pilihanmu adalah 42, 17, 95): TEMPAT:42,17,95
Jangan lewatkan baris TEMPAT. Ini wajib.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Konteks:\n${context}\n\n---\nPertanyaan: ${query}` },
  ];
}

module.exports = {
  retrieve, createMapsJob, indexPlaces, indexPendingPlaces,
  buildContext, buildMessages, jobListeners,
};
