'use strict';
let lastLogCount = 0;

// ── Toggle setup ──────────────────────────────────────────────────
const TOGGLES = [
  { id: 'toggleScrape',    key: 'enableScrape',    rowId: 'rowScrape'    },
  { id: 'toggleEnrich',    key: 'enableEnrich',    rowId: 'rowEnrich'    },
  { id: 'toggleAffiliate', key: 'enableAffiliate', rowId: 'rowAffiliate' },
];

async function loadToggles() {
  const keys = TOGGLES.map(t => t.key);
  const data  = await chrome.storage.local.get(keys);
  for (const t of TOGGLES) {
    const el  = document.getElementById(t.id);
    const row = document.getElementById(t.rowId);
    const on  = data[t.key] !== false; // default ON
    el.checked = on;
    row.classList.toggle('active', on);
  }
}

function bindToggles() {
  for (const t of TOGGLES) {
    const el  = document.getElementById(t.id);
    const row = document.getElementById(t.rowId);
    el.addEventListener('change', async () => {
      const on = el.checked;
      row.classList.toggle('active', on);
      await chrome.storage.local.set({ [t.key]: on });
      chrome.runtime.sendMessage({ type: 'TOGGLE_CHANGED', key: t.key, value: on }).catch(() => {});
    });
  }
}

// ── Stats + log ───────────────────────────────────────────────────
async function load() {
  const data = await chrome.storage.local.get([
    'agentId', 'status', 'lastJobAt', 'totalIngested', 'agentLogs',
    ...TOGGLES.map(t => t.key),
  ]);

  const status   = data.status || 'idle';
  const statusEl = document.getElementById('status');
  statusEl.textContent = status;
  statusEl.className   = 'val ' + ({ working: 'warn', error: 'err', polling: 'poll' }[status] || 'ok');

  document.getElementById('agentId').textContent =
    (data.agentId || '-').slice(6, 20) + '…';
  document.getElementById('total').textContent = data.totalIngested || 0;

  if (data.lastJobAt) {
    const ago = Math.round((Date.now() - data.lastJobAt) / 1000);
    document.getElementById('lastJob').textContent =
      ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
  }

  // Sync toggle states in case background changed them
  for (const t of TOGGLES) {
    const el  = document.getElementById(t.id);
    const row = document.getElementById(t.rowId);
    const on  = data[t.key] !== false;
    el.checked = on;
    row.classList.toggle('active', on);
  }

  const logs = data.agentLogs || [];
  document.getElementById('logCount').textContent = `${logs.length} lines`;
  if (logs.length !== lastLogCount) {
    lastLogCount = logs.length;
    renderLogs(logs);
  }
}

function renderLogs(logs) {
  const box = document.getElementById('logBox');
  const wasAtBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 20;
  box.innerHTML = logs.map(line => {
    let cls = 'info';
    if (line.includes(' ERR '))        cls = 'err';
    else if (line.includes(' WARN '))  cls = 'warn';
    else if (line.includes(' PAGE '))  cls = 'page';
    else if (line.includes('[proxy]')) cls = 'prx';
    const escaped = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="line ${cls}">${escaped}</div>`;
  }).join('');
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

async function clearLogs() {
  await chrome.storage.local.set({ agentLogs: [] });
  lastLogCount = 0;
  document.getElementById('logBox').innerHTML = '';
  document.getElementById('logCount').textContent = '0 lines';
}

// ── Init ──────────────────────────────────────────────────────────
document.getElementById('btnClear').addEventListener('click', clearLogs);

loadToggles();
bindToggles();
load();
setInterval(load, 2000);
