'use strict';
// Loads every engine file listed in src/manifest.json (skipping ones not yet written) and
// returns globalThis.BudgetEngine. Tests call this instead of requiring files one by one.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

function loadEngine({ only } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  for (const rel of manifest.engine) {
    // A whole file name: 'core.js' is engine/core.js, not engine/timeline-core.js.
    if (only && !only.some(name => rel === name || rel.endsWith('/' + name))) continue;
    const file = path.join(SRC, rel);
    if (fs.existsSync(file)) require(file);
  }
  return globalThis.BudgetEngine;
}

module.exports = { loadEngine, SRC };
