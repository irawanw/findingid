#!/usr/bin/env node
'use strict';

// One-shot: migrate price_history from MySQL → PostgreSQL
// Run: node tools/migrate_price_history.js

require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '/data/www/findingid/backend/.env' });

const mysql = require('/data/www/findingid/backend/node_modules/mysql2/promise');
const { Pool } = require('/data/www/findingid/backend/node_modules/pg');

const BATCH = 1000;

const mysqlPool = mysql.createPool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME     || 'findingid',
  user:     process.env.DB_USER     || 'findingid',
  password: process.env.DB_PASS     || 'secret',
  connectionLimit: 5,
  timezone: '+07:00',
  charset: 'utf8mb4',
});

const pgPool = new Pool({
  host:     process.env.PG_HOST || '127.0.0.1',
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_NAME || 'findingid',
  user:     process.env.PG_USER || 'findingid',
  password: process.env.PG_PASS || 'secret',
  max: 10,
});

// Partitions we've already created this run
const createdPartitions = new Set();

async function ensurePartition(pg, capturedAt) {
  const d     = new Date(capturedAt || Date.now());
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const key   = `${year}_${month}`;
  if (createdPartitions.has(key)) return;

  const name  = `price_history_${key}`;
  const start = `${year}-${month}-01`;
  const nextM = new Date(Date.UTC(year, d.getUTCMonth() + 1, 1));
  const end   = `${nextM.getUTCFullYear()}-${String(nextM.getUTCMonth() + 1).padStart(2, '0')}-01`;

  // DDL does not accept $1/$2 parameters — use safe string interpolation
  // (dates come from controlled toISOString-style format, safe to interpolate)
  await pg.query(
    `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF price_history ` +
    `FOR VALUES FROM ('${start}') TO ('${end}')`
  );
  createdPartitions.add(key);
  process.stdout.write(`\n  [partition created] ${name}`);
}

async function main() {
  const t0 = Date.now();
  console.log('=== price_history migration ===\n');

  const mysql = await mysqlPool.getConnection();
  const pg    = await pgPool.connect();

  try {
    const [[{ total }]] = await mysql.execute('SELECT COUNT(*) as total FROM price_history');
    console.log(`Total rows: ${total.toLocaleString()}`);

    let offset = 0, migrated = 0, errors = 0;

    while (offset < total) {
      const [rows] = await mysql.execute(
        `SELECT id, product_id, price, variant_name, captured_at
         FROM price_history ORDER BY id LIMIT ? OFFSET ?`,
        [BATCH, offset]
      );
      if (!rows.length) break;

      for (const r of rows) {
        try {
          await ensurePartition(pg, r.captured_at);
          await pg.query(
            `INSERT INTO price_history (product_id, price, variant_name, captured_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [r.product_id, Math.round(Number(r.price)), r.variant_name || null, r.captured_at]
          );
          migrated++;
        } catch (err) {
          errors++;
          if (errors <= 10) console.error(`\n  price_history id=${r.id}: ${err.message}`);
        }
      }

      offset += rows.length;
      process.stdout.write(`\r  ${offset.toLocaleString()} / ${total.toLocaleString()} (${errors} errors)`);
    }

    const { rows: cnt } = await pg.query('SELECT COUNT(*) FROM price_history');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n\nDone: ${migrated.toLocaleString()} inserted, ${errors} errors`);
    console.log(`PostgreSQL price_history count: ${Number(cnt[0].count).toLocaleString()}`);
    console.log(`Elapsed: ${elapsed}s`);
  } finally {
    mysql.release();
    pg.release();
    await mysqlPool.end();
    await pgPool.end();
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
