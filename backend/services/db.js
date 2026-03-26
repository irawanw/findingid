'use strict';
// ================================================================
// db.js — PostgreSQL shim with MySQL2-compatible API
//
// Drop-in replacement for mysql2/promise pool.
// Key differences handled here:
//   • ? placeholders  → $1 $2 … (auto-converted)
//   • Returns [rows]  for SELECT/WITH
//   • Returns [{affectedRows, insertId, rows}] for INSERT/UPDATE/DELETE
//   • withTransaction(fn) passes a client with the same .query() shim
// ================================================================
const pgdb = require('./pgdb');

// Convert MySQL ? placeholders to PostgreSQL $1 $2 ...
function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const SELECT_RE = /^\s*(SELECT|WITH)\b/i;

/**
 * Execute a query. Returns [rows] for SELECT, [{affectedRows, insertId, rows}] for DML.
 * Fully compatible with the mysql2/promise API used across all routes.
 */
async function query(sql, params = []) {
  const pgSql  = toPostgres(sql);
  const result = await pgdb.query(pgSql, params);

  if (SELECT_RE.test(sql)) {
    return [result.rows];
  }

  // DML — return OkPacket-like object
  const insertId = result.rows?.[0]?.id ?? 0;
  return [{
    affectedRows: result.rowCount,
    changedRows:  result.rowCount,
    insertId,
    rows:         result.rows,
  }];
}

/**
 * Transactional helper — callback receives a connection with the same query() shim.
 */
async function withTransaction(fn) {
  return pgdb.withTransaction(async (client) => {
    const wrappedClient = {
      query: async (sql, params = []) => {
        const pgSql  = toPostgres(sql);
        const result = await client.query(pgSql, params);
        if (SELECT_RE.test(sql)) return [result.rows];
        return [{ affectedRows: result.rowCount, insertId: result.rows?.[0]?.id ?? 0, rows: result.rows }];
      },
    };
    return fn(wrappedClient);
  });
}

async function ping() {
  return pgdb.ping();
}

function getPool() {
  return pgdb.getPool();
}

module.exports = { query, withTransaction, ping, getPool };
