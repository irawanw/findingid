'use strict';
/**
 * POST /api/agent
 *
 * SSE endpoint for general (non-product) queries.
 * - Pre-fetches structured data from free APIs (forex, gold, crypto, weather, nearby)
 * - Falls back to SearXNG (self-hosted meta-search) for general web queries
 * - Sends context to local Qwen via vLLM and streams the response
 * No Hermes, no external paid APIs needed.
 *
 * Body: { query: string, lat?: number, lon?: number }
 */

const express = require('express');
const router  = express.Router();
const rag     = require('../services/rag');
const db      = require('../services/db');
const { bestVariantDiscount } = require('../services/discount');

const VLLM_URL  = process.env.VLLM_BASE_URL  || 'http://192.168.18.36:8001/v1';
const VLLM_MODEL = process.env.VLLM_MODEL    || 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const SEARXNG   = process.env.SEARXNG_URL    || 'http://127.0.0.1:8889';

function send(res, obj) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getYahooPrice(symbol) {
  const enc = encodeURIComponent(symbol);
  const d = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=1d`
  );
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('no price');
  return { price: meta.regularMarketPrice, currency: meta.currency, symbol };
}

async function getForex(from, to = 'IDR') {
  const d = await fetchJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  return { base: d.base, date: d.date, rate: d.rates?.[to], target: to };
}

async function getCrypto(ids = 'bitcoin,ethereum') {
  return fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,idr`
  );
}

async function getWeather(lat, lon) {
  const d = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weathercode,windspeed_10m,relativehumidity_2m&timezone=auto`
  );
  return d?.current;
}

async function getNearby(query, lat, lon, limit = 8) {
  const q = encodeURIComponent(query);
  return fetchJson(
    `https://nominatim.openstreetmap.org/search?q=${q}&lat=${lat}&lon=${lon}` +
    `&format=json&limit=${limit}&addressdetails=1`,
    { 'User-Agent': 'finding.id/1.0 (contact@finding.id)' }
  );
}

async function searchWeb(query, lang = 'id-ID') {
  const q   = encodeURIComponent(query);
  const url = `${SEARXNG}/search?q=${q}&format=json&language=${lang}&categories=general`;
  const d   = await fetchJson(url, {
    'X-Forwarded-For': '127.0.0.1',
    'X-Real-IP':       '127.0.0.1',
  });
  return (d.results || []).slice(0, 6).map(r => ({
    title:   (r.title   || '').slice(0, 120),
    url:     r.url     || '',
    content: (r.content || '').slice(0, 200),
  }));
}

// ─── Query pattern matching ───────────────────────────────────────────────────

const P = {
  gold:      /\b(emas|gold|xau|logam\s*mulia|antam)\b/i,
  silver:    /\b(perak|silver|xag)\b/i,
  crude:     /\b(crude\s*oil|minyak\s*(mentah|bumi|brent|wti)|petroleum)\b/i,
  usd:       /\b(usd|dolar(\s*(as|amerika))?|dollar)\b.*\b(idr|rupiah|rp)\b|\bkurs.*usd\b|\bdolar.*sekarang\b/i,
  eur:       /\b(eur|euro)\b.*\b(idr|rupiah)\b|\bkurs.*euro\b/i,
  sgd:       /\b(sgd|dolar\s*singapura)\b/i,
  myr:       /\b(myr|ringgit)\b/i,
  jpy:       /\b(jpy|yen)\b/i,
  kurs:      /\bkurs\b/i,
  crypto:    /\b(bitcoin|btc|ethereum|eth|crypto|kripto)\b/i,
  ihsg:      /\b(ihsg|indeks\s*harga\s*saham|bursa\s*efek)\b/i,
  weather:   /\b(cuaca|weather|suhu|hujan|mendung|panas|dingin|temperature)\b/i,
  nearby:    /\b(terdekat|nearby|sekitar\s*(sini|saya)|dekat\s*(sini|saya)|di\s*dekat\s*saya)\b/i,
};

// ─── Pre-fetch structured data ────────────────────────────────────────────────

async function prefetch(query, lat, lon) {
  const q = query.toLowerCase();
  const tasks = [];

  if (P.gold.test(q))   tasks.push(getYahooPrice('GC=F').then(d => `Harga Emas (Gold Futures COMEX): $${d.price.toLocaleString()} USD per troy oz`).catch(() => null));
  if (P.silver.test(q)) tasks.push(getYahooPrice('SI=F').then(d => `Harga Perak (Silver Futures): $${d.price.toLocaleString()} USD per troy oz`).catch(() => null));
  if (P.crude.test(q)) {
    tasks.push(getYahooPrice('CL=F').then(d => `WTI Crude Oil: $${d.price.toLocaleString()} USD/barrel`).catch(() => null));
    tasks.push(getYahooPrice('BZ=F').then(d => `Brent Crude Oil: $${d.price.toLocaleString()} USD/barrel`).catch(() => null));
  }
  if (P.usd.test(q))    tasks.push(getForex('USD').then(d => `Kurs USD/IDR: Rp ${d.rate?.toLocaleString('id-ID')} (per ${d.date})`).catch(() => null));
  if (P.eur.test(q))    tasks.push(getForex('EUR').then(d => `Kurs EUR/IDR: Rp ${d.rate?.toLocaleString('id-ID')} (per ${d.date})`).catch(() => null));
  if (P.sgd.test(q))    tasks.push(getForex('SGD').then(d => `Kurs SGD/IDR: Rp ${d.rate?.toLocaleString('id-ID')} (per ${d.date})`).catch(() => null));
  if (P.myr.test(q))    tasks.push(getForex('MYR').then(d => `Kurs MYR/IDR: Rp ${d.rate?.toLocaleString('id-ID')} (per ${d.date})`).catch(() => null));
  if (P.jpy.test(q))    tasks.push(getForex('JPY').then(d => `Kurs JPY/IDR: Rp ${d.rate?.toLocaleString('id-ID')} (per ${d.date})`).catch(() => null));

  // Generic kurs — fetch top currencies
  if (P.kurs.test(q) && ![P.usd, P.eur, P.sgd, P.myr, P.jpy].some(p => p.test(q))) {
    tasks.push(fetchJson('https://api.frankfurter.app/latest?from=USD&to=IDR,EUR,SGD,MYR,JPY,GBP,CNY,AUD')
      .then(d => {
        const r = d.rates;
        const lines = [`Kurs per ${d.date} (base USD):`];
        if (r.IDR) lines.push(`USD/IDR: Rp ${r.IDR.toLocaleString('id-ID')}`);
        if (r.EUR) lines.push(`EUR/IDR: Rp ${Math.round(r.IDR / r.EUR).toLocaleString('id-ID')}`);
        if (r.SGD) lines.push(`SGD/IDR: Rp ${Math.round(r.IDR / r.SGD).toLocaleString('id-ID')}`);
        if (r.MYR) lines.push(`MYR/IDR: Rp ${Math.round(r.IDR / r.MYR).toLocaleString('id-ID')}`);
        if (r.JPY) lines.push(`JPY/IDR: Rp ${(r.IDR / r.JPY).toFixed(2)}`);
        return lines.join('\n');
      }).catch(() => null));
  }

  if (P.crypto.test(q)) {
    const ids = [];
    if (/bitcoin|btc/i.test(q)) ids.push('bitcoin');
    if (/ethereum|eth/i.test(q)) ids.push('ethereum');
    if (!ids.length) ids.push('bitcoin', 'ethereum');
    tasks.push(getCrypto(ids.join(',')).then(d => {
      const lines = ['Harga Crypto:'];
      if (d.bitcoin) lines.push(`Bitcoin (BTC): $${d.bitcoin.usd?.toLocaleString()} / Rp ${d.bitcoin.idr?.toLocaleString('id-ID')}`);
      if (d.ethereum) lines.push(`Ethereum (ETH): $${d.ethereum.usd?.toLocaleString()} / Rp ${d.ethereum.idr?.toLocaleString('id-ID')}`);
      return lines.join('\n');
    }).catch(() => null));
  }

  if (P.ihsg.test(q)) tasks.push(getYahooPrice('^JKSE').then(d => `IHSG: ${d.price?.toLocaleString('id-ID', { maximumFractionDigits: 2 })} poin`).catch(() => null));

  if (P.weather.test(q) && lat != null) {
    tasks.push(getWeather(lat, lon).then(d => {
      if (!d) return null;
      const wc = d.weathercode;
      const desc = wc <= 1 ? 'Cerah' : wc <= 3 ? 'Berawan sebagian' : wc <= 48 ? 'Berkabut/berawan' : wc <= 67 ? 'Hujan' : wc <= 77 ? 'Salju' : 'Badai/petir';
      return `Cuaca saat ini (lokasi user): Suhu ${d.temperature_2m}°C, ${desc}, Angin ${d.windspeed_10m} km/h, Kelembaban ${d.relativehumidity_2m}%`;
    }).catch(() => null));
  }

  if (P.nearby.test(q) && lat != null) {
    const placeMatch = q.match(/\b(restoran|restaurant|cafe|kafe|atm|bank|hotel|apotek|pharmacy|rumah\s*sakit|hospital|pom\s*bensin|spbu|minimarket|indomaret|alfamart|masjid|mosque|sekolah|mall|supermarket|warung)\b/i);
    const place = placeMatch?.[1] || 'place';
    tasks.push(getNearby(place, lat, lon, 6).then(places => {
      if (!places?.length) return null;
      const list = places.map((p, i) =>
        `${i + 1}. ${p.display_name?.split(',').slice(0, 3).join(', ')}`
      ).join('\n');
      return `${place.toUpperCase()} terdekat dari lokasi Anda:\n${list}`;
    }).catch(() => null));
  }

  const results = await Promise.allSettled(tasks);
  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .join('\n\n');
}

// ─── Product recommendations ──────────────────────────────────────────────────
// Call Qdrant vector search directly (semantic only — no token filter).
// rag.retrieve() has strict token guards designed for exact product search;
// for agent recommendations we want semantic proximity, not lexical exactness.

const cfg = require('../config/config');

async function getRelatedProducts(query, limit = 3) {
  if (!query || query.trim().length < 2) return [];
  try {
    // 1. Semantic search via RAG service (Qdrant)
    const res = await fetch(`${cfg.RAG.URL}/products/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folder: cfg.RAG.FOLDER, query: query.trim(), top_k: limit * 4 }),
      signal:  AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const { products: hits = [] } = await res.json();
    if (!hits.length) return [];

    // 2. Hydrate from DB — no token filter, semantic score is the relevance signal
    const names = hits.slice(0, limit * 3).map(h => h.product_name);
    const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
    const [rows] = await db.query(
      `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url, variants_json
       FROM products WHERE title IN (${placeholders}) AND is_active = true
       ORDER BY (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
       LIMIT $${names.length + 1}`,
      [...names, limit]
    );

    return rows.slice(0, limit).map(p => {
      const disc = bestVariantDiscount(p.variants_json);
      return {
        id:             p.id,
        title:          p.title,
        price:          p.price,
        rating:         p.rating,
        sold:           p.sold_count,
        source:         p.source,
        link:           p.link,
        affiliate_link: p.affiliate_link || null,
        image:          p.image_url,
        is_deal:        false,
        is_chosen:      false,
        chosen_rank:    null,
        best_discount:  disc ? { pct: disc.pct, price_before: disc.price_before } : null,
      };
    });
  } catch (e) {
    console.error('[agent] related products error:', e.message);
    return [];
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

async function agentHandler(req, res) {
  const { query, lat, lon } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  if (!res.headersSent) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const q   = query.trim();
    const lat_ = lat ?? null;
    const lon_ = lon ?? null;

    send(res, { type: 'status', message: 'Mengambil data real-time...', stage: 'agent' });
    console.log('[agent] prefetch start q=', q);

    // Run structured pre-fetch + web search in parallel
    const [structured, webResults] = await Promise.all([
      prefetch(q, lat_, lon_).catch(e => { console.error('[agent] prefetch error:', e.message); return ''; }),
      searchWeb(q).catch(e => { console.error('[agent] searchWeb error:', e.message); return []; }),
    ]);
    console.log('[agent] prefetch done structured=', structured?.length, 'web=', webResults?.length);

    // Build context block
    const contextParts = [];
    if (structured) contextParts.push(`=== DATA REAL-TIME ===\n${structured}`);
    if (webResults.length) {
      const webText = webResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`
      ).join('\n\n');
      contextParts.push(`=== HASIL PENCARIAN WEB ===\n${webText}`);
    }

    const context = contextParts.join('\n\n');
    const loc = (lat_ != null)
      ? `Lokasi user: lat=${lat_.toFixed(6)}, lon=${lon_.toFixed(6)}.`
      : 'Lokasi user: tidak diketahui.';

    const systemPrompt = `Kamu adalah asisten AI di dalam platform finding.id (marketplace Indonesia). /no_think
Jawab pertanyaan umum menggunakan data yang sudah disediakan di bawah ini.
${loc}

Aturan:
- Gunakan DATA REAL-TIME dan HASIL PENCARIAN WEB yang sudah disediakan untuk menjawab dengan akurat.
- Jangan mengarang data. Jika data tidak tersedia, katakan tidak tahu.
- Jika pertanyaan tentang membeli produk, arahkan: "Cari produk di kolom pencarian finding.id."
- Jawab dalam bahasa yang sama dengan user (Indonesia atau English).
- Format rapi dengan markdown (bold angka penting, bullet point).
- Singkat dan langsung ke poin.`;

    const userMessage = context
      ? `${q}\n\n${context}`
      : q;

    send(res, { type: 'status', message: 'Memproses jawaban...', stage: 'agent' });

    const body = JSON.stringify({
      model:       VLLM_MODEL,
      stream:      true,
      max_tokens:  1200,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    });

    // Combine user abort + 90s timeout
    const llmAc = new AbortController();
    const llmTimeout = setTimeout(() => llmAc.abort(), 90000);
    ac.signal.addEventListener('abort', () => llmAc.abort());

    const llmRes = await fetch(`${VLLM_URL}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: llmAc.signal,
    }).finally(() => clearTimeout(llmTimeout));

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => '');
      throw new Error(`LLM HTTP ${llmRes.status}: ${errText.slice(0, 200)}`);
    }

    const reader = llmRes.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) send(res, { type: 'token', content: token });
        } catch (_) {}
      }
    }

    // Recommend related products after the answer
    const related = await getRelatedProducts(q);
    console.log('[agent] related products:', related.length);
    if (related.length) {
      send(res, { type: 'products', data: related });
    }

    send(res, { type: 'done', sources: webResults.length, duration: 0, intent: 'agent' });
    res.write('data: [DONE]\n\n');

  } catch (err) {
    if (err.name === 'AbortError') return res.end();
    console.error('[agent] error:', err.message);
    if (!res.writableEnded) {
      send(res, { type: 'error', message: 'Asisten tidak tersedia saat ini. Coba lagi.' });
      res.write('data: [DONE]\n\n');
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

router.post('/', agentHandler);

module.exports = router;
module.exports.agentHandler = agentHandler;
