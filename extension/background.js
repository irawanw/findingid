'use strict';
// ================================================================
// finding.id — Background Service Worker v3.0
// Manifest V3
//
// JOB TYPES:
//   scrape job (priority >= 1): user searched on finding.id
//     → poll GET /api/jobs?priority_min=1 every POLL_INTERVAL seconds
//     → call Shopee search API directly with browser cookies
//     → POST /api/ingest
//
//   keyword job (priority = 0): background keyword seeder
//     → NOT handled by this extension (handled by scraper.py)
//
// NO SSE — MV3 service workers get terminated ~30s after install,
// making long-lived SSE connections unreliable. Alarm-based polling
// is the correct MV3 pattern.
// ================================================================

const API_BASE      = 'https://finding.id';
const API_KEY       = 'findingid-ingest-12ada3cec82e435f3787d7c8e510a211';
const POLL_INTERVAL = 2;   // seconds (works in dev mode; Chrome clamps to 1min in prod)
const MAX_LOG_LINES = 200;

// ── Proxy rotation ────────────────────────────────────────────────
// Proxy list is fetched from the backend (sourced from proxifly/free-proxy-list ID proxies,
// health-checked via TCP). Falls back to direct connection if no proxies available.
let _proxies    = [];
let _proxyIndex = 0;
let _proxyFetchedAt = 0;
const PROXY_TTL_MS = 30 * 60 * 1000; // re-fetch every 30 min

async function loadProxies() {
  if (_proxies.length && Date.now() - _proxyFetchedAt < PROXY_TTL_MS) return;
  try {
    const res = await fetch(`${API_BASE}/api/proxies/healthy`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) return;
    const { proxies } = await res.json();
    if (Array.isArray(proxies) && proxies.length) {
      _proxies = proxies;
      _proxyFetchedAt = Date.now();
      _proxyIndex = 0;
      info(`[proxy] loaded ${proxies.length} healthy proxies`);
    }
  } catch (e) {
    warn('[proxy] failed to load proxies:', e.message);
  }
}

async function rotateProxy() {
  await loadProxies();
  if (!_proxies.length) return; // no proxies — use direct connection
  const proxy = _proxies[_proxyIndex % _proxies.length];
  _proxyIndex = (_proxyIndex + 1) % _proxies.length;
  return new Promise((resolve) => {
    chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: { singleProxy: { scheme: proxy.protocol || 'http', host: proxy.ip, port: proxy.port } },
      },
      scope: 'regular',
    }, () => {
      if (chrome.runtime.lastError) {
        warn(`[proxy] set failed: ${chrome.runtime.lastError.message}`);
      } else {
        info(`[proxy] → ${proxy.ip}:${proxy.port} (${proxy.latency_ms}ms)`);
      }
      resolve(proxy);
    });
  });
}

async function clearProxy() {
  return new Promise((resolve) => {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => resolve());
  });
}

// Report a failed proxy back to backend so it gets penalised in DB
async function reportProxyFailed(proxy) {
  if (!proxy?.ip) return;
  fetch(`${API_BASE}/api/proxies/report`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body:    JSON.stringify({ ip: proxy.ip, port: proxy.port }),
  }).catch(() => {});
}

let AGENT_ID          = null;
let agentLogs         = [];
let _jobRunning       = false;
let _affiliateRunning = false;
let _scrapeTabId      = null;  // tab ID of active fetchShopeeViaTab tab
let _nextJobAt        = 0;     // cooldown: don't claim next job until this timestamp

const JOB_COOLDOWN_MIN_MS = 6.25 * 60 * 1000; // 6m 15s (1.25× original 5m)
const JOB_COOLDOWN_MAX_MS = 12.5 * 60 * 1000; // 12m 30s (1.25× original 10m)

function scheduleNextJob() {
  const delay = JOB_COOLDOWN_MIN_MS + Math.random() * (JOB_COOLDOWN_MAX_MS - JOB_COOLDOWN_MIN_MS);
  _nextJobAt = Date.now() + delay;
  info(`[scrape] next job in ${Math.round(delay / 60000)}m`);
}

// ── Logging ───────────────────────────────────────────────────────
function log(level, ...args) {
  const ts  = new Date().toISOString().slice(11, 23);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${ts}] ${level.toUpperCase()} ${msg}`;
  if (level === 'err') console.error('[fid:bg]', msg);
  else                 console.log('[fid:bg]', msg);
  agentLogs.push(line);
  if (agentLogs.length > MAX_LOG_LINES) agentLogs = agentLogs.slice(-MAX_LOG_LINES);
  chrome.storage.local.set({ agentLogs }).catch(() => {});
}
const info = (...a) => log('info', ...a);
const warn = (...a) => log('warn', ...a);
const err  = (...a) => log('err',  ...a);

// ── Init ──────────────────────────────────────────────────────────
async function runJobsNow() {
  if (await isEnabled('enableScrape'))    pollScrapeJobs();
  if (await isEnabled('enableAffiliate')) pollAffiliateJobs();
  if (await isEnabled('enableEnrich'))    pollEnrichQueue().finally(() => scheduleNextEnrich());
  else                                    scheduleNextEnrich();
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('agentId');
  AGENT_ID = stored.agentId || ('agent_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now());
  await chrome.storage.local.set({ agentId: AGENT_ID });
  info('Installed. Agent ID:', AGENT_ID);
  chrome.proxy.settings.clear({ scope: 'regular' }, () => {});
  setupAlarm();
  setupImageBlocking();
  setTimeout(runJobsNow, 3000); // wait for Chrome to finish initializing
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(['agentId', 'agentLogs', 'enableScrape']);
  AGENT_ID  = stored.agentId  || 'agent_unknown';
  agentLogs = stored.agentLogs || [];
  info('Startup. Agent ID:', AGENT_ID);
  setupImageBlocking();
  fetch(`${API_BASE}/api/scraper/enabled`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body:    JSON.stringify({ enabled: stored.enableScrape !== false }),
  }).catch(() => {});
  setupAlarm();
  setTimeout(runJobsNow, 3000); // wait for Chrome to finish initializing
});

async function ensureAgentId() {
  if (AGENT_ID) return;
  const stored = await chrome.storage.local.get(['agentId', 'agentLogs']);
  AGENT_ID  = stored.agentId  || 'agent_unknown';
  agentLogs = stored.agentLogs || [];
}

const AFFILIATE_INTERVAL_S = 10; // affiliate link generation — background, not time-critical
const ENRICH_ALARM_MIN_MS  = 5.625 * 60 * 1000; // 5m 37.5s (1.5× previous)
const ENRICH_ALARM_MAX_MS  = 9.375 * 60 * 1000; // 9m 22.5s (1.5× previous)

function scheduleNextEnrich() {
  const delayMs = ENRICH_ALARM_MIN_MS + Math.random() * (ENRICH_ALARM_MAX_MS - ENRICH_ALARM_MIN_MS);
  chrome.alarms.create('enrich', { delayInMinutes: delayMs / 60000 });
}

// Block images + media on marketplace tabs to save bandwidth.
// Uses declarativeNetRequest dynamic rules (MV3-safe, no webRequestBlocking needed).
function setupImageBlocking() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: {
        resourceTypes: ['image', 'media'],
        initiatorDomains: [
          'shopee.co.id',
          'tokopedia.com',
          'rumah123.com',
          'olx.co.id',
        ],
      },
    }],
  }, () => {
    if (chrome.runtime.lastError) warn('[dnr] image block error:', chrome.runtime.lastError.message);
    else info('[dnr] image blocking enabled');
  });
}

function setupAlarm() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('poll',      { periodInMinutes: POLL_INTERVAL / 60 });
    chrome.alarms.create('affiliate', { periodInMinutes: AFFILIATE_INTERVAL_S / 60 });
    // enrich alarm scheduled by runJobsNow after immediate first run
    info(`Alarms set — scrape every ${POLL_INTERVAL}s, affiliate every ${AFFILIATE_INTERVAL_S}s`);
  });
}

// ── Toggle helpers ────────────────────────────────────────────────
async function isEnabled(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] !== false; // default ON
}

// ── Alarm handler ─────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'poll') {
    if (await isEnabled('enableScrape')) pollScrapeJobs();
  }
  if (alarm.name === 'affiliate') {
    if (await isEnabled('enableAffiliate')) pollAffiliateJobs();
  }
  if (alarm.name === 'enrich') {
    if (await isEnabled('enableEnrich')) {
      pollEnrichQueue().finally(() => scheduleNextEnrich());
    } else {
      scheduleNextEnrich(); // keep rescheduling even when disabled
    }
  }
});

// ── Global message handler ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LOG') {
    const ts   = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] PAGE  ${msg.tag} ${msg.msg}`;
    agentLogs.push(line);
    if (agentLogs.length > MAX_LOG_LINES) agentLogs = agentLogs.slice(-MAX_LOG_LINES);
    chrome.storage.local.set({ agentLogs }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // TOGGLE_CHANGED — sync enableScrape to backend so shopee_scraper.py can read it
  if (msg.type === 'TOGGLE_CHANGED' && msg.key === 'enableScrape') {
    fetch(`${API_BASE}/api/scraper/enabled`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body:    JSON.stringify({ enabled: msg.value }),
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // PRODUCTS_SCRAPED — passive push from content script (content_interceptor.js still runs on marketplace pages)
  if (msg.type === 'PRODUCTS_SCRAPED') {
    // If from our active scrape tab, fetchShopeeViaTab's own listener handles it
    if (_scrapeTabId && sender.tab?.id === _scrapeTabId) {
      sendResponse({ ok: true });
      return false;
    }
    const products = msg.products || [];
    const src      = msg.source   || 'shopee';
    if (products.length) {
      ingestProducts(null, src, products)
        .then(r => info(`[passive:${src}] pushed ${products.length} products inserted=${r?.inserted}`))
        .catch(e => warn(`[passive:${src}] ingest error: ${e.message}`));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'REVIEWS_SCRAPED' || msg.type === 'AFFILIATE_LINKS_RESULT') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CAPTCHA_DETECTED') {
    sendResponse({ ok: true });
    fetch(`${API_BASE}/api/alert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'captcha', source: msg.source, url: msg.url }),
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'SCRAPE_NOW') {
    chrome.storage.local.set({ lastEnrichAt: 0, nextEnrichDelay: 0 });
    pollEnrichQueue();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'AFFILIATE_ALL') {
    sendResponse({ ok: true });
    (async () => {
      let total = 0, rounds = 0;
      const MAX_ROUNDS = 100;
      info('[affiliate-all] Starting bulk affiliate generation…');
      while (rounds++ < MAX_ROUNDS) {
        const res = await fetch(`${API_BASE}/api/affiliate-jobs`, {
          headers: { 'X-API-Key': API_KEY },
        }).catch(() => null);
        if (!res?.ok) { warn('[affiliate-all] Poll failed'); break; }
        const { items } = await res.json();
        if (!items?.length) { info(`[affiliate-all] Done — ${total} links generated`); break; }
        info(`[affiliate-all] Round ${rounds}: ${items.length} items…`);
        await runAffiliateJob(items);
        total += items.length;
      }
    })();
    return false;
  }
});

// ── Finding.id keepalive port — wakes service worker on search ────────────────────
// content_findingid.js connects here. Open port = Chrome won't kill the service worker
// while finding.id tab is open, eliminating the 1-minute alarm delay for priority jobs.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'findingid-page') return;
  info('[keepalive] finding.id page connected');

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'SEARCH_TRIGGERED') return;
    info(`[keepalive] search triggered: "${msg.query}" — polling for priority job`);
    if (!(await isEnabled('enableScrape'))) return;
    await ensureAgentId();
    // Poll every 3s for up to 45s — the job is created by search.js within ~1s
    for (let i = 0; i < 15; i++) {
      if (_jobRunning) break;
      try {
        const prioRes = await fetch(`${API_BASE}/api/jobs?priority_min=1`, {
          headers: { 'X-Agent-ID': AGENT_ID, 'X-API-Key': API_KEY },
        });
        if (prioRes.ok) {
          const { job: prioJob } = await prioRes.json();
          if (prioJob) {
            info(`[keepalive] priority job found: "${prioJob.query}"`);
            runPriorityScrapeJob(prioJob);
            break;
          }
        }
      } catch (e) { warn('[keepalive] poll error:', e.message); }
      await new Promise(r => setTimeout(r, 3000));
    }
  });

  port.onDisconnect.addListener(() => {
    info('[keepalive] finding.id page disconnected');
  });
});

// ── Scrape job polling ────────────────────────────────────────────
// ── Priority scrape: inject direct API fetch (no tab navigation, no XHR wait) ─────
// Runs immediately when a user triggers a search on finding.id. Uses executeScript
// in MAIN world to call marketplace search APIs directly with browser session cookies.
// Results come back via window.postMessage → content.js → PRODUCTS_SCRAPED message.

function fetchViaTabDirect(tabId, source, injectFn, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const hardTimeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      chrome.runtime.onMessage.removeListener(msgHandler);
      reject(new Error(`${source} direct-inject timeout`));
    }, timeoutMs);

    function msgHandler(msg, sender) {
      if (sender.tab?.id !== tabId) return;
      if (msg.type !== 'PRODUCTS_SCRAPED') return;
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      chrome.runtime.onMessage.removeListener(msgHandler);
      resolve(msg.products || []);
    }

    chrome.runtime.onMessage.addListener(msgHandler);
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world:  'MAIN',
      func:   injectFn,
      args,
    }).catch(e => {
      if (!resolved) {
        resolved = true;
        clearTimeout(hardTimeout);
        chrome.runtime.onMessage.removeListener(msgHandler);
        reject(new Error(`executeScript: ${e.message}`));
      }
    });
  });
}

async function fetchShopeeViaTabDirect(keyword) {
  const tab = await findShopeeTab();
  if (!tab) throw new Error('No Shopee tab open');
  info(`[scrape:shopee] direct inject tab=${tab.id} keyword="${keyword}"`);
  return fetchViaTabDirect(tab.id, 'shopee', function(kw) {
    const url = `/api/v4/search/search_items?by=relevancy&keyword=${encodeURIComponent(kw)}&limit=60&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2`;
    fetch(url, { credentials: 'include' })
      .then(r => r.json())
      .then(data => window.postMessage({ __fid: true, url, data }, '*'))
      .catch(e => console.warn('[fid:direct:shopee]', e.message));
  }, [keyword]);
}

async function fetchTokopediaViaTabDirect(keyword) {
  const tab = await findTokopediaTab();
  if (!tab) throw new Error('No Tokopedia tab open');
  info(`[scrape:toko] direct inject tab=${tab.id} keyword="${keyword}"`);
  return fetchViaTabDirect(tab.id, 'tokopedia', function(kw) {
    const url  = 'https://gql.tokopedia.com/graphql/AceSearchProductV4Query';
    const body = JSON.stringify([{
      operationName: 'AceSearchProductV4Query',
      variables: { params: `keyword=${encodeURIComponent(kw)}&page=1&rows=60&source=search&start=0&device=desktop` },
      query: 'query AceSearchProductV4Query($params:String!){aceSearchProductV4(params:$params){data{products{id name url appLinks{android} price{number value} rating transactionSuccess countSold imageUrl mediaURL{image image300} category{name breadcrumb} label_groups{position title content type}}}}}',
    }]);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'include',
    }).then(r => r.json())
      .then(data => {
        const d = Array.isArray(data) ? data[0] : data;
        window.postMessage({ __fid: true, url, data: d }, '*');
      })
      .catch(e => console.warn('[fid:direct:toko]', e.message));
  }, [keyword]);
}

// Priority job: execute immediately, no tab navigation, direct API inject
async function runPriorityScrapeJob(job) {
  _jobRunning = true;
  let totalInserted = 0;
  info(`[scrape:prio] ▶ "${job.query}" (id=${job.id})`);
  try {
    try {
      const shopeeProducts = await fetchShopeeViaTab(job.query);
      info(`[scrape:prio:shopee] ${shopeeProducts.length} products`);
      if (shopeeProducts.length) {
        const r = await ingestProducts(job.id, 'shopee', shopeeProducts);
        totalInserted += r.inserted || 0;
        info(`[scrape:prio:shopee] inserted=${r.inserted}`);
      }
    } catch (e) { warn(`[scrape:prio:shopee] ${e.message}`); }

    try {
      const tokoProducts = await fetchTokopediaViaTab(job.query);
      info(`[scrape:prio:toko] ${tokoProducts.length} products`);
      if (tokoProducts.length) {
        const r = await ingestProducts(job.id, 'tokopedia', tokoProducts);
        totalInserted += r.inserted || 0;
        info(`[scrape:prio:toko] inserted=${r.inserted}`);
      }
    } catch (e) { warn(`[scrape:prio:toko] ${e.message}`); }

    await markJobDone(job.id, totalInserted);
    info(`[scrape:prio] done — inserted=${totalInserted}`);
  } catch (e) {
    err('[scrape:prio] error:', e.message);
    await markJobDone(job.id, 0);
  } finally {
    _jobRunning = false;
  }
}

// Keyword scrape: background jobs, slower pace, tab navigation + XHR intercept.
// Uses 1.25× longer cooldown to reduce IP block risk.
async function pollScrapeJobs() {
  if (_jobRunning) return;
  await ensureAgentId();

  // ── Priority jobs first — no cooldown gate ──────────────────────
  try {
    const prioRes = await fetch(`${API_BASE}/api/jobs?priority_min=1`, {
      headers: { 'X-Agent-ID': AGENT_ID, 'X-API-Key': API_KEY },
    });
    if (prioRes.ok) {
      const { job: prioJob } = await prioRes.json();
      if (prioJob) {
        info(`[scrape] priority job "${prioJob.query}" (id=${prioJob.id})`);
        return runPriorityScrapeJob(prioJob);
      }
    }
  } catch (e) { warn('[scrape] priority poll error:', e.message); }

  // ── Keyword jobs — respect cooldown ────────────────────────────
  if (Date.now() < _nextJobAt) return;
  try {
    const res = await fetch(`${API_BASE}/api/jobs?priority_min=0`, {
      headers: { 'X-Agent-ID': AGENT_ID, 'X-API-Key': API_KEY },
    });
    if (!res.ok) return;
    const { job } = await res.json();
    if (!job) return;

    info(`[scrape] claimed keyword job "${job.query}" (id=${job.id})`);
    _jobRunning = true;
    let totalInserted = 0;

    try {
      try {
        // await rotateProxy(); // proxy disabled — quota exhausted
        const shopeeProducts = await fetchShopeeViaTab(job.query);
        info(`[scrape:shopee] ${shopeeProducts.length} products`);
        if (shopeeProducts.length) {
          const r = await ingestProducts(job.id, 'shopee', shopeeProducts);
          totalInserted += r.inserted || 0;
          info(`[scrape:shopee] inserted=${r.inserted}`);
        }
      } catch (e) { warn(`[scrape:shopee] ${e.message}`); }

      try {
        // await rotateProxy(); // proxy disabled — quota exhausted
        const tokoProducts = await fetchTokopediaViaTab(job.query);
        info(`[scrape:toko] ${tokoProducts.length} products`);
        if (tokoProducts.length) {
          const r = await ingestProducts(job.id, 'tokopedia', tokoProducts);
          totalInserted += r.inserted || 0;
          info(`[scrape:toko] inserted=${r.inserted}`);
        }
      } catch (e) { warn(`[scrape:toko] ${e.message}`); }

      await markJobDone(job.id, totalInserted);
      info(`[scrape] keyword job done — inserted=${totalInserted}`);
      scheduleNextJob();
    } catch (e) {
      err('[scrape] keyword job error:', e.message);
      await markJobDone(job.id, 0);
      scheduleNextJob();
    } finally {
      _jobRunning = false;
    }
  } catch (e) {
    err('[scrape] keyword poll error:', e.message);
  }
}

async function markJobDone(jobId, count) {
  await fetch(`${API_BASE}/api/jobs/${jobId}/done`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ productsIngested: count }),
  }).catch(() => {});
}

// ── Shared: find existing marketplace tabs (never creates one) ─────
function findShopeeTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://shopee.co.id/*' }, tabs => {
      const ready = tabs.find(t => !t.discarded && t.status === 'complete');
      resolve(ready || tabs[0] || null);
    });
  });
}

function findTokopediaTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://www.tokopedia.com/*' }, tabs => {
      const ready = tabs.find(t => !t.discarded && t.status === 'complete');
      resolve(ready || tabs[0] || null);
    });
  });
}

// Navigate a tab to a URL, return Promise that resolves with PRODUCTS_SCRAPED products
function fetchViaTab(tabId, url, source, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const hardTimeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      chrome.runtime.onMessage.removeListener(msgHandler);
      reject(new Error(`${source} search timeout`));
    }, timeoutMs);

    function msgHandler(msg, sender) {
      if (sender.tab?.id !== tabId) return;
      if (msg.type !== 'PRODUCTS_SCRAPED') return;
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      chrome.runtime.onMessage.removeListener(msgHandler);
      resolve(msg.products || []);
    }

    chrome.runtime.onMessage.addListener(msgHandler);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        resolved = true;
        clearTimeout(hardTimeout);
        chrome.runtime.onMessage.removeListener(msgHandler);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

async function fetchShopeeViaTab(keyword) {
  const tab = await findShopeeTab();
  if (!tab) throw new Error('No Shopee tab open');
  _scrapeTabId = tab.id;
  const url = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;
  info(`[scrape:shopee] tab ${tab.id} → "${keyword}"`);
  try {
    return await fetchViaTab(tab.id, url, 'shopee');
  } finally {
    _scrapeTabId = null;
  }
}

async function fetchTokopediaViaTab(keyword) {
  const tab = await findTokopediaTab();
  if (!tab) throw new Error('No Tokopedia tab open');
  const url = `https://www.tokopedia.com/search?st=product&q=${encodeURIComponent(keyword)}`;
  info(`[scrape:toko] tab ${tab.id} → "${keyword}"`);
  return fetchViaTab(tab.id, url, 'tokopedia');
}

// ── API helpers ───────────────────────────────────────────────────
async function ingestProducts(jobId, source, products) {
  const res = await fetch(`${API_BASE}/api/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'X-Agent-ID': AGENT_ID },
    body:    JSON.stringify({ jobId, source, products }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ingest HTTP ${res.status}: ${text.slice(0, 100)}`);
  return JSON.parse(text);
}

// ── Affiliate job helpers ─────────────────────────────────────────
async function pollAffiliateJobs() {
  if (_affiliateRunning) { info('[affiliate] already running, skipping'); return; }
  _affiliateRunning = true;
  try {
    const res = await fetch(`${API_BASE}/api/affiliate-jobs`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) { warn(`[affiliate] poll HTTP ${res.status}`); return; }
    const { items } = await res.json();
    if (!items?.length) { info('[affiliate] No jobs pending'); return; }

    info(`[affiliate] Got ${items.length} products needing affiliate links`);
    await runAffiliateJob(items);
  } catch (e) {
    err('[affiliate] poll error:', e.message);
  } finally {
    _affiliateRunning = false;
  }
}

const AFFILIATE_CHUNK_SIZE      = 5;
const AFFILIATE_CHUNK_DELAY_MIN = 7000;
const AFFILIATE_CHUNK_DELAY_MAX = 10000;
const CUSTOM_LINK_URL = 'https://affiliate.shopee.co.id/offer/custom_link';

// Always navigate to custom_link (fresh load) before each job
function _ensureCustomLinkPage(tabId) {
  return new Promise((resolve) => {
    function onUpdated(tid, info) {
      if (tid !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(resolve, 1500);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url: CUSTOM_LINK_URL }, () => {
      if (chrome.runtime.lastError) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

// Submit up to 5 product URLs via the custom_link UI, returns [{itemId, shopId, productOfferLink}]
function _affiliateChunk(tabId, chunk) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      resolve([]);
    }, 25000);

    function handler(msg, sender) {
      if (sender.tab?.id !== tabId) return;
      if (msg.type !== 'AFFILIATE_LINKS_RESULT') return;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(handler);
      resolve(msg.links || []);
    }
    chrome.runtime.onMessage.addListener(handler);

    // ISOLATED world: relay postMessage → runtime message
    chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => {
        window.addEventListener('message', function h(ev) {
          if (!ev.data?.__fid_affiliate) return;
          window.removeEventListener('message', h);
          chrome.runtime.sendMessage({ type: 'AFFILIATE_LINKS_RESULT', links: ev.data.links || [], error: ev.data.error || null });
        });
      },
    }).catch(() => {});

    // MAIN world: patch fetch+XHR, fill textarea, click button, close modal
    chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (items) => {
        const LOG = (...a) => console.log('[fid-affiliate]', ...a);

        function handleResponse(data) {
          LOG('raw response:', JSON.stringify(data).slice(0, 300));
          const batch = data?.data?.batchCustomLink || [];
          LOG('batchCustomLink entries:', batch.length, batch.map(b => `failCode=${b.failCode} short=${b.shortLink}`));
          const links = items.map((item, i) => ({
            itemId: item.itemId,
            shopId: item.shopId,
            productOfferLink: batch[i]?.failCode === 0 ? (batch[i].shortLink || null) : null,
          }));
          LOG('mapped links:', links.map(l => `${l.itemId}→${l.productOfferLink}`));

          // Close modal — try multiple strategies with delays
          setTimeout(() => {
            const allBtns = [...document.querySelectorAll('button')];
            LOG('buttons after response:', allBtns.map(b => `"${b.textContent.trim().slice(0,20)}" cls=${b.className.slice(0,50)}`));

            // Try specific selectors first (Ant Design modal)
            const closeEl =
              document.querySelector('.ant-modal-close') ||
              document.querySelector('.ant-modal-close-x') ||
              document.querySelector('[aria-label="Close"]') ||
              document.querySelector('[aria-label="close"]') ||
              allBtns.find(b => /close|tutup|dismiss|cancel/i.test(b.getAttribute('aria-label') || '')) ||
              allBtns.find(b => /ant-modal-close|modal-close|btn-close/i.test(b.className)) ||
              allBtns.find(b => /^[×✕✖x]$/i.test(b.textContent.trim()));

            if (closeEl) {
              LOG('closing modal:', closeEl.tagName, closeEl.className.slice(0,50));
              closeEl.click();
            } else {
              LOG('no close element found, trying Escape');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            }
          }, 800);

          window.postMessage({ __fid_affiliate: true, links }, '*');
        }

        // Patch fetch
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
          const res = await origFetch.apply(this, args);
          const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
          LOG('fetch intercepted:', url.slice(0, 80));
          if (url.includes('gql?q=batchCustomLink')) {
            window.fetch = origFetch;
            res.clone().json().then(handleResponse).catch(e => {
              LOG('parse error:', e);
              window.fetch = origFetch;
              window.postMessage({ __fid_affiliate: true, links: [], error: 'parse error' }, '*');
            });
          }
          return res;
        };

        // Patch XHR as fallback (Shopee may use XHR)
        const OrigXHR = window.XMLHttpRequest;
        function PatchedXHR() {
          const xhr = new OrigXHR();
          const origOpen = xhr.open.bind(xhr);
          let _url = '';
          xhr.open = function(method, url, ...rest) { _url = url; return origOpen(method, url, ...rest); };
          xhr.addEventListener('load', function() {
            if (_url.includes('gql?q=batchCustomLink')) {
              LOG('XHR intercepted:', _url.slice(0, 80));
              window.XMLHttpRequest = OrigXHR;
              window.fetch = origFetch;
              try { handleResponse(JSON.parse(xhr.responseText)); } catch(e) { LOG('XHR parse error:', e); }
            }
          });
          return xhr;
        }
        PatchedXHR.prototype = OrigXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;

        // Fill textarea
        const urls = items.map(i => i.link).join('\n');
        LOG('urls to submit:', urls);
        const textarea = document.querySelector('textarea');
        if (textarea) {
          LOG('textarea found, setting value');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(textarea, urls); else textarea.value = urls;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          LOG('NO TEXTAREA FOUND on page');
        }

        // Click button
        setTimeout(() => {
          const allBtns = [...document.querySelectorAll('button')];
          LOG('buttons available:', allBtns.map(b => `"${b.textContent.trim().slice(0,30)}" disabled=${b.disabled}`));
          const btn = allBtns.find(b => /custom|generate|buat|kirim|submit|dapatkan|link/i.test(b.textContent) && !b.disabled);
          if (btn) {
            LOG('clicking button:', btn.textContent.trim());
            btn.click();
          } else {
            window.fetch = origFetch;
            window.XMLHttpRequest = OrigXHR;
            LOG('NO matching button found');
            window.postMessage({ __fid_affiliate: true, links: [], error: 'button not found' }, '*');
          }
        }, 800);
      },
      args: [chunk],
    }).catch(e => { err('[affiliate] inject error:', e.message); resolve([]); });
  });
}

async function runAffiliateJob(items) {
  // Open or reuse an affiliate tab
  const tabId = await new Promise((resolve) => {
    chrome.tabs.query({}, allTabs => {
      const existing = allTabs.find(t => t.url?.startsWith('https://affiliate.shopee.co.id/'));
      if (existing) return resolve(existing.id);
      chrome.tabs.create({ url: CUSTOM_LINK_URL, active: false }, tab => {
        if (chrome.runtime.lastError) return resolve(null);
        function onLoad(tid, changeInfo) {
          if (tid !== tab.id || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onLoad);
          setTimeout(() => resolve(tab.id), 1500);
        }
        chrome.tabs.onUpdated.addListener(onLoad);
      });
    });
  });

  if (!tabId) { err('[affiliate] could not get tab'); return; }

  await _ensureCustomLinkPage(tabId);

  info(`[affiliate] processing ${items.length} items in batches of 5`);
  const allLinks = [];
  for (let i = 0; i < items.length; i += AFFILIATE_CHUNK_SIZE) {
    const chunk = items.slice(i, i + AFFILIATE_CHUNK_SIZE);
    info(`[affiliate] chunk ${Math.floor(i / AFFILIATE_CHUNK_SIZE) + 1}: ${chunk.length} items`);
    const links = await _affiliateChunk(tabId, chunk);
    allLinks.push(...links);
    if (i + AFFILIATE_CHUNK_SIZE < items.length) {
      const delay = AFFILIATE_CHUNK_DELAY_MIN + Math.random() * (AFFILIATE_CHUNK_DELAY_MAX - AFFILIATE_CHUNK_DELAY_MIN);
      await new Promise(r => setTimeout(r, delay));
      await _ensureCustomLinkPage(tabId); // navigate only if needed between batches
    }
  }

  await submitAffiliateLinks(items, allLinks).catch(e => err('[affiliate] submit error:', e.message));
}

async function submitAffiliateLinks(items, links) {
  // Always submit all items — empty string for failed ones so they leave the queue permanently
  const resultsPayload = items.map(item => {
    const found = links.find(l => String(l.itemId) === String(item.itemId));
    return { id: item.id, affiliateLink: found?.productOfferLink || '' };
  });
  const postRes = await fetch(`${API_BASE}/api/affiliate-jobs/done`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body:    JSON.stringify({ results: resultsPayload }),
  });
  const ok = resultsPayload.filter(r => r.affiliateLink).length;
  info(`[affiliate] Submitted ${ok} links, ${resultsPayload.length - ok} failed/skipped → HTTP ${postRes.status}`);
}

// ── Enrich queue (product detail enrichment) ──────────────────────
let isEnriching = false;

async function pollEnrichQueue() {
  if (isEnriching) return;

  let product;
  try {
    const res = await fetch(`${API_BASE}/api/products/enrich/queue`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) return;
    ({ product } = await res.json());
  } catch (e) { return; }

  if (!product) { info('[enrich] queue empty'); return; }

  isEnriching = true;
  // await rotateProxy(); // proxy disabled — quota exhausted
  info(`[enrich] ▶ id=${product.id} "${product.title?.slice(0, 50)}"`);

  try {
    const data = await _runEnrichByUrl(product.link, product.source_item_id, product.shopid, product.itemid);
    const result = await enrichTestPush(data);
    info(`[enrich] ✓ id=${product.id} rag=${result.rag_indexed}`);
    if (result.updated) {
      fetch(`${API_BASE}/api/alert`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'enrich_done', id: result.id, title: result.title, fields: result.fields }),
      }).catch(() => {});
    }
  } catch (e) {
    err(`[enrich] id=${product.id}: ${e.message}`);
  } finally {
    isEnriching = false;
  }
}

// Navigate existing Shopee tab to product URL — no new tab, no close.
// Shopee JS fires get_pc automatically; reviews (get_ratings) are lazy-scrolled,
// so we inject a direct fetch for both review types after the page fully loads.
function _runEnrichByUrl(productUrl, sourceItemId, shopId, itemId) {
  return new Promise(async (resolve, reject) => {
    const tab = await findShopeeTab();
    if (!tab) return reject(new Error('No Shopee tab open — open shopee.co.id first'));

    const tabId = tab.id;
    let productData = null, finished = false;
    const reviewsData = { positive: [], negative: [] };
    let batchTimer = null, hardTimeout = null;

    function finish(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(batchTimer);
      clearTimeout(hardTimeout);
      chrome.runtime.onMessage.removeListener(msgHandler);
      chrome.tabs.onUpdated.removeListener(onTabComplete);
      const hasAnything = productData || reviewsData.positive.length || reviewsData.negative.length;
      if (!hasAnything) return reject(new Error(`No data (${reason})`));
      resolve({
        source_item_id:  productData?.source_item_id || String(sourceItemId),
        price:           productData?.price           ?? null,
        variants_json:   productData?.variants_json   || null,
        images_json:     productData?.images_json     || null,
        description:     productData?.description     || null,
        specs:           productData?.specs           || null,
        attributes_json: productData?.attributes_json || null,
        reviews_json:    (reviewsData.positive.length || reviewsData.negative.length) ? reviewsData : null,
        sold_count:      productData?.sold_count      ?? null,
        sold_display:    productData?.sold_display    ?? null,
        rating:          productData?.rating          ?? null,
        rating_summary:  productData?.rating_summary  ?? null,
      });
    }

    function resetIdle() {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => finish('idle'), 8000);
    }

    // After page fully loads, inject a direct fetch for reviews (type 0=positive, 3=negative).
    // Reviews are lazy-loaded on scroll; injecting the fetch directly is more reliable.
    // Wait 2s after 'complete' before fetching — Shopee's session/cookies need to settle.
    function onTabComplete(tid, changeInfo) {
      if (tid !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onTabComplete);
      const iid = String(itemId || sourceItemId);
      const sid = String(shopId || '');
      if (!sid) return;
      info(`[enrich] tab loaded — fetching get_pc + reviews in 2s itemid=${iid} shopid=${sid}`);
      setTimeout(() => {
        if (finished) return;
        chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: 'MAIN',
          func: (iid, sid) => {
            // Always re-fetch get_pc so images/variants are captured even when SPA uses cache
            const pcUrl = `/api/v4/pdp/get_pc?item_id=${iid}&shop_id=${sid}`;
            fetch(pcUrl, { credentials: 'include' })
              .then(r => r.json())
              .then(data => window.postMessage({ __fid: true, url: pcUrl, data }, '*'))
              .catch(() => {});
            // Fetch positive + negative reviews
            [0, 3].forEach(type => {
              const url = `/api/v2/item/get_ratings?itemid=${iid}&shopid=${sid}&type=${type}&offset=0&limit=6&flag=1&filter=0`;
              fetch(url, { credentials: 'include' })
                .then(r => r.json())
                .then(data => window.postMessage({ __fid: true, url, data }, '*'))
                .catch(() => {});
            });
          },
          args: [iid, sid],
        }).catch(e => warn(`[enrich] inject error: ${e.message}`));
      }, 2000);
    }

    function msgHandler(msg, sender) {
      if (sender.tab?.id !== tabId) return;
      if (msg.type === 'REVIEWS_SCRAPED') {
        for (const r of (msg.reviews || [])) {
          if (String(r.source_item_id) !== String(sourceItemId)) continue;
          const arr = r.review_type === 3 ? reviewsData.negative : reviewsData.positive;
          if (arr.length < 3) arr.push({ star: r.rating_star, text: (r.comment||'').slice(0,500), user: r.author_username||'anonymous', variant: r.variant_name||null });
        }
        resetIdle();
      }
      if (msg.type === 'PRODUCTS_SCRAPED') {
        for (const p of (msg.products || [])) {
          if (String(p.source_item_id) === String(sourceItemId)) productData = p;
        }
        resetIdle();
      }
    }

    chrome.tabs.onUpdated.addListener(onTabComplete);
    chrome.runtime.onMessage.addListener(msgHandler);
    chrome.tabs.update(tabId, { url: productUrl }, () => {
      if (chrome.runtime.lastError) {
        chrome.runtime.onMessage.removeListener(msgHandler);
        chrome.tabs.onUpdated.removeListener(onTabComplete);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      hardTimeout = setTimeout(() => finish('timeout'), 50000);
      batchTimer  = setTimeout(() => finish('idle-start'), 25000);
      info(`[enrich] tab ${tabId} → ${productUrl}`);
    });
  });
}

async function enrichTestPush(data) {
  const res = await fetch(`${API_BASE}/api/products/enrich`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body:    JSON.stringify(data),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}
