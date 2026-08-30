const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // Remove p-6 if it follows console-card
  content = content.replace(/console-card p-6/g, 'console-card');
  content = content.replace(/console-card p-4 md:px-6/g, 'console-card p-4 md:p-6'); // Actually if they want p-4 on mobile, p-6 on md.
  
  // Make sure body copy line-height is 1.6-1.7 (leading-relaxed)
  // Let's add leading-relaxed to any text-sm or text-base without leading-
  content = content.replace(/className="([^"]*text-sm(?!.*leading-)[^"]*)"/g, 'className="$1 leading-relaxed"');
  content = content.replace(/className="([^"]*text-\[14px\](?!.*leading-)[^"]*)"/g, 'className="$1 leading-relaxed"');
  content = content.replace(/className="([^"]*text-base(?!.*leading-)[^"]*)"/g, 'className="$1 leading-relaxed"');
  
  // Tabular nums for mono:
  content = content.replace(/className="([^"]*font-mono(?!.*tabular-nums)[^"]*)"/g, 'className="$1 tabular-nums"');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated padding/leading/tabular in ${filePath}`);
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
