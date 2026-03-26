'use strict';

// ================================================================
// Variant Normalizer
//
// Converts raw variant names from Shopee/Tokopedia into a standard
// structured format with typed dimension attributes.
//
// Shopee combines tier dimensions with comma:
//   "Hitam,128GB"  →  { label:"Hitam / 128GB", attrs:{Warna:"Hitam", Penyimpanan:"128GB"} }
//   "Merah,XL"     →  { label:"Merah / XL",    attrs:{Warna:"Merah", Ukuran:"XL"} }
//   "Coklat/500g"  →  { label:"Coklat / 500g", attrs:{Rasa:"Coklat", Berat:"500g"} }  (food context)
//
// Uses rule-based detection for ~85% of cases.
// Falls back to LLM batch call for tokens that rules can't classify.
// ================================================================

const { detectDimension } = require('./taxonomy');
const vllm = require('./vllm');

// ── LLM fallback prompt ───────────────────────────────────────────
const FALLBACK_SYSTEM =
`You classify Indonesian e-commerce product variant tokens into dimension types.
For each numbered token, reply with EXACTLY one of these dimension types:
  Warna | Ukuran | Rasa | Tipe | Material | Volume | Berat | Jumlah | Daya | Konektor | Lainnya

Rules:
- Color names (any language) → Warna
- Clothing/shoe sizes (S,M,L,XL,38,40) → Ukuran
- Flavors (chocolate, strawberry, dll) → Rasa
- Product type/edition (Original, Pro, Travel Size) → Tipe
- Fabric/material → Material
- Volume (50ml, 1L) → Volume
- Weight (100g, 1kg) → Berat
- Quantity (1 pcs, isi 40) → Jumlah
- Wattage/power (65W) → Daya
- Port/connector type → Konektor
- Anything else → Lainnya

OUTPUT: one dimension name per line, same order as input, nothing else.`;

/**
 * Ask LLM to classify a batch of unrecognized tokens.
 * @param {string[]} tokens
 * @param {string}   [cat] — product category for context
 * @returns {Promise<string[]>} dimension names, same length as tokens
 */
async function llmClassifyTokens(tokens, cat) {
  if (!tokens.length) return [];
  const numbered = tokens.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const context  = cat ? `Product category: ${cat}\n\n` : '';
  try {
    const raw = await vllm.complete(FALLBACK_SYSTEM, context + numbered, tokens.length * 6);
    const lines = raw.split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 0);
    return tokens.map((_, i) => lines[i] || 'Lainnya');
  } catch (err) {
    console.error('[variantNormalizer] LLM fallback failed:', err.message);
    return tokens.map(() => 'Lainnya');
  }
}

// ── Variant name splitter ─────────────────────────────────────────
// Shopee: tiers joined by comma ("Hitam,128GB")
// Some sellers: slash ("Hitam/128GB"), dash ("Hitam - 128GB")
// Single-value: no separator
function splitVariantName(name) {
  if (!name) return [];
  // Try comma split first (most common in Shopee)
  const byComma = name.split(',').map(s => s.trim()).filter(Boolean);
  if (byComma.length > 1) return byComma;
  // Slash split
  const bySlash = name.split('/').map(s => s.trim()).filter(Boolean);
  if (bySlash.length > 1) return bySlash;
  // " - " split (with spaces around dash)
  const byDash = name.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  if (byDash.length > 1) return byDash;
  return [name.trim()];
}

/**
 * Build a normalized label from attrs object.
 * Preferred dimension order for display.
 */
const DIM_ORDER = [
  'Warna', 'RAM', 'Penyimpanan', 'Ukuran', 'Volume', 'Berat',
  'Rasa', 'Jumlah', 'Tipe', 'Material', 'Daya', 'Konektor', 'Lainnya',
];

function buildLabel(attrs) {
  const ordered = DIM_ORDER
    .map(dim => attrs[dim])
    .filter(Boolean);
  // Append any dims not in order list
  Object.entries(attrs).forEach(([k, v]) => {
    if (!DIM_ORDER.includes(k)) ordered.push(v);
  });
  return ordered.join(' / ') || 'Default';
}

/**
 * Normalize a single parsed variant object.
 *
 * @param {{name, price, price_before, stock, image_url}} raw
 * @param {string}  [cat]        standardized category
 * @param {string[]} [llmDims]   LLM-resolved dimensions for unknown tokens (parallel to splitVariantName)
 * @returns normalized variant object
 */
function normalizeOne(raw, cat, llmDims = []) {
  const tokens  = splitVariantName(raw.name || '');
  const attrs   = {};
  let   llmIdx  = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const det   = detectDimension(token, cat);

    if (det.dim === 'RAM+Penyimpanan') {
      // Combined RAM/Storage token — split into two attrs
      attrs['RAM']         = det.ram;
      attrs['Penyimpanan'] = det.storage;
    } else if (det.dim) {
      // Rule-based classified — use it
      // Don't overwrite same dim if already set (keep first)
      if (!attrs[det.dim]) attrs[det.dim] = det.value;
    } else {
      // Unknown — use LLM resolution if available
      const llmDim = llmDims[llmIdx++] || 'Lainnya';
      const key    = llmDim === 'Lainnya' ? 'Varian' : llmDim;
      if (!attrs[key]) attrs[key] = det.value; // det.value has capitalized raw
    }
  }

  const label = buildLabel(attrs);

  return {
    label,                                         // "Hitam / 128GB"
    attrs,                                         // { Warna: "Hitam", Penyimpanan: "128GB" }
    price:        raw.price        ?? null,
    price_before: raw.price_before ?? null,
    stock:        raw.stock        ?? null,
    image_url:    raw.image_url    ?? null,
    _raw_name:    raw.name         ?? null,        // keep original for debugging
  };
}

/**
 * Normalize a full variants_json array.
 *
 * Process:
 *   1. Rule-based classify all tokens
 *   2. Collect all tokens that returned dim=null
 *   3. One LLM batch call for unknowns (if any)
 *   4. Re-run normalization with LLM results filled in
 *
 * @param {string|Array} variantsJson  — raw variants_json from DB or ingest
 * @param {string}       [cat]         — standardized category
 * @returns {Promise<Array>}           — normalized variant array
 */
async function normalizeVariants(variantsJson, cat) {
  let variants = [];
  try {
    variants = typeof variantsJson === 'string'
      ? JSON.parse(variantsJson)
      : (variantsJson || []);
  } catch (_) { return []; }

  if (!Array.isArray(variants) || !variants.length) return [];

  // ── Pass 1: identify which tokens need LLM ─────────────────────
  const unknownTokens = []; // flat list of all unclassified tokens across all variants
  const variantTokenMeta = variants.map(v => {
    const tokens = splitVariantName(v.name || '');
    return tokens.map(token => {
      const det = detectDimension(token, cat);
      if (det.dim === null) {
        const idx = unknownTokens.length;
        unknownTokens.push(token);
        return { token, det, llmIdx: idx, needsLLM: true };
      }
      return { token, det, needsLLM: false };
    });
  });

  // ── Pass 2: LLM batch for unknowns ────────────────────────────
  let llmResults = [];
  if (unknownTokens.length > 0) {
    // Deduplicate to reduce LLM calls
    const unique    = [...new Set(unknownTokens)];
    const uniqueMap = new Map();
    const rawResults = await llmClassifyTokens(unique, cat);
    unique.forEach((t, i) => uniqueMap.set(t, rawResults[i] || 'Lainnya'));
    llmResults = unknownTokens.map(t => uniqueMap.get(t) || 'Lainnya');
  }

  // ── Pass 3: build normalized variants ─────────────────────────
  const normalized = variants.map((v, vi) => {
    const meta   = variantTokenMeta[vi];
    const attrs  = {};

    for (const m of meta) {
      const det = m.det;
      if (det.dim === 'RAM+Penyimpanan') {
        if (!attrs['RAM'])         attrs['RAM']         = det.ram;
        if (!attrs['Penyimpanan']) attrs['Penyimpanan'] = det.storage;
      } else if (det.dim) {
        if (!attrs[det.dim]) attrs[det.dim] = det.value;
      } else {
        // LLM resolved
        const llmDim = m.needsLLM ? (llmResults[m.llmIdx] || 'Lainnya') : 'Lainnya';
        const key    = llmDim === 'Lainnya' ? 'Varian' : llmDim;
        if (!attrs[key]) attrs[key] = det.value;
      }
    }

    return {
      label:        buildLabel(attrs),
      attrs,
      price:        v.price        ?? null,
      price_before: v.price_before ?? null,
      stock:        v.stock        ?? null,
      image_url:    v.image_url    ?? null,
      _raw_name:    v.name         ?? null,
    };
  });

  // Deduplicate: same label + price → keep first
  const seen = new Set();
  return normalized.filter(v => {
    const key = `${v.label}|${v.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sync version — rule-based only, no LLM. Use when speed matters
 * (e.g. inside a hot ingest loop where LLM latency is unacceptable).
 * Unknown tokens get dim="Varian" with raw value.
 */
function normalizeVariantsSync(variantsJson, cat) {
  let variants = [];
  try {
    variants = typeof variantsJson === 'string'
      ? JSON.parse(variantsJson)
      : (variantsJson || []);
  } catch (_) { return []; }

  if (!Array.isArray(variants) || !variants.length) return [];

  const seen = new Set();
  return variants
    .map(v => normalizeOne(v, cat))
    .filter(v => {
      const key = `${v.label}|${v.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

module.exports = { normalizeVariants, normalizeVariantsSync, splitVariantName, buildLabel };
