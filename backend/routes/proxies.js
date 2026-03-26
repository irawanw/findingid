'use strict';
const express      = require('express');
const router       = express.Router();
const db           = require('../services/db');
const proxyChecker = require('../services/proxyChecker');
const cfg          = require('../config/config');

function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/proxies/healthy — returns working proxy list for extension
router.get('/healthy', authCheck, async (req, res) => {
  try {
    const proxies = await proxyChecker.getHealthy();
    res.json({ proxies, count: proxies.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/proxies — admin: full list with health status
router.get('/', authCheck, async (req, res) => {
  const [rows] = await db.query(
    `SELECT id, ip, port, protocol, anonymity, score,
            is_healthy, latency_ms, fail_count,
            last_checked, last_seen
     FROM proxies
     ORDER BY is_healthy DESC, latency_ms ASC`
  );
  const healthy = rows.filter(r => r.is_healthy && r.fail_count < 3).length;
  res.json({ proxies: rows, total: rows.length, healthy });
});

// POST /api/proxies/refresh — manually trigger a refresh + health check
router.post('/refresh', authCheck, async (req, res) => {
  res.json({ ok: true, message: 'Refresh started' });
  proxyChecker.refresh().catch(e => console.error('[proxy] manual refresh error:', e.message));
});

// POST /api/proxies/report — extension reports a proxy as failed
router.post('/report', authCheck, async (req, res) => {
  const { ip, port } = req.body;
  if (!ip || !port) return res.status(400).json({ error: 'ip and port required' });
  await db.query(
    `UPDATE proxies SET
       fail_count = LEAST(fail_count + 1, 10),
       is_healthy = CASE WHEN fail_count + 1 >= 3 THEN false ELSE is_healthy END
     WHERE ip = ? AND port = ?`,
    [ip, port]
  );
  res.json({ ok: true });
});

module.exports = router;
