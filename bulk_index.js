'use strict';
const mysql = require('mysql2/promise');
const axios = require('axios');

const DB = { host:'localhost', port:3306, database:'findingid', user:'findingid', password:'fid_e4f72614bde12fae9d9f' };
const RAG = 'http://127.0.0.1:8002';
const BATCH = 50;

async function main() {
  const db = await mysql.createConnection(DB);
  const [rows] = await db.query(
    `SELECT id, title, category, price, description, specs FROM products WHERE is_active=1 ORDER BY id ASC`
  );
  console.log(`Total products: ${rows.length}`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const products = batch.map(r => ({
      id:          String(r.id),
      name:        r.title || '',
      category:    r.category || '',
      price:       Number(r.price) || 0,
      description: (r.description || '').slice(0, 500),
      specs:       (r.specs || '').slice(0, 200),
    }));
    try {
      await axios.post(`${RAG}/products/index`, { folder: 'findingid', products }, { timeout: 60000 });
      process.stdout.write(`\rIndexed ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    } catch(e) {
      console.error(`\nBatch ${i} error:`, e.message);
    }
  }
  console.log('\nDone!');
  await db.end();
}

main().catch(console.error);
