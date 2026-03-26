'use strict';

// ================================================================
// finding.id — Master Product Taxonomy
//
// Single source of truth for:
//   1. CATEGORIES  — standard category list (LLM + SEO)
//   2. Variant dimension detection (color, size, storage, flavor, etc.)
//   3. Attribute key normalization map
//
// Covers the full product breadth:
//   Electronics, Fashion, Skincare, Baby, Food, Health, Automotive,
//   Home, Sports, Pets, and more.
// ================================================================

// ── 1. Standard Categories ────────────────────────────────────────
// ~40 categories. Broad enough for SEO, specific enough to be meaningful.
// The LLM classifier maps any raw Shopee/Tokopedia category to one of these.
const CATEGORIES = [
  // ── Elektronik
  'Handphone',
  'Tablet',
  'Laptop',
  'Desktop & PC',
  'Monitor',
  'Komponen Komputer',        // CPU, GPU, RAM, SSD, mobo, PSU, casing PC
  'Aksesoris Komputer',       // keyboard, mouse, headset, USB hub, kabel data
  'Aksesoris Handphone',      // casing, charger, kabel, powerbank, anti gores
  'Perangkat Audio',          // speaker, earphone, headphone, soundbar, mic
  'Kamera & Foto',            // kamera, lensa, tripod, drone, gimbal
  'TV & Perangkat Hiburan',   // TV, proyektor, smart box, media player
  'Konsol & Game',            // PS5/4, Xbox, Nintendo, gaming chair, controller
  'Perangkat Wearable',       // smartwatch, fitness band, VR headset
  'Printer & Scan',           // printer, scanner, toner, cartridge

  // ── Peralatan Rumah
  'Peralatan Rumah Tangga',   // AC, kulkas, mesin cuci, vacuum, setrika, dispenser air
  'Peralatan Dapur',          // blender, rice cooker, microwave, kompor, air fryer
  'Furnitur',                 // meja, kursi, lemari, rak, sofa, kasur
  'Dekorasi & Lampu',         // hiasan rumah, lampu, karpet, cermin, gorden
  'Perlengkapan Rumah',       // peralatan kebersihan, organizer, tempat sampah, linen

  // ── Fashion
  'Pakaian Pria',             // kaos, kemeja, celana, jaket, batik pria
  'Pakaian Wanita',           // dress, blouse, rok, jaket, baju muslim wanita
  'Pakaian Anak',             // baju anak laki-laki & perempuan, seragam
  'Pakaian Bayi',             // baju bayi, sleepsuit, bedong, kaos kaki bayi
  'Sepatu',                   // sneakers, formal, sandal, sepatu anak, sepatu olahraga
  'Tas & Dompet',             // ransel, tote bag, tas selempang, dompet, koper
  'Aksesoris Fashion',        // jam tangan, perhiasan, kacamata, topi, ikat pinggang
  'Pakaian Muslim',           // hijab, gamis, mukena, baju koko, sarung

  // ── Kecantikan & Kesehatan
  'Skincare',                 // serum, moisturizer, sunscreen, toner, face wash
  'Makeup',                   // foundation, lipstik, eyeshadow, mascara, blush
  'Perawatan Rambut',         // sampo, kondisioner, hair mask, hair dryer, sisir
  'Perawatan Tubuh',          // sabun mandi, lotion, deodorant, scrub, parfum
  'Suplemen & Vitamin',       // vitamin C, protein whey, multivitamin, herbal
  'Kesehatan & Medis',        // masker, termometer, tensimeter, obat, alat bantu

  // ── Ibu & Bayi
  'Ibu & Bayi',               // popok, stroller, car seat, dot, MPASI, susu formula
  'Mainan & Edukasi Anak',    // mainan bayi, puzzle, lego, board game, buku anak

  // ── Makanan & Hewan
  'Makanan & Minuman',        // snack, kopi, teh, beras, minyak, minuman kemasan
  'Hewan Peliharaan',         // makanan kucing/anjing, cage, aksesoris hewan

  // ── Olahraga & Outdoor
  'Olahraga & Fitness',       // alat gym, baju olahraga, sepatu olahraga, raket
  'Outdoor & Camping',        // tenda, sleeping bag, ransel gunung, perlengkapan hiking

  // ── Otomotif
  'Aksesoris Mobil',          // karpet, parfum, charger mobil, dashcam, cover ban
  'Aksesoris Motor',          // helm, jaket motor, aksesoris sparepart motor

  // ── Lainnya
  'Buku & Alat Tulis',        // buku, novel, komik, alat tulis, perlengkapan sekolah
  'Hobi & Koleksi',           // alat musik, kartu koleksi, action figure, tanaman
  'Perlengkapan Kantor',      // meja kantor, kursi kantor, ATK, mesin kasir
  'Otomotif',                 // kendaraan, sparepart, ban, velg (catch-all)
  'Lainnya',
];

// ── 2. Category meta — which variant dimensions are expected ─────
// Used to resolve ambiguous tokens (e.g. "Coklat" = Warna or Rasa?)
const CATEGORY_DIMS = {
  'Handphone':            ['Warna', 'Penyimpanan', 'RAM'],
  'Tablet':               ['Warna', 'Penyimpanan', 'RAM'],
  'Laptop':               ['Warna', 'Penyimpanan', 'RAM'],
  'Desktop & PC':         ['Penyimpanan', 'RAM'],
  'Komponen Komputer':    ['Kapasitas', 'Tipe'],
  'Aksesoris Komputer':   ['Warna', 'Tipe'],
  'Aksesoris Handphone':  ['Warna', 'Tipe', 'Ukuran'],
  'Perangkat Audio':      ['Warna', 'Tipe'],
  'Kamera & Foto':        ['Warna', 'Tipe'],
  'TV & Perangkat Hiburan': ['Ukuran'],
  'Konsol & Game':        ['Warna', 'Tipe'],
  'Perangkat Wearable':   ['Warna', 'Ukuran'],

  'Peralatan Rumah Tangga': ['Tipe', 'Ukuran'],
  'Peralatan Dapur':      ['Tipe', 'Ukuran'],
  'Furnitur':             ['Warna', 'Ukuran', 'Material'],
  'Dekorasi & Lampu':     ['Warna', 'Ukuran', 'Tipe'],
  'Perlengkapan Rumah':   ['Warna', 'Ukuran', 'Tipe'],

  'Pakaian Pria':         ['Warna', 'Ukuran'],
  'Pakaian Wanita':       ['Warna', 'Ukuran'],
  'Pakaian Anak':         ['Warna', 'Ukuran'],
  'Pakaian Bayi':         ['Warna', 'Ukuran'],
  'Pakaian Muslim':       ['Warna', 'Ukuran'],
  'Sepatu':               ['Warna', 'Ukuran'],
  'Tas & Dompet':         ['Warna', 'Ukuran', 'Material'],
  'Aksesoris Fashion':    ['Warna', 'Ukuran', 'Tipe'],

  'Skincare':             ['Tipe Kulit', 'Volume', 'Varian'],
  'Makeup':               ['Warna', 'Shade', 'Tipe'],
  'Perawatan Rambut':     ['Tipe Rambut', 'Volume', 'Varian'],
  'Perawatan Tubuh':      ['Tipe', 'Volume', 'Varian'],
  'Suplemen & Vitamin':   ['Varian', 'Jumlah', 'Berat'],
  'Kesehatan & Medis':    ['Tipe', 'Ukuran', 'Jumlah'],

  'Ibu & Bayi':           ['Ukuran', 'Jumlah', 'Tipe'],  // popok: Ukuran=S/M/L, Jumlah=40pcs
  'Mainan & Edukasi Anak': ['Tipe', 'Warna', 'Ukuran'],

  'Makanan & Minuman':    ['Rasa', 'Berat', 'Jumlah'],
  'Hewan Peliharaan':     ['Rasa', 'Berat', 'Tipe'],

  'Olahraga & Fitness':   ['Warna', 'Ukuran', 'Tipe'],
  'Outdoor & Camping':    ['Warna', 'Ukuran', 'Tipe'],

  'Aksesoris Mobil':      ['Tipe', 'Warna', 'Ukuran'],
  'Aksesoris Motor':      ['Tipe', 'Warna', 'Ukuran'],

  'Buku & Alat Tulis':    ['Tipe', 'Jumlah'],
  'Hobi & Koleksi':       ['Tipe', 'Warna'],
};

// ── 3. Color definitions ─────────────────────────────────────────
const COLORS = {
  // Indonesian → canonical
  hitam: 'Hitam',       putih: 'Putih',       merah: 'Merah',
  biru: 'Biru',         hijau: 'Hijau',        kuning: 'Kuning',
  orange: 'Orange',     jingga: 'Orange',
  pink: 'Pink',         'merah muda': 'Pink',
  ungu: 'Ungu',         violet: 'Ungu',
  abu: 'Abu-abu',       'abu-abu': 'Abu-abu',
  cokelat: 'Cokelat',   kopi: 'Cokelat',
  emas: 'Emas',         perak: 'Silver',
  tosca: 'Tosca',       teal: 'Tosca',
  navy: 'Navy',
  cream: 'Cream',       krem: 'Cream',        ivory: 'Cream',
  maroon: 'Maroon',
  magenta: 'Magenta',   fuchsia: 'Magenta',
  mint: 'Mint',
  lavender: 'Lavender', lila: 'Lavender',
  beige: 'Beige',       nude: 'Nude',
  mocca: 'Mocca',       mocha: 'Mocca',
  melon: 'Melon',       salmon: 'Salmon',
  mauve: 'Mauve',       dusty: null,          // modifier, handled below
  rose: 'Rose',         dusty_rose: 'Dusty Rose',
  lilac: 'Lilac',       coral: 'Coral',
  sage: 'Sage',         olive: 'Olive',

  // English → canonical
  black: 'Hitam',       white: 'Putih',       red: 'Merah',
  blue: 'Biru',         green: 'Hijau',       yellow: 'Kuning',
  purple: 'Ungu',       grey: 'Abu-abu',      gray: 'Abu-abu',
  silver: 'Silver',     gold: 'Emas',         brown: 'Cokelat',
  pink: 'Pink',         orange: 'Orange',

  transparan: 'Transparan', transparent: 'Transparan',
  bening: 'Transparan', clear: 'Transparan',
};

// Build regex from color keys
const _colorKeys = Object.keys(COLORS).filter(k => COLORS[k] !== null && k !== 'dusty');
const COLOR_PATTERN = new RegExp(
  '(?:^|\\b)(' + _colorKeys
    .sort((a, b) => b.length - a.length) // longest first — "abu-abu" before "abu"
    .map(k => k.replace(/[-]/g, '[-\\s]?').replace(/\s/g, '\\s+'))
    .join('|') + ')(?:\\b|$)',
  'i'
);

// ── 4. Flavor definitions (food / beverage / supplement) ─────────
const FLAVORS = new Set([
  'coklat', 'chocolate', 'vanilla', 'vanila', 'stroberi', 'strawberry',
  'mangga', 'mango', 'jeruk', 'orange', 'lemon', 'matcha', 'green tea',
  'teh hijau', 'kopi', 'coffee', 'susu', 'milk', 'keju', 'cheese',
  'caramel', 'karamel', 'blueberry', 'anggur', 'grape', 'melon',
  'semangka', 'watermelon', 'pisang', 'banana', 'original', 'plain',
  'madu', 'honey', 'pandan', 'durian', 'kelapa', 'coconut',
  'mint', 'spearmint', 'buah', 'fruit', 'mixed berry', 'blackcurrant',
  'peach', 'apricot', 'bayam', 'wortel', 'carrot', 'apple', 'apel',
  'kurma', 'date', 'jahe', 'ginger', 'kunyit', 'turmeric', 'kencur',
  'rempah', 'pedas', 'spicy', 'bbq', 'balado', 'keju', 'asin',
]);

// ── 5. Variant Dimension Detector ────────────────────────────────
/**
 * Detect the dimension type of a single variant token.
 *
 * @param {string} token   — e.g. "Hitam", "128GB", "XL", "Coklat"
 * @param {string} [cat]   — standardized category (from CATEGORIES), for ambiguity resolution
 * @returns {{ dim: string|null, value: string }}
 *   dim   = canonical dimension key (e.g. "Warna", "Penyimpanan", "Ukuran")
 *   value = normalized display value
 */
function detectDimension(token, cat) {
  const t   = String(token).trim();
  const low = t.toLowerCase().replace(/\s+/g, ' ');

  if (!t) return { dim: null, value: t };

  // ── Storage/RAM with explicit labels ──────────────────────────
  if (/\b(rom|internal|storage|penyimpanan)\b/i.test(t)) {
    const m = t.match(/(\d+)\s*(gb|tb|mb)/i);
    if (m) return { dim: 'Penyimpanan', value: normStorage(m[1], m[2]) };
  }
  if (/\bram\b/i.test(t)) {
    const m = t.match(/(\d+)\s*(gb|mb)/i);
    if (m) return { dim: 'RAM', value: normStorage(m[1], m[2]) };
  }

  // ── Pure storage/memory number ────────────────────────────────
  // e.g. "128GB", "512GB", "1TB", "256 GB"
  const storageM = t.match(/^(\d+)\s*(gb|tb|mb)$/i);
  if (storageM) {
    const num = parseInt(storageM[1]);
    const unit = storageM[2].toUpperCase();
    const normalized = `${num}${unit}`;
    // Phones/tablets/laptops: small GB = RAM, large GB = storage
    const isElectronicsCat = cat && /handphone|tablet|laptop|desktop/i.test(cat);
    if (unit === 'GB' && num <= 32 && isElectronicsCat) {
      return { dim: 'RAM', value: normalized };
    }
    return { dim: 'Penyimpanan', value: normalized };
  }

  // ── RAM + Storage combined in one token: "8/128GB", "6GB/128GB" ─
  const ramStorageM = t.match(/^(\d+)\s*\/\s*(\d+)\s*(gb|tb)$/i);
  if (ramStorageM) {
    return {
      dim: 'RAM+Penyimpanan',
      value: `${ramStorageM[1]}GB/${ramStorageM[2]}${ramStorageM[3].toUpperCase()}`,
      ram: `${ramStorageM[1]}GB`,
      storage: `${ramStorageM[2]}${ramStorageM[3].toUpperCase()}`,
    };
  }

  // ── Weight / Volume ───────────────────────────────────────────
  // e.g. "500g", "1kg", "100ml", "250ml", "1L", "1 liter"
  const weightM = t.match(/^(\d+(?:[.,]\d+)?)\s*(g|gr|gram|kg|kilogram)$/i);
  if (weightM) {
    const n = weightM[1].replace(',', '.');
    const u = /^(kg|kilogram)/i.test(weightM[2]) ? 'kg' : 'g';
    return { dim: 'Berat', value: `${n}${u}` };
  }
  const volM = t.match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|liter|cc)$/i);
  if (volM) {
    const n = volM[1].replace(',', '.');
    const u = /^(l|liter)/i.test(volM[2]) ? 'L' : 'ml';
    return { dim: 'Volume', value: `${n}${u}` };
  }

  // ── Apparel sizes ─────────────────────────────────────────────
  // "S", "M", "L", "XL", "XXL", "3XL", "4XL"
  if (/^(xs|s|m|l|xl|xxl|3xl|4xl|xxxl|\d{0,1}xl)$/i.test(t)) {
    return { dim: 'Ukuran', value: t.toUpperCase() };
  }

  // ── Diaper / baby sizes ───────────────────────────────────────
  // "NB", "Newborn" + standard S/M/L/XL/XXL
  if (/^(nb|newborn)$/i.test(t)) {
    return { dim: 'Ukuran', value: 'NB' };
  }

  // ── Shoe sizes ────────────────────────────────────────────────
  // 28–47 range (adult), 15–27 (kids)
  if (/^\d{2}$/.test(t) && parseInt(t) >= 15 && parseInt(t) <= 50) {
    return { dim: 'Ukuran', value: t };
  }

  // ── Screen sizes ──────────────────────────────────────────────
  // "55 Inch", "6.1\"", "32\""
  const screenM = t.match(/^(\d+(?:[.,]\d+)?)\s*(inch|"|in\b)/i);
  if (screenM) {
    return { dim: 'Ukuran', value: `${screenM[1].replace(',', '.')}"` };
  }

  // ── Quantity / pack size ──────────────────────────────────────
  // "1 pcs", "2 pack", "isi 40", "40 lembar", "1 pasang", "3 buah", "1 lusin"
  if (/^(\d+)\s*(pcs|pc|pack|buah|lembar|sheet|pasang|lusin|sachet|kapsul|tablet|keping|roll|botol|tube)$/i.test(t) ||
      /^(isi|paket)\s*\d+/i.test(t)) {
    return { dim: 'Jumlah', value: capitalize(t) };
  }

  // ── Wattage / power ───────────────────────────────────────────
  // "65W", "100 Watt"
  const wattM = t.match(/^(\d+)\s*(w|watt)$/i);
  if (wattM) return { dim: 'Daya', value: `${wattM[1]}W` };

  // ── Skin type (skincare context) ─────────────────────────────
  if (/\b(normal|oily|dry|berminyak|kering|sensitif|sensitive|combination|kombinasi)\b.*\b(skin|kulit)\b/i.test(t) ||
      /\b(kulit)\s+(berminyak|kering|normal|sensitif|kombinasi)\b/i.test(t) ||
      /\b(all skin|semua kulit)\b/i.test(t)) {
    return { dim: 'Tipe Kulit', value: capitalize(t) };
  }

  // ── Flavor (food/beverage/supplement) ────────────────────────
  // Use category context — "coklat" for fashion = Warna, for food = Rasa
  const isFood = cat && /makanan|minuman|suplemen|vitamin|hewan|kopi|teh|snack/i.test(cat);
  if (isFood && FLAVORS.has(low)) {
    return { dim: 'Rasa', value: capitalize(t) };
  }

  // ── Color detection ───────────────────────────────────────────
  // Exact match in color map
  if (COLORS[low] !== undefined && COLORS[low] !== null) {
    return { dim: 'Warna', value: COLORS[low] };
  }

  // Partial color match (e.g. "Dark Blue", "Biru Dongker", "Light Grey")
  const colorM = low.match(COLOR_PATTERN);
  if (colorM) {
    const baseVal  = COLORS[colorM[1].toLowerCase()] || capitalize(colorM[1]);
    const prefix   = low.slice(0, colorM.index).trim();
    const suffix   = low.slice(colorM.index + colorM[1].length).trim();
    const modifier = [prefix, suffix].filter(Boolean).join(' ');
    const value    = modifier
      ? `${capitalize(modifier)} ${baseVal}`
      : baseVal;
    return { dim: 'Warna', value };
  }

  // ── Flavor fallback (non-food context, common flavor words still used) ─
  if (FLAVORS.has(low)) {
    return { dim: 'Rasa', value: capitalize(t) };
  }

  // ── Connector / port types ────────────────────────────────────
  if (/^(type[\s-]?c|micro[\s-]?usb|lightning|usb[\s-]?a|usb[\s-]?c|hdmi|dp|vga|rj45)$/i.test(t)) {
    return { dim: 'Konektor', value: t.toUpperCase().replace(/TYPE C/i, 'Type-C').replace(/MICRO USB/i, 'Micro USB') };
  }

  // ── Material ──────────────────────────────────────────────────
  if (/\b(cotton|katun|polyester|nilon|nylon|leather|kulit|suede|kanvas|canvas|denim|linen|wol|wool|satin|silk|sutra|fleece)\b/i.test(t)) {
    return { dim: 'Material', value: capitalize(t) };
  }

  // ── Generic "Tipe" / "Varian" ─────────────────────────────────
  // Keep as-is but classify as Tipe — e.g. "Original", "Pro Max", "Travel Size"
  if (/^(original|pro|plus|max|lite|mini|ultra|se|standard|regular|travel size|ekonomis|premium|deluxe|special)$/i.test(t)) {
    return { dim: 'Tipe', value: capitalize(t) };
  }

  // ── Fallback — unknown, keep raw ─────────────────────────────
  return { dim: null, value: capitalize(t) };
}

// Normalize storage/RAM value
function normStorage(num, unit) {
  return `${parseInt(num)}${unit.toUpperCase()}`;
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ── 6. Attribute Key Normalization ───────────────────────────────
// Maps raw attr name → canonical Indonesian key.
// Covers Shopee + Tokopedia attribute names across ALL categories.
const ATTR_KEY_MAP = {
  // ── Electronics
  'ram': 'RAM', 'memory ram': 'RAM', 'memori ram': 'RAM', 'memori': 'RAM', 'memory': 'RAM',
  'storage': 'Penyimpanan', 'internal storage': 'Penyimpanan', 'penyimpanan': 'Penyimpanan',
  'penyimpanan internal': 'Penyimpanan', 'rom': 'Penyimpanan', 'kapasitas': 'Penyimpanan',
  'kapasitas penyimpanan': 'Penyimpanan', 'internal memory': 'Penyimpanan',
  'processor': 'Prosesor', 'prosesor': 'Prosesor', 'chipset': 'Prosesor',
  'cpu': 'Prosesor', 'chip': 'Prosesor', 'jenis prosesor': 'Prosesor', 'soc': 'Prosesor',
  'layar': 'Layar', 'ukuran layar': 'Layar', 'screen size': 'Layar', 'display size': 'Layar',
  'resolusi layar': 'Resolusi', 'screen resolution': 'Resolusi', 'resolusi': 'Resolusi',
  'tipe layar': 'Tipe Layar', 'panel type': 'Tipe Layar', 'display type': 'Tipe Layar',
  'refresh rate': 'Refresh Rate',
  'baterai': 'Baterai', 'battery': 'Baterai', 'kapasitas baterai': 'Baterai',
  'battery capacity': 'Baterai', 'cell capacity': 'Baterai',
  'kamera': 'Kamera Belakang', 'kamera belakang': 'Kamera Belakang', 'rear camera': 'Kamera Belakang',
  'kamera depan': 'Kamera Depan', 'front camera': 'Kamera Depan', 'selfie camera': 'Kamera Depan',
  'resolusi kamera': 'Kamera Belakang',
  'os': 'Sistem Operasi', 'operating system': 'Sistem Operasi', 'sistem operasi': 'Sistem Operasi',
  'jaringan': 'Jaringan', 'network': 'Jaringan', 'konektivitas': 'Konektivitas',
  'connectivity': 'Konektivitas', 'nfc': 'NFC', 'bluetooth': 'Bluetooth', 'wifi': 'WiFi',
  'sim card': 'SIM Card', 'kartu sim': 'SIM Card', 'dual sim': 'SIM Card',
  'slot sim': 'SIM Card',

  // ── Physical / general
  'berat': 'Berat', 'weight': 'Berat', 'net weight': 'Berat', 'berat bersih': 'Berat',
  'berat kotor': 'Berat Kotor', 'gross weight': 'Berat Kotor',
  'dimensi': 'Dimensi', 'dimension': 'Dimensi', 'ukuran': 'Ukuran', 'size': 'Ukuran',
  'panjang': 'Panjang', 'length': 'Panjang',
  'lebar': 'Lebar', 'width': 'Lebar',
  'tinggi': 'Tinggi', 'height': 'Tinggi',
  'warna': 'Warna', 'color': 'Warna', 'colour': 'Warna',
  'material': 'Material', 'bahan': 'Material', 'material utama': 'Material',
  'main material': 'Material',
  'brand': 'Merek', 'merek': 'Merek', 'merk': 'Merek',
  'model': 'Model', 'tipe': 'Tipe', 'type': 'Tipe', 'seri': 'Seri', 'series': 'Seri',
  'garansi': 'Garansi', 'warranty': 'Garansi', 'garansi resmi': 'Garansi',
  'jenis garansi': 'Garansi',
  'kondisi': 'Kondisi', 'condition': 'Kondisi',
  'daya': 'Daya', 'power': 'Daya', 'wattage': 'Daya', 'power consumption': 'Daya',
  'voltase': 'Voltase', 'voltage': 'Voltase',

  // ── Fashion / Apparel
  'bahan pakaian': 'Material', 'fabric': 'Material', 'kain': 'Material',
  'jenis bahan': 'Material',
  'ukuran pakaian': 'Ukuran', 'clothing size': 'Ukuran', 'apparel size': 'Ukuran',
  'pola': 'Pola', 'pattern': 'Pola', 'motif': 'Pola',
  'gender': 'Gender', 'jenis kelamin': 'Gender',
  'usia': 'Usia', 'age': 'Usia', 'umur': 'Usia',

  // ── Shoes
  'ukuran sepatu': 'Ukuran', 'shoe size': 'Ukuran', 'nomor sepatu': 'Ukuran',
  'jenis sol': 'Sol', 'sole type': 'Sol',
  'tinggi hak': 'Tinggi Hak', 'heel height': 'Tinggi Hak',

  // ── Skincare / Beauty
  'tipe kulit': 'Tipe Kulit', 'skin type': 'Tipe Kulit', 'jenis kulit': 'Tipe Kulit',
  'kandungan': 'Kandungan', 'ingredients': 'Kandungan', 'bahan aktif': 'Kandungan',
  'spf': 'SPF',
  'volume': 'Volume', 'net volume': 'Volume', 'isi bersih': 'Volume',
  'kapasitas volume': 'Volume',
  'expired': 'Kedaluwarsa', 'expiry': 'Kedaluwarsa', 'best before': 'Kedaluwarsa',
  'kadaluarsa': 'Kedaluwarsa',
  'bpom': 'BPOM', 'nomor bpom': 'BPOM', 'izin bpom': 'BPOM',

  // ── Food & Beverage
  'rasa': 'Rasa', 'flavor': 'Rasa', 'flavour': 'Rasa', 'varian rasa': 'Rasa',
  'berat bersih': 'Berat', 'neto': 'Berat', 'net weight': 'Berat',
  'halal': 'Halal',

  // ── Baby products
  'ukuran popok': 'Ukuran', 'diaper size': 'Ukuran',
  'isi per pack': 'Jumlah', 'jumlah lembar': 'Jumlah', 'per pack': 'Jumlah',

  // ── Automotive
  'merek kendaraan': 'Merek Kendaraan', 'car brand': 'Merek Kendaraan',
  'tipe kendaraan': 'Tipe Kendaraan', 'vehicle type': 'Tipe Kendaraan',
  'tahun': 'Tahun', 'year': 'Tahun',

  // ── Home / Furniture
  'kapasitas': 'Kapasitas',
  'luas': 'Luas', 'area': 'Luas',
  'watt': 'Daya',
};

/**
 * Normalize a raw attribute key to its canonical form.
 * Returns null if unknown (caller decides to keep or drop).
 */
function normalizeAttrKey(raw) {
  if (!raw) return null;
  const low = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return ATTR_KEY_MAP[low] || null;
}

/**
 * Normalize a raw attribute value given its canonical key.
 */
function normalizeAttrValue(key, raw) {
  if (!raw) return raw;
  const v = String(raw).trim();

  switch (key) {
    case 'Penyimpanan':
    case 'RAM':
    case 'Kapasitas':
      // "128 GB" → "128GB", "1 TB" → "1TB"
      return v.replace(/(\d+)\s*(gb|tb|mb)/gi, (_, n, u) => `${parseInt(n)}${u.toUpperCase()}`);

    case 'Layar':
      // "6.1 Inch" / "6,1 inch" → "6.1\""
    {
      const m = v.match(/^([\d.,]+)\s*inch/i);
      if (m) return `${m[1].replace(',', '.')}"`;
      return v;
    }

    case 'Baterai':
      // "5000 mAh" → "5000mAh"
      return v.replace(/(\d[\d.]*)\s*mah/i, (_, n) => `${n}mAh`);

    case 'Berat':
      // "200 gram" → "200g", "1.5 kg" → "1.5kg"
      return v
        .replace(/(\d+(?:\.\d+)?)\s*gram/i, (_, n) => `${n}g`)
        .replace(/(\d+(?:\.\d+)?)\s*kg/i,   (_, n) => `${n}kg`)
        .replace(/(\d+(?:\.\d+)?)\s*gr\b/i,  (_, n) => `${n}g`);

    case 'Volume':
      // "100 ml" → "100ml", "1 liter" → "1L"
      return v
        .replace(/(\d+(?:\.\d+)?)\s*ml/i,    (_, n) => `${n}ml`)
        .replace(/(\d+(?:\.\d+)?)\s*liter/i, (_, n) => `${n}L`)
        .replace(/(\d+(?:\.\d+)?)\s*\bl\b/i, (_, n) => `${n}L`);

    case 'Daya':
      return v.replace(/(\d+)\s*(w|watt)/i, (_, n) => `${n}W`);

    case 'Warna': {
      const det = detectDimension(v);
      if (det.dim === 'Warna') return det.value;
      return capitalize(v);
    }

    default:
      return v;
  }
}

module.exports = {
  CATEGORIES,
  CATEGORY_DIMS,
  detectDimension,
  normalizeAttrKey,
  normalizeAttrValue,
  COLORS,
  COLOR_PATTERN,
  FLAVORS,
};
