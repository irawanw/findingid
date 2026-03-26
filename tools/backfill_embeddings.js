#!/usr/bin/env node
'use strict';
/**
 * Backfill products.embedding for all 120k products.
 *
 * Flow:
 *   1. Read products in batches of 64 (no embedding yet)
 *   2. POST title + category + description to /embed (BGE-M3)
 *   3. UPDATE products SET embedding = $1 WHERE id = $2
 *
 * Resume-safe: skips products where embedding IS NOT NULL.
 * Run: node tools/backfill_embeddings.js
 */

require('/data/www/findingid/backend/node_modules/dotenv').config({
  path: '/data/www/findingid/backend/.env',
});

const { Pool } = require('/data/www/findingid/backend/node_modules/pg');
// Node 20 has built-in fetch — no external dep needed

const EMBED_URL  = 'http://127.0.0.1:8002/embed';
const BATCH      = 64;   // texts per embed call — fits in BGE-M3 CPU memory
const PG_CONCUR  = 8;    // parallel UPDATE statements

const pg = new Pool({
  host:     process.env.PG_HOST || '127.0.0.1',
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_NAME || 'findingid',
  user:     process.env.PG_USER || 'findingid',
  password: process.env.PG_PASS,
  max:      PG_CONCUR + 2,
});

async function embedBatch(texts) {
  const res = await fetch(EMBED_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ texts }),
    signal:  AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const { embeddings } = await res.json();
  return embeddings; // float[][]
}

async function main() {
  const t0 = Date.now();

  const { rows: [{ total }] } = await pg.query(
    `SELECT COUNT(*) AS total FROM products WHERE is_active = true AND embedding IS NULL`
  );
  console.log(`Products needing embeddings: ${Number(total).toLocaleString()}`);
  if (total == 0) { console.log('Nothing to do.'); await pg.end(); return; }

  let done = 0, errors = 0, offset = 0;

  while (true) {
    // Fetch next batch of products without embeddings
    const { rows } = await pg.query(
      `SELECT id, title, category, description
       FROM products
       WHERE is_active = true AND embedding IS NULL
       ORDER BY id ASC
       LIMIT $1`,
      [BATCH]
    );
    if (!rows.length) break;

    // Build text for each product: title + category + truncated description
    const texts = rows.map(r => {
      const cat  = r.category    ? ` [${r.category}]` : '';
      const desc = r.description ? ' ' + String(r.description).slice(0, 300) : '';
      return (r.title + cat + desc).trim();
    });

    // Embed
    let vecs;
    try {
      vecs = await embedBatch(texts);
    } catch (err) {
      errors += rows.length;
      console.error(`\n  embed error: ${err.message} — skipping batch`);
      // Mark these as 'attempted' by setting a zero vector so we don't loop forever
      // Actually just offset so we skip — but since we order by id and filter IS NULL,
      // failed ones will be retried next run. Just abort this batch.
      offset += rows.length;
      continue;
    }

    // Update in parallel
    await Promise.all(rows.map(async (r, i) => {
      const vec = vecs[i];
      if (!vec || vec.length !== 1024) { errors++; return; }
      try {
        await pg.query(
          `UPDATE products SET embedding = $1 WHERE id = $2`,
          [`[${vec.join(',')}]`, r.id]
        );
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`\n  update id=${r.id}: ${e.message}`);
      }
    }));

    done += rows.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const pct = ((done / Number(total)) * 100).toFixed(1);
    const eta = done > 0
      ? Math.round((Number(total) - done) * (Date.now() - t0) / done / 1000)
      : '?';
    process.stdout.write(
      `\r  ${done.toLocaleString()} / ${Number(total).toLocaleString()} (${pct}%) — ${elapsed}s elapsed, ~${eta}s remaining, ${errors} errors`
    );
  }

  const { rows: [{ filled }] } = await pg.query(
    `SELECT COUNT(*) AS filled FROM products WHERE embedding IS NOT NULL`
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nDone: ${done.toLocaleString()} embedded, ${errors} errors`);
  console.log(`Total products with embedding: ${Number(filled).toLocaleString()}`);
  console.log(`Elapsed: ${elapsed}s`);

  await pg.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
