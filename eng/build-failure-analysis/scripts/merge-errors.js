// Merges errors from a new binlog extraction into the combined errors file.
// Reads from files instead of shell arguments to avoid ARG_MAX limits.
//
// Usage: node merge-errors.js <combined-errors.json> <new-binlog.json> <output.json>

const fs = require('fs');

const combinedPath = process.argv[2];
const newBinlogPath = process.argv[3];
const outputPath = process.argv[4];

if (!combinedPath || !newBinlogPath || !outputPath) {
  console.error('Usage: node merge-errors.js <combined.json> <new-binlog.json> <output.json>');
  process.exit(1);
}

const combined = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));
const newData = JSON.parse(fs.readFileSync(newBinlogPath, 'utf8'));

let newErrors = [];
try {
  newErrors = JSON.parse(newData.errors || '[]');
} catch {
  // errors field might be a plain string from MCP
  if (typeof newData.errors === 'string' && newData.errors.length > 0) {
    newErrors = [{ severity: 'error', message: newData.errors }];
  }
}

const merged = [...combined, ...newErrors];

// Deduplicate by code+message+file+line
const seen = new Set();
const unique = merged.filter(e => {
  const key = [e.code || '', e.message || '', e.file || '', e.line || ''].join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

fs.writeFileSync(outputPath, JSON.stringify(unique, null, 2));
console.log(`Merged: ${combined.length} existing + ${newErrors.length} new = ${unique.length} unique errors`);
