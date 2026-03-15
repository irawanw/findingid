'use strict';
const vllm = require('./vllm');

// ================================================================
// Product Categorizer — uses vLLM to classify product titles
// into simplified category buckets (≈25 entries).
//
// Rationale: the old 300-entry Shopee leaf list caused the LLM to
// drift toward accessory/sub-categories (e.g. "Handphone & Tablet
// Aksesoris") when the product is clearly a device.  A compact,
// human-readable taxonomy keeps LLM output accurate and consistent.
//
// Price guard (applied AFTER LLM classification):
//   If price > 1_000_000 IDR  →  the product is NOT an accessory.
//   Any accessory-like category is automatically promoted to its
//   parent device category (e.g. phone accessory → Handphone).
// ================================================================

const CATEGORIES = [
  'Handphone',
  'Tablet',
  'Laptop',
  'Desktop',
  'Monitor',
  'Komponen Komputer',      // CPU, GPU, RAM, SSD, mobo, PSU, cooling
  'Aksesoris Komputer',     // keyboard, mouse, headset, hub, cable for PC
  'Aksesoris Handphone',    // case, charger, cable, powerbank, screen protector
  'Perangkat Audio',        // speaker, earphone, headphone, soundbar
  'Kamera & Foto',
  'TV & Perangkat Hiburan', // TV, proyektor, media player, smart box
  'Konsol & Game',          // PS, Xbox, Nintendo, gaming chair, controller
  'Perangkat Wearable',     // smartwatch, fitness band, VR headset
  'Peralatan Rumah Tangga', // AC, kulkas, mesin cuci, vacuum, setrika
  'Peralatan Dapur',        // microwave, blender, rice cooker, dispenser
  'Furnitur & Dekorasi',
  'Pakaian & Fashion',
  'Sepatu & Tas',
  'Kecantikan & Perawatan',
  'Makanan & Minuman',
  'Olahraga & Outdoor',
  'Otomotif',               // motor, mobil, aksesoris kendaraan
  'Buku & Alat Tulis',
  'Mainan & Anak',
  'Kesehatan & Medis',
  'Lainnya',
];

// Accessory categories that must be overridden when price > 1_000_000
const ACCESSORY_CATEGORIES = new Set([
  'Aksesoris Komputer',
  'Aksesoris Handphone',
]);

// Map accessory → promoted device category for expensive products
const ACCESSORY_PROMOTION = {
  'Aksesoris Handphone': 'Handphone',
  'Aksesoris Komputer':  'Komponen Komputer',
};

// Price threshold above which a product cannot be a basic accessory
const ACCESSORY_MAX_PRICE = 1_000_000;

const CATEGORY_LIST = CATEGORIES.join('\n');

const SYSTEM_PROMPT =
`You are a product category classifier for an Indonesian e-commerce platform.
You will receive a numbered list of product titles in Indonesian or English.
For each title, reply with EXACTLY ONE category name from the list below — nothing else.

VALID CATEGORIES:
${CATEGORY_LIST}

RULES:
- If the product is a smartphone/handphone (iPhone, Samsung, Xiaomi, etc.) → use "Handphone"
- If the product is a laptop → use "Laptop"
- If the product is a desktop PC, gaming PC, mini PC → use "Desktop"
- If the product is a PC component (GPU, CPU, RAM, SSD, motherboard, casing PC, PSU) → use "Komponen Komputer"
- If the product is a keyboard, mouse, headset, gaming chair, USB hub → use "Aksesoris Komputer"
- If the product is a phone case, charger, cable, powerbank, screen protector → use "Aksesoris Handphone"
- If unsure → use "Lainnya"

OUTPUT FORMAT: one category name per line, same order as input, no numbers, no extra text.`;

/**
 * Apply price-based guard: if price > 1_000_000 and category is an
 * accessory, promote it to the corresponding device category.
 *
 * @param {string|null} category
 * @param {number|null} price  — IDR
 * @returns {string|null}
 */
function applyPriceGuard(category, price) {
  if (!category) return category;
  if (!price || typeof price !== 'number' || price <= ACCESSORY_MAX_PRICE) return category;
  if (!ACCESSORY_CATEGORIES.has(category)) return category;

  const promoted = ACCESSORY_PROMOTION[category] || null;
  if (promoted) {
    console.log(`[categorizer] price guard: "${category}" → "${promoted}" (price ${price.toLocaleString('id-ID')})`);
    return promoted;
  }
  return category;
}

// Exact + case-insensitive match against CATEGORIES
function matchCategory(name) {
  if (!name) return null;
  const trimmed = name.trim();

  // 1. Exact match
  if (CATEGORIES.includes(trimmed)) return trimmed;

  // 2. Case-insensitive
  const lower = trimmed.toLowerCase();
  const ci = CATEGORIES.find(c => c.toLowerCase() === lower);
  if (ci) return ci;

  // 3. Prefix match (LLM sometimes adds trailing words)
  const prefix = CATEGORIES.find(c => lower.startsWith(c.toLowerCase()));
  if (prefix) return prefix;

  // 4. Substring: valid category name appears inside LLM output
  const sub = CATEGORIES.find(c => lower.includes(c.toLowerCase()));
  if (sub) return sub;

  // 5. Map common Shopee leaf names the LLM might still output
  const ALIAS = {
    'handphone & tablet aksesoris': 'Aksesoris Handphone',
    'casing & skin':                'Aksesoris Handphone',
    'kabel, charger, & konverter':  'Aksesoris Handphone',
    'powerbank & baterai':          'Aksesoris Handphone',
    'audio handphone':              'Perangkat Audio',
    'keyboard & mouse':             'Aksesoris Komputer',
    'aksesoris desktop & laptop':   'Aksesoris Komputer',
    'komponen desktop & laptop':    'Komponen Komputer',
    'komputer & aksesoris':         'Komponen Komputer',
    'aksesoris konsol':             'Konsol & Game',
    'video game':                   'Konsol & Game',
    'perangkat vr':                 'Perangkat Wearable',
    'tv & aksesoris':               'TV & Perangkat Hiburan',
    'proyektor & aksesoris':        'TV & Perangkat Hiburan',
    'kamera':                       'Kamera & Foto',
    'drone & aksesoris':            'Kamera & Foto',
    'perangkat audio & speaker':    'Perangkat Audio',
    'audio computer':               'Perangkat Audio',
    'software':                     'Lainnya',
    'penyimpanan data':             'Komponen Komputer',
  };

  const aliasKey = lower.replace(/\s+/g, ' ').trim();
  if (ALIAS[aliasKey]) return ALIAS[aliasKey];

  // 6. Partial alias scan
  for (const [alias, cat] of Object.entries(ALIAS)) {
    if (lower.includes(alias) || alias.includes(lower.slice(0, 8))) return cat;
  }

  return null;
}

/**
 * Classify a batch of product titles.
 * Returns array of { display_name, catid:null } — catid no longer used.
 * Caller may additionally pass prices[] for price-guard post-processing.
 *
 * @param {string[]} titles
 * @param {number[]} [prices]   optional parallel array of prices in IDR
 * @returns {Promise<Array<{display_name:string|null, catid:null}>>}
 */
async function classifyProducts(titles, prices = []) {
  if (!titles.length) return [];

  const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  let raw;
  try {
    raw = await vllm.complete(SYSTEM_PROMPT, numbered, titles.length * 16);
  } catch (err) {
    console.error('[categorizer] vLLM call failed:', err.message);
    return titles.map(() => ({ display_name: null, catid: null }));
  }

  const lines = raw.split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 0);

  return titles.map((_, i) => {
    const raw_name = lines[i] || null;
    let display_name = matchCategory(raw_name);

    if (!display_name && raw_name) {
      console.warn(`[categorizer] no match for: "${raw_name}"`);
    }

    // Apply price guard
    const price = typeof prices[i] === 'number' ? prices[i] : null;
    display_name = applyPriceGuard(display_name, price);

    return { display_name, catid: null };
  });
}

module.exports = { classifyProducts, applyPriceGuard };
