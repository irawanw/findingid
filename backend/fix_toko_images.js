'use strict';
process.chdir('/data/www/findingid/backend');
require('./node_modules/dotenv').config({ path: '.env' });
const db = require('./services/db');

// Convert p16-images-sign-sg.tokopedia-static.net signed URLs to stable images.tokopedia.net URLs.
// Signed URL path: /tos-alisg-i-xxx/img/product-1/YYYY/... → images.tokopedia.net/img/cache/200-square/product-1/YYYY/...
// Also handles hash-only paths (no /img/ prefix): /tos-alisg-i-xxx/{hash}~tplv-...
function convertToStable(url) {
  if (!url || !url.includes('tokopedia-static.net')) return null;

  try {
    const u = new URL(url);
    let imgPath = u.pathname
      .replace(/^\/tos-[^/]+\//, '')       // strip CDN prefix like /tos-alisg-i-aphluv4xwc-sg/
      .replace(/~tplv-[^?]+/, '');         // strip transform params like ~tplv-...:200:200.jpeg

    // If path starts with img/ → use cache/200-square format
    if (imgPath.startsWith('img/')) {
      return `https://images.tokopedia.net/img/cache/200-square/${imgPath.replace(/^img\//, '')}`;
    }
    // Hash-only path (e.g. 1684197f660f4fe8b5437cc77ec0b984) → use old format
    if (/^[a-f0-9]{32}/.test(imgPath)) {
      return `https://images.tokopedia.net/img/cache/200-square/${imgPath}`;
    }
    return null;
  } catch (_) { return null; }
}

async function run() {
  const [rows] = await db.query(
    `SELECT id, image_url FROM products
     WHERE source = 'tokopedia'
       AND image_url LIKE 'https://p16-images%tokopedia-static.net%'
       AND is_active = 1`
  );
  console.log(`Found ${rows.length} products with signed Tokopedia URLs`);

  let updated = 0, skipped = 0;
  for (const row of rows) {
    const stable = convertToStable(row.image_url);
    if (!stable) { skipped++; continue; }
    await db.query('UPDATE products SET image_url = ? WHERE id = ?', [stable, row.id]);
    updated++;
  }
  console.log(`Done: updated=${updated} skipped=${skipped}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
