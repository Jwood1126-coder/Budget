'use strict';
// Tests for BudgetEngine.balances: balances over time, monthly patterns, "comfortable to save"
// and the projection. All households, merchants and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const L = E.ledger;
const B = E.balances;

let seq = 0;
function row(accountId, date, amountCents, fields = {}) {
  seq += 1;
  return Object.assign({ id: 'b' + String(seq).padStart(5, '0'), accountId, date, description: 'SAMPLE ROW', amountCents, kind: 'spend', category: 'Groceries' }, fields);
}
const pay = (date, cents, extra) => row('chk', date, cents, Object.assign({ kind: 'income', subtype: 'payroll', category: 'Income' }, extra));
const buy = (date, cents, extra) => row('chk', date, -cents, extra);
const toSavings = (date, cents) => {
  const out = row('chk', date, -cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer' });
  const inn = row('sav', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', pairId: out.id });
  out.pairId = inn.id;
  return [out, inn];
};

function build(txns, { chk = [{ start: '2026-01-01', end: '2026-06-30' }], sav = [{ start: '2026-01-01', end: '2026-06-30' }] } = {}) {
  return L.normalizeDataset({
    schemaVersion: 2, datasetId: 'balances-test', isSynthetic: true,
    accounts: [
      { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: chk },
      { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint', coverage: sav },
      { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: chk }
    ],
    transactions: txns
  });
}
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

test('monthly flows: in, out and saved for full months only; business purchases still left the account', () => {
  const biz = buy('2026-02-11', 30000, { category: 'Household & hardware' });
  const txns = [pay('2026-01-05', 300000), buy('2026-01-10', 100000), ...toSavings('2026-01-20', 25000),
    pay('2026-02-05', 300000), biz, row('chk', '2026-02-20', -60000, { kind: 'debt_payment', subtype: 'loan', category: 'Debt' })];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-14' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const edited = L.applyEdits(ds, { [biz.id]: { business: 'business', reason: 'work tools', history: [] } });
  const flows = B.monthlyFlows(edited, ds, { months: ['2026-01', '2026-02'] });
  assert.deepEqual(flows[0], { month: '2026-01', coverage: 'full', inCents: 300000, outCents: 100000, savedCents: 25000, leftCents: 175000, businessCents: 0 });
  assert.equal(flows[1].coverage, 'partial', 'the checking export ends mid-February');
  assert.equal(flows[1].inCents, null, 'a partial month is unknown, not small');
  const full = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-28' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const f2 = B.monthlyFlows(L.applyEdits(full, { [biz.id]: { business: 'business', reason: 'work tools', history: [] } }), full, { months: ['2026-02'] })[0];
  assert.equal(f2.outCents, 90000, 'debt payment + business purchase');
  assert.equal(f2.businessCents, 30000);
});

test('monthly flows: one-offs left out of planning are left out only with planning: true', () => {
  const big = buy('2026-01-15', 200000, { category: 'Dental' });
  const ds = build([pay('2026-01-05', 300000), big]);
  const edited = L.applyEdits(ds, { [big.id]: { planningBaseline: 'exclude', reason: 'one-off', history: [] } });
  assert.equal(B.monthlyFlows(edited, ds, { months: ['2026-01'] })[0].outCents, 200000);
  assert.equal(B.monthlyFlows(edited, ds, { months: ['2026-01'], planning: true })[0].outCents, 0);
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

test('income by person: the parts add up to money in, month by month and on average', () => {
  const txns = [pay('2026-01-05', 210000), row('chk', '2026-01-15', 145000, { kind: 'transfer', subtype: 'contribution', category: 'Transfer' }),
    row('chk', '2026-01-31', 333, { kind: 'income', subtype: 'interest', category: 'Income' }), pay('2026-02-05', 210000)];
  const ds = build(txns, { chk: [{ start: '2026-01-01', end: '2026-02-28' }], sav: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const attribute = B.incomeAttribution({ incomes: [
    { personId: 'p1', kind: 'paycheck', jointPerPaycheckCents: 210000 },
    { personId: 'p2', kind: 'contribution', jointPerPaycheckCents: 145000 }
  ] });
  const flows = B.monthlyFlows(eff(ds), ds, { months: ['2026-01', '2026-02'], attribute });
  assert.deepEqual(flows[0].bySource, { p1: 210000, p2: 145000, other: 333 });
  assert.equal(flows[0].inCents, 355333);
  const u = B.usual(flows, { count: 12 });
  assert.equal(u.bySource.p1 + u.bySource.p2 + u.bySource.other, u.inCents);
  assert.deepEqual(u.bySource, { p1: 210000, p2: 72500, other: 167 });
});

test('usual: the average of the last full months', () => {
  const flows = [
    { month: '2026-01', inCents: 100000, outCents: 50000, savedCents: 10000 },
    { month: '2026-02', inCents: null, outCents: null, savedCents: null },
    { month: '2026-03', inCents: 200000, outCents: 70000, savedCents: 20000 },
    { month: '2026-04', inCents: 300000, outCents: 90000, savedCents: 30000 },
  ];
  assert.deepEqual(B.usual(flows, { count: 2 }), { inCents: 250000, outCents: 80000, savedCents: 25000, months: ['2026-03', '2026-04'], count: 2 });
  assert.equal(B.usual([], {}).inCents, null);
});

test('comfortable: what was left over in three of every four months, rounded down to $50', () => {
  const lefts = [210000, 50000, 260000, 180000, 230000, 90000, 240000, 200000, 220000, 250000, 190000, 205000];
  const flows = lefts.map((l, i) => ({ month: E.months.add('2025-10', i), inCents: 600000, outCents: 600000 - l, savedCents: 0 }));
  const r = B.comfortable(flows, { count: 12 });
  assert.equal(r.comfortableCents, 190000, 'the 4th lowest of 12 (already a multiple of $50)');
  const odd = B.comfortable(flows.map((f, i) => (i === 3 ? { ...f, outCents: f.inCents - 191234 } : f)), { count: 12 });
  assert.equal(odd.comfortableCents, 190000, 'rounded down to $50');
  assert.equal(r.monthsAtLeast, 9);
  assert.equal(r.lowestCents, 50000);
  assert.equal(r.highestCents, 260000);
  const bad = B.comfortable([{ month: '2026-01', inCents: 100, outCents: 500 }], {});
  assert.equal(bad.comfortableCents, 0, 'never below $0');
});

test('project: plain arithmetic, and the month checking would run out', () => {
  const p = B.project({ startMonth: '2026-10', months: 3, start: { checking: 100000, savings: 50000 }, inCents: 500000, outCents: 520000, savedCents: 40000 });
  assert.equal(p.monthlyLeftCents, -60000);
  assert.deepEqual(p.rows.map(r => ({ month: r.month, checking: r.checking, savings: r.savings, total: r.total })), [
    { month: '2026-10', checking: 40000, savings: 90000, total: 130000 },
    { month: '2026-11', checking: -20000, savings: 130000, total: 110000 },
    { month: '2026-12', checking: -80000, savings: 170000, total: 90000 },
  ]);
  assert.equal(p.firstShortMonth, '2026-11');
  assert.equal(p.limited, false, 'without limits it is plain arithmetic (amounts that are only a change can go below zero)');
  assert.throws(() => B.project({ startMonth: '2026-10', months: 3, start: {}, inCents: 1.5, outCents: 0, savedCents: 0 }), E.ValidationError);
  assert.throws(() => B.project({ startMonth: 'soon', months: 3, start: {}, inCents: 0, outCents: 0, savedCents: 0 }), E.ValidationError);
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
  const flows = B.monthlyFlows(txns, ds, {});
  const year = flows.filter(f => f.month >= '2025-10' && f.month <= '2026-09');
  const left = year.reduce((s, f) => s + f.leftCents, 0);
  const change = h.groups.checking.values[h.months.indexOf('2026-09')] - h.groups.checking.values[h.months.indexOf('2025-09')];
  assert.ok(Math.abs(left - change) < 300000, `pattern ${left} vs balance change ${change}`);
});

test('project with limits: no balance goes below $0; savings tops up checking; the rest is an uncovered shortfall', () => {
  // Checking 1,000.00 and savings 500.00, 600.00 a month more going out than coming in, still moving 400.00 to savings.
  const p = B.project({ startMonth: '2026-10', months: 4, start: { checking: 100000, savings: 50000 }, inCents: 500000, outCents: 520000, savedCents: 40000, limits: { checking: true, savings: true } });
  assert.deepEqual(p.rows.map(r => [r.month, r.checking, r.savings, r.uncovered]), [
    ['2026-10', 40000, 90000, 0],
    ['2026-11', 0, 110000, 0],      // checking short 200.00: savings covers it
    ['2026-12', 0, 90000, 0],       // short 600.00 again (after 400.00 went in): covered
    ['2027-01', 0, 70000, 0],
  ]);
  assert.ok(p.rows.every(r => r.checking >= 0 && r.savings >= 0), 'no negative balance in any month');
  assert.equal(p.firstShortMonth, '2026-11');
  assert.equal(p.coveredFromSavingsCents, 20000 + 60000 + 60000);
  assert.equal(p.firstUncoveredMonth, null);

  // Spending far above income: savings empties, then the rest is uncovered, never a negative balance.
  const q = B.project({ startMonth: '2026-10', months: 3, start: { checking: 50000, savings: 30000 }, inCents: 300000, outCents: 400000, savedCents: 0, limits: { checking: true, savings: true } });
  assert.deepEqual(q.rows.map(r => [r.month, r.checking, r.savings, r.uncovered]), [
    ['2026-10', 0, 0, 20000],       // short 1,000.00: 500.00 in checking + 300.00 from savings, 200.00 uncovered
    ['2026-11', 0, 0, 120000],
    ['2026-12', 0, 0, 220000],
  ]);
  assert.equal(q.savingsEmptyMonth, '2026-10');
  assert.equal(q.firstUncoveredMonth, '2026-10');
  assert.equal(q.uncoveredCents, 220000);
  // Every cent is accounted for: start + 3 months of the plan = end balances − what was not covered.
  assert.equal(50000 + 30000 + 3 * (300000 - 400000), q.rows[2].total - q.uncoveredCents);

  // A planned drawdown bigger than savings: only what is there reaches checking.
  const d = B.project({ startMonth: '2026-10', months: 3, start: { checking: 10000, savings: 25000 }, inCents: 200000, outCents: 210000, savedCents: -10000, limits: { checking: true, savings: true } });
  assert.deepEqual(d.rows.map(r => [r.checking, r.savings, r.uncovered]), [
    [10000, 15000, 0],              // 100.00 short, 100.00 drawn from savings
    [10000, 5000, 0],
    [5000, 0, 0],                   // only 50.00 was left to draw
  ]);
  assert.equal(d.savingsEmptyMonth, '2026-12');
  assert.equal(d.firstSavingsShortMonth, '2026-12');
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
