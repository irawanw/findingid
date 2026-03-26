'use strict';
/**
 * POST /api/products/enrich
 *
 * Lightweight endpoint to update description, specs, reviews_json
 * for an already-ingested product. Called by the Chrome extension's
 * manual "Enrich Test" button (and future automated enrichment job).
 *
 * Unlike /api/ingest, this does NOT re-categorize or require all fields.
 * It only patches enrichment columns on an existing row.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const rag     = require('../services/rag');
const cfg     = require('../config/config');
const { downloadAndCacheImages, downloadAndCacheVariationImages } = require('./ingest');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /queue — returns next product needing enrichment
// Criteria: shopee products missing any detail data, ordered by quality score
// Skips products attempted within the last 2 hours to prevent infinite retry loops
router.get('/queue', authCheck, async (req, res) => {
  const [rows] = await db.query(
    `SELECT id, source_item_id, link, title
     FROM products
     WHERE source = 'shopee'
       AND is_active = true
       AND enrich_done = false
       AND (
         (COALESCE(sold_count, 0) >= 1000  AND COALESCE(rating, 0) >= 4.5 AND COALESCE(price, 0) >= 300000) OR
         (COALESCE(sold_count, 0) >= 5000  AND COALESCE(rating, 0) >= 4.5 AND COALESCE(price, 0) >= 100000) OR
         (COALESCE(sold_count, 0) >= 10000 AND COALESCE(rating, 0) >= 4.8 AND COALESCE(price, 0) >= 50000)
       )
     ORDER BY (COALESCE(rating, 0) * 0.4 + LN(1 + COALESCE(sold_count, 0)) * 0.6) DESC, updated_at ASC
     LIMIT 1`
  );

  if (!rows.length) return res.json({ product: null });

  const p = rows[0];
  // Extract shopid from link: https://shopee.co.id/TITLE-i.SHOPID.ITEMID
  const m = (p.link || '').match(/-i\.(\d+)\.(\d+)/);
  if (!m) return res.json({ product: null });

  // Mark as in-progress so concurrent queue calls skip this product
  await db.query(
    'UPDATE products SET enrich_done = true, enrich_attempted_at = NOW() WHERE id = ?',
    [p.id]
  );

  res.json({
    product: {
      id:             p.id,
      source_item_id: p.source_item_id,
      shopid:         m[1],
      itemid:         m[2],
      title:          p.title,
      link:           p.link,
    },
  });
});

router.post('/', authCheck, async (req, res) => {
  const { source_item_id, shopid, description, specs, attributes_json, reviews_json, sold_count, rating, rating_summary, sold_display, price, variants_json, images_json } = req.body;

  if (!source_item_id) {
    return res.status(400).json({ error: 'source_item_id is required' });
  }

  // Find existing product
  const [rows] = await db.query(
    `SELECT id, title, price, category FROM products WHERE source_item_id = ? LIMIT 1`,
    [String(source_item_id)]
  );
  if (!rows.length) {
    return res.status(404).json({ error: `No product with source_item_id=${source_item_id}` });
  }
  const product = rows[0];

  // Validate reviews_json shape
  let reviewsStr = null;
  if (reviews_json) {
    try {
      const rv = typeof reviews_json === 'string' ? JSON.parse(reviews_json) : reviews_json;
      if (rv && (rv.positive || rv.negative)) {
        // Keep max 3 positive + 3 negative, trim text
        const clean = {
          positive: (rv.positive || []).slice(0, 3).map(r => ({
            star: r.star || 0,
            text: String(r.text || '').slice(0, 600),
            user: r.user || 'anonymous',
            variant: r.variant || null,
          })),
          negative: (rv.negative || []).slice(0, 3).map(r => ({
            star: r.star || 0,
            text: String(r.text || '').slice(0, 600),
            user: r.user || 'anonymous',
            variant: r.variant || null,
          })),
        };
        reviewsStr = JSON.stringify(clean);
      }
    } catch (_) {}
  }

  // Update only non-null fields
  const updates = [];
  const params  = [];

  if (description) {
    updates.push('description = ?');
    params.push(String(description).slice(0, 2000));
  }
  if (specs) {
    updates.push('specs = ?');
    params.push(String(specs).slice(0, 1000));
  }
  if (attributes_json) {
    try {
      const av = typeof attributes_json === 'string' ? JSON.parse(attributes_json) : attributes_json;
      if (Array.isArray(av)) {
        const clean = av.map(a => ({ name: String(a.name || ''), value: String(a.value || '') }));
        updates.push('attributes_json = ?');
        params.push(JSON.stringify(clean));
      }
    } catch (_) {}
  }
  if (reviewsStr) {
    updates.push('reviews_json = ?');
    params.push(reviewsStr);
  }
  const newPrice = price != null && Number(price) > 0 ? Number(price) : null;
  if (newPrice) {
    updates.push('price = ?');
    params.push(newPrice);
  }
  if (variants_json) {
    try {
      const vv = typeof variants_json === 'string' ? JSON.parse(variants_json) : variants_json;
      if (Array.isArray(vv) && vv.length) {
        updates.push('variants_json = ?');
        params.push(JSON.stringify(vv));
      }
    } catch (_) {}
  }
  let newImagesJson = null;
  if (images_json) {
    try {
      const iv = typeof images_json === 'string' ? JSON.parse(images_json) : images_json;
      if (Array.isArray(iv) && iv.length) {
        newImagesJson = iv;
        // Don't overwrite images_json in DB here — downloadAndCacheImages does that after caching
      }
    } catch (_) {}
  }
  if (sold_count != null && Number(sold_count) > 0) {
    // Use GREATEST so enriched total always wins over smaller list-scrape monthly value
    updates.push('sold_count = GREATEST(COALESCE(sold_count, 0), ?)');
    params.push(Number(sold_count));
  }
  if (sold_display) {
    updates.push('sold_display = ?');
    params.push(String(sold_display).slice(0, 20));
  }
  if (rating != null && Number(rating) > 0) {
    updates.push('rating = ?');
    params.push(Number(rating));
  }
  if (rating_summary) {
    try {
      const rs = typeof rating_summary === 'string' ? JSON.parse(rating_summary) : rating_summary;
      if (rs?.stars) {
        updates.push('rating_summary = ?');
        params.push(JSON.stringify(rs));
      }
    } catch (_) {}
  }

  if (!updates.length) {
    return res.json({ updated: false, reason: 'no enrichment data provided', id: product.id });
  }

  updates.push('updated_at = NOW()');
  updates.push('enrich_done = true');
  updates.push('enrich_attempted_at = NOW()');
  params.push(product.id);

  await db.query(
    `UPDATE products SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  // Cache gallery images (fire-and-forget)
  if (newImagesJson) {
    const primaryUrl = newImagesJson[0] || null;
    downloadAndCacheImages(product.id, primaryUrl, JSON.stringify(newImagesJson), 'shopee').catch(() => {});
  }

  // Cache per-color variation images if variants_json has image_urls
  if (variants_json) {
    try {
      const vv = typeof variants_json === 'string' ? JSON.parse(variants_json) : variants_json;
      const seen = new Set();
      const varImgs = (Array.isArray(vv) ? vv : [])
        .filter(v => v.image_url && v.name)
        .reduce((acc, v) => {
          const color = v.name.includes(',') ? v.name.split(',')[0] : v.name;
          if (!seen.has(color)) { seen.add(color); acc.push({ name: color, image_url: v.image_url }); }
          return acc;
        }, []);
      if (varImgs.length) {
        downloadAndCacheVariationImages(product.id, JSON.stringify(varImgs), 'shopee').catch(() => {});
      }
    } catch (_) {}
  }

  // Record price history if price changed
  if (newPrice) {
    db.query(
      'INSERT INTO price_history (product_id, price, variant_name) VALUES (?, ?, NULL)',
      [product.id, newPrice]
    ).catch(() => {});
    // Variant prices from enrichment
    if (variants_json) {
      try {
        const vv = typeof variants_json === 'string' ? JSON.parse(variants_json) : variants_json;
        for (const v of (Array.isArray(vv) ? vv : [])) {
          if (v.price > 0 && v.name) {
            db.query(
              'INSERT INTO price_history (product_id, price, variant_name) VALUES (?, ?, ?)',
              [product.id, v.price, v.name.slice(0, 255)]
            ).catch(() => {});
          }
        }
      } catch (_) {}
    }
  }

  // Re-index in RAG so vector search benefits from new data
  let ragIndexed = false;
  try {
    await rag.indexProducts([{
      id:          product.id,
      title:       product.title,
      price:       product.price,
      category:    product.category || '',
      description: description || null,
      specs:       specs       || null,
    }]);
    ragIndexed = true;
  } catch (e) {
    console.warn('[enrich] RAG index failed:', e.message);
  }

  console.log(`[enrich] Updated product id=${product.id} (${product.title?.slice(0, 50)}) reviews=${!!reviewsStr} specs=${!!specs} rag=${ragIndexed}`);

  res.json({
    updated:    true,
    id:         product.id,
    title:      product.title,
    rag_indexed: ragIndexed,
    fields:     { description: !!description, specs: !!specs, attributes: !!attributes_json, reviews: !!reviewsStr },
  });

  // Auto-create short video job (fire-and-forget, no duplicate)
  setImmediate(async () => {
    try {
      const [ins] = await db.query(
        'INSERT INTO shortvideo_jobs (product_id, status) VALUES (?, ?) ON CONFLICT (product_id) DO NOTHING',
        [product.id, 'pending_script']
      );
      if (!ins.affectedRows) return; // job already existed

      console.log(`[shortvideo] Created job for product ${product.id}, generating script...`);
      const scriptOut = path.join(__dirname, `../../scripts/short_${product.id}.json`);
      const proc = spawn('node', [
        path.join(__dirname, '../../tools/gen_short_script.js'),
        String(product.id),
      ], { stdio: 'pipe' });

      proc.on('close', async (code) => {
        if (code !== 0) {
          await db.query(
            'UPDATE shortvideo_jobs SET status=?, error_msg=? WHERE product_id=?',
            ['failed', 'Script generation failed (exit '+code+')', product.id]
          );
          return;
        }
        try {
          const scriptJson = fs.readFileSync(scriptOut, 'utf8');
          await db.query(
            'UPDATE shortvideo_jobs SET status=?, script_json=? WHERE product_id=?',
            ['draft', scriptJson, product.id]
          );
          console.log(`[shortvideo] Script ready for product ${product.id}`);
        } catch (e) {
          await db.query(
            'UPDATE shortvideo_jobs SET status=?, error_msg=? WHERE product_id=?',
            ['failed', 'Script read error: '+e.message, product.id]
          );
        }
      });
    } catch (e) {
      console.warn('[shortvideo] Job creation error:', e.message);
    }
  });
});

module.exports = router;
