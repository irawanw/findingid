'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

const BATCH_SIZE = 5;

function authCheck(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// Parses shopId from two Shopee URL formats:
//   https://shopee.co.id/TITLE-i.{shopId}.{itemId}
//   https://shopee.co.id/product/{shopId}/{itemId}
function parseShopId(link) {
  if (!link) return null;
  const m1 = link.match(/-i\.(\d+)\.\d+/);
  if (m1) return Number(m1[1]);
  const m2 = link.match(/\/product\/(\d+)\/\d+/);
  if (m2) return Number(m2[1]);
  return null;
}

// GET /api/affiliate-jobs
// Returns a batch of Shopee products missing affiliate links.
// Response: { ok, items: [{id, itemId, shopId}] }
router.get('/', authCheck, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, source_item_id, link
       FROM products
       WHERE source = 'shopee'
         AND is_active = 1
         AND source_item_id IS NOT NULL
         AND link IS NOT NULL
         AND (affiliate_link IS NULL OR affiliate_link = '')
       ORDER BY click_count DESC, id ASC
       LIMIT ?`,
      [BATCH_SIZE]
    );

    const items = rows
      .map(r => ({ id: r.id, itemId: r.source_item_id, shopId: parseShopId(r.link), link: r.link }))
      .filter(r => r.shopId);

    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[affiliate-jobs:get]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/affiliate-jobs/done
// Body: { results: [{id, affiliateLink}] }
router.post('/done', authCheck, async (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : [];

  if (!results.length) {
    return res.status(400).json({ ok: false, error: 'results[] is required' });
  }

  let updated = 0;
  try {
    for (const { id, affiliateLink } of results) {
      if (!id || affiliateLink === undefined) continue;
      await db.query(
        `UPDATE products
         SET affiliate_link = ?, affiliate_generated_at = NOW()
         WHERE id = ?`,
        [String(affiliateLink).slice(0, 1000), id]
      );
      updated++;
    }
    return res.json({ ok: true, updated });
  } catch (err) {
    console.error('[affiliate-jobs:done]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
