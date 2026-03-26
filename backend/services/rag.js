'use strict';
const axios  = require('axios');
const db     = require('./db');
const cache  = require('./cache');
const cfg    = require('../config/config');
const { v4: uuidv4 } = require('uuid');
const notifier = require('./notifier');

// ================================================================
// RAG Pipeline — integrates with existing aimin RAG service
//
// Existing infra (at /data/www/aimin/rag-service):
//   POST 127.0.0.1:8002/products/query
//     body: { folder, query, top_k }
//     resp: { products: [{ product_name, product_category, score }], has_index }
//
//   POST 127.0.0.1:8002/products/index
//     body: { folder, products: [{ id, name, category, price, description, specs }] }
//
// Flow:
//   1. Call RAG service → get top-k product_name + product_category
//   2. Hydrate from MySQL using name+category lookup
//   3. Score < threshold → trigger scraping job
//   4. Return { docs, context, needsScraping, bestScore }
//
// Scoring thresholds (same as aimin vector_store.py):
//   score_threshold: 0.30 (set in RAG service)
//   GOOD:  >= 0.70 → confident match
//   WEAK:  < 0.50  → trigger background scraping
// ================================================================

const SCORE_GOOD  = 0.70;
const SCORE_WEAK  = 0.60;  // below this: skip Qdrant title-match, use FULLTEXT only

// ── Category matching helpers ─────────────────────────────────────────────────
// Shopee uses short names ("Handphone"), Tokopedia uses full paths
// ("handphone-tablet/handphone/ios"). Match both by checking exact name OR
// whether the path contains the slug as a full segment (/slug/ or ending /slug).
function _catSlug(name) { return name.toLowerCase().replace(/\s+/g, '-'); }

function _buildCatSQL(cats, negate = false) {
  if (!cats.length) return { sql: '', params: [] };
  const params = [];
  const perCat = cats.map(cat => {
    const slug = _catSlug(cat);
    params.push(cat, slug, slug);
    return `(category = ? OR LOWER(category) LIKE '%/' || ? || '/%' OR LOWER(category) LIKE '%/' || ?)`;
  });
  const joined = perCat.join(' OR ');
  return negate
    ? { sql: `AND (category IS NULL OR NOT (${joined}))`, params }
    : { sql: `AND (${joined})`, params };
}

function _buildCatOrderSQL(cats) {
  if (!cats.length) return { sql: '', params: [] };
  const params = [];
  const perCat = cats.map(cat => {
    const slug = _catSlug(cat);
    params.push(cat, slug, slug);
    return `(category = ? OR LOWER(category) LIKE '%/' || ? || '/%' OR LOWER(category) LIKE '%/' || ?)`;
  });
  return { sql: `CASE WHEN (${perCat.join(' OR ')}) THEN 0 ELSE 1 END,`, params };
}

function _keywordTokens(query) {
  return [...new Set(
    String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(t => t.replace(/[+\-<>()~*"@]/g, ''))
      .filter(t => t.length >= 2)
  )];
}

function _toBooleanAndQuery(query) {
  const uniq = _keywordTokens(query);
  if (!uniq.length) return String(query || '').trim();
  // For 3+ tokens: only first 2 are mandatory (+), rest are optional (boost only).
  // Prevents zero results when the exact phrase combo has no DB match.
  if (uniq.length >= 3) {
    return uniq.map((t, i) => i < 2 ? `+${t}*` : `${t}*`).join(' ');
  }
  return uniq.map(t => `+${t}*`).join(' ');
}

// Common Indonesian ↔ English / alternate spelling pairs for token matching
const TOKEN_VARIANTS = {
  'lipstik': ['lipstick', 'lip stick'],
  'lipstick': ['lipstik'],
  'handphone': ['smartphone', 'hp'],
  'hp': ['handphone', 'smartphone'],
  'earphone': ['headphone', 'headset', 'earbud'],
  'headphone': ['earphone', 'headset'],
  'powerbank': ['power bank'],
  'kacamata': ['glasses', 'spectacle'],
  'skincare': ['skin care'],
  'moisturizer': ['moisturiser', 'pelembab'],
};

function _containsAllTokens(row, tokens) {
  if (!tokens.length) return true;
  const hay = `${row?.title || ''} ${row?.description || ''}`.toLowerCase();
  const matchCount = tokens.filter(t => {
    if (hay.includes(t)) return true;
    const alts = TOKEN_VARIANTS[t] || [];
    return alts.some(alt => hay.includes(alt));
  }).length;
  // 1-2 tokens: require all (brand protection e.g. "printer epson")
  // 3+ tokens: require 60% — prevents dropping semantically relevant
  // products just because they use different word forms
  const required = tokens.length <= 2
    ? tokens.length
    : Math.ceil(tokens.length * 0.6);
  return matchCount >= required;
}

const ragHttp = axios.create({
  baseURL: cfg.RAG.URL,
  timeout: 120000, // 2 min — batch embedding 500 products on CPU needs time
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Run RAG retrieval for a user query.
 *
 * @param {string} query   Natural language query
 * @param {object} [opts]
 * @param {object} [opts.price]  { min, max, target } price filter in IDR
 * @param {string[]} [opts.preferredCategories]
 * @param {string[]} [opts.excludedCategories]
 */
async function retrieve(query, opts = {}) {
  const priceFilter = opts.price || null;
  const preferredCategories = Array.isArray(opts.preferredCategories) ? opts.preferredCategories : [];
  const excludedCategories  = Array.isArray(opts.excludedCategories)  ? opts.excludedCategories  : [];
  const keywordTokens = _keywordTokens(query);
  const booleanAndQuery = _toBooleanAndQuery(query);
  let ragRes;
  // Fetch more candidates from Qdrant when a price filter is active —
  // a larger pool means the price filter has more to choose from.
  const ragTopK = opts.price ? Math.max(cfg.RAG.TOP_K * 4, 20) : cfg.RAG.TOP_K;
  const debug = opts.debug ? {
    query,
    ragTopK,
    preferredCategories,
    excludedCategories,
    priceFilter,
  } : null;

  try {
    ragRes = await ragHttp.post('/products/query', {
      folder: cfg.RAG.FOLDER,
      query,
      top_k: ragTopK,
    });
  } catch (err) {
    console.error('[rag] query failed:', err.message);
    return { docs: [], context: '', needsScraping: true, bestScore: 0, hasIndex: false, debug };
  }

  const { products: hits = [], has_index: hasIndex = false } = ragRes.data;
  if (debug) {
    debug.qdrant = {
      hasIndex,
      hits: hits.map(h => ({ name: h.product_name, category: h.product_category, score: h.score })),
    };
  }

  if (!hits.length) {
    // Qdrant has no embeddings yet (products just ingested) — fall back to MySQL FULLTEXT
    // so search.js can unblock immediately without waiting for Qdrant indexing to complete.
    try {
      const [ft] = await db.query(
        `SELECT id, title, price, rating, sold_count, source, link, image_url, category,
                affiliate_link, description, specs, reviews_json, variants_json,
                (ai_analysis IS NOT NULL) AS has_ai_page, updated_at
         FROM products
         WHERE is_active = true AND fts @@ websearch_to_tsquery('simple', ?)
         ORDER BY (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
         LIMIT ?`,
        [query, cfg.RAG.TOP_K]
      );
      if (ft.length) {
        const ftFiltered = ft.filter(r => _containsAllTokens(r, keywordTokens));
        console.log(`[rag] Qdrant empty — FULLTEXT fallback returned ${ftFiltered.length}/${ft.length} products after token filter`);
        const docs = ftFiltered.map(r => ({ ...r, _score: 0.3, _match_source: 'fulltext-qdrant-empty' }));
        const context = buildContext(docs, query);
        if (debug) {
          debug.path = 'fulltext-qdrant-empty';
          debug.fulltextFallbackCount = docs.length;
        }
        return { docs, context, needsScraping: docs.length < 3, bestScore: 0.3, hasIndex: false, debug };
      }
    } catch (ftErr) {
      console.error('[rag] FULLTEXT fallback failed:', ftErr.message);
    }
    return { docs: [], context: '', needsScraping: true, bestScore: 0, hasIndex, debug };
  }

  const bestScore = hits[0]?.score ?? 0;

  // Hydrate full product details from MySQL
  // RAG returns product_name + product_category; we look up by both
  let products = [];
  if (hits.length) {
    const conditions = hits.map(() => "(title = ? AND (category = ? OR ? IS NULL OR ? = ''))").join(' OR ');
    const params = hits.flatMap(h => [h.product_name, h.product_category, h.product_category, h.product_category]);

    // Price filter clause — applied when user specifies a budget
    let priceClause = '';
    if (priceFilter?.min !== undefined && priceFilter?.max !== undefined) {
      priceClause = priceFilter.min > 0
        ? `AND price BETWEEN ${Math.round(priceFilter.min)} AND ${Math.round(priceFilter.max)}`
        : `AND price <= ${Math.round(priceFilter.max)}`;
    }

    // Category intent clauses — category should have highest priority.
    // If the caller didn't specify preferred categories, auto-detect from Qdrant hits:
    // if ≥60% of Qdrant hits share the same category, use it as a preferred filter.
    let effectivePreferred = preferredCategories;
    // Auto-detect category from Qdrant hits only when scores are strong (≥0.55).
    // Low scores mean Qdrant returned unrelated products → their categories are noise.
    if (!preferredCategories.length && hits.length && bestScore >= 0.55) {
      const catCount = {};
      for (const h of hits) {
        if (h.product_category) catCount[h.product_category] = (catCount[h.product_category] || 0) + 1;
      }
      const [topCat, topCount] = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0] || [];
      if (topCat && topCount / hits.length >= 0.6) {
        effectivePreferred = [topCat];
        console.log(`[rag] auto-category from Qdrant: "${topCat}" (${topCount}/${hits.length} hits, score=${bestScore.toFixed(2)})`);
      }
    }

    if (debug) debug.effectivePreferred = effectivePreferred;

    // Pre-compute before hydration — also gates the no-price fallback below.
    // Category-only query: every token is just the category name itself
    // (e.g. "handphone", "laptop"). The category SQL filter handles relevance;
    // the no-price fallback must NOT fire or it returns 400K phones for 5M searches.
    const isCategoryOnlyQuery = effectivePreferred.length > 0 &&
      keywordTokens.every(t => effectivePreferred.some(cat => cat.toLowerCase().includes(t)));
    if (debug) debug.isCategoryOnlyQuery = isCategoryOnlyQuery;

    const _pref    = _buildCatSQL(effectivePreferred);
    const _excl    = _buildCatSQL(excludedCategories, true);
    const _prefOrd = _buildCatOrderSQL(effectivePreferred);
    const preferredClause  = _pref.sql;
    const excludedClause   = _excl.sql;
    const categoryParams   = [..._pref.params, ..._excl.params];

    // ── Step 1: Title-match hydration (exact match on Qdrant product names) ──
    // Skip when bestScore < SCORE_WEAK: low scores mean Qdrant is guessing unrelated products.
    // Directly using those would put wrong products in LLM context.
    // FULLTEXT supplement (Step 2) will recover from FULLTEXT index which has lexical relevance.
    let rows2 = [];
    const trustQdrant = bestScore >= SCORE_WEAK;
    if (debug) debug.trustQdrant = trustQdrant;
    if (!trustQdrant) {
      console.log(`[rag] low Qdrant score (${bestScore.toFixed(2)}) — skipping title-match, using FULLTEXT only`);
    }
    try {
      if (!trustQdrant) throw new Error('skip'); // jump to FULLTEXT
      const [rows] = await db.query(
        `SELECT id, title, price, rating, sold_count, source, link, image_url, category,
                affiliate_link, description, specs, reviews_json, variants_json,
                (ai_analysis IS NOT NULL) AS has_ai_page, updated_at
         FROM products
         WHERE (${conditions}) AND is_active = true ${priceClause} ${preferredClause} ${excludedClause}
         ORDER BY
           ${_prefOrd.sql}
           COALESCE(sold_count, 0) DESC, rating DESC
         LIMIT ?`,
        [
          ...params,
          ...categoryParams,
          ..._prefOrd.params,
          cfg.RAG.TOP_K,
        ]
      );
      rows2 = rows.map(r => ({ ...r, _match_source: 'qdrant-hydrate' }));

      // Fallback 1: price filter yielded 0 — retry without price, sort by closeness to target.
      // Skip for category-only queries (e.g. "handphone 5 jutaan"): those phones at 400K
      // are wrong results — FULLTEXT + category-direct steps below will find the right ones.
      if (!rows2.length && priceClause && !isCategoryOnlyQuery) {
        console.log('[rag] price filter yielded 0 results, falling back without price constraint');

        const fbPref    = _buildCatSQL(effectivePreferred);
        const fbExcl    = _buildCatSQL(excludedCategories, true);
        const fbPrefOrd = _buildCatOrderSQL(effectivePreferred);

        const [fb] = await db.query(
          `SELECT id, title, price, rating, sold_count, source, link, image_url, category,
                  affiliate_link, description, specs, reviews_json, variants_json,
                  (ai_analysis IS NOT NULL) AS has_ai_page
           FROM products
           WHERE (${conditions}) AND is_active = true ${fbPref.sql} ${fbExcl.sql}
           ORDER BY
             ${fbPrefOrd.sql}
             COALESCE(sold_count, 0) DESC, ABS(price - ?) ASC, rating DESC
           LIMIT ?`,
          [
            ...params,
            ...fbPref.params,
            ...fbExcl.params,
            ...fbPrefOrd.params,
            Math.round(priceFilter.target),
            cfg.RAG.TOP_K,
          ]
        );
        rows2 = fb.map(r => ({ ...r, _match_source: 'qdrant-hydrate-fallback-no-price' }));
      }
    } catch (dbErr) {
      console.error('[rag] title-match hydration failed:', dbErr.message);
      // rows2 stays [] → FULLTEXT supplement below will recover
    }

    // Apply all-token AND guard to Qdrant-hydrated results.
    // Prevents brand confusion: "printer epson" should not return Canon printers.
    // Category-only queries (isCategoryOnlyQuery, pre-computed above) are exempt:
    // "Samsung Galaxy A36" is a handphone but doesn't say "handphone" in its title —
    // the category SQL filter already guarantees relevance.
    const beforeQdrantFilter = rows2.length;
    if (!isCategoryOnlyQuery) {
      rows2 = rows2.filter(r => _containsAllTokens(r, keywordTokens));
    }
    const qdrantTokenDropped = beforeQdrantFilter - rows2.length;
    if (qdrantTokenDropped > 0) {
      console.log(`[rag] token-filter dropped ${qdrantTokenDropped}/${beforeQdrantFilter} Qdrant-hydrated products`);
    }
    if (debug) debug.tokenFilter = { qdrantDropped: qdrantTokenDropped, tokens: keywordTokens, isCategoryOnlyQuery };

    // ── Step 2: FULLTEXT supplement — runs whenever we have fewer than TOP_K results ──
    // Handles title drift (Qdrant names ≠ MySQL titles) AND price-range sparsity.
    const MIN_DOCS = 3;
    try {
      if (rows2.length < cfg.RAG.TOP_K) {
        const existingIds = new Set(rows2.map(r => r.id));
        const needed = cfg.RAG.TOP_K - rows2.length;

        const ftPref    = _buildCatSQL(effectivePreferred);
        const ftExcl    = _buildCatSQL(excludedCategories, true);
        const ftPrefOrd = _buildCatOrderSQL(effectivePreferred);
        // priceClause already contains inline values — do NOT push extra params for it

        const [ft] = await db.query(
          `SELECT id, title, price, rating, sold_count, source, link, image_url, category,
                  affiliate_link, description, specs, reviews_json, variants_json,
                  (ai_analysis IS NOT NULL) AS has_ai_page
           FROM products
           WHERE is_active = true
             AND price >= 1000
             AND fts @@ websearch_to_tsquery('simple', ?)
             ${ftPref.sql} ${ftExcl.sql}
             ${priceClause}
           ORDER BY
             ${ftPrefOrd.sql}
             (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
           LIMIT ?`,
          [
            query,
            ...ftPref.params,
            ...ftExcl.params,
            ...ftPrefOrd.params,
            needed + MIN_DOCS,
          ]
        );

        // Merge: deduplicate by ID, Qdrant-hydrated results first (higher semantic relevance)
        const ftDeduped = ft.filter(r => !existingIds.has(r.id));
        const extras = ftDeduped
          .filter(r => _containsAllTokens(r, keywordTokens))
          .map(r => ({ ...r, _match_source: 'fulltext-supplement' }));
        const ftTokenDropped = ftDeduped.length - extras.length;
        rows2 = [...rows2, ...extras].slice(0, cfg.RAG.TOP_K);
        if (debug) {
          debug.fulltextSupplemented = extras.length;
          debug.tokenFilter = { ...(debug.tokenFilter || {}), fulltextDropped: ftTokenDropped };
        }
        if (extras.length) console.log(`[rag] FULLTEXT supplemented ${extras.length} extra products (total: ${rows2.length})`);
      }
    } catch (ftErr) {
      console.error('[rag] FULLTEXT supplement failed:', ftErr.message);
    }

    // ── Step 3: Category direct lookup — fills remaining slots up to TOP_K ──
    // FULLTEXT for "+handphone*" misses "Samsung Galaxy" / "Xiaomi Redmi" products
    // because their titles don't contain the word "handphone". If we know the category
    // (effectivePreferred), query directly by category + price instead.
    if (rows2.length < cfg.RAG.TOP_K && effectivePreferred.length) {
      try {
        const existingIds3 = new Set(rows2.map(r => r.id));
        const catPref    = _buildCatSQL(effectivePreferred);
        const catExcl    = _buildCatSQL(excludedCategories, true);
        const catPrefOrd = _buildCatOrderSQL(effectivePreferred);
        const [catRows] = await db.query(
          `SELECT id, title, price, rating, sold_count, source, link, image_url, category,
                  affiliate_link, description, specs, reviews_json, variants_json,
                  (ai_analysis IS NOT NULL) AS has_ai_page
           FROM products
           WHERE is_active = true AND price >= 1000 ${catPref.sql} ${catExcl.sql} ${priceClause}
           ORDER BY ${catPrefOrd.sql} (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
           LIMIT ?`,
          [...catPref.params, ...catExcl.params, ...catPrefOrd.params, cfg.RAG.TOP_K]
        );
        // Apply token filter: category-direct is category+price only, no lexical match.
        // Without this, a miscategorized product (e.g. piano in "Aksesoris Komputer")
        // can appear for completely unrelated queries like "headset gaming".
        // isCategoryOnlyQuery exemption: queries like "handphone" where every token
        // IS the category name — the category filter is the only relevant signal.
        const catExtras = catRows
          .filter(r => !existingIds3.has(r.id))
          .filter(r => isCategoryOnlyQuery || _containsAllTokens(r, keywordTokens))
          .map(r => ({ ...r, _match_source: 'category-direct' }));
        if (catExtras.length) {
          rows2 = [...rows2, ...catExtras].slice(0, cfg.RAG.TOP_K);
          console.log(`[rag] category-direct supplement added ${catExtras.length} products (total: ${rows2.length})`);
          if (debug) debug.categoryDirectCount = catExtras.length;
        }
      } catch (catErr) {
        console.error('[rag] category-direct fallback failed:', catErr.message);
      }
    }

    // Enrich with score from RAG, then re-sort by semantic relevance + freshness
    const scoreMap = Object.fromEntries(hits.map(h => [h.product_name, h.score]));
    const now = Date.now();
    products = rows2
      .map(r => {
        const base = scoreMap[r.title] ?? 0;
        const ageMs = r.updated_at ? (now - new Date(r.updated_at).getTime()) : Infinity;
        const ageH  = ageMs / 3_600_000;
        // +0.05 if updated within 24h, −0.05 if stale > 7 days
        const freshBoost = ageH < 24 ? 0.05 : ageH > 168 ? -0.05 : 0;
        return { ...r, _score: base + freshBoost };
      })
      .sort((a, b) => b._score - a._score);

    if (debug) {
      debug.hydratedCount = rows2.length;
      debug.finalCount = products.length;
    }

    // ── Deal detection: flag products priced ≥15% below their 30-day average ──
    try {
      const ids = products.map(p => p.id).filter(Boolean);
      if (ids.length) {
        const [dealRows] = await db.query(
          `SELECT product_id, AVG(price) AS avg_price
           FROM price_history
           WHERE product_id = ANY(?)
             AND captured_at > NOW() - INTERVAL '30 days'
             AND variant_name IS NULL
           GROUP BY product_id
           HAVING COUNT(*) >= 1`,
          [ids]
        );
        const dealMap = Object.fromEntries(dealRows.map(r => [r.product_id, parseFloat(r.avg_price)]));
        products = products.map(p => {
          const avg = dealMap[p.id];
          const cur = parseFloat(p.price) || 0;
          return { ...p, _is_deal: avg && cur > 0 && cur <= avg * 0.85 };
        });
      }
    } catch (_) {}
  }

  const context       = buildContext(products, query);
  const needsScraping = bestScore < SCORE_WEAK || products.length < 3;

  return { docs: products, context, needsScraping, bestScore, hasIndex, debug };
}

/**
 * Format products as LLM context string.
 */
function buildContext(products, query) {
  if (!products.length) {
    return `Tidak ada produk relevan ditemukan untuk: "${query}".`;
  }

  const lines = products.map((p, i) => {
    const price  = p.price      ? `Rp ${Number(p.price).toLocaleString('id-ID')}` : 'harga tidak tersedia';
    const rating = p.rating     ? `${p.rating}/5` : '-';
    const sold   = p.sold_count ? `${Number(p.sold_count).toLocaleString()} terjual` : '';
    const parts  = [
      `[${i + 1}] ${p.title || 'Produk'}`,
      `    Harga: ${price} | Rating: ${rating} ${sold}`.trimEnd(),
      `    Sumber: ${p.source || '-'}`,
    ];
    if (p.specs)       parts.push(`    Spek: ${String(p.specs).slice(0, 300)}`);
    if (p.description) parts.push(`    Deskripsi: ${String(p.description).slice(0, 200)}`);

    try {
      const rv = p.reviews_json
        ? (typeof p.reviews_json === 'string' ? JSON.parse(p.reviews_json) : p.reviews_json)
        : null;
      if (rv?.positive?.[0]) parts.push(`    Ulasan (+): "${rv.positive[0].text.slice(0, 150)}" — ${rv.positive[0].star}⭐`);
      if (rv?.negative?.[0]) parts.push(`    Ulasan (-): "${rv.negative[0].text.slice(0, 150)}" — ${rv.negative[0].star}⭐`);
    } catch (_) {}

    // PILIHAN marker for card selection
    parts.push(`    [ref:${p.id}]`);

    return parts.join('\n');
  });

  return `Data produk dari database:\n\n${lines.join('\n\n')}`;
}

/**
 * Build vLLM message array.
 * @param {string}   query
 * @param {string}   context
 * @param {object}   opts
 * @param {string}   opts.intent   'search' | 'chat'
 * @param {object[]} opts.history  [{role:'user'|'assistant', content:string}]
 */
function buildMessages(query, context, opts = {}) {
  const { intent = 'search', history = [] } = opts;

  // Format conversation history (last N pairs) into prompt
  let historyStr = '';
  if (history.length) {
    const lines = history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6) // max 3 exchanges
      .map(m => `${m.role === 'user' ? 'User' : 'Asisten'}: ${m.content.slice(0, 400)}`);
    if (lines.length) historyStr = `[Riwayat percakapan]\n${lines.join('\n')}\n\n`;
  }

  // For chat (follow-up), tell the AI not to re-list products
  const chatNote = intent === 'chat'
    ? '\nPENTING: Ini pertanyaan lanjutan. JANGAN ulangi list produk. Jawab langsung dan ringkas berdasarkan riwayat di atas.\n'
    : '\n\nWAJIB: Setelah merekomendasikan produk, SELALU akhiri responsmu dengan satu baris ini persis — gunakan angka dari marker [ref:xxx] di data produk di atas:\nPILIHAN:xxx,yyy,zzz\nContoh (jika ref produk pilihanmu adalah 42, 17, 95): PILIHAN:42,17,95\nJangan lewatkan baris PILIHAN. Ini wajib.\nPENTING: Jangan tampilkan ref/ID angka di teks rekomendasi — hanya boleh di baris PILIHAN.';

  return [
    { role: 'system', content: cfg.SYSTEM_PROMPT + chatNote },
    {
      role: 'user',
      content: `${historyStr}Konteks:\n${context}\n\n---\nPertanyaan: ${query}`,
    },
  ];
}

/**
 * Index a batch of products into RAG service.
 * Called after ingestion pipeline stores data in MySQL.
 *
 * @param {object[]} products  Array of product rows from MySQL
 */
async function indexProducts(products) {
  const payload = (products || []).map(p => ({
    id:          p.id,
    name:        p.title,
    category:    p.category || '',
    price:       p.price    || null,
    description: p.description || null,
    specs:       null,
  }));

  await ragHttp.post('/products/index', {
    folder:   cfg.RAG.FOLDER,
    products: payload,
  });

  // Mark as indexed so indexPendingProducts() won't re-process them
  const ids = products.map(p => p.id).filter(Boolean);
  if (ids.length) {
    await db.query(
      `UPDATE products SET indexed_at = NOW() WHERE id = ANY(?)`,
      [ids]
    ).catch(e => console.error('[rag] indexed_at update failed:', e.message));
  }
}

/**
 * Index only products not yet in Qdrant (indexed_at IS NULL).
 * Called automatically after each scrape cycle completes.
 * Processes up to 500 at a time to stay within RAG service limits.
 */
async function indexPendingProducts() {
  const [rows] = await db.query(
    `SELECT id, title, price, category, description
     FROM products
     WHERE is_active = true AND indexed_at IS NULL
     ORDER BY id ASC
     LIMIT 500`
  );

  if (!rows.length) return { indexed: 0 };

  await indexProducts(rows);  // also sets indexed_at

  console.log(`[rag] indexPendingProducts: indexed ${rows.length} new products`);
  return { indexed: rows.length };
}

/**
 * Rebuild the entire product RAG index from current MySQL truth.
 * Uses /products/reindex which clears Qdrant first then re-inserts all.
 * Processes in batches of 500 to avoid memory issues.
 */
async function reindexAllProducts() {
  const [rows] = await db.query(
    `SELECT id, title, price, category, description
     FROM products
     WHERE is_active = true
     ORDER BY id ASC`
  );

  if (!rows.length) return { indexed: 0 };

  const payload = rows.map(p => ({
    id:          p.id,
    name:        p.title,
    category:    p.category || '',
    price:       p.price    || null,
    description: p.description || null,
    specs:       null,
  }));

  // First batch uses /products/reindex (clears old vectors + inserts)
  const BATCH = 500;
  await ragHttp.post('/products/reindex', {
    folder:   cfg.RAG.FOLDER,
    products: payload.slice(0, BATCH),
  });

  // Remaining batches use /products/index (incremental upsert, no delete)
  for (let i = BATCH; i < payload.length; i += BATCH) {
    await ragHttp.post('/products/index', {
      folder:   cfg.RAG.FOLDER,
      products: payload.slice(i, i + BATCH),
    });
    console.log(`[rag] reindexAllProducts: batch ${Math.ceil(i/BATCH)+1}/${Math.ceil(payload.length/BATCH)} (${i+BATCH}/${payload.length})`);
  }

  await db.query(
    `UPDATE products SET indexed_at = NOW() WHERE is_active = true`
  );

  return { indexed: rows.length };
}

/**
 * Create a scraping job in MySQL + Redis job queue.
 * Chrome extension agents poll GET /api/jobs to pick these up.
 */
async function createScrapingJob(query, sources, { priority = 1 } = {}) {
  const jobId  = uuidv4();
  const srcArr = sources || ['shopee', 'tokopedia'];

  try {
    await db.query(
      `INSERT INTO search_jobs (id, query, sources, status, priority, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, NOW(), NOW() + (? * INTERVAL '1 second'))`,
      [jobId, query, JSON.stringify(srcArr), priority, cfg.JOBS.TTL_SECONDS]
    );
  } catch (err) {
    console.error('[rag] createScrapingJob DB error:', err.message);
  }

  // Push to Redis list for fast extension polling
  try {
    await cache.getClient().lpush('jobs:pending', jobId);
    await cache.set(`job:${jobId}`, {
      id: jobId, query, sources: srcArr, status: 'pending', created: Date.now(),
    }, cfg.JOBS.TTL_SECONDS);
  } catch {}

  // Push to connected extension SSE streams immediately (priority jobs only)
  if (priority >= 1) {
    notifier.emit('job:priority', { id: jobId, type: 'list', query, sources: srcArr, priority });
  }

  return jobId;
}

/**
 * Delete the Qdrant vector for a single product by name.
 * Fast — no embedding needed, just a filter-delete.
 */
async function deleteProductVector(title) {
  await ragHttp.delete('/products/one', {
    data: { folder: cfg.RAG.FOLDER, product_name: title },
  });
}

module.exports = {
  retrieve,
  buildMessages,
  buildContext,
  indexProducts,
  indexPendingProducts,
  reindexAllProducts,
  deleteProductVector,
  createScrapingJob,
  SCORE_GOOD,
  SCORE_WEAK,
};
