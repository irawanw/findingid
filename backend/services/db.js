'use strict';
const mysql  = require('mysql2/promise');
const cfg    = require('../config/config');

// ================================================================
// MySQL Connection Pool
// Uses mysql2 promise API with connection pooling.
// Pool size matches DB_POOL_SIZE to avoid connection exhaustion.
// ================================================================

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:               cfg.DB.HOST,
      port:               cfg.DB.PORT,
      database:           cfg.DB.NAME,
      user:               cfg.DB.USER,
      password:           cfg.DB.PASS,
      connectionLimit:    cfg.DB.POOL_SIZE,
      waitForConnections: true,
      queueLimit:         0,
      timezone:           '+07:00',
      charset:            'utf8mb4',
      // Keep-alive
      enableKeepAlive:    true,
      keepAliveInitialDelay: 10000,
    });
    pool.on('connection', () => {
      if (!cfg.IS_PROD) console.log('[db] new connection established');
    });
  }
  return pool;
}

/**
 * Execute a SQL query with optional parameters.
 * Returns [rows, fields].
 */
async function query(sql, params = []) {
  const db = getPool();
  const [rows, fields] = await db.execute(sql, params);
  return [rows, fields];
}

/**
 * Transactional helper. Callback receives a connection.
 */
async function withTransaction(fn) {
  const db   = getPool();
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    conn.release();
    return result;
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
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
