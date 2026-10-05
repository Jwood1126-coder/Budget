'use strict';
// Tests for BudgetEngine.ledger: normalization (v2 + legacy v1), edits, counting rules,
// filters, grouping and coverage. All data is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../helpers/ledger.cjs');

const { E, deepFreeze } = H;
const L = E.ledger;

const LEGACY_PATH = path.join(__dirname, '..', '..', 'fixtures', 'legacy-v1-sample.json');
const loadLegacy = () => JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));

const ACCOUNTS = [
  { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] },
  { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', paidInFull: true, coverage: [{ start: '2026-01-01', end: '2026-09-30' }] },
  { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] },
  { id: 'alex-chk', label: 'Alex personal', type: 'checking', scope: 'personal', ownerId: 'p1', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] }
];

const row = H.rowMaker({ prefix: 't', pad: 4, description: 'SAMPLE GROCER #12' });
/** A card purchase of groceries unless `fields` say otherwise. */
const tx = (date, amountCents, fields) => row('card', date, amountCents, fields);

const rawDataset = (transactions, extra = {}) => H.rawDataset({ datasetId: 'test-household', generatedAt: '2026-10-01', currency: 'USD', accounts: ACCOUNTS, transactions, ...extra });

const dataset = (transactions, extra) => L.normalizeDataset(rawDataset(transactions, extra));
const byId = (rows, id) => rows.find(t => t.id === id);

// ======================================================================= legacy v1

test('v1: converts the legacy fixture into a v2 dataset with the derived datasetId', () => {
  const raw = loadLegacy();
  const ds = L.normalizeDataset(raw);
  assert.equal(ds.schemaVersion, 2);
  assert.equal(ds.datasetId, 'legacy-sample');
  assert.equal(ds.isSynthetic, true);
  assert.equal(ds.generatedAt, '2031-10-01');
  assert.equal(ds.transactions.length, 576);
  assert.deepEqual(ds.accounts.map(a => [a.id, a.type, a.scope]), [['sample-bank', 'other', 'joint'], ['sample-card', 'other', 'joint']]);
  assert.deepEqual(ds.accounts[0].coverage, [{ start: '2029-10-01', end: '2031-09-25' }]);
  assert.equal(L.validateDataset(raw).errors.length, 0);
});

test('v1: datasetId comes from raw.datasetId, else legacy-private for non-synthetic data', () => {
  const raw = loadLegacy();
  raw.isSynthetic = false;
  assert.equal(L.normalizeDataset(raw).datasetId, 'legacy-private');
  raw.datasetId = 'household-copy';
  assert.equal(L.normalizeDataset(raw).datasetId, 'household-copy');
});

test('v1: spend rows flip sign; refunds become positive flow and keep a refund flag', () => {
  const ds = L.normalizeDataset(loadLegacy());
  const purchase = byId(ds.transactions, 'sample-0001');
  assert.equal(purchase.amountCents, -110000);
  assert.equal(purchase.kind, 'spend');
  const refund = byId(ds.transactions, 'sample-0019');
  assert.equal(refund.amountCents, 1500);
  assert.ok(refund.flags.includes('refund'));
  assert.equal(L.measure(refund).spendCents, -1500);
});

test('v1: other kinds use direction; investment becomes a transfer/investment', () => {
  const ds = L.normalizeDataset(loadLegacy());
  const payroll = byId(ds.transactions, 'sample-0020');
  assert.equal(payroll.amountCents, 300000);
  assert.equal(payroll.kind, 'income');
  assert.equal(payroll.subtype, 'payroll');
  const cardPayment = byId(ds.transactions, 'sample-0021');
  assert.equal(cardPayment.amountCents, -90000);
  assert.equal(cardPayment.kind, 'card_payment');
  const savings = byId(ds.transactions, 'sample-0022');
  assert.deepEqual([savings.kind, savings.subtype, savings.amountCents], ['transfer', 'savings', -10000]);
  const invest = byId(ds.transactions, 'sample-0023');
  assert.deepEqual([invest.kind, invest.subtype, invest.amountCents], ['transfer', 'investment', -5000]);
  const debt = byId(ds.transactions, 'sample-0024');
  assert.deepEqual([debt.kind, debt.subtype, debt.amountCents], ['debt_payment', 'store_card', -4000]);
});

test('v1: monthly spending totals equal the v1 monthly spendingCents for every month', () => {
  const raw = loadLegacy();
  const txns = L.applyEdits(L.normalizeDataset(raw), {});
  const groups = L.group(txns, 'month');
  assert.equal(groups.length, raw.monthly.length);
  for (const m of raw.monthly) {
    const g = groups.find(x => x.key === m.month);
    assert.ok(g, 'missing month ' + m.month);
    assert.equal(g.spendCents, m.spendingCents, m.month);
  }
});

test('v1: per-month summary reconciles with the v1 monthly cash-flow fields', () => {
  const raw = loadLegacy();
  const txns = L.applyEdits(L.normalizeDataset(raw), {});
  for (const m of raw.monthly) {
    const s = L.summarize(L.filter(txns, { months: [m.month] }));
    assert.equal(s.spendingCents, m.spendingCents);
    assert.equal(s.payrollCents, m.observedPayrollDepositsCents);
    assert.equal(s.debtPaymentsCents, m.debtPaymentsCents);
    assert.equal(s.cardPaymentsCents, m.cardRepaymentsExcludedCents);
    // v1 tracked savings and investment separately; both count as saved in v2.
    assert.equal(s.savedNetCents, m.savingsNetTransactionChangeCents + m.investmentOutflowsCents);
    const card = L.summarize(L.filter(txns, { months: [m.month], accountIds: ['sample-card'] }));
    assert.equal(card.purchasesCents, m.mainCardPurchasesCents);
    assert.equal(card.refundsCents, m.mainCardRefundsCents);
    const bank = L.summarize(L.filter(txns, { months: [m.month], accountIds: ['sample-bank'], kinds: ['spend'] }));
    assert.equal(bank.spendingCents, m.directCheckingSpendCents);
  }
});

test('v1: quarter total becomes a reference that reconciles with the converted data', () => {
  const raw = loadLegacy();
  const ds = L.normalizeDataset(raw);
  assert.deepEqual(ds.references, [{
    id: 'legacy-quarter', label: 'Earlier app baseline total', start: '2031-07-01', end: '2031-09-30', spendingCents: 848400, source: 'legacy dataset'
  }]);
  const ref = ds.references[0];
  const txns = L.applyEdits(ds, {});
  assert.equal(L.summarize(L.filter(txns, { start: ref.start, end: ref.end })).spendingCents, ref.spendingCents);
});

test('v1: confirming the airfare reimbursement reproduces the v1 "if confirmed" quarter total', () => {
  const raw = loadLegacy();
  const ds = L.normalizeDataset(raw);
  const txns = L.applyEdits(ds, { 'sample-0542': { reimbursement: 'confirmed', history: [] } });
  const s = L.summarize(L.filter(txns, { start: '2031-07-01', end: '2031-09-30' }));
  assert.equal(s.spendingCents, raw.quarter.spendingIfAirfareReimbursementConfirmedCents);
  assert.equal(byId(txns, 'sample-0542').excluded, 'reimbursed');
});

test('v1: hasMainCardCoverage false becomes a partial coverage override', () => {
  const ds = L.normalizeDataset(loadLegacy());
  assert.deepEqual(Object.keys(ds.coverageOverrides).sort(), ['2029-10', '2029-11', '2029-12']);
  const oct = L.coverage(ds, '2029-10');
  assert.equal(oct.status, 'partial');
  assert.equal(oct.overridden, true);
  assert.equal(oct.computedStatus, 'full');
  assert.equal(L.coverage(ds, '2030-01').status, 'full');
});

test('v1: the last month is partial because the exports end on the 25th', () => {
  const ds = L.normalizeDataset(loadLegacy());
  const sep = L.coverage(ds, '2031-09');
  assert.equal(sep.status, 'partial');
  assert.equal(sep.coveredDays, 25);
  assert.equal(sep.totalDays, 30);
  assert.equal(L.latestCompleteMonth(ds), '2031-08');
});

test('v1: flags are kept as legacy:<flag> and known ones are mapped', () => {
  const ds = L.normalizeDataset(loadLegacy());
  const mixed = byId(ds.transactions, 'sample-0007');
  assert.ok(mixed.flags.includes('legacy:mixed_retail'));
  assert.ok(mixed.flags.includes('mixed_retail'));
  const business = byId(ds.transactions, 'sample-0515');
  assert.ok(business.flags.includes('business_candidate'));
  assert.ok(business.flags.includes('legacy:business_candidate'));
  const airfare = byId(ds.transactions, 'sample-0542');
  assert.ok(airfare.flags.includes('reimbursement_candidate'));
  const dental = byId(ds.transactions, 'sample-0565');
  assert.ok(dental.flags.includes('legacy:nonroutine_dental_episode'));
  assert.ok(!dental.flags.includes('nonroutine_dental_episode'));
  assert.ok(dental.flags.includes('legacy:source_category_revised'));
  assert.ok(!dental.flags.includes('source_category_revised'));
  assert.equal(dental.sourceCategory, 'Health');
  assert.equal(dental.category, 'Dental');
});

test('v1: needsCategoryReview maps to the needs_category_review flag', () => {
  const raw = loadLegacy();
  raw.transactions[0].needsCategoryReview = true;
  const ds = L.normalizeDataset(raw);
  assert.ok(byId(ds.transactions, raw.transactions[0].id).flags.includes('needs_category_review'));
});

test('v1: conversion never mutates the input', () => {
  const raw = deepFreeze(loadLegacy());
  const before = JSON.stringify(raw);
  L.normalizeDataset(raw);
  assert.equal(JSON.stringify(raw), before);
});

test('v1: a transaction from an unlisted source gets a placeholder account and a note', () => {
  const raw = loadLegacy();
  raw.transactions[0].source = 'sample-other';
  const ds = L.normalizeDataset(raw);
  const acct = ds.accounts.find(a => a.id === 'sample-other');
  assert.ok(acct);
  assert.deepEqual(acct.coverage, []);
  assert.ok(ds.notes.some(n => n.includes('sample-other')));
});

// ======================================================================= v2 validation

test('v2: defaults are filled for optional fields', () => {
  const ds = dataset([{ id: 'a1', accountId: 'card', date: '2026-03-02', description: 'SAMPLE PIZZA CO', amountCents: -2450, kind: 'spend', category: 'Dining & takeout' }]);
  const t = ds.transactions[0];
  assert.deepEqual(t.flags, []);
  assert.deepEqual(t.matchIds, []);
  assert.equal(t.pairId, null);
  assert.equal(t.subtype, null);
  assert.equal(t.confidence, 'medium');
  assert.equal(t.categoryReason, '');
  assert.equal(t.note, '');
  assert.equal(t.merchant, 'SAMPLE PIZZA CO');
  assert.equal(t.sourceFile, null);
  assert.equal(t.sourceRow, null);
  assert.equal(t.sourceCategory, null);
  assert.deepEqual(ds.coverageOverrides, {});
  assert.deepEqual(ds.references, []);
  assert.deepEqual(ds.notes, []);
});

test('v2: transactions are sorted by date then id', () => {
  const ds = dataset([
    tx('2026-03-05', -100, { id: 'b' }),
    tx('2026-03-01', -100, { id: 'z' }),
    tx('2026-03-05', -100, { id: 'a' })
  ]);
  assert.deepEqual(ds.transactions.map(t => t.id), ['z', 'a', 'b']);
});

test('v2: non-integer or non-numeric cents are rejected', () => {
  for (const bad of [12.5, '1250', null, NaN]) {
    const { errors } = L.validateDataset(rawDataset([tx('2026-03-01', bad, { id: 'bad' })]));
    assert.ok(errors.some(e => e.includes('amountCents')), String(bad));
  }
});

test('v2: unknown account is an error', () => {
  const { errors } = L.validateDataset(rawDataset([tx('2026-03-01', -500, { id: 'x1', accountId: 'nope' })]));
  assert.ok(errors.some(e => e.includes('unknown account "nope"')));
});

test('v2: duplicate transaction ids are an error', () => {
  const { errors } = L.validateDataset(rawDataset([tx('2026-03-01', -500, { id: 'dup' }), tx('2026-03-02', -700, { id: 'dup' })]));
  assert.ok(errors.some(e => e.includes('Duplicate transaction id "dup"')));
});

test('v2: impossible or malformed dates are errors', () => {
  for (const bad of ['2026-02-30', '2026/03/01', '03/01/2026', '', undefined]) {
    const { errors } = L.validateDataset(rawDataset([tx('2026-03-01', -500, { id: 'd1', date: bad })]));
    assert.ok(errors.some(e => e.includes('not a valid YYYY-MM-DD date')), String(bad));
  }
});

test('v2: unknown kind is an error', () => {
  const { errors } = L.validateDataset(rawDataset([tx('2026-03-01', -500, { kind: 'purchase' })]));
  assert.ok(errors.some(e => e.includes('kind "purchase"')));
});

test('v2: bad accounts and coverage ranges are errors', () => {
  const accounts = [
    { id: 'chk', label: 'Joint checking', type: 'brokerage', scope: 'joint', coverage: [] },
    { id: 'card', label: 'Card', type: 'credit_card', scope: 'shared', coverage: [{ start: '2026-05-01', end: '2026-04-01' }] }
  ];
  const { errors } = L.validateDataset(rawDataset([], { accounts }));
  assert.ok(errors.some(e => e.includes('type "brokerage"')));
  assert.ok(errors.some(e => e.includes('scope "shared"')));
  assert.ok(errors.some(e => e.includes('ends (2026-04-01) before it starts')));
});

test('v2: unsupported schema versions and non-objects are rejected', () => {
  assert.ok(L.validateDataset(rawDataset([], { schemaVersion: 3 })).errors[0].includes('schemaVersion'));
  assert.deepEqual(L.validateDataset(null).errors, ['Dataset must be an object.']);
  assert.throws(() => L.normalizeDataset([]), E.ValidationError);
});

test('v2: normalizeDataset throws a readable ValidationError; validateDataset does not throw', () => {
  const raw = rawDataset([tx('2026-03-01', 1.5, { id: 'c1' }), tx('2026-13-01', -1, { id: 'c2' })]);
  const result = L.validateDataset(raw);
  assert.equal(result.errors.length, 2);
  assert.throws(() => L.normalizeDataset(raw), err => {
    assert.ok(err instanceof E.ValidationError);
    assert.match(err.message, /c1.*amountCents/);
    assert.match(err.message, /c2.*date/);
    return true;
  });
});

test('v2: dangling links and missing categories are warnings, not errors', () => {
  const raw = rawDataset([
    tx('2026-03-01', -500, { id: 'w1', pairId: 'ghost', kind: 'transfer', subtype: 'savings', accountId: 'chk' }),
    tx('2026-03-02', -500, { id: 'w2', category: undefined, matchIds: ['ghost2'] })
  ]);
  const { errors, warnings } = L.validateDataset(raw);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some(w => w.includes('"ghost"')));
  assert.ok(warnings.some(w => w.includes('"ghost2"')));
  assert.ok(warnings.some(w => w.includes('no category')));
  const ds = L.normalizeDataset(raw);
  assert.equal(byId(ds.transactions, 'w2').category, 'Uncategorized');
});

test('v2: invalid coverage overrides are errors', () => {
  const { errors } = L.validateDataset(rawDataset([], { coverageOverrides: { '2026-3': { status: 'full' }, '2026-04': { status: 'mostly' } } }));
  assert.equal(errors.length, 2);
});

test('v2: normalizeDataset accepts JSON text and never mutates the input', () => {
  const raw = deepFreeze(rawDataset([tx('2026-03-02', -500, { id: 'j2' }), tx('2026-03-01', -300, { id: 'j1' })]));
  const before = JSON.stringify(raw);
  const ds = L.normalizeDataset(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.notEqual(ds.transactions, raw.transactions);
  const fromText = L.normalizeDataset(JSON.stringify(raw));
  assert.deepEqual(fromText, ds);
  assert.deepEqual(L.normalizeDataset('\uFEFF' + JSON.stringify(raw)), ds);
  assert.throws(() => L.normalizeDataset('{not json'), E.ValidationError);
});

test('v2: normalizing a normalized dataset is stable', () => {
  const ds = dataset([tx('2026-03-01', -500), tx('2026-03-02', 200)]);
  assert.deepEqual(L.normalizeDataset(ds), ds);
});

// ======================================================================= posted balances (dataset.balances)

test('balances: absent or not a list gives [] (never undefined), legacy data included', () => {
  assert.deepEqual(dataset([tx('2026-03-01', -100)]).balances, []);
  assert.deepEqual(dataset([tx('2026-03-01', -100)], { balances: null }).balances, []);
  assert.deepEqual(dataset([tx('2026-03-01', -100)], { balances: 'oops' }).balances, []);
  assert.deepEqual(L.normalizeDataset(loadLegacy()).balances, []);
});

test('balances: bad entries and unknown accounts are dropped; the rest is sorted by account, then date', () => {
  const ds = dataset([tx('2026-03-01', -100)], {
    balances: [
      { accountId: 'sav', date: '2026-09-30', cents: 1200000, source: 'statement', note: '  September statement  ' },
      { accountId: 'chk', date: '2026-09-30', cents: 412345, source: 'bank' },
      { accountId: 'chk', date: '2026-06-30', cents: 398700, source: 'statement' },
      { accountId: 'nowhere', date: '2026-09-30', cents: 1, source: 'statement' },
      { accountId: 'chk', date: '2026-02-30', cents: 1, source: 'statement' },
      { accountId: 'chk', date: '2026-07-31', cents: 12.5, source: 'statement' },
      { accountId: 'chk', date: '2026-07-31', cents: '100', source: 'statement' },
      { accountId: 'chk', date: '2026-08-31', cents: 100, source: 'typed' },
      { accountId: 'chk', date: '2026-08-31', cents: 100 },
      null,
      'chk 2026-08-31 100'
    ]
  });
  assert.deepEqual(ds.balances, [
    { accountId: 'chk', date: '2026-06-30', cents: 398700, source: 'statement' },
    { accountId: 'chk', date: '2026-09-30', cents: 412345, source: 'bank' },
    { accountId: 'sav', date: '2026-09-30', cents: 1200000, source: 'statement', note: 'September statement' }
  ]);
});

test('balances: one per account and date — a statement beats the bank in either order; equals: the later wins', () => {
  const statement = { accountId: 'chk', date: '2026-09-30', cents: 410000, source: 'statement' };
  const bank = { accountId: 'chk', date: '2026-09-30', cents: 412345, source: 'bank' };
  assert.deepEqual(L.normalizeBalances([statement, bank], ['chk']), [statement]);
  assert.deepEqual(L.normalizeBalances([bank, statement], ['chk']), [statement]);
  const later = { ...statement, cents: 409999 };
  assert.deepEqual(L.normalizeBalances([statement, later], ['chk']), [later]);
  assert.deepEqual(L.normalizeBalances([bank, { ...bank, cents: 1 }], new Set(['chk'])), [{ ...bank, cents: 1 }]);
});

test('balances: dropped entries are a validation warning, never an error; the input is not modified', () => {
  const raw = deepFreeze(rawDataset([tx('2026-03-01', -100)], {
    balances: [{ accountId: 'chk', date: '2026-09-30', cents: 1, source: 'statement' }, { accountId: 'nowhere', date: '2026-09-30', cents: 1, source: 'statement' }]
  }));
  const v = L.validateDataset(raw);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some(w => /1 of 2 posted balances were left out/.test(w)));
  assert.equal(L.normalizeDataset(raw).balances.length, 1);
  assert.ok(L.validateDataset(rawDataset([], { balances: {} })).warnings.includes('balances is not a list; ignored.'));
});

// ======================================================================= applyEdits

test('applyEdits returns new objects and never mutates the dataset or edits', () => {
  const ds = deepFreeze(dataset([tx('2026-03-01', -500, { id: 'm1' })]));
  const edits = deepFreeze({ m1: { category: 'Household & hardware', categoryReason: 'Paper goods', history: [] } });
  const rows = L.applyEdits(ds, edits);
  assert.notEqual(rows[0], ds.transactions[0]);
  assert.equal(ds.transactions[0].category, 'Groceries');
  assert.equal(rows[0].category, 'Household & hardware');
  assert.equal(rows[0].baseCategory, 'Groceries');
  assert.equal(rows[0].edited, true);
  rows[0].flags.push('x');
  assert.deepEqual(ds.transactions[0].flags, []);
});

test('applyEdits adds account context and default effective fields', () => {
  const ds = dataset([tx('2026-03-01', -500, { id: 'c1' })]);
  const [t] = L.applyEdits(ds, {});
  assert.equal(t.accountType, 'credit_card');
  assert.equal(t.accountScope, 'joint');
  assert.equal(t.accountLabel, 'Joint card');
  assert.equal(t.excluded, null);
  assert.equal(t.planningExcluded, false);
  assert.equal(t.edited, false);
  assert.deepEqual(t.editWarnings, []);
  assert.deepEqual(t.parts, [{ category: 'Groceries', spendCents: 500 }]);
});

test('applyEdits: a history-only edit is not counted as edited', () => {
  const ds = dataset([tx('2026-03-01', -500, { id: 'h1' })]);
  const [t] = L.applyEdits(ds, { h1: { history: [{ at: '2026-09-01T10:00:00Z', field: 'category', from: 'X', to: null, reason: 'undo' }] } });
  assert.equal(t.edited, false);
});

test('applyEdits: a kind edit changes counting and resets the old subtype', () => {
  const ds = dataset([tx('2026-03-03', -25000, { id: 'k1', accountId: 'chk', description: 'TRANSFER TO SAVINGS' })]);
  const [t] = L.applyEdits(ds, { k1: { kind: 'transfer', kindReason: 'It went to savings', history: [] } });
  assert.equal(t.kind, 'transfer');
  assert.equal(t.baseKind, 'spend');
  assert.equal(t.subtype, null);
  assert.deepEqual(t.parts, []);
  assert.equal(L.measure(t).spendCents, 0);
  const [t2] = L.applyEdits(ds, { k1: { kind: 'transfer', subtype: 'savings', history: [] } });
  assert.equal(L.measure(t2).savedCents, 25000);
});

test('applyEdits: an unknown kind edit is ignored with a warning', () => {
  const ds = dataset([tx('2026-03-03', -500, { id: 'k2' })]);
  const [t] = L.applyEdits(ds, { k2: { kind: 'gift', history: [] } });
  assert.equal(t.kind, 'spend');
  assert.equal(t.editWarnings.length, 1);
});

test('applyEdits: duplicate exclude removes the row from every total', () => {
  const ds = dataset([tx('2026-03-14', -6418, { id: 'd1' }), tx('2026-03-15', -6418, { id: 'd2' })]);
  const rows = L.applyEdits(ds, { d2: { duplicate: 'exclude', history: [] } });
  assert.equal(byId(rows, 'd2').excluded, 'duplicate');
  assert.deepEqual(byId(rows, 'd2').parts, []);
  const s = L.summarize(rows);
  assert.equal(s.spendingCents, 6418);
  assert.equal(s.excludedCents, 6418);
  assert.equal(s.excludedCount, 1);
  assert.equal(s.count, 1);
  const kept = L.applyEdits(ds, { d2: { duplicate: 'keep', history: [] } });
  assert.equal(L.summarize(kept).spendingCents, 12836);
});

function reimbursementDataset(chargeFields = {}, depositFields = {}) {
  return dataset([
    tx('2026-07-08', -48660, Object.assign({ id: 'air', description: 'SAMPLE AIRLINES', category: 'Travel', flags: ['reimbursement_candidate'] }, chargeFields)),
    tx('2026-08-21', 48660, Object.assign({ id: 'dep', accountId: 'chk', description: 'MOBILE DEPOSIT', kind: 'income', subtype: 'other', category: 'Income' }, depositFields)),
    tx('2026-08-22', -5000, { id: 'food' })
  ]);
}

test('applyEdits: reimbursement confirmed on the charge excludes the charge AND its deposit', () => {
  const ds = reimbursementDataset({ matchIds: ['dep'] });
  const before = L.summarize(L.applyEdits(ds, {}));
  assert.equal(before.spendingCents, 53660);
  assert.equal(before.incomeCents, 48660);
  const rows = L.applyEdits(ds, { air: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'air').excluded, 'reimbursed');
  assert.equal(byId(rows, 'dep').excluded, 'reimbursed');
  const after = L.summarize(rows);
  assert.equal(after.spendingCents, 5000);
  assert.equal(after.incomeCents, 0);
  assert.equal(after.excludedIncomeCents, 48660);
});

test('applyEdits: reimbursement confirmed on the deposit works when only the charge links to it', () => {
  const ds = reimbursementDataset({ matchIds: ['dep'] });
  const rows = L.applyEdits(ds, { dep: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'air').excluded, 'reimbursed');
  assert.equal(byId(rows, 'dep').excluded, 'reimbursed');
  assert.equal(byId(rows, 'air').reimbursementStatus, 'confirmed');
});

test('applyEdits: reimbursement confirmed on a charge linked from the deposit side', () => {
  const ds = reimbursementDataset({}, { matchIds: ['air'] });
  const rows = L.applyEdits(ds, { air: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'dep').excluded, 'reimbursed');
  assert.equal(byId(rows, 'food').excluded, null);
});

test('applyEdits: a confirmed reimbursement with no linked deposit excludes only that charge', () => {
  const ds = reimbursementDataset();
  const rows = L.applyEdits(ds, { air: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'air').excluded, 'reimbursed');
  assert.equal(byId(rows, 'dep').excluded, null);
});

test('applyEdits: not_reimbursed and pending keep both sides counted', () => {
  const ds = reimbursementDataset({ matchIds: ['dep'] });
  for (const status of ['not_reimbursed', 'pending']) {
    const rows = L.applyEdits(ds, { air: { reimbursement: status, history: [] } });
    assert.equal(byId(rows, 'air').excluded, null);
    assert.equal(byId(rows, 'dep').excluded, null);
    assert.equal(byId(rows, 'air').reimbursementStatus, status);
  }
});

test('applyEdits: a deposit pays back at most one charge, preferring the exact amount', () => {
  const ds = dataset([
    tx('2026-07-01', -10000, { id: 'c-a', flags: ['reimbursement_candidate'], matchIds: ['dep'] }),
    tx('2026-07-02', -20000, { id: 'c-b', flags: ['reimbursement_candidate'], matchIds: ['dep'] }),
    tx('2026-07-20', 20000, { id: 'dep', accountId: 'chk', kind: 'income', subtype: 'other' })
  ]);
  const links = L.reimbursementLinks(L.applyEdits(ds, {}));
  assert.deepEqual(links.find(p => p.depositId === 'dep').chargeId, 'c-b');
  assert.equal(links.find(p => p.chargeId === 'c-a').depositId, null);
});

test('applyEdits: business decision excludes the charge; household keeps it', () => {
  const ds = dataset([tx('2026-04-02', -8899, { id: 'hd', description: 'SAMPLE HARDWARE', flags: ['business_candidate'] })]);
  assert.equal(L.applyEdits(ds, { hd: { business: 'business', history: [] } })[0].excluded, 'business');
  assert.equal(L.applyEdits(ds, { hd: { business: 'household', history: [] } })[0].excluded, null);
  assert.equal(L.applyEdits(ds, {})[0].businessStatus, 'pending');
});

test('applyEdits: a business decision on a non-spend row is ignored', () => {
  const ds = dataset([tx('2026-04-02', 120000, { id: 'pay', accountId: 'chk', kind: 'income', subtype: 'payroll' })]);
  const [t] = L.applyEdits(ds, { pay: { business: 'business', history: [] } });
  assert.equal(t.excluded, null);
  assert.equal(t.businessStatus, null);
});

test('applyEdits: what-if excludes pending reimbursements on both sides', () => {
  const ds = reimbursementDataset({ matchIds: ['dep'] });
  const off = L.applyEdits(ds, {});
  assert.equal(byId(off, 'air').excluded, null);
  const rows = L.applyEdits(ds, {}, { whatIf: { excludePendingReimbursements: true } });
  assert.equal(byId(rows, 'air').excluded, 'what_if');
  assert.equal(byId(rows, 'dep').excluded, 'what_if');
  const notReimbursed = L.applyEdits(ds, { air: { reimbursement: 'not_reimbursed', history: [] } }, { whatIf: { excludePendingReimbursements: true } });
  assert.equal(byId(notReimbursed, 'air').excluded, null);
  const confirmed = L.applyEdits(ds, { dep: { reimbursement: 'confirmed', history: [] } }, { whatIf: { excludePendingReimbursements: true } });
  assert.equal(byId(confirmed, 'air').excluded, 'reimbursed');
});

test('applyEdits: what-if excludes business candidates unless marked household', () => {
  const ds = dataset([
    tx('2026-04-02', -8899, { id: 'b1', flags: ['business_candidate'] }),
    tx('2026-04-03', -4500, { id: 'b2', flags: ['business_candidate'] }),
    tx('2026-04-04', -1000, { id: 'plain' })
  ]);
  const rows = L.applyEdits(ds, { b2: { business: 'household', history: [] } }, { whatIf: { excludeBusinessCandidates: true } });
  assert.equal(byId(rows, 'b1').excluded, 'what_if');
  assert.equal(byId(rows, 'b2').excluded, null);
  assert.equal(byId(rows, 'plain').excluded, null);
  assert.equal(L.summarize(rows).spendingCents, 5500);
});

test('applyEdits: planning exclusion leaves actual totals intact', () => {
  const ds = dataset([tx('2026-08-04', -86000, { id: 'dent', category: 'Dental' }), tx('2026-08-05', -5000)]);
  const rows = L.applyEdits(ds, { dent: { planningBaseline: 'exclude', history: [] } });
  const t = byId(rows, 'dent');
  assert.equal(t.planningExcluded, true);
  assert.equal(t.excluded, null);
  assert.equal(L.summarize(rows).spendingCents, 91000);
  assert.equal(L.group(rows, 'month')[0].spendCents, 91000);
  assert.equal(L.group(rows, 'month', { planning: true })[0].spendCents, 5000);
});

test('applyEdits: valid splits become parts that group into their categories', () => {
  const ds = dataset([tx('2026-05-06', -21000, { id: 'cost', description: 'SAMPLE WAREHOUSE', category: 'Mixed retail', flags: ['mixed_retail'] })]);
  const splits = [{ category: 'Groceries', cents: 15000 }, { category: 'Household & hardware', cents: 6000 }];
  const rows = L.applyEdits(ds, { cost: { splits, history: [] } });
  assert.deepEqual(rows[0].parts, [{ category: 'Groceries', spendCents: 15000 }, { category: 'Household & hardware', spendCents: 6000 }]);
  assert.equal(rows[0].splitApplied, true);
  const groups = L.group(rows, 'category');
  assert.deepEqual(groups.map(g => [g.key, g.spendCents, g.ids]), [['Groceries', 15000, ['cost']], ['Household & hardware', 6000, ['cost']]]);
  assert.equal(L.summarize(rows).spendingCents, 21000);
});

test('applyEdits: splits that do not add up are ignored with a warning', () => {
  const ds = dataset([tx('2026-05-06', -21000, { id: 'cost', category: 'Mixed retail' })]);
  const bad = [
    [{ category: 'Groceries', cents: 15000 }, { category: 'Household & hardware', cents: 5000 }],
    [{ category: '', cents: 15000 }, { category: 'Household & hardware', cents: 6000 }],
    [{ category: 'Groceries', cents: 150.5 }, { category: 'Household & hardware', cents: 20849.5 }],
    []
  ];
  for (const splits of bad) {
    const [t] = L.applyEdits(ds, { cost: { splits, history: [] } });
    assert.deepEqual(t.parts, [{ category: 'Mixed retail', spendCents: 21000 }]);
    assert.equal(t.splitApplied, false);
    assert.equal(t.editWarnings.length, 1);
    assert.match(t.editWarnings[0], /^Split ignored/);
  }
});

test('applyEdits: a refund can be split as long as the parts add up to the negative spend', () => {
  const ds = dataset([tx('2026-05-06', 3000, { id: 'ref', category: 'Mixed retail' })]);
  const [t] = L.applyEdits(ds, { ref: { splits: [{ category: 'Clothing', cents: -2000 }, { category: 'Electronics', cents: -1000 }], history: [] } });
  assert.deepEqual(t.parts.map(p => p.spendCents), [-2000, -1000]);
});

test('applyEdits: splits on a non-spend row are ignored with a warning', () => {
  const ds = dataset([tx('2026-05-01', 120000, { id: 'pay', accountId: 'chk', kind: 'income', subtype: 'payroll' })]);
  const [t] = L.applyEdits(ds, { pay: { splits: [{ category: 'A', cents: 120000 }], history: [] } });
  assert.deepEqual(t.parts, []);
  assert.equal(t.editWarnings.length, 1);
});

test('applyEdits: a user note replaces the shown note but the import note stays searchable', () => {
  const ds = dataset([tx('2026-05-01', -500, { id: 'n1', note: 'import note' })]);
  const [t] = L.applyEdits(ds, { n1: { note: 'Birthday gift for Sam', history: [] } });
  assert.equal(t.note, 'Birthday gift for Sam');
  assert.equal(t.baseNote, 'import note');
  assert.equal(L.filter([t], { query: 'import' }).length, 1);
});

// ======================================================================= measure & summarize

test('measure: purchases and refunds', () => {
  const ds = dataset([tx('2026-03-01', -12000, { id: 'p' }), tx('2026-03-02', 2500, { id: 'r' })]);
  const rows = L.applyEdits(ds, {});
  assert.deepEqual(L.measure(byId(rows, 'p')), { spendCents: 12000, incomeCents: 0, debtCents: 0, savedCents: 0, contributionCents: 0 });
  assert.equal(L.measure(byId(rows, 'r')).spendCents, -2500);
  const s = L.summarize(rows);
  assert.equal(s.purchasesCents, 12000);
  assert.equal(s.refundsCents, 2500);
  assert.equal(s.spendingCents, 9500);
});

test('measure: zero results are +0, never -0', () => {
  const ds = dataset([tx('2026-03-01', 0, { id: 'z', kind: 'card_payment', accountId: 'chk' })]);
  const m = L.measure(L.applyEdits(ds, {})[0]);
  for (const v of Object.values(m)) assert.ok(Object.is(v, 0));
});

test('measure: income, payroll and interest', () => {
  const ds = dataset([
    tx('2026-03-06', 188000, { id: 'pay', accountId: 'chk', kind: 'income', subtype: 'payroll', category: 'Income' }),
    tx('2026-03-31', 410, { id: 'int', accountId: 'sav', kind: 'income', subtype: 'interest', category: 'Income' })
  ]);
  const rows = L.applyEdits(ds, {});
  assert.equal(L.measure(byId(rows, 'pay')).incomeCents, 188000);
  const s = L.summarize(rows);
  assert.equal(s.incomeCents, 188410);
  assert.equal(s.payrollCents, 188000);
  assert.equal(s.spendingCents, 0);
});

test('measure: debt payments are their own outflow, not spending', () => {
  const ds = dataset([tx('2026-03-09', -5500, { id: 'sc', accountId: 'chk', kind: 'debt_payment', subtype: 'store_card' })]);
  const rows = L.applyEdits(ds, {});
  assert.equal(L.measure(rows[0]).debtCents, 5500);
  assert.equal(L.measure(rows[0]).spendCents, 0);
  assert.equal(L.summarize(rows).debtPaymentsCents, 5500);
  assert.deepEqual(rows[0].parts, []);
});

test('measure: card payments are excluded; only the paying side is reported', () => {
  const ds = dataset([
    tx('2026-03-25', -91234, { id: 'cp-chk', accountId: 'chk', kind: 'card_payment', pairId: 'cp-card' }),
    tx('2026-03-25', 91234, { id: 'cp-card', accountId: 'card', kind: 'card_payment', pairId: 'cp-chk' }),
    tx('2026-03-10', -91234, { id: 'groc' })
  ]);
  const rows = L.applyEdits(ds, {});
  for (const id of ['cp-chk', 'cp-card']) assert.deepEqual(L.measure(byId(rows, id)), { spendCents: 0, incomeCents: 0, debtCents: 0, savedCents: 0, contributionCents: 0 });
  const s = L.summarize(rows);
  assert.equal(s.spendingCents, 91234);
  assert.equal(s.cardPaymentsCents, 91234);
  assert.equal(s.incomeCents, 0);
});

test('measure: both sides of a savings transfer are counted once', () => {
  const ds = dataset([
    tx('2026-06-02', -25000, { id: 'out', accountId: 'chk', kind: 'transfer', subtype: 'savings', pairId: 'in' }),
    tx('2026-06-02', 25000, { id: 'in', accountId: 'sav', kind: 'transfer', subtype: 'savings', pairId: 'out' })
  ]);
  const rows = L.applyEdits(ds, {});
  assert.equal(L.measure(byId(rows, 'out')).savedCents, 25000);
  assert.equal(L.measure(byId(rows, 'in')).savedCents, 0);
  assert.equal(L.summarize(rows).savedNetCents, 25000);
});

test('measure: a withdrawal from savings is negative saving, counted once', () => {
  const ds = dataset([
    tx('2026-06-10', -40000, { id: 'w-sav', accountId: 'sav', kind: 'transfer', subtype: 'savings', pairId: 'w-chk' }),
    tx('2026-06-10', 40000, { id: 'w-chk', accountId: 'chk', kind: 'transfer', subtype: 'savings', pairId: 'w-sav' })
  ]);
  assert.equal(L.summarize(L.applyEdits(ds, {})).savedNetCents, -40000);
});

test('measure: a lone savings-side row counts when its other side is not in the data', () => {
  const ds = dataset([
    tx('2026-06-02', 25000, { id: 'lone', accountId: 'sav', kind: 'transfer', subtype: 'savings' }),
    tx('2026-07-02', 25000, { id: 'dangling', accountId: 'sav', kind: 'transfer', subtype: 'savings', pairId: 'not-imported' })
  ]);
  const rows = L.applyEdits(ds, {});
  assert.equal(L.measure(byId(rows, 'lone')).savedCents, 25000);
  assert.equal(byId(rows, 'dangling').pairMissing, true);
  assert.equal(L.measure(byId(rows, 'dangling')).savedCents, 25000);
});

test('measure: a lone cash-side savings transfer counts as saved', () => {
  const ds = dataset([tx('2026-06-02', -25000, { id: 'o', accountId: 'chk', kind: 'transfer', subtype: 'savings' })]);
  assert.equal(L.summarize(L.applyEdits(ds, {})).savedNetCents, 25000);
});

test('measure: investment transfers count as saved', () => {
  const ds = dataset([tx('2026-06-03', -5000, { id: 'inv', accountId: 'chk', kind: 'transfer', subtype: 'investment' })]);
  assert.equal(L.measure(L.applyEdits(ds, {})[0]).savedCents, 5000);
});

test('measure: contributions arriving in a joint account count; personal-side rows do not', () => {
  const ds = dataset([
    tx('2026-06-01', 132500, { id: 'c-joint', accountId: 'chk', kind: 'transfer', subtype: 'contribution', description: 'ONLINE TRANSFER FROM SAM' }),
    tx('2026-06-01', -132500, { id: 'c-personal', accountId: 'alex-chk', kind: 'transfer', subtype: 'contribution' })
  ]);
  const rows = L.applyEdits(ds, {});
  assert.equal(L.measure(byId(rows, 'c-joint')).contributionCents, 132500);
  assert.equal(L.measure(byId(rows, 'c-personal')).contributionCents, 0);
  const s = L.summarize(rows);
  assert.equal(s.contributionsCents, 132500);
  assert.equal(s.incomeCents, 0);
  assert.equal(s.savedNetCents, 0);
});

test('measure: internal transfers count as nothing', () => {
  const ds = dataset([tx('2026-05-11', 50000, { id: 'int', accountId: 'chk', kind: 'transfer', subtype: 'internal' })]);
  assert.deepEqual(L.measure(L.applyEdits(ds, {})[0]), { spendCents: 0, incomeCents: 0, debtCents: 0, savedCents: 0, contributionCents: 0 });
});

test('measure: excluded rows contribute nothing', () => {
  const ds = dataset([tx('2026-05-11', -5000, { id: 'x' })]);
  const [t] = L.applyEdits(ds, { x: { duplicate: 'exclude', history: [] } });
  assert.deepEqual(L.measure(t), { spendCents: 0, incomeCents: 0, debtCents: 0, savedCents: 0, contributionCents: 0 });
  assert.equal(L.measure(null).spendCents, 0);
});

// ======================================================================= filter

function filterDataset() {
  return dataset([
    tx('2026-07-08', -48660, { id: 'air', description: 'SAMPLE AIRLINES 0123', merchant: 'Sample Airlines', category: 'Travel', sourceCategory: 'Travel', flags: ['reimbursement_candidate'] }),
    tx('2026-08-21', 48660, { id: 'dep', accountId: 'chk', description: 'MOBILE DEPOSIT', kind: 'income', subtype: 'other', category: 'Income' }),
    tx('2026-08-22', -87245, { id: 'big', accountId: 'chk', description: 'SAMPLE ROOFING', category: 'Home maintenance & repairs', note: 'gutter repair' }),
    tx('2026-08-23', -123450, { id: 'comma', accountId: 'chk', description: 'SAMPLE APPLIANCE', category: 'Electronics' }),
    tx('2026-08-24', -4800, { id: 'pets', description: 'SAMPLE PET SUPPLY', category: 'Pets', sourceCategory: 'Shopping', flags: ['mixed_retail', 'needs_category_review'] }),
    tx('2026-08-25', -2000, { id: 'alex', accountId: 'alex-chk', description: 'SAMPLE BOOKSHOP', category: 'Hobbies' }),
    tx('2026-09-01', -48661, { id: 'near', description: 'SAMPLE TRAVEL AGENCY', category: 'Travel' })
  ]);
}

test('filter: amount queries match the absolute amount exactly', () => {
  const rows = L.applyEdits(filterDataset(), {});
  const ids = q => L.filter(rows, { query: q }).map(t => t.id).sort();
  assert.deepEqual(ids('486.60'), ['air', 'dep']);
  assert.deepEqual(ids('$486.60'), ['air', 'dep']);
  assert.deepEqual(ids('-486.60'), ['air', 'dep']);
  assert.deepEqual(ids('872.45'), ['big']);
  assert.deepEqual(ids('$872.45'), ['big']);
  assert.deepEqual(ids('1,234.50'), ['comma']);
  assert.deepEqual(ids('486.61'), ['near']);
  assert.deepEqual(ids('486.62'), []);
});

test('filter: text query is case-insensitive across merchant, description, category, source category, note and account', () => {
  const rows = L.applyEdits(filterDataset(), {});
  const ids = q => L.filter(rows, { query: q }).map(t => t.id).sort();
  assert.deepEqual(ids('sample airlines'), ['air']);
  assert.deepEqual(ids('mobile'), ['dep']);
  assert.deepEqual(ids('GUTTER'), ['big']);
  assert.deepEqual(ids('shopping'), ['pets']);
  assert.deepEqual(ids('hobbies'), ['alex']);
  assert.deepEqual(ids('alex personal'), ['alex']);
  assert.deepEqual(ids('   '), rows.map(t => t.id).sort());
});

test('filter: dates are inclusive and months, accounts, kinds and merchant narrow results', () => {
  const rows = L.applyEdits(filterDataset(), {});
  const ids = o => L.filter(rows, o).map(t => t.id);
  assert.deepEqual(ids({ start: '2026-08-21', end: '2026-08-22' }), ['dep', 'big']);
  assert.deepEqual(ids({ months: ['2026-07', '2026-09'] }), ['air', 'near']);
  assert.deepEqual(ids({ accountIds: ['chk'] }), ['dep', 'big', 'comma']);
  assert.deepEqual(ids({ kinds: ['income'] }), ['dep']);
  assert.deepEqual(ids({ merchant: 'Sample Airlines' }), ['air']);
  assert.deepEqual(ids({ merchant: 'sample airlines' }), []);
});

test('filter: scope joint keeps only joint accounts; all keeps everything', () => {
  const rows = L.applyEdits(filterDataset(), {});
  assert.ok(!L.filter(rows, { scope: 'joint' }).some(t => t.id === 'alex'));
  assert.equal(L.filter(rows, { scope: 'all' }).length, rows.length);
  assert.equal(L.filter(rows, {}).length, rows.length);
  assert.deepEqual(L.filter(rows, { scope: 'personal' }).map(t => t.id), ['alex']);
});

test('filter: flags must all be present', () => {
  const rows = L.applyEdits(filterDataset(), {});
  assert.deepEqual(L.filter(rows, { flags: ['mixed_retail'] }).map(t => t.id), ['pets']);
  assert.deepEqual(L.filter(rows, { flags: ['mixed_retail', 'needs_category_review'] }).map(t => t.id), ['pets']);
  assert.deepEqual(L.filter(rows, { flags: ['mixed_retail', 'refund'] }), []);
});

test('filter: category matches the row category or any split part', () => {
  const ds = dataset([tx('2026-05-06', -21000, { id: 'cost', category: 'Mixed retail' }), tx('2026-05-07', -900, { id: 'g' })]);
  const rows = L.applyEdits(ds, { cost: { splits: [{ category: 'Groceries', cents: 15000 }, { category: 'Pets', cents: 6000 }], history: [] } });
  assert.deepEqual(L.filter(rows, { category: 'Pets' }).map(t => t.id), ['cost']);
  assert.deepEqual(L.filter(rows, { category: 'Groceries' }).map(t => t.id), ['cost', 'g']);
  // Once split, the row lives only in its parts' categories (matches group('category')).
  assert.deepEqual(L.filter(rows, { category: 'Mixed retail' }).map(t => t.id), []);
});

test('filter: excluded rows are hidden unless includeExcluded', () => {
  const rows = L.applyEdits(filterDataset(), { big: { duplicate: 'exclude', history: [] } });
  assert.ok(!L.filter(rows).some(t => t.id === 'big'));
  assert.ok(L.filter(rows, { includeExcluded: true }).some(t => t.id === 'big'));
});

// ======================================================================= group

test('group: months are chronological; categories, merchants and accounts sort by spend', () => {
  const ds = dataset([
    tx('2026-05-02', -3000, { merchant: 'Corner Cafe', category: 'Dining & takeout' }),
    tx('2026-03-02', -10000, { merchant: 'Sample Grocer' }),
    tx('2026-04-02', -2000, { merchant: 'Sample Grocer' }),
    tx('2026-04-03', -50000, { accountId: 'chk', merchant: 'Sample Servicer', category: 'Mortgage' }),
    tx('2026-04-04', 1000, { merchant: 'Sample Grocer' }),
    tx('2026-04-05', 300000, { accountId: 'chk', kind: 'income', subtype: 'payroll' })
  ]);
  const rows = L.applyEdits(ds, {});
  assert.deepEqual(L.group(rows, 'month').map(g => [g.key, g.spendCents, g.count]), [['2026-03', 10000, 1], ['2026-04', 51000, 3], ['2026-05', 3000, 1]]);
  assert.deepEqual(L.group(rows, 'category').map(g => [g.key, g.spendCents]), [['Mortgage', 50000], ['Groceries', 11000], ['Dining & takeout', 3000]]);
  assert.equal(L.group(rows, 'category')[0].group, 'Housing');
  assert.deepEqual(L.group(rows, 'merchant').map(g => [g.key, g.spendCents, g.count]), [['Sample Servicer', 50000, 1], ['Sample Grocer', 11000, 3], ['Corner Cafe', 3000, 1]]);
  assert.deepEqual(L.group(rows, 'account').map(g => [g.key, g.label, g.spendCents]), [['chk', 'Joint checking', 50000], ['card', 'Joint card', 14000]]);
  assert.throws(() => L.group(rows, 'week'), E.ValidationError);
});

test('group: excluded rows are never grouped', () => {
  const ds = dataset([tx('2026-03-02', -10000, { id: 'a' }), tx('2026-03-03', -10000, { id: 'b' })]);
  const rows = L.applyEdits(ds, { b: { duplicate: 'exclude', history: [] } });
  assert.deepEqual(L.group(rows, 'category').map(g => [g.spendCents, g.ids]), [[10000, ['a']]]);
});

// ======================================================================= months & coverage

function coverageDataset(extra = {}) {
  return dataset([tx('2025-12-30', -500, { id: 'early', accountId: 'chk' })], Object.assign({
    accounts: [
      { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-06-30' }] },
      { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [{ start: '2026-03-12', end: '2026-04-30' }, { start: '2026-05-06', end: '2026-06-30' }] },
      { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint', coverage: [{ start: '2026-02-01', end: '2026-06-15' }] }
    ]
  }, extra));
}

test('months: spans the earliest coverage or transaction to the latest', () => {
  assert.deepEqual(L.months(coverageDataset()), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.deepEqual(L.months(dataset([], { accounts: [] })), []);
});

test('coverage: an account starting mid-month makes that month partial', () => {
  const ds = coverageDataset();
  const mar = L.coverage(ds, '2026-03');
  assert.equal(mar.status, 'partial');
  assert.equal(mar.coveredDays, 20);
  assert.equal(mar.totalDays, 31);
  assert.deepEqual(mar.accounts.map(a => [a.accountId, a.coveredDays]), [['chk', 31], ['card', 20]]);
  assert.match(mar.note, /Joint card covers 20 of 31 days/);
  assert.equal(L.coverage(ds, '2026-04').status, 'full');
});

test('coverage: an expected account with no export yet makes the month partial, not full', () => {
  const ds = coverageDataset();
  const jan = L.coverage(ds, '2026-01');
  assert.equal(jan.status, 'partial');
  assert.equal(jan.coveredDays, 0);
  assert.equal(jan.accounts.find(a => a.accountId === 'card').expected, true);
});

test('coverage: a gap between two ranges makes the month partial', () => {
  const may = L.coverage(coverageDataset(), '2026-05');
  assert.equal(may.status, 'partial');
  assert.equal(may.coveredDays, 26);
});

test('coverage: savings gaps do not make spending months partial, but do for purpose all', () => {
  const ds = coverageDataset();
  assert.equal(L.coverage(ds, '2026-06').status, 'full');
  assert.ok(!L.coverage(ds, '2026-06').accounts.some(a => a.accountId === 'sav'));
  const all = L.coverage(ds, '2026-06', { purpose: 'all' });
  assert.equal(all.status, 'partial');
  assert.equal(all.coveredDays, 15);
});

test('coverage: months outside every expected account are none', () => {
  const ds = coverageDataset();
  const dec = L.coverage(ds, '2025-12');
  assert.equal(dec.status, 'none');
  assert.equal(dec.coveredDays, 0);
  assert.equal(L.coverage(ds, '2026-07').status, 'none');
});

test('coverage: overrides win both ways and keep the computed facts', () => {
  const ds = coverageDataset({ coverageOverrides: { '2026-03': { status: 'full', note: 'Card statement checked by hand' }, '2026-04': { status: 'partial' } } });
  const mar = L.coverage(ds, '2026-03');
  assert.equal(mar.status, 'full');
  assert.equal(mar.overridden, true);
  assert.equal(mar.computedStatus, 'partial');
  assert.equal(mar.coveredDays, 20);
  assert.equal(mar.note, 'Card statement checked by hand');
  const apr = L.coverage(ds, '2026-04');
  assert.equal(apr.status, 'partial');
  assert.match(apr.note, /set manually/);
});

test('coverage: coverageMap and latestCompleteMonth', () => {
  const ds = coverageDataset();
  const map = L.coverageMap(ds);
  assert.deepEqual(Object.keys(map), L.months(ds));
  assert.equal(map['2026-04'].status, 'full');
  assert.equal(L.latestCompleteMonth(ds), '2026-06');
  assert.equal(L.latestCompleteMonth(coverageDataset({ coverageOverrides: { '2026-06': { status: 'partial' } } })), '2026-04');
  assert.equal(L.latestCompleteMonth(dataset([], { accounts: [] })), null);
});

test('coverage: rejects malformed months', () => {
  assert.throws(() => L.coverage(coverageDataset(), '2026-3'), E.ValidationError);
});

// ======================================================================= hardening: partial reimbursements
// A confirmed reimbursement whose deposit does not equal the charge must not make the
// difference disappear: only the amount actually paid back leaves the totals.

function mismatchDataset(chargeCents, depositCents, depositFields = {}) {
  return dataset([
    tx('2026-07-08', 0 - chargeCents, { id: 'trip', description: 'SAMPLE AIRLINES', category: 'Travel', flags: ['reimbursement_candidate'], matchIds: ['back'] }),
    tx('2026-07-20', depositCents, Object.assign({ id: 'back', accountId: 'chk', description: 'MOBILE DEPOSIT', kind: 'income', subtype: 'other', category: 'Income', flags: ['reimbursement_candidate'] }, depositFields))
  ]);
}

test('hardening: a deposit smaller than the charge leaves the unreimbursed part in spending', () => {
  const ds = mismatchDataset(30000, 20000);
  const rows = L.applyEdits(ds, { trip: { reimbursement: 'confirmed', history: [] } });
  const s = L.summarize(rows);
  // The household paid $300 and got $200 back: $100 is still its own cost.
  assert.equal(s.spendingCents, 10000);
  assert.equal(s.incomeCents, 0);
  assert.equal(s.excludedCents, 20000);
  assert.equal(s.excludedIncomeCents, 20000);
  assert.equal(byId(rows, 'back').excluded, 'reimbursed');
  const trip = byId(rows, 'trip');
  assert.equal(trip.excluded, null);
  assert.equal(trip.reimbursedCents, 20000);
  assert.equal(L.measure(trip).spendCents, 10000);
  assert.deepEqual(trip.parts, [{ category: 'Travel', spendCents: 10000 }]);
  assert.deepEqual(L.group(rows, 'category').map(g => [g.key, g.spendCents]), [['Travel', 10000]]);
  assert.ok(trip.editWarnings.some(w => /\$200\.00 of this \$300\.00/.test(w)), trip.editWarnings.join(' '));
});

test('hardening: a deposit larger than the charge keeps the extra as income', () => {
  const ds = mismatchDataset(20000, 30000);
  const rows = L.applyEdits(ds, { back: { reimbursement: 'confirmed', history: [] } });
  const s = L.summarize(rows);
  assert.equal(byId(rows, 'trip').excluded, 'reimbursed');
  assert.equal(byId(rows, 'back').excluded, null);
  assert.equal(byId(rows, 'back').reimbursedCents, 20000);
  assert.equal(s.spendingCents, 0);
  assert.equal(s.incomeCents, 10000);
  assert.equal(s.excludedIncomeCents, 20000);
});

test('hardening: equal amounts still exclude both sides completely', () => {
  const rows = L.applyEdits(mismatchDataset(20000, 20000), { trip: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'trip').excluded, 'reimbursed');
  assert.equal(byId(rows, 'back').excluded, 'reimbursed');
  assert.equal(byId(rows, 'trip').reimbursedCents, 0);
  assert.equal(L.summarize(rows).spendingCents, 0);
});

test('hardening: a split, partly reimbursed charge shrinks its parts to the amount still counted', () => {
  const ds = mismatchDataset(30001, 10000);
  const edits = {
    trip: { reimbursement: 'confirmed', splits: [{ category: 'Travel', cents: 20001 }, { category: 'Dining & takeout', cents: 10000 }], history: [] }
  };
  const trip = byId(L.applyEdits(ds, edits), 'trip');
  assert.equal(trip.splitApplied, true);
  const total = trip.parts.reduce((sum, p) => sum + p.spendCents, 0);
  assert.equal(total, 20001);
  assert.equal(total, L.measure(trip).spendCents);
  assert.deepEqual(trip.parts.map(p => p.category), ['Travel', 'Dining & takeout']);
  assert.ok(trip.parts.every(p => Number.isInteger(p.spendCents)));
});

test('hardening: the what-if toggle also only removes what the deposit covers', () => {
  const rows = L.applyEdits(mismatchDataset(30000, 20000), {}, { whatIf: { excludePendingReimbursements: true } });
  assert.equal(byId(rows, 'back').excluded, 'what_if');
  assert.equal(byId(rows, 'trip').excluded, null);
  assert.equal(L.summarize(rows).spendingCents, 10000);
  assert.ok(byId(rows, 'trip').editWarnings.some(w => /^What-if: assuming \$200\.00 of this \$300\.00 charge is paid back/.test(w)), byId(rows, 'trip').editWarnings.join(' '));
  // Without the toggle nothing changes.
  assert.equal(L.summarize(L.applyEdits(mismatchDataset(30000, 20000), {})).spendingCents, 30000);
});

test('hardening: a duplicate or business decision still removes a partly reimbursed charge entirely', () => {
  const ds = mismatchDataset(30000, 20000);
  const dup = L.applyEdits(ds, { trip: { reimbursement: 'confirmed', duplicate: 'exclude', history: [] } });
  assert.equal(byId(dup, 'trip').excluded, 'duplicate');
  assert.equal(L.measure(byId(dup, 'trip')).spendCents, 0);
  const biz = L.applyEdits(ds, { trip: { reimbursement: 'confirmed', business: 'business', history: [] } });
  assert.equal(byId(biz, 'trip').excluded, 'business');
  assert.equal(L.summarize(biz).spendingCents, 0);
});

// ======================================================================= hardening: coverage of accounts without exports

function noExportDataset(extra) {
  return dataset([tx('2026-02-10', -5000, { accountId: 'chk' })], Object.assign({
    accounts: [
      { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-03-31' }] },
      { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [] },
      { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint' }
    ]
  }, extra || {}));
}

test('hardening: a spending account with no export at all keeps months partial (its spending is unknown)', () => {
  const ds = noExportDataset();
  const feb = L.coverage(ds, '2026-02');
  assert.equal(feb.status, 'partial');
  assert.equal(feb.coveredDays, 0);
  const card = feb.accounts.find(a => a.accountId === 'card');
  assert.deepEqual([card.coveredDays, card.missingDays, card.expected], [0, 28, true]);
  assert.match(feb.note, /Joint card covers 0 of 28 days/);
  assert.equal(L.latestCompleteMonth(ds), null);
  // A savings account without exports still does not affect spending completeness.
  assert.ok(!feb.accounts.some(a => a.accountId === 'sav'));
});

test('hardening: ledger coverage agrees with the importer month summary for accounts without exports', () => {
  if (!E.importer || typeof E.importer.monthlySummary !== 'function') return;
  const ds = noExportDataset();
  for (const row of E.importer.monthlySummary(ds)) assert.equal(L.coverage(ds, row.month).status, row.spendingCoverage, row.month);
});

test('hardening: with only export-less accounts every month is none, and an override still wins', () => {
  const ds = dataset([], { accounts: [{ id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [] }] });
  assert.equal(L.coverage(ds, '2026-02').status, 'none');
  const ds2 = noExportDataset({ coverageOverrides: { '2026-02': { status: 'full', note: 'Card unused this month' } } });
  assert.equal(L.coverage(ds2, '2026-02').status, 'full');
  assert.equal(L.coverage(ds2, '2026-03').status, 'partial');
});

test('hardening: a contribution that partly paid back a charge counts only its remainder', () => {
  const ds = mismatchDataset(20000, 50000, { kind: 'transfer', subtype: 'contribution', description: 'ONLINE TRANSFER FROM SAM PERSONAL', category: 'Transfer' });
  const rows = L.applyEdits(ds, { trip: { reimbursement: 'confirmed', history: [] } });
  assert.equal(byId(rows, 'trip').excluded, 'reimbursed');
  assert.equal(byId(rows, 'back').reimbursedCents, 20000);
  assert.equal(L.summarize(rows).contributionsCents, 30000);
});

test('hardening: counting identities hold under random edits and what-if toggles (inputs frozen)', () => {
  let seed = 2026;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = list => list[Math.floor(rnd() * list.length)];
  for (let iter = 0; iter < 40; iter++) {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const kind = pick(['spend', 'spend', 'spend', 'income', 'transfer', 'card_payment', 'debt_payment']);
      const sign = kind === 'income' || rnd() < 0.15 ? 1 : -1;
      rows.push(tx(pick(['2026-02', '2026-04', '2026-06', '2026-08']) + '-1' + Math.floor(rnd() * 9), sign * (1 + Math.floor(rnd() * 90000)), {
        id: 'f' + iter + '-' + i, accountId: pick(['chk', 'card', 'sav', 'alex-chk']), kind,
        subtype: kind === 'transfer' ? pick(['savings', 'contribution', 'internal']) : kind === 'income' ? 'other' : null,
        category: pick(['Groceries', 'Travel', 'Dental']), flags: rnd() < 0.15 ? ['reimbursement_candidate'] : rnd() < 0.1 ? ['business_candidate'] : []
      }));
    }
    for (let k = 0; k < 5; k++) { const a = pick(rows), b = pick(rows); if (a !== b) a.matchIds = [b.id]; }
    const ds = deepFreeze(dataset(rows));
    const edits = {};
    for (const t of ds.transactions) {
      const r = rnd();
      if (r < 0.05) edits[t.id] = { duplicate: 'exclude' };
      else if (r < 0.12) edits[t.id] = { reimbursement: pick(['confirmed', 'pending', 'not_reimbursed']) };
      else if (r < 0.15) edits[t.id] = { business: pick(['business', 'household']) };
      else if (r < 0.2 && t.kind === 'spend') {
        const third = Math.trunc(-t.amountCents / 3);
        edits[t.id] = { splits: [{ category: 'Groceries', cents: third }, { category: 'Travel', cents: -t.amountCents - third }] };
      }
    }
    deepFreeze(edits);
    for (const whatIf of [{}, { excludePendingReimbursements: true, excludeBusinessCandidates: true }]) {
      const eff = L.applyEdits(ds, edits, { whatIf });
      for (const t of eff) {
        const m = L.measure(t);
        if (t.excluded) assert.ok(Object.values(m).every(v => v === 0), t.id);
        else if (t.kind === 'spend') assert.equal(t.parts.reduce((s, p) => s + p.spendCents, 0), m.spendCents, t.id);
      }
      const s = L.summarize(eff);
      assert.equal(L.group(eff, 'category').reduce((a, g) => a + g.spendCents, 0), s.spendingCents);
      // Counted + excluded always adds back to the gross flow: nothing appears or vanishes.
      assert.equal(eff.filter(t => t.kind === 'spend').reduce((a, t) => a - t.amountCents, 0), s.spendingCents + s.excludedCents);
      assert.equal(eff.filter(t => t.kind === 'income').reduce((a, t) => a + t.amountCents, 0), s.incomeCents + s.excludedIncomeCents);
    }
  }
});

test('filter: a split purchase matches only its parts, agreeing with group(category)', () => {
  const ds = L.normalizeDataset({
    schemaVersion: 2, datasetId: 'split-filter', isSynthetic: true, currency: 'USD',
    accounts: [{ id: 'card', label: 'Card', type: 'credit_card', scope: 'joint', ownerId: null, paidInFull: true, coverage: [{ start: '2026-05-01', end: '2026-05-31' }] }],
    transactions: [{ id: 'wh', accountId: 'card', date: '2026-05-10', description: 'SAMPLE WAREHOUSE', merchant: 'Sample Warehouse', amountCents: -10000, kind: 'spend', category: 'Mixed retail', sourceCategory: 'Shopping' }],
  });
  const edits = { wh: E.review.editRecord(null, 'splits', [{ category: 'Groceries', cents: 7000 }, { category: 'Clothing', cents: 3000 }], 'Checked the receipt', '2026-06-01T00:00:00Z') };
  const rows = L.applyEdits(ds, edits);
  assert.deepEqual(L.filter(rows, { category: 'Mixed retail' }).map(t => t.id), [], 'original category no longer matches');
  assert.deepEqual(L.filter(rows, { category: 'Groceries' }).map(t => t.id), ['wh']);
  const grouped = Object.fromEntries(L.group(rows, 'category').map(g => [g.key, g.spendCents]));
  assert.deepEqual(grouped, { Groceries: 7000, Clothing: 3000 });
});
