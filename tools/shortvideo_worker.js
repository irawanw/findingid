#!/usr/bin/env node
'use strict';
/**
 * shortvideo_worker.js
 * Processes pending_script jobs one at a time (LLM is sequential).
 * Run via PM2: pm2 start tools/shortvideo_worker.js --name shortvideo-worker
 */

const BACKEND = __dirname + '/../backend';
process.chdir(BACKEND);
require(BACKEND + '/node_modules/dotenv').config({ path: BACKEND + '/.env' });

const mysql  = require(BACKEND + '/node_modules/mysql2/promise');
const { spawn } = require('child_process');
const fs     = require('fs');
const path   = require('path');

const DB = {
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'findingid',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'findingid',
};
const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const GEN_SCRIPT  = path.join(__dirname, 'gen_short_script.js');
const POLL_MS     = 5000;   // check every 5s when idle
const BUSY_MS     = 1000;   // check again quickly after a job completes

let running = false;

async function getNextJob(conn) {
  const [rows] = await conn.execute(
    `SELECT id, product_id FROM shortvideo_jobs
     WHERE status = 'pending_script'
     ORDER BY created_at ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function processJob(conn, job) {
  const { id, product_id } = job;
  console.log(`[worker] Processing job ${id} for product ${product_id}...`);

  // Lock it — mark as in-progress so no duplicate processing
  await conn.execute(
    `UPDATE shortvideo_jobs SET status = 'pending_script', error_msg = 'generating...' WHERE id = ?`,
    [id]
  );

  return new Promise((resolve) => {
    const proc = spawn('node', [GEN_SCRIPT, String(product_id)], {
      stdio: 'pipe',
      cwd: BACKEND,
    });

    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.stdout?.on('data', d => process.stdout.write(d));

    proc.on('close', async (code) => {
      try {
        if (code !== 0) {
          console.error(`[worker] job ${id} failed (exit ${code}): ${stderr.slice(0,200)}`);
          await conn.execute(
            `UPDATE shortvideo_jobs SET status='failed', error_msg=? WHERE id=?`,
            [`Script gen failed (exit ${code}): ${stderr.slice(0, 500)}`, id]
          );
          return resolve(false);
        }

        const outFile = path.join(SCRIPTS_DIR, `short_${product_id}.json`);
        if (!fs.existsSync(outFile)) {
          await conn.execute(
            `UPDATE shortvideo_jobs SET status='failed', error_msg='Output file not found' WHERE id=?`,
            [id]
          );
          return resolve(false);
        }

        const scriptJson = fs.readFileSync(outFile, 'utf8');
        await conn.execute(
          `UPDATE shortvideo_jobs SET status='draft', script_json=?, error_msg=NULL, log_tail=NULL WHERE id=?`,
          [scriptJson, id]
        );
        console.log(`[worker] job ${id} done — product ${product_id} → draft`);
        resolve(true);
      } catch (e) {
        console.error('[worker] DB update error:', e.message);
        resolve(false);
      }
    });
  });
}

async function main() {
  const conn = await mysql.createConnection(DB);
  console.log('[worker] Short video script worker started');

  while (true) {
    try {
      const job = await getNextJob(conn);
      if (job) {
        running = true;
        await processJob(conn, job);
        running = false;
        await sleep(BUSY_MS);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      console.error('[worker] Error:', e.message);
      // Reconnect if DB dropped
      try { await conn.ping(); } catch (_) {
        try { await conn.end(); } catch (_) {}
        Object.assign(conn, await mysql.createConnection(DB));
      }
      await sleep(POLL_MS);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
