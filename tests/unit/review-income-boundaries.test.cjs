// Synthetic regressions from the assistant's independent review (October 2026), kept as written;
// only the checkout path is this repository's. Every value and identity here is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const E = require(path.join(root, 'tests/load-engine.cjs')).loadEngine();
const income = (id, cents, fields = {}) => ({ id, label: id, personId: 'p1', kind: 'contribution', frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 2, jointPerPaycheckCents: cents, status: 'confirmed', ...fields });
function run(incomes, { deposits = true, settings = {} } = {}) {
  const ds = E.ledger.normalizeDataset({ schemaVersion: 2, datasetId: 'boundary-synthetic', isSynthetic: true,
    accounts: [{ id: 'checking', label: 'Synthetic checking', scope: 'joint', type: 'checking', coverage: [{ start: '2031-05-01', end: '2031-05-31' }] }],
    transactions: deposits ? [{ id: 'synthetic-pay', accountId: 'checking', date: '2031-05-02', amountCents: 200000, description: 'Invented old paycheck', merchant: 'Synthetic employer', kind: 'income', category: 'Income', personId: 'p1' }] : [] });
  const st = E.state.defaults({ isSynthetic: true, household: { name: 'Synthetic' }, plan: { people: [{ id: 'p1', name: 'River' }], incomes } }, ds);
  const tl = E.timeline.build({ dataset: ds, txns: E.ledger.applyEdits(ds, {}), plan: st.plan, settings: { horizon: 12, ...settings }, today: '2031-06-01' });
  const value = month => tl.months.find(m => m.month === month).in.p1;
  const detail = { basis: tl.dialsByKey.p1.basisKind, budgetCents: tl.dialsByKey.p1.budgetCents, months: ['2031-06','2031-07','2031-08','2031-09'].map(month => ({ month, timelineCents: value(month), budgetCents: E.plan.monthly(st.plan, { scope:'joint', month, timing:'average' }).income.totalCents })), derivedIncomeChanges: tl.changes.list.filter(c => c.source === 'income') };
  return { tl, value, detail };
}
test('known new pay must start even when no income is active in the first projected month', () => {
  const r = run([income('New job', 300000, { startMonth: '2031-08' })]);
  console.log('later-only-with-history', JSON.stringify(r.detail));
  assert.equal(r.value('2031-08'), 300000);
});
test('known new pay must start after a zero-deposit month with no initially active stream', () => {
  const r = run([income('New job', 300000, { startMonth: '2031-08' })], { deposits: false });
  console.log('later-only-zero-history', JSON.stringify(r.detail));
  assert.equal(r.value('2031-08'), 300000);
});
test('a new job after an already-ended job must replace the historical deposit average', () => {
  const r = run([income('Old job', 200000, { endMonth: '2031-05' }), income('New job', 300000, { startMonth: '2031-08' })]);
  console.log('gap-at-plan-start', JSON.stringify(r.detail));
  assert.equal(r.value('2031-08'), 300000);
});
test('an active stream stops completely after its last month', () => {
  const r = run([income('Contract', 200000, { endMonth: '2031-07' })]);
  assert.equal(r.value('2031-07'), 200000); assert.equal(r.value('2031-08'), 0);
});
test('a gap later in the horizon becomes zero and new pay resumes on schedule', () => {
  const r = run([income('Old job', 200000, { endMonth:'2031-06' }), income('New job', 300000, { startMonth:'2031-08', endMonth:'2031-09' })]);
  assert.deepEqual(['2031-06','2031-07','2031-08','2031-09','2031-10'].map(r.value), [200000,0,300000,300000,0]);
});
test('deposit average remains the fallback when no Budget income exists', () => {
  const r = run([]); assert.equal(r.value('2031-08'), 200000); assert.equal(r.detail.derivedIncomeChanges.length, 0);
});
test('direct dial plus dated delta follows the documented override policy', () => {
  const r = run([income('Base',100000), income('New',300000,{startMonth:'2031-08'})], { settings:{ dials:{ p1:777000 } } });
  assert.equal(r.value('2031-06'),777000); assert.equal(r.value('2031-08'),1077000);
});
test('zero-valued but active Budget income permits later pay, unlike no active stream', () => {
  const r = run([income('Zero base',0), income('New',300000,{startMonth:'2031-08'})]);
  assert.equal(r.value('2031-08'),300000);
});
