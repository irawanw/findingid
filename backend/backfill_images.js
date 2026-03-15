'use strict';
process.chdir('/data/www/findingid/backend');
require('./node_modules/dotenv').config({ path: '.env' });
const db   = require('./services/db');
const fs   = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../uploads/products');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function run() {
  const [rows] = await db.query(
    `SELECT id, image_url FROM products
     WHERE source = 'tokopedia'
       AND image_url LIKE 'https://p16-images-sign-sg.tokopedia-static.net%'
       AND is_active = 1
     ORDER BY id ASC
     LIMIT 500`
  );
  console.log(`Found ${rows.length} Tokopedia products with signed URLs`);

  let ok = 0, fail = 0, skip = 0;
  for (const row of rows) {
    const localFile = path.join(UPLOADS_DIR, `${row.id}.jpg`);
    if (fs.existsSync(localFile)) { skip++; continue; }
    try {
      const res = await fetch(row.image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { fail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) { fail++; continue; }
      fs.writeFileSync(localFile, buf);
      await db.query('UPDATE products SET image_url = ? WHERE id = ?',
        [`/uploads/products/${row.id}.jpg`, row.id]);
      ok++;
      if (ok % 10 === 0) process.stdout.write(`  cached ${ok}...\n`);
    } catch (e) { fail++; }
  }
  console.log(`Done: cached=${ok} failed/expired=${fail} skipped=${skip}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
