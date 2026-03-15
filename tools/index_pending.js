'use strict';
process.chdir('/data/www/findingid/backend');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '/data/www/findingid/backend/.env' });
const rag = require('/data/www/findingid/backend/services/rag');

async function run() {
  let total = 0;
  while (true) {
    const r = await rag.indexPendingProducts();
    if (!r.indexed) { console.log('Done. Total indexed:', total); break; }
    total += r.indexed;
    console.log('Indexed batch:', r.indexed, '| total so far:', total);
  }
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
