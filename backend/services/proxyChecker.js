'use strict';
/**
 * Proxy Manager — fetches Indonesian proxies from proxifly/free-proxy-list,
 * health-checks each one via TCP connect, stores results in the proxies table.
 *
 * Flow:
 *   1. fetchAndUpsert()  — pulls GitHub JSON, upserts rows into DB
 *   2. checkAll()        — TCP-connects each unchecked/stale proxy, records latency
 *   3. refresh()         — runs both steps; called hourly from server.js
 *
 * Extension polls GET /api/proxies/healthy for a fresh list of working proxies.
 */

const net = require('net');
const db  = require('./db');

const PROXY_LIST_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/ID/data.json';
const TCP_TIMEOUT_MS = 4000;   // per proxy TCP connect timeout
const STALE_MINUTES  = 90;     // re-check proxies older than this
const MAX_FAIL_COUNT = 3;      // drop proxy from healthy pool after N consecutive fails
const CONCURRENCY    = 10;     // parallel TCP checks

// ── TCP health check ──────────────────────────────────────────────
function tcpCheck(ip, port) {
  return new Promise((resolve) => {
    const start  = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latency: Date.now() - start });
    };

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.connect(port, ip, () => finish(true));
    socket.on('error',   () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

// ── Fetch + upsert proxy list from GitHub ─────────────────────────
async function fetchAndUpsert() {
  const res = await fetch(PROXY_LIST_URL, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'finding.id/proxy-checker' },
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: HTTP ${res.status}`);

  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error('Empty proxy list');

  // Only use HTTP proxies — Chrome proxy API supports http/https, not socks
  const httpProxies = list.filter(p => p.protocol === 'http' || p.protocol === 'https');

  let upserted = 0;
  for (const p of httpProxies) {
    await db.query(
      `INSERT INTO proxies (ip, port, protocol, anonymity, score, last_seen)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON CONFLICT (ip, port) DO UPDATE SET
         protocol  = EXCLUDED.protocol,
         anonymity = EXCLUDED.anonymity,
         score     = EXCLUDED.score,
         last_seen = NOW()`,
      [p.ip, p.port, p.protocol, p.anonymity || null, p.score || 0]
    );
    upserted++;
  }

  console.log(`[proxy] upserted ${upserted} proxies from GitHub (total in list: ${list.length})`);
  return upserted;
}

// ── TCP-check all stale/unchecked proxies ─────────────────────────
async function checkAll() {
  const [rows] = await db.query(
    `SELECT id, ip, port FROM proxies
     WHERE last_checked IS NULL
        OR last_checked < NOW() - INTERVAL '${STALE_MINUTES} minutes'
     ORDER BY last_checked ASC`
  );

  if (!rows.length) {
    console.log('[proxy] all proxies fresh, nothing to check');
    return;
  }

  console.log(`[proxy] checking ${rows.length} proxies (concurrency=${CONCURRENCY})`);

  // Process in parallel batches
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const { ok, latency } = await tcpCheck(row.ip, row.port);
      await db.query(
        `UPDATE proxies SET
           is_healthy   = ?,
           latency_ms   = ?,
           fail_count   = CASE WHEN ? THEN 0 ELSE LEAST(fail_count + 1, 10) END,
           last_checked = NOW()
         WHERE id = ?`,
        [ok, ok ? latency : null, ok, row.id]
      );
    }));
  }

  const [[{ healthy, total }]] = await db.query(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN is_healthy = true AND fail_count < ${MAX_FAIL_COUNT} THEN 1 ELSE 0 END) as healthy
     FROM proxies`,
    []
  );
  console.log(`[proxy] check done — ${healthy}/${total} healthy`);
}

// ── Full refresh: fetch + check ───────────────────────────────────
async function refresh() {
  try {
    await fetchAndUpsert();
  } catch (e) {
    console.error('[proxy] fetch error:', e.message);
  }
  try {
    await checkAll();
  } catch (e) {
    console.error('[proxy] check error:', e.message);
  }
}

// ── Get healthy proxy list for API/extension ──────────────────────
async function getHealthy() {
  const [rows] = await db.query(
    `SELECT ip, port, protocol, latency_ms, anonymity
     FROM proxies
     WHERE is_healthy = 1
       AND fail_count < ?
       AND last_checked > NOW() - INTERVAL ? MINUTE
     ORDER BY latency_ms ASC`,
    [MAX_FAIL_COUNT, STALE_MINUTES]
  );
  return rows;
}

module.exports = { refresh, fetchAndUpsert, checkAll, getHealthy };
