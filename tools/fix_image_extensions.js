'use strict';
process.chdir('/data/www/findingid/backend');
require('/data/www/findingid/backend/node_modules/dotenv').config({ path: '.env' });

const db   = require('/data/www/findingid/backend/services/db');
const fs   = require('fs');
const path = require('path');

const DIR = '/data/www/findingid/uploads/products';

function detectExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';  // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';  // JPEG
  if (buf.slice(0,4).toString() === 'RIFF' && buf.slice(8,12).toString() === 'WEBP') return '.webp';
  return null;
}

async function run() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg'));
  console.log(`Checking ${files.length} .jpg files...`);

  let renamed = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const id = parseInt(file.replace('.jpg', ''), 10);
    if (!id) continue;

    const filePath = path.join(DIR, file);
    const buf = fs.readFileSync(filePath).slice(0, 12);
    const realExt = detectExt(buf);

    if (!realExt || realExt === '.jpg') { skipped++; continue; }

    const newFile = `${id}${realExt}`;
    const newPath = path.join(DIR, newFile);

    try {
      fs.renameSync(filePath, newPath);
      await db.query('UPDATE products SET image_url = ? WHERE id = ?',
        [`/uploads/products/${newFile}`, id]);
      renamed++;
      if (renamed % 200 === 0) console.log(`  renamed ${renamed}...`);
    } catch (e) { errors++; }
  }

  console.log(`Done: renamed=${renamed}  already-correct=${skipped}  errors=${errors}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
