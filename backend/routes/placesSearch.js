'use strict';
const express  = require('express');
const router   = express.Router();
const vllm     = require('../services/vllm');
const cache    = require('../services/cache');
const db       = require('../services/db');
const notifier = require('../services/notifier');
const placesRag = require('../services/placesRag');
const crypto   = require('crypto');

// ================================================================
// POST /api/places/search  — SSE streaming (mirrors search.js)
//
// Flow (identical to product search):
//   1. SSE headers open immediately
//   2. Create maps scraping job → extension claims via /api/places/jobs
//   3. RAG retrieve from Qdrant findingid_places + MySQL FULLTEXT
//   4. Poll every 1s (up to 30s) until scraper delivers results
//   5. Stream LLM analysis with TEMPAT marker
//   6. Send place cards
//   7. Cache result
// ================================================================

function send(res, obj) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

const WAIT_MESSAGES = [
  'Mencari tempat terbaik untukmu...',
  'Mengumpulkan data dari Google Maps...',
  'Menemukan pilihan terpopuler...',
  'Menyaring tempat berkualitas...',
  'Hampir ketemu, sabar ya...',
  'Sedikit lagi...',
  'Memilihkan yang terbaik untukmu...',
  'Hampir selesai...',
];

router.post('/', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const raw = query.trim().slice(0, 500);
  const t0  = Date.now();

  // SSE headers — open immediately
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    // ── 1. Check cache ─────────────────────────────────────────
    const cacheKey = `places:${crypto.createHash('md5').update(raw.toLowerCase()).digest('hex')}`;
    const cached   = await cache.get(cacheKey);
    if (cached?.places?.length) {
      send(res, { type: 'status', message: 'Cache hit', stage: 'cache' });
      if (cached.text) send(res, { type: 'replace', content: cached.text });
      send(res, { type: 'places', data: cached.places });
      send(res, { type: 'done', sources: cached.sources, duration: Date.now() - t0, cached: true });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ── 2. Fire maps scraping job ──────────────────────────────
    let jobId = null;
    placesRag.createMapsJob(raw, 1)
      .then(id => { jobId = id; })
      .catch(() => {});

    // ── 3. Initial RAG retrieve ────────────────────────────────
    send(res, { type: 'status', message: 'Mencari di database...', stage: 'rag' });
    let { docs, context, needsScraping, bestScore } = await placesRag.retrieve(raw);
    console.log(`[places/search] attempt=1 docs=${docs.length} bestScore=${bestScore?.toFixed(2)}`);

    // ── 4. Poll until scraper delivers (mirrors search.js exactly) ──
    if (bestScore < 0.65 && docs.length < 3) {
      // Wait for ingest signal OR poll every 1s for up to 30s
      let signaled = false;
      const onSignal = () => { signaled = true; };
      notifier.once(`ingest:places:${raw}`, onSignal);

      for (let attempt = 2; attempt <= 30; attempt++) {
        send(res, {
          type:    'status',
          message: WAIT_MESSAGES[(attempt - 2) % WAIT_MESSAGES.length],
          stage:   'rag',
        });

        await new Promise(resolve => {
          const t = setTimeout(resolve, 1000);
          ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });

        if (!res.writableEnded) res.write(': heartbeat\n\n');
        if (ac.signal.aborted) { notifier.off(`ingest:places:${raw}`, onSignal); return res.end(); }

        ({ docs, context, bestScore } = await placesRag.retrieve(raw));
        console.log(`[places/search] attempt=${attempt} docs=${docs.length} bestScore=${bestScore?.toFixed(2)} signaled=${signaled}`);

        if (bestScore >= 0.65 || docs.length >= 3 || signaled) break;
      }
      notifier.off(`ingest:places:${raw}`, onSignal);
    }

    // ── 5. No results after all retries ──────────────────────
    if (docs.length === 0) {
      const msg = `⏳ Tempat **"${raw}"** belum tersedia di database kami.\n\nSilakan coba lagi dalam 1-2 menit, kami sedang mencarinya di Google Maps.`;
      send(res, { type: 'token', content: msg });
      send(res, { type: 'done', sources: 0, duration: Date.now() - t0, jobId, scraping: true });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ── 6. Send preliminary place cards ───────────────────────
    const preliminary = docs.map(p => ({
      id:       p.id,
      name:     p.name,
      category: p.category,
      rating:   p.rating,
      reviews:  p.reviews_count,
      address:  p.address,
      phone:    p.phone,
      website:  p.website,
      has_wa:   p.has_wa,
      lat:      p.lat,
      lng:      p.lng,
      images:   (() => { try { return typeof p.images_json === 'string' ? JSON.parse(p.images_json) : p.images_json; } catch { return null; } })(),
      maps_url: p.maps_url,
    }));
    send(res, { type: 'places', data: preliminary, preliminary: true });

    // ── 7. Stream LLM analysis ─────────────────────────────────
    const messages  = placesRag.buildMessages(raw, context);
    let fullAnswer  = '';
    let urlBuf      = '';

    function flushToken(chunk) {
      if (!chunk || ac.signal.aborted || res.writableEnded) return;
      send(res, { type: 'token', content: chunk });
    }
    function onToken(chunk) {
      urlBuf += chunk;
      const lastNl = urlBuf.lastIndexOf('\n');
      if (lastNl === -1) return;
      const safe = urlBuf.slice(0, lastNl + 1);
      urlBuf = urlBuf.slice(lastNl + 1);
      if (safe) flushToken(safe);
    }

    try {
      fullAnswer = await vllm.generateStream(messages, onToken, ac.signal);
    } catch (llmErr) {
      if (llmErr.name === 'CanceledError' || llmErr.name === 'AbortError') return res.end();
      fullAnswer = docs.length
        ? `Ditemukan ${docs.length} tempat relevan. Layanan AI sedang sibuk, silakan coba lagi.`
        : 'Tempat tidak ditemukan. Kami sedang mengumpulkan data baru.';
      flushToken(fullAnswer);
    }

    if (urlBuf) flushToken(urlBuf);

    // ── 8. Parse TEMPAT marker → send final cards ──────────────
    let chosenIds = [];
    const tempatMatch = fullAnswer.match(/TEMPAT:\s*\[?([\d,\s]+)\]?/);
    console.log(`[places/search] LLM output (${fullAnswer.length} chars), TEMPAT: ${tempatMatch ? tempatMatch[0] : 'NONE'}`);
    if (tempatMatch) {
      chosenIds = tempatMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
      fullAnswer = fullAnswer.replace(/\n?TEMPAT:\s*\[?[\d,\s]+\]?\n?/g, '').trimEnd();
    }

    send(res, { type: 'replace', content: fullAnswer });

    let sentCards = [];
    if (docs.length && chosenIds.length) {
      const docMap    = Object.fromEntries(docs.map(p => [p.id, p]));
      const chosenSet = new Set(chosenIds);
      const allCards  = [
        ...chosenIds.map(id => docMap[id]).filter(Boolean),
        ...docs.filter(p => !chosenSet.has(p.id)),
      ].slice(0, 9);

      sentCards = allCards.map(p => ({
        id:         p.id,
        name:       p.name,
        category:   p.category,
        rating:     p.rating,
        reviews:    p.reviews_count,
        address:    p.address,
        phone:      p.phone,
        website:    p.website,
        has_wa:     p.has_wa,
        lat:        p.lat,
        lng:        p.lng,
        images:     (() => { try { return typeof p.images_json === 'string' ? JSON.parse(p.images_json) : p.images_json; } catch { return null; } })(),
        maps_url:   p.maps_url,
        is_chosen:  chosenSet.has(p.id),
        chosen_rank: chosenSet.has(p.id) ? chosenIds.indexOf(p.id) + 1 : null,
      }));
      send(res, { type: 'places', data: sentCards });
    }

    // ── 9. Done ────────────────────────────────────────────────
    send(res, { type: 'done', sources: docs.length, duration: Date.now() - t0, jobId });
    res.write('data: [DONE]\n\n');

    // ── 10. Cache ──────────────────────────────────────────────
    if (fullAnswer && sentCards.length) {
      cache.set(cacheKey, {
        text:    fullAnswer,
        places:  sentCards,
        sources: docs.length,
      }, 180).catch(() => {}); // 3 min TTL for places (fresher than products)
    }

  } catch (err) {
    console.error('[places/search] error:', err.message);
    if (!res.writableEnded) {
      send(res, { type: 'error', message: 'Terjadi kesalahan server. Silakan coba lagi.' });
      res.write('data: [DONE]\n\n');
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
