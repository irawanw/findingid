'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const cfg     = require('../config/config');

function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ','');
  if (cfg.IS_PROD && key !== process.env.INGEST_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Multer storage ────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, '../../video/public');
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dirs = { music: 'music_uploads', sfx: 'sfx_uploads', transitions: 'transition_uploads' };
    const dir  = path.join(PUBLIC, dirs[req.params.type] || 'music_uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Jobs ──────────────────────────────────────────────────────────

// GET /api/shortvideo/jobs
router.get('/jobs', async (req, res) => {
  try {
    const status = req.query.status;
    const where  = status ? 'WHERE j.status = ?' : '';
    const params = status ? [status] : [];
    const [rows] = await db.query(`
      SELECT j.id, j.product_id, j.status, j.progress, j.output_path, j.error_msg,
             j.created_at, j.updated_at,
             p.title AS product_title,
             p.images_json
      FROM shortvideo_jobs j
      LEFT JOIN products p ON p.id = j.product_id
      ${where}
      ORDER BY j.updated_at DESC
      LIMIT 200
    `, params);

    // Attach first image
    const jobs = rows.map(r => {
      let img = null;
      try {
        const imgs = typeof r.images_json === 'string' ? JSON.parse(r.images_json) : r.images_json;
        if (Array.isArray(imgs) && imgs[0]) img = imgs[0];
      } catch (_) {}
      return { ...r, product_image: img, images_json: undefined };
    });
    res.json(jobs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shortvideo/jobs/:id
router.get('/jobs/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT j.*, p.title AS product_title, p.images_json
      FROM shortvideo_jobs j
      LEFT JOIN products p ON p.id = j.product_id
      WHERE j.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    let img = null;
    try {
      const imgs = typeof r.images_json === 'string' ? JSON.parse(r.images_json) : r.images_json;
      if (Array.isArray(imgs) && imgs[0]) img = imgs[0];
    } catch (_) {}
    res.json({ ...r, product_image: img, images_json: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shortvideo/jobs/:id
router.put('/jobs/:id', async (req, res) => {
  try {
    const { settings_json, script_json } = req.body;
    const updates = []; const params = [];
    if (settings_json !== undefined) { updates.push('settings_json = ?'); params.push(typeof settings_json === 'string' ? settings_json : JSON.stringify(settings_json)); }
    if (script_json   !== undefined) { updates.push('script_json = ?');   params.push(typeof script_json   === 'string' ? script_json   : JSON.stringify(script_json));   }
    if (!updates.length) return res.json({ updated: false });
    params.push(req.params.id);
    await db.query(`UPDATE shortvideo_jobs SET ${updates.join(',')} WHERE id = ?`, params);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shortvideo/jobs/:id/queue
router.post('/jobs/:id/queue', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT status FROM shortvideo_jobs WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (['queued','rendering'].includes(rows[0].status))
      return res.status(400).json({ error: `Cannot queue job with status: ${rows[0].status}` });
    await db.query('UPDATE shortvideo_jobs SET status = ?, progress = 0, output_path = NULL WHERE id = ?', ['queued', req.params.id]);
    res.json({ queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shortvideo/jobs/:id/regen-tts  — delete cached TTS files then re-queue
router.post('/jobs/:id/regen-tts', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT product_id, status FROM shortvideo_jobs WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { product_id, status } = rows[0];
    if (!['draft', 'done', 'failed', 'queued'].includes(status))
      return res.status(400).json({ error: `Cannot regen TTS for job with status: ${status}` });

    // Delete cached TTS files so the worker regenerates them
    const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
    for (const suffix of ['_audio.mp3', '_words.json', '_timing.json']) {
      const f = path.join(SCRIPTS_DIR, `short_${product_id}${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    await db.query(
      "UPDATE shortvideo_jobs SET status='queued', progress=0, output_path=NULL, error_msg=NULL WHERE id=?",
      [req.params.id]
    );
    res.json({ queued: true, tts_deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shortvideo/jobs/:id/regen-script
router.post('/jobs/:id/regen-script', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT product_id FROM shortvideo_jobs WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { product_id } = rows[0];

    await db.query("UPDATE shortvideo_jobs SET status='pending_script', script_json=NULL, error_msg=NULL, log_tail=NULL WHERE id=?", [req.params.id]);

    // Fire-and-forget: run gen_short_script.js
    const { spawn } = require('child_process');
    const scriptPath = path.join(__dirname, '../../tools/gen_short_script.js');
    const proc = spawn(process.execPath, [scriptPath, String(product_id)], { detached: true, stdio: 'ignore' });
    proc.unref();

    // Poll until done (max 120s) then save result
    (async () => {
      const outFile = path.join(__dirname, '../../scripts', `short_${product_id}.json`);
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        if (fs.existsSync(outFile)) {
          try {
            const scriptJson = fs.readFileSync(outFile, 'utf8');
            JSON.parse(scriptJson); // validate
            await db.query("UPDATE shortvideo_jobs SET status='draft', script_json=?, error_msg=NULL, log_tail=NULL WHERE id=?", [scriptJson, req.params.id]);
            return;
          } catch (_) {}
        }
      }
      await db.query("UPDATE shortvideo_jobs SET status='failed', error_msg='Script gen timed out' WHERE id=?", [req.params.id]);
    })();

    res.json({ started: true, product_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shortvideo/jobs/:id/regen-analysis
router.post('/jobs/:id/regen-analysis', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT product_id FROM shortvideo_jobs WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { product_id } = rows[0];

    await db.query('UPDATE products SET ai_analysis=NULL, ai_analysis_at=NULL, enrich_attempted_at=NULL WHERE id=?', [product_id]);

    const { generateAndSave } = require('../services/productAnalysis');
    generateAndSave(product_id).then(r => {
      console.log(`[regen-analysis] product ${product_id}:`, r ? '✓' : '✗');
    });

    res.json({ started: true, product_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shortvideo/jobs/:id
router.delete('/jobs/:id', authCheck, async (req, res) => {
  try {
    await db.query('DELETE FROM shortvideo_jobs WHERE id = ?', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Assets ────────────────────────────────────────────────────────

router.get('/assets/music', async (_req, res) => {  // no auth — read-only public assets
  try { const [r] = await db.query('SELECT * FROM shortvideo_music ORDER BY created_at DESC'); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assets/transitions', async (_req, res) => {  // no auth
  try { const [r] = await db.query('SELECT * FROM shortvideo_transitions ORDER BY id'); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assets/sfx', async (_req, res) => {  // no auth
  try { const [r] = await db.query('SELECT * FROM shortvideo_sfx ORDER BY created_at DESC'); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shortvideo/assets/:type  (music | sfx | transitions)
router.post('/assets/:type', authCheck, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { name, duration_s, tags, source, category, type: ttype } = req.body;
    const filename = req.file.filename;
    const t = req.params.type;

    if (t === 'music') {
      const [r] = await db.query(
        'INSERT INTO shortvideo_music (name, filename, duration_s, tags, source) VALUES (?,?,?,?,?)',
        [name || filename, filename, duration_s || null, tags || null, source || null]
      );
      res.json({ id: r.insertId, filename });
    } else if (t === 'sfx') {
      const [r] = await db.query(
        'INSERT INTO shortvideo_sfx (name, filename, category) VALUES (?,?,?)',
        [name || filename, filename, category || null]
      );
      res.json({ id: r.insertId, filename });
    } else if (t === 'transitions') {
      const [r] = await db.query(
        'INSERT INTO shortvideo_transitions (name, filename, type) VALUES (?,?,?)',
        [name || filename, filename, ttype || null]
      );
      res.json({ id: r.insertId, filename });
    } else {
      res.status(400).json({ error: 'Unknown asset type' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
