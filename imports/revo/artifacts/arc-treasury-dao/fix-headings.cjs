const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // For text-lg, text-xl, text-2xl, text-3xl, text-4xl, text-5xl, text-6xl, text-7xl
  // Ensure they have tracking-tight or tighter, and leading-none or leading-tight
  content = content.replace(/className="([^"]*(?:text-[2-7]xl|text-xl)(?!.*tracking-)[^"]*)"/g, 'className="$1 tracking-tight"');
  content = content.replace(/className="([^"]*(?:text-[2-7]xl|text-xl)(?!.*leading-)[^"]*)"/g, 'className="$1 leading-tight"');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated headings in ${filePath}`);
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
