'use strict';
/**
 * Batch backfill AI analysis for enriched products.
 * Run from project root: node backend/tools/backfill-analysis.js
 * OR run as: cd /data/www/findingid/backend && node ../tools/backfill-analysis.js
 *
 * NOTE: Must be run from the backend/ directory so node_modules resolves correctly.
 * The package.json script below handles this automatically.
 *
 * Processes products that have description + reviews but no ai_analysis yet.
 * Sequential (one at a time) to avoid overloading vLLM.
 */

const db              = require('./services/db');
const productAnalysis = require('./services/productAnalysis');

const BATCH_LIMIT = 500;  // max products per run
const DELAY_MS    = 2000; // ms between each product

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('[backfill] Starting AI analysis backfill...\n');

  const [rows] = await db.query(
    `SELECT id, title FROM products
     WHERE is_active = 1
       AND price >= 300000
       AND rating >= 4.5
       AND sold_count >= 100
       AND description IS NOT NULL
       AND description != ''
       AND LENGTH(description) >= 30
       AND reviews_json IS NOT NULL
       AND ai_analysis IS NULL
     ORDER BY sold_count DESC, rating DESC
     LIMIT ?`,
    [BATCH_LIMIT]
  );

  console.log(`[backfill] Found ${rows.length} products to process.\n`);
  if (!rows.length) {
    console.log('[backfill] Nothing to do. Exiting.');
    process.exit(0);
  }

  let ok = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const { id, title } = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] id=${id} "${title.slice(0, 50)}" ... `);

    const result = await productAnalysis.generateAndSave(id);

    if (result) {
      ok++;
      console.log('OK');
    } else {
      failed++;
      console.log('SKIP/FAIL');
    }

    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n[backfill] Done. OK=${ok} SKIP/FAIL=${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
