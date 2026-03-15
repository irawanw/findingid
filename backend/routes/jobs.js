'use strict';
const express        = require('express');
const router         = express.Router();
const { v4: uuidv4 } = require('uuid');
const cache          = require('../services/cache');
const db             = require('../services/db');
const cfg            = require('../config/config');
const seeder         = require('../services/keywordSeeder');
const rag            = require('../services/rag');
const notifier       = require('../services/notifier');
const telegram       = require('../services/telegram');

// Connected extension SSE clients — push jobs to them immediately
const jobListeners = new Set();

// Listen for priority jobs from rag.createScrapingJob
notifier.on('job:priority', (job) => {
  for (const res of jobListeners) {
    try { res.write(`data: ${JSON.stringify({ job })}\n\n`); } catch (_) {}
  }
  console.log(`[jobs/stream] pushed priority job "${job.query}" to ${jobListeners.size} extension(s)`);
});

// ================================================================
// Jobs API — Chrome Extension polling
//
// Job types:
//   list   — scrape search results (query → 60 basic products)
//   detail — enrich products (items[] → pdp/get_pc + ratings)
//
// GET  /api/jobs          → claim next pending job
// POST /api/jobs          → create a new job (used by extension)
// POST /api/jobs/:id/done → mark job complete
// GET  /api/jobs/status   → summary
// ================================================================

// GET /api/jobs — claim next pending job
// ?priority_min=1  → only claim priority >= 1 jobs (used by extension polling)
router.get('/', async (req, res) => {
  try {
    const priorityMin = parseInt(req.query.priority_min, 10) || 0;
    // MySQL — claim highest-priority oldest pending job
    const [rows] = await db.query(
      `SELECT id, type, query, sources, source, items, status, priority, created_at
       FROM search_jobs
       WHERE status = 'pending' AND expires_at > NOW() AND priority >= ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
      [priorityMin]
    );

    if (!rows.length) return res.json({ job: null });

    const row = rows[0];
    await db.query(
      `UPDATE search_jobs SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
      [row.id]
    );

    res.json({
      job: {
        id:       row.id,
        type:     row.type || 'list',
        query:    row.query,
        sources:  JSON.parse(row.sources || '["shopee"]'),
        source:   row.source || null,
        items:    row.items ? JSON.parse(row.items) : null,
        status:   'claimed',
        priority: row.priority ?? 0,
      }
    });

  } catch (err) {
    console.error('[jobs] GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// GET /api/jobs/stream — SSE: extension connects once, backend pushes jobs instantly
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send any currently pending priority job immediately on connect,
  // but only if no job is already claimed (being worked on by any agent).
  db.query(
    `SELECT id, type, query, sources, priority FROM search_jobs
     WHERE status = 'pending' AND priority >= 1 AND expires_at > NOW()
       AND NOT EXISTS (
         SELECT 1 FROM search_jobs s2
         WHERE s2.status = 'claimed' AND s2.expires_at > NOW()
       )
     ORDER BY priority DESC, created_at ASC LIMIT 1`
  ).then(([rows]) => {
    if (rows.length && !res.writableEnded) {
      const row = rows[0];
      res.write(`data: ${JSON.stringify({ job: {
        id: row.id, type: row.type || 'list',
        query: row.query,
        sources: JSON.parse(row.sources || '["shopee","tokopedia"]'),
        priority: row.priority,
      }})}\n\n`);
    }
  }).catch(() => {});

  // Heartbeat every 10s to keep connection alive through proxies
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 10000);

  jobListeners.add(res);

  req.on('close', () => {
    clearInterval(hb);
    jobListeners.delete(res);
  });
});

// POST /api/jobs/:id/claim — extension claims a specific pushed job
router.post('/:id/claim', async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE search_jobs SET status = 'claimed', claimed_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [req.params.id]
    );
    res.json({ ok: result.affectedRows > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/jobs/peek — check next pending job without claiming it
router.get('/peek', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, priority FROM search_jobs
       WHERE status = 'pending' AND expires_at > NOW()
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    );
    res.json({ job: rows.length ? { id: rows[0].id, priority: rows[0].priority } : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs — create a new job
// Used by extension after list scrape to create a detail job
router.post('/', async (req, res) => {
  const { type = 'list', query = '', sources, source, items } = req.body;

  if (type === 'detail' && (!Array.isArray(items) || !items.length)) {
    return res.status(400).json({ error: 'detail job requires items[]' });
  }
  if (type === 'list' && !query) {
    return res.status(400).json({ error: 'list job requires query' });
  }

  const id        = uuidv4();
  const expiresAt = new Date(Date.now() + (cfg.JOBS?.TTL_SECONDS || 300) * 1000);

  try {
    await db.query(
      `INSERT INTO search_jobs (id, type, query, sources, source, items, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        type,
        query || '',
        JSON.stringify(sources || (source ? [source] : ['shopee'])),
        source || null,
        items ? JSON.stringify(items) : null,
        expiresAt,
      ]
    );

    res.json({ ok: true, id, type });
  } catch (err) {
    console.error('[jobs] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// POST /api/jobs/:id/done — mark job completed
router.post('/:id/done', async (req, res) => {
  const { id } = req.params;
  const { productsIngested = 0 } = req.body;

  try {
    // Fetch job details before marking done (query + priority)
    const [[job]] = await db.query(
      `SELECT query, priority FROM search_jobs WHERE id = ? LIMIT 1`,
      [id]
    ).catch(() => [[null]]);

    await db.query(
      `UPDATE search_jobs SET status = 'done', completed_at = NOW(), products_ingested = ? WHERE id = ?`,
      [productsIngested, id]
    ).catch(() => {});

    await cache.del(`job:${id}`);
    res.json({ ok: true });

    // Fire-and-forget: RAG indexing + Telegram fallback notification
    // NOTE: For priority jobs handled by the extension (products > 0), ingest.js fires the
    // notification and marks the job done directly — this endpoint is NOT called for those.
    // This fires for: (a) keyword jobs from scraper.py, (b) priority jobs with 0 products.
    setImmediate(async () => {
      try {
        await rag.indexPendingProducts()
          .then(r => { if (r.indexed) console.log(`[jobs:done] RAG indexed ${r.indexed} new products`); })
          .catch(e => console.error('[jobs:done] RAG index-pending error:', e.message));
      } catch (_) {}

      if (job) {
        try {
          // Read passive ingest stats accumulated by ingest.js during keyword scraping
          let cachedStats = null;
          try {
            const redis = cache.getClient();
            const raw = await redis.get(`job_stats:${id}`);
            if (raw) {
              cachedStats = JSON.parse(raw);
              await redis.del(`job_stats:${id}`);
            }
          } catch (_) {}

          let remainingPriority = 0, remainingKeywords = 0;
          const [[prio]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM search_jobs WHERE status IN ('pending','claimed') AND priority > 0`
          ).catch(() => [[{ cnt: 0 }]]);
          remainingPriority = Number(prio?.cnt || 0);
          const [[kw]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM search_jobs WHERE status IN ('pending','claimed') AND priority = 0`
          ).catch(() => [[{ cnt: 0 }]]);
          remainingKeywords = Number(kw?.cnt || 0);

          await telegram.reportJobDone({
            query:             job.query || '(seeder)',
            isPriority:        (job.priority ?? 0) >= 1,
            total:             cachedStats?.total        ?? productsIngested,
            newCount:          cachedStats?.newCount     ?? 0,
            updatedCount:      cachedStats?.updatedCount ?? 0,
            priceChanged:      cachedStats?.priceChanged ?? 0,
            errors:            0,
            remainingPriority,
            remainingKeywords,
          });
        } catch (e) {
          console.error('[jobs:done] telegram notify error:', e.message);
        }
      }
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// POST /api/jobs/seed — force seeder cycle immediately (clears Redis lock first)
router.post('/seed', async (req, res) => {
  try {
    await seeder.forceRunCycle();
    res.json({ ok: true });
  } catch (err) {
    console.error('[jobs] seed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/status — admin view
router.get('/status', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT type, status, COUNT(*) as count
       FROM search_jobs
       WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
       GROUP BY type, status`
    );
    res.json({ statuses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
