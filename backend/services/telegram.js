'use strict';
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8293099809:AAFG-MZ1L-ddoTpGIGmRWSFyBYH3o7EuRbc';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '337802884';
const API_URL   = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

/**
 * Send a Telegram message.
 * @param {string} text  Markdown-safe text
 */
async function send(text) {
  const payload = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(API_URL, payload, { timeout: 15000 });
      return;
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || (err.message || '').includes('timeout');
      if (attempt < 3 && isTimeout) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      console.error(`[telegram] send failed (attempt ${attempt}):`, err.message);
    }
  }
}

/**
 * CAPTCHA alert — called when extension detects a challenge page.
 * @param {string} source  e.g. 'shopee'
 * @param {string} url     Page URL where CAPTCHA appeared
 */
async function alertCaptcha(source, url) {
  // Truncate URL — Shopee CAPTCHA URLs are huge and can break Telegram messages
  const shortUrl = url ? url.split('?')[0].slice(0, 200) : 'N/A';
  await send(
    `⚠️ <b>CAPTCHA terdeteksi!</b>\n\n` +
    `🌐 Source: <b>${source}</b>\n` +
    `🔗 URL: ${shortUrl}\n\n` +
    `Scraper otomatis dihentikan sementara.`
  );
}

/**
 * Job completion report.
 * @param {object} stats
 * @param {string} stats.query
 * @param {number} stats.remainingPriority
 * @param {number} stats.remainingKeywords
 * @param {boolean} stats.isPriority
 */
async function reportJobDone(stats) {
  const icon = stats.isPriority ? '🎯' : '🔍';
  const type = stats.isPriority ? 'Priority' : 'Keyword';
  const errLine = stats.errors > 0 ? `\n⚠️ Error: ${stats.errors}` : '';
  await send(
    `${icon} <b>Scrape ${type} selesai</b>\n` +
    `🔎 <b>${stats.query || '-'}</b>\n\n` +
    `📦 Total produk : <b>${stats.total ?? 0}</b>\n` +
    `🆕 Baru         : <b>${stats.newCount ?? 0}</b>\n` +
    `🔄 Diperbarui   : <b>${stats.updatedCount ?? 0}</b>\n` +
    `💰 Harga berubah: <b>${stats.priceChanged ?? 0}</b>` +
    errLine + `\n\n` +
    `⏳ Antrian priority : ${stats.remainingPriority ?? 0}\n` +
    `📋 Antrian keyword  : ${stats.remainingKeywords ?? 0}`
  );
}

/**
 * Seeder cycle summary.
 * @param {object} stats
 * @param {number} stats.jobsCreated
 * @param {number} stats.totalKeywords
 * @param {number} stats.pendingKeywords
 */
async function reportSeederCycle(stats) {
  await send(
    `🌱 <b>Seeder cycle</b>\n\n` +
    `📋 Keywords total: ${stats.totalKeywords}\n` +
    `⏳ Belum di-scrape: ${stats.pendingKeywords}\n` +
    `🚀 Jobs dibuat: <b>${stats.jobsCreated}</b>`
  );
}

/**
 * Enrichment completion report.
 * @param {object} info
 * @param {number} info.id
 * @param {string} info.title
 * @param {object} info.fields  { description, specs, attributes, reviews }
 */
async function reportEnrichDone(info) {
  const filled = Object.entries(info.fields || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'nothing';
  const pageLink = info.id ? `\n🔗 <a href="https://finding.id/p/${info.id}">Lihat halaman produk</a>` : '';
  await send(
    `✅ <b>Enrichment selesai</b>\n\n` +
    `🆔 ID: ${info.id}\n` +
    `📦 ${(info.title || '').slice(0, 80)}\n` +
    `📝 Data: <b>${filled}</b>` +
    pageLink
  );
}

module.exports = { send, alertCaptcha, reportJobDone, reportSeederCycle, reportEnrichDone };
