'use strict';
/**
 * /api/scraper — distributed mouse lock for multi-instance scraper.py
 *
 * When 2 shopee_scraper.py instances run in the same Windows session they share
 * one mouse cursor.  Before starting any mouse-heavy browsing each instance
 * acquires a Redis lock; only one holds it at a time.
 *
 * POST   /api/scraper/lock   { agent, ttl? }  → { held: bool, holder? }
 * DELETE /api/scraper/lock   { agent }         → { ok: bool }
 */
const express = require('express');
const router  = express.Router();
const cache   = require('../services/cache');
const cfg     = require('../config/config');

const LOCK_KEY     = 'scraper_mouse_lock';
const DEFAULT_TTL  = 12 * 60; // 12 min — enough for one full scrape cycle

function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Acquire lock — NX so only first caller wins
router.post('/lock', authCheck, async (req, res) => {
  const { agent, ttl = DEFAULT_TTL } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent required' });

  const redis = cache.getClient();
  try {
    // If same agent already holds it, refresh TTL (idempotent heartbeat)
    const holder = await redis.get(LOCK_KEY);
    if (holder === agent) {
      await redis.expire(LOCK_KEY, ttl);
      return res.json({ held: true, agent });
    }
    const set = await redis.set(LOCK_KEY, agent, 'EX', ttl, 'NX');
    if (set === 'OK') return res.json({ held: true, agent });
    return res.json({ held: false, holder });
  } catch (e) {
    // Redis down — grant lock so scraper doesn't hang forever
    console.error('[scraper-lock] Redis error:', e.message);
    return res.json({ held: true, agent, warn: 'redis_error' });
  }
});

// Release lock
router.delete('/lock', authCheck, async (req, res) => {
  const { agent } = req.body;
  const redis = cache.getClient();
  try {
    const holder = await redis.get(LOCK_KEY);
    if (!agent || holder === agent) {
      await redis.del(LOCK_KEY);
      return res.json({ ok: true });
    }
    return res.json({ ok: false, reason: 'not_holder', holder });
  } catch (e) {
    return res.json({ ok: true, warn: 'redis_error' });
  }
});

// Scraper enabled flag — lets the extension toggle control shopee_scraper.py
const ENABLED_KEY = 'scraper_enabled';

router.get('/enabled', authCheck, async (req, res) => {
  const redis = cache.getClient();
  try {
    const val = await redis.get(ENABLED_KEY);
    // Default: enabled (null = never set = on)
    return res.json({ enabled: val !== '0' });
  } catch (_) {
    return res.json({ enabled: true });
  }
});

router.post('/enabled', authCheck, async (req, res) => {
  const { enabled } = req.body;
  const redis = cache.getClient();
  try {
    await redis.set(ENABLED_KEY, enabled ? '1' : '0');
    return res.json({ ok: true, enabled });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
