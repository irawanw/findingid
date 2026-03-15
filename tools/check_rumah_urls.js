#!/usr/bin/env node
'use strict';
/**
 * Rumah URL Checker
 * Checks each rumah record's source URL and updates url_status in DB.
 *
 * Usage:
 *   node check_rumah_urls.js             # check all unchecked
 *   node check_rumah_urls.js --retry     # also retry timeouts
 *   node check_rumah_urls.js --all       # recheck everything
 *
 * url_status values:
 *   unchecked  — not yet checked
 *   active     — HTTP 200/301/302 received
 *   dead       — HTTP 404/410/403/gone or connection refused
 *   timeout    — no response within timeout
 *   redirect   — redirected to a different domain (likely dead listing)
 */

const http    = require('http');
const https   = require('https');
const mysql   = require('/data/www/findingid/backend/node_modules/mysql2/promise');
const path    = require('path');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '/data/www/findingid/backend/.env' });

const CONCURRENCY  = 8;    // parallel requests (lowered for 99.co rate limits)
const TIMEOUT_MS   = 10000; // per request
const BATCH_SIZE   = 200;  // fetch from DB at a time
const RETRY_DELAY  = 50;   // ms between batches

const args      = process.argv.slice(2);
const retryTimeout = args.includes('--retry');
const recheckAll   = args.includes('--all');

// Domains known to be completely dead — mark immediately without checking
const DEAD_DOMAINS = new Set([
  'www.urbanindo.com', 'urbanindo.com',
  'www.mitula.co.id', 'mitula.co.id',
  'id.mitula.net',
  'www.rumahdijual.com',  // shut down
  'rumahdijual.com',
]);

// These domains return 200 even for deleted listings (soft 404) — need content check
const SOFT_404_DOMAINS = new Set([
  'www.99.co', '99.co',
  'www.lamudi.co.id', 'lamudi.co.id',
  'www.rumah123.com', 'rumah123.com',
]);

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function checkUrl(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      resolve(status);
    };

    const domain = getDomain(url);
    if (!domain) return finish('dead');
    if (DEAD_DOMAINS.has(domain)) return finish('dead');

    let parsed;
    try { parsed = new URL(url); } catch { return finish('dead'); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'HEAD',
      timeout:  TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept':     'text/html',
      },
    };

    const req = lib.request(options, (res) => {
      const code = res.statusCode;
      // Consume response body to free socket
      res.resume();

      if (code === 200) {
        // For soft-404 domains we trust 200 for now (can refine later)
        return finish('active');
      }
      if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
        const loc = res.headers['location'] || '';
        // If redirected to homepage or completely different domain → dead listing
        const origDomain = getDomain(url);
        const redirDomain = getDomain(loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.hostname}${loc}`);
        if (redirDomain && origDomain && redirDomain !== origDomain) {
          return finish('redirect'); // cross-domain redirect = listing gone
        }
        return finish('active'); // same-domain redirect = still alive
      }
      if (code === 404 || code === 410 || code === 403 || code === 451) {
        return finish('dead');
      }
      // Other codes (500, 503, etc.) — treat as timeout/unknown
      return finish('timeout');
    });

    req.on('timeout', () => { req.destroy(); finish('timeout'); });
    req.on('error',   () => finish('dead'));
    req.end();
  });
}

async function run() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  // Build WHERE clause
  let where = "url IS NOT NULL AND url != ''";
  if (recheckAll) {
    // check everything
  } else if (retryTimeout) {
    where += " AND url_status IN ('unchecked','timeout')";
  } else {
    where += " AND url_status = 'unchecked'";
  }

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) as total FROM rumah WHERE ${where}`
  );
  console.log(`\n[checker] ${total} URLs to check (concurrency=${CONCURRENCY})`);
  if (!total) { console.log('[checker] nothing to do'); await db.end(); return; }

  let checked = 0, active = 0, dead = 0, timeout = 0, redirect = 0, nourl = 0;
  const start = Date.now();

  // Process in batches
  let offset = 0;
  while (true) {
    const [rows] = await db.query(
      `SELECT rumah_id, url FROM rumah WHERE ${where} ORDER BY rumah_id LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );
    if (!rows.length) break;

    // Process batch with concurrency limit
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (row) => {
        if (!row.url) {
          await db.query('UPDATE rumah SET url_status=? WHERE rumah_id=?', ['dead', row.rumah_id]);
          nourl++; checked++;
          return;
        }
        const status = await checkUrl(row.url);
        await db.query('UPDATE rumah SET url_status=? WHERE rumah_id=?', [status, row.rumah_id]);
        checked++;
        if (status === 'active')   active++;
        if (status === 'dead')     dead++;
        if (status === 'timeout')  timeout++;
        if (status === 'redirect') { redirect++; dead++; }
      }));

      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const rate    = (checked / elapsed).toFixed(1);
      const eta     = Math.round((total - checked) / rate);
      process.stdout.write(
        `\r  checked=${checked}/${total} active=${active} dead=${dead} timeout=${timeout} | ${rate}/s ETA=${eta}s   `
      );
    }

    offset += rows.length;
    await new Promise(r => setTimeout(r, RETRY_DELAY));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\n[checker] Done in ${elapsed}s`);
  console.log(`  active:   ${active}`);
  console.log(`  dead:     ${dead}`);
  console.log(`  timeout:  ${timeout}`);
  console.log(`  redirect: ${redirect}`);

  // Final summary from DB
  const [summary] = await db.query(
    'SELECT url_status, COUNT(*) as cnt FROM rumah GROUP BY url_status ORDER BY cnt DESC'
  );
  console.log('\n[checker] DB summary:');
  summary.forEach(r => console.log(`  ${r.url_status}: ${r.cnt}`));

  await db.end();
}

run().catch(e => { console.error('[checker] fatal:', e.message); process.exit(1); });
