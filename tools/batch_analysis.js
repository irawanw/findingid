'use strict';
/**
 * Batch AI analysis generator for all eligible products.
 * Run: node tools/batch_analysis.js
 */
require(__dirname + '/../backend/node_modules/dotenv').config({ path: __dirname + '/../backend/.env' });
const db       = require(__dirname + '/../backend/services/db');
const analysis = require(__dirname + '/../backend/services/productAnalysis');

const CONCURRENCY = 2;   // parallel requests to LLM
const DELAY_MS    = 500; // ms between batches

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const [rows] = await db.query(`
    SELECT id FROM products
    WHERE is_active = 1
      AND description IS NOT NULL AND LENGTH(description) >= 30
      AND (ai_analysis IS NULL OR ai_analysis_at < DATE_SUB(NOW(), INTERVAL 7 DAY))
    ORDER BY sold_count DESC, rating DESC
  `);

  const total = rows.length;
  console.log(`[batch] ${total} products to process`);
  if (!total) { process.exit(0); }

  let done = 0, skipped = 0, failed = 0;
  const start = Date.now();

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(r => analysis.generateAndSave(r.id))
    );

    for (const res of results) {
      if (res.status === 'fulfilled') {
        if (res.value === null) skipped++;
        else done++;
      } else {
        failed++;
      }
    }

    const elapsed  = ((Date.now() - start) / 1000).toFixed(0);
    const progress = Math.min(i + CONCURRENCY, total);
    const pct      = ((progress / total) * 100).toFixed(1);
    const rate     = done / (elapsed / 60);
    const remaining = total - progress;
    const etaMin   = rate > 0 ? (remaining / rate).toFixed(0) : '?';

    console.log(`[batch] ${progress}/${total} (${pct}%) | done=${done} skipped=${skipped} failed=${failed} | elapsed=${elapsed}s ETA=${etaMin}min`);

    if (i + CONCURRENCY < rows.length) await sleep(DELAY_MS);
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[batch] DONE — ${done} generated, ${skipped} skipped, ${failed} failed in ${totalSec}s`);
  process.exit(0);
}

main().catch(e => { console.error('[batch] fatal:', e.message); process.exit(1); });
