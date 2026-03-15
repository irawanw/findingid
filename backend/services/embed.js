'use strict';
const axios = require('axios');
const cfg   = require('../config/config');

// ================================================================
// Embedding Service
//
// Calls the embedding endpoint (OpenAI-compatible /v1/embeddings).
// Points to the same vLLM instance or a dedicated embedding server
// (e.g., Text Embeddings Inference by HuggingFace).
//
// For production at 10-50M records:
//   - Use a dedicated, lightweight embedding model (e.g., BGE-M3, E5)
//   - Batch embed at ingest time; never embed at query time in hot path
//   - Target embedding dim 768 (smaller = faster Qdrant search)
// ================================================================

const http = axios.create({
  baseURL: cfg.EMBED.BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Embed a single string. Returns Float32Array.
 */
async function embedOne(text) {
  const vecs = await embedBatch([text]);
  return vecs[0];
}

/**
 * Embed multiple strings in one API call. Returns Array of Float32Array.
 * Batch up to 32 at a time for memory safety.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];

  const payload = {
    model: cfg.EMBED.MODEL,
    input: texts,
    encoding_format: 'float',
  };

  const res = await http.post('/embeddings', payload);
  const data = res.data?.data;
  if (!Array.isArray(data)) throw new Error('Invalid embedding response');

  // Sort by index in case API returns out-of-order
  data.sort((a, b) => a.index - b.index);
  return data.map(d => new Float32Array(d.embedding));
}

module.exports = { embedOne, embedBatch };
