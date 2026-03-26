'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

// Simple API-key guard — extension sends X-API-Key header
function apiKeyGuard(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.LEADS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /api/leads/upsert ───────────────────────────────────────────────────
// Auto-called by extension after every scrape batch.
// Accepts array of leads; inserts new ones, updates existing on place_id match
// (falling back to name+address match when place_id is absent).
router.post('/upsert', apiKeyGuard, async (req, res) => {
  const leadsArr = req.body?.leads;
  if (!Array.isArray(leadsArr) || !leadsArr.length) {
    return res.status(400).json({ error: 'leads[] required' });
  }

  let inserted = 0, updated = 0, errors = 0;

  for (const lead of leadsArr) {
    const {
      place_id, name, category, rating, reviews_count, address,
      phone, website, has_wa, lat, lng,
      hours_json, images_json, reviews_best, reviews_bad, about,
      widget_json, maps_url,
    } = lead;

    if (!name) continue;

    try {
      // Lookup by place_id first, then fall back to name+address
      let existingId = null;
      if (place_id) {
        const [[row]] = await db.query(
          'SELECT id FROM gmaps_leads WHERE place_id = ?', [place_id]
        );
        if (row) existingId = row.id;
      }
      if (!existingId) {
        const [[row]] = await db.query(
          'SELECT id FROM gmaps_leads WHERE name = ? AND (address = ? OR address IS NULL)',
          [name, address || '']
        );
        if (row) existingId = row.id;
      }

      const j = v => (v != null ? JSON.stringify(v) : null);
      const vals = [
        place_id   || null,
        name,
        category   || null,
        rating     != null ? rating : null,
        reviews_count != null ? reviews_count : null,
        address    || null,
        phone      || null,
        website    || null,
        has_wa     ? 1 : 0,
        lat        != null ? lat : null,
        lng        != null ? lng : null,
        j(hours_json),
        j(images_json),
        j(reviews_best),
        j(reviews_bad),
        about      || null,
        j(widget_json),
        maps_url   || null,
      ];

      if (existingId) {
        await db.query(`
          UPDATE gmaps_leads SET
            place_id=?, name=?, category=?, rating=?, reviews_count=?,
            address=?, phone=?, website=?, has_wa=?, lat=?, lng=?,
            hours_json=?, images_json=?, reviews_best=?, reviews_bad=?,
            about=?, widget_json=?, maps_url=?, updated_at=NOW()
          WHERE id=?
        `, [...vals, existingId]);
        updated++;
      } else {
        await db.query(`
          INSERT INTO gmaps_leads
            (place_id,name,category,rating,reviews_count,address,phone,website,
             has_wa,lat,lng,hours_json,images_json,reviews_best,reviews_bad,
             about,widget_json,maps_url)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, vals);
        inserted++;
      }
    } catch (e) {
      console.error('[leads/upsert] error for', name, ':', e.message);
      errors++;
    }
  }

  res.json({ ok: true, inserted, updated, errors, total: leadsArr.length });
});

// ── GET /api/leads ───────────────────────────────────────────────────────────
// List leads for admin review (no auth needed for read)
router.get('/', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const { category, q } = req.query;

  let where = '1=1';
  const params = [];

  if (category) { where += ' AND category LIKE ?'; params.push(`%${category}%`); }
  if (q)        { where += ' AND (name LIKE ? OR address LIKE ? OR website LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const [rows] = await db.query(
    `SELECT id, place_id, name, category, rating, reviews_count, address, phone,
            website, has_wa, lat, lng, about, maps_url, scraped_at, updated_at
     FROM gmaps_leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM gmaps_leads WHERE ${where}`, params
  );

  res.json({ rows, total, limit, offset });
});

module.exports = router;
