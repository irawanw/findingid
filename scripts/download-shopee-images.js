'use strict';
/**
 * Batch download Shopee images for existing products.
 * Targets: source=shopee, sold_count > 10, rating > 4, no local image yet.
 *
 * Usage: node scripts/download-shopee-images.js
 * Options:
 *   --concurrency=5   parallel downloads (default 5)
 *   --dry-run         print count only, no downloads
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const mysql   = require('/data/www/findingid/backend/node_modules/mysql2/promise');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const UPLOADS_DIR  = path.join(__dirname, '../uploads/products');
const CONCURRENCY  = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '5');
const DRY_RUN      = process.argv.includes('--dry-run');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────
function shopeeImage500(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.includes('susercontent.com')) {
    return url.replace(/_tn$/, '').replace(/@resize_w\d+_nl/, '') + '@resize_w500_nl';
  }
  const m = url.match(/cf\.shopee\.co\.id\/file\/(.+?)(_tn)?$/i);
  if (m) return `https://down-id.img.susercontent.com/file/${m[1]}@resize_w500_nl`;
  return null;
}

function imageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0,4).toString() === 'RIFF' && buf.slice(8,12).toString() === 'WEBP') return '.webp';
  return '.jpg';
}

function alreadyCached(id) {
  for (const ext of ['.jpg', '.png', '.webp']) {
    if (fs.existsSync(path.join(UPLOADS_DIR, `${id}${ext}`))) return true;
  }
  return false;
}

// ── Pool worker ────────────────────────────────────────────────
async function downloadOne(db, product, stats) {
  const { id, image_url } = product;

  if (alreadyCached(id)) {
    stats.skipped++;
    return;
  }

  const url500 = shopeeImage500(image_url);
  if (!url500) {
    stats.failed++;
    return;
  }

  try {
    const res = await fetch(url500, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://shopee.co.id/',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      stats.failed++;
      process.stdout.write(`✗ ${id} HTTP ${res.status}\n`);
      return;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      stats.failed++;
      return;
    }

    const ext  = imageExt(buf);
    const dest = path.join(UPLOADS_DIR, `${id}${ext}`);
    fs.writeFileSync(dest, buf);

    await db.query(
      'UPDATE products SET image_url = ? WHERE id = ?',
      [`/uploads/products/${id}${ext}`, id]
    );

    stats.done++;
    if (stats.done % 50 === 0) {
      process.stdout.write(`  ✓ ${stats.done} downloaded, ${stats.failed} failed, ${stats.skipped} skipped\n`);
    }
  } catch (err) {
    stats.failed++;
    // silent — timeouts, network errors expected for some products
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  const [rows] = await db.query(`
    SELECT id, image_url
    FROM products
    WHERE source = 'shopee'
      AND is_active = 1
      AND sold_count > 10
      AND rating > 4
      AND image_url IS NOT NULL
      AND image_url != ''
      AND image_url NOT LIKE '/uploads/%'
    ORDER BY (rating * 0.5 + LOG(1 + sold_count) * 0.5) DESC
  `);

  console.log(`Found ${rows.length} Shopee products to download (sold>10, rating>4)`);

  if (DRY_RUN) {
    console.log('Dry run — exiting.');
    await db.end();
    return;
  }

  const stats = { done: 0, failed: 0, skipped: 0 };
  const queue = [...rows];

  // Process with fixed concurrency
  async function worker() {
    while (queue.length) {
      const product = queue.shift();
      if (product) await downloadOne(db, product, stats);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await Promise.all(workers);

  console.log(`\n✅ Done: ${stats.done} downloaded, ${stats.failed} failed, ${stats.skipped} already cached`);
  await db.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
