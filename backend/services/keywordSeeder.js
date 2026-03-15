'use strict';
const db       = require('./db');
const cache    = require('./cache');
const telegram = require('./telegram');
const { v4: uuidv4 } = require('uuid');

// 1 keyword per 25-30 minute cycle (randomised to avoid predictable patterns)
const COOLDOWN_H   = 24;   // re-seed after 24h (full cycle ~5-6 days for 822 keywords)
const LOCK_KEY     = 'seeder:lock';
const LOCK_TTL_S   = 50; // 50 seconds — releases well before next 1-3 min cycle

/**
 * One seeder cycle:
 *   1. Acquire Redis lock (only one PM2 worker runs per cycle)
 *   2. Pick the next unseeded keyword
 *   3. Insert one search_job + push to Redis queue
 *   4. Update last_seeded
 */
async function runCycle() {
  const redis = cache.getClient();

  // Check pause flag
  const paused = await redis.get('seeder:paused');
  if (paused) { console.log('[seeder] paused — skipping cycle'); return; }

  // Distributed lock — SET NX so only one worker per cluster fires
  const locked = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_S, 'NX');
  if (!locked) return; // another worker already handling this cycle

  try {
    const [rows] = await db.query(
      `SELECT id, keyword FROM keyword_seeds
       WHERE last_seeded IS NULL
          OR last_seeded < DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY seed_count ASC, priority DESC, last_seeded ASC
       LIMIT 1`,
      [COOLDOWN_H]
    );

    if (!rows.length) {
      console.log('[seeder] all keywords recently seeded, skipping cycle');
      return;
    }

    const row    = rows[0];
    const jobId  = uuidv4();
    const sources = ['shopee'];

    try {
      await db.query(
        `INSERT INTO search_jobs (id, query, sources, status, priority, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', 0, NOW(), DATE_ADD(NOW(), INTERVAL 3600 SECOND))`,
        [jobId, row.keyword, JSON.stringify(sources)]
      );
    } catch (err) {
      console.error('[seeder] insert job error:', err.message);
      return;
    }

    try {
      await redis.lpush('jobs:pending', jobId);
      await cache.set(`job:${jobId}`, {
        id: jobId, query: row.keyword, sources, status: 'pending', created: Date.now(),
      }, 3600);
    } catch {}

    await db.query(
      `UPDATE keyword_seeds SET last_seeded = NOW(), seed_count = seed_count + 1 WHERE id = ?`,
      [row.id]
    );

    console.log(`[seeder] queued "${row.keyword}" → job ${jobId}`);

  } catch (err) {
    console.error('[seeder] cycle error:', err.message);
  }
}

/**
 * Start the seeder on a 10-minute interval.
 * Runs immediately on startup so first keyword is queued right away.
 */
async function start() {
  const [[{ pending }]] = await db.query(
    `SELECT COUNT(*) AS pending FROM keyword_seeds
     WHERE last_seeded IS NULL OR last_seeded < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [COOLDOWN_H]
  ).catch(() => [[{ pending: '?' }]]);

  console.log(`[seeder] starting — ${pending} keywords pending, 1 per 8-14 min (random)`);

  runCycle(); // run immediately (Redis NX lock ensures only one worker fires)

  // Sync click-based seeds at startup, then once every 24h
  syncClickSeeds();
  setInterval(syncClickSeeds, 24 * 60 * 60 * 1000);

  // Schedule next cycle with a random delay, then repeat with new random delay each time
  function scheduleNext() {
    const delayMs = (25 + Math.random() * 5) * 60 * 1000; // 25–30 minutes
    setTimeout(() => { runCycle(); scheduleNext(); }, delayMs);
  }
  scheduleNext();
}

/** Force a cycle regardless of the Redis lock (used by scraper startup). */
async function forceRunCycle() {
  const redis = cache.getClient();
  await redis.del(LOCK_KEY);
  return runCycle();
}

/**
 * Day 9: Sync top-clicked queries from affiliate_click_events into keyword_seeds.
 * Queries clicked by real users are high-signal — prioritise them for scraping.
 * Cap: 50 inserts/run. Runs at startup and daily.
 */
async function syncClickSeeds() {
  const CAP = 50;
  try {
    const [topClicked] = await db.query(
      `SELECT query, COUNT(*) AS clicks
       FROM affiliate_click_events
       WHERE query IS NOT NULL AND query != '' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY query
       ORDER BY clicks DESC
       LIMIT ?`,
      [CAP]
    );

    if (!topClicked.length) return;

    let inserted = 0;
    for (const { query } of topClicked) {
      try {
        await db.query(
          `INSERT INTO keyword_seeds (keyword, category, priority)
           VALUES (?, '', 10)
           ON DUPLICATE KEY UPDATE priority = GREATEST(priority, 10)`,
          [query]
        );
        inserted++;
      } catch (_) {}
    }

    if (inserted > 0) {
      console.log(`[seeder] syncClickSeeds: upserted ${inserted} high-priority seeds from click events`);
    }
  } catch (err) {
    console.error('[seeder] syncClickSeeds error:', err.message);
  }
}

module.exports = { start, runCycle, forceRunCycle, syncClickSeeds };
