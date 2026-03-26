'use strict';
const express  = require('express');
const router   = express.Router();
const db       = require('../services/db');
const notifier = require('../services/notifier');
const { indexPlaces } = require('../services/placesRag');

// ================================================================
// Places Ingest — Chrome Extension pushes scraped Maps data
// POST /api/places/ingest
//
// Extension sends scraped places after completing a maps job.
// We upsert into gmaps_leads, index into Qdrant, then signal
// waiting search SSE clients via notifier.
// ================================================================

const API_KEY = process.env.PLACES_API_KEY || process.env.LEADS_API_KEY;

router.post('/', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { places, jobId, jobQuery } = req.body;
  if (!Array.isArray(places) || !places.length) {
    return res.status(400).json({ error: 'places[] required' });
  }

  let inserted = 0, updated = 0;
  const insertedRows = [];

  for (const p of places) {
    const { place_id, name, category, rating, reviews_count, address,
            phone, website, has_wa, lat, lng,
            hours_json, images_json, reviews_best, reviews_bad, about,
            widget_json, maps_url } = p;

    if (!name) continue;

    try {
      const j = v => (v != null ? JSON.stringify(v) : null);

      // Check existing by place_id or name+address
      let existingId = null;
      if (place_id) {
        const [[row]] = await db.query('SELECT id FROM gmaps_leads WHERE place_id = ?', [place_id]);
        if (row) existingId = row.id;
      }
      if (!existingId) {
        const [[row]] = await db.query(
          'SELECT id FROM gmaps_leads WHERE name = ? AND (address = ? OR address IS NULL)',
          [name, address || '']
        );
        if (row) existingId = row.id;
      }

      const vals = [
        place_id || null, name, category || null,
        rating != null ? rating : null,
        reviews_count != null ? reviews_count : null,
        address || null, phone || null, website || null,
        has_wa ? 1 : 0,
        lat != null ? lat : null, lng != null ? lng : null,
        j(hours_json), j(images_json), j(reviews_best), j(reviews_bad),
        about || null, j(widget_json), maps_url || null,
      ];

      if (existingId) {
        await db.query(
          `UPDATE gmaps_leads SET
             place_id=?,name=?,category=?,rating=?,reviews_count=?,address=?,
             phone=?,website=?,has_wa=?,lat=?,lng=?,hours_json=?,images_json=?,
             reviews_best=?,reviews_bad=?,about=?,widget_json=?,maps_url=?,
             updated_at=NOW()
           WHERE id=?`,
          [...vals, existingId]
        );
        updated++;
        insertedRows.push({ id: existingId, name, category, about, address });
      } else {
        const [result] = await db.query(
          `INSERT INTO gmaps_leads
             (place_id,name,category,rating,reviews_count,address,phone,website,
              has_wa,lat,lng,hours_json,images_json,reviews_best,reviews_bad,
              about,widget_json,maps_url)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          vals
        );
        inserted++;
        insertedRows.push({ id: result.insertId, name, category, about, address });
      }
    } catch (e) {
      console.error('[places/ingest] error for', name, ':', e.message);
    }
  }

  res.json({ ok: true, inserted, updated, total: places.length });

  // Signal waiting search SSE that new data is available
  if (jobQuery) notifier.emit(`ingest:places:${jobQuery}`);

  // Mark job done
  if (jobId) {
    db.query(
      `UPDATE maps_jobs SET status = 'done', completed_at = NOW(), places_ingested = ? WHERE id = ?`,
      [inserted + updated, jobId]
    ).catch(() => {});
  }

  // Background: index new/updated places into Qdrant
  if (insertedRows.length) {
    setImmediate(() => {
      indexPlaces(insertedRows)
        .then(()  => console.log(`[places/ingest] RAG indexed ${insertedRows.length} places`))
        .catch(e  => console.error('[places/ingest] RAG index error:', e.message));
    });
  }
});

module.exports = router;
