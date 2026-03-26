'use strict';
require('dotenv').config();

// ================================================================
//
//  finding.id — Backend Server
//  AI Marketplace Intelligence
//
// ================================================================
//
//  ARCHITECTURE OVERVIEW
//  ─────────────────────
//
//  ┌─────────────────────────────────────────────────────────┐
//  │                    CLIENTS (100k+ CCU)                  │
//  │           Browser (SSE)  │  Chrome Extension (REST)     │
//  └────────────────┬─────────┴────────────────┬────────────┘
//                   │                          │
//  ┌────────────────▼──────────────────────────▼────────────┐
//  │         NGINX / Load Balancer (SSL termination)         │
//  │         HAProxy or Kubernetes Ingress at scale          │
//  └────────────────────────────┬───────────────────────────┘
//                               │
//  ┌──────────────────────────────────────────────────────────┐
//  │   Node.js API Servers  (stateless, horizontally scaled)  │
//  │   PM2 cluster / K8s Deployment (replicas=N)              │
//  │                                                          │
//  │   POST /api/search   → RAG → vLLM streaming              │
//  │   GET  /api/jobs     → extension job polling             │
//  │   POST /api/ingest   → extension data push               │
//  └──────┬────────────────────┬──────────────────────────────┘
//         │                    │
//  ┌──────▼──────┐    ┌────────▼──────────────────────────────┐
//  │    Redis     │    │         Core Services                  │
//  │  Cache layer │    │                                        │
//  │  Rate limit  │    │  ┌──────────────────────────────────┐ │
//  │  Job queue   │    │  │  RAG Service (127.0.0.1:8002)    │ │
//  │  (ioredis)   │    │  │  FastAPI + BGE-M3 embeddings     │ │
//  └─────────────┘    │  │  Qdrant vector search            │ │
//                     │  └──────────────────────────────────┘ │
//                     │                                        │
//                     │  ┌──────────────────────────────────┐ │
//                     │  │  vLLM (127.0.0.1:8001)           │ │
//                     │  │  Qwen3.5-9B (llama.cpp)          │ │
//                     │  │  OpenAI-compatible streaming     │ │
//                     │  └──────────────────────────────────┘ │
//                     │                                        │
//                     │  ┌──────────────────────────────────┐ │
//                     │  │  MySQL (RDS / read replicas)     │ │
//                     │  │  products, search_jobs, logs     │ │
//                     │  └──────────────────────────────────┘ │
//                     └────────────────────────────────────────┘
//
//  SCRAPING LOOP (continuous learning)
//  ────────────────────────────────────
//  User query with low RAG score
//      └→ createScrapingJob() → Redis jobs:pending
//              └→ Chrome Extension polls GET /api/jobs
//                      └→ Opens Shopee/Tokopedia search
//                              └→ Intercepts XHR responses
//                                      └→ POST /api/ingest
//                                              └→ MySQL upsert
//                                                      └→ RAG indexProducts()
//                                                              └→ Qdrant indexed
//
//  SCALABILITY NOTES
//  ──────────────────
//  - MySQL: Use InnoDB, index on (source, category), partition by source
//           Read replicas for search hydration
//           Connection pool size = 20 per Node process
//  - Qdrant: HNSW index, on_disk=true for 50M+ vectors
//            Distributed cluster for shard count > 1
//  - Redis:  Cluster mode for rate limit + job queue at scale
//            Search cache TTL = 5min (reduces vLLM calls ~60%)
//  - vLLM:   Circuit breaker prevents cascade failures
//            Graceful degradation → return products without LLM
//  - Node.js: Stateless → scale horizontally behind LB
//             Use PM2 cluster or K8s HPA
//  - Kafka (optional): Replace Redis lists with Kafka for ingestion
//                      at >1000 scrape events/sec
// ================================================================

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const cfg          = require('./config/config');

// ── Routes ───────────────────────────────────────────────────
const searchRoute        = require('./routes/search');
const jobsRoute          = require('./routes/jobs');
const ingestRoute        = require('./routes/ingest');
const productsRoute      = require('./routes/products');
const affiliateJobsRoute = require('./routes/affiliateJobs');
const cariRoute          = require('./routes/cari');
const seoRoute           = require('./routes/seo');
const enrichRoute        = require('./routes/enrich');
const shortvideoRoute    = require('./routes/shortvideo');
const agentRoute         = require('./routes/agent');
const scraperRoute       = require('./routes/scraper');
const proxiesRoute       = require('./routes/proxies');
const proxyChecker       = require('./services/proxyChecker');
const lebaranRoute       = require('./routes/lebaran');
const productPageRoute   = require('./routes/productPage');
const aiReviewRoute      = require('./routes/aiReview');
const dealsRoute         = require('./routes/deals');
const leadsRoute         = require('./routes/leads');
const placesSearchRoute  = require('./routes/placesSearch');
const placesJobsRoute    = require('./routes/placesJobs');
const placesIngestRoute  = require('./routes/placesIngest');
const telegram           = require('./services/telegram');
const productAnalysis    = require('./services/productAnalysis');

// ── Services (initialise early) ──────────────────────────────
const db             = require('./services/db');
const cache          = require('./services/cache');
const rag            = require('./services/rag');
const keywordSeeder  = require('./services/keywordSeeder');

const app = express();

// ── Security / middleware ────────────────────────────────────
app.set('trust proxy', 1); // for X-Forwarded-For behind NGINX
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin:      cfg.CORS_ORIGINS,
  credentials: true,
}));
app.use(morgan(cfg.IS_PROD ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs:         cfg.RATE.WINDOW_MS,
  max:              cfg.RATE.MAX,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests' }),
  // Redis store for distributed rate limiting (uncomment at scale)
  // store: new (require('rate-limit-redis'))({ client: cache.getClient() }),
});
app.use('/api/search', limiter);

// ── SEO: robots.txt ──────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /admin191

Sitemap: https://finding.id/sitemap.xml`
  );
});

// ── SEO: sitemap index ────────────────────────────────────────
// sitemap.xml      → sitemap index listing all sub-sitemaps
// sitemap-static.xml   → homepage, /cari, /best, /top pages
// sitemap-products.xml?page=N  → product pages, 40k per page

const SITEMAP_PAGE_SIZE = 40000;

app.get('/sitemap.xml', async (req, res) => {
  const now = new Date().toISOString().slice(0, 10);
  try {
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM products WHERE is_active = true`
    );
    const pages = Math.ceil(total / SITEMAP_PAGE_SIZE);
    const sitemaps = [
      `  <sitemap><loc>https://finding.id/sitemap-static.xml</loc><lastmod>${now}</lastmod></sitemap>`,
      ...Array.from({ length: pages }, (_, i) =>
        `  <sitemap><loc>https://finding.id/sitemap-products.xml?page=${i + 1}</loc><lastmod>${now}</lastmod></sitemap>`
      ),
    ];
    res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.join('\n')}
</sitemapindex>`
    );
  } catch (e) {
    res.status(500).send('Error generating sitemap index');
  }
});

app.get('/sitemap-static.xml', (req, res) => {
  const now = new Date().toISOString().slice(0, 10);
  const { SLUGS } = require('./routes/cari');
  const { CAT_MAP, PRICE_SUFFIXES } = require('./routes/seo');

  const pages = [
    { url: 'https://finding.id/',                   priority: '1.0', freq: 'daily' },
    { url: 'https://finding.id/ai-review',          priority: '0.9', freq: 'daily' },
    { url: 'https://finding.id/deals',              priority: '0.9', freq: 'daily' },
    { url: 'https://finding.id/hasil',              priority: '0.8', freq: 'daily' },
    { url: 'https://finding.id/lebaran',            priority: '1.0', freq: 'daily' },
    { url: 'https://finding.id/lebaran/tips-mudik', priority: '0.9', freq: 'weekly' },
    ...Object.keys(SLUGS).map(slug => ({
      url: `https://finding.id/cari/${slug}`,
      priority: slug.includes('lebaran') || slug.includes('koko') || slug.includes('nastar') || slug.includes('hampers') || slug.includes('mudik') ? '1.0' : '0.9',
      freq: 'daily',
    })),
    ...Object.keys(CAT_MAP).map(catSlug => ({
      url: `https://finding.id/best/${catSlug}`,
      priority: '0.8', freq: 'daily',
    })),
    ...Object.keys(CAT_MAP).flatMap(catSlug =>
      PRICE_SUFFIXES.map(ps => ({
        url: `https://finding.id/top/${catSlug}-${ps}`,
        priority: '0.7', freq: 'daily',
      }))
    ),
  ];

  const urls = pages.map(u => `
  <url>
    <loc>${u.url}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('');

  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`
  );
});

app.get('/sitemap-products.xml', async (req, res) => {
  const now   = new Date().toISOString().slice(0, 10);
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = SITEMAP_PAGE_SIZE;
  const off   = (page - 1) * limit;

  try {
    const [rows] = await db.query(
      `SELECT id, ai_analysis_at, updated_at FROM products
       WHERE is_active = true
       ORDER BY id ASC LIMIT ? OFFSET ?`,
      [limit, off]
    );
    const urls = rows.map(p => {
      const lastmod = (p.ai_analysis_at || p.updated_at)
        ? new Date(p.ai_analysis_at || p.updated_at).toISOString().split('T')[0]
        : now;
      const priority = p.ai_analysis_at ? '0.8' : '0.6';
      return `
  <url>
    <loc>https://finding.id/p/${p.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
  </url>`;
    }).join('');

    res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`
    );
  } catch (e) {
    res.status(500).send('Error generating product sitemap');
  }
});

// ── Static frontend (single-page app) ────────────────────────
// Serve the index.html from the parent directory
app.use(express.static(path.join(__dirname, '../')));

// ── API routes ────────────────────────────────────────────────
app.use('/api/search',         searchRoute);
app.use('/api/agent',          agentRoute);
app.use('/api/jobs',           jobsRoute);
app.use('/api/ingest',         ingestRoute);
app.use('/api/products',       productsRoute);
app.use('/api/affiliate-jobs',   affiliateJobsRoute);
app.use('/api/products/enrich', enrichRoute);
app.use('/api/shortvideo',      shortvideoRoute);
app.use('/api/scraper',        scraperRoute);
app.use('/api/proxies',        proxiesRoute);
app.use('/p',                   productPageRoute);
app.use('/ai-review',           aiReviewRoute);
app.use('/deals',               dealsRoute);
// Leads + Places APIs: allow Chrome extensions — auth via X-API-Key
app.use('/api/leads',          cors({ origin: '*', credentials: false }), leadsRoute);
app.use('/api/places/search',  placesSearchRoute);
app.use('/api/places/jobs',    cors({ origin: '*', credentials: false }), placesJobsRoute);
app.use('/api/places/ingest',  cors({ origin: '*', credentials: false }), placesIngestRoute);
app.use('/cari',                cariRoute);

// /rumah section permanently removed — return 410 Gone for fast deindexing
app.use('/rumah', (req, res) => res.status(410).send('Page Gone'));

app.use('/',                    seoRoute);   // handles /top/:slug and /best/:slug
app.use('/lebaran',             lebaranRoute);
app.get('/tips-mudik-lebaran',  (req, res) => res.redirect(301, '/lebaran/tips-mudik'));

// ── Admin dashboard (Next.js on port 3191) ─────────────────
const { createProxyMiddleware } = require('http-proxy-middleware');
app.use('/admin191', createProxyMiddleware({
  target: 'http://127.0.0.1:3191',
  changeOrigin: false,
  ws: true,
  pathRewrite: (pathReq) => {
    if (pathReq === '/' || pathReq === '') return '/admin191';
    if (pathReq.startsWith('/admin191')) return pathReq;
    // Express strips the /admin191 mount prefix so pathReq is relative, e.g.:
    //   /?_rsc=abc  → /admin191?_rsc=abc  (NOT /admin191/?_rsc=abc — causes 308 loop)
    //   /products   → /admin191/products
    if (pathReq.startsWith('/?') || pathReq.startsWith('?')) {
      // root path with query string — attach without adding a slash
      const qs = pathReq.startsWith('/') ? pathReq.slice(1) : pathReq;
      return `/admin191${qs}`;   // /admin191?_rsc=abc
    }
    return `/admin191${pathReq}`;
  },
  on: {
    proxyReq: (proxyReq, req) => {
      const isDocument = req.headers['sec-fetch-dest'] === 'document';
      if (isDocument) {
        proxyReq.removeHeader('rsc');
        proxyReq.removeHeader('next-router-state-tree');
        proxyReq.removeHeader('next-url');
        proxyReq.setHeader('accept', 'text/html,application/xhtml+xml');
      }
    },
    proxyRes: (proxyRes, req, res) => {
      if (req.url?.startsWith('/admin191')) {
        proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, private';
        proxyRes.headers['vary'] = 'RSC, Next-Router-State-Tree, Next-URL, Accept, Cookie';
      }
    },
    error: (err, req, res) => {
      console.error('[admin proxy]', err.message);
      if (!res.headersSent) res.status(502).send('Admin panel starting up, try again in a moment.');
    },
  },
}));
// ── Admin static assets (_next/) ─────────────────────────────
// Next.js outputs asset URLs as /_next/static/... (no basePath prefix).
// These must be forwarded to port 3191 so CSS/JS loads correctly.
app.use('/_next', createProxyMiddleware({
  target: 'http://127.0.0.1:3191',
  changeOrigin: false,
  pathRewrite: (pathReq) => `/_next${pathReq}`,
  on: {
    error: (err, req, res) => {
      if (!res.headersSent) res.status(502).send('');
    },
  },
}));

// Legacy redirect
app.get('/admin/products', (req, res) => res.redirect(301, '/admin191/products'));

// ── Search results page ─────────────────────────────────────
app.get('/hasil', (req, res) => {
  res.sendFile(path.join(__dirname, '../hasil.html'));
});

// ── Bot UA filter for click tracking ────────────────────────
const BOT_UA_RE = /bot|spider|crawler|slurp|mediapartners|adsbot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegram|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|baiduspider|yandex|duckduckbot|sogou|exabot|ia_archiver|archive\.org_bot|seznambot|naver|coccocbot|bytespider|amazonbot|ccbot/i;

// ── Click tracking proxy ────────────────────────────────────
// GET /go/:id?sid=...&q=... — logs click, redirects to affiliate_link or link
app.get('/go/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/');

  const ua = String(req.headers['user-agent'] || '');
  const isBot = BOT_UA_RE.test(ua);

  try {
    const [rows] = await db.query(
      'SELECT source, link, affiliate_link, ai_analysis FROM products WHERE id = ? AND is_active = true LIMIT 1',
      [id]
    );
    if (!rows.length) return res.redirect('/');

    const { source, link, affiliate_link, ai_analysis } = rows[0];
    const dest = affiliate_link || link;

    // ── Skip tracking for bots and admin sessions ─────────────
    const isAdmin = (() => {
      const raw = (req.headers.cookie || '').split(';')
        .map(s => s.trim()).find(s => s.startsWith('fid_admin_session='));
      return !!raw;
    })();

    // ── Extract query params (needed for redirect even for bots) ─
    const sid   = String(req.query.sid || '').slice(0, 64)  || null;
    const query = String(req.query.q   || '').slice(0, 500) || null;

    // ── Fire-and-forget: increment click counter + log event ──
    if (!isAdmin && !isBot) {
      const referrer = String(req.headers.referer || '').slice(0, 500) || null;
      const uaTrunc  = ua.slice(0, 500) || null;
      const ip       = req.ip || req.headers['x-forwarded-for'] || '';
      const ip_hash  = ip
        ? require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 64)
        : null;

      db.query('UPDATE products SET click_count = click_count + 1 WHERE id = ?', [id]).catch(() => {});
      db.query(
        `INSERT INTO affiliate_click_events (product_id, sid, query, source, has_affiliate, referrer, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, sid, query, source || null, affiliate_link ? 1 : 0, referrer, ip_hash, uaTrunc]
      ).catch(() => {});
    }

    // ── If product has AI analysis, show product page first ───
    // Pass sid/q through so CTA on product page can still track
    if (ai_analysis) {
      const qs = new URLSearchParams();
      if (sid)   qs.set('sid', sid);
      if (query) qs.set('q', query);
      const qstr = qs.toString() ? '?' + qs.toString() : '';
      return res.redirect(302, `/p/${id}${qstr}`);
    }

    return res.redirect(302, dest);
  } catch {
    return res.redirect('/');
  }
});

// ── Alerts from extension ─────────────────────────────────────
// POST /api/alert  { type:'captcha'|'enrich_done', ... }
app.post('/api/alert', async (req, res) => {
  const body = req.body || {};
  const { type } = body;
  console.log(`[alert] received type=${type}`, JSON.stringify(body).slice(0, 200));

  if (type === 'captcha') {
    const { source, url } = body;
    console.warn(`[alert] CAPTCHA detected on ${source}: ${url}`);
    telegram.alertCaptcha(source || 'unknown', url).catch(e => console.error('[alert] telegram captcha failed:', e.message));
  }

  if (type === 'enrich_done') {
    const { id, title, fields } = body;
    telegram.reportEnrichDone({ id, title, fields }).catch(e => console.error('[alert] telegram enrich_done failed:', e.message));
    // Trigger background AI analysis generation for this product
    if (id) productAnalysis.generateAndSave(id).catch(e => console.error('[alert] analysis failed:', e.message));
  }

  res.json({ ok: true });
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    db.ping().catch(() => false),
    cache.ping().catch(() => false),
  ]);
  const status = dbOk && redisOk ? 200 : 503;
  res.status(status).json({
    status:  status === 200 ? 'ok' : 'degraded',
    db:      dbOk,
    redis:   redisOk,
    vllm_cb: require('./services/vllm').CB.state,
    uptime:  Math.floor(process.uptime()),
  });
});

// ── Places page ──────────────────────────────────────────────
app.get('/places', (req, res) => {
  res.sendFile(path.join(__dirname, '../places.html'));
});

// ── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server] unhandled:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(cfg.PORT, () => {
  // Start keyword seeder (10-minute interval, queues scraping jobs from PDF keywords)
  keywordSeeder.start();

  // Proxy manager — initial fetch + health check, then refresh every hour
  proxyChecker.refresh().catch(e => console.error('[proxy] initial refresh error:', e.message));
  setInterval(() => proxyChecker.refresh(), 60 * 60 * 1000);

  console.log(`\n finding.id backend running on port ${cfg.PORT}`);
  console.log(` vLLM:     ${cfg.VLLM.BASE_URL}`);
  console.log(` RAG:      ${cfg.RAG.URL}`);
  console.log(` Redis:    ${cfg.REDIS.URL}`);
  console.log(` DB:       ${cfg.DB.HOST}:${cfg.DB.PORT}/${cfg.DB.NAME}`);
  console.log(` Env:      ${cfg.NODE_ENV}\n`);
});

module.exports = app;
