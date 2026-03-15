'use strict';
const axios = require('axios');
const cfg   = require('../config/config');

// ================================================================
// Qdrant Vector DB Client
//
// REST-based wrapper around Qdrant HTTP API.
// Qdrant uses HNSW index by default — O(log n) query time.
//
// Collection schema (set up once via initCollection):
//   vector size : cfg.EMBED.DIM  (e.g. 1536 or 768)
//   distance    : Cosine
//   on_disk     : true  → required for 10-50M vectors (RAM < vectors)
//   HNSW m      : 16    → balance recall vs memory
//   HNSW ef     : 100   → search accuracy
//
// Payload filters supported:
//   source  : "shopee" | "tokopedia" | "rumah" | "mobil"
//   category: string
//   price   : numeric range
// ================================================================

const http = axios.create({
  baseURL: cfg.QDRANT.URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    ...(cfg.QDRANT.API_KEY ? { 'api-key': cfg.QDRANT.API_KEY } : {}),
  },
});

const COL = cfg.QDRANT.COLLECTION;

/**
 * Create collection with HNSW index (run once at startup).
 * Idempotent — skips if already exists.
 */
async function initCollection() {
  // Check if exists
  try {
    await http.get(`/collections/${COL}`);
    return; // already exists
  } catch (e) {
    if (e.response?.status !== 404) throw e;
  }

  // Create
  await http.put(`/collections/${COL}`, {
    vectors: {
      size:     cfg.EMBED.DIM,
      distance: 'Cosine',
      on_disk:  true,          // store vectors on disk for scale
    },
    hnsw_config: {
      m:                 16,
      ef_construct:      100,
      full_scan_threshold: 10000,
    },
    optimizers_config: {
      indexing_threshold: 20000,
      memmap_threshold:   50000,
    },
    // Payload index for fast filtered search
    // Created separately below
  });

  // Create payload indexes for common filters
  for (const field of ['source', 'category', 'price']) {
    await http.put(`/collections/${COL}/index`, {
      field_name: field,
      field_schema: field === 'price' ? 'float' : 'keyword',
    }).catch(() => {}); // Non-fatal if index exists
  }

  console.log(`[qdrant] collection "${COL}" created`);
}

/**
 * Upsert product vectors.
 * points: [{ id, vector: Float32Array, payload: {...} }]
 */
async function upsert(points) {
  if (!points.length) return;
  await http.put(`/collections/${COL}/points`, {
    points: points.map(p => ({
      id:      p.id,
      vector:  Array.from(p.vector),
      payload: p.payload,
    })),
  });
}

/**
 * Search for top-k nearest vectors.
 * vector: Float32Array  queryVector
 * filter: optional Qdrant filter object
 * Returns array of { id, score, payload }
 */
async function search(vector, { topK = cfg.QDRANT.TOP_K, filter } = {}) {
  const body = {
    vector:       Array.from(vector),
    limit:        topK,
    with_payload: true,
    with_vector:  false,
  };
  if (filter) body.filter = filter;

  const res = await http.post(`/collections/${COL}/points/search`, body);
  return res.data?.result ?? [];
}

/**
 * Delete points by IDs.
 */
async function deletePoints(ids) {
  await http.post(`/collections/${COL}/points/delete`, {
    points: ids,
  });
}

/**
 * Healthcheck.
 */
async function ping() {
  try {
    const res = await http.get('/healthz');
    return res.status === 200;
  } catch { return false; }
}

module.exports = { initCollection, upsert, search, deletePoints, ping };
