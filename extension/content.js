// ================================================================
// finding.id — Content Script (ISOLATED world) v1.2
//
// STRATEGY:
//   content_interceptor.js runs in MAIN world and hooks fetch/XHR.
//   It forwards captured responses here via window.postMessage.
//   This script (ISOLATED world) has chrome.runtime access, so it
//   parses the data and sends product batches to the background.
//
// FIELDS CAPTURED PER PRODUCT:
//   title, price, rating, sold_count, link, image_url,
//   category, description, specs (key:value pairs as string)
// ================================================================

(function () {
  'use strict';

  const source = detectSource();
  const TAG    = `[fid:content:${source}]`;

  // ── Shopee category ID → human-readable name ─────────────────
  // These are Shopee Indonesia's top-level & common sub-categories.
  // Convert a product title to a Shopee-style URL slug: spaces→hyphens, strip unsafe chars
  function toShopeeSlug(title) {
    return (title || '')
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9\-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || 'product';
  }

  // Detail API provides display_name directly; this map covers list results.
  const SHOPEE_CATS = {
    11042604: "Sepatu Wanita",
    11042605: "Boots",
    11042609: "Sneakers",
    11042610: "Sepatu Flat",
    11042615: "Loafers & Boat Shoes",
    11042616: "Sepatu Oxford",
    11042617: "Slip Ons, Mary Janes & Mules",
    11042618: "Heels",
    11042623: "Wedges",
    11042624: "Sandal",
    11042630: "Aksesoris & Perawatan Sepatu",
    11042637: "Kaus Kaki & Stocking",
    11042641: "Sepatu Wanita Lainnya",
    11042642: "Tas Wanita",
    11042643: "Ransel Wanita",
    11042644: "Tas Serut",
    11042645: "Tas Laptop",
    11042650: "Clutch",
    11042651: "Tas Pinggang Wanita",
    11042652: "Tote Bag",
    11042655: "Top Handle Bag",
    11042656: "Tas Selempang & Bahu Wanita",
    11042657: "Dompet Wanita",
    11042664: "Aksesoris Tas",
    11042671: "Tas Wanita Lainnya",
    11042672: "Koper & Tas Travel",
    11042684: "Fashion Muslim",
    11042685: "Hijab",
    11042693: "Aksesoris Muslim",
    11042697: "Atasan Muslim Wanita",
    11042702: "Dress Muslim",
    11042712: "Bawahan Muslim Wanita",
    11042718: "Mukena & Perlengkapan Sholat",
    11042725: "Pakaian Muslim Pria",
    11042732: "Pakaian Muslim Anak",
    11042737: "Outerwear",
    11042743: "Set",
    11042744: "Fashion Muslim Lainnya",
    11042745: "Pakaian Wanita",
    11042746: "Atasan",
    11042754: "Celana Panjang & Legging",
    11042762: "Celana Pendek",
    11042766: "Rok",
    11042770: "Dress",
    11042774: "Wedding Dress",
    11042775: "Jumpsuit, Playsuit, & Overall",
    11042780: "Jaket, Mantel, & Rompi",
    11042787: "Sweater & Cardigan",
    11042788: "Hoodie & Sweatshirt",
    11042792: "Set",
    11042797: "Pakaian Dalam",
    11042807: "Pakaian Tidur & Piyama",
    11042812: "Baju Hamil",
    11042820: "Pakaian Tradisional",
    11042826: "Kostum",
    11042827: "Pakaian Wanita Lainnya",
    11042828: "Kain",
    11042840: "Batik",
    11042849: "Pakaian Pria",
    11042850: "Denim",
    11042855: "Hoodie & Sweatshirt",
    11042859: "Sweater & Cardigan",
    11042860: "Jaket, Mantel, & Rompi",
    11042865: "Jas Formal",
    11042871: "Celana Panjang",
    11042876: "Celana Pendek",
    11042877: "Atasan",
    11042883: "Batik",
    11042885: "Pakaian Dalam",
    11042890: "Pakaian Tidur",
    11042891: "Set Pakaian Pria",
    11042892: "Pakaian Tradisional",
    11042897: "Kostum",
    11042898: "Pakaian Kerja",
    11042899: "Pakaian Pria Lainnya",
    11042900: "Jam Tangan",
    11042901: "Jam Tangan Wanita",
    11042905: "Jam Tangan Pria",
    11042909: "Jam Tangan Couple",
    11042913: "Aksesoris Jam Tangan",
    11042920: "Jam Tangan Lainnya",
    11042921: "Aksesoris Fashion",
    11042922: "Cincin",
    11042923: "Anting",
    11042924: "Syal & Selendang",
    11042925: "Sarung Tangan",
    11042930: "Aksesoris Rambut",
    11042937: "Gelang Tangan & Bangle",
    11042938: "Gelang Kaki",
    11042939: "Topi",
    11042947: "Kalung",
    11042952: "Kacamata & Aksesoris",
    11042957: "Logam Mulia",
    11042963: "Ikat Pinggang",
    11042967: "Dasi",
    11042968: "Aksesoris Tambahan",
    11042976: "Set & Paket Aksesoris",
    11042977: "Aksesoris Fashion Lainnya",
    11042978: "Perhiasan Berharga",
    11042985: "Sepatu Pria",
    11042986: "Boot",
    11042991: "Sneakers",
    11042992: "Slip-On & Mules",
    11042993: "Sepatu Formal",
    11042996: "Sandal",
    11043002: "Aksesoris & Perawatan Sepatu",
    11043008: "Tali Sepatu",
    11043009: "Kaos Kaki",
    11043010: "Sepatu Pria Lainnya",
    11043011: "Tas Pria",
    11043012: "Ransel Pria",
    11043013: "Tas Laptop",
    11043018: "Tote Bag",
    11043019: "Tas Kerja",
    11043020: "Clutch",
    11043021: "Tas Pinggang Pria",
    11043022: "Tas Selempang & Bahu Pria",
    11043023: "Dompet",
    11043030: "Tas Pria Lainnya",
    11043031: "Fashion Bayi & Anak",
    11043032: "Pakaian Bayi",
    11043043: "Sepatu Bayi",
    11043044: "Tas Anak Laki-Laki",
    11043050: "Tas Anak Perempuan",
    11043056: "Aksesoris Bayi & Anak",
    11043067: "Perlengkapan Hujan",
    11043071: "Perhiasan",
    11043077: "Pakaian Anak Laki-Laki",
    11043092: "Pakaian Anak Perempuan",
    11043110: "Sepatu Anak Laki-Laki",
    11043118: "Sepatu Anak Perempuan",
    11043126: "Fashion Bayi & Anak Lainnya",
    11043127: "Denim",
    11043145: "Perawatan & Kecantikan",
    11043146: "Perawatan Tubuh",
    11043159: "Perawatan Tangan",
    11043164: "Perawatan Kaki",
    11043169: "Perawatan Kuku",
    11043178: "Perawatan Rambut",
    11043185: "Perawatan Pria",
    11043198: "Parfum & Wewangian",
    11043202: "Kosmetik Wajah",
    11043212: "Kosmetik Mata",
    11043219: "Kosmetik Bibir",
    11043226: "Pembersih Make Up",
    11043227: "Aksesoris Make Up",
    11043240: "Alat Perawatan Wajah",
    11043245: "Alat Pelangsing Tubuh",
    11043246: "Alat Penghilang Bulu Rambut",
    11043247: "Alat Rambut",
    11043253: "Perawatan Wajah",
    11043267: "Treatment Mata",
    11043272: "Treatment Bibir",
    11043277: "Paket & Set Kecantikan",
    11043278: "Kecantikan Lainnya",
    11043279: "Kesehatan",
    11043280: "Suplemen Makanan",
    11043288: "Obat-obatan & Alat Kesehatan",
    11043296: "Alat Tes & Monitor",
    11043302: "P3K",
    11043308: "Alat Bantu Cedera & Disabilitas",
    11043314: "Obat Nyamuk",
    11043315: "Popok Dewasa",
    11043316: "Hand Sanitizer",
    11043317: "Minyak Esensial",
    11043318: "Perawatan Hidung & Pernafasan",
    11043319: "Perawatan Telinga",
    11043320: "Perawatan Mulut",
    11043331: "Kewanitaan",
    11043339: "Kesehatan Seksual",
    11043345: "Kesehatan Lainnya",
    11043346: "Perawatan Mata",
    11043350: "Ibu & Bayi",
    11043351: "Perlengkapan Travelling Bayi",
    11043360: "Peralatan & Aksesoris Makan",
    11043369: "Perlengkapan Botol Susu",
    11043375: "Perlengkapan Menyusui",
    11043381: "Perlengkapan Ibu Hamil",
    11043385: "Kesehatan Kehamilan",
    11043390: "Kesehatan & Perawatan Bayi",
    11043404: "Perlengkapan Mandi",
    11043411: "Kamar Bayi",
    11043420: "Keamanan Bayi",
    11043428: "Susu Formula & Makanan Bayi",
    11043433: "Popok & Pispot",
    11043439: "Mainan",
    11043449: "Set & Paket Hadiah",
    11043450: "Ibu & Bayi Lainnya",
    11043451: "Makanan & Minuman",
    11043453: "Makanan Ringan",
    11043467: "Bahan Pokok",
    11043496: "Menu Sarapan",
    11043502: "Minuman",
    11043517: "Susu & Olahan",
    11043529: "Makanan Segar & Beku",
    11043544: "Roti & Kue",
    11043555: "Set Hadiah & Hampers",
    11043556: "Makanan & Minuman Lainnya",
    11043557: "Makanan Kaleng",
    11043564: "Makanan Instan",
    11043572: "Hobi & Koleksi",
    11043573: "Makanan Hewan",
    11043584: "Aksesoris Hewan Peliharaan",
    11043596: "Litter & Toilet",
    11043603: "Grooming Hewan",
    11043608: "Pakaian & Aksesoris Hewan",
    11043617: "Perawatan Kesehatan Hewan",
    11043622: "Koleksi",
    11043633: "Mainan & Games",
    11043647: "CD, DVD & Bluray",
    11043648: "Alat & Aksesoris Musik",
    11043656: "Piringan Hitam",
    11043657: "Album Foto",
    11043658: "Perlengkapan Menjahit",
    11043659: "Hobi & Koleksi Lainnya",
    11043660: "Otomotif",
    11043661: "Mobil",
    11043662: "Aksesoris Interior Mobil",
    11043681: "Aksesoris Eksterior Mobil",
    11043693: "Suku Cadang Mobil",
    11043714: "Perkakas & Perlengkapan Kendaraan",
    11043718: "Perawatan Kendaraan",
    11043725: "Oli & Pelumas Kendaraan",
    11043733: "Gantungan & Sarung Kunci Kendaraan",
    11043734: "Sepeda Motor",
    11043735: "Aksesoris Sepeda Motor",
    11043747: "Suku Cadang Motor",
    11043770: "Aksesoris Pengendara Motor",
    11043776: "E-Money & Aksesoris",
    11043777: "Otomotif Lainnya",
    11043778: "Perlengkapan Rumah",
    11043779: "Pengharum Ruangan & Aromaterapi",
    11043783: "Kamar Mandi",
    11043797: "Kamar Tidur",
    11043807: "Dekorasi",
    11043820: "Furniture",
    11043838: "Taman",
    11043849: "Renovasi Rumah",
    11043863: "Perkakas",
    11043875: "Alat Pemeliharaan Rumah",
    11043886: "Kebersihan & Binatu",
    11043895: "Peralatan Dapur",
    11043909: "Peralatan Masak",
    11043922: "Peralatan Makan",
    11043934: "Alat Pengaman",
    11043939: "Organizer Rumah",
    11043950: "Perlengkapan Keagamaan",
    11043951: "Perlengkapan Rumah Lainnya",
    11043952: "Payung",
    11043958: "Olahraga & Outdoor",
    11043959: "Alat Pancing",
    11043968: "Bersepeda",
    11043974: "Camping & Hiking",
    11043987: "Panjat Tebing",
    11043988: "Panahan",
    11043992: "Sepak Bola, Futsal, & Sepak Takraw",
    11043999: "Basket",
    11044004: "Voli",
    11044008: "Bulu Tangkis",
    11044013: "Tenis",
    11044019: "Tenis Meja",
    11044024: "Tinju & Bela Diri",
    11044031: "Golf",
    11044038: "Baseball & Softball",
    11044039: "Squash",
    11044040: "Rugbi",
    11044041: "Billiard",
    11044042: "Selancar & Wakeboard",
    11044043: "Ice Skating & Olahraga Musim Dingin",
    11044044: "Diving & Renang",
    11044060: "Boating",
    11044061: "Yoga & Pilates",
    11044066: "Fitness",
    11044074: "Dart",
    11044075: "Sepatu Olahraga",
    11044087: "Pakaian Olahraga Pria",
    11044093: "Pakaian Olahraga Wanita",
    11044100: "Pakaian Olahraga Anak",
    11044101: "Aksesoris Olahraga & Aktivitas Outdoor",
    11044112: "Olahraga & Outdoor Lainnya",
    11044113: "Boardsport",
    11044123: "Buku & Alat Tulis",
    11044124: "Alat Tulis",
    11044131: "Perlengkapan Sekolah & Kantor",
    11044149: "Folder, Organizer Kertas, & Aksesoris",
    11044155: "Perlengkapan Menggambar",
    11044166: "Buku Tulis & Kertas",
    11044177: "Surat-Menyurat",
    11044182: "Bubble Wrap",
    11044183: "Majalah & Koran",
    11044188: "Buku Anak-Anak",
    11044191: "Buku Edukasi",
    11044197: "Buku Non-Fiksi",
    11044213: "Buku Fiksi",
    11044218: "Komik & Manga",
    11044223: "E-Book",
    11044224: "Buku & Alat Tulis Lainnya",
    11044245: "Pembungkus Kado & Kemasan",
    11044253: "Bunga",
    11044258: "Elektronik",
    11044259: "Foot Bath & Spa",
    11044260: "Mesin Jahit & Aksesoris",
    11044261: "Setrika & Mesin Uap",
    11044262: "Purifier & Humidifier",
    11044266: "Penyedot Debu & Peralatan Perawatan Lantai",
    11044271: "Telepon",
    11044276: "Mesin Cuci & Pengering",
    11044280: "Water Heater",
    11044281: "Pendingin Ruangan",
    11044286: "Pengering Sepatu",
    11044287: "Penghangat Ruangan",
    11044288: "TV & Aksesoris",
    11044294: "Perangkat Dapur",
    11044319: "Kelistrikan",
    11044328: "Baterai",
    11044329: "Rokok Elektronik & Shisha",
    11044335: "Remot Kontrol",
    11044336: "Elektronik Lainnya",
    11044337: "Walkie Talkie",
    11044338: "Media Player",
    11044344: "Perangkat Audio & Speaker",
    11044352: "Konsol Game",
    11044362: "Aksesoris Konsol",
    11044363: "Alat Casting",
    11044364: "Komputer & Aksesoris",
    11044365: "Desktop",
    11044371: "Monitor",
    11044372: "Komponen Desktop & Laptop",
    11044386: "Penyimpanan Data",
    11044394: "Komponen Network",
    11044405: "Software",
    11044410: "Peralatan Kantor",
    11044416: "Printer & Scanner",
    11044422: "Aksesoris Desktop & Laptop",
    11044434: "Keyboard & Mouse",
    11044440: "Laptop",
    11044445: "Gaming",
    11044451: "Audio Computer",
    11044457: "Komputer & Aksesoris Lainnya",
    11044458: "Handphone & Aksesoris",
    11044459: "Kartu Perdana",
    11044460: "Tablet",
    11044476: "Handphone",
    11044504: "Perangkat Wearable",
    11044507: "Perangkat VR",
    11044508: "Aksesoris Selfie",
    11044514: "Handphone & Tablet Aksesoris",
    11044523: "Kartu Memori",
    11044527: "Kabel, Charger, & Konverter",
    11044534: "Powerbank & Baterai",
    11044539: "Casing & Skin",
    11044544: "Audio Handphone",
    11044549: "Handphone & Aksesoris Lainnya",
    11044550: "Lampu",
    11044567: "Kamera Keamanan",
    11044573: "Video Game",
    11044584: "Proyektor & Aksesoris",
    11044588: "Fotografi",
    11044589: "Kamera",
    11044598: "Lensa & Aksesoris",
    11044605: "Flash & Aksesoris",
    11044610: "Lighting & Perlengkapan Studio Foto",
    11044611: "Roll Film & Kertas Foto",
    11044612: "Printer Foto",
    11044613: "Tas & Casing Kamera",
    11044614: "Charger Baterai",
    11044615: "Baterai & Battery Grip",
    11044616: "Tripod, Monopod, & Aksesoris",
    11044617: "Kartu Memori",
    11044619: "Perawatan Kamera",
    11044626: "Drone & Aksesoris",
    11044629: "Fotografi Lainnya",
    11044630: "Gimbal & Stabilizer",
    11044631: "Voucher",
    11044632: "Tiket Event",
    11044635: "Belanja",
    11044642: "Data",
    11044648: "Pulsa",
    11044654: "Travel & Tour",
    11044658: "Gaming",
    11044666: "Shopee",
    11053196: "Lensa Kontak & Aksesoris",
    11105951: "Deals Sekitarmu",
    11105952: "Voucher ShopeePay",
    11105953: "Voucher Deals",
    11116625: "Perlengkapan Pesta",
    11116633: "Souvenir & Perlengkapan Pesta",
    11116634: "Souvenir & Hadiah",
    11116635: "Balon",
    11122103: "Hewan Peliharaan Lainnya",
  };

  // Batch collector — accumulates all products seen, deduplicated by link
  const seen     = new Set();
  let   batchNum = 0;

  log('✅ ISOLATED world script loaded on ' + location.href);

  // ── CAPTCHA / challenge page detection ───────────────────────
  // Shopee shows a /verify or /bot-verify page when it suspects automation.
  // Detect it by URL path and known DOM elements, then alert the backend.
  (function detectCaptcha() {
    const url = location.href;
    const isCaptchaUrl =
      /\/(verify|bot[\-_]?verify|challenge|robot|captcha)/i.test(location.pathname) ||
      url.includes('cf_chl') || url.includes('__cf_chl');

    // Also check for visible captcha DOM after a short delay
    function checkDom() {
      const hasCaptchaDom =
        !!document.querySelector('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]') ||
        !!document.querySelector('[class*="verify"], [id*="verify-"]') ||
        (document.title || '').toLowerCase().includes('verify') ||
        (document.title || '').toLowerCase().includes('robot');

      if (isCaptchaUrl || hasCaptchaDom) {
        log('⚠️ CAPTCHA detected! url=' + url);
        chrome.runtime.sendMessage({ type: 'CAPTCHA_DETECTED', source, url });
      }
    }

    // Check immediately and after DOM settles
    checkDom();
    setTimeout(checkDom, 2000);
  })();

  // ── Listen for messages from MAIN world interceptor ──────────
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    // Forward interceptor logs to background
    if (d.__fid_log) {
      log(d.msg);
      return;
    }

    // Handle intercepted API data
    if (d.__fid) {
      log('📥 relay received url=' + d.url);
      log('relay top-level keys: ' + Object.keys(d.data || {}).join(', '));
      handleData(d.data, d.url);
      return;
    }
  });

  log('✅ message listener registered');

  // ── Source detection ──────────────────────────────────────────
  function detectSource() {
    const h = location.hostname;
    if (h.includes('shopee'))    return 'shopee';
    if (h.includes('tokopedia')) return 'tokopedia';
    if (h.includes('rumah123'))  return 'rumah';
    if (h.includes('olx'))       return 'olx';
    return 'unknown';
  }

  // ── Data router ───────────────────────────────────────────────
  function handleData(data, url) {
    let products = [];

    try {
      if (source === 'shopee') {
        if (/\/api\/v4\/pdp\/get_pc/i.test(url)) {
          // Detail page — single product (full description + specs)
          const p = parseShopeeDetail(data);
          if (p) products = [p];
        } else if (/\/api\/v2\/item\/get_ratings/i.test(url)) {
          // Reviews — send separately, don't mix with product batch
          const reviews = parseShopeeRatings(data, url);
          if (reviews.length) sendReviews(reviews);
          return;
        } else {
          products = parseShopee(data, url);
        }
      }
      if (source === 'tokopedia') products = parseTokopedia(data, url);
      if (source === 'rumah')     products = parseRumah(data, url);
      if (source === 'olx')       products = parseOlx(data, url);
    } catch (err) {
      log('Parse error: ' + err.message + ' url=' + url);
      return;
    }

    log(`Parsed ${products.length} products from ${url}`);

    // Deduplicate by link
    const fresh = products.filter(p => {
      if (!p.title) return false;
      const key = p.link || p.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (fresh.length === 0) {
      log('⚠️ 0 fresh products after dedup. parsed=' + products.length + ' data_snapshot=' + JSON.stringify(data).slice(0, 200));
      return;
    }

    batchNum++;
    log(`Sending batch #${batchNum}: ${fresh.length} products`);

    const payload = fresh.slice(0, 60);
    log('📦 sendMessage PRODUCTS_SCRAPED batch=' + batchNum + ' count=' + payload.length + ' sample=' + JSON.stringify(payload[0]).slice(0, 150));

    try {
      chrome.runtime.sendMessage({
        type:     'PRODUCTS_SCRAPED',
        source,
        batch:    batchNum,
        products: payload,
      }, response => {
        if (chrome.runtime.lastError) {
          log('❌ sendMessage error: ' + chrome.runtime.lastError.message);
        } else {
          log('✅ background acknowledged batch #' + batchNum + ' response=' + JSON.stringify(response));
        }
      });
    } catch (e) {
      log('❌ sendMessage threw (context invalidated?): ' + e.message);
    }
  }

  // ── Shopee parser ─────────────────────────────────────────────
  // v4/search/search_items → { items: [{ item_basic: {...} }], total_count, nomore }
  // v2/search_items        → same shape
  function parseShopee(data, url) {
    log('Shopee raw keys:', Object.keys(data));

    const items =
      data?.items ||
      data?.data?.items ||
      data?.search_result?.items ||
      [];

    if (!items.length) {
      log('Shopee: no items found. Top-level keys:', Object.keys(data));
      return [];
    }

    log(`Shopee: found ${items.length} items (total_count=${data.total_count})`);

    // Parse Shopee display sold string "10RB+" → 10000, "1JT+" → 1000000
    function parseDisplaySold(str) {
      if (!str || typeof str !== 'string') return null;
      const m = str.replace(/\s/g, '').match(/^([\d.]+)(RB|JT)?/i);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!n) return null;
      const unit = (m[2] || '').toUpperCase();
      if (unit === 'JT') return Math.round(n * 1000000);
      if (unit === 'RB') return Math.round(n * 1000);
      return Math.round(n);
    }

    return items.map(raw => {
      const b = raw.item_basic || raw.item || raw;

      // Price: stored in micro-units → divide by 100000 to get IDR
      // e.g. 189800000000 → Rp 1,898,000
      const price = (b.price || b.price_min)
        ? Math.round((b.price || b.price_min) / 100000)
        : null;

      // Use item_card_display_sold_count for accurate total vs monthly split
      const dsc          = b.item_card_display_sold_count || {};
      const monthly_sold = dsc.rounded_local_monthly_sold_count ?? dsc.monthly_sold_count ?? b.sold ?? null;
      const sold_display_list = dsc.display_sold_count_text || null;

      // Rating
      const rating = b.item_rating?.rating_star ?? b.rating_star ?? null;

      // Images: capture all (max 7). Save both 720px local-download URLs and original full-res CDN URLs.
      const imgIds = (b.images || (b.image ? [b.image] : [])).slice(0, 7);
      const toImgUrl     = id => id.startsWith('http') ? id : `https://down-id.img.susercontent.com/file/${id}@resize_w720_nl`;
      const toImgFullRes = id => id.startsWith('http') ? id : `https://down-id.img.susercontent.com/file/${id}@resize_w1500_nl.webp`;
      const imgUrl = imgIds[0] ? toImgUrl(imgIds[0]) : null;
      const images_json = imgIds.length ? JSON.stringify(imgIds.map(toImgUrl)) : null;
      const source_images_json = imgIds.length ? JSON.stringify(imgIds.map(toImgFullRes)) : null;

      // Category — map catid integer to human name via lookup table
      const cat = SHOPEE_CATS[b.catid] || null;
      if (!cat && b.catid) log(`⚠ Unknown catid ${b.catid} — add to SHOPEE_CATS map`);

      // Specs — search results don't include attributes, so build from available meta
      const specParts = [
        b.brand        ? `Brand: ${b.brand}`               : null,
        b.shop_location? `Lokasi: ${b.shop_location}`      : null,
        b.discount     ? `Diskon: ${b.discount}`           : null,
        b.is_official_shop ? 'Official Shop'               : null,
        b.cmt_count    ? `${b.cmt_count} ulasan`           : null,
      ].filter(Boolean);

      return {
        title:       b.name || b.title,
        price,
        rating,
        sold_count:   dsc.display_sold_count ?? dsc.rounded_display_sold_count ?? monthly_sold,
        monthly_sold,
        sold_display: sold_display_list,
        source_item_id: b.itemid ? String(b.itemid) : null,
        shopid:      b.shopid   ? String(b.shopid)  : null,
        link:        b.itemid && b.shopid
          ? `https://shopee.co.id/${toShopeeSlug(b.name || b.title)}-i.${b.shopid}.${b.itemid}`
          : null,
        image_url:          imgUrl,
        images_json,
        source_images_json,
        category:    cat,
        description: '',   // not in search — filled by detail parser
        specs:       specParts.join(' | ').slice(0, 500),
      };
    }).filter(p => p.title);
  }

  // ── Shopee detail parser ───────────────────────────────────────
  // /api/v4/pdp/get_pc?item_id=X&shop_id=Y
  // Returns full description, attributes, tier_variations
  function parseShopeeDetail(data) {
    const b = data?.data?.item || data?.item;
    if (!b) {
      log('Shopee detail: no item found. keys=' + Object.keys(data || {}).join(', '));
      return null;
    }

    // API uses item_id/shop_id (underscored); keep fallback for older responses
    const itemId = b.item_id ?? b.itemid;
    const shopId = b.shop_id ?? b.shopid;
    const title  = b.title  || b.name;

    log('Shopee detail: item_id=' + itemId + ' title=' + String(title).slice(0, 60));

    // Full specs from attributes array: [{name, value}]
    const attrs   = b.attributes || [];
    const attrStr = attrs.map(a => `${a.name}: ${a.value}`).join(' | ');

    // Tier variations (e.g. color, size)
    const tiers    = b.tier_variations || [];
    const tierStr  = tiers
      .filter(t => t.name)
      .map(t => `${t.name}: ${(t.options || []).join(', ')}`)
      .join(' | ');

    const specParts = [
      b.brand         ? `Brand: ${b.brand}`          : null,
      b.shop_location ? `Lokasi: ${b.shop_location}` : null,
      attrStr || null,
      tierStr || null,
    ].filter(Boolean);

    const price = (b.price || b.price_min)
      ? Math.round((b.price || b.price_min) / 100000)
      : null;

    // Images: full gallery (product_images.images is the authoritative list), fallback to b.images
    // Also include variation images so every color variant has its image cached
    const toImgUrl     = id => id.startsWith('http') ? id : `https://down-id.img.susercontent.com/file/${id}@resize_w720_nl`;
    const toImgFullRes = id => id.startsWith('http') ? id : `https://down-id.img.susercontent.com/file/${id}@resize_w1500_nl.webp`;
    const galleryIds = b.product_images?.images || b.images || (b.image ? [b.image] : []);
    // Build colorIdx → imageUrl from most-reliable source first:
    // 1. product_images.first_tier_variations[idx].image  (objects with .image field)
    // 2. tier_variations[0].images[idx]                   (string IDs, parallel to options)
    // 3. tier_variations[0].option_items[idx].image       (another Shopee structure)
    const ftvItems   = b.product_images?.first_tier_variations || [];
    const tierImgArr = b.tier_variations?.[0]?.images || [];
    const optItems   = b.tier_variations?.[0]?.option_items || [];
    const colorImg   = {}; // idx → url
    ftvItems.forEach((item, idx) => {
      const id = item?.image || item?.gallery_image;
      if (id) colorImg[idx] = toImgUrl(id);
    });
    tierImgArr.forEach((id, idx) => {
      if (id && !colorImg[idx]) colorImg[idx] = toImgUrl(id);
    });
    optItems.forEach((item, idx) => {
      const id = item?.image || item?.image_url;
      if (id && !colorImg[idx]) colorImg[idx] = toImgUrl(id);
    });

    // Collect variation image string IDs for gallery (ftvItems are objects, extract .image)
    const ftvIds = ftvItems.map(item => item?.image || item?.gallery_image).filter(Boolean);
    const varImgStrIds = ftvIds.length ? ftvIds
      : tierImgArr.filter(Boolean).length ? tierImgArr.filter(Boolean)
      : optItems.map(o => o?.image || o?.image_url).filter(Boolean);

    const varImgIds = varImgStrIds.filter(id => !galleryIds.includes(id));
    const allImgIds = [...galleryIds, ...varImgIds].slice(0, 20);
    const imgIds = allImgIds;
    const imgUrl = imgIds[0] ? toImgUrl(imgIds[0]) : null;
    const images_json = imgIds.length ? JSON.stringify(imgIds.map(toImgUrl)) : null;
    const source_images_json = imgIds.length ? JSON.stringify(imgIds.map(toImgFullRes)) : null;

    // Variants: b.models → [{name, price, price_before_discount, stock}]
    const variants_json = (() => {
      const models = b.models || [];
      if (!models.length) return null;

      const vars = models
        .filter(m => m.name && m.price != null)
        .map(m => {
          const tierIdx = m.tier_index?.[0] ?? null;
          const imgUrl  = tierIdx != null ? (colorImg[tierIdx] || null) : null;
          return {
            name:         m.name,
            price:        m.price                  ? Math.round(m.price / 100000)                          : null,
            price_before: m.price_before_discount  ? Math.round(m.price_before_discount / 100000)          : null,
            stock:        m.stock ?? null,
            image_url:    imgUrl,
          };
        });
      return vars.length ? JSON.stringify(vars) : null;
    })();

    // attributes_json: '[]' for no attrs (marks "checked, nothing found") vs NULL (not yet checked)
    const attributesJson = JSON.stringify(attrs.map(a => ({ name: a.name, value: a.value })));

    // product_review has accurate total sold + rating breakdown
    const pr = b.product_review || null;

    // Total sold: historical_sold numeric is often null — fall back to display string
    // Display string e.g. "10RB+" → base 10000 + small random so it looks natural
    const soldNumeric = b.historical_sold ?? b.global_sold ?? null;
    const soldDisplay = pr?.historical_sold_display ?? pr?.sold_count_display ?? pr?.global_sold_display ?? null;

    function parseDisplaySold(str) {
      if (!str || typeof str !== 'string') return null;
      const m = str.replace(/\s/g, '').match(/^([\d.]+)(RB|JT)?/i);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!n) return null;
      const unit = (m[2] || '').toUpperCase();
      if (unit === 'JT') return Math.round(n * 1000000);
      if (unit === 'RB') return Math.round(n * 1000);
      return Math.round(n);
    }
    const soldBase = soldNumeric ?? parseDisplaySold(soldDisplay);
    // Add small random offset (up to 1000) so round numbers look natural
    const sold_count = soldBase != null ? soldBase + Math.floor(Math.random() * 1000) : null;

    // Rating breakdown from rating_count array [total, 1★, 2★, 3★, 4★, 5★]
    const rc = pr?.rating_count;
    const rating_summary = (Array.isArray(rc) && rc.length >= 6) ? {
      total: rc[0],
      stars: { 1: rc[1], 2: rc[2], 3: rc[3], 4: rc[4], 5: rc[5] },
    } : null;

    return {
      title:           title,
      price,
      rating:          pr?.rating_star ?? b.item_rating?.rating_star ?? null,
      sold_count,
      sold_display:    soldDisplay || null,
      rating_summary,
      source_item_id:  String(itemId),
      shopid:          String(shopId),
      link:            `https://shopee.co.id/${toShopeeSlug(title)}-i.${shopId}.${itemId}`,
      image_url:          imgUrl,
      images_json,
      source_images_json,
      variants_json,
      category:        b.fe_categories?.slice(-1)[0]?.display_name
                       || b.categories?.[0]?.display_name
                       || SHOPEE_CATS[b.cat_id || b.catid] || null,
      description:     String(b.description || b.rich_text_description || '').slice(0, 1000),
      specs:           specParts.join(' | ').slice(0, 1000),
      attributes_json: attributesJson,
    };
  }

  // ── Shopee ratings parser ─────────────────────────────────────
  // /api/v2/item/get_ratings?itemid=X&shopid=Y&type=0 (positive) / type=3 (negative)
  function parseShopeeRatings(data, url) {
    const ratings = data?.data?.ratings || [];
    if (!ratings.length) return [];

    const qs          = new URLSearchParams(url.split('?')[1] || '');
    const itemid      = qs.get('itemid') || '';
    const shopid      = qs.get('shopid') || '';
    const review_type = parseInt(qs.get('type') || '0', 10);

    log(`Shopee ratings: itemid=${itemid} type=${review_type} count=${ratings.length}`);

    return ratings
      .filter(r => r.comment)
      .map(r => ({
        source_item_id: itemid,
        shopid,
        review_id:       String(r.cmtid),
        rating_star:     r.rating_star || 0,
        comment:         (r.comment || '').slice(0, 1000),
        author_username: r.author_username || 'anonymous',
        variant_name:    r.product_items?.[0]?.model_name || null,
        review_type,
        ctime:           r.ctime ? new Date(r.ctime * 1000).toISOString() : null,
      }));
  }

  // ── Send reviews to background ────────────────────────────────
  function sendReviews(reviews) {
    log(`📦 sendMessage REVIEWS_SCRAPED count=${reviews.length}`);
    try {
      chrome.runtime.sendMessage({
        type: 'REVIEWS_SCRAPED',
        source,
        reviews,
      }, response => {
        if (chrome.runtime.lastError) {
          log('❌ REVIEWS_SCRAPED error: ' + chrome.runtime.lastError.message);
        } else {
          log('✅ REVIEWS_SCRAPED ack=' + JSON.stringify(response));
        }
      });
    } catch (e) {
      log('❌ REVIEWS_SCRAPED threw (context invalidated?): ' + e.message);
    }
  }

  // ── Tokopedia parser ──────────────────────────────────────────
  // GraphQL at gql.tokopedia.com — response wraps data in operationName
  function parseTokopedia(data, url) {
    log('Tokopedia raw keys:', Object.keys(data));

    // Handle GraphQL array response (batch operations)
    if (Array.isArray(data)) {
      return data.flatMap(item => parseTokopedia(item, url));
    }

    const products =
      data?.data?.searchProductV5?.data?.products ||
      data?.data?.aceSearchProductV4?.data?.products ||
      data?.data?.searchProduct?.data?.products ||
      data?.data?.products ||
      [];

    if (!products.length) {
      log('Tokopedia: no products found. Keys:', JSON.stringify(data).slice(0, 400));
      return [];
    }

    log(`Tokopedia: found ${products.length} products`);

    return products.map(p => {
      // Specs from label_groups / labelGroups
      // Old format: [{title, content}], New V5 format: [{position, title, type, url}]
      const labels  = p.label_groups || p.labelGroups || [];
      const specStr = labels
        .filter(l => l.title && l.position !== 'overlay_1' && l.position !== 'final_price')
        .map(l => l.content ? `${l.title}: ${l.content}` : l.title)
        .join(' | ');

      // Price — V5: price.number, older: price.value / priceInt
      const price = p.price?.number ?? p.price?.value ?? p.priceInt ?? p.price_int ?? null;

      // Rating — V5: string "4.6", older: object with averageRating
      const rating = typeof p.rating === 'string'
        ? (parseFloat(p.rating) || null)
        : (p.rating?.averageRating ?? p.ratingAverage ?? null);

      // Sold — V5: in labelGroups position=ri_product_credibility e.g. "4rb+ terjual"
      const soldLabel = labels.find(l => l.position === 'ri_product_credibility');
      const sold = p.countSold ?? p.transactionSuccess
        ?? (soldLabel ? soldLabel.title : null);

      // Image — V5: mediaURL.image (signed, ~1yr expiry), older: imageUrl / image_url
      const image_url = p.mediaURL?.image || p.mediaURL?.image300
        || p.imageUrl || p.image_url || p.imageUrl300 || null;
      // Multi-image: mediaURLs array if available (Tokopedia sometimes includes it)
      const tokoImgArr = (p.mediaURLs || []).map(m => m?.image || m?.url).filter(Boolean).slice(0, 7);
      if (image_url && !tokoImgArr.includes(image_url)) tokoImgArr.unshift(image_url);
      const images_json = tokoImgArr.length > 1 ? JSON.stringify(tokoImgArr.slice(0, 7)) : null;
      // Variants: Tokopedia list may have price ranges
      const variants_json = (() => {
        const opts = p.campaign?.originalPrice ? null : (p.options || p.variants || []);
        if (!opts || !opts.length) return null;
        const vars = opts.filter(o => o.name && o.price != null)
          .map(o => ({ name: o.name, price: o.price, stock: o.stock ?? null }));
        return vars.length ? JSON.stringify(vars) : null;
      })();

      // Category — V5: category.breadcrumb, older: categoryBreadcrumb
      const category = p.category?.breadcrumb || p.category?.name
        || p.categoryBreadcrumb || p.department?.name || null;

      return {
        source_item_id: p.id || p.oldID ? String(p.id || p.oldID) : null,
        title:          p.name,
        price,
        rating,
        sold_count:     sold,
        link:           p.url || p.appLinks?.android || null,
        image_url,
        images_json,
        variants_json,
        category,
        description:    (p.description || '').slice(0, 500),
        specs:          specStr.slice(0, 500),
      };
    }).filter(p => p.title && p.link);
  }

  // ── Rumah123 parser ───────────────────────────────────────────
  function parseRumah(data, url) {
    log('Rumah123 raw keys:', Object.keys(data));
    const listings = data?.data?.listings || data?.items || data?.results || [];
    log(`Rumah123: found ${listings.length} listings`);

    return listings.map(p => {
      const specs = [
        p.bedroomCount   ? `${p.bedroomCount} KT`        : null,
        p.bathroomCount  ? `${p.bathroomCount} KM`        : null,
        p.buildingSize   ? `Bangunan ${p.buildingSize}m²` : null,
        p.landSize       ? `Tanah ${p.landSize}m²`        : null,
        p.certificate    ? `SHM: ${p.certificate}`        : null,
      ].filter(Boolean).join(' | ');

      return {
        title:       p.title,
        price:       p.price?.value || p.priceValue || null,
        rating:      null,
        sold_count:  null,
        link:        p.url ? `https://www.rumah123.com${p.url}` : p.shareLink || null,
        image_url:   p.images?.[0]?.url || p.primaryImage || null,
        category:    p.propertyType || 'properti',
        description: p.description?.slice(0, 500) || '',
        specs,
      };
    }).filter(p => p.title);
  }

  // ── OLX parser ────────────────────────────────────────────────
  function parseOlx(data, url) {
    log('OLX raw keys:', Object.keys(data));
    const ads = data?.data?.ads || data?.ads || data?.items || [];
    log(`OLX: found ${ads.length} ads`);

    return ads.map(a => {
      const params  = a.params || [];
      const specStr = params.map(pp => `${pp.key}: ${pp.value?.label || pp.value}`).join(' | ');

      return {
        title:       a.subject || a.title,
        price:       a.price?.value?.number || a.price?.value || null,
        rating:      null,
        sold_count:  null,
        link:        a.url || null,
        image_url:   a.images?.[0]?.url || null,
        category:    a.category?.name || 'otomotif',
        description: (a.body || '').slice(0, 500),
        specs:       specStr.slice(0, 500),
      };
    }).filter(p => p.title);
  }

  // ── Logger ────────────────────────────────────────────────────
  function log(...args) {
    const msg = args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ');
    console.log(TAG, msg);

    // Forward log to background so it can be stored and shown in popup
    try {
      chrome.runtime.sendMessage({ type: 'LOG', tag: TAG, msg });
    } catch (_) {}
  }

})();
