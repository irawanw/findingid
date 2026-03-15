'use strict';
const express      = require('express');
const router       = express.Router();
const db           = require('../services/db');
const rag          = require('../services/rag');
const cfg          = require('../config/config');
const cache        = require('../services/cache');
const { normalizeQuery } = require('../services/queryNormalizer');
const { classifyProducts, applyPriceGuard } = require('../services/categorizer');
const notifier = require('../services/notifier');
const fs           = require('fs');
const path         = require('path');

const UPLOADS_DIR = path.join(__dirname, '../../uploads/products');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Detect real image extension from magic bytes
function imageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0,4).toString() === 'RIFF' && buf.slice(8,12).toString() === 'WEBP') return '.webp';
  return null;
}

const PLACEHOLDER_MD5 = new Set([
  '7df85ac1de99b6c204f61abeaae3501f', // Tokopedia "no image" placeholder
]);
const crypto = require('crypto');

// Download a single image URL, return local path or null on failure.
async function fetchAndSave(dest, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return null;
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (PLACEHOLDER_MD5.has(hash)) return null;
    const ext = imageExt(buf) || '.jpg';
    const fullDest = dest + ext;
    fs.writeFileSync(fullDest, buf);
    return fullDest;
  } catch (_) { return null; }
}

// Download all product images (max 7) at 720px and cache locally.
// Updates image_url (primary) and images_json (all) in DB.
// Fire-and-forget — never awaited.
// Download gallery images (product page photos).
// Files: productId.ext (primary), productId_1.ext, productId_2.ext, ...
// Scans disk after download so images_json is always authoritative — never downgrades.
async function downloadAndCacheImages(productId, primaryUrl, imagesJson, source) {
  let urls = [];
  try { urls = JSON.parse(imagesJson || '[]'); } catch (_) {}
  if (!urls.length && primaryUrl) urls = [primaryUrl];
  if (!urls.length) return;

  const toHiRes = url => source === 'shopee'
    ? url.replace(/@resize_w\d+_nl/, '@resize_w720_nl').replace(/_tn$/, '@resize_w720_nl')
    : url;

  // Download any URLs not yet on disk (index 0 → productId_0.ext, renamed to productId.ext)
  for (let i = 0; i < Math.min(urls.length, 20); i++) {
    const base     = path.join(UPLOADS_DIR, `${productId}_${i}`);
    const existing = ['.jpg', '.png', '.webp'].find(e => fs.existsSync(base + e));
    if (existing) continue;
    await fetchAndSave(base, toHiRes(urls[i]));
  }

  // Rename _0.ext → .ext (primary, no index suffix)
  const extns = ['.jpg', '.png', '.webp'];
  const idx0  = path.join(UPLOADS_DIR, `${productId}_0`);
  const ext0  = extns.find(e => fs.existsSync(idx0 + e));
  if (ext0) fs.renameSync(idx0 + ext0, path.join(UPLOADS_DIR, `${productId}${ext0}`));

  // Scan disk — build authoritative list of ALL cached gallery images
  const allPaths = [];
  const primaryExt = extns.find(e => fs.existsSync(path.join(UPLOADS_DIR, `${productId}${e}`)));
  if (primaryExt) allPaths.push(`/uploads/products/${productId}${primaryExt}`);
  for (let i = 1; i < 20; i++) {
    const e = extns.find(ex => fs.existsSync(path.join(UPLOADS_DIR, `${productId}_${i}${ex}`)));
    if (e) allPaths.push(`/uploads/products/${productId}_${i}${e}`);
    else   break;
  }

  if (!allPaths.length) return;
  await db.query(
    'UPDATE products SET image_url = ?, images_json = ? WHERE id = ?',
    [allPaths[0], JSON.stringify(allPaths), productId]
  );
}

// Download variation images (per-color swatches for two-tier products).
// variationImagesJson: [{name:"Black", image_url:"https://..."}, ...]
// Files: productId_v0.ext, productId_v1.ext, ...
// Updates variation_images_json in DB with local paths.
async function downloadAndCacheVariationImages(productId, variationImagesJson, source) {
  let items = [];
  try { items = JSON.parse(variationImagesJson || '[]'); } catch (_) {}
  items = items.filter(v => v.name && v.image_url);
  if (!items.length) return;

  const toHiRes = url => source === 'shopee'
    ? url.replace(/@resize_w\d+_nl/, '@resize_w720_nl').replace(/_tn$/, '@resize_w720_nl')
    : url;

  const result = [];
  for (let i = 0; i < Math.min(items.length, 20); i++) {
    const { name, image_url } = items[i];
    const base     = path.join(UPLOADS_DIR, `${productId}_v${i}`);
    const extns    = ['.jpg', '.png', '.webp'];
    const existing = extns.find(e => fs.existsSync(base + e));
    let   localUrl = existing ? `/uploads/products/${productId}_v${i}${existing}` : null;
    if (!localUrl) {
      const saved = await fetchAndSave(base, toHiRes(image_url));
      localUrl = saved ? '/uploads/products/' + path.basename(saved) : null;
    }
    result.push({ name, image_url: localUrl || image_url });
  }

  if (!result.length) return;
  await db.query(
    'UPDATE products SET variation_images_json = ? WHERE id = ?',
    [JSON.stringify(result), productId]
  );
}

// Convert a signed Tokopedia CDN URL to the stable images.tokopedia.net format.
// Signed URLs (p16-images-sign-sg.tokopedia-static.net) expire in hours via Akamai.
// The stable CDN serves the same image indefinitely without a signature.
function toStableTokopediaUrl(url) {
  if (!url || !url.includes('tokopedia-static.net')) return url;
  try {
    const u = new URL(url);
    const imgPath = u.pathname
      .replace(/^\/tos-[^/]+\//, '')   // strip CDN shard prefix
      .replace(/~tplv-[^?]+/, '');     // strip image transform suffix
    if (imgPath.startsWith('img/')) {
      return `https://images.tokopedia.net/img/cache/200-square/${imgPath.replace(/^img\//, '')}`;
    }
    if (/^[a-zA-Z0-9/_-]/.test(imgPath)) {
      return `https://images.tokopedia.net/img/cache/200-square/${imgPath}`;
    }
  } catch (_) {}
  return url; // fallback: keep original if conversion fails
}

// ================================================================
// POST /api/ingest — Chrome Extension data ingestion
//
// Called by the extension after scraping a marketplace page.
// Body:
//   {
//     jobId:    "uuid",          // optional, links to search_jobs
//     source:   "shopee",        // "shopee"|"tokopedia"|"rumah"|"mobil"
//     products: [{
//       title:      string,
//       price:      number,
//       rating:     number,       // 0.0 - 5.0
//       sold_count: number,
//       link:       string,       // canonical URL
//       image_url:  string,
//       category:   string,
//       description: string,
//     }]
//   }
//
// Pipeline:
//   1. Upsert each product into MySQL (ON DUPLICATE KEY UPDATE)
//   2. Send batch to RAG service for embedding + Qdrant indexing
//   3. Mark job done in search_jobs
// ================================================================

// Rewrite Shopee image URLs to the susercontent CDN with resize param.
// Handles both old cf.shopee.co.id/_tn format and bare image IDs.
function compressShopeeImage(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('susercontent.com')) {
    if (!url.includes('@resize_w250_nl')) return url.replace(/_tn$/, '') + '@resize_w250_nl';
    return url;
  }
  const m = url.match(/cf\.shopee\.co\.id\/file\/(.+?)(_tn)?$/i);
  if (m) return `https://down-id.img.susercontent.com/file/${m[1]}@resize_w250_nl`;
  return url;
}


// Simple API key auth for extension
function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/', authCheck, async (req, res) => {
  const { jobId, source, products } = req.body;

  // Look up the job's query so we can tag products with which search scraped them
  let jobQuery = null;
  if (jobId) {
    try {
      const [jrows] = await db.query('SELECT query FROM search_jobs WHERE id = ? LIMIT 1', [jobId]);
      jobQuery = jrows[0]?.query?.trim().toLowerCase().slice(0, 200) || null;
    } catch (_) {}
  }

  if (!source || !Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'source and products[] are required' });
  }

  if (products.length > 500) {
    return res.status(400).json({ error: 'Max 500 products per batch' });
  }

  const inserted     = [];
  const errors       = [];
  let   newCount     = 0;
  let   updatedCount = 0;
  let   priceChanged = 0;

  // Pre-fetch existing prices so we can detect price changes on update
  const existingPrices = new Map();
  try {
    const itemIds = products.map(p => p.source_item_id).filter(Boolean);
    if (itemIds.length) {
      const [ep] = await db.query(
        `SELECT source_item_id, price FROM products WHERE source_item_id IN (${itemIds.map(() => '?').join(',')})`,
        itemIds
      );
      for (const r of ep) existingPrices.set(r.source_item_id, Number(r.price));
    }
  } catch (_) {}

  try {
    // ── 0. Apply price guard to products that already have a category ──
    // Category classification (vLLM) runs AFTER insert so it doesn't block.
    for (const p of products) {
      if (p.category) {
        const price = typeof p.price === 'number' ? p.price : parseFloat(p.price) || 0;
        p.category = applyPriceGuard(p.category, price) || p.category;
      }
    }

    // ── 1. Upsert products into MySQL immediately ────────────
    for (const p of products) {
      if (!p.title || !p.link) continue;

      try {
        const [result] = await db.query(
          `INSERT INTO products
             (source_item_id, title, price, rating, sold_count, monthly_sold, sold_display, source, link,
              image_url, images_json, source_images_json, category, description, specs, attributes_json, variants_json, reviews_json, rating_summary, search_query, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             title               = VALUES(title),
             price               = VALUES(price),
             rating              = COALESCE(VALUES(rating), rating),
             sold_count          = IF(VALUES(sold_count) IS NULL, sold_count, GREATEST(COALESCE(sold_count, 0), VALUES(sold_count))),
             monthly_sold        = COALESCE(VALUES(monthly_sold), monthly_sold),
             sold_display        = COALESCE(VALUES(sold_display), sold_display),
             link                = VALUES(link),
             image_url           = VALUES(image_url),
             images_json         = COALESCE(VALUES(images_json), images_json),
             source_images_json  = COALESCE(VALUES(source_images_json), source_images_json),
             category            = COALESCE(VALUES(category), category),
             description         = COALESCE(NULLIF(VALUES(description),''), description),
             specs               = COALESCE(NULLIF(VALUES(specs),''), specs),
             attributes_json     = COALESCE(VALUES(attributes_json), attributes_json),
             variants_json       = COALESCE(VALUES(variants_json), variants_json),
             reviews_json        = COALESCE(VALUES(reviews_json), reviews_json),
             rating_summary      = COALESCE(VALUES(rating_summary), rating_summary),
             search_query        = VALUES(search_query),
             is_active           = 1,
             updated_at          = NOW()`,
          [
            p.source_item_id?.slice(0, 100) || null,
            p.title?.slice(0, 500),
            p.price        ?? null,
            p.rating       ?? null,
            p.sold_count   ?? null,
            p.monthly_sold ?? null,
            p.sold_display?.slice(0, 20) || null,
            source,
            p.link?.slice(0, 1000),
            (source === 'tokopedia'
              ? toStableTokopediaUrl(p.image_url)
              : compressShopeeImage(p.image_url))?.slice(0, 1000) || null,
            p.images_json || null,
            p.source_images_json || null,
            p.category?.slice(0, 200)     || null,
            p.description?.slice(0, 2000) || null,
            p.specs?.slice(0, 1000)       || null,
            p.attributes_json             || null,
            p.variants_json               || null,
            p.reviews_json                || null,
            p.rating_summary ? JSON.stringify(p.rating_summary) : null,
            jobQuery,
          ]
        );

        const id = result.insertId || null;
        // affectedRows: 1 = new insert, 2 = updated, 0 = no change
        if (result.affectedRows === 1 && result.insertId > 0) newCount++;
        else if (result.affectedRows === 2) {
          updatedCount++;
          // Detect price change
          const oldPrice = existingPrices.get(String(p.source_item_id));
          if (oldPrice !== undefined && p.price > 0 && Math.abs(Number(p.price) - oldPrice) > 1) priceChanged++;
        }
        if (id || result.affectedRows) {
          // Fetch the actual ID (needed for RAG indexing)
          const [rows] = await db.query('SELECT id FROM products WHERE link = ? LIMIT 1', [p.link]);
          if (rows[0]) {
            inserted.push({ ...p, id: rows[0].id });
            // Download gallery images (fire-and-forget — URLs are fresh/valid right now)
            downloadAndCacheImages(rows[0].id, p.image_url, p.images_json || null, source).catch(() => {});
            // Download per-color variation images if present
            if (p.variants_json) {
              try {
                const vv = JSON.parse(p.variants_json);
                // Build deduplicated color→imageUrl map from variants
                const seen = new Set();
                const varImgs = vv
                  .filter(v => v.image_url && v.name)
                  .reduce((acc, v) => {
                    const color = v.name.includes(',') ? v.name.split(',')[0] : v.name;
                    if (!seen.has(color)) { seen.add(color); acc.push({ name: color, image_url: v.image_url }); }
                    return acc;
                  }, []);
                if (varImgs.length) {
                  downloadAndCacheVariationImages(rows[0].id, JSON.stringify(varImgs), source).catch(() => {});
                }
              } catch (_) {}
            }
          }
        }
      } catch (rowErr) {
        errors.push({ title: p.title, error: rowErr.message });
      }
    }

    // ── 2. Notify waiting searches immediately after MySQL insert ──
    // rag.retrieve() has a FULLTEXT fallback for when Qdrant isn't indexed yet,
    // so search can unblock and serve results from MySQL right away.
    if (inserted.length && jobQuery) {
      console.log(`[ingest] notifying waiters for "${jobQuery}" (${inserted.length} products in MySQL)`);
      notifier.emit(`ingest:${jobQuery}`);
    }

    // ── 3. Background: RAG index + classify categories (non-blocking) ──
    setImmediate(async () => {
      try {
        if (inserted.length) {
          await rag.indexProducts(inserted).catch(err =>
            console.error('[ingest] RAG indexing failed:', err.message)
          );
          // Capture price snapshots for deal detection (base price + all variants)
          for (const p of inserted) {
            if (!p.id) continue;
            // Base price
            if (p.price > 0) {
              db.query(
                'INSERT INTO price_history (product_id, price, variant_name) VALUES (?, ?, NULL)',
                [p.id, p.price]
              ).catch(() => {});
            }
            // Variant prices
            if (p.variants_json) {
              try {
                const variants = JSON.parse(p.variants_json);
                for (const v of variants) {
                  if (v.price > 0 && v.name) {
                    db.query(
                      'INSERT INTO price_history (product_id, price, variant_name) VALUES (?, ?, ?)',
                      [p.id, v.price, v.name.slice(0, 255)]
                    ).catch(() => {});
                  }
                }
              } catch (_) {}
            }
          }

          // Store batch product IDs in Redis so active search SSE can use all 60 for vLLM comparison
          if (jobQuery) {
            try {
              const batchKey = `batch:${require('crypto').createHash('md5').update(jobQuery).digest('hex')}`;
              const redis = cache.getClient();
              const ids = inserted.map(p => String(p.id)).filter(Boolean);
              if (ids.length) {
                await redis.del(batchKey);
                await redis.lpush(batchKey, ...ids);
                await redis.expire(batchKey, 600); // 10 min
                console.log(`[ingest] batch cache: stored ${ids.length} IDs for "${jobQuery}"`);
              }
            } catch (_) {}
          }
        }
        const needsCat = inserted.filter(p => p.title && !p.category);
        if (needsCat.length) {
          console.log(`[ingest] classifying ${needsCat.length} products via vLLM (background)`);
          const titles = needsCat.map(p => p.title);
          const prices = needsCat.map(p => typeof p.price === 'number' ? p.price : parseFloat(p.price) || 0);
          const catResults = await classifyProducts(titles, prices).catch(err => {
            console.error('[ingest] categorizer failed:', err.message);
            return needsCat.map(() => ({ display_name: null, catid: null }));
          });
          let ci = 0;
          for (const p of needsCat) {
            const r = catResults[ci++];
            if (r?.display_name) {
              const cat = applyPriceGuard(r.display_name, p.price || 0) || r.display_name;
              await db.query('UPDATE products SET category = ? WHERE id = ? AND (category IS NULL OR category = "")', [cat, p.id]).catch(() => {});
              p.category = cat;
            }
          }
        }
      } catch (e) {
        console.error('[ingest] background classify/index error:', e.message);
      }
    });

    // ── 4. Mark job done ────────────────────────────────────
    if (jobId) {
      db.query(
        `UPDATE search_jobs SET status = 'done', completed_at = NOW(), products_ingested = ? WHERE id = ?`,
        [inserted.length, jobId]
      ).catch(() => {});
    } else if (inserted.length > 0) {
      // Passive ingest (scraper.py keyword scrape — no jobId from extension).
      // Find the currently claimed job and accumulate stats in Redis so jobs/:id/done
      // can report accurate numbers when scraper.py marks the job done.
      try {
        const [activeJobs] = await db.query(
          `SELECT id FROM search_jobs WHERE status = 'claimed' AND expires_at > NOW()
           ORDER BY claimed_at DESC LIMIT 1`
        );
        if (activeJobs.length) {
          const activeJobId = activeJobs[0].id;
          const redis = cache.getClient();
          const statsKey = `job_stats:${activeJobId}`;
          const existing = await redis.get(statsKey).catch(() => null);
          const prev = existing ? JSON.parse(existing) : { total: 0, newCount: 0, updatedCount: 0, priceChanged: 0 };
          await redis.set(statsKey, JSON.stringify({
            total:        prev.total        + inserted.length,
            newCount:     prev.newCount     + newCount,
            updatedCount: prev.updatedCount + updatedCount,
            priceChanged: prev.priceChanged + priceChanged,
          }), 'EX', 900);
        }
      } catch (_) {}
    }

    // ── 4. Bust search cache for this query so next search gets fresh results ──
    if (inserted.length > 0 && jobQuery) {
      try {
        const { query: q, price, preferredCategories, excludedCategories } = normalizeQuery(jobQuery);
        const cacheKey = cache.searchKey(JSON.stringify({ q, price, preferredCategories, excludedCategories }));
        await cache.del(cacheKey);
        console.log(`[ingest] cache busted for "${jobQuery}"`);
      } catch (_) {}
    }

    // Telegram is sent by jobs.js when the job is marked done — not here (avoid double notify)

    res.json({
      ok:       true,
      inserted: inserted.length,
      errors:   errors.length,
      details:  errors.slice(0, 10),
    });

  } catch (err) {
    console.error('[ingest] error:', err.message);
    res.status(500).json({ error: 'Ingestion failed', details: err.message });
  }
});

module.exports = router;
module.exports.downloadAndCacheImages          = downloadAndCacheImages;
module.exports.downloadAndCacheVariationImages = downloadAndCacheVariationImages;
