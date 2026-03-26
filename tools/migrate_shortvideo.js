#!/usr/bin/env node
'use strict';
require('/data/www/findingid/backend/node_modules/dotenv').config({
  path: '/data/www/findingid/backend/.env',
});
const mysql = require('/data/www/findingid/backend/node_modules/mysql2/promise');
const pgdb  = require('/data/www/findingid/backend/services/pgdb');
const pg    = { query: pgdb.query };

async function main() {
  const my = await mysql.createConnection({
    host: 'localhost',
    user: 'findingid',
    password: process.env.DB_PASS || '',
    database: 'findingid',
    typeCast: false,
    multipleStatements: false,
  });

  // ── shortvideo_jobs ────────────────────────────────────────
  const [jobs] = await my.query(
    'SELECT id,product_id,status,script_json,settings_json,output_path,error_msg,created_at,updated_at,progress,log_tail FROM shortvideo_jobs ORDER BY id'
  );
  console.log(`Migrating ${jobs.length} shortvideo_jobs...`);
  let done = 0, skipped = 0;
  for (const r of jobs) {
    try {
      await pg.query(
        `INSERT INTO shortvideo_jobs
           (id,product_id,status,script_json,settings_json,output_path,error_msg,created_at,updated_at,progress,log_tail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (product_id) DO NOTHING`,
        [
          r.id,
          r.product_id,
          r.status,
          r.script_json   || null,
          r.settings_json || null,
          r.output_path   || null,
          r.error_msg     || null,
          r.created_at,
          r.updated_at,
          r.progress || 0,
          r.log_tail || null,
        ]
      );
      done++;
    } catch (e) {
      skipped++;
      if (skipped <= 3) console.error(`  job id=${r.id}: ${e.message}`);
    }
  }
  await pg.query(`SELECT setval('shortvideo_jobs_id_seq', (SELECT MAX(id) FROM shortvideo_jobs))`);
  console.log(`  inserted: ${done}, skipped: ${skipped}`);

  // ── shortvideo_music ───────────────────────────────────────
  const [music] = await my.query(
    'SELECT id,name,filename,duration_s,tags,source,created_at FROM shortvideo_music ORDER BY id'
  );
  console.log(`Migrating ${music.length} shortvideo_music...`);
  for (const r of music) {
    await pg.query(
      `INSERT INTO shortvideo_music (id,name,filename,duration_s,tags,source,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [r.id, r.name, r.filename, r.duration_s || null, r.tags || null, r.source || null, r.created_at]
    );
  }
  await pg.query(`SELECT setval('shortvideo_music_id_seq', GREATEST(1,(SELECT COALESCE(MAX(id),1) FROM shortvideo_music)))`);
  console.log(`  done.`);

  // ── shortvideo_transitions ─────────────────────────────────
  const [trans] = await my.query(
    'SELECT id,name,filename,preview_url,type,created_at FROM shortvideo_transitions ORDER BY id'
  );
  console.log(`Migrating ${trans.length} shortvideo_transitions...`);
  for (const r of trans) {
    await pg.query(
      `INSERT INTO shortvideo_transitions (id,name,filename,preview_url,type,created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [r.id, r.name, r.filename || null, r.preview_url || null, r.type || null, r.created_at]
    );
  }
  await pg.query(`SELECT setval('shortvideo_transitions_id_seq', GREATEST(1,(SELECT COALESCE(MAX(id),1) FROM shortvideo_transitions)))`);
  console.log(`  done.`);

  // ── sfx (MySQL has 0 rows, just reset seq) ─────────────────
  await pg.query(`SELECT setval('shortvideo_sfx_id_seq', 1, false)`);

  await my.end();

  // Verify
  const { rows: counts } = await pgdb.query(`
    SELECT 'jobs' as t, COUNT(*) as n FROM shortvideo_jobs
    UNION ALL SELECT 'music', COUNT(*) FROM shortvideo_music
    UNION ALL SELECT 'transitions', COUNT(*) FROM shortvideo_transitions
  `);
  console.log('\nFinal counts:', counts.map(r => `${r.t}=${r.n}`).join(', '));
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
