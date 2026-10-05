'use strict';
// Tests for BudgetEngine.balances: balances over time and whose money a deposit is.
// All households, merchants and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { E, rowMaker, pair, dataset, jointAccounts } = require('../helpers/ledger.cjs');

const L = E.ledger;
const B = E.balances;

const row = rowMaker({ prefix: 'b' });
const pay = (date, cents, extra) => row('chk', date, cents, Object.assign({ kind: 'income', subtype: 'payroll', category: 'Income' }, extra));
const buy = (date, cents, extra) => row('chk', date, -cents, extra);
const SAVINGS = { kind: 'transfer', subtype: 'savings', category: 'Transfer' };
const toSavings = (date, cents) => pair(row('chk', date, -cents, SAVINGS), row('sav', date, cents, SAVINGS));

const HALF_YEAR = [{ start: '2026-01-01', end: '2026-06-30' }];
/** Joint checking, savings and a card (covered like checking). */
const build = (txns, { chk = HALF_YEAR, sav = HALF_YEAR } = {}) => dataset({ datasetId: 'balances-test', accounts: jointAccounts({ chk, sav, card: chk }), transactions: txns });
const eff = ds => L.applyEdits(ds, {});

test('cash accounts: checking and savings count, cards do not', () => {
  const ds = build([]);
  assert.deepEqual(B.cashAccounts(ds).map(a => [a.id, a.group]), [['chk', 'checking'], ['sav', 'savings']]);
});

test('end of day: the balance that is not the start of another row, in either file order', () => {
  // Day starts at 1,000; +500 then −200 → ends at 1,300.
  const rows = [{ balanceCents: 150000, amountCents: 50000, sourceRow: 1 }, { balanceCents: 130000, amountCents: -20000, sourceRow: 2 }];
  assert.equal(B.endOfDay(rows), 130000);
  assert.equal(B.endOfDay(rows.slice().reverse()), 130000);
  // Ambiguous (two rows that cancel): file order decides.
  const amb = [{ balanceCents: 100000, amountCents: 5000, sourceRow: 1, newestFirst: true }, { balanceCents: 100000, amountCents: -5000, sourceRow: 2, newestFirst: true }];
  assert.equal(B.endOfDay(amb), 100000);
});

test('history: running balances from the export give month-end balances, gaps stay unknown', () => {
  const txns = [
    pay('2026-01-05', 300000, { balanceCents: 400000, sourceFile: 'a.csv', sourceRow: 1 }),
    buy('2026-01-20', 50000, { balanceCents: 350000, sourceFile: 'a.csv', sourceRow: 2 }),
    buy('2026-03-03', 10000, { balanceCents: 340000, sourceFile: 'a.csv', sourceRow: 3 }),
  ];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-03-01', end: '2026-03-31' }] });
  const h = B.history(eff(ds), ds, { months: ['2025-12', '2026-01', '2026-02', '2026-03'] });
  const chk = h.accounts.find(a => a.id === 'chk');
  assert.equal(chk.source, 'bank');
  assert.deepEqual(chk.values, [100000, 350000, null, 340000], 'Dec worked back from the first balance; Feb not covered → unknown');
});

test('history: one entered balance is worked back and forward with the transactions', () => {
  const txns = [pay('2026-01-05', 300000), buy('2026-02-10', 100000), ...toSavings('2026-02-15', 50000), pay('2026-03-05', 300000)];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-03-31' }], sav: [{ start: '2026-01-01', end: '2026-03-31' }] });
  const h = B.history(eff(ds), ds, { entered: { chk: 500000, sav: 150000 }, asOf: '2026-02-28', months: ['2026-01', '2026-02', '2026-03'] });
  assert.deepEqual(h.groups.checking.values, [650000, 500000, 800000]);
  assert.deepEqual(h.groups.savings.values, [100000, 150000, 150000]);
  assert.deepEqual(h.total.values, [750000, 650000, 950000]);
  assert.equal(h.total.kind, 'balance');
  assert.deepEqual(h.latest, { month: '2026-03', index: 2, checking: 800000, savings: 150000, total: 950000 });
});

test('history: without any known balance the lines show change, and say so', () => {
  const txns = [pay('2026-01-05', 300000), buy('2026-01-10', 100000), ...toSavings('2026-02-15', 50000)];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-28' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const h = B.history(eff(ds), ds, { months: ['2026-01', '2026-02'] });
  assert.equal(h.groups.checking.kind, 'change');
  assert.equal(h.total.kind, 'change');
  assert.deepEqual(h.groups.checking.values, [200000, 150000]);
  assert.deepEqual(h.groups.savings.values, [0, 50000]);
  assert.match(h.accounts[0].note, /change since/);
  // Only the savings balance known: total cannot be a balance.
  const h2 = B.history(eff(ds), ds, { entered: { sav: 90000 }, asOf: '2026-02-28', months: ['2026-01', '2026-02'] });
  assert.equal(h2.groups.savings.kind, 'balance');
  assert.equal(h2.total.kind, 'change');
});

test('history: rows marked as duplicate copies never move the balance', () => {
  const dup = buy('2026-01-12', 40000);
  const txns = [pay('2026-01-05', 300000), buy('2026-01-12', 40000), dup];
  const ds = build(txns);
  const edited = L.applyEdits(ds, { [dup.id]: { duplicate: 'exclude', reason: 'test', history: [] } });
  const h = B.history(edited, ds, { entered: { chk: 0, sav: 0 }, asOf: '2025-12-31', months: ['2026-01'] });
  assert.equal(h.groups.checking.values[0], 260000);
});

test('income by person: named rows, then the budget’s incomes, decide whose money it is', () => {
  const plan = { incomes: [
    { id: 'a-pay', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 250000, jointPerPaycheckCents: 210000 },
    { id: 'b-pay', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: null, jointPerPaycheckCents: null },
    { id: 'b-in', personId: 'p2', kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: 145000 }
  ] };
  const who = B.incomeAttribution(plan);
  assert.equal(who({ kind: 'income', subtype: 'payroll', amountCents: 210000 }), 'p1', 'the only paycheck that reaches joint');
  assert.equal(who({ kind: 'transfer', subtype: 'contribution', amountCents: 99900 }), 'p2', 'the only person who sends transfers');
  assert.equal(who({ kind: 'income', subtype: 'interest', amountCents: 500 }), null, 'interest is nobody’s pay');
  assert.equal(who({ kind: 'income', subtype: 'payroll', amountCents: 1, personId: 'p2' }), 'p2', 'a rule’s person wins');
  // Both paychecks reach joint: the amount decides, and an unmatched amount stays unassigned.
  const both = B.incomeAttribution({ incomes: [
    { personId: 'p1', kind: 'paycheck', jointPerPaycheckCents: 210000 },
    { personId: 'p2', kind: 'paycheck', jointPerPaycheckCents: 180000 }
  ] });
  assert.equal(both({ kind: 'income', subtype: 'payroll', amountCents: 180000 }), 'p2');
  assert.equal(both({ kind: 'income', subtype: 'payroll', amountCents: 123400 }), null);
  assert.equal(B.incomeAttribution(null)({ kind: 'income', subtype: 'payroll', amountCents: 1 }), null);
  // A transfer the import rules did not recognise, of exactly the partner's usual transfer amount.
  assert.equal(who({ kind: 'income', subtype: 'other', amountCents: 145000 }), 'p2');
  assert.equal(who({ kind: 'transfer', subtype: 'internal', amountCents: 145000 }), 'p2');
  assert.equal(who({ kind: 'income', subtype: 'other', amountCents: 145001 }), null, 'only an exact amount');
  assert.equal(who({ kind: 'income', subtype: 'interest', amountCents: 145000 }), null, 'interest never');
});

test('income by person: the parts add up to money in', () => {
  const txns = [pay('2026-01-05', 210000), row('chk', '2026-01-15', 145000, { kind: 'transfer', subtype: 'contribution', category: 'Transfer' }),
    row('chk', '2026-01-31', 333, { kind: 'income', subtype: 'interest', category: 'Income' }), pay('2026-02-05', 210000)];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-28' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const plan = { incomes: [
    { personId: 'p1', kind: 'paycheck', jointPerPaycheckCents: 210000 },
    { personId: 'p2', kind: 'contribution', jointPerPaycheckCents: 145000 }
  ] };
  // flows.breakdown attributes each deposit with B.incomeAttribution(plan).
  const [jan, feb] = E.flows.breakdown(eff(ds), ds, { months: ['2026-01', '2026-02'], plan }).map(r => r.actual);
  assert.deepEqual({ p1: jan.p1, p2: jan.p2, other: jan.unassigned + jan.interest }, { p1: 210000, p2: 145000, other: 333 });
  assert.equal(jan.moneyIn, 355333);
  assert.deepEqual({ p1: feb.p1, p2: feb.p2, other: feb.unassigned + feb.interest }, { p1: 210000, p2: 0, other: 0 });
  assert.equal(feb.moneyIn, 210000);
});

test('sample: month-end checking matches the bank’s own last balance, and the pattern explains the change', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const ds = L.normalizeDataset(JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/sample-data.json'), 'utf8')));
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/sample-profile.json'), 'utf8'));
  const txns = eff(ds);
  const h = B.history(txns, ds, { entered: profile.plan.balances.accounts, asOf: profile.plan.balances.accountsAsOf });
  const lastBank = ds.transactions.filter(t => t.accountId === 'joint-checking' && Number.isInteger(t.balanceCents)).sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
  assert.equal(h.groups.checking.values[h.months.indexOf('2026-09')], lastBank.balanceCents, 'no checking rows after the last balance row');
  assert.equal(h.total.kind, 'balance');
  // Over a year, in − out − saved accounts for the change in checking to within card-payment timing.
  const flows = E.flows.breakdown(txns, ds, { plan: profile.plan });
  const year = flows.filter(f => f.month >= '2025-10' && f.month <= '2026-09');
  assert.equal(year.length, 12);
  const left = year.reduce((s, f) => s + f.actual.left, 0);
  const change = h.groups.checking.values[h.months.indexOf('2026-09')] - h.groups.checking.values[h.months.indexOf('2025-09')];
  assert.ok(Math.abs(left - change) < 300000, `pattern ${left} vs balance change ${change}`);
});

test('history: a balance dated after the export ends is used at its own date; the days in between are a labelled gap with no transactions assumed', () => {
  const txns = [buy('2026-06-10', 20000), ...toSavings('2026-06-15', 30000)];
  const ds = build(txns);
  // Today's savings balance, typed two days after the export ends on 30 June.
  const h = B.history(eff(ds), ds, { entered: { sav: 1412345, chk: 250000 }, asOf: '2026-07-02', months: ['2026-05', '2026-06', '2026-07'] });
  const sav = h.accounts.find(a => a.id === 'sav');
  assert.deepEqual(sav.anchor, { date: '2026-07-02', cents: 1412345, source: 'entered' }, 'the date is never moved');
  assert.deepEqual(sav.gap, { side: 'after', from: '2026-07-01', to: '2026-07-02', days: 2 });
  assert.equal(h.groups.savings.values[1], 1412345, 'June 30: nothing assumed to move in the gap');
  assert.equal(h.groups.savings.values[0], 1412345 - 30000, 'and worked back with the transactions');
  assert.equal(h.groups.savings.values[2], null, 'July 31 is after the balance date and not covered: unknown');
  assert.equal(h.total.kind, 'balance');
  assert.match(sav.note, /Your export ends Jun 30, 2026, the balance is dated Jul 2, 2026\. The 2 days from Jul 1, 2026 to Jul 2, 2026 are not in your data: no transactions are assumed in them\./);
  assert.deepEqual(sav.last, { date: '2026-07-02', cents: 1412345 });
  assert.deepEqual(sav.first, { date: '2025-12-31', cents: 1412345 - 30000 });
  // Months later: still used at its own date, however long the gap; never moved, never dropped.
  const far = B.history(eff(ds), ds, { entered: { sav: 1412345, chk: 250000 }, asOf: '2026-09-30', months: ['2026-06'] });
  const farSav = far.accounts.find(a => a.id === 'sav');
  assert.equal(farSav.anchor.date, '2026-09-30');
  assert.equal(farSav.gap.days, 92);
  assert.equal(far.groups.savings.values[0], 1412345, 'the gap is assumed empty and labelled, not guessed');
  assert.match(farSav.note, /92 days/);
});

test('history: a balance dated before the export starts is used at its date; earlier months stay unknown', () => {
  const txns = [buy('2026-01-10', 20000)];
  const ds = build(txns);
  const h = B.history(eff(ds), ds, { entered: { chk: 500000 }, enteredAsOf: { chk: '2025-11-20' }, months: ['2025-10', '2025-11', '2025-12', '2026-01'] });
  const chk = h.accounts.find(a => a.id === 'chk');
  assert.deepEqual(chk.gap, { side: 'before', from: '2025-11-21', to: '2025-12-31', days: 41 });
  assert.deepEqual(h.groups.checking.values, [null, 500000, 500000, 480000], 'October is before anything is known');
  assert.match(chk.note, /Your export starts Jan 1, 2026/);
});

test('history: each account uses its own balance date; a running balance wins unless the entered one is newer', () => {
  const txns = [pay('2026-01-05', 300000, { balanceCents: 400000, sourceFile: 'a.csv', sourceRow: 1 }), buy('2026-02-10', 100000), ...toSavings('2026-02-15', 50000)];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-28' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const h = B.history(eff(ds), ds, { entered: { chk: 999999, sav: 150000 }, asOf: '2026-01-04', enteredAsOf: { sav: '2026-02-28' }, months: ['2026-01', '2026-02'] });
  const chk = h.accounts.find(a => a.id === 'chk'), sav = h.accounts.find(a => a.id === 'sav');
  assert.equal(chk.source, 'bank');
  assert.deepEqual(h.groups.checking.values, [400000, 250000], 'the older entered checking balance does not override the bank');
  assert.match(chk.note, /not newer than the export/);
  assert.deepEqual(sav.anchor, { date: '2026-02-28', cents: 150000, source: 'entered' });
  assert.deepEqual(h.groups.savings.values, [100000, 150000]);
  const newer = B.history(eff(ds), ds, { entered: { chk: 260000 }, enteredAsOf: { chk: '2026-03-04' }, months: ['2026-02'] });
  const c2 = newer.accounts.find(a => a.id === 'chk');
  assert.deepEqual(c2.anchor, { date: '2026-03-04', cents: 260000, source: 'entered' }, 'a newer entered balance becomes the latest known balance');
  assert.deepEqual(c2.last, { date: '2026-03-04', cents: 260000 });
});
