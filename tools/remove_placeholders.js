'use strict';
process.chdir('/data/www/findingid/backend');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '.env' });

const db   = require('/data/www/findingid/backend/services/db');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = '/data/www/findingid/uploads/products';

// Known Tokopedia placeholder image hashes
const PLACEHOLDER_HASHES = new Set([
  '7df85ac1de99b6c204f61abeaae3501f',  // main "no image" placeholder
]);

// Also detect by size: any file < 6KB is almost certainly a placeholder
// (real 200x200 product photos are 8KB+)
const MAX_PLACEHOLDER_BYTES = 6000;

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

async function run() {
  const files = fs.readdirSync(DIR);
  console.log(`Scanning ${files.length} cached images...`);

  let removed = 0, kept = 0;
  const ids = [];

  for (const file of files) {
    const m = file.match(/^(\d+)\.(jpg|png|webp)$/);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    const filePath = path.join(DIR, file);

    try {
      const stat = fs.statSync(filePath);
      if (stat.size >= MAX_PLACEHOLDER_BYTES) { kept++; continue; }

      const buf = fs.readFileSync(filePath);
      const hash = md5(buf);
      if (!PLACEHOLDER_HASHES.has(hash) && stat.size >= MAX_PLACEHOLDER_BYTES) { kept++; continue; }

      fs.unlinkSync(filePath);
      ids.push(id);
      removed++;
    } catch (_) {}
  }

  if (ids.length) {
    // Batch update in chunks of 500
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.query(
        `UPDATE products SET image_url = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
    }
  }

  console.log(`Done: removed ${removed} placeholder files, kept ${kept} real images`);
  console.log(`${ids.length} product image_urls reset to NULL`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
