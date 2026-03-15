'use strict';
/**
 * refetch_hires_images.js
 * Re-downloads product images at full resolution (1500px) from Shopee CDN.
 * Uses source_images_json if present, otherwise reconstructs URLs from images_json.
 *
 * Usage:
 *   node tools/refetch_hires_images.js            -- all products with local images
 *   node tools/refetch_hires_images.js 7695        -- single product
 *   node tools/refetch_hires_images.js --limit=50  -- first 50 products
 */

require(__dirname + '/../backend/node_modules/dotenv').config({ path: __dirname + '/../backend/.env' });
const db   = require(__dirname + '/../backend/services/db');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const IMAGE_DIR  = path.join(__dirname, '../video/public/uploads/products');
const CONCURRENCY = 3;
const DELAY_MS    = 200;

const singleId = process.argv[2] && !process.argv[2].startsWith('--') ? parseInt(process.argv[2]) : null;
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT    = limitArg ? parseInt(limitArg.replace('--limit=', '')) : 99999;

// Convert any known Shopee URL → 1500px version
function toHiRes(url) {
  if (!url) return null;
  if (!url.startsWith('http')) return null; // already local path, skip
  // Strip existing resize suffix and replace with 1500px
  return url.replace(/@resize_w\d+[^"']*/g, '') + '@resize_w1500_nl.webp';
}

// Download a URL to a local file, returns file size or null on error
function downloadFile(url, dest) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest).then(resolve);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return resolve(null);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(fs.statSync(dest).size); });
    });
    req.on('error', () => { file.close(); fs.unlink(dest, () => {}); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

// Derive local file path from images_json entry (local path like /uploads/products/7695.jpg)
function localPathToFilename(localPath) {
  return path.basename(localPath); // e.g. "7695.jpg", "7695_1.jpg"
}

async function processProduct(p) {
  // Prefer source_images_json (CDN URLs), fall back to images_json (local paths — need to reconstruct)
  let cdnUrls = [];

  if (p.source_images_json) {
    try { cdnUrls = JSON.parse(p.source_images_json); } catch {}
  }

  // If no source URLs, try to reconstruct from images_json local paths
  // Local: /uploads/products/7695_1.jpg → we can't get CDN URL without source_item_id + shopid
  // Best we can do: skip (these will get source_images_json next time extension runs)
  if (!cdnUrls.length) {
    console.log(`  [${p.id}] No source_images_json, skipping (re-scrape to populate)`);
    return 0;
  }

  // Map each CDN URL to its expected local filename
  let downloaded = 0;
  let localImages = [];
  try { localImages = JSON.parse(p.images_json || '[]'); } catch {}

  for (let i = 0; i < cdnUrls.length; i++) {
    const cdnUrl = toHiRes(cdnUrls[i]);
    if (!cdnUrl) continue;

    // Determine local filename from images_json index or fallback pattern
    const localPath = localImages[i] || null;
    const filename  = localPath
      ? localPathToFilename(localPath)
      : (i === 0 ? `${p.id}.jpg` : `${p.id}_${i}.jpg`);

    const dest = path.join(IMAGE_DIR, filename);

    // Check existing file size — skip if already large (>150KB = likely already hi-res)
    if (fs.existsSync(dest)) {
      const existing = fs.statSync(dest).size;
      if (existing > 150 * 1024) {
        process.stdout.write('.');
        continue;
      }
    }

    const size = await downloadFile(cdnUrl, dest);
    if (size) {
      downloaded++;
      process.stdout.write(`↑`);
    } else {
      process.stdout.write(`✗`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  return downloaded;
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  let query = `SELECT id, source_item_id, images_json, source_images_json
               FROM products
               WHERE is_active = 1 AND images_json IS NOT NULL`;
  const params = [];

  if (singleId) {
    query += ' AND id = ?';
    params.push(singleId);
  } else {
    query += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(LIMIT);
  }

  const [rows] = await db.query(query, params);
  console.log(`[refetch] ${rows.length} products to process`);

  let totalDownloaded = 0;
  let done = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(p => {
      process.stdout.write(`\n[${p.id}] `);
      return processProduct(p);
    }));
    totalDownloaded += results.reduce((a, b) => a + b, 0);
    done += batch.length;
    if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\n\n[refetch] Done — ${done} products, ${totalDownloaded} images re-downloaded at 1500px`);
  process.exit(0);
}

main().catch(e => { console.error('[refetch] ERROR:', e.message); process.exit(1); });
