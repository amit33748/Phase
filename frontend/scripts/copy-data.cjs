const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
const dataWeb = path.join(projectRoot, 'data/web');
const targetApiWeb = path.resolve(__dirname, '../public/api/web');
const targetApi = path.resolve(__dirname, '../public/api');

fs.mkdirSync(targetApiWeb, { recursive: true });

// Generate combined meta.json
const metaPath = path.join(dataWeb, 'meta.json');
const refPath = path.join(dataWeb, 'ref_candidates.json');

if (fs.existsSync(metaPath) && fs.existsSync(refPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  const combined = { ...meta, refCandidates: ref };
  fs.writeFileSync(path.join(targetApi, 'meta.json'), JSON.stringify(combined), 'utf8');
  console.log('[build-data] Generated public/api/meta.json');
}

const files = [
  'base.arrow',
  'hex_r6.arrow',
  'hex_r7.arrow',
  'hex_r8.arrow',
  'ref_candidates.json',
  'meta.json'
];

for (const file of files) {
  const src = path.join(dataWeb, file);
  const dest = path.join(targetApiWeb, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[build-data] Copied ${file} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(2)} MB)`);
  }
}
