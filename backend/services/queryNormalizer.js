'use strict';

// ================================================================
// Query Normalizer
//
// Resolves ambiguous Indonesian slang before the query hits RAG
// and the Shopee scraper.
//
// Key ambiguity: "hp" / "hape" / "handphone"
//   - Brand HP:   "laptop hp", "komputer hp", "printer hp", "hp envy"
//   - Handphone:  "hp 3 jutaan", "hape gaming", "hp dibawah 5jt"
//
// Also extracts price budget from phrases like:
//   "8 jutaan"  → { target: 8_000_000, min: 6_800_000, max: 9_200_000 }
//   "dibawah 5jt" → { target: 5_000_000, min: 0, max: 5_000_000 }
//   "5-8 juta"  → { target: 6_500_000, min: 5_000_000, max: 8_000_000 }
// ================================================================

const HP_BRAND_CONTEXTS = [
  'laptop', 'notebook', 'komputer', 'computer', 'printer', 'scanner',
  'inkjet', 'laserjet', 'deskjet', 'officejet', 'envy', 'pavilion',
  'victus', 'omen', 'spectre', 'elitebook', 'probook', 'chromebook',
  'zbook', 'stream', 'dragonfly', 'monitor',
];

const SMARTPHONE_CONTEXTS = [
  'jutaan', 'juta', 'ribu', 'rb', 'jt', 'budget', 'murah', 'mahal',
  'dibawah', 'di bawah', 'diatas', 'di atas', 'harga', 'kisaran',
  'gaming', 'game', 'kamera', 'camera', 'foto', 'selfie', 'video',
  'nonton', 'tiktok', 'instagram', 'medsos', 'sosmed',
  'baterai', 'battery', 'ram', 'storage', 'penyimpanan',
  'android', 'ios', 'iphone', 'samsung', 'xiaomi', 'oppo', 'vivo',
  'realme', 'poco', 'redmi', 'infinix', 'tecno', 'itel', 'nokia',
  'untuk', 'buat', 'bagus', 'terbaik', 'rekomendasi',
];

const PHONE_BRANDS = [
  'iphone', 'samsung', 'xiaomi', 'oppo', 'vivo', 'realme', 'poco', 'redmi',
  'infinix', 'tecno', 'itel', 'nokia', 'huawei', 'honor', 'pixel', 'asus rog phone'
];

const PHONE_ACCESSORY_TERMS = [
  'aksesoris', 'accessories', 'charger', 'kabel', 'cable', 'adapter', 'case', 'casing',
  'skin', 'tempered', 'protector', 'screen protector', 'powerbank', 'earphone', 'headset',
  'tws', 'holder', 'mount', 'car holder', 'stiker', 'otg', 'memory card', 'sim card'
];

const PHONE_ACCESSORY_CATEGORIES = [
  'Aksesoris Handphone',
  'Perangkat Wearable',
];

// ── Semantic price hints ──────────────────────────────────────────
// When no explicit price is given, infer a range from contextual keywords.
// Keyed by the first preferredCategory returned by detectCategoryIntent.
const SEMANTIC_PRICE_HINTS = {
  Otomotif: [
    { terms: ['murah', 'hemat', 'terjangkau', 'ekonomis', 'entry'],      min:  5_000_000, max: 15_000_000 },
    { terms: ['pelajar', 'siswa', 'mahasiswa', 'anak sekolah'],          min:  5_000_000, max: 12_000_000 },
    { terms: ['premium', 'mewah', 'flagship'],                           min: 25_000_000, max: 50_000_000 },
  ],
  Laptop: [
    { terms: ['anak sekolah', 'pelajar', 'siswa', 'smp', 'sma', 'sd'],  min: 2_500_000, max:  6_000_000 },
    { terms: ['mahasiswa', 'kuliah', 'kampus'],                           min: 4_000_000, max:  9_000_000 },
    { terms: ['gaming', 'game'],                                          min: 8_000_000, max: 25_000_000 },
    { terms: ['kerja', 'kantor', 'office', 'bisnis', 'business'],        min: 5_000_000, max: 15_000_000 },
    { terms: ['murah', 'hemat', 'terjangkau', 'ekonomis'],               min: 2_000_000, max:  5_000_000 },
    { terms: ['premium', 'mewah', 'profesional', 'flagship'],            min:15_000_000, max: 50_000_000 },
  ],
  Handphone: [
    { terms: ['anak sekolah', 'pelajar', 'siswa', 'smp', 'sma', 'sd'],  min: 1_000_000, max:  3_000_000 },
    { terms: ['mahasiswa', 'kuliah', 'kampus'],                           min: 1_500_000, max:  4_000_000 },
    { terms: ['gaming', 'game'],                                          min: 3_000_000, max:  8_000_000 },
    { terms: ['kerja', 'kantor', 'office', 'bisnis', 'business'],        min: 2_500_000, max:  6_000_000 },
    { terms: ['murah', 'hemat', 'terjangkau', 'ekonomis'],               min:   500_000, max:  2_000_000 },
    { terms: ['flagship', 'premium', 'mewah'],                           min: 8_000_000, max: 25_000_000 },
  ],
};

function inferSemanticPrice(lower, preferredCategories) {
  const hints = SEMANTIC_PRICE_HINTS[preferredCategories?.[0]];
  if (!hints) return null;
  for (const hint of hints) {
    if (hint.terms.some(t => lower.includes(t))) {
      return { min: hint.min, max: hint.max, target: Math.round((hint.min + hint.max) / 2), raw: null, semantic: true };
    }
  }
  return null;
}

/**
 * Ask the LLM to infer a price range for a query when keyword map has no match.
 * Returns { min, max, target, raw:null, semantic:true } or null.
 * Results are cached 24h in Redis so identical queries never hit the LLM twice.
 *
 * @param {string} query        - clean product query (price already stripped)
 * @param {string[]} categories - preferredCategories from detectCategoryIntent
 * @param {Function} llmComplete - vllm.complete(system, prompt, maxTokens)
 * @param {object}  [cache]     - cache service (get/set)
 */
async function inferPriceWithLLM(query, categories, llmComplete, cache) {
  const category = categories?.[0] || '';
  const cacheKey = `price-hint:${category}:${query.toLowerCase().replace(/\s+/g, ' ').trim()}`;

  if (cache) {
    const cached = await cache.get(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  const system = `Kamu asisten belanja Indonesia. Tugasmu: perkirakan kisaran harga wajar untuk produk yang dicari.
Balas HANYA dengan dua angka dipisah tanda hubung, dalam satuan JUTA rupiah.
Format: MIN-MAX
Contoh: "8-20" artinya 8 juta sampai 20 juta.
Jangan tambahkan kata lain.`;

  const userPrompt = category
    ? `Produk: ${query} (${category})`
    : `Produk: ${query}`;

  try {
    const raw = await llmComplete(system, userPrompt, 15);
    // Match "8-20", "8 - 20", "8.5-20"
    const match = raw?.match(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)/);
    if (!match) return null;

    const min = parseFloat(match[1].replace(',', '.')) * 1_000_000;
    const max = parseFloat(match[2].replace(',', '.')) * 1_000_000;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null;

    const result = { min, max, target: Math.round((min + max) / 2), raw: null, semantic: true };
    if (cache) cache.set(cacheKey, result, 86400).catch(() => {}); // 24h cache
    return result;
  } catch {
    return null;
  }
}

// ── Price extraction ──────────────────────────────────────────────
const PRICE_TOLERANCE = 0.15; // ±15%

/**
 * Parse price budget from query string.
 * Returns { min, max, target, raw } in IDR, or null if no price found.
 * `raw` is the matched substring so the caller can strip it from the query.
 */
function extractPrice(lower) {
  // Multipliers
  const mul = (s) => {
    if (/juta|jt/.test(s))   return 1_000_000;
    if (/ribu|rb|k/.test(s)) return 1_000;
    return 1;
  };
  const parseNum = (s) => parseFloat(s.replace(',', '.'));

  // Range: "5-8 juta", "5 sampai 8 juta", "5 hingga 8jt", "antara 3-5jt"
  const rangeRe = /(?:antara\s+)?(\d+(?:[.,]\d+)?)\s*(?:[-–]|sampai|hingga|sd|s\/d)\s*(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)/;
  const rangeMatch = lower.match(rangeRe);
  if (rangeMatch) {
    const m  = mul(rangeMatch[3]);
    const lo = parseNum(rangeMatch[1]) * m;
    const hi = parseNum(rangeMatch[2]) * m;
    return { min: lo, max: hi, target: (lo + hi) / 2, raw: rangeMatch[0] };
  }

  // Upper bound — prefix: "dibawah 5jt", "under 5jt", "maks 3juta", "tidak/ga lebih dari 5jt", "paling mahal 5jt"
  const upperRe = /(?:(?:tidak|ga|gak|jangan)\s+lebih\s+dari|paling\s+mahal|di\s*bawah|bawah|under|maks(?:im(?:al|um))?|max|kurang\s*dari|budget)\s*(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)/;
  const upperMatch = lower.match(upperRe);
  if (upperMatch) {
    const m  = mul(upperMatch[2]);
    const hi = parseNum(upperMatch[1]) * m;
    return { min: 0, max: hi, target: hi, raw: upperMatch[0] };
  }

  // Upper bound — postfix: "5jt ke bawah", "5 juta kebawah", "5jt max"
  const upperPostRe = /(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)\s*(?:ke\s*bawah|kebawah|max|maks)/;
  const upperPostMatch = lower.match(upperPostRe);
  if (upperPostMatch) {
    const m  = mul(upperPostMatch[2]);
    const hi = parseNum(upperPostMatch[1]) * m;
    return { min: 0, max: hi, target: hi, raw: upperPostMatch[0] };
  }

  // Lower bound — prefix: "diatas 5jt", "minimal 3juta", "lebih dari 5jt"
  const lowerRe = /(?:di\s*atas|atas|above|min(?:im(?:al|um))?|lebih\s+dari|paling\s+murah)\s*(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)/;
  const lowerMatch = lower.match(lowerRe);
  if (lowerMatch) {
    const m  = mul(lowerMatch[2]);
    const lo = parseNum(lowerMatch[1]) * m;
    return { min: lo, max: lo * 3, target: lo, raw: lowerMatch[0] };
  }

  // Lower bound — postfix: "5jt ke atas", "5 juta keatas"
  const lowerPostRe = /(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)\s*(?:ke\s*atas|keatas)/;
  const lowerPostMatch = lower.match(lowerPostRe);
  if (lowerPostMatch) {
    const m  = mul(lowerPostMatch[2]);
    const lo = parseNum(lowerPostMatch[1]) * m;
    return { min: lo, max: lo * 3, target: lo, raw: lowerPostMatch[0] };
  }

  // Approximate: "8 jutaan", "3jtan", "3 juta-an", "10jt", "500k", "1.5jt"
  const approxRe = /(\d+(?:[.,]\d+)?)\s*(juta|jt|ribu|rb|k)(?:an|-an)?/;
  const approxMatch = lower.match(approxRe);
  if (approxMatch) {
    const m      = mul(approxMatch[2]);
    const target = parseNum(approxMatch[1]) * m;
    return {
      min:    Math.round(target * (1 - PRICE_TOLERANCE)),
      max:    Math.round(target * (1 + PRICE_TOLERANCE)),
      target,
      raw:    approxMatch[0],
    };
  }

  return null;
}

function detectCategoryIntent(lower) {
  const hpMeansBrand = /\bhp\b/.test(lower) && HP_BRAND_CONTEXTS.some(ctx => lower.includes(ctx));

  // ── Phone device intent ────────────────────────────────────
  const wantsPhone = PHONE_BRANDS.some(b => lower.includes(b)) ||
    /\b(handphone|hape|smartphone|iphone|android|ponsel|gawai|telepon\s+genggam)\b/.test(lower) ||
    (/\bhp\b/.test(lower) && !hpMeansBrand);

  const wantsAccessory = PHONE_ACCESSORY_TERMS.some(t => lower.includes(t));

  if (wantsPhone && !wantsAccessory) {
    return {
      preferredCategories: ['Handphone'],
      excludedCategories: PHONE_ACCESSORY_CATEGORIES,
      note: 'intent=device-only'
    };
  }

  if (wantsPhone && wantsAccessory) {
    return {
      preferredCategories: ['Aksesoris Handphone'],
      excludedCategories: [],
      note: 'intent=accessory'
    };
  }

  // ── Computer / gaming PC intent ────────────────────────────
  const wantsPC = /\b(komputer|computer|pc gaming|gaming pc|gaming desktop|rakit pc|build pc)\b/.test(lower);
  const wantsLaptop = /\blaptop\b/.test(lower);
  const wantsComponent = /\b(gpu|cpu|processor|ram|ssd|nvme|motherboard|mobo|psu|power supply|casing pc|grafis|vga|rtx|gtx|radeon|geforce|quadro)\b/.test(lower);
  const wantsPCAccessory = /\b(keyboard|mouse|headset|headphone|mousepad|monitor|webcam|hub usb)\b/.test(lower);

  // If user also said "laptop", GPU/RAM terms describe laptop specs — not standalone parts
  if (wantsComponent && !wantsLaptop) {
    return {
      preferredCategories: ['Komponen Komputer'],
      excludedCategories: ['Aksesoris Komputer', 'Aksesoris Handphone'],
      note: 'intent=pc-component'
    };
  }

  if (wantsPCAccessory && !wantsPC && !wantsLaptop) {
    // Do NOT set preferredCategories for PC accessories (headset, mouse, keyboard, etc.).
    // These products are spread across "Perangkat Audio", "Aksesoris Komputer",
    // "komputer-laptop/aksesoris-pc-gaming/headset-gaming" — no single category works.
    // Setting a category here triggers LLM price inference and excludes most results.
    // Qdrant semantic + FULLTEXT + token filter is sufficient for these queries.
    return {
      preferredCategories: [],
      excludedCategories: [],
      note: 'intent=pc-accessory'
    };
  }

  if (wantsPC) {
    return {
      preferredCategories: ['Desktop', 'Komponen Komputer'],
      excludedCategories: ['Aksesoris Komputer', 'Aksesoris Handphone'],
      note: 'intent=desktop-pc'
    };
  }

  if (wantsLaptop) {
    return {
      preferredCategories: ['Laptop'],
      excludedCategories: ['Aksesoris Komputer', 'Aksesoris Handphone'],
      note: 'intent=laptop'
    };
  }

  // ── Motor / kendaraan listrik intent ───────────────────────
  const wantsMotor = /\b(motor\s+listrik|sepeda\s+motor|skutik|skuter|e-?bike|ebike|moped)\b/.test(lower)
    || (/\bmotor\b/.test(lower) && /\b(listrik|electric|ev|beli|kredit)\b/.test(lower));
  if (wantsMotor) {
    return {
      preferredCategories: ['Otomotif'],
      excludedCategories: ['TV & Perangkat Hiburan', 'Peralatan Rumah Tangga', 'Handphone', 'Laptop', 'Aksesoris Handphone', 'Aksesoris Komputer'],
      note: 'intent=motor-listrik'
    };
  }

  return { preferredCategories: [], excludedCategories: [], note: null };
}
/**
 * Normalize a raw user query.
 * Returns {
 *   query,
 *   price: {min,max,target}|null,
 *   preferredCategories: string[],
 *   excludedCategories: string[],
 *   note
 * }
 */
/**
 * Remove the price phrase from a query string so RAG gets clean product terms.
 * e.g. "laptop gaming 10 jutaan" → "laptop gaming"
 */
function stripPrice(raw, priceRaw) {
  if (!priceRaw) return raw;
  // Build a case-insensitive literal match; also strip surrounding connectors
  const escaped = priceRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = raw
    .replace(new RegExp(`\\s*(?:sekitar|harga|kisaran|budget|antara)?\\s*${escaped}`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || raw;
}

// Common Indonesian phone search typos — fix before any detection logic runs.
// Order matters: longer patterns first to avoid partial replacements.
const PHONE_TYPOS = [
  [/\bhen[dp]?pon\b/g,  'handphone'],  // hendpon, henpon
  [/\bhanphone\b/g,     'handphone'],  // missing 'd'
  [/\bhanpon\b/g,       'handphone'],
  [/\bhndphone\b/g,     'handphone'],
  [/\bhandpon\b/g,      'handphone'],
  [/\bhendphone\b/g,    'handphone'],  // e instead of a
  [/\bhonphone\b/g,     'handphone'],
  [/\bsmarphone\b/g,    'smartphone'], // missing 't'
  [/\bsmarfone\b/g,     'smartphone'],
  [/\bsmartfone\b/g,    'smartphone'], // phonetic
  [/\bsmartpon\b/g,     'smartphone'],
  [/\bhaphe\b/g,        'hape'],
  [/\bhappe\b/g,        'hape'],
  [/\bponcel\b/g,       'ponsel'],
];

function fixTypos(raw) {
  let s = raw;
  for (const [pattern, replacement] of PHONE_TYPOS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

function normalizeQuery(raw) {
  const corrected = fixTypos(raw);
  const lower = corrected.toLowerCase();

  // Extract explicit price budget
  let price = extractPrice(lower);

  // Strip price phrase from query so RAG embedding focuses on product terms
  const baseQuery = stripPrice(corrected, price?.raw);

  // Intent / category hints (device vs accessory)
  const intent = detectCategoryIntent(lower);

  // Tier-1 semantic inference: fast keyword map
  if (!price) {
    price = inferSemanticPrice(lower, intent.preferredCategories);
    if (price) console.log(`[normalizer] semantic price (keyword): ${price.min}–${price.max} for "${raw}"`);
  }

  // ── "hape" → always Handphone slang ──────────────────────
  if (/\bhape\b/.test(lower)) {
    const q = baseQuery.replace(/\bhape\b/gi, 'Handphone');
    return {
      query: q,
      price,
      preferredCategories: intent.preferredCategories,
      excludedCategories: intent.excludedCategories,
      note: [ 'hape→Handphone', intent.note ].filter(Boolean).join(' | '),
    };
  }

  // ── "hp" disambiguation ───────────────────────────────────
  if (/\bhp\b/.test(lower)) {
    const isBrand = HP_BRAND_CONTEXTS.some(ctx => lower.includes(ctx));
    if (isBrand) {
      const q = baseQuery.replace(/\bhp\b/gi, 'HP');
      return {
        query: q,
        price,
        preferredCategories: intent.preferredCategories,
        excludedCategories: intent.excludedCategories,
        note: [ 'hp→HP brand', intent.note ].filter(Boolean).join(' | '),
      };
    }

    const isSmartphone = SMARTPHONE_CONTEXTS.some(ctx => lower.includes(ctx));
    if (isSmartphone) {
      const q = baseQuery.replace(/\bhp\b/gi, 'Handphone');
      return {
        query: q,
        price,
        preferredCategories: intent.preferredCategories,
        excludedCategories: intent.excludedCategories,
        note: [ 'hp→Handphone (context)', intent.note ].filter(Boolean).join(' | '),
      };
    }

    // Default bare "hp" → Handphone
    const q = baseQuery.replace(/\bhp\b/gi, 'Handphone');
    return {
      query: q,
      price,
      preferredCategories: intent.preferredCategories,
      excludedCategories: intent.excludedCategories,
      note: [ 'hp→Handphone (default)', intent.note ].filter(Boolean).join(' | '),
    };
  }

  return {
    query: baseQuery,
    price,
    preferredCategories: intent.preferredCategories,
    excludedCategories: intent.excludedCategories,
    note: intent.note || null,
  };
}

// ================================================================
// Intent Classifier
//
// Decides whether a query should trigger a scraping job (SEARCH)
// or just answer from existing data (CHAT).
//
// Three-tier approach:
//   1. Strong CHAT signals   → 'chat'   immediately (no LLM call)
//   2. Strong SEARCH signals → 'search' immediately (no LLM call)
//   3. Ambiguous             → LLM classifier (1 token, ~200ms)
// ================================================================

// Words that reference something already shown on screen
// Patterns that clearly signal a follow-up question, not a product search.
// Rule: ends with "?", or contains a comparison/question phrase.
const CHAT_PATTERNS = [
  /\b(yang\s+mana|bagusan\s+mana|mending\s+mana|mending\s+yang)\b/,       // which one is better
  /\b(apa\s+bedanya|bedanya\s+apa|apa\s+perbedaan|perbedaannya)\b/,        // what's the difference
  /\b(kelebihan|kekurangan|kelemahan|keunggulan)\b/,                       // pros/cons
  /\b(worth\s*it|layak\s+beli)\b/,                                         // worth buying?
  /\b(kenapa|mengapa)\b/,                                                   // why
  /\b(lebih\s+bagus\s+mana|yang\s+mana\s+lebih\s+bagus)\b/,               // which is better
  /^(oke|ok|siap|makasih|thanks|terimakasih|terima kasih|mantap|nice)[\s!.]*$/, // ack/thanks
];

// Patterns that signal a general-knowledge / real-world query → delegate to Hermes agent.
// These are clearly NOT marketplace product searches.
const AGENT_PATTERNS = [
  // Commodity & financial prices (non-product)
  /\b(crude\s*oil|minyak\s*(mentah|bumi|brent|wti)|petroleum)\b/,
  /\bharga\s+(emas|perak|platinum|logam\s+mulia)\b/,
  /\bharga\s+(saham|ihsg|indeks\s+saham|bursa)\b/,
  /\b(kurs|nilai\s+tukar|exchange\s+rate)\s+(dolar|dollar|usd|euro|yen|yuan|sgd|ringgit|baht)\b/,
  /\bharga\s+(bitcoin|crypto|ethereum|btc|eth|kripto)\b/,
  /\bharga\s+(bbm|pertalite|pertamax|solar|avtur)\b/,
  // Weather
  /\bcuaca\b.*\b(hari\s*ini|besok|minggu\s*ini|prakiraan|forecast)\b/,
  /\b(prakiraan|forecast)\s+cuaca\b/,
  /\b(hujan|panas|mendung)\s+(hari\s*ini|besok)\s*(di\b|di\s+\w+)?\b/,
  // Places & services near user (restaurants, ATMs, hospitals, etc.)
  /\b(restoran|rumah\s*makan|warung\s*makan|warung|cafe|kafe|kedai)\b.*\b(terdekat|dekat\s+(sini|saya|aku)|sekitar\s+(sini|saya|aku)|nearby)\b/,
  /\b(terdekat|dekat\s+(sini|saya|aku)|sekitar\s+sini|nearby)\b.*\b(restoran|rumah\s*makan|warung|cafe|kafe|makan|kuliner)\b/,
  /\b(atm|bank|indomaret|alfamart|apotek|apotik|klinik|rumah\s*sakit|pom\s*bensin|spbu|bengkel)\b.*\b(terdekat|dekat\s+(sini|saya)|sekitar)\b/,
  /\b(terdekat|dekat\s+(sini|saya)|sekitar)\b.*\b(atm|bank|apotek|spbu|bengkel|klinik)\b/,
  // Viral / trending places (not product)
  /\b(kuliner|restoran|cafe|tempat\s+makan|wisata|destinasi)\s+(viral|hits|trending|populer|rekomendasi|terbaik)\b.*\b(di|jakarta|bandung|surabaya|bali|jogja|yogya|medan|makassar|semarang)\b/,
  /\b(tempat\s+makan|wisata|destinasi)\s+(viral|hits|rekomendasi)\b/,
  // News / current events
  /\bberita\s+(terbaru|hari\s*ini|terkini|viral)\b/,
  /\b(apa\s+yang\s+lagi\s+viral|lagi\s+trending|trending\s+sekarang)\b/,
  // Inflation, economics, macro data
  /\b(inflasi|gdp|pdb|pertumbuhan\s+ekonomi|suku\s+bunga\s+bi|bi\s+rate)\b.*\b(sekarang|terbaru|hari\s*ini)\b/,
  // Product price questions — user wants info, not to buy
  /\bharga\b.{1,50}\bberapa\b/,        // "harga X berapa"
  /\bberapa\s+harga\b/,                // "berapa harga X"
  /\bharganya\s+berapa\b/,             // "harganya berapa"
  /\b(paling\s+murah|termurah|paling\s+mahal|termahal)\b.*\bberapa\b/,  // "paling murah berapa"
  /\bberapa\b.{0,20}$/,               // ends with "berapa ya?", "berapa sih?" etc
  // General knowledge / advice — clearly not a product search
  /\b(gimana|bagaimana)\s+(cara|bisa|supaya|agar|kalau|untuk)\b/,
  /\b(cara|tips|langkah)\s+(agar|supaya|untuk|memulai|meningkatkan|mengembangkan|menjalankan|menjadi|membuat|mengatasi|memilih)\b/,
  /\b(apa\s+itu|apakah\s+itu|pengertian|definisi)\b/,
  /\b(kenapa|mengapa)\b.{5,}/,         // why questions with substance
];

// Patterns that are CHAT only when there is conversation history
const CHAT_WITH_HISTORY_PATTERNS = [
  /^(apa|apakah)\b/,                                    // apa itu / apakah bagus
  /^(gimana|bagaimana)\b/,                              // gimana performa-nya
  /^(jelaskan|ceritakan|kasih tau|kasi tau)\b/,         // jelaskan lebih lanjut
  /^(rekomen|sarankan|saran)\b/,                        // rekomendasi mana
  /^(pilih|pilihan)\b/,                                 // pilih yang mana
  /^(cocok|pas)\b/,                                     // cocok buat gaming?
  /\b(nomor\s*\d+|yang\s+pertama|yang\s+kedua|yang\s+ketiga|no\s*\d+)\b/, // nomor 1/2/3
  /\b(itu|ini|tersebut|tadi)\b/,                        // refers to previously shown items
  /\b(lebih\s+(murah|mahal|bagus|jelek|ringan|kencang|cepat))\b/,          // comparison
  /\b(mana\s+yang|yang\s+paling)\b/,                   // mana yang terbaik
];

/**
 * Classify user query intent.
 * - hasHistory: true when the user has an active conversation with previously shown products
 *
 * @param {string} raw
 * @param {boolean} hasHistory
 * @returns {Promise<'search'|'chat'|'agent'>}
 */
async function classifyIntent(raw, hasHistory = false) {
  const lower = raw.toLowerCase().trim();

  // Agent patterns take priority (commodity prices, weather, nearby, etc.)
  if (AGENT_PATTERNS.some(p => p.test(lower))) return 'agent';

  // If query has a question mark and no conversation history → agent
  // (user is asking a question cold, not following up on products shown)
  if (!hasHistory && lower.includes('?')) return 'agent';

  // Always-chat patterns (follow-up signals: "yang mana", "apa bedanya", etc.)
  if (CHAT_PATTERNS.some(p => p.test(lower))) return 'chat';

  // Context-dependent: only treat as chat if there's an active conversation
  if (hasHistory && CHAT_WITH_HISTORY_PATTERNS.some(p => p.test(lower))) return 'chat';

  // Everything else is a product search
  return 'search';
}

/**
 * Async version of normalizeQuery with LLM price inference fallback.
 * Use this in route handlers that have access to vllm + cache.
 *
 * Flow:
 *   1. Explicit price phrase in query  → use it
 *   2. Keyword semantic map match       → use it  (fast, free)
 *   3. LLM inference (cached 24h)      → use it  (handles rare variants)
 *   4. No price found                  → price: null
 *
 * @param {string}   raw
 * @param {object}   [opts]
 * @param {Function} [opts.llmComplete]  - vllm.complete(system, prompt, maxTokens)
 * @param {object}   [opts.cache]        - cache service
 */
async function normalizeQueryFull(raw, { llmComplete, cache } = {}) {
  const result = normalizeQuery(raw);

  // Price already resolved (explicit or keyword-semantic)
  if (result.price) return result;

  // No product category detected → LLM won't add value
  if (!result.preferredCategories?.length) return result;

  // Only infer price when the query has contextual/budget signals.
  // Skip for specific model/product code searches like "rtx 5080", "iphone 16 pro".
  // Budget signals: quality tier words, use-case words, or demographic words.
  const lower = raw.toLowerCase();
  const hasBudgetSignal = /\b(murah|hemat|mahal|budget|terjangkau|premium|mewah|gaming|kerja|kantor|kuliah|mahasiswa|pelajar|sekolah|anak|entry|flagship|profesional)\b/.test(lower)
    || /\b(untuk|buat|cocok)\b/.test(lower);
  if (!hasBudgetSignal) return result;

  // Tier-2: ask LLM
  if (llmComplete) {
    const inferred = await inferPriceWithLLM(result.query, result.preferredCategories, llmComplete, cache);
    if (inferred) {
      console.log(`[normalizer] semantic price (LLM): ${inferred.min}–${inferred.max} for "${raw}"`);
      return { ...result, price: inferred };
    }
  }

  return result;
}

module.exports = { normalizeQuery, normalizeQueryFull, classifyIntent };
