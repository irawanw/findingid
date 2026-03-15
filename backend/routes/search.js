'use strict';
const express         = require('express');
const router          = express.Router();
const rag             = require('../services/rag');
const vllm            = require('../services/vllm');
const cache           = require('../services/cache');
const db              = require('../services/db');
const cfg             = require('../config/config');
const crypto          = require('crypto');
const { normalizeQueryFull, classifyIntent } = require('../services/queryNormalizer');

// LLM-based classifier for ambiguous queries — returns 'chat' or 'search'

// ================================================================
// POST /api/search
//
// SSE streaming endpoint. Sends newline-delimited JSON events:
//
//   data: {"type":"status","message":"...","stage":"rag|llm|done"}
//   data: {"type":"token","content":"..."}
//   data: {"type":"products","data":[{...}]}
//   data: {"type":"done","sources":5,"duration":1200}
//   data: {"type":"error","message":"..."}
//   data: [DONE]
//
// Backpressure: we check res.writableEnded before each write.
// Cancellation: client disconnect fires 'close' → abort controller.
// ================================================================

// SSE helper — writes a single event line
function send(res, obj) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

router.post('/', async (req, res) => {
  const { query, history } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const raw = query.trim().slice(0, 500);
  const t0  = Date.now();

  // ── SSE headers — open connection immediately ─────────────
  // Must happen before any async work so the browser sees a live
  // stream even while normalizeQueryFull / cache lookup runs.
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // ── AbortController for vLLM cancellation ────────────────
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
  // ── Normalize query (may call LLM for price inference) ───
  const { query: q, price, preferredCategories, excludedCategories, note } = await normalizeQueryFull(raw, {
    llmComplete: vllm.complete.bind(vllm),
    cache,
  });
  if (note) console.log(`[search] normalize: "${raw}" → "${q}" (${note})`);
  if (price) console.log(`[search] price filter: ${price.min}–${price.max} (target ${price.target})`);
  if (preferredCategories?.length) console.log(`[search] preferred categories: ${preferredCategories.join(', ')}`);
  if (excludedCategories?.length)  console.log(`[search] excluded categories: ${excludedCategories.join(', ')}`);

    // ── 1. Classify intent ──────────────────────────────────
    const hasHistory = Array.isArray(history) && history.length > 0;
    const intent = await classifyIntent(raw, hasHistory);
    const isSearch = intent === 'search';
    console.log(`[search] ── NEW REQUEST ── query="${raw}" intent="${intent}" isSearch=${isSearch}`);

    // ── 2. Check Redis cache ────────────────────────────────
    const cacheKey = cache.searchKey(JSON.stringify({
      q,
      price,
      preferredCategories,
      excludedCategories,
    }));
    const cached   = await cache.get(cacheKey);

    // Discard stale cache entries that have no products (written before PILIHAN fix)
    if (cached && cached.products?.length) {
      send(res, { type: 'status', message: 'Cache hit', stage: 'cache' });
      // Stream cached text token-by-token to preserve the typing effect
      if (cached.text) {
        // Cached text already has markdown links [name](url) — send as replace, not token stream
        send(res, { type: 'replace', content: cached.text });
      }
      send(res, { type: 'products', data: cached.products });
      send(res, { type: 'done', sources: cached.sources, duration: Date.now() - t0, cached: true });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // If cached but no products, delete it and run fresh
    if (cached) await cache.del(cacheKey).catch(() => {});

    // ── 3. Always fire scraping job for SEARCH intent (keeps data fresh) ──
    let jobId = null;
    if (isSearch) {
      // Use raw (original) query so scraper searches Shopee with the full phrase
      // e.g. "smartphone 7 jutaan" → Shopee search returns price-appropriate results.
      // Normalized q (price stripped) is only for internal vector/DB lookups.
      rag.createScrapingJob(raw, ['shopee'])
        .then(id => { jobId = id; })
        .catch(() => {});
    }

    // ── 4. RAG retrieval — poll every 1s until scraper delivers results ──
    const RAG_RETRIES  = 30;  // 30 × 1s = 30s max wait
    const WAIT_MESSAGES = [
      'Mencari produk terbaik untuk kamu...',
      'Mencari produk yang paling laris...',
      'Menemukan pilihan terpopuler...',
      'Memilihkan yang terbaik untukmu...',
      'Mencari penawaran terbaik...',
      'Menganalisis pilihan produk...',
      'Hampir ketemu, sabar ya...',
      'Sedikit lagi, mau sempurna dulu...',
      'Hampir selesai...',
    ];
    let docs          = [];
    let context       = '';
    let needsScraping = true;

    send(res, { type: 'status', message: 'Mencari di database...', stage: 'rag' });
    let bestScore = 0;
    ({ docs, context, needsScraping, bestScore } = await rag.retrieve(q, { price, preferredCategories, excludedCategories }));
    console.log(`[search] attempt=1 docs=${docs.length} bestScore=${bestScore?.toFixed(2)} needsScraping=${needsScraping} isSearch=${isSearch}`);

    // ── 3b. vLLM query rewrite fallback ─────────────────────
    // When RAG finds nothing useful on first try, ask the LLM to rephrase
    // the query to better match product titles in the DB, then retry once.
    // This helps with typos, unusual phrasing, or overly generic terms.
    // Only fires on failure — zero overhead on the happy path.
    if (bestScore < 0.70 && docs.length < 3 && isSearch) {
      try {
        send(res, { type: 'status', message: 'Mencoba pendekatan berbeda...', stage: 'rag' });
        const rewritten = await vllm.complete(
          'Kamu adalah optimizer query pencarian produk Indonesia. ' +
          'Tugas: tulis ulang query pencarian agar lebih cocok dengan judul produk di marketplace Indonesia (Shopee/Tokopedia). ' +
          'Gunakan kata kunci produk yang umum dipakai penjual. Balas HANYA dengan query baru, tanpa penjelasan tambahan.',
          `Query: "${raw}"\nQuery yang lebih baik:`,
          150
        );
        const rw = rewritten?.trim().replace(/^["']|["']$/g, '').trim();
        if (rw && rw.toLowerCase() !== raw.toLowerCase() && rw.length > 1) {
          console.log(`[search] vLLM rewrite: "${raw}" → "${rw}"`);
          const rwNorm = await normalizeQueryFull(rw, { llmComplete: vllm.complete.bind(vllm), cache });
          const rwResult = await rag.retrieve(rwNorm.query || rw, {
            price:                rwNorm.price               || price,
            preferredCategories:  rwNorm.preferredCategories?.length ? rwNorm.preferredCategories : preferredCategories,
            excludedCategories:   rwNorm.excludedCategories?.length  ? rwNorm.excludedCategories  : excludedCategories,
          });
          if (rwResult.docs.length > docs.length || rwResult.bestScore > bestScore) {
            ({ docs, context, bestScore, needsScraping } = rwResult);
            console.log(`[search] rewrite improved: docs=${docs.length} score=${bestScore?.toFixed(2)}`);
          }
          // Also scrape with the rewritten query so future searches benefit.
          // The original raw query was already queued above — this adds the
          // LLM-improved version so Shopee gets a better search term too.
          rag.createScrapingJob(rw, ['shopee']).catch(() => {});
        }
      } catch (rwErr) {
        console.warn('[search] vLLM rewrite fallback failed:', rwErr.message);
      }
    }

    if (bestScore < 0.70 && docs.length < 3 && isSearch) {
      for (let attempt = 2; attempt <= RAG_RETRIES; attempt++) {
        send(res, {
          type: 'status',
          message: WAIT_MESSAGES[(attempt - 2) % WAIT_MESSAGES.length],
          stage: 'rag',
        });

        await new Promise(resolve => {
          const t = setTimeout(resolve, 1000);
          ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });

        if (!res.writableEnded) res.write(': heartbeat\n\n');
        if (ac.signal.aborted) return res.end();

        ({ docs, context, needsScraping, bestScore } = await rag.retrieve(q, { price, preferredCategories, excludedCategories }));
        console.log(`[search] attempt=${attempt} docs=${docs.length} bestScore=${bestScore?.toFixed(2)}`);

        if (bestScore >= 0.70) break;
        if (docs.length >= 3) { console.log(`[search] ${docs.length} docs found — proceeding`); break; }
      }
    }

    // ── 4b. Augment docs with fresh scrape batch (all 60 products) ──────────
    // After the polling loop, check Redis for the full batch just scraped.
    // vLLM then sees all 60 candidates and picks the real top 3 — not just
    // the 10 that RAG happened to surface.
    if (isSearch && docs.length > 0) {
      try {
        const batchKey = `batch:${crypto.createHash('md5').update(raw.toLowerCase()).digest('hex')}`;
        const redis = cache.getClient();
        const batchIds = await redis.lrange(batchKey, 0, -1);
        if (batchIds.length > 0) {
          const existingIds = new Set(docs.map(d => d.id));
          const newIds = batchIds.map(Number).filter(id => id > 0 && !existingIds.has(id)).slice(0, 50);
          if (newIds.length > 0) {
            const ph = newIds.map(() => '?').join(',');
            const [batchRows] = await db.query(
              `SELECT id, title, price, rating, sold_count, source, link, affiliate_link,
                      image_url, category, specs, reviews_json, updated_at
               FROM products WHERE id IN (${ph}) AND is_active = 1 AND price >= 50000`,
              newIds
            );
            if (batchRows.length > 0) {
              docs = [...docs, ...batchRows].slice(0, 19);
              context = rag.buildContext(docs, q);
              console.log(`[search] batch augment: +${batchRows.length} products → ${docs.length} total for vLLM`);
            }
          }
        }
      } catch (_) {}
    }

    // ── 5. If still no results after all retries, bail ──
    console.log(`[search] after retries: bestScore=${bestScore?.toFixed(2)} docs=${docs.length}`);
    if (bestScore < 0.70 && docs.length < 3 && isSearch) {
      const msg = `⏳ Produk **"${raw}"** belum tersedia saat ini.\n\nSilakan coba lagi dalam 1-2 menit, kami sedang mencarikannya untukmu.`;
      send(res, { type: 'token', content: msg });
      send(res, { type: 'done', sources: 0, duration: Date.now() - t0, jobId, intent, scraping: true });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ── 5. Send preliminary product cards immediately (before LLM)
    // User sees cards right away while AI generates the analysis text.
    if (docs.length && isSearch) {
      const preliminary = docs.map(p => ({
        id: p.id, title: p.title, price: p.price, rating: p.rating,
        sold: p.sold_count, source: p.source, link: p.link,
        affiliate_link: p.affiliate_link, image: p.image_url,
        is_deal: p._is_deal || false,
      }));
      send(res, { type: 'products', data: preliminary, preliminary: true });
    }

    // ── 6. Stream LLM answer ────────────────────────────────
    // ── 6. Stream LLM tokens directly to client as vLLM generates ──
    // Tokens arrive in real-time via /chat/stream — no waiting for full response.
    // We buffer the full answer simultaneously for PILIHAN parsing + caching.
    const messages = rag.buildMessages(q, context, {
      intent,
      history: isSearch ? [] : (Array.isArray(history) ? history : []),
    });
    let fullAnswer = '';
    // URL-stripping state: hold back tokens that might be start of a URL
    let urlBuf = '';

    function flushToken(chunk) {
      if (!chunk || ac.signal.aborted || res.writableEnded) return;
      send(res, { type: 'token', content: chunk });
    }

    function onToken(chunk) {
      // Buffer to strip bare finding.id/go/NNN URLs before they reach the client
      urlBuf += chunk;
      // Flush everything up to the last newline; hold the rest (might be a URL line)
      const lastNl = urlBuf.lastIndexOf('\n');
      if (lastNl === -1) return; // no newline yet — keep buffering
      const safe = urlBuf.slice(0, lastNl + 1);
      urlBuf = urlBuf.slice(lastNl + 1);
      const cleaned = safe.replace(/[ \t]*https?:\/\/finding\.id\/go\/\d+[ \t]*\n?/g, '');
      if (cleaned) flushToken(cleaned);
    }

    try {
      fullAnswer = await vllm.generateStream(messages, onToken, ac.signal);
    } catch (llmErr) {
      if (llmErr.name === 'CanceledError' || llmErr.name === 'AbortError') return res.end();
      fullAnswer = docs.length
        ? `Ditemukan ${docs.length} produk relevan. Layanan AI sedang sibuk, silakan coba lagi.`
        : 'Produk tidak ditemukan. Kami sedang mengumpulkan data baru.';
      flushToken(fullAnswer);
    }

    // Flush remaining buffer (last line with no trailing newline)
    if (urlBuf) {
      const cleaned = urlBuf.replace(/[ \t]*https?:\/\/finding\.id\/go\/\d+[ \t]*/g, '');
      if (cleaned) flushToken(cleaned);
    }

    // Strip any bare finding.id URLs the LLM may have output
    fullAnswer = fullAnswer.replace(/[ \t]*\n?[ \t]*https?:\/\/finding\.id\/go\/\d+[ \t]*/gm, '');

    // ── Parse PILIHAN:[...] from LLM output & send product cards ──
    let chosenIds = [];
    const pilihanMatch = fullAnswer.match(/PILIHAN:\s*\[?([\d,\s]+)\]?/);
    console.log(`[search] LLM output (${fullAnswer.length} chars): ...${fullAnswer.slice(-120)}`);
    console.log(`[search] PILIHAN match: ${pilihanMatch ? pilihanMatch[0] : 'NONE'}`);
    if (pilihanMatch) {
      chosenIds = pilihanMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
      fullAnswer = fullAnswer.replace(/\n?PILIHAN:\s*\[?[\d,\s]+\]?\n?/g, '').trimEnd();
    }

    // ── Inject <a href> links (script, not LLM) ──────────────────────────────
    const docMap = Object.fromEntries(docs.map(p => [p.id, p]));
    if (chosenIds.length) {
      // 1. Numbered items: "1. ProductName..." → link using PILIHAN order
      fullAnswer = fullAnswer.replace(/^(\d+)\.\s+(.+)$/gm, (_, num, rest) => {
        const idx = parseInt(num, 10) - 1;
        const p   = docMap[chosenIds[idx]];
        if (!p) return `${num}. ${rest}`;
        return `${num}. <a href="https://finding.id/go/${p.id}" target="_blank" rel="noopener noreferrer" style="color:var(--orange)">${p.title}</a>`;
      });
      // 2. {{ID}} or {{name:ID}} tokens anywhere in text (comparison sentences, etc.)
      fullAnswer = fullAnswer.replace(/\{\{(?:[^}:]*:)?(\d+)\}\}/g, (_, id) => {
        const p = docMap[parseInt(id, 10)];
        if (!p) return '';
        return `<a href="https://finding.id/go/${p.id}" target="_blank" rel="noopener noreferrer" style="color:var(--orange)">${p.title}</a>`;
      });
    }

    // Send replace so PILIHAN removal + links are applied to what's already streamed
    send(res, { type: 'replace', content: fullAnswer });

    // Only show cards if LLM explicitly chose products (PILIHAN marker present).
    // If LLM said "no products found", it won't write PILIHAN → no cards shown.
    // Fall back to top docs only for chat intent (follow-up questions).
    let sentCards = [];
    if (docs.length && chosenIds.length) {
      const docMap    = Object.fromEntries(docs.map(p => [p.id, p]));
      const chosenSet = new Set(chosenIds);

      // LLM-chosen products first, then all remaining docs
      const allCards = [
        ...chosenIds.map(id => docMap[id]).filter(Boolean),
        ...docs.filter(p => !chosenSet.has(p.id)),
      ].slice(0, isSearch ? 19 : 1);

      sentCards = allCards.map((p, i) => ({
        id:            p.id,
        title:         p.title,
        price:         p.price,
        rating:        p.rating,
        sold:          p.sold_count,
        source:        p.source,
        link:          p.link,
        affiliate_link: p.affiliate_link || null,
        image:         p.image_url,
        is_deal:       p._is_deal || false,
        is_chosen:     chosenSet.has(p.id),
        chosen_rank:   chosenSet.has(p.id) ? chosenIds.indexOf(p.id) + 1 : null,
      }));
      send(res, { type: 'products', data: sentCards });
    }

    // ── 7. Done ─────────────────────────────────────────────
    const duration = Date.now() - t0;
    send(res, { type: 'done', sources: docs.length, duration, jobId, intent, scraping: isSearch });
    res.write('data: [DONE]\n\n');

    // ── 8. Cache result (non-blocking) ──────────────────────
    // Cache all sent cards (up to 19) including is_chosen/chosen_rank flags
    if (fullAnswer && sentCards.length) {
      cache.set(cacheKey, {
        text:     fullAnswer,
        products: sentCards,
        sources:  docs.length,
      }).catch(() => {});
    }

  } catch (err) {
    console.error('[search] error:', err.message);
    if (!res.writableEnded) {
      send(res, { type: 'error', message: 'Terjadi kesalahan server. Silakan coba lagi.' });
      res.write('data: [DONE]\n\n');
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
