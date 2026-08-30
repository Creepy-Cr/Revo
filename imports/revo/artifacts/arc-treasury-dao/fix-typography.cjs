const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // 1. Text size bump:
  content = content.replace(/text-\[8px\]/g, 'text-[11px]');
  content = content.replace(/text-\[9px\]/g, 'text-[11px]');
  content = content.replace(/text-\[10px\]/g, 'text-[11px]');
  content = content.replace(/text-\[13px\]/g, 'text-sm');

  // 2. Weights:
  content = content.replace(/font-bold/g, 'font-semibold');
  content = content.replace(/font-extrabold/g, 'font-semibold');
  content = content.replace(/font-black/g, 'font-semibold');

  // 3. Tracking for small uppercase labels
  // We want to replace tracking-widest with tracking-[0.14em] where it's uppercase.
  // Actually, replacing all text-[11px] font-mono tracking-widest uppercase ...
  content = content.replace(/tracking-widest/g, 'tracking-[0.14em]');
  content = content.replace(/tracking-wider/g, 'tracking-[0.1em]'); // Optional: boost wider a bit

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${filePath}`);
  }
}

function walk(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      processFile(fullPath);
    }
  }
}

walk(dir);
