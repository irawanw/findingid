'use strict';
const express   = require('express');
const router    = express.Router();
const crypto    = require('crypto');
const db        = require('../services/db');
const rag       = require('../services/rag');
const cfg       = require('../config/config');
const affiliate = require('../services/affiliate');
const { normalizeQueryFull, normalizeQuery } = require('../services/queryNormalizer');
const vllm  = require('../services/vllm');
const cache = require('../services/cache');

const ADMIN_COOKIE_NAME = 'fid_admin_session';
const ADMIN_SESSION_TTL_SECONDS = Math.max(parseInt(process.env.ADMIN_SESSION_TTL_SECONDS || '43200', 10) || 43200, 600);
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || process.env.INGEST_API_KEY || '');

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function signAdminSession(payloadBase64) {
  return crypto
    .createHmac('sha256', process.env.INGEST_API_KEY || 'dev-only-insecure-key')
    .update(payloadBase64)
    .digest('hex');
}

function createAdminSession(username) {
  const payload = {
    u: username,
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS,
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = signAdminSession(payloadBase64);
  return `${payloadBase64}.${sig}`;
}

function readAdminSession(req) {
  const token = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!token || !token.includes('.')) return null;

  const [payloadBase64, sig] = token.split('.');
  if (!payloadBase64 || !sig) return null;

  const expected = signAdminSession(payloadBase64);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.u) return null;
    return payload;
  } catch {
    return null;
  }
}

function setAdminSessionCookie(res, token) {
  const isSecure = cfg.IS_PROD;
  const attrs = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  ];
  if (isSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearAdminSessionCookie(res) {
  const isSecure = cfg.IS_PROD;
  const attrs = [
    `${ADMIN_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}


// GET /api/products?query=...&limit=7&source=shopee&offset=0
// GET /api/products?ids=1,2,3  — fetch specific products by ID (used by frontend polling)
// Called by frontend polling after scraping job is dispatched.
// Returns freshly ingested products matching the query.
router.get('/', async (req, res) => {
  const query  = String(req.query.query || '').trim().slice(0, 200);
  const limit  = Math.min(parseInt(req.query.limit) || 7, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const source = req.query.source || null;
  const sort   = req.query.sort || '';
  const idsRaw = req.query.ids || '';

  try {
    let rows;

    // Fetch by specific IDs (polling affiliate link readiness for known products)
    if (idsRaw) {
      const ids = idsRaw.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0).slice(0, 20);
      if (!ids.length) return res.json({ ok: true, products: [], count: 0 });
      const placeholders = ids.map(() => '?').join(',');
      [rows] = await db.query(
        `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                category, specs, reviews_json
         FROM products
         WHERE id IN (${placeholders}) AND is_active = true`,
        ids
      );
      return res.json({ ok: true, products: rows, count: rows.length });
    }

    if (query) {
      // Normalize query: strip price phrase, extract price + category filters (with LLM fallback)
      const { query: cleanQuery, price, preferredCategories, excludedCategories } = await normalizeQueryFull(query, {
        llmComplete: vllm.complete.bind(vllm),
        cache,
      });
      const searchTerm = cleanQuery || query;

      // Split into long words (≥3 chars, usable by MySQL FULLTEXT) and short words
      // (e.g. brand names like "LG", "HP", "AC" that FULLTEXT silently ignores)
      const allWords   = searchTerm.split(/\s+/).filter(Boolean);
      const words      = allWords.filter(w => w.length >= 3);
      const shortWords = allWords.filter(w => w.length > 0 && w.length < 3);

      // Indonesian ↔ English alternate spellings — expand FULLTEXT and title anchors
      const WORD_VARIANTS = {
        'lipstik': 'lipstick', 'lipstick': 'lipstik',
        'earphone': 'headphone', 'headphone': 'earphone',
        'skincare': 'skin care', 'powerbank': 'power bank',
      };
      // Expand words list with variants for title anchor (LIKE) check
      const anchorWords = [...new Set([
        ...words,
        ...words.map(w => WORD_VARIANTS[w.toLowerCase()]).filter(Boolean),
      ])];

      // Two-pass search strategy:
      //   Pass 1: require ALL long words (+w1 +w2 +w3) — prevents wrong-brand matches
      //   Pass 2: for 3+ word queries only require first word; for 2-word require first word only
      const strictTerm  = words.map(w => `+${w}`).join(' ') || searchTerm;
      const relaxedTerm = words.length > 1
        ? words.map((w, i) => {
            const mandatory = words.length >= 3 ? i < 1 : i < Math.ceil(words.length / 2);
            return mandatory ? `+${w}` : w;
          }).join(' ')
        : strictTerm;

      const buildQuery = (ftTerm) => {
        const wc = [
          'is_active = true',
          'fts @@ websearch_to_tsquery(\'simple\', ?)',
        ];
        const p = [ftTerm];

        // Short-word filter: MySQL FULLTEXT skips tokens < 3 chars (e.g. "LG").
        // Enforce them via LIKE on title so brand names aren't silently dropped.
        for (const sw of shortWords) {
          wc.push('LOWER(title) LIKE ?');
          p.push(`%${sw.toLowerCase()}%`);
        }

        // Require at least one word (including variants) to appear in the TITLE.
        // Prevents items where the word only appears in their description
        // (e.g. food described as "simpan di kulkas") from polluting results.
        if (anchorWords.length) {
          const anchors = anchorWords.map(() => 'LOWER(title) LIKE ?').join(' OR ');
          wc.push(`(${anchors})`);
          p.push(...anchorWords.map(w => `%${w.toLowerCase()}%`));
        }

        if (source) { wc.push('source = ?'); p.push(source); }
        if (price)  { wc.push('price BETWEEN ? AND ?'); p.push(price.min, price.max); }
        if (preferredCategories?.length) {
          // Match both Shopee short names ("Handphone") and Tokopedia full paths
          // ("handphone-tablet/handphone/ios") via slug-based LIKE patterns.
          const perCat = preferredCategories.map(cat => {
            const slug = cat.toLowerCase().replace(/\s+/g, '-');
            p.push(cat, slug, slug);
            return `(category = ? OR LOWER(category) LIKE '%/' || ? || '/%' OR LOWER(category) LIKE '%/' || ?)`;
          });
          wc.push(`(${perCat.join(' OR ')})`);
        } else if (excludedCategories?.length) {
          const perCat = excludedCategories.map(cat => {
            const slug = cat.toLowerCase().replace(/\s+/g, '-');
            p.push(cat, slug, slug);
            return `(category = ? OR LOWER(category) LIKE '%/' || ? || '/%' OR LOWER(category) LIKE '%/' || ?)`;
          });
          wc.push(`(category IS NULL OR NOT (${perCat.join(' OR ')}))`);
        }
        return { wc, p };
      };

      const sql = `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                          category, specs, reviews_json
                   FROM products
                   WHERE {WHERE}
                   ORDER BY (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
                   LIMIT ? OFFSET ?`;

      // Pass 1: strict (all required)
      const { wc: wc1, p: p1 } = buildQuery(strictTerm);
      [rows] = await db.query(sql.replace('{WHERE}', wc1.join(' AND ')), [...p1, limit, offset]);

      // Pass 2: relaxed (first half required) — only if strict found nothing and not paginating
      if (!rows.length && offset === 0 && strictTerm !== relaxedTerm) {
        const { wc: wc2, p: p2 } = buildQuery(relaxedTerm);
        [rows] = await db.query(sql.replace('{WHERE}', wc2.join(' AND ')), [...p2, limit, offset]);
      }

      // Category-direct fallback — when FULLTEXT can't find enough results but
      // we know the category (e.g. "smartphone 6 juta" → Handphone + price).
      // Most phones don't say "smartphone" in their title so FULLTEXT misses them.
      // Uses the same offset so "load more" pagination works correctly.
      if (rows.length < limit && preferredCategories?.length) {
        const catWhere = [];
        const catParams = [];
        catWhere.push('is_active = true', 'price >= 50000');
        const perCat = preferredCategories.map(cat => {
          const slug = cat.toLowerCase().replace(/\s+/g, '-');
          catParams.push(cat, slug, slug);
          return `(category = ? OR LOWER(category) LIKE '%/' || ? || '/%' OR LOWER(category) LIKE '%/' || ?)`;
        });
        catWhere.push(`(${perCat.join(' OR ')})`);
        if (price) { catWhere.push('price BETWEEN ? AND ?'); catParams.push(price.min, price.max); }
        if (source) { catWhere.push('source = ?'); catParams.push(source); }
        const existingIds = new Set(rows.map(r => r.id));
        const [catRows] = await db.query(
          `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                  category, specs, reviews_json
           FROM products
           WHERE ${catWhere.join(' AND ')}
           ORDER BY (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC
           LIMIT ? OFFSET ?`,
          [...catParams, limit, offset]
        );
        const extras = catRows.filter(r => !existingIds.has(r.id));
        rows = [...rows, ...extras].slice(0, limit);
      }

      // If still nothing, return empty so the frontend shows the "belum tersedia" message.
    } else if (sort === 'category-top') {
      // Top 3 sold per category, globally sorted by sold_count, capped at limit
      [rows] = await db.query(
        `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                category, specs, reviews_json
         FROM (
           SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                  category, specs, reviews_json,
                  ROW_NUMBER() OVER (PARTITION BY category ORDER BY sold_count DESC) AS rn
           FROM products
           WHERE is_active = true
             AND sold_count > 0
             AND price >= 50000
             AND category IS NOT NULL AND category != ''
         ) ranked
         WHERE rn <= 3
         ORDER BY sold_count DESC
         LIMIT ?`,
        [limit]
      );
    } else {
      const orderBy = sort === 'popular'
        ? 'click_count DESC, (rating * 0.6 + LN(1 + COALESCE(sold_count, 0)) * 0.4) DESC'
        : 'updated_at DESC, rating DESC';
      [rows] = await db.query(
        `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url,
                category, specs, reviews_json, click_count
         FROM products
         WHERE is_active = true
         ORDER BY ${orderBy}
         LIMIT ?`,
        [limit]
      );
    }

    res.json({ ok: true, products: rows, count: rows.length });
  } catch (err) {
    console.error('[products]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/products/admin/login
// Body: { username, password }
router.post('/admin/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  const usernameOk = username === ADMIN_USERNAME;
  const passwordOk = ADMIN_PASSWORD && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

  if (!usernameOk || !passwordOk) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  const token = createAdminSession(username);
  setAdminSessionCookie(res, token);

  return res.json({
    ok: true,
    user: { username },
  });
});

// GET /api/products/admin/me
router.get('/admin/me', (req, res) => {
  const session = readAdminSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return res.json({ ok: true, user: { username: session.u } });
});

// POST /api/products/admin/logout
router.post('/admin/logout', (req, res) => {
  clearAdminSessionCookie(res);
  return res.json({ ok: true });
});

// GET /api/products/admin/list
// Admin listing with filters + pagination for backend dashboard.
router.get('/admin/list', adminAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const category = String(req.query.category || '').trim().slice(0, 200);
  const source = String(req.query.source || '').trim().slice(0, 50);
  const includeInactive = String(req.query.include_inactive || '0') === '1';

  const minPrice = req.query.min_price !== undefined && req.query.min_price !== ''
    ? Number(req.query.min_price)
    : null;
  const maxPrice = req.query.max_price !== undefined && req.query.max_price !== ''
    ? Number(req.query.max_price)
    : null;

  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];

  if (!includeInactive) where.push('is_active = true');
  if (q) {
    where.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (source) {
    where.push('source = ?');
    params.push(source);
  }
  if (Number.isFinite(minPrice)) {
    where.push('price >= ?');
    params.push(minPrice);
  }
  if (Number.isFinite(maxPrice)) {
    where.push('price <= ?');
    params.push(maxPrice);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const [rows] = await db.query(
      `SELECT id, title, price, rating, sold_count, source, link, affiliate_link, image_url, category,
              is_active, click_count, updated_at
       FROM products
       ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM products
       ${whereSql}`,
      params
    );

    const [catRows] = await db.query(
      `SELECT category, COUNT(*) AS cnt
       FROM products
       WHERE category IS NOT NULL AND category <> ''
       GROUP BY category
       ORDER BY cnt DESC, category ASC
       LIMIT 300`
    );

    const [srcRows] = await db.query(
      `SELECT source, COUNT(*) AS cnt
       FROM products
       WHERE source IS NOT NULL AND source <> ''
       GROUP BY source
       ORDER BY cnt DESC, source ASC`
    );

    return res.json({
      ok: true,
      page,
      limit,
      total: Number(countRow.total || 0),
      products: rows,
      categories: catRows.map(r => r.category),
      sources: srcRows.map(r => r.source),
    });
  } catch (err) {
    console.error('[products:admin:list]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

function adminAuth(req, res, next) {
  const session = readAdminSession(req);
  if (session) {
    req.adminUser = session.u;
    return next();
  }

  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return next();
}

// DELETE /api/products/admin/bulk
// Body: { ids: number[] }
// Soft-delete many products and automatically rebuild RAG index once.
router.delete('/admin/bulk', adminAuth, async (req, res) => {
  const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [...new Set(idsRaw.map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0))];

  if (!ids.length) {
    return res.status(400).json({ ok: false, error: 'ids[] is required' });
  }
  if (ids.length > 1000) {
    return res.status(400).json({ ok: false, error: 'Max 1000 ids per request' });
  }

  const placeholders = ids.map(() => '?').join(',');

  try {
    const [existingRows] = await db.query(
      `SELECT id, title FROM products WHERE id IN (${placeholders})`,
      ids
    );

    if (!existingRows.length) {
      return res.status(404).json({ ok: false, error: 'No matching products found' });
    }

    await db.query(
      `UPDATE products
       SET is_active = false,
           updated_at = NOW()
       WHERE id IN (${placeholders})`,
      ids
    );

    // Delete individual vectors from Qdrant (no full reindex needed)
    await Promise.allSettled(
      existingRows.map(r => rag.deleteProductVector(r.title))
    );

    return res.json({
      ok: true,
      deleted_count: existingRows.length,
    });
  } catch (err) {
    console.error('[products:bulk-delete]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/products/:id
// Soft-delete product in MySQL and automatically rebuild RAG index.
router.delete('/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid product id' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, title, source
       FROM products
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    await db.query(
      `UPDATE products
       SET is_active = false,
           updated_at = NOW()
       WHERE id = ?`,
      [id]
    );

    await rag.deleteProductVector(rows[0].title).catch(e =>
      console.error('[products:delete] rag vector delete failed:', e.message)
    );

    return res.json({
      ok: true,
      deleted: {
        id,
        title: rows[0].title,
        source: rows[0].source,
      },
    });
  } catch (err) {
    console.error('[products:delete]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products/admin/rag-debug?q=...
// Admin-only retrieval debugger: shows normalization, Qdrant hits, scores, and why each product appears.
router.get('/admin/rag-debug', adminAuth, async (req, res) => {
  const rawQ = String(req.query.q || '').trim().slice(0, 300);
  if (!rawQ) return res.status(400).json({ ok: false, error: 'q is required' });

  try {
    const norm = await normalizeQueryFull(rawQ, {
      llmComplete: vllm.complete.bind(vllm),
      cache,
    });

    const out = await rag.retrieve(norm.query, {
      price: norm.price,
      preferredCategories: norm.preferredCategories,
      excludedCategories: norm.excludedCategories,
      debug: true,
    });

    return res.json({
      ok: true,
      input: rawQ,
      normalized: {
        query: norm.query,
        note: norm.note || null,
        price: norm.price || null,
        preferredCategories: norm.preferredCategories || [],
        excludedCategories: norm.excludedCategories || [],
      },
      retrieval: {
        bestScore: out.bestScore,
        hasIndex: out.hasIndex,
        needsScraping: out.needsScraping,
        debug: out.debug || null,
      },
      products: (out.docs || []).map((p, i) => ({
        rank: i + 1,
        id: p.id,
        title: p.title,
        source: p.source,
        category: p.category,
        price: p.price,
        rating: p.rating,
        sold_count: p.sold_count,
        score: p._score ?? 0,
        match_source: p._match_source || 'unknown',
        why: p._match_source === 'qdrant-hydrate'
          ? 'Exact title/category hydration from Qdrant hit'
          : p._match_source === 'qdrant-hydrate-fallback-no-price'
            ? 'Qdrant hydration fallback (price filter removed)'
            : p._match_source === 'fulltext-supplement'
              ? 'Added by MySQL FULLTEXT supplement'
              : p._match_source === 'fulltext-qdrant-empty'
                ? 'Qdrant had no hits; sourced from FULLTEXT'
                : 'Retrieved by ranking pipeline',
      })),
    });
  } catch (err) {
    console.error('[products:admin:rag-debug]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products/rag-stats
// Returns live Qdrant vector count + MySQL active product count for the admin Reindex page.
router.get('/rag-stats', adminAuth, async (req, res) => {
  try {
    const cfg = require('../config/config');
    const axios = require('axios');

    // MySQL active count
    const [[{ mysqlCount }]] = await db.query(
      `SELECT COUNT(*) AS "mysqlCount" FROM products WHERE is_active = true`
    );

    // PG last indexed count
    const [[{ indexedCount }]] = await db.query(
      `SELECT COUNT(*) AS "indexedCount" FROM products WHERE is_active = true AND indexed_at IS NOT NULL`
    );

    // Qdrant vector count for findingid folder
    let qdrantCount = null;
    try {
      const r = await axios.post(
        `http://localhost:6333/collections/aimin_products/points/count`,
        { filter: { must: [{ key: 'folder', match: { value: cfg.RAG.FOLDER } }] }, exact: true },
        { timeout: 5000 }
      );
      qdrantCount = r.data?.result?.count ?? null;
    } catch (_) {}

    return res.json({ ok: true, mysqlCount, indexedCount, qdrantCount });
  } catch (err) {
    console.error('[products:rag-stats]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/products/reindex
// Force rebuild product RAG index from active MySQL rows.
router.post('/reindex', adminAuth, async (req, res) => {
  try {
    const result = await rag.reindexAllProducts();
    return res.json({ ok: true, reindex: result });
  } catch (err) {
    console.error('[products:reindex]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/products/admin/affiliate-session
// Save Shopee affiliate session (cookie + csrf token) to Redis.
// Body: { cookie: string, csrfToken: string }
router.post('/admin/affiliate-session', adminAuth, async (req, res) => {
  const cookie    = String(req.body?.cookie    || '').trim();
  const csrfToken = String(req.body?.csrfToken || '').trim();

  if (!cookie) {
    return res.status(400).json({ ok: false, error: 'cookie is required' });
  }

  try {
    await affiliate.saveSession(cookie, csrfToken);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[affiliate:session]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products/admin/affiliate-session
// Returns session status (exists/not, updatedAt) — never returns the cookie itself.
router.get('/admin/affiliate-session', adminAuth, async (req, res) => {
  try {
    const session = await affiliate.loadSession();
    return res.json({
      ok:        true,
      hasSession: !!session,
      updatedAt:  session?.updatedAt || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/products/admin/affiliate-session
router.delete('/admin/affiliate-session', adminAuth, async (req, res) => {
  try {
    await affiliate.clearSession();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products/admin/affiliate-count
// Returns count of products with/without affiliate links.
router.get('/admin/affiliate-count', adminAuth, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT
         SUM(CASE WHEN affiliate_link IS NOT NULL AND affiliate_link <> '' THEN 1 ELSE 0 END) AS "withLink"
       FROM products
       WHERE is_active = true`
    );
    return res.json({ ok: true, withLink: Number(row.withLink || 0) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/products/admin/generate-affiliates
// Batch-generate affiliate links for Shopee products missing them.
// SSE stream: data: { type: "progress"|"done"|"error", ... }
router.post('/admin/generate-affiliates', adminAuth, async (req, res) => {
  const session = await affiliate.loadSession();
  if (!session) {
    return res.status(400).json({ ok: false, error: 'No affiliate session. Please set your cookie first.' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    // Load all Shopee products missing affiliate links in pages
    const PAGE = 100;
    let offset  = 0;
    let totalUpdated = 0;
    let totalFailed  = 0;

    send({ type: 'status', message: 'Loading products...' });

    while (true) {
      const [rows] = await db.query(
        `SELECT id, source_item_id, link
         FROM products
         WHERE source = 'shopee'
           AND is_active = true
           AND source_item_id IS NOT NULL
           AND (affiliate_link IS NULL OR affiliate_link = '')
         LIMIT ? OFFSET ?`,
        [PAGE, offset]
      );

      if (!rows.length) break;

      send({ type: 'progress', message: `Processing ${rows.length} products (offset ${offset})...` });

      const stats = await affiliate.generateForProducts(rows, session);

      if (stats.sessionExpired) {
        send({ type: 'error', message: 'Session expired. Please update your cookie and try again.' });
        res.end();
        return;
      }

      // Persist updated links to DB
      for (const p of rows) {
        if (p.affiliateLink) {
          await db.query(
            `UPDATE products SET affiliate_link = ?, affiliate_generated_at = NOW() WHERE id = ?`,
            [p.affiliateLink.slice(0, 1000), p.id]
          );
        }
      }

      totalUpdated += stats.updated;
      totalFailed  += stats.failed;

      send({ type: 'progress', message: `Updated: ${totalUpdated}, Failed: ${totalFailed}` });

      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    send({ type: 'done', updated: totalUpdated, failed: totalFailed });
  } catch (err) {
    console.error('[affiliate:generate]', err.message);
    send({ type: 'error', message: err.message });
  }

  res.end();
});


// ── Revenue funnel metrics ────────────────────────────────────
// Bot UA patterns to exclude from organic traffic metrics
const BOT_UA_PATTERN = `(bot|spider|crawler|crawl|scraper|slurp|fetcher|` +
  `googlebot|bingbot|yandex|baidu|duckduck|petalbot|semrush|ahrefs|` +
  `mj12bot|dotbot|archive\.org|facebookexternalhit|twitterbot|` +
  `applebot|sogou|exabot|ia_archiver|proximic|seznambot|` +
  `curl|wget|python-requests|axios|node-fetch|go-http)`;

// GET /api/products/admin/metrics/revenue-funnel
// Query params: days=7 (default 7), date_from, date_to (YYYY-MM-DD)
// Returns click stats with bot filtering, daily series for chart.
router.get('/admin/metrics/revenue-funnel', adminAuth, async (req, res) => {
  try {
    // ── Period resolution ──────────────────────────────────────
    let periodStart, periodEnd;
    if (req.query.date_from && req.query.date_to) {
      periodStart = `'${req.query.date_from}'::date`;
      periodEnd   = `'${req.query.date_to}'::date + INTERVAL '1 day'`;
    } else {
      const days  = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
      periodStart = `NOW() - INTERVAL '${days} days'`;
      periodEnd   = `NOW()`;
    }

    // Bot filter clause (null user_agent = old rows before column was added, keep them)
    const botFilter = `(user_agent IS NULL OR user_agent !~* '${BOT_UA_PATTERN}')`;

    const [[totals24h]] = await db.query(`
      SELECT
        COUNT(*)                                          AS total_clicks,
        SUM(CASE WHEN has_affiliate THEN 1 ELSE 0 END)    AS affiliate_clicks,
        COUNT(DISTINCT sid)                               AS unique_sessions,
        COUNT(DISTINCT product_id)                        AS unique_products
      FROM affiliate_click_events
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND ${botFilter}
    `);

    const [[totalsperiod]] = await db.query(`
      SELECT
        COUNT(*)                                          AS total_clicks,
        SUM(CASE WHEN has_affiliate THEN 1 ELSE 0 END)    AS affiliate_clicks,
        COUNT(DISTINCT sid)                               AS unique_sessions,
        COUNT(DISTINCT product_id)                        AS unique_products
      FROM affiliate_click_events
      WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
        AND ${botFilter}
    `);

    const [[yesterday]] = await db.query(`
      SELECT COUNT(*) AS clicks
      FROM affiliate_click_events
      WHERE created_at >= NOW() - INTERVAL '48 hours'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND ${botFilter}
    `);

    const [topQueries] = await db.query(`
      SELECT
        query,
        COUNT(*)                                          AS clicks,
        SUM(CASE WHEN has_affiliate THEN 1 ELSE 0 END)    AS affiliate_clicks,
        COUNT(DISTINCT product_id)                        AS unique_products,
        MAX(created_at)                                   AS last_click_at
      FROM affiliate_click_events
      WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
        AND query IS NOT NULL AND query != ''
        AND ${botFilter}
      GROUP BY query
      ORDER BY clicks DESC
      LIMIT 30
    `);

    const [topProducts] = await db.query(`
      SELECT
        e.product_id,
        p.title,
        p.source,
        p.price,
        (p.affiliate_link IS NOT NULL)                    AS has_affiliate,
        COUNT(*)                                          AS clicks,
        MAX(e.created_at)                                 AS last_click_at
      FROM affiliate_click_events e
      LEFT JOIN products p ON p.id = e.product_id
      WHERE e.created_at >= ${periodStart} AND e.created_at < ${periodEnd}
        AND ${botFilter}
      GROUP BY e.product_id, p.title, p.source, p.price, p.affiliate_link
      ORDER BY clicks DESC
      LIMIT 30
    `);

    // Daily series for chart (up to 90 days)
    const [dailySeries] = await db.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Jakarta')      AS day,
        COUNT(*)                                          AS clicks,
        SUM(CASE WHEN has_affiliate THEN 1 ELSE 0 END)    AS affiliate_clicks
      FROM affiliate_click_events
      WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
        AND ${botFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const affiliateRatio24h = totals24h.total_clicks > 0
      ? Math.round((totals24h.affiliate_clicks / totals24h.total_clicks) * 100) : 0;
    const affiliateRatioperiod = totalsperiod.total_clicks > 0
      ? Math.round((totalsperiod.affiliate_clicks / totalsperiod.total_clicks) * 100) : 0;

    res.json({
      ok: true,
      summary: {
        today:     { ...totals24h,    affiliate_ratio_pct: affiliateRatio24h },
        yesterday: { clicks: yesterday.clicks },
        period:    { ...totalsperiod, affiliate_ratio_pct: affiliateRatioperiod },
      },
      daily_series: dailySeries,
      top_queries:  topQueries,
      top_products: topProducts,
    });
  } catch (err) {
    console.error('[metrics] revenue-funnel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
