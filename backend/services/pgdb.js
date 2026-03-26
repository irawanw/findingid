'use strict';
const { Pool } = require('pg');
const cfg = require('../config/config');

// ================================================================
// PostgreSQL connection pool (node-postgres)
// Replaces mysql2 pool in db.js.
//
// All queries use $1/$2/... positional parameters.
// Pool is lazy-initialized on first use.
// ================================================================

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     cfg.PG.HOST,
      port:     cfg.PG.PORT,
      database: cfg.PG.NAME,
      user:     cfg.PG.USER,
      password: cfg.PG.PASS,
      max:      cfg.PG.POOL_SIZE,
      idleTimeoutMillis:    30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[pgdb] idle client error:', err.message);
    });
    if (!cfg.IS_PROD) {
      pool.on('connect', () => console.log('[pgdb] new connection'));
    }
  }
  return pool;
}

/**
 * Execute a query. Returns { rows, rowCount }.
 * @param {string}   sql
 * @param {Array}    [params]
 */
async function query(sql, params = []) {
  const db = getPool();
  const result = await db.query(sql, params);
  return result; // { rows, rowCount, fields }
}

/**
 * Transactional helper.
 * @param {function(client): Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Healthcheck — returns true if DB is reachable.
 */
async function ping() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

module.exports = { query, withTransaction, ping, getPool };
