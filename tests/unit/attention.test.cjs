'use strict';
// Tests for BudgetEngine.attention: the Overview's "needs attention" list (plan facts, data review
// items, forecast warnings), dismissals and ordering. The households and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const A = E.attention;
const L = E.ledger;
const SAMPLE_DATA = require('../../fixtures/sample-data.json');
const SAMPLE_PROFILE = require('../../fixtures/sample-profile.json');

const ORDER = { action: 0, decision: 1, info: 2 };

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** A state around a plan with nothing to flag: known balance, no streams, bills or debts. */
function stateWith(planExtra = {}, ui = {}, extra = {}) {
  const plan = Object.assign({
    people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }],
    incomes: [], bills: [], debts: [], targets: {}, savings: [], personalSpending: [],
    balances: { jointCashCents: 500000, asOf: '2026-09-30', note: '' },
    settings: { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 }
  }, planExtra);
  return Object.assign({
    plan,
    scenarios: [{ id: 'baseline', name: 'Current plan', events: [], assumptions: {} }],
    ledgerEdits: {},
    ui: Object.assign({ scope: 'joint', dismissed: {} }, ui)
  }, extra);
}

const item = (items, id) => items.find(i => i.id === id);
const ids = items => items.map(i => i.id);
const planList = (planExtra, ui) => A.list({ state: deepFreeze(stateWith(planExtra, ui)) });

const paycheck = (fields = {}) => Object.assign({ id: 'sam-pay', label: 'Sam paycheck', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: 250000, jointPerPaycheckCents: 0, frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 1, assumedPerMonthIfUnknown: 2, status: 'confirmed' }, fields);
const contribution = (fields = {}) => Object.assign({ id: 'sam-contrib', label: 'Sam contribution', personId: 'p2', kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: 132500, frequency: 'semimonthly', frequencyStatus: 'observed', semimonthlyDays: [1, 15], assumedPerMonthIfUnknown: 2, status: 'observed' }, fields);
const bill = (fields = {}) => Object.assign({ id: 'car', label: 'Sam car payment', category: null, monthlyCents: 37200, fundedFrom: 'joint', type: 'debt', status: 'existing', startMonth: null, endMonth: null }, fields);

function assertOrdered(items) {
  for (let i = 1; i < items.length; i++) {
    assert.ok(ORDER[items[i - 1].severity] <= ORDER[items[i].severity], 'out of order: ' + items.map(x => x.severity + ':' + x.id).join(', '));
  }
}

// ======================================================================= plan items

test('plan: a complete plan needs no attention', () => {
  assert.deepEqual(planList({ incomes: [paycheck()], bills: [bill()] }), []);
});

test('plan: an unknown pay frequency is a decision that names the assumed paychecks a month', () => {
  const items = planList({ incomes: [paycheck({ frequency: 'unknown', frequencyStatus: 'unknown', assumedPerMonthIfUnknown: 3 })] });
  const f = item(items, 'freq-sam-pay');
  assert.equal(f.severity, 'decision');
  assert.equal(f.title, "Confirm Sam's pay frequency");
  assert.match(f.detail, /Until confirmed, the budget assumes 3 paychecks a month\.$/);
  assert.equal(f.route, '#/budget?section=income');
});

test('plan: a known frequency marked unknown says which frequency is assumed', () => {
  const f = item(planList({ incomes: [paycheck({ frequency: 'biweekly', frequencyStatus: 'unknown' })] }), 'freq-sam-pay');
  assert.match(f.detail, /Until confirmed, the budget assumes biweekly pay \(every two weeks\)\.$/);
  assert.doesNotMatch(f.detail, /paychecks a month/);
});

test('plan: unknown take-home pay is info for joint, a decision for the whole household', () => {
  const plan = { incomes: [paycheck({ netPerPaycheckCents: null })] };
  assert.equal(item(planList(plan), 'net-sam-pay').severity, 'info');
  assert.equal(item(planList(plan, { scope: 'household' }), 'net-sam-pay').severity, 'decision');
  assert.equal(item(planList(plan), 'net-sam-pay').title, "Sam's full take-home pay is unknown");
});

test('plan: an observed contribution with a known schedule asks to confirm amount and timing', () => {
  const c = item(planList({ incomes: [contribution()] }), 'contrib-sam-contrib');
  assert.equal(c.severity, 'info');
  assert.equal(c.title, "Sam's contribution schedule is inferred from observed transfers");
  assert.equal(c.detail, '$1,325 transfers were observed twice a month. Confirm it is the planned amount and timing.');
});

test('plan: an observed contribution with an unknown frequency says the schedule is not confirmed and what is assumed', () => {
  const c = item(planList({ incomes: [contribution({ frequency: 'unknown' })] }), 'contrib-sam-contrib');
  assert.equal(c.severity, 'decision');
  assert.equal(c.title, "Confirm Sam's transfer schedule");
  assert.equal(c.detail, '$1,325 transfers have been observed, but the schedule is not confirmed. Until it is, the budget assumes 2 transfers a month.');
  assert.doesNotMatch(c.detail, /regularly|paycheck/);
});

test('plan: a contribution with an unknown schedule and amount still names the assumption', () => {
  const c = item(planList({ incomes: [contribution({ frequency: 'unknown', frequencyStatus: 'unknown', status: 'unknown', jointPerPaycheckCents: null, assumedPerMonthIfUnknown: 1 })] }), 'contrib-sam-contrib');
  assert.equal(c.severity, 'decision');
  assert.equal(c.detail, 'The transfer schedule is not confirmed. Until it is, the budget assumes 1 transfer a month.');
  // A known frequency marked unknown names that frequency.
  const d = item(planList({ incomes: [contribution({ frequency: 'weekly', frequencyStatus: 'unknown' })] }), 'contrib-sam-contrib');
  assert.match(d.detail, /the budget assumes weekly transfers \(every week\)\.$/);
  // A confirmed schedule needs nothing.
  assert.equal(item(planList({ incomes: [contribution({ frequencyStatus: 'confirmed' })] }), 'contrib-sam-contrib'), undefined);
});

test('plan: a bill with unknown funding asks who pays it, with or without an amount', () => {
  const items = planList({ bills: [bill({ fundedFrom: 'unknown' })] });
  const f = item(items, 'bill-fund-car');
  assert.equal(f.severity, 'decision');
  assert.equal(f.title, 'Who pays Sam car payment?');
  assert.equal(f.detail, '$372.00/month is left out of the joint-account budget until you choose the paying account (it is included in the whole-household view).');
  const blank = planList({ bills: [bill({ fundedFrom: 'unknown', monthlyCents: null })] });
  assert.equal(item(blank, 'bill-amt-car').severity, 'action');
  assert.match(item(blank, 'bill-fund-car').detail, /^It is left out of the joint-account budget/);
});

test('plan: a planned bill is info with its placeholder amount', () => {
  const items = planList({ bills: [bill({ id: 'life', label: 'Life insurance', monthlyCents: 4000, type: 'insurance', status: 'planned' })] });
  const p = item(items, 'bill-planned-life');
  assert.equal(p.severity, 'info');
  assert.equal(p.title, 'Life insurance is planned, not an existing bill');
  assert.match(p.detail, /^\$40\.00\/month is a placeholder/);
  // Without an amount it is an amount to enter instead.
  const blank = planList({ bills: [bill({ id: 'life', label: 'Life insurance', monthlyCents: null, status: 'planned' })] });
  assert.deepEqual(ids(blank), ['bill-amt-life']);
});

test('plan: promotional financing with missing facts is a decision naming the payment', () => {
  const debt = promo => ({ id: 'store-card', label: 'Store card', ownerId: 'joint', balanceCents: 198035, paymentBillId: 'store-card', promo, loanCount: null, repaymentPlan: null, termStatus: 'unknown', escrowIncluded: null });
  const pay = bill({ id: 'store-card', label: 'Store card payment', monthlyCents: 5500 });
  const p = item(planList({ bills: [pay], debts: [debt({ balanceCents: null, expiresMonth: null, deferredInterest: null })] }), 'promo-store-card');
  assert.equal(p.severity, 'decision');
  assert.equal(p.title, 'Verify the promotional financing on Store card');
  assert.match(p.detail, /whether the \$55\.00 payment clears it in time/);
  assert.ok(item(planList({ bills: [pay], debts: [debt({ balanceCents: 120000, expiresMonth: null })] }), 'promo-store-card'), 'expiry still missing');
  assert.equal(item(planList({ bills: [pay], debts: [debt({ balanceCents: 120000, expiresMonth: '2027-06' })] }), 'promo-store-card'), undefined);
});

test('plan: a missing joint cash balance is a decision', () => {
  const items = planList({ balances: { jointCashCents: null, asOf: null, note: '' } });
  assert.deepEqual(ids(items), ['balance']);
  assert.equal(items[0].severity, 'decision');
});

test('plan: items are ordered action, then decision, then info', () => {
  const items = planList({
    balances: { jointCashCents: null, asOf: null, note: '' },
    incomes: [contribution()],
    bills: [bill({ id: 'life', label: 'Life insurance', monthlyCents: 4000, status: 'planned' }), bill({ id: 'gym', label: 'Gym', monthlyCents: null })]
  });
  assert.deepEqual(items.map(i => i.severity), ['action', 'decision', 'info', 'info']);
  assert.deepEqual(ids(items), ['bill-amt-gym', 'balance', 'contrib-sam-contrib', 'bill-planned-life']);
});

test('dismissed items are filtered out; others stay', () => {
  const plan = { balances: { jointCashCents: null, asOf: null, note: '' }, bills: [bill({ id: 'gym', label: 'Gym', monthlyCents: null })] };
  assert.deepEqual(ids(planList(plan, { dismissed: { 'attention:balance': true } })), ['bill-amt-gym']);
  assert.deepEqual(ids(planList(plan, { dismissed: { 'attention:balance': false } })), ['bill-amt-gym', 'balance']);
  // Without a ui section nothing is dismissed and nothing throws.
  const st = stateWith(plan);
  delete st.ui;
  assert.deepEqual(ids(A.list({ state: st })), ['bill-amt-gym', 'balance']);
});

test('a section that cannot be calculated becomes one info item instead of breaking the list', () => {
  const items = A.list({ state: { plan: null, scenarios: [], ui: { dismissed: {} } } });
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'info');
  assert.equal(items[0].title, 'Part of this list could not be calculated');
});

// ======================================================================= data items (sample)

function sampleState(edits) {
  const ds = L.normalizeDataset(SAMPLE_DATA);
  const state = E.state.defaults(SAMPLE_PROFILE, ds);
  if (edits) state.ledgerEdits = edits;
  return { ds, state, txns: L.applyEdits(ds, state.ledgerEdits) };
}

test('sample: data review items with plan items, in severity order', () => {
  const { ds, state, txns } = sampleState();
  const items = A.list({ dataset: ds, txns, state });
  assertOrdered(items);
  for (const id of ['dupes', 'uncertain', 'transfers', 'business', 'spike-2026-08Dental', 'coverage', 'bill-fund-p2-car', 'promo-store-card', 'net-p2-pay', 'contrib-p2-contribution', 'bill-planned-life-insurance', 'escrow-mortgage', 'terms-p1-student-loans']) {
    assert.ok(item(items, id), id + ' missing from ' + ids(items).join(', '));
  }
  // The sample profile carries an account balance, so there is no 'enter today's balances' item.
  assert.equal(item(items, 'balance'), undefined);
  // Sam's paycheck has no known amount, so only 'pay unknown' is listed, not a frequency question.
  assert.equal(item(items, 'freq-p2-pay'), undefined);
  assert.equal(item(items, 'dupes').severity, 'action');
  assert.equal(item(items, 'dupes').title, '1 possible duplicate to check');
  assert.equal(item(items, 'coverage').title, '3 months with incomplete account coverage');
  assert.equal(item(items, 'net-p2-pay').severity, 'info'); // joint scope by default
  assert.equal(item(items, 'contrib-p2-contribution').detail, '$1,325 transfers were observed twice a month. Confirm it is the planned amount and timing.');
  const reimb = items.filter(i => /^reimb-/.test(i.id));
  assert.equal(reimb.length, 1);
  assert.match(reimb[0].title, /^Is Sample Airlines \(\$486\.60\) being reimbursed\?$/);
});

test('sample: only spending is described as counted in spending among uncertain rows', () => {
  const { ds, state, txns } = sampleState();
  const u = item(A.list({ dataset: ds, txns, state }), 'uncertain');
  assert.equal(u.title, '2 transactions need a category');
  // $80.00 of spending; the $486.60 deposit is income, not spending.
  assert.equal(u.detail, '$80.00 is counted in spending but sits in an uncertain category. 1 other transaction ($486.60) is not spending; check that it is counted as the right kind (income, transfer or reimbursement).');
});

test('sample: the annual home insurance is not an unusual-spending item; the dental episode is', () => {
  const { ds, state, txns } = sampleState();
  const spikes = A.list({ dataset: ds, txns, state }).filter(i => /^spike/.test(i.id));
  assert.deepEqual(ids(spikes), ['spike-2026-08Dental']);
  assert.equal(spikes[0].severity, 'decision');
  assert.equal(spikes[0].title, 'Unusual Dental spending in Aug 2026: $1,988');
});

test('sample: a spike already decided for planning is not listed', () => {
  const { ds } = sampleState();
  const dental = L.applyEdits(ds, {}).filter(t => t.category === 'Dental' && t.date.startsWith('2026-08'));
  const edits = { [dental[0].id]: { planningBaseline: 'exclude', history: [] } };
  const { state, txns } = sampleState(edits);
  assert.ok(!A.list({ dataset: ds, txns, state }).some(i => /^spike/.test(i.id)));
});

test('sample: dismissing data items removes them', () => {
  const { ds, state, txns } = sampleState();
  state.ui.dismissed = { 'attention:dupes': true, 'attention:spike-2026-08Dental': true };
  const items = A.list({ dataset: ds, txns, state });
  assert.ok(!item(items, 'dupes'));
  assert.ok(!item(items, 'spike-2026-08Dental'));
  assert.ok(item(items, 'uncertain'));
});

test('sample: the whole-household scope makes unknown take-home pay a decision', () => {
  const { ds, state, txns } = sampleState();
  state.ui.scope = 'household';
  assert.equal(item(A.list({ dataset: ds, txns, state }), 'net-p2-pay').severity, 'decision');
});

// ======================================================================= data items (built)

const ACCOUNTS = [
  { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] },
  { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] }
];
let seq = 0;
const tx = (date, amountCents, fields = {}) => Object.assign({ id: 'a' + String(++seq).padStart(4, '0'), accountId: 'card', date, description: 'SAMPLE SHOP ' + seq, amountCents, kind: 'spend', category: 'Groceries' }, fields);
const dataset = rows => L.normalizeDataset({ schemaVersion: 2, datasetId: 'attention-test', isSynthetic: true, accounts: ACCOUNTS, transactions: rows });

test('spikes: decided spikes do not hide undecided ones; more than two are summarised', () => {
  const rows = [tx('2026-05-10', -90000, { id: 'trav', category: 'Travel' }), tx('2026-06-10', -90000, { id: 'elec', category: 'Electronics' }),
    tx('2026-07-10', -90000, { id: 'hob', category: 'Hobbies' }), tx('2026-08-10', -90000, { id: 'gift', category: 'Gifts & donations' })];
  const ds = dataset(rows);
  // The two newest are decided: the older undecided spikes are still listed.
  const decided = { gift: { planningBaseline: 'include', history: [] }, hob: { planningBaseline: 'exclude', history: [] } };
  const st = stateWith({}, {}, { ledgerEdits: decided });
  const items = A.list({ dataset: ds, txns: L.applyEdits(ds, decided), state: st });
  assert.deepEqual(ids(items.filter(i => /^spike/.test(i.id))), ['spike-2026-06Electronics', 'spike-2026-05Travel']);
  // Four undecided: two listed, the rest summarised rather than dropped.
  const all = A.list({ dataset: ds, txns: L.applyEdits(ds, {}), state: stateWith() });
  assert.deepEqual(ids(all.filter(i => /^spike/.test(i.id))), ['spike-2026-08Gifts & donations', 'spike-2026-07Hobbies', 'spikes-more']);
  assert.equal(item(all, 'spikes-more').title, '2 more months with unusual spending');
});

const loneDeposit = (id, cents, date) => tx(date, cents, { id, accountId: 'chk', kind: 'income', subtype: 'other', category: 'Income', description: 'MOBILE DEPOSIT', flags: ['reimbursement_candidate'] });

test('reimbursements: a flagged deposit with no charge gets its own id and wording', () => {
  const ds = dataset([loneDeposit('lone', 12000, '2026-08-21'), loneDeposit('lone2', 15000, '2026-08-22')]);
  const items = A.list({ dataset: ds, txns: L.applyEdits(ds, {}), state: stateWith() });
  const r = items.filter(i => /^reimb-/.test(i.id));
  assert.deepEqual(ids(r).sort(), ['reimb-lone', 'reimb-lone2']);
  assert.equal(item(r, 'reimb-lone').title, 'Is the $120.00 deposit a reimbursement?');
  assert.equal(item(r, 'reimb-lone').severity, 'decision');
});

test('reimbursements: more than three pending are summarised, not dropped', () => {
  const rows = ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']
    .map((d, i) => tx(d, -(20000 + i), { id: 'c' + i, merchant: 'Sample Air ' + i, category: 'Travel', flags: ['reimbursement_candidate'] }));
  const ds = dataset(rows);
  const items = A.list({ dataset: ds, txns: L.applyEdits(ds, {}), state: stateWith() });
  const shown = items.filter(i => /^reimb-c/.test(i.id));
  assert.equal(shown.length, 3);
  for (const i of shown) assert.match(i.title, /^Is Sample Air \d \(\$200\.0\d\) being reimbursed\?$/);
  const more = item(items, 'reimb-more');
  assert.equal(more.title, '2 more possible reimbursements');
  assert.equal(more.severity, 'decision');
});

// ======================================================================= starting balance

/** The ACCOUNTS above with the bank's own checking balance for Sep 30 supplied with the data. */
const withBankBalance = rows => L.normalizeDataset({ schemaVersion: 2, datasetId: 'attention-test', isSynthetic: true, accounts: ACCOUNTS, transactions: rows,
  balances: [{ accountId: 'chk', date: '2026-09-30', cents: 512340, source: 'bank' }] });
const NOTHING_ENTERED = { balances: { jointCashCents: null, asOf: null, note: '' } };

test('balance: a balance supplied with the data counts as known, with or without an entered one', () => {
  const ds = withBankBalance([tx('2026-09-12', -4200)]);
  const st = deepFreeze(stateWith(NOTHING_ENTERED));
  assert.equal(E.timeline.anchors(st.plan, ds).combined.cents, 512340, 'the Plan page starts from the bank figure');
  // Worked out from the data when the caller does not say, and as the caller says otherwise.
  assert.equal(item(A.list({ dataset: ds, txns: L.applyEdits(ds, {}), state: st }), 'balance'), undefined);
  assert.equal(item(A.list({ dataset: ds, txns: L.applyEdits(ds, {}), state: st, balanceKnown: true }), 'balance'), undefined);
});

test('balance: with no balance anywhere, "Enter today’s balances" keeps its wording and route', () => {
  const ds = dataset([tx('2026-09-12', -4200)]); // no supplied balance, no running balance
  const st = deepFreeze(stateWith(NOTHING_ENTERED));
  assert.equal(E.timeline.anchors(st.plan, ds).combined, null);
  for (const extra of [{}, { balanceKnown: false }]) {
    const b = item(A.list(Object.assign({ dataset: ds, txns: L.applyEdits(ds, {}), state: st }, extra)), 'balance');
    assert.ok(b, 'listed: ' + JSON.stringify(extra));
    assert.equal(b.title, 'Enter today’s balances');
    assert.equal(b.detail, 'Bank exports do not include balances. Until you add them on the Plan page, the chart shows money in and out, not how much you will have.');
    assert.equal(b.route, '#/overview');
    assert.equal(b.severity, 'decision');
  }
});

test('balance: on the sample, the bank running balance alone is enough (nothing entered at all)', () => {
  const { ds, state, txns } = sampleState();
  state.plan.balances = Object.assign({}, state.plan.balances, { jointCashCents: null, asOf: null, accounts: {}, accountDates: {} });
  const anc = E.timeline.anchors(state.plan, ds, txns);
  assert.ok(anc.combined && anc.accounts.every(a => a.source !== 'entered'), 'a balance comes with the data');
  assert.equal(item(A.list({ dataset: ds, txns, state }), 'balance'), undefined);
  assert.equal(item(A.list({ dataset: ds, txns, state, balanceKnown: !!anc.combined }), 'balance'), undefined);
});

// ======================================================================= forecast items

test('forecast: negative months and scenario amounts not entered come from the projection', () => {
  const { ds, state, txns } = sampleState();
  const ctx = { project: (id, o = {}) => E.forecast.project(state.plan, state.scenarios.find(s => s.id === id), { startMonth: '2026-10', months: o.months || 24, scope: state.ui.scope }) };
  const items = A.list({ dataset: ds, txns, state, ctx });
  assertOrdered(items);
  const baby = item(items, 'scn-missing-baby-arrives');
  assert.equal(baby.severity, 'info');
  assert.equal(baby.title, '“Baby arrives (May 2027)” has 3 amounts not entered');
  assert.match(baby.detail, /Birth and hospital costs: amount not entered/);
  assert.equal(baby.route, '#/overview?compare=Baby%20arrives%20(May%202027)', 'Forecast is retired: the what-if opens in the Plan chart’s Compare');
  assert.ok(item(items, 'scn-missing-home-projects-scenario'));
});

test('forecast: a projection that throws leaves the rest of the list intact', () => {
  const st = stateWith({ balances: { jointCashCents: null, asOf: null, note: '' } });
  const items = A.list({ state: st, ctx: { project: () => { throw new Error('boom'); } } });
  assert.deepEqual(ids(items), ['balance']);
});

test('list() does not mutate its inputs', () => {
  const { ds, state, txns } = sampleState();
  deepFreeze(state);
  deepFreeze(txns);
  assert.doesNotThrow(() => A.list({ dataset: ds, txns, state }));
});
