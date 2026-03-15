'use strict';
const Redis = require('ioredis');
const cfg   = require('../config/config');

// ================================================================
// Redis Cache Layer
//
// Used for:
//   1. Search result caching (TTL-based, LRU-friendly)
//   2. Rate limiting (sliding window counters)
//   3. Job queue buffering (list-based)
//   4. Deduplication of scraping jobs
//
// Key namespaces:
//   search:{hash}     → cached search response (JSON)
//   rl:{ip}           → rate limit counter
//   jobs:pending      → list of pending job IDs
//   job:{id}          → job details (hash)
// ================================================================

let client;

function getClient() {
  if (!client) {
    client = new Redis(cfg.REDIS.URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    client.on('error',   (err) => console.error('[redis] error:', err.message));
    client.on('connect', ()    => console.log('[redis] connected'));
  }
  return client;
}

/**
 * Get cached value (JSON-parsed).
 */
async function get(key) {
  try {
    const val = await getClient().get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

/**
 * Set cached value (JSON-stringified) with TTL.
 */
async function set(key, value, ttlSeconds = cfg.REDIS.CACHE_TTL) {
  try {
    await getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch { return false; }
}

/**
 * Delete a key.
 */
async function del(key) {
  try { await getClient().del(key); } catch {}
}

/**
 * Increment rate limit counter. Returns current count.
 */
async function incrRateLimit(ip, windowMs) {
  const key    = `rl:${ip}`;
  const r      = getClient();
  const count  = await r.incr(key);
  if (count === 1) await r.pexpire(key, windowMs);
  return count;
}

/**
 * Generate a stable cache key for a search query.
 * Simple normalisation: lowercase + trim.
 */
function searchKey(query) {
  const norm = query.toLowerCase().trim().replace(/\s+/g, ' ');
  return `search:${norm}`;
}

/**
 * Healthcheck.
 */
async function ping() {
  try {
    await getClient().ping();
    return true;
  } catch { return false; }
}

module.exports = { get, set, del, incrRateLimit, searchKey, ping, getClient };
