'use strict';
require('dotenv').config();

// ================================================================
// finding.id — Central Configuration
//
// Infrastructure cross-reference (/data/www/aimin):
//   vLLM:        http://127.0.0.1:8001/v1  (Qwen3.5-9B-UD-Q5_K_XL, llama.cpp)
//   RAG service: http://127.0.0.1:8002     (FastAPI, BGE-M3 1024-dim)
//   Qdrant:      http://localhost:6333      (collection: aimin_products)
//   Embed dim:   1024                       (BAAI/bge-m3 dense)
// ================================================================
module.exports = {

  // ── Server ────────────────────────────────────────────────
  PORT:     parseInt(process.env.PORT)    || 3000,
  NODE_ENV: process.env.NODE_ENV          || 'development',
  IS_PROD:  process.env.NODE_ENV === 'production',

  // ── vLLM OpenAI-compatible API ───────────────────────────
  // POST /v1/chat/completions  stream:true/false
  VLLM: {
    BASE_URL:    process.env.VLLM_BASE_URL    || 'http://127.0.0.1:8001/v1',
    MODEL:       process.env.VLLM_MODEL       || 'Qwen3.5-9B-UD-Q5_K_XL.gguf',
    MAX_TOKENS:  parseInt(process.env.VLLM_MAX_TOKENS)   || 600,
    TEMPERATURE: parseFloat(process.env.VLLM_TEMPERATURE) || 0.3,
  },

  // ── RAG Service (existing aimin infra at 8002) ────────────
  // Endpoints:
  //   POST /products/index  — embed & store products
  //   POST /products/query  — semantic search → {products:[{product_name,product_category,score}]}
  //   GET  /healthz         — health check
  RAG: {
    URL:    process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8002',
    FOLDER: process.env.RAG_FOLDER     || 'findingid',   // namespace within Qdrant
    TOP_K:  parseInt(process.env.RAG_TOP_K) || 5,
  },

  // ── MySQL ─────────────────────────────────────────────────
  DB: {
    HOST:      process.env.DB_HOST      || 'localhost',
    PORT:      parseInt(process.env.DB_PORT) || 3306,
    NAME:      process.env.DB_NAME      || 'findingid',
    USER:      process.env.DB_USER      || 'findingid',
    PASS:      process.env.DB_PASS      || '',
    POOL_SIZE: parseInt(process.env.DB_POOL_SIZE) || 20,
  },

  // ── Redis ─────────────────────────────────────────────────
  REDIS: {
    URL:       process.env.REDIS_URL            || 'redis://localhost:6379',
    CACHE_TTL: parseInt(process.env.CACHE_TTL_SECONDS) || 300,
  },

  // ── Rate limiting ─────────────────────────────────────────
  RATE: {
    WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    MAX:       parseInt(process.env.RATE_LIMIT_MAX)       || 30,
  },

  // ── Jobs ──────────────────────────────────────────────────
  JOBS: {
    TTL_SECONDS: parseInt(process.env.JOB_TTL_SECONDS)      || 300,
    POLL_MS:     parseInt(process.env.JOB_POLL_INTERVAL_MS) || 5000,
  },

  // ── CORS ──────────────────────────────────────────────────
  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),

  // ── System prompt ─────────────────────────────────────────
  SYSTEM_PROMPT: `/no_think
Kamu adalah finding.id, asisten belanja AI untuk marketplace Indonesia (Shopee, Tokopedia, dll).
WAJIB jawab dalam Bahasa Indonesia. Jangan gunakan bahasa lain.

JIKA DATA PRODUK TERSEDIA:
- Rekomendasikan TOP 3 terbaik. Tulis dengan format bernomor: 1. 2. 3.
- Per produk tulis dalam urutan ini:
  a) Nama produk + harga + rating + jumlah terjual
  b) Spesifikasi/fitur utama yang relevan dengan pertanyaan (dari data yang tersedia)
  c) Kelebihan utama: 1-2 kalimat konkret (apa yang membuatnya unggul dibanding lainnya)
  d) Cocok untuk: siapa yang sebaiknya beli ini (contoh: gaming serius, pelajar budget, foto profesional)
  e) Nilai uang: apakah harganya sepadan? bandingkan dengan harga rata-rata di data
- Di akhir tulis 1 kalimat perbandingan ketiga produk (mana paling hemat, mana paling premium, mana terbalik value-nya).
- Jangan tampilkan URL atau ID di teks — hanya di baris PILIHAN.
- Jangan mengarang spesifikasi atau harga yang tidak ada di data.

JIKA DATA KOSONG ATAU BELUM CUKUP:
- Informasikan dengan ramah: "Data produk sedang kami kumpulkan dari Shopee..."
- Berikan 2-3 tips umum tentang kategori produk tersebut (apa yang perlu diperhatikan saat beli)

Maksimal 600 kata. Padat, spesifik, bantu pengguna benar-benar memutuskan.`,
};
