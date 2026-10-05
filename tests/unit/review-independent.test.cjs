// Synthetic regressions from the assistant's independent review (October 2026), kept as written;
// only the checkout path is this repository's. Every value and identity here is invented.
'use strict';
// Synthetic diagnosis only. No production inputs and no application edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const E = require(path.join(root, 'tests/load-engine.cjs')).loadEngine();
const ds = E.ledger.normalizeDataset({ schemaVersion: 2, datasetId: 'independent-synthetic', isSynthetic: true,
  accounts: [{ id: 'checking', label: 'Synthetic checking', scope: 'joint', type: 'checking', coverage: [{ start: '2031-05-01', end: '2031-05-31' }] }],
  transactions: [{ id: 'synthetic-pay', accountId: 'checking', date: '2031-05-02', amountCents: 200000, description: 'Invented paycheck', merchant: 'Synthetic employer', kind: 'income', category: 'Income', personId: 'p1' }]
});
const income = (id, amount, extra = {}) => ({ id, label: id, personId: 'p1', kind: 'contribution', frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 2, jointPerPaycheckCents: amount, status: 'confirmed', ...extra });
function profile(incomes = [income('Synthetic pay', 200000)]) {
  return { isSynthetic: true, household: { name: 'Synthetic', people: [{ id: 'p1', name: 'River' }] }, plan: {
    people: [{ id: 'p1', name: 'River' }], incomes,
    bills: [{ id: 'synthetic-rent', label: 'Synthetic rent', monthlyCents: 10000, fundedFrom: 'joint', category: 'Mortgage' }],
    savings: [{ id: 'synthetic-goal', label: 'Synthetic goal', monthlyCents: 1000, targetCents: 100000 }],
    targets: { Groceries: 20000 }, balances: { jointCashCents: 500000, asOf: '2031-05-31' },
  } };
}
function run(incomes) {
  const p = profile(incomes);
  const state = E.state.defaults(p, ds);
  const timeline = E.timeline.build({ dataset: ds, txns: E.ledger.applyEdits(ds, {}), plan: state.plan, settings: { horizon: 12 }, today: '2031-06-01' });
  return { state, timeline };
}
function compareMonths(r) {
  return ['2031-06', '2031-07', '2031-08', '2031-09'].map(month => ({ month,
    expectedCents: E.flows.planFunding(r.state.plan, { month, timing: 'average' }).people.p1.jointCents,
    timelineCents: r.timeline.months.find(m => m.month === month).in.p1,
  }));
}
test('future startMonth must enter the projection without a manual plan.changes duplicate', () => {
  const values = compareMonths(run([income('Base', 100000), income('Future', 300000, { startMonth: '2031-08' })]));
  console.log('future-start evidence', JSON.stringify(values));
  assert.deepEqual(values.map(v => v.timelineCents), values.map(v => v.expectedCents));
});
test('future endMonth must stop the projection without a manual plan.changes duplicate', () => {
  const values = compareMonths(run([income('Base', 100000), income('Ending', 100000, { endMonth: '2031-07' })]));
  console.log('future-end evidence', JSON.stringify(values));
  assert.deepEqual(values.map(v => v.timelineCents), values.map(v => v.expectedCents));
});
test('missing plan profile must not erase a previously synced budget', () => {
  const p = profile();
  const before = E.setupSync.apply(E.state.defaults(p, ds), p).state;
  const after = E.setupSync.apply(before, { household: { name: 'Synthetic' } });
  const counts = s => ({ incomes: s.plan.incomes.length, bills: s.plan.bills.length, goals: s.plan.savings.length, targets: Object.keys(s.plan.targets).length, cashCents: s.plan.balances.jointCashCents });
  console.log('missing-plan evidence', JSON.stringify({ before: counts(before), after: counts(after.state), changed: after.changed, notes: after.notes }));
  assert.deepEqual(after.state.plan, before.plan);
});
test('controls: unchanged profile is idempotent; direct income dial is honored', () => {
  const p = profile();
  const state = E.setupSync.apply(E.state.defaults(p, ds), p).state;
  assert.equal(E.setupSync.apply(state, p).state, state);
  const tl = E.timeline.build({ dataset: ds, txns: E.ledger.applyEdits(ds, {}), plan: state.plan, settings: { horizon: 12, dials: { p1: 777000 } }, today: '2031-06-01' });
  assert.equal(tl.months.find(m => m.month === '2031-08').in.p1, 777000);
});
