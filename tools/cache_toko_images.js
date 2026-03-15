'use strict';
process.chdir('/data/www/findingid/backend');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '.env' });

const db   = require('/data/www/findingid/backend/services/db');
const fs   = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../uploads/products');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function run() {
  // Get all Tokopedia products with an external image URL (not yet local)
  const [rows] = await db.query(
    `SELECT id, image_url FROM products
     WHERE source = 'tokopedia'
       AND image_url IS NOT NULL
       AND image_url NOT LIKE '/uploads/%'
       AND is_active = 1
     ORDER BY id ASC`
  );
  console.log(`Downloading images for ${rows.length} Tokopedia products...`);

  let ok = 0, fail = 0, skip = 0;

  for (const row of rows) {
    const dest = path.join(UPLOADS_DIR, `${row.id}.jpg`);
    if (fs.existsSync(dest)) {
      // Already on disk but DB not updated yet
      await db.query('UPDATE products SET image_url = ? WHERE id = ?',
        [`/uploads/products/${row.id}.jpg`, row.id]);
      skip++; continue;
    }
    try {
      const res = await fetch(row.image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { fail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) { fail++; continue; }
      fs.writeFileSync(dest, buf);
      await db.query('UPDATE products SET image_url = ? WHERE id = ?',
        [`/uploads/products/${row.id}.jpg`, row.id]);
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok} cached, ${fail} failed, ${skip} already on disk...`);
    } catch (_) { fail++; }
  }

  console.log(`\nDone: cached=${ok}  failed/broken=${fail}  already_on_disk=${skip}`);
  console.log(`Disk: ${fs.readdirSync(UPLOADS_DIR).length} files in uploads/products/`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
