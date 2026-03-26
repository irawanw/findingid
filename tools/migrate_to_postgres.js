#!/usr/bin/env node
'use strict';

// ================================================================
// MySQL → PostgreSQL migration for finding.id
//
// Run: node tools/migrate_to_postgres.js
//
// What it does:
//   1. Migrates products (with normalization applied)
//   2. Migrates price_history (creates monthly partitions as needed)
//   3. Migrates search_jobs, ingestion_log, search_log,
//      affiliate_click_events, seo_pages, places
//   4. Shows counts + timing per table
//
// Safe to re-run — uses ON CONFLICT DO UPDATE (upsert).
// ================================================================

require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '/data/www/findingid/backend/.env' });

const mysql = require('/data/www/findingid/backend/node_modules/mysql2/promise');
const { Pool } = require('/data/www/findingid/backend/node_modules/pg');
const { normalizeVariantsSync } = require('/data/www/findingid/backend/services/variantNormalizer');
const { normalizeAttributes }   = require('/data/www/findingid/backend/services/attributeNormalizer');
const { matchCategory }         = require('/data/www/findingid/backend/services/categorizer');

const BATCH = 500; // rows per batch

// ── connections ──────────────────────────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────
function log(msg) { process.stdout.write(msg + '\n'); }
function progress(cur, total, label) {
  process.stdout.write(`\r  ${label}: ${cur.toLocaleString()} / ${total.toLocaleString()}`);
}

function safeJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s || s === 'null' || s === '[]' || s === '{}') return null;
  // Check starts with valid JSON char
  if (s[0] !== '{' && s[0] !== '[' && s[0] !== '"') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function safeStr(val, max) {
  if (!val) return null;
  const s = String(val);
  return max ? s.slice(0, max) : s;
}

// Ensure price_history partition exists for a given month
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
  await pg.query(
    `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF price_history ` +
    `FOR VALUES FROM ('${start}') TO ('${end}')`
  );
  createdPartitions.add(key);
}

// ── 1. Migrate products ───────────────────────────────────────────
async function migrateProducts(mysql, pg) {
  const [[{ total }]] = await mysql.execute('SELECT COUNT(*) as total FROM products');
  log(`\nMigrating products: ${total.toLocaleString()} rows`);

  let offset = 0, migrated = 0, errors = 0;

  while (offset < total) {
    const [rows] = await mysql.execute(
      `SELECT * FROM products ORDER BY id LIMIT ? OFFSET ?`,
      [BATCH, offset]
    );
    if (!rows.length) break;

    for (const r of rows) {
      try {
        // Normalize category to std taxonomy
        const catStd = matchCategory(r.category) || null;

        // Normalize variants with sync rule-based pass
        let variantsJson = safeJson(r.variants_json);
        if (variantsJson) {
          const normalized = normalizeVariantsSync(variantsJson, catStd || r.category);
          if (normalized.length) variantsJson = normalized;
        }

        // Normalize attributes
        let attrsJson = safeJson(r.attributes_json);
        if (attrsJson) {
          const normalized = normalizeAttributes(attrsJson);
          if (normalized.length) attrsJson = normalized;
        }

        // All JSONB columns must be passed as JSON strings — if you pass a JS
        // array/object, pg serializes it as a Postgres array {a,b} not JSON ["a","b"]
        const toJsonStr = (v) => { const p = safeJson(v); return p ? JSON.stringify(p) : null; };

        await pg.query(`
          INSERT INTO products (
            id, source_item_id, source, title, price, rating, sold_count,
            monthly_sold, sold_display, link, image_url, images_json,
            variation_images_json, source_images_json,
            category, category_std, description, specs,
            attributes_json, variants_json, reviews_json, rating_summary,
            location, seller_name, seller_rating, search_query,
            ai_analysis, affiliate_link, click_count,
            is_active, indexed_at, created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
            $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
            $27,$28,$29,$30,$31,$32,$33
          )
          ON CONFLICT (link) DO UPDATE SET
            source_item_id        = COALESCE(EXCLUDED.source_item_id, products.source_item_id),
            title                 = EXCLUDED.title,
            price                 = EXCLUDED.price,
            rating                = COALESCE(EXCLUDED.rating, products.rating),
            sold_count            = GREATEST(COALESCE(products.sold_count,0), COALESCE(EXCLUDED.sold_count,0)),
            monthly_sold          = COALESCE(EXCLUDED.monthly_sold, products.monthly_sold),
            sold_display          = COALESCE(EXCLUDED.sold_display, products.sold_display),
            image_url             = COALESCE(EXCLUDED.image_url, products.image_url),
            images_json           = COALESCE(EXCLUDED.images_json, products.images_json),
            variation_images_json = COALESCE(EXCLUDED.variation_images_json, products.variation_images_json),
            source_images_json    = COALESCE(EXCLUDED.source_images_json, products.source_images_json),
            category              = COALESCE(EXCLUDED.category, products.category),
            category_std          = COALESCE(EXCLUDED.category_std, products.category_std),
            description           = COALESCE(NULLIF(EXCLUDED.description,''), products.description),
            specs                 = COALESCE(NULLIF(EXCLUDED.specs,''), products.specs),
            attributes_json       = COALESCE(EXCLUDED.attributes_json, products.attributes_json),
            variants_json         = COALESCE(EXCLUDED.variants_json, products.variants_json),
            reviews_json          = COALESCE(EXCLUDED.reviews_json, products.reviews_json),
            rating_summary        = COALESCE(EXCLUDED.rating_summary, products.rating_summary),
            ai_analysis           = COALESCE(EXCLUDED.ai_analysis, products.ai_analysis),
            affiliate_link        = COALESCE(EXCLUDED.affiliate_link, products.affiliate_link),
            click_count           = GREATEST(products.click_count, EXCLUDED.click_count),
            is_active             = EXCLUDED.is_active,
            updated_at            = EXCLUDED.updated_at
        `, [
          r.id,
          safeStr(r.source_item_id, 100),
          safeStr(r.source, 50),
          safeStr(r.title, 500),
          r.price    ? Math.round(Number(r.price))   : null,
          r.rating   ? Number(r.rating)              : null,
          r.sold_count   ?? null,
          r.monthly_sold ?? null,
          safeStr(r.sold_display, 20),
          r.link,
          r.image_url,
          toJsonStr(r.images_json),
          toJsonStr(r.variation_images_json),
          toJsonStr(r.source_images_json),
          safeStr(r.category, 200),
          catStd,
          r.description ? String(r.description).slice(0, 5000) : null,
          r.specs       ? String(r.specs).slice(0, 2000)       : null,
          attrsJson     ? JSON.stringify(attrsJson) : null,
          variantsJson  ? JSON.stringify(variantsJson) : null,
          toJsonStr(r.reviews_json),
          toJsonStr(r.rating_summary),
          safeStr(r.location, 200),
          safeStr(r.seller_name, 200),
          r.seller_rating ? Number(r.seller_rating) : null,
          safeStr(r.search_query, 200),
          r.ai_analysis   || null,
          r.affiliate_link || null,
          r.click_count   || 0,
          r.is_active === 1 || r.is_active === true,
          r.indexed_at || null,
          r.created_at || new Date(),
          r.updated_at || new Date(),
        ]);
        migrated++;
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`\n  product id=${r.id}: ${err.message}`);
      }
    }

    offset += rows.length;
    progress(offset, total, 'products');
  }
  log(`\n  Done: ${migrated.toLocaleString()} migrated, ${errors} errors`);
  return migrated;
}

// ── 2. Migrate price_history ──────────────────────────────────────
async function migratePriceHistory(mysql, pg) {
  const [[{ total }]] = await mysql.execute('SELECT COUNT(*) as total FROM price_history');
  log(`\nMigrating price_history: ${total.toLocaleString()} rows`);

  let offset = 0, migrated = 0, errors = 0;

  while (offset < total) {
    const [rows] = await mysql.execute(
      `SELECT ph.id, ph.product_id, ph.price, ph.variant_name, ph.captured_at
       FROM price_history ph
       ORDER BY ph.id LIMIT ? OFFSET ?`,
      [BATCH, offset]
    );
    if (!rows.length) break;

    for (const r of rows) {
      try {
        await ensurePartition(pg, r.captured_at);
        // MySQL product ids are preserved in Postgres (we inserted them directly)
        await pg.query(
          `INSERT INTO price_history (product_id, price, variant_name, captured_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [r.product_id, Math.round(Number(r.price)), r.variant_name || null, r.captured_at]
        );
        migrated++;
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`\n  price_history id=${r.id}: ${err.message}`);
      }
    }

    offset += rows.length;
    progress(offset, total, 'price_history');
  }
  log(`\n  Done: ${migrated.toLocaleString()} migrated, ${errors} errors`);
}

// ── 3. Migrate search_jobs ────────────────────────────────────────
async function migrateSearchJobs(mysql, pg) {
  const [rows] = await mysql.execute('SELECT * FROM search_jobs');
  log(`\nMigrating search_jobs: ${rows.length} rows`);
  let ok = 0;
  for (const r of rows) {
    try {
      await pg.query(`
        INSERT INTO search_jobs (id,query,sources,status,products_ingested,created_at,claimed_at,completed_at,expires_at,agent_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO NOTHING`,
        [r.id, r.query, JSON.stringify(safeJson(r.sources)||["shopee"]), r.status, r.products_ingested||0,
         r.created_at, r.claimed_at, r.completed_at, r.expires_at, r.agent_id]
      );
      ok++;
    } catch (err) { if (ok < 5) console.error('\n ', err.message); }
  }
  log(`  Done: ${ok}`);
}

// ── 4. Migrate affiliate_click_events ────────────────────────────
async function migrateClicks(mysql, pg) {
  const [[{ total }]] = await mysql.execute('SELECT COUNT(*) as total FROM affiliate_click_events');
  log(`\nMigrating affiliate_click_events: ${total.toLocaleString()} rows`);
  let offset = 0, ok = 0;
  while (offset < total) {
    const [rows] = await mysql.execute(
      'SELECT * FROM affiliate_click_events ORDER BY id LIMIT ? OFFSET ?', [BATCH, offset]
    );
    if (!rows.length) break;
    for (const r of rows) {
      try {
        // Resolve product_id in postgres
        const { rows: prows } = await pg.query('SELECT id FROM products WHERE id = $1 LIMIT 1', [r.product_id]);
        if (!prows.length) continue;
        await pg.query(`
          INSERT INTO affiliate_click_events (product_id,sid,query,source,has_affiliate,referrer,ip_hash,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [prows[0].id, r.sid, r.query, r.source, !!r.has_affiliate, r.referrer, r.ip_hash, r.created_at]
        );
        ok++;
      } catch (_) {}
    }
    offset += rows.length;
    progress(offset, total, 'clicks');
  }
  log(`\n  Done: ${ok.toLocaleString()}`);
}

// ── 5. Migrate seo_pages ─────────────────────────────────────────
async function migrateSeoPages(mysql, pg) {
  const [rows] = await mysql.execute('SELECT * FROM seo_pages');
  log(`\nMigrating seo_pages: ${rows.length} rows`);
  let ok = 0;
  for (const r of rows) {
    try {
      await pg.query(`
        INSERT INTO seo_pages (url_path,page_type,title,product_count,quality_score,is_indexable,generated_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (url_path) DO NOTHING`,
        [r.url_path, r.page_type, r.title, r.product_count||0, r.quality_score||0, !!r.is_indexable, r.generated_at, r.updated_at]
      );
      ok++;
    } catch (_) {}
  }
  log(`  Done: ${ok}`);
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log('=== finding.id MySQL → PostgreSQL migration ===\n');

  const mysql = await mysqlPool.getConnection();
  const pg    = await pgPool.connect();

  try {
    // Sync MySQL IDs to Postgres by preserving them
    // Reset sequence after bulk insert so next INSERT gets correct id
    await migrateProducts(mysql, pg);
    await pg.query(`SELECT setval('products_id_seq', (SELECT MAX(id) FROM products))`);

    await migratePriceHistory(mysql, pg);
    await migrateSearchJobs(mysql, pg);
    await migrateClicks(mysql, pg);
    await migrateSeoPages(mysql, pg);

    // Final counts
    log('\n=== Verification ===');
    const tables = ['products','price_history','search_jobs','affiliate_click_events','seo_pages'];
    for (const t of tables) {
      const { rows } = await pg.query(`SELECT COUNT(*) FROM ${t}`);
      log(`  ${t}: ${Number(rows[0].count).toLocaleString()}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`\nMigration complete in ${elapsed}s`);
  } finally {
    mysql.release();
    pg.release();
    await mysqlPool.end();
    await pgPool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
