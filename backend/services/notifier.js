'use strict';
const Redis       = require('ioredis');
const EventEmitter = require('events');
const cfg         = require('../config/config');

// ================================================================
// Cross-process pub/sub for search ↔ ingest coordination.
//
// PM2 runs multiple cluster workers — each has its own memory.
// A plain EventEmitter only works within one process, so ingest on
// worker-0 would never wake a search waiting on worker-1.
//
// Redis pub/sub broadcasts across all workers:
//   publisher  — one connection, used by ingest.js to emit
//   subscriber — one connection per worker, receives broadcasts
//
// API mirrors EventEmitter (once / off / emit) so call sites are unchanged.
// ================================================================

const CHANNEL_PREFIX = 'fid:ingest:';

const publisher  = new Redis(cfg.REDIS.URL, { lazyConnect: false, enableReadyCheck: false });
const subscriber = new Redis(cfg.REDIS.URL, { lazyConnect: false, enableReadyCheck: false });

// Local emitter routes incoming Redis messages to once/on listeners
const local = new EventEmitter();
local.setMaxListeners(500);

subscriber.on('message', (channel, message) => {
  if (channel.startsWith(CHANNEL_PREFIX)) {
    const event = channel.slice(CHANNEL_PREFIX.length);
    let payload;
    try { payload = JSON.parse(message); } catch (_) { payload = undefined; }
    local.emit(event, payload);
  }
});

// Track which events we're subscribed to (avoid duplicate SUBSCRIBE calls)
const subscribed = new Set();

function ensureSubscribed(event) {
  if (subscribed.has(event)) return;
  subscribed.add(event);
  subscriber.subscribe(CHANNEL_PREFIX + event).catch(err =>
    console.error('[notifier] subscribe error:', err.message)
  );
}

function unsubscribeIfUnused(event) {
  if (local.listenerCount(event) === 0 && subscribed.has(event)) {
    subscribed.delete(event);
    subscriber.unsubscribe(CHANNEL_PREFIX + event).catch(() => {});
  }
}

module.exports = {
  on(event, fn) {
    ensureSubscribed(event);
    local.on(event, fn);
  },

  once(event, fn) {
    ensureSubscribed(event);
    local.once(event, fn);
  },

  off(event, fn) {
    local.off(event, fn);
    unsubscribeIfUnused(event);
  },

  emit(event, payload) {
    const message = payload !== undefined ? JSON.stringify(payload) : '1';
    publisher.publish(CHANNEL_PREFIX + event, message).catch(err =>
      console.error('[notifier] publish error:', err.message)
    );
  },
};
