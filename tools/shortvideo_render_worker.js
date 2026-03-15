#!/usr/bin/env node
'use strict';
/**
 * shortvideo_render_worker.js
 * Picks up 'queued' jobs and runs: TTS → Remotion render → done
 * pm2 start tools/shortvideo_render_worker.js --name shortvideo-renderer
 */

const BACKEND = __dirname + '/../backend';
process.chdir(BACKEND);
require(BACKEND + '/node_modules/dotenv').config({ path: BACKEND + '/.env' });

const mysql   = require(BACKEND + '/node_modules/mysql2/promise');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

const DB = {
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'findingid',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'findingid',
};

const ROOT        = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const VIDEO_DIR   = path.join(ROOT, 'video');
const POLL_MS     = 8000;

// ── DB helpers ────────────────────────────────────────────────────
async function setProgress(conn, id, progress, log) {
  await conn.execute(
    'UPDATE shortvideo_jobs SET progress=?, log_tail=? WHERE id=?',
    [progress, log?.slice(-2000) ?? null, id]
  );
}
async function setStatus(conn, id, status, extra = {}) {
  const fields = ['status=?']; const vals = [status];
  if ('progress'   in extra) { fields.push('progress=?');   vals.push(extra.progress); }
  if ('output_path' in extra) { fields.push('output_path=?'); vals.push(extra.output_path); }
  if ('error_msg'  in extra) { fields.push('error_msg=?');  vals.push(extra.error_msg); }
  if ('log_tail'   in extra) { fields.push('log_tail=?');   vals.push(extra.log_tail?.slice(-2000)); }
  vals.push(id);
  await conn.execute(`UPDATE shortvideo_jobs SET ${fields.join(',')} WHERE id=?`, vals);
}

// ── Run a subprocess, stream output, return exit code ─────────────
function runProc(cmd, args, opts, onData) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'pipe', ...opts });
    proc.stdout?.on('data', d => { onData?.(d.toString()); process.stdout.write(d); });
    proc.stderr?.on('data', d => { onData?.(d.toString()); });
    proc.on('close', resolve);
  });
}

// ── Process one job ────────────────────────────────────────────────
async function processJob(conn, job) {
  const { id, product_id, script_json, settings_json } = job;
  const settings = JSON.parse(settings_json || '{}');

  console.log(`[renderer] Starting job ${id} product ${product_id}`);
  await setStatus(conn, id, 'rendering', { progress: 0, error_msg: null, log_tail: 'Starting...' });

  let log = '';
  // Filter \r-overwrite lines and RENDER_PROGRESS markers from human-readable log
  const appendLog = (txt) => {
    const clean = txt
      .replace(/RENDER_PROGRESS:\d+\n?/g, '')   // strip progress markers
      .replace(/\r[^\n]*/g, '')                  // strip carriage-return overwrites
      .replace(/\n{3,}/g, '\n\n');               // collapse blank lines
    if (clean.trim()) log += clean;
  };

  // ── Step 1: Write script JSON to disk (gen_tts.py reads it) ──
  const scriptPath = path.join(SCRIPTS_DIR, `short_${product_id}.json`);
  if (script_json) {
    fs.writeFileSync(scriptPath, script_json);
  } else if (!fs.existsSync(scriptPath)) {
    return setStatus(conn, id, 'failed', { error_msg: 'No script_json and no file on disk', log_tail: log });
  }

  // ── Step 2: TTS (skip if files already exist) ─────────────────
  const audioPath  = path.join(SCRIPTS_DIR, `short_${product_id}_audio.mp3`);
  const timingPath = path.join(SCRIPTS_DIR, `short_${product_id}_timing.json`);
  const ttsReady   = fs.existsSync(audioPath) && fs.existsSync(timingPath);

  if (ttsReady) {
    appendLog('\n[1/3] TTS files already exist, skipping generation.');
    await setProgress(conn, id, 30, log + '\n[1/3] TTS cached. Starting video render...');
  } else {
    await setProgress(conn, id, 5, log + '\n[1/3] Generating TTS audio...');
    const code1 = await runProc('python3', [
      path.join(__dirname, 'gen_tts.py'), scriptPath
    ], { cwd: ROOT }, (d) => { appendLog(d); });

    if (code1 !== 0) {
      return setStatus(conn, id, 'failed', { progress: 10, error_msg: 'TTS failed', log_tail: log });
    }
    await setProgress(conn, id, 30, log + '\n[2/3] TTS done. Starting video render...');
  }

  // ── Step 3: Write render config ──────────────────────────────
  const musicId = settings.music_id || 1;
  const [[musicRow]] = await conn.execute(
    'SELECT filename FROM shortvideo_music WHERE id = ?', [musicId]
  );
  const musicFile = musicRow?.filename || 'music.mp3';

  const renderCfg = {
    product_id,
    script:           `short_${product_id}.json`,
    audio:            `short_${product_id}_audio.mp3`,
    timing:           `short_${product_id}_timing.json`,
    music:            musicFile,
    music_volume:     settings.music_volume ?? 30,
    voice_volume:     settings.voice_volume ?? 100,
    captions_enabled: settings.captions_enabled !== false, // default true
    font:             settings.font_style || 'montserrat',
    output:           `output_${product_id}.mp4`,
  };
  fs.writeFileSync(path.join(VIDEO_DIR, 'render_config.json'), JSON.stringify(renderCfg, null, 2));

  // ── Step 4: Remotion render ───────────────────────────────────
  let lastPct = 30;
  const code2 = await runProc('node', ['render.mjs', '--product=' + product_id], {
    cwd: VIDEO_DIR,
  }, (d) => {
    appendLog(d);
    // Parse structured progress marker emitted by render.mjs
    const m = d.match(/RENDER_PROGRESS:(\d+)/);
    if (m) {
      const pct = Math.min(95, parseInt(m[1]));
      if (pct > lastPct) {
        lastPct = pct;
        conn.execute('UPDATE shortvideo_jobs SET progress=?, log_tail=? WHERE id=?',
          [pct, log.slice(-2000), id]).catch(() => {});
      }
    }
  });

  if (code2 !== 0) {
    return setStatus(conn, id, 'failed', { progress: lastPct, error_msg: 'Render failed', log_tail: log });
  }

  // ── Step 3: Done ──────────────────────────────────────────────
  const outputPath = `/scripts/output_${product_id}.mp4`;
  await setStatus(conn, id, 'done', {
    progress:    100,
    output_path: outputPath,
    log_tail:    log + '\n[3/3] Render complete!',
    error_msg:   null,
  });
  console.log(`[renderer] Job ${id} done → ${outputPath}`);
}

// ── Main loop ──────────────────────────────────────────────────────
async function main() {
  const conn = await mysql.createConnection(DB);
  console.log('[renderer] Short video render worker started');

  while (true) {
    try {
      const [rows] = await conn.execute(
        `SELECT id, product_id, script_json, settings_json
         FROM shortvideo_jobs WHERE status='queued'
         ORDER BY updated_at ASC LIMIT 1`
      );
      if (rows.length) {
        await processJob(conn, rows[0]);
        await sleep(2000);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      console.error('[renderer] Error:', e.message);
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
