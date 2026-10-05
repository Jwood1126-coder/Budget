'use strict';
// The committed synthetic sample must be reproducible and must follow fixtures/SAMPLE_HOUSEHOLD.md.
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const REPO = path.resolve(__dirname, '..', '..');
const { generate, FILES } = require('../../tools/build-sample.cjs');

const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const dataset = JSON.parse(read(FILES.data));
const report = JSON.parse(read(FILES.report));
const T = dataset.transactions;
const byDesc = re => T.filter(t => re.test(t.description));
const monthOf = t => t.date.slice(0, 7);
const countBy = (list, fn) => list.reduce((m, t) => { const k = fn(t); m[k] = (m[k] || 0) + 1; return m; }, {});
const sum = list => list.reduce((s, t) => s + t.amountCents, 0);

describe('regeneration', () => {
  let first;
  before(() => { first = generate(); });

  test('generating twice gives identical bytes', () => {
    assert.deepEqual(generate(), first);
  });
  test('the committed fixtures match a fresh generation byte for byte', () => {
    for (const [rel, text] of Object.entries(first)) assert.equal(read(rel), text, rel + ' is out of date: run node tools/build-sample.cjs');
  });
  test('build-sample --check agrees', () => {
    const res = spawnSync(process.execPath, [path.join(REPO, 'tools', 'build-sample.cjs'), '--check'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });
  test('the generator never reads the clock or randomness from the platform', () => {
    const src = read('tools/build-sample.cjs');
    assert.ok(!/Date\.now|new Date\(|Math\.random/.test(src));
  });
  test('the CLI --sample path rebuilds the same dataset', () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'budget-sample-'));
    const out = path.join(tmp, 'data.json'), rep = path.join(tmp, 'report.json');
    const res = spawnSync(process.execPath, [path.join(REPO, 'tools', 'import.cjs'), '--sample', '--out', out, '--report', rep], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), read(FILES.data));
    assert.equal(fs.readFileSync(rep, 'utf8'), read(FILES.report));
  });
});

describe('raw exports', () => {
  test('four files with the specified headers', () => {
    assert.equal(read(FILES.checkingA).split('\n')[0], 'Date,Description,Amount,Balance');
    assert.equal(read(FILES.checkingB).split('\n')[0], 'Date,Description,Amount,Balance');
    assert.equal(read(FILES.card).split('\n')[0], 'Transaction Date,Posted Date,Description,Category,Debit,Credit');
    assert.equal(read(FILES.savings).split('\n')[0], 'Posting Date,Description,Amount');
    const files = fs.readdirSync(path.join(REPO, 'fixtures', 'sample-raw')).sort();
    assert.deepEqual(files, ['card-2025-01-to-2026-09.csv', 'checking-2024-10-to-2025-12.csv', 'checking-2025-11-to-2026-09.csv', 'savings-2025-06-to-2026-09.csv']);
  });
  test('date formats: MM/DD/YYYY for checking and card, YYYY-MM-DD for savings', () => {
    assert.match(read(FILES.checkingA).split('\n')[1], /^\d\d\/\d\d\/\d{4},/);
    assert.match(read(FILES.card).split('\n')[1], /^\d\d\/\d\d\/\d{4},\d\d\/\d\d\/\d{4},/);
    assert.match(read(FILES.savings).split('\n')[1], /^\d{4}-\d\d-\d\d,/);
  });
  test('the two checking exports overlap in Nov–Dec 2025 with byte-identical rows', () => {
    const inOverlap = rel => read(rel).split('\n').filter(l => /^(11|12)\/\d\d\/2025,/.test(l));
    const a = inOverlap(FILES.checkingA), b = inOverlap(FILES.checkingB);
    assert.ok(a.length > 15);
    assert.deepEqual(b, a);
  });
  test('every description comes from the fictional spec', () => {
    const allowed = /^(SAMPLE [A-Z ]+|ONLINE TRANSFER FROM (SAM PERSONAL CHK|CHK 4821)|TRANSFER (TO SAVINGS|FROM CHECKING|TO SAMPLE BROKERAGE)|ZELLE PAYMENT TO J SMITH|MOBILE DEPOSIT|INTEREST PAID|KROGER #0412|ALDI 77|AMAZON MKTPL\*[A-Z0-9]{6}|COSTCO (WHSE|GAS) #0123|TARGET 00012345|SHELL OIL 57441|CHIPOTLE 1834|PANERA BREAD #602|NETFLIX\.COM|SPOTIFY USA|CHEWY\.COM|THE HOME DEPOT #3812|LOWES #01944|CVS\/PHARMACY #4410|BRIGHT SMILE DENTAL|ANNUAL MEMBERSHIP FEE|AUTOMATIC PAYMENT - THANK YOU)$/;
    for (const t of T) assert.match(t.description, allowed);
  });
});

describe('sample dataset', () => {
  test('is a synthetic schema v2 dataset', () => {
    assert.equal(dataset.schemaVersion, 2);
    assert.equal(dataset.datasetId, 'sample');
    assert.equal(dataset.isSynthetic, true);
    assert.equal(dataset.generatedAt, '2026-10-01');
    assert.equal(dataset.currency, 'USD');
    assert.equal(report.isSynthetic, true);
    assert.equal(JSON.parse(read(FILES.config)).isSynthetic, true);
    assert.deepEqual(dataset.accounts.map(a => [a.id, a.type, a.scope, a.paidInFull]), [
      ['joint-checking', 'checking', 'joint', false], ['joint-card', 'credit_card', 'joint', true], ['joint-savings', 'savings', 'joint', false],
      ['joint-brokerage', 'investment', 'joint', false]]);
  });

  test('a balance-only brokerage account: invented statement balances, a few joint transfers into it, never cash', () => {
    const brokerage = dataset.accounts.find(a => a.id === 'joint-brokerage');
    assert.deepEqual(brokerage.coverage, [], 'no export');
    assert.ok(!T.some(t => t.accountId === 'joint-brokerage'));
    assert.deepEqual(dataset.balances.filter(b => b.accountId === 'joint-brokerage').map(b => [b.date, b.cents, b.source]),
      [['2026-03-31', 1248000, 'statement'], ['2026-06-30', 1310550, 'statement'], ['2026-09-30', 1402025, 'statement']]);
    const transfers = T.filter(t => t.description === 'TRANSFER TO SAMPLE BROKERAGE');
    assert.deepEqual(transfers.map(t => [t.accountId, t.date, t.amountCents, t.kind, t.subtype]), ['04', '05', '06', '07', '08', '09']
      .map(m => ['joint-checking', '2026-' + m + '-05', -20000, 'transfer', 'investment']));
    assert.ok(!E.balances.cashAccounts(dataset).some(a => a.id === 'joint-brokerage'), 'never cash');
  });

  test('every transaction has the contract shape', () => {
    const KINDS = { spend: [null], income: ['payroll', 'interest', 'reimbursement', 'other'], transfer: ['savings', 'contribution', 'internal', 'investment'],
      card_payment: [null], debt_payment: ['loan', 'store_card', 'other'] };
    const FLAGS = ['mixed_retail', 'needs_category_review', 'reimbursement_candidate', 'business_candidate', 'duplicate_candidate', 'unpaired_transfer', 'pending', 'fee', 'refund'];
    const accountIds = new Set(dataset.accounts.map(a => a.id));
    const ids = new Set(T.map(t => t.id));
    const files = new Set(report.files.map(f => f.name));
    assert.equal(ids.size, T.length, 'ids are unique');
    for (const t of T) {
      // personId and balanceCents (the bank's running balance) are optional.
      const keys = Object.keys(t).filter(k => k !== 'personId' && k !== 'balanceCents');
      if (t.balanceCents !== undefined) {
        assert.ok(Number.isSafeInteger(t.balanceCents), t.id + ' balance in whole cents');
        assert.equal(dataset.accounts.find(a => a.id === t.accountId).type, 'checking', 'only the checking export prints a balance');
      }
      assert.deepEqual(keys, ['id', 'accountId', 'date', 'description', 'merchant', 'amountCents', 'kind', 'subtype', 'category', 'sourceCategory',
        'categoryReason', 'confidence', 'flags', 'pairId', 'matchIds', 'sourceFile', 'sourceRow', 'note'], t.id);
      assert.match(t.id, /^tx-[0-9a-z]+$/);
      assert.ok(accountIds.has(t.accountId));
      assert.ok(E.dates.isDate(t.date), t.date);
      assert.ok(t.description && t.merchant && t.category && t.categoryReason, t.id);
      assert.ok(Number.isInteger(t.amountCents) && t.amountCents !== 0, 'integer cents: ' + t.id);
      assert.ok(t.kind in KINDS, t.kind);
      assert.ok(KINDS[t.kind].includes(t.subtype), t.kind + '/' + t.subtype);
      assert.ok(t.sourceCategory === null || typeof t.sourceCategory === 'string');
      assert.ok(['high', 'medium', 'low'].includes(t.confidence));
      assert.ok(t.flags.every(f => FLAGS.includes(f)), t.flags.join());
      if (t.pairId !== null) assert.equal(T.find(x => x.id === t.pairId).pairId, t.id, 'pairs are reciprocal');
      for (const m of t.matchIds) assert.ok(T.find(x => x.id === m).matchIds.includes(t.id), 'matches are reciprocal');
      assert.ok(files.has(t.sourceFile));
      assert.ok(Number.isInteger(t.sourceRow) && t.sourceRow >= 2);
      assert.equal(typeof t.note, 'string');
      if ('personId' in t) assert.ok(t.personId === 'p1' || t.personId === 'p2');
    }
  });

  test('transactions are sorted by date then id', () => {
    for (let i = 1; i < T.length; i++) assert.ok(T[i - 1].date < T[i].date || (T[i - 1].date === T[i].date && T[i - 1].id < T[i].id));
  });

  test('passes ledger validation when the ledger module is present', { skip: !E.ledger }, () => {
    assert.deepEqual(E.ledger.validateDataset(dataset).errors, []);
  });

  test('report rows add up for every file', () => {
    for (const f of report.files) assert.equal(f.rows, f.imported + f.skipped + f.duplicatesRemoved, f.name);
    assert.equal(report.files.reduce((s, f) => s + f.imported, 0), T.length);
  });
});

describe('sample matches SAMPLE_HOUSEHOLD.md', () => {
  test('de-duplication removed exactly the Nov–Dec 2025 overlap', () => {
    const later = report.files.find(f => f.name === 'checking-2025-11-to-2026-09.csv');
    const overlapRows = read(FILES.checkingB).split('\n').filter(l => /^(11|12)\/\d\d\/2025,/.test(l)).length;
    assert.equal(later.duplicatesRemoved, overlapRows);
    assert.equal(report.duplicatesRemoved.length, overlapRows);
    assert.ok(report.duplicatesRemoved.every(d => d.date >= '2025-11-01' && d.date <= '2025-12-31'));
    assert.ok(!T.some(t => t.sourceFile === 'checking-2025-11-to-2026-09.csv' && t.date < '2026-01-01'));
    const checkingNovDec = T.filter(t => t.accountId === 'joint-checking' && t.date >= '2025-11-01' && t.date <= '2025-12-31');
    assert.equal(checkingNovDec.length, overlapRows);
  });

  test('Alex is paid $1,880 biweekly from 2024-10-04, with three-paycheck months', () => {
    const pay = T.filter(t => t.subtype === 'payroll');
    assert.ok(pay.every(t => t.amountCents === 188000 && t.accountId === 'joint-checking'));
    assert.equal(pay[0].date, '2024-10-04');
    for (let i = 1; i < pay.length; i++) assert.equal(E.dates.daysBetween(pay[i - 1].date, pay[i].date), 14);
    const perMonth = countBy(pay, monthOf);
    assert.deepEqual(Object.keys(perMonth).filter(m => perMonth[m] === 3), ['2024-11', '2025-05', '2025-10', '2026-05']);
    assert.ok(Object.values(perMonth).every(n => n === 2 || n === 3));
  });

  test('Sam contributes $1,325 twice a month, on weekdays, as an expected unpaired contribution', () => {
    const c = T.filter(t => t.subtype === 'contribution');
    assert.equal(c.length, 48);
    for (const t of c) {
      assert.equal(t.amountCents, 132500);
      assert.equal(t.personId, 'p2');
      assert.deepEqual(t.flags, []);
      assert.ok(![0, 6].includes(E.dates.weekday(t.date)), t.date);
    }
    assert.ok(c.some(t => t.date === '2025-01-31'), '2025-02-01 (Saturday) moved to Friday');
  });

  test('card autopays equal the previous statement and are paired with the card credit', () => {
    const pays = T.filter(t => t.kind === 'card_payment' && t.accountId === 'joint-checking');
    assert.equal(pays.length, 20);
    assert.equal(pays[0].date, '2025-02-25');
    for (const p of pays) {
      const twin = T.find(x => x.id === p.pairId);
      assert.equal(twin.accountId, 'joint-card');
      assert.equal(twin.amountCents, -p.amountCents);
      assert.equal(twin.date, p.date);
      const prev = E.months.add(monthOf(p), -1);
      const statement = -sum(T.filter(t => t.accountId === 'joint-card' && t.kind === 'spend' && monthOf(t) === prev));
      assert.equal(-p.amountCents, statement, 'autopay ' + p.date);
    }
    assert.ok(!T.some(t => t.kind === 'card_payment' && t.flags.includes('unpaired_transfer')));
  });

  test('savings transfers are paired and labelled savings on both sides', () => {
    const out = T.filter(t => t.description === 'TRANSFER TO SAVINGS');
    assert.equal(out.length, 16);
    for (const t of out) {
      const twin = T.find(x => x.id === t.pairId);
      assert.equal(twin.accountId, 'joint-savings');
      assert.equal(twin.description, 'TRANSFER FROM CHECKING');
      assert.deepEqual([t.subtype, twin.subtype], ['savings', 'savings']);
      assert.equal(t.amountCents, -25000);
    }
  });

  test('the airline charge and the mobile deposit are reimbursement candidates', () => {
    const [air] = byDesc(/^SAMPLE AIRLINES$/);
    const [dep] = byDesc(/^MOBILE DEPOSIT$/);
    assert.equal(air.date, '2026-07-08');
    assert.equal(air.amountCents, -48660);
    assert.equal(air.category, 'Travel');
    assert.equal(dep.date, '2026-08-21');
    assert.equal(dep.kind, 'income');
    assert.equal(dep.subtype, 'other');
    assert.ok(air.flags.includes('reimbursement_candidate') && dep.flags.includes('reimbursement_candidate'));
    assert.deepEqual(air.matchIds, [dep.id]);
    assert.deepEqual(dep.matchIds, [air.id]);
    assert.equal(T.filter(t => t.flags.includes('reimbursement_candidate')).length, 2);
  });

  test('the near-duplicate Target pair is present and both rows are kept', () => {
    const pair = T.filter(t => t.description === 'TARGET 00012345' && t.amountCents === -6418);
    assert.deepEqual(pair.map(t => t.date), ['2026-03-14', '2026-03-15']);
    assert.notEqual(pair[0].id, pair[1].id);
  });

  test('the $500 inbound transfer is flagged as unpaired', () => {
    const [t] = byDesc(/^ONLINE TRANSFER FROM CHK 4821$/);
    assert.equal(t.date, '2026-05-11');
    assert.equal(t.amountCents, 50000);
    assert.equal(t.kind, 'transfer');
    assert.equal(t.pairId, null);
    assert.ok(t.flags.includes('unpaired_transfer'));
    assert.deepEqual(T.filter(t => t.flags.includes('unpaired_transfer')).map(x => x.id), [t.id]);
  });

  test('the August 2026 dental episode totals $1,987.70 in Dental', () => {
    const aug = T.filter(t => t.category === 'Dental' && monthOf(t) === '2026-08');
    assert.deepEqual(aug.map(t => [t.date, t.amountCents]), [['2026-08-04', -86000], ['2026-08-11', -71540], ['2026-08-25', -41230]]);
    assert.equal(-sum(aug), 198770);
    const routine = T.filter(t => t.category === 'Dental' && t.amountCents === -4500).map(monthOf);
    assert.deepEqual(routine, ['2025-02', '2025-08', '2026-02']);
  });

  test('Oct–Dec 2024 lack card coverage; spending is fully covered from 2025-01', () => {
    const card = dataset.accounts.find(a => a.id === 'joint-card');
    assert.deepEqual(card.coverage, [{ start: '2025-01-01', end: '2026-09-30' }]);
    assert.deepEqual(dataset.accounts.find(a => a.id === 'joint-checking').coverage, [{ start: '2024-10-01', end: '2026-09-30' }]);
    assert.deepEqual(dataset.accounts.find(a => a.id === 'joint-savings').coverage, [{ start: '2025-06-01', end: '2026-09-30' }]);
    const status = Object.fromEntries(report.months.map(m => [m.month, m.spendingCoverage]));
    for (const m of ['2024-10', '2024-11', '2024-12']) assert.equal(status[m], 'partial', m);
    for (const m of E.months.range('2025-01', '2026-09')) assert.equal(status[m], 'full', m);
    assert.ok(!T.some(t => t.accountId === 'joint-card' && t.date < '2025-01-01'));
  });

  test('ledger coverage agrees when the ledger module is present', { skip: !E.ledger }, () => {
    assert.equal(E.ledger.coverage(dataset, '2024-11').status, 'partial');
    assert.equal(E.ledger.coverage(dataset, '2025-03').status, 'full');
  });

  test('fixed checking bills follow the spec', () => {
    const fixed = [
      [/^SAMPLE MORTGAGE SERVICER PMT$/, -141256, 'Mortgage', 1],
      [/^SAMPLE INTERNET CO$/, -7500, 'Internet & phone', 12],
      [/^SAMPLE WIRELESS$/, -9240, 'Internet & phone', 22]
    ];
    for (const [re, cents, category, day] of fixed) {
      const rows = byDesc(re);
      assert.equal(rows.length, 24, String(re));
      assert.ok(rows.every(t => t.amountCents === cents && t.category === category && t.kind === 'spend' && Number(t.date.slice(8)) === day), String(re));
    }
    assert.deepEqual(byDesc(/^SAMPLE HOME INSURANCE$/).map(t => [t.date, t.amountCents, t.category]), [['2025-03-15', -110400, 'Home insurance'], ['2026-03-15', -110400, 'Home insurance']]);
    const store = byDesc(/^SAMPLE STORE CARD PAYMENT$/);
    assert.equal(store.length, 24);
    assert.ok(store.every(t => t.kind === 'debt_payment' && t.subtype === 'store_card' && t.amountCents === -5500 && t.date.endsWith('-09')));
    const [zelle] = byDesc(/^ZELLE/);
    assert.deepEqual([zelle.date, zelle.amountCents, zelle.category], ['2026-04-18', -8000, 'Uncategorized']);
    assert.ok(zelle.flags.includes('needs_category_review'));
  });

  test('utilities are seasonal within the specified tolerance', () => {
    const GAS = [212, 188, 151, 96, 57, 38, 34, 33, 41, 72, 128, 183];
    const ELECTRIC = [96, 91, 86, 81, 92, 126, 151, 147, 112, 86, 89, 99];
    const check = (re, table, tol, category) => {
      const rows = byDesc(re);
      assert.equal(rows.length, 24);
      for (const t of rows) {
        const base = table[Number(t.date.slice(5, 7)) - 1] * 100;
        assert.ok(Math.abs(-t.amountCents - base) <= tol, t.date + ' ' + t.amountCents);
        assert.equal(t.category, category);
      }
    };
    check(/^SAMPLE GAS UTILITY$/, GAS, 900, 'Gas & heating');
    check(/^SAMPLE ELECTRIC CO$/, ELECTRIC, 700, 'Electric');
    const water = byDesc(/^SAMPLE CITY WATER SEWER$/);
    assert.deepEqual(water.map(monthOf), ['2024-10', '2025-01', '2025-04', '2025-07', '2025-10', '2026-01', '2026-04', '2026-07']);
    assert.ok(water.every(t => Math.abs(-t.amountCents - 16500) <= 1200 && t.category === 'Water & sewer'));
  });

  test('card merchants are classified as the spec describes', () => {
    const cats = re => [...new Set(byDesc(re).map(t => t.category))];
    assert.deepEqual(cats(/^AMAZON MKTPL/), ['Mixed retail']);
    assert.deepEqual(cats(/^COSTCO WHSE/), ['Mixed retail']);
    assert.deepEqual(cats(/^COSTCO GAS/), ['Fuel']);
    assert.deepEqual(cats(/^TARGET/), ['Mixed retail']);
    assert.deepEqual(cats(/^SHELL OIL/), ['Fuel']);
    assert.deepEqual(cats(/^(KROGER|ALDI)/), ['Groceries']);
    assert.deepEqual(cats(/^(CHIPOTLE|PANERA|SAMPLE PIZZA)/), ['Dining & takeout']);
    assert.deepEqual(cats(/^(NETFLIX|SPOTIFY)/), ['Subscriptions']);
    assert.deepEqual(cats(/^CHEWY/), ['Pets']);
    assert.deepEqual(cats(/^CVS/), ['Medical & pharmacy']);
    assert.deepEqual(cats(/^ANNUAL MEMBERSHIP FEE$/), ['Fees & interest']);
    const hardware = byDesc(/HOME DEPOT|LOWES/);
    assert.ok(hardware.every(t => t.category === 'Household & hardware' && t.flags.includes('business_candidate')));
    assert.ok(hardware.every(t => /Possible business purchase — confirm/.test(t.categoryReason)));
    assert.ok(byDesc(/^(AMAZON|COSTCO WHSE|TARGET)/).every(t => t.flags.includes('mixed_retail')));
    assert.ok(byDesc(/^AMAZON MKTPL/).every(t => t.sourceCategory === 'Shopping'), 'bank category preserved');
    assert.deepEqual(byDesc(/^NETFLIX/).map(t => t.amountCents).filter(c => c !== -1549), []);
    assert.deepEqual(byDesc(/^ANNUAL MEMBERSHIP FEE$/).map(monthOf), ['2025-01', '2026-01']);
  });

  test('Amazon refunds are card credits that reduce spending (not reimbursements)', () => {
    const refunds = T.filter(t => t.flags.includes('refund'));
    assert.ok(refunds.length >= 6);
    for (const r of refunds) {
      assert.equal(r.accountId, 'joint-card');
      assert.equal(r.kind, 'spend');
      assert.ok(r.amountCents > 0);
      assert.ok(!r.flags.includes('reimbursement_candidate'));
      assert.ok(T.some(t => t.description === r.description && t.amountCents === -r.amountCents && t.date <= r.date), 'refunds an earlier charge');
    }
  });

  test('December has extra gift spending at Amazon and Target', () => {
    const giftSpend = month => -sum(T.filter(t => /^(AMAZON|TARGET)/.test(t.description) && monthOf(t) === month));
    const others = E.months.range('2025-01', '2025-11').map(giftSpend);
    const avg = others.reduce((a, b) => a + b, 0) / others.length;
    assert.ok(giftSpend('2025-12') > avg + 20000, 'December ' + giftSpend('2025-12') + ' vs average ' + Math.round(avg));
  });

  test('savings interest is paid monthly between $1.10 and $6.00', () => {
    const interest = T.filter(t => t.subtype === 'interest');
    assert.equal(interest.length, 16);
    assert.ok(interest.every(t => t.accountId === 'joint-savings' && t.amountCents >= 110 && t.amountCents <= 600 && t.date === E.months.end(monthOf(t))));
  });

  test('sample rules hold only fictional, sample-specific names', () => {
    const rules = JSON.parse(read(FILES.rules));
    assert.ok(rules.merchantRules.some(r => r.flags && r.flags.includes('business_candidate') && r.reason === 'Possible business purchase — confirm'));
    assert.deepEqual(rules.transferHints, [{ match: 'ONLINE TRANSFER FROM SAM PERSONAL', subtype: 'contribution', personId: 'p2', reason: 'Transfer hint: Sam\'s contribution from a personal account outside the data' },
      { match: 'TRANSFER TO SAMPLE BROKERAGE', sign: 'out', subtype: 'investment', reason: 'Transfer hint: joint contribution to the sample brokerage account (balance-only, no export)' }]);
    for (const r of rules.merchantRules) assert.match(r.match, /SAMPLE|HOME DEPOT|LOWE/);
  });
});
