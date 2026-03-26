'use strict';
const express  = require('express');
const router   = express.Router();
const db       = require('../services/db');
const { jobListeners } = require('../services/placesRag');

// ================================================================
// Places Jobs — Chrome Extension polling (mirrors jobs.js)
//
// GET  /api/places/jobs          → claim next pending maps job
// GET  /api/places/jobs/stream   → SSE: extension connects, backend pushes instantly
// POST /api/places/jobs/:id/claim → claim a specific pushed job
// POST /api/places/jobs/:id/done  → mark job done
// ================================================================

// GET /api/places/jobs — claim next pending maps job
router.get('/', async (req, res) => {
  try {
    const priorityMin = parseInt(req.query.priority_min, 10) || 0;
    const [rows] = await db.query(
      `SELECT id, keyword, city, query, priority
       FROM maps_jobs
       WHERE status = 'pending' AND expires_at > NOW() AND priority >= ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
      [priorityMin]
    );

    if (!rows.length) return res.json({ job: null });
    const row = rows[0];

    await db.query(
      `UPDATE maps_jobs SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
      [row.id]
    );

    res.json({
      job: {
        id:       row.id,
        type:     'maps',
        keyword:  row.keyword,
        city:     row.city,
        query:    row.query,
        priority: row.priority,
      },
    });
  } catch (e) {
    console.error('[places/jobs] GET error:', e.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// GET /api/places/jobs/stream — SSE: extension connects, server pushes jobs instantly
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send any currently pending priority job on connect
  db.query(
    `SELECT id, keyword, city, query, priority FROM maps_jobs
     WHERE status = 'pending' AND priority >= 1 AND expires_at > NOW()
       AND NOT EXISTS (
         SELECT 1 FROM maps_jobs j2
         WHERE j2.status = 'claimed' AND j2.expires_at > NOW()
       )
     ORDER BY priority DESC, created_at ASC LIMIT 1`
  ).then(([rows]) => {
    if (rows.length && !res.writableEnded) {
      const r = rows[0];
      res.write(`data: ${JSON.stringify({ job: {
        id: r.id, type: 'maps', keyword: r.keyword, city: r.city,
        query: r.query, priority: r.priority,
      }})}\n\n`);
    }
  }).catch(() => {});

  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 10000);

  jobListeners.add(res);
  req.on('close', () => { clearInterval(hb); jobListeners.delete(res); });
});

// POST /api/places/jobs/:id/claim — extension claims a specific pushed job
router.post('/:id/claim', async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE maps_jobs SET status = 'claimed', claimed_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [req.params.id]
    );
    res.json({ ok: result.affectedRows > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/places/jobs/:id/done — mark job completed
router.post('/:id/done', async (req, res) => {
  const { placesIngested = 0 } = req.body;
  try {
    await db.query(
      `UPDATE maps_jobs SET status = 'done', completed_at = NOW(), places_ingested = ? WHERE id = ?`,
      [placesIngested, req.params.id]
    );
    res.json({ ok: true });

    // Background: index any pending places into Qdrant
    setImmediate(async () => {
      const { indexPendingPlaces } = require('../services/placesRag');
      await indexPendingPlaces().catch(e => console.error('[places/jobs] index error:', e.message));
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update job' });
  }
});

module.exports = router;
