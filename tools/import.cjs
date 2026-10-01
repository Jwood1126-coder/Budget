#!/usr/bin/env node
'use strict';
/*
 * Import bank and card CSV exports into the normalized dataset (docs/ARCHITECTURE.md §2, §8).
 *
 *   node tools/import.cjs                         private/import.json -> private/budget-data.json
 *                                                 + private/import-report.json + private/import-report.md
 *   node tools/import.cjs --period 2026-07-01..2026-09-30
 *                                                 also print a breakdown of that period (reconciliation)
 *   node tools/import.cjs --sample                rebuild fixtures/sample-data.json from the synthetic CSVs
 *
 * Options: --config <file>  --out <file>  --report <file>  --period A..B  --sample  --help
 * Paths are relative to the repository root. Outputs contain private financial data: they belong
 * in the git-ignored private/ folder. Writing inside fixtures/ is refused unless --sample is given.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENGINE_FILES = ['src/engine/core.js', 'src/engine/categories.js', 'src/engine/importer.js'];

/** Load only the engine files the importer needs (other modules may be mid-development). */
function loadImporterEngine() {
  for (const rel of ENGINE_FILES) require(path.join(REPO_ROOT, rel));
  return globalThis.BudgetEngine;
}

// ------------------------------------------------------------------ formatting helpers

/**
 * JSON with two-space indentation, but each object inside an array on one line
 * (one transaction per line keeps the dataset compact and diff-friendly).
 */
function formatJSON(value) {
  return fmt(value, '') + '\n';
}
function fmt(v, ind) {
  const inner = ind + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(x => x !== null && typeof x === 'object' && !Array.isArray(x))) {
      return '[\n' + v.map(x => inner + JSON.stringify(x)).join(',\n') + '\n' + ind + ']';
    }
    const flat = JSON.stringify(v);
    if (v.every(x => x === null || typeof x !== 'object') && flat.length <= 100) return flat;
    return '[\n' + v.map(x => inner + fmt(x, inner)).join(',\n') + '\n' + ind + ']';
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (!keys.length) return '{}';
    return '{\n' + keys.map(k => inner + JSON.stringify(k) + ': ' + fmt(v[k], inner)).join(',\n') + '\n' + ind + '}';
  }
  return JSON.stringify(v);
}

function localToday() {
  const d = new Date(); // the CLI (not the engine) may read the clock: it stamps generatedAt
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ------------------------------------------------------------------ import from a config

/**
 * Build { dataset, report } from an import config.
 * @param {object} config  { datasetId, isSynthetic, generatedAt?, accounts, files: [{ path, accountId, mapping?, coverageStart?, coverageEnd? }],
 *                           rules?: string|object, coverageOverrides?, references?, notes? }
 * @param {{readText: (relPath: string) => string, today?: string}} io
 */
function runImportFromConfig(config, { readText, today } = {}) {
  const E = loadImporterEngine();
  if (!config || typeof config !== 'object') throw new E.ValidationError('The import config must be a JSON object.');
  if (!Array.isArray(config.files) || !config.files.length) throw new E.ValidationError('The import config needs a "files" list.');
  const extraWarnings = [];
  let rules = {};
  if (typeof config.rules === 'string' && config.rules) {
    let text = null;
    try { text = readText(config.rules); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (text === null) extraWarnings.push('Rules file ' + config.rules + ' not found: only the generic default rules were used.');
    else {
      try { rules = JSON.parse(text); } catch (err) { throw new E.ValidationError('Rules file ' + config.rules + ' is not valid JSON: ' + err.message); }
    }
  } else if (config.rules && typeof config.rules === 'object') {
    rules = config.rules;
  }
  const baseNames = config.files.map(f => path.basename(String(f.path || '')));
  const files = config.files.map((f, i) => {
    if (!f || typeof f.path !== 'string' || !f.path) throw new E.ValidationError('File #' + (i + 1) + ' in the config needs a "path".');
    let text;
    try { text = readText(f.path); } catch (err) {
      if (err.code === 'ENOENT') throw new E.ValidationError('Export file not found: ' + f.path);
      throw err;
    }
    // The base name is enough to trace a row and keeps folder names out of the dataset.
    const name = baseNames.filter(n => n === baseNames[i]).length > 1 ? f.path : baseNames[i];
    return { name, text, accountId: f.accountId, mapping: f.mapping || undefined, coverageStart: f.coverageStart || undefined, coverageEnd: f.coverageEnd || undefined };
  });
  const result = E.importer.buildDataset({
    files,
    accounts: config.accounts,
    rules,
    datasetId: config.datasetId,
    isSynthetic: config.isSynthetic === true,
    generatedAt: config.generatedAt || today || localToday(),
    coverageOverrides: config.coverageOverrides,
    references: config.references,
    notes: config.notes
  });
  result.report.warnings.unshift(...extraWarnings);
  return result;
}

// ------------------------------------------------------------------ readable report

function renderMarkdown(report, dataset) {
  const E = loadImporterEngine();
  const $ = c => E.money.format(c);
  const label = new Map(dataset.accounts.map(a => [a.id, a.label]));
  const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const out = [];
  out.push('# Import report — ' + dataset.datasetId, '');
  out.push('Generated ' + report.generatedAt + '. ' + (dataset.isSynthetic ? 'Synthetic sample data.' :
    '**Private:** this report contains your household\'s financial data. Keep it in `private/`; never commit or share it.'), '');
  out.push(report.transactions + ' transactions from ' + (report.start || '—') + ' to ' + (report.end || '—') + '.', '');

  out.push('## Files', '', '| File | Account | Rows | Imported | Skipped | Duplicates removed | Dates in file | Coverage | Sign convention |', '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
  for (const f of report.files) {
    const skipped = f.skipped ? f.skipped + ' (' + Object.entries(f.skippedReasons).map(([k, n]) => k + ': ' + n).join(', ') + ')' : '0';
    out.push('| ' + [f.name, label.get(f.accountId), f.rows, f.imported, skipped, f.duplicatesRemoved, (f.start || '—') + ' – ' + (f.end || '—'),
      (f.coverageStart || '—') + ' – ' + (f.coverageEnd || '—'), f.signConvention].map(cell).join(' | ') + ' |');
  }
  out.push('', 'Rows = imported + skipped + duplicates removed.', '');

  out.push('## Coverage by account', '');
  for (const a of report.accounts) {
    out.push('- **' + a.label + '** (' + a.type + ', ' + a.transactions + ' transactions): ' +
      (a.coverage.length ? a.coverage.map(r => r.start + ' – ' + r.end).join('; ') : 'no coverage'));
  }
  out.push('');

  out.push('## Coverage and spending by month', '');
  out.push('Spending = purchases − refunds (raw import, before any review edits). Card payments are excluded: the card purchases are the spending.', '');
  const head = ['Month', ...report.accounts.map(a => cell(a.label)),'Spending coverage', 'Purchases', 'Refunds', 'Spending', 'Income', 'Debt payments', 'Card payments (excluded)'];
  out.push('| ' + head.join(' | ') + ' |', '| ' + head.map((h, i) => (i === 0 || i <= report.accounts.length + 1 ? '---' : '---:')).join(' | ') + ' |');
  for (const m of report.months) {
    const cells = report.accounts.map(a => (m.coverage[a.id] === m.days ? 'full' : m.coverage[a.id] ? m.coverage[a.id] + '/' + m.days + ' days' : '—'));
    out.push('| ' + [m.month, ...cells, m.spendingCoverage, $(m.purchasesCents), $(m.refundsCents), $(m.spendingCents), $(m.incomeCents), $(m.debtPaymentsCents), $(m.cardPaymentsCents)].join(' | ') + ' |');
  }
  out.push('');

  out.push('## Totals by kind', '', '| Kind | Count | Money in | Money out |', '| --- | ---: | ---: | ---: |');
  for (const [kind, t] of Object.entries(report.totalsByKind)) out.push('| ' + [kind, t.count, $(t.inflowCents), $(t.outflowCents)].join(' | ') + ' |');
  out.push('', 'Spending overall: purchases ' + $(report.spending.purchasesCents) + ', refunds ' + $(report.spending.refundsCents) + ', net ' + $(report.spending.netCents) + '.', '');

  out.push('## Needs review', '');
  const flags = Object.entries(report.flagCounts);
  if (!flags.length) out.push('Nothing flagged.');
  else { out.push('| Flag | Transactions |', '| --- | ---: |'); for (const [f, n] of flags) out.push('| ' + f + ' | ' + n + ' |'); }
  out.push('');

  out.push('## Duplicates removed (overlapping exports)', '');
  if (!report.duplicatesRemoved.length) out.push('None.');
  else {
    out.push(report.duplicatesRemoved.length + ' rows appeared in more than one export of the same account and were imported once.', '');
    out.push('| File | Row | Date | Amount | Description | Kept from |', '| --- | ---: | --- | ---: | --- | --- |');
    for (const d of report.duplicatesRemoved.slice(0, 200)) out.push('| ' + [d.file, d.row, d.date, $(d.amountCents), d.description, d.keptFile + ' row ' + d.keptRow].map(cell).join(' | ') + ' |');
    if (report.duplicatesRemoved.length > 200) out.push('', '… ' + (report.duplicatesRemoved.length - 200) + ' more in import-report.json.');
  }
  out.push('');

  out.push('## Skipped rows', '');
  if (!report.skippedRows.length) out.push('None.');
  else for (const s of report.skippedRows) out.push('- ' + s.file + ' row ' + s.row + ': ' + s.reason);
  out.push('');

  out.push('## Warnings', '');
  if (!report.warnings.length) out.push('None.');
  else for (const w of report.warnings) out.push('- ' + w);
  out.push('');
  return out.join('\n');
}

function printPeriod(dataset, period, log) {
  const E = loadImporterEngine();
  const $ = c => E.money.format(c);
  // Accept whole months too: 2026-07..2026-09 means 2026-07-01..2026-09-30.
  let [start, end] = String(period).split('..');
  if (E.months.isMonth(start)) start = E.months.start(start);
  if (E.months.isMonth(end)) end = E.months.end(end);
  const b = E.importer.periodBreakdown(dataset, start, end);
  const label = new Map(dataset.accounts.map(a => [a.id, a.label]));
  log('');
  log('Period ' + b.start + ' .. ' + b.end + ' (' + b.transactions + ' transactions, raw import before review edits)');
  log('  Spending: purchases ' + $(b.spending.purchasesCents) + ' − refunds ' + $(b.spending.refundsCents) + ' = ' + $(b.spending.netCents));
  log('  By account:');
  for (const r of b.byAccount) log('    ' + (label.get(r.accountId) || r.accountId).padEnd(28) + $(r.spendCents).padStart(14) + '  (' + r.count + ')');
  log('  By category:');
  for (const r of b.byCategory) log('    ' + r.category.padEnd(28) + $(r.spendCents).padStart(14) + '  (' + r.count + ')');
  log('  By kind (count, money in / money out):');
  for (const r of b.byKind) log('    ' + (r.kind + (r.subtype ? ' · ' + r.subtype : '')).padEnd(28) + String(r.count).padStart(5) + '  in ' + $(r.inflowCents) + ' / out ' + $(r.outflowCents));
  log('  Refunds: ' + b.refunds.count + ' totalling ' + $(b.refunds.cents) + ' (already subtracted from spending)');
  log('  Card payments excluded: ' + $(b.cardPaymentsExcluded.paidFromCashCents) + ' paid from cash accounts, ' + $(b.cardPaymentsExcluded.receivedOnCardsCents) + ' received on cards');
  log('  Transfers (not spending):');
  for (const r of b.transfers) log('    ' + r.subtype.padEnd(14) + ' in ' + $(r.inCents) + ' / out ' + $(r.outCents) + (r.unpaired ? '  (' + r.unpaired + ' unpaired)' : ''));
  log('  Debt payments (not category spending): ' + $(b.debtPayments.cents) + ' (' + b.debtPayments.count + ')');
  log('  Income: payroll ' + $(b.income.payrollCents) + ', interest ' + $(b.income.interestCents) + ', other ' + $(b.income.otherCents));
  const c = b.candidates;
  log('  Review candidates: reimbursement ' + c.reimbursement.count + ' rows (charges ' + $(c.reimbursement.chargesCents) + ', deposits ' + $(c.reimbursement.depositsCents) + '); ' +
    'business ' + c.business.count + ' (' + $(c.business.spendCents) + '); mixed retail ' + c.mixedRetail.count + ' (' + $(c.mixedRetail.spendCents) + '); ' +
    'needs category ' + c.needsReview.count + '; unpaired transfers ' + c.unpairedTransfers.count);
  log('  Coverage of the period:');
  for (const r of b.coverage) log('    ' + r.label.padEnd(28) + r.coveredDays + '/' + r.totalDays + ' days');
  return b;
}

// ------------------------------------------------------------------ setup help

const EXAMPLE_CONFIG = {
  _help: [
    'Copy this file to private/import.json and replace every placeholder. Paths are relative to the repository root.',
    'accounts[].type: checking | savings | credit_card | loan | other; scope: joint | personal; ownerId: p1 | p2 | null (personal accounts).',
    'files[].coverageStart / coverageEnd: the full date range you asked the bank to export (YYYY-MM-DD). Omit them to use the first and last row dates.',
    'files[].mapping is optional: add it only if the importer cannot recognise the column headers, e.g.',
    '{ "date": "Trans Date", "description": "Payee", "amount": "Amount", "dateFormat": "MDY", "chargesPositive": true }',
    'rules: optional private rules file (format: docs/ARCHITECTURE.md, "Rules format").'
  ],
  datasetId: 'household',
  isSynthetic: false,
  accounts: [
    { id: 'joint-checking', label: 'Joint checking', type: 'checking', scope: 'joint', ownerId: null, paidInFull: false },
    { id: 'joint-card', label: 'Joint credit card', type: 'credit_card', scope: 'joint', ownerId: null, paidInFull: true }
  ],
  files: [
    { path: 'private/raw/CHECKING-EXPORT.csv', accountId: 'joint-checking', coverageStart: 'YYYY-MM-DD', coverageEnd: 'YYYY-MM-DD' },
    { path: 'private/raw/CARD-EXPORT.csv', accountId: 'joint-card', coverageStart: 'YYYY-MM-DD', coverageEnd: 'YYYY-MM-DD' }
  ],
  rules: 'private/rules.json'
};

function setupHelp(configRel, exampleRel, wroteExample) {
  return [
    'No import config found at ' + configRel + '.',
    '',
    'Set up a private import (everything stays on this computer, in the git-ignored private/ folder):',
    '  1. Download CSV exports from each bank/card website (one or more files per account).',
    '     Choose the full date range you want and note it: that range is the file\'s coverage.',
    '  2. Put the files in private/raw/ (create the folder). Never put real exports anywhere else in this repository.',
    '  3. ' + (wroteExample ? 'An example config was written to ' + exampleRel + '. ' : 'See ' + exampleRel + ' for an example. ') +
      'Copy it to ' + configRel + ' and edit it:',
    '       - accounts: one entry per account (id, label, type, scope, ownerId, paidInFull)',
    '       - files: one entry per CSV with its accountId and coverageStart/coverageEnd',
    '  4. Optional: write private/rules.json with household rules (your utilities, employer, transfer hints).',
    '  5. Run again: node tools/import.cjs',
    '  6. Read private/import-report.md, then build the app: node tools/build.cjs',
    '',
    'If a file\'s columns are not recognised, the importer stops and asks for a "mapping" for that file.'
  ].join('\n');
}

// ------------------------------------------------------------------ CLI

const USAGE = [
  'Usage: node tools/import.cjs [options]',
  '',
  '  (no options)            private/import.json -> private/budget-data.json, private/import-report.json and .md',
  '  --config <file>         import config (default private/import.json)',
  '  --out <file>            dataset output (default private/budget-data.json)',
  '  --report <file>         JSON report (default private/import-report.json; a .md is written beside it)',
  '  --period A..B           also print a breakdown of YYYY-MM-DD..YYYY-MM-DD (or YYYY-MM..YYYY-MM) to reconcile',
  '                          against another total',
  '  --sample                rebuild the synthetic fixtures/sample-data.json (the only way to write into fixtures/)',
  '  --help                  show this help',
  '',
  'Paths are relative to the repository root. Outputs contain private financial data: keep them in private/.'
].join('\n');

function parseArgs(argv) {
  const args = { config: null, out: null, report: null, period: null, sample: false, help: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('Option ' + a + ' needs a value.');
      return v;
    };
    if (a === '--config') args.config = value();
    else if (a === '--out') args.out = value();
    else if (a === '--report') args.report = value();
    else if (a === '--period') args.period = value();
    else if (a === '--root') args.root = value(); // for tests: run against another folder
    else if (a === '--sample') args.sample = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unknown option ' + a + ' (try --help).');
  }
  return args;
}

const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function main(argv, { log = console.log, error = console.error } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (err) { error(err.message); return 2; }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : REPO_ROOT;
  const defaults = args.sample
    ? { config: 'fixtures/sample-import.json', out: 'fixtures/sample-data.json', report: 'fixtures/sample-import-report.json' }
    : { config: 'private/import.json', out: 'private/budget-data.json', report: 'private/import-report.json' };
  const resolve = p => path.resolve(root, p);
  const configPath = resolve(args.config || defaults.config);
  const outPath = resolve(args.out || defaults.out);
  const reportPath = resolve(args.report || defaults.report);
  const mdPath = args.sample ? null : reportPath.replace(/\.json$/i, '') + '.md';

  const fixturesDir = resolve('fixtures');
  if (!args.sample) {
    for (const p of [outPath, reportPath, mdPath]) {
      if (p && isInside(fixturesDir, p)) {
        error('Refusing to write ' + path.relative(root, p) + ': fixtures/ is committed to a public repository. Use --sample only for the synthetic sample.');
        return 2;
      }
    }
  }

  if (!fs.existsSync(configPath)) {
    const exampleRel = 'private/import.example.json';
    const examplePath = resolve(exampleRel);
    let wrote = false;
    if (!args.sample && !fs.existsSync(examplePath)) { // never overwrite an existing file
      fs.mkdirSync(path.dirname(examplePath), { recursive: true });
      fs.writeFileSync(examplePath, formatJSON(EXAMPLE_CONFIG), { flag: 'wx' });
      wrote = true;
    }
    error(setupHelp(path.relative(root, configPath), exampleRel, wrote));
    return 1;
  }

  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) {
    error('Could not read ' + path.relative(root, configPath) + ': ' + err.message);
    return 1;
  }
  if (args.sample && config.isSynthetic !== true) {
    error('Refusing --sample: ' + path.relative(root, configPath) + ' is not marked "isSynthetic": true. Real data must never go into fixtures/.');
    return 2;
  }
  if (args.sample) {
    // The flag alone is not proof: a mislabelled private config would copy real exports into the
    // public fixtures/. The synthetic sample is built only from inputs that already live there.
    const inputs = [path.relative(root, configPath)];
    for (const f of Array.isArray(config.files) ? config.files : []) if (f && typeof f.path === 'string') inputs.push(f.path);
    if (typeof config.rules === 'string' && config.rules) inputs.push(config.rules);
    const outside = inputs.filter(p => !isInside(fixturesDir, resolve(p)));
    if (outside.length) {
      error('Refusing --sample: these inputs are not inside fixtures/: ' + outside.join(', ') + '. The synthetic sample is built only from files in fixtures/.');
      return 2;
    }
  }

  let result;
  try {
    result = runImportFromConfig(config, { readText: p => fs.readFileSync(resolve(p), 'utf8') });
  } catch (err) {
    if (!(err && err.name === 'ValidationError')) throw err;
    error('Import failed: ' + err.message);
    if (err.code === 'UNRECOGNISED_HEADER') {
      error('First row of that file: ' + JSON.stringify(err.header));
      error('Add to that file\'s entry in the config, using its own column names, e.g.:');
      error('  "mapping": { "date": "<date column>", "description": "<description column>", "amount": "<amount column>", "dateFormat": "MDY" }');
      error('  (or "debit"/"credit" instead of "amount"; add "chargesPositive": true for card exports that list purchases as positive numbers)');
    }
    return 1;
  }
  const { dataset, report } = result;

  for (const p of [outPath, reportPath, mdPath]) if (p) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(outPath, formatJSON(dataset));
  fs.writeFileSync(reportPath, formatJSON(report));
  if (mdPath) fs.writeFileSync(mdPath, renderMarkdown(report, dataset));

  const E = loadImporterEngine();
  log('Imported ' + report.transactions + ' transactions (' + (report.start || '—') + ' to ' + (report.end || '—') + ') from ' + report.files.length + ' files.');
  for (const f of report.files) log('  ' + f.name + ': ' + f.rows + ' rows, ' + f.imported + ' imported, ' + f.skipped + ' skipped, ' + f.duplicatesRemoved + ' duplicates removed');
  log('Spending (purchases − refunds): ' + E.money.format(report.spending.netCents) + '. Flags: ' +
    (Object.entries(report.flagCounts).map(([k, n]) => k + ' ' + n).join(', ') || 'none') + '.');
  for (const w of report.warnings) log('Warning: ' + w);
  log('Wrote ' + [outPath, reportPath, mdPath].filter(Boolean).map(p => path.relative(root, p)).join(', '));
  if (!args.sample) {
    log('');
    log('PRIVATE: these outputs contain your household\'s financial data. Keep them in private/ (ignored by git); never commit, upload or share them.');
    if (![outPath, reportPath].every(p => isInside(resolve('private'), p))) log('WARNING: some outputs are outside private/ and are NOT protected by .gitignore.');
  }
  if (args.period) {
    try { printPeriod(dataset, args.period, log); } catch (err) {
      if (!(err && err.name === 'ValidationError')) throw err;
      error('--period: ' + err.message + ' Use --period YYYY-MM-DD..YYYY-MM-DD or YYYY-MM..YYYY-MM.');
      return 1;
    }
  }
  return 0;
}

module.exports = { runImportFromConfig, renderMarkdown, formatJSON, loadImporterEngine, periodText: printPeriod, main, EXAMPLE_CONFIG };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
