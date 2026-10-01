#!/usr/bin/env node
'use strict';
/*
 * Regenerate the committed synthetic sample from fixtures/SAMPLE_HOUSEHOLD.md (entirely fictional).
 *
 *   node tools/build-sample.cjs           write fixtures/sample-raw/*.csv, sample-rules.json,
 *                                         sample-import.json, sample-data.json, sample-import-report.json
 *   node tools/build-sample.cjs --check   exit 1 if the committed files differ from a fresh generation
 *
 * Deterministic: a seeded PRNG, fixed dates, no clock. The raw CSVs imitate real bank exports
 * (header formats per the spec); the dataset is produced by the real importer from those CSVs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { runImportFromConfig, formatJSON, loadImporterEngine } = require('./import.cjs');

const ROOT = path.resolve(__dirname, '..');
const SEED = 0x5a3b1e;
const OPENING_CHECKING_CENTS = 385000; // fictional balance before the first exported row

const FILES = {
  checkingA: 'fixtures/sample-raw/checking-2024-10-to-2025-12.csv',
  checkingB: 'fixtures/sample-raw/checking-2025-11-to-2026-09.csv',
  card: 'fixtures/sample-raw/card-2025-01-to-2026-09.csv',
  savings: 'fixtures/sample-raw/savings-2025-06-to-2026-09.csv',
  rules: 'fixtures/sample-rules.json',
  config: 'fixtures/sample-import.json',
  data: 'fixtures/sample-data.json',
  report: 'fixtures/sample-import-report.json'
};

/** Small, fast, seedable PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dollars(cents) {
  const abs = Math.abs(cents);
  return (cents < 0 ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
const mdy = iso => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
const csvLine = fields => fields.map(f => (/[",\n\r]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f)).join(',') + '\n';

// ------------------------------------------------------------------ household rules (fictional)

const SAMPLE_RULES = {
  _note: 'Household rules for the fictional sample (Alex & Sam). A real household keeps its own rules in private/rules.json.',
  categoryMap: {},
  merchantRules: [
    { match: 'SAMPLE MORTGAGE SERVICER', sign: 'out', category: 'Mortgage', merchant: 'Sample Mortgage Servicer', reason: 'Household rule: mortgage servicer (escrow split unknown)' },
    { match: 'SAMPLE GAS UTILITY', sign: 'out', category: 'Gas & heating', merchant: 'Sample Gas Utility', reason: 'Household rule: gas utility bill' },
    { match: 'SAMPLE ELECTRIC CO', sign: 'out', category: 'Electric', merchant: 'Sample Electric Co', reason: 'Household rule: electric utility bill' },
    { match: 'SAMPLE CITY WATER SEWER', sign: 'out', category: 'Water & sewer', merchant: 'Sample City Water & Sewer', reason: 'Household rule: water and sewer bill' },
    { match: 'SAMPLE INTERNET CO', sign: 'out', category: 'Internet & phone', merchant: 'Sample Internet Co', reason: 'Household rule: home internet' },
    { match: 'SAMPLE WIRELESS', sign: 'out', category: 'Internet & phone', merchant: 'Sample Wireless', reason: 'Household rule: mobile phone plan' },
    { match: 'SAMPLE HOME INSURANCE', sign: 'out', category: 'Home insurance', merchant: 'Sample Home Insurance', reason: 'Household rule: annual home insurance premium' },
    { match: 'SAMPLE STORE CARD PAYMENT', sign: 'out', kind: 'debt_payment', subtype: 'store_card', category: 'Debt payment', merchant: 'Sample store card',
      reason: 'Household rule: store-card payment — that card\'s purchases are not in the data, so it counts as a debt payment' },
    { match: 'SAMPLE EMPLOYER PAYROLL', sign: 'in', merchant: 'Sample Employer', reason: 'Household rule: Alex\'s paycheck (joint portion)' },
    { match: 'HOME DEPOT|LOWE\'?S', flags: ['business_candidate'], reason: 'Possible business purchase — confirm' },
    { match: 'SAMPLE ENDODONTICS', category: 'Dental', merchant: 'Sample Endodontics', reason: 'Household rule: endodontist (dental specialist)' }
  ],
  transferHints: [
    { match: 'ONLINE TRANSFER FROM SAM PERSONAL', subtype: 'contribution', personId: 'p2', reason: 'Transfer hint: Sam\'s contribution from a personal account outside the data' }
  ]
};

const SAMPLE_CONFIG = {
  datasetId: 'sample',
  isSynthetic: true,
  generatedAt: '2026-10-01',
  accounts: [
    { id: 'joint-checking', label: 'Joint checking', type: 'checking', scope: 'joint', ownerId: null, paidInFull: false },
    { id: 'joint-card', label: 'Joint rewards card', type: 'credit_card', scope: 'joint', ownerId: null, paidInFull: true },
    { id: 'joint-savings', label: 'Joint savings', type: 'savings', scope: 'joint', ownerId: null, paidInFull: false }
  ],
  files: [
    { path: FILES.checkingA, accountId: 'joint-checking', coverageStart: '2024-10-01', coverageEnd: '2025-12-31' },
    { path: FILES.checkingB, accountId: 'joint-checking', coverageStart: '2025-11-01', coverageEnd: '2026-09-30' },
    { path: FILES.card, accountId: 'joint-card', coverageStart: '2025-01-01', coverageEnd: '2026-09-30' },
    { path: FILES.savings, accountId: 'joint-savings', coverageStart: '2025-06-01', coverageEnd: '2026-09-30' }
  ],
  rules: FILES.rules,
  notes: [
    'Entirely fictional household (Alex & Sam) generated by tools/build-sample.cjs from fixtures/SAMPLE_HOUSEHOLD.md. No real person, account, employer or balance.',
    'Personal accounts are not in the data: Sam\'s contributions arrive as transfers from outside, and Sam\'s full take-home pay is unknown.'
  ]
};

// ------------------------------------------------------------------ generation

/**
 * Build every sample file in memory. `seed` exists only for tooling; the committed sample uses SEED.
 * @returns {Object<string, string>} repo-relative path -> file contents
 */
function generate({ seed = SEED } = {}) {
  const E = loadImporterEngine();
  const D = E.dates, M = E.months;
  const rand = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const between = (loDollars, hiDollars) => int(loDollars * 100, hiDollars * 100);
  const pick = list => list[int(0, list.length - 1)];
  const code6 = () => Array.from({ length: 6 }, () => pick('ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'.split(''))).join('');

  // ---- joint card: purchases are the spending; paid in full every month
  const card = [];
  let seq = 0;
  const charge = (date, description, category, cents) => card.push({ date, txnDate: D.addDays(date, -int(0, 2)), description, category, debit: cents, credit: null, seq: seq++ });
  const credit = (date, description, category, cents, txnDate) => card.push({ date, txnDate: txnDate || date, description, category, debit: null, credit: cents, seq: seq++ });

  M.range('2025-01', '2026-09').forEach((month, i) => {
    const dim = M.daysIn(month);
    const on = d => D.inMonth(month, d);
    for (let w = 1; w <= dim; w += 7) {
      const d = w + int(0, 6);
      if (d <= dim) charge(on(d), pick(['KROGER #0412', 'KROGER #0412', 'ALDI 77']), 'Groceries', between(85, 190));
    }
    const amazon = [];
    for (let k = int(3, 5); k > 0; k--) {
      const row = { date: on(int(1, dim)), description: 'AMAZON MKTPL*' + code6(), cents: between(14, 120) };
      amazon.push(row);
      charge(row.date, row.description, 'Shopping', row.cents);
    }
    if (i % 3 === 1) { // a return roughly every three months: the same item credited back
      const r = amazon[0];
      const back = D.addDays(r.date, int(3, 8));
      credit(back <= M.end(month) ? back : M.end(month), r.description, 'Shopping', r.cents, null);
    }
    for (let k = 0; k < 2; k++) charge(on(int(1, dim)), 'COSTCO WHSE #0123', 'Shopping', between(140, 260));
    charge(on(int(1, dim)), 'COSTCO GAS #0123', 'Gas', between(38, 55));
    if (month === '2026-03') {
      // Near-duplicate for review: same amount on consecutive posting days (never auto-removed).
      charge('2026-03-14', 'TARGET 00012345', 'Shopping', 6418);
      charge('2026-03-15', 'TARGET 00012345', 'Shopping', 6418);
    } else {
      for (let k = int(1, 2); k > 0; k--) charge(on(int(1, dim)), 'TARGET 00012345', 'Shopping', between(35, 110));
    }
    for (let k = 0; k < 2; k++) charge(on(int(1, dim)), 'SHELL OIL 57441', 'Gas', between(32, 52));
    for (let k = int(6, 10); k > 0; k--) charge(on(int(1, dim)), pick(['CHIPOTLE 1834', 'PANERA BREAD #602', 'SAMPLE PIZZA CO']), 'Food & Drink', between(11, 68));
    charge(on(7), 'NETFLIX.COM', 'Entertainment', 1549);
    charge(on(14), 'SPOTIFY USA', 'Entertainment', 1199);
    charge(on(int(3, 6)), 'CHEWY.COM', 'Shopping', int(4650, 4950));
    for (let k = int(1, 2); k > 0; k--) charge(on(int(1, dim)), pick(['THE HOME DEPOT #3812', 'LOWES #01944']), 'Home', between(22, 185));
    if (i % 2 === 0) charge(on(int(1, dim)), 'CVS/PHARMACY #4410', 'Health & Wellness', between(9, 42));
    // Routine cleanings in February and August. In August 2026 the visit became the unusual
    // episode below, so that month has no separate $45 cleaning.
    if ((month.endsWith('-02') || month.endsWith('-08')) && month !== '2026-08') charge(on(int(5, 20)), 'BRIGHT SMILE DENTAL', 'Health & Wellness', 4500);
    if (month.endsWith('-01')) charge(on(5), 'ANNUAL MEMBERSHIP FEE', 'Fees & Adjustments', 9500);
    if (month === '2025-12') { // holiday gifts, roughly +$350
      for (let k = 0; k < 3; k++) charge(on(int(1, 20)), 'AMAZON MKTPL*' + code6(), 'Shopping', between(70, 105));
      charge(on(int(1, 20)), 'TARGET 00012345', 'Shopping', between(70, 105));
    }
  });
  charge('2026-07-08', 'SAMPLE AIRLINES', 'Travel', 48660);
  charge('2026-08-04', 'BRIGHT SMILE DENTAL', 'Health & Wellness', 86000);
  charge('2026-08-11', 'SAMPLE ENDODONTICS', 'Health & Wellness', 71540);
  charge('2026-08-25', 'SAMPLE ENDODONTICS', 'Health & Wellness', 41230);

  // Statement = calendar month of posted dates; autopay on the 25th pays last month's net charges.
  const statement = new Map();
  for (const r of card) statement.set(r.date.slice(0, 7), (statement.get(r.date.slice(0, 7)) || 0) + (r.debit || 0) - (r.credit || 0));
  const autopays = M.range('2025-02', '2026-09').map(month => ({ date: month + '-25', cents: statement.get(M.add(month, -1)) }));
  for (const p of autopays) credit(p.date, 'AUTOMATIC PAYMENT - THANK YOU', '', p.cents, p.date);
  card.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  // ---- joint checking
  const checking = [];
  const add = (date, description, cents) => checking.push({ date, description, cents, seq: seq++ });
  const GAS = [212, 188, 151, 96, 57, 38, 34, 33, 41, 72, 128, 183];
  const ELECTRIC = [96, 91, 86, 81, 92, 126, 151, 147, 112, 86, 89, 99];
  M.range('2024-10', '2026-09').forEach(month => {
    const n = M.calendarNumber(month);
    const on = d => D.inMonth(month, d);
    add(on(1), 'SAMPLE MORTGAGE SERVICER PMT', -141256);
    if (month >= '2025-06') add(on(2), 'TRANSFER TO SAVINGS', -25000);
    add(on(9), 'SAMPLE STORE CARD PAYMENT', -5500);
    if ([1, 4, 7, 10].includes(n)) add(on(10 + int(-2, 2)), 'SAMPLE CITY WATER SEWER', -(16500 + int(-1200, 1200)));
    add(on(12), 'SAMPLE INTERNET CO', -7500);
    if (month === '2025-03' || month === '2026-03') add(on(15), 'SAMPLE HOME INSURANCE', -110400);
    add(on(18 + int(-2, 2)), 'SAMPLE ELECTRIC CO', -(ELECTRIC[n - 1] * 100 + int(-700, 700)));
    add(on(20 + int(-2, 2)), 'SAMPLE GAS UTILITY', -(GAS[n - 1] * 100 + int(-900, 900)));
    add(on(22), 'SAMPLE WIRELESS', -9240);
    for (const dom of [1, 15]) { // Sam's contribution; weekend dates move to the previous Friday
      let d = on(dom);
      const wd = D.weekday(d);
      if (wd === 6) d = D.addDays(d, -1); else if (wd === 0) d = D.addDays(d, -2);
      if (d >= '2024-10-01' && d <= '2026-09-30') add(d, 'ONLINE TRANSFER FROM SAM PERSONAL CHK', 132500);
    }
  });
  for (let d = '2024-10-04'; d <= '2026-09-30'; d = D.addDays(d, 14)) add(d, 'SAMPLE EMPLOYER PAYROLL DIR DEP', 188000);
  for (const p of autopays) add(p.date, 'SAMPLE BANK CARD AUTOPAY', -p.cents);
  add('2026-04-18', 'ZELLE PAYMENT TO J SMITH', -8000);
  add('2026-05-11', 'ONLINE TRANSFER FROM CHK 4821', 50000);
  add('2026-08-21', 'MOBILE DEPOSIT', 48660);
  checking.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  let balance = OPENING_CHECKING_CENTS;
  for (const r of checking) { balance += r.cents; r.balance = balance; }

  // ---- joint savings (starting balance not exported)
  const savings = [];
  M.range('2025-06', '2026-09').forEach(month => {
    savings.push({ date: month + '-02', description: 'TRANSFER FROM CHECKING', cents: 25000 });
    savings.push({ date: M.end(month), description: 'INTEREST PAID', cents: int(110, 600) });
  });

  // ---- CSV text
  const checkingCsv = (start, end) => 'Date,Description,Amount,Balance\n' + checking
    .filter(r => r.date >= start && r.date <= end).reverse() // newest first, like many bank downloads
    .map(r => csvLine([mdy(r.date), r.description, dollars(r.cents), dollars(r.balance)])).join('');
  const cardCsv = 'Transaction Date,Posted Date,Description,Category,Debit,Credit\n' + card
    .map(r => csvLine([mdy(r.txnDate), mdy(r.date), r.description, r.category, r.debit ? dollars(r.debit) : '', r.credit ? dollars(r.credit) : ''])).join('');
  const savingsCsv = 'Posting Date,Description,Amount\n' + savings.map(r => csvLine([r.date, r.description, dollars(r.cents)])).join('');

  const files = {
    [FILES.checkingA]: checkingCsv('2024-10-01', '2025-12-31'),
    [FILES.checkingB]: checkingCsv('2025-11-01', '2026-09-30'),
    [FILES.card]: cardCsv,
    [FILES.savings]: savingsCsv,
    [FILES.rules]: formatJSON(SAMPLE_RULES),
    [FILES.config]: formatJSON(SAMPLE_CONFIG)
  };
  const readText = rel => {
    if (!(rel in files)) { const err = new Error('not generated: ' + rel); err.code = 'ENOENT'; throw err; }
    return files[rel];
  };
  const { dataset, report } = runImportFromConfig(SAMPLE_CONFIG, { readText });
  files[FILES.data] = formatJSON(dataset);
  files[FILES.report] = formatJSON(report);
  return files;
}

function main(argv) {
  const check = argv.includes('--check');
  const files = generate();
  if (check) {
    const stale = Object.entries(files).filter(([rel, text]) => {
      const abs = path.join(ROOT, rel);
      return !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== text;
    }).map(([rel]) => rel);
    if (stale.length) { console.error('Out of date (run node tools/build-sample.cjs):\n  ' + stale.join('\n  ')); return 1; }
    console.log('Sample fixtures are up to date.');
    return 0;
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const report = JSON.parse(files[FILES.report]);
  console.log('Wrote ' + Object.keys(files).length + ' sample files: ' + report.transactions + ' transactions, ' + report.start + ' to ' + report.end + '.');
  for (const f of report.files) console.log('  ' + f.name + ': ' + f.rows + ' rows, ' + f.imported + ' imported, ' + f.duplicatesRemoved + ' duplicates removed');
  return 0;
}

module.exports = { generate, FILES, SAMPLE_RULES, SAMPLE_CONFIG, SEED };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
