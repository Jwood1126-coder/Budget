'use strict';
// Tests for BudgetEngine.state: defaults, sanitize, legacy migration, workbooks, scenario
// operations, validated paths and storage. Every household, amount and id here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const S = E.state;

const PROFILE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'sample-profile.json');
const profile = () => JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const DS = { datasetId: 'sample' };
const NOW = '2026-10-01T12:00:00.000Z';
const LATER = '2026-10-02T08:30:00.000Z';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const base = () => S.defaults(profile(), DS);
const byId = (list, id) => list.find(x => x.id === id);
const hasNote = (notes, re) => notes.some(n => re.test(n));
const isValidationError = re => err => err instanceof E.ValidationError && (!re || re.test(err.message));

/** The earlier app's saved defaults (version 4) with invented "observed" targets. */
function legacyV4() {
  return {
    version: 4,
    forecast: {
      start: '2031-10', months: 36, babyStart: '', childcareStart: '', leaveStart: '', leaveMonths: 0,
      incomeGrowth: 0, expenseGrowth: 0, cashYield: 0,
      oneoffs: [{ label: 'Home repair', amount: null, month: '' }, { label: 'Celebration', amount: null, month: '' }, { label: 'Family setup', amount: null, month: '' }],
      debtEnds: { vehicleA: '', student: '', vehicleB: '', storeCard: '' }
    },
    vehicleBFunding: 'unknown', healthMode: 'separate', healthMigrationNotice: false, auditBudgetNotice: false,
    planMode: 'household', personAPay: 3000, personAFrequency: '', personBPay: null, personBFrequency: '',
    personAAllocation: 350, personBContribution: 2000, incomeBasis: 'regular', otherIncome: 0, otherExpenses: null,
    childcare: null, babyCosts: null, leaveReduction: 0, homeFund: null, emergencyFund: null, anniversaryFund: null,
    otherSavings: 0, currentCash: null, cashGoal: null,
    targets: {
      mortgage: 1466.21, energy: 180, municipal: 61.27, groceries: 712.46, dining: 233.1, shopping: 498.75,
      fuel: 151.38, vehicle: 42.5, pets: 55.12, home: 96.4, medical: 38.9, dental: null, travel: 120.33,
      subscriptions: 27.48, entertainment: 18.99, phoneInsurance: null, cardFee: 10, storeCard: 40,
      vehicleA: 180, student: 220, vehicleB: 300, lifeInsurance: null, vision: 12.5, unclassified: 8.75
    },
    adjustments: { airfare: false, business: false },
    checks: {},
    tab: 'overview'
  };
}

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; }
  };
}

// ===================================================================== defaults

test('defaults: builds a complete version-5 state from the sample profile', () => {
  const st = base();
  assert.equal(st.version, 5);
  assert.equal(st.datasetId, 'sample');
  assert.deepEqual(Object.keys(st), ['version', 'datasetId', 'plan', 'scenarios', 'compareIds', 'ledgerEdits', 'references', 'checklist', 'ui', 'meta']);
  assert.deepEqual(st.plan.people, [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }]);
  assert.deepEqual(st.ledgerEdits, {});
  assert.deepEqual(st.references, []);
  assert.deepEqual(st.checklist, {});
});

test('defaults: the baseline comes first, is called "Current budget" and has no changes', () => {
  const st = base();
  assert.equal(st.scenarios[0].id, 'baseline');
  assert.equal(st.scenarios[0].name, 'Current budget');
  assert.deepEqual(st.scenarios[0].events, []);
  assert.deepEqual(st.scenarios.map(s => s.id), ['baseline', 'baby-arrives', 'home-projects-scenario']);
});

test('defaults: compares the baseline with the first other scenario', () => {
  assert.deepEqual(base().compareIds, ['baseline', 'baby-arrives']);
  assert.deepEqual(S.defaults(null, DS).compareIds, ['baseline']);
});

test('defaults: joint scope, overview route, what-ifs off and epoch timestamps', () => {
  const st = base();
  assert.deepEqual(st.ui, { scope: 'joint', lastRoute: '#/overview', whatIf: { excludePendingReimbursements: false, excludeBusinessCandidates: false }, dismissed: {} });
  assert.deepEqual(st.meta, { createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z', migratedFrom: null, migrationNotes: [], legacySnapshot: null });
  assert.equal(st.scenarios[1].createdAt, '1970-01-01T00:00:00.000Z');
});

test('defaults: uses the supplied { now } for every timestamp', () => {
  const st = S.defaults(profile(), DS, { now: NOW });
  assert.equal(st.meta.createdAt, NOW);
  assert.equal(st.meta.updatedAt, NOW);
  assert.ok(st.scenarios.every(s => s.createdAt === NOW && s.updatedAt === NOW));
  assert.equal(S.defaults(profile(), DS, { now: 'yesterday' }).meta.createdAt, '1970-01-01T00:00:00.000Z');
});

test('defaults: without a profile gives an empty plan for Partner A and Partner B', () => {
  const st = S.defaults(null, null);
  assert.equal(st.datasetId, 'no-data');
  assert.deepEqual(st.plan.people, [{ id: 'p1', name: 'Partner A' }, { id: 'p2', name: 'Partner B' }]);
  assert.deepEqual(st.plan.incomes, []);
  assert.deepEqual(st.plan.targets, {});
  assert.deepEqual(st.plan.balances, { jointCashCents: null, asOf: null, note: '' });
  assert.deepEqual(st.plan.settings, { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 });
  assert.equal(st.scenarios.length, 1);
});

test('defaults: dataset id comes from the dataset object or a plain id', () => {
  assert.equal(S.defaults(null, 'my-data').datasetId, 'my-data');
  assert.equal(S.defaults(null, { datasetId: '  trimmed  ' }).datasetId, 'trimmed');
  assert.equal(S.defaults(null, { datasetId: '' }).datasetId, 'no-data');
});

test('defaults: does not modify the profile and is deterministic', () => {
  const p = deepFreeze(profile());
  const a = S.defaults(p, DS);
  const b = S.defaults(p, DS);
  assert.deepEqual(a, b);
  assert.notEqual(a.plan, b.plan);
});

test('defaults: profile scenarios without ids get stable generated ids', () => {
  const p = profile();
  p.scenarios = [{ name: 'Sabbatical', events: [{ type: 'one_time', label: 'Course fee', month: '2027-01', amountCents: null }] }];
  const a = S.defaults(p, DS);
  const b = S.defaults(p, DS);
  assert.equal(a.scenarios[1].name, 'Sabbatical');
  assert.match(a.scenarios[1].id, /^scenario-[a-z0-9]+$/);
  assert.equal(a.scenarios[1].id, b.scenarios[1].id);
  assert.equal(a.scenarios[1].events[0].id, b.scenarios[1].events[0].id);
});

test('defaults: a profile scenario that claims the baseline id is renamed, not merged', () => {
  const p = profile();
  p.scenarios = [{ id: 'baseline', name: 'Imposter', events: [] }];
  const st = S.defaults(p, DS);
  assert.equal(st.scenarios[0].name, 'Current budget');
  assert.equal(st.scenarios[1].id, 'baseline-2');
});

test('sanitize(defaults) is a no-op', () => {
  for (const [p, opts] of [[profile(), {}], [null, {}], [profile(), { now: NOW }]]) {
    const st = S.defaults(p, DS, opts);
    const r = S.sanitize(st, p, DS, opts);
    assert.deepEqual(r.notes, []);
    assert.equal(JSON.stringify(r.state), JSON.stringify(st));
  }
});

// ===================================================================== sample profile

test('sample profile: synthetic household Alex & Sam', () => {
  const p = profile();
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.isSynthetic, true);
  assert.equal(p.household.name, 'Alex & Sam (sample)');
  assert.deepEqual(p.household.people, [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }]);
});

test('sample profile: income streams match the plan facts', () => {
  const { incomes } = base().plan;
  assert.deepEqual(incomes.map(s => s.id), ['p1-pay', 'p2-pay', 'p2-contribution']);
  const alex = byId(incomes, 'p1-pay');
  assert.equal(alex.netPerPaycheckCents, 224000);
  assert.equal(alex.jointPerPaycheckCents, 188000);
  assert.equal(alex.frequency, 'biweekly');
  assert.equal(alex.frequencyStatus, 'confirmed');
  assert.equal(alex.anchorDate, '2024-10-04');
  const samPay = byId(incomes, 'p2-pay');
  assert.equal(samPay.netPerPaycheckCents, null);
  assert.equal(samPay.jointPerPaycheckCents, null);
  assert.equal(samPay.frequency, 'unknown');
  const contribution = byId(incomes, 'p2-contribution');
  assert.equal(contribution.kind, 'contribution');
  assert.equal(contribution.jointPerPaycheckCents, 132500);
  assert.equal(contribution.frequency, 'semimonthly');
  assert.equal(contribution.frequencyStatus, 'observed');
  assert.deepEqual(contribution.semimonthlyDays, [1, 15]);
});

test('sample profile: bills match the plan facts', () => {
  const { bills } = base().plan;
  const expect = {
    mortgage: [141256, 'joint', 'existing'], internet: [7500, 'joint', 'existing'], wireless: [9240, 'joint', 'existing'],
    'home-insurance': [9200, 'joint', 'existing'], 'store-card': [5500, 'joint', 'existing'], 'p1-car': [24500, 'p1', 'existing'],
    'p1-student-loans': [28950, 'p1', 'existing'], 'p2-car': [37200, 'unknown', 'existing'], 'life-insurance': [4000, 'joint', 'planned']
  };
  assert.deepEqual(bills.map(b => b.id).sort(), Object.keys(expect).sort());
  for (const [id, [cents, fundedFrom, status]] of Object.entries(expect)) {
    const b = byId(bills, id);
    assert.equal(b.monthlyCents, cents, id);
    assert.equal(b.fundedFrom, fundedFrom, id);
    assert.equal(b.status, status, id);
  }
  // Debt payments are not category spending.
  assert.equal(byId(bills, 'store-card').category, null);
  assert.equal(byId(bills, 'mortgage').debtId, 'mortgage');
});

test('sample profile: debts keep unknowns unknown', () => {
  const { debts } = base().plan;
  const mortgage = byId(debts, 'mortgage');
  assert.equal(mortgage.balanceCents, 14800000);
  assert.equal(mortgage.balanceStatus, 'approximate');
  assert.equal(mortgage.aprPct, null);
  assert.equal(mortgage.escrowIncluded, null);
  const loans = byId(debts, 'p1-student-loans');
  assert.equal(loans.balanceCents, 1421280);
  assert.deepEqual(loans.aprRange, [3.73, 6.28]);
  assert.equal(loans.aprStatus, 'displayed');
  assert.equal(loans.loanCount, 6);
  assert.equal(loans.repaymentPlan, null);
  const card = byId(debts, 'store-card');
  assert.equal(card.balanceCents, 198035);
  assert.deepEqual([card.promo.balanceCents, card.promo.expiresMonth, card.promo.deferredInterest], [null, null, null]);
  assert.equal(byId(debts, 'p1-car').balanceCents, 590000);
  assert.equal(byId(debts, 'p2-car').balanceCents, 2480000);
});

test('sample profile: targets use taxonomy names and some are deliberately blank', () => {
  const { targets } = base().plan;
  const names = new Set(E.categories.names());
  for (const k of Object.keys(targets)) assert.ok(names.has(k), k + ' is a taxonomy category');
  assert.equal(targets.Groceries, 60000);
  assert.equal(targets.Dental, null);
  assert.ok(Object.values(targets).filter(v => v === null).length >= 3);
  // Housing, phone and insurance are bills, so they have no targets (no double counting).
  for (const k of ['Mortgage', 'Internet & phone', 'Home insurance']) assert.equal(k in targets, false);
});

test('sample profile: savings goals, balances and settings', () => {
  const { plan } = base();
  const emergency = byId(plan.savings, 'emergency');
  assert.deepEqual([emergency.targetCents, emergency.savedCents, emergency.monthlyCents, emergency.spendAtTarget], [1500000, null, 15000, false]);
  const trip = byId(plan.savings, 'anniversary-trip');
  assert.deepEqual([trip.targetCents, trip.targetMonth, trip.savedCents, trip.monthlyCents, trip.spendAtTarget], [240000, '2027-09', 0, 20000, true]);
  const home = byId(plan.savings, 'home-projects');
  assert.deepEqual([home.targetCents, home.monthlyCents, home.spendAtTarget], [null, 10000, false]);
  assert.equal(plan.balances.jointCashCents, null);
  assert.deepEqual(plan.settings, { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 });
});

test('sample profile: scenario amounts that are unknown are null, never invented', () => {
  const st = base();
  const baby = byId(st.scenarios, 'baby-arrives');
  assert.equal(baby.name, 'Baby arrives (May 2027)');
  assert.equal(byId(baby.events, 'baby-supplies').monthlyCents, 25000);
  const childcare = byId(baby.events, 'childcare');
  assert.deepEqual([childcare.type, childcare.startMonth, childcare.monthlyCents], ['recurring', '2027-09', null]);
  const birth = byId(baby.events, 'birth-costs');
  assert.deepEqual([birth.type, birth.month, birth.amountCents], ['one_time', '2027-05', null]);
  const leave = byId(baby.events, 'p2-leave');
  assert.deepEqual([leave.type, leave.streamId, leave.startMonth, leave.endMonth, leave.jointPerPaycheckCents], ['income_change', 'p2-contribution', '2027-05', '2027-07', null]);
  assert.equal('netPerPaycheckCents' in leave, false, 'take-home is not changed by this event');
  const home = byId(st.scenarios, 'home-projects-scenario');
  assert.deepEqual(home.events.map(e => [e.label, e.month, e.amountCents, e.goalId]), [
    ['Attic insulation', '2026-11', null, 'home-projects'],
    ['Window replacement', '2027-04', null, 'home-projects'],
    ['Electrical panel', '2027-06', null, 'home-projects']
  ]);
  for (const s of st.scenarios) for (const ev of s.events) if (ev.amountCents === null || ev.monthlyCents === null) assert.ok(ev.note.length > 0, ev.id + ' explains its unknown');
});

test('sample profile: every unknown has an explanation', () => {
  const p = profile();
  assert.ok(p.notes.length >= 5);
  const { plan } = base();
  for (const s of plan.incomes) if (s.netPerPaycheckCents === null && s.kind === 'paycheck') assert.match(s.note, /Unknown/);
  assert.match(byId(plan.bills, 'p2-car').note, /Unknown/);
  assert.match(byId(plan.debts, 'store-card').promo.note, /Unverified/);
  assert.match(plan.balances.note, /Unknown/);
});

// ===================================================================== sanitize

test('sanitize: an invalid amount becomes unknown with a note; valid siblings are kept', () => {
  const st = base();
  const raw = JSON.parse(JSON.stringify(st));
  byId(raw.plan.bills, 'mortgage').monthlyCents = -500;
  byId(raw.plan.bills, 'internet').monthlyCents = 12.5;
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(byId(r.state.plan.bills, 'mortgage').monthlyCents, null);
  assert.equal(byId(r.state.plan.bills, 'internet').monthlyCents, null);
  assert.equal(byId(r.state.plan.bills, 'wireless').monthlyCents, 9240);
  assert.equal(byId(r.state.plan.bills, 'mortgage').label, 'Mortgage');
  assert.ok(hasNote(r.notes, /plan\.bills\[id=mortgage\]\.monthlyCents: -500 is not valid/));
  assert.ok(hasNote(r.notes, /plan\.bills\[id=internet\]\.monthlyCents/));
});

test('sanitize: amounts above $100 million are rejected', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.targets.Groceries = 10000000001;
  raw.plan.balances.jointCashCents = -250000;
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.plan.targets.Groceries, null);
  assert.equal(r.state.plan.balances.jointCashCents, -250000, 'an overdrawn balance is allowed');
  assert.ok(hasNote(r.notes, /plan\.targets\.Groceries/));
});

test('sanitize: invalid enums, months and dates reset to defaults with notes', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  const alex = byId(raw.plan.incomes, 'p1-pay');
  alex.frequency = 'fortnightly';
  alex.anchorDate = '2024-02-30';
  alex.startMonth = '2026-13';
  raw.plan.settings.comparisonWindow = 5;
  raw.plan.settings.incomeTiming = 'average';
  const r = S.sanitize(raw, profile(), DS);
  const out = byId(r.state.plan.incomes, 'p1-pay');
  assert.equal(out.frequency, 'unknown');
  assert.equal(out.anchorDate, null);
  assert.equal(out.startMonth, null);
  assert.equal(out.netPerPaycheckCents, 224000);
  assert.equal(r.state.plan.settings.comparisonWindow, 3);
  assert.equal(r.state.plan.settings.incomeTiming, 'average');
  for (const re of [/frequency: "fortnightly"/, /anchorDate/, /startMonth/, /settings\.comparisonWindow/]) assert.ok(hasNote(r.notes, re), String(re));
});

test('sanitize: labels and notes are trimmed and capped (80 / 500 characters)', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.plan.bills, 'internet').label = '  Internet  ';
  byId(raw.plan.bills, 'wireless').label = 'W'.repeat(120);
  byId(raw.plan.bills, 'wireless').note = 'n'.repeat(600);
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(byId(r.state.plan.bills, 'internet').label, 'Internet');
  assert.equal(byId(r.state.plan.bills, 'wireless').label.length, 80);
  assert.equal(byId(r.state.plan.bills, 'wireless').note.length, 500);
  assert.ok(hasNote(r.notes, /wireless\]\.label: shortened to 80/));
  assert.ok(hasNote(r.notes, /wireless\]\.note: shortened to 500/));
});

test('sanitize: a blank label falls back to a default name with a note', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.plan.savings, 'emergency').label = '   ';
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(byId(r.state.plan.savings, 'emergency').label, 'Savings goal');
  assert.ok(hasNote(r.notes, /savings\[id=emergency\]\.label/));
});

test('sanitize: lists are capped (60 bills, 12 incomes, 30 savings goals)', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.bills = Array.from({ length: 70 }, (_, i) => ({ id: 'b' + i, label: 'Bill ' + i, monthlyCents: 100 }));
  raw.plan.incomes = Array.from({ length: 15 }, (_, i) => ({ id: 'i' + i, label: 'Income ' + i }));
  raw.plan.savings = Array.from({ length: 31 }, (_, i) => ({ id: 'g' + i, label: 'Goal ' + i }));
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.plan.bills.length, 60);
  assert.equal(r.state.plan.bills[59].id, 'b59');
  assert.equal(r.state.plan.incomes.length, 12);
  assert.equal(r.state.plan.savings.length, 30);
  assert.ok(hasNote(r.notes, /plan\.bills: only 60 entries can be kept; 10 more were dropped/));
  assert.ok(hasNote(r.notes, /plan\.incomes: only 12/));
  assert.ok(hasNote(r.notes, /plan\.savings: only 30/));
});

test('sanitize: duplicate ids are renamed deterministically', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.bills.push({ id: 'mortgage', label: 'Second mortgage', monthlyCents: 30000, fundedFrom: 'joint' });
  raw.plan.bills.push({ id: 'mortgage', label: 'Third', monthlyCents: 100 });
  const a = S.sanitize(raw, profile(), DS);
  const b = S.sanitize(raw, profile(), DS);
  const ids = a.state.plan.bills.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('mortgage-2') && ids.includes('mortgage-3'));
  assert.equal(byId(a.state.plan.bills, 'mortgage-2').label, 'Second mortgage');
  assert.deepEqual(a.state, b.state);
  assert.ok(hasNote(a.notes, /"mortgage" was used twice; this entry is now "mortgage-2"/));
});

test('sanitize: entries without a usable id get a stable generated id', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.savings.push({ label: 'New sofa', monthlyCents: 5000 });
  raw.plan.savings.push({ id: 'has space', label: 'Bad id', monthlyCents: 100 });
  const a = S.sanitize(raw, profile(), DS);
  const b = S.sanitize(raw, profile(), DS);
  const sofa = a.state.plan.savings.find(g => g.label === 'New sofa');
  assert.match(sofa.id, /^goal-[a-z0-9]+$/);
  assert.equal(sofa.id, b.state.plan.savings.find(g => g.label === 'New sofa').id);
  assert.ok(hasNote(a.notes, /the id "has space" is not usable/));
});

test('sanitize: entries that are not objects are dropped with a note', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.bills.splice(1, 0, 'oops', null, 7);
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.plan.bills.length, base().plan.bills.length);
  assert.ok(hasNote(r.notes, /plan\.bills\[1\]: not a valid entry \("oops"\)/));
});

test('sanitize: category keys may be any name from 1 to 80 characters', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.targets['Kids activities'] = 12000;
  raw.plan.targets['Misc. (cash)'] = null;
  raw.plan.targets[''] = 500;
  raw.plan.targets['   '] = 500;
  raw.plan.targets['x'.repeat(81)] = 500;
  raw.plan.targets['  Groceries  '] = 1;
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.plan.targets['Kids activities'], 12000);
  assert.equal(r.state.plan.targets['Misc. (cash)'], null);
  assert.equal('' in r.state.plan.targets, false);
  assert.equal(Object.keys(r.state.plan.targets).some(k => k.length > 80), false);
  assert.equal(r.state.plan.targets.Groceries, 60000, 'the first Groceries wins; the trimmed duplicate is dropped');
  assert.ok(hasNote(r.notes, /category name "" is not usable/));
  assert.ok(hasNote(r.notes, /"Groceries" appears twice/));
});

test('sanitize: an end month before the start month is cleared with a note', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  Object.assign(byId(raw.plan.bills, 'p1-car'), { startMonth: '2026-05', endMonth: '2026-01' });
  const r = S.sanitize(raw, profile(), DS);
  const car = byId(r.state.plan.bills, 'p1-car');
  assert.deepEqual([car.startMonth, car.endMonth], ['2026-05', null]);
  assert.ok(hasNote(r.notes, /p1-car\]\.endMonth: 2026-01 is before/));
});

test('sanitize: fields that are not part of the format are dropped with a note', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.extraTopLevel = { a: 1 };
  raw.plan.mystery = true;
  byId(raw.plan.bills, 'internet').colour = 'blue';
  const r = S.sanitize(raw, profile(), DS);
  assert.equal('extraTopLevel' in r.state, false);
  assert.equal('mystery' in r.state.plan, false);
  assert.equal('colour' in byId(r.state.plan.bills, 'internet'), false);
  for (const re of [/^extraTopLevel: not part/, /plan\.mystery: not part/, /internet\]\.colour: not part/]) assert.ok(hasNote(r.notes, re), String(re));
});

test('sanitize: a missing baseline is restored and a misplaced one moved first', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  const [baseline, ...others] = raw.scenarios;
  raw.scenarios = others;
  let r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.scenarios[0].id, 'baseline');
  assert.equal(r.state.scenarios[0].name, 'Current budget');
  assert.ok(hasNote(r.notes, /was missing and has been restored/));

  raw.scenarios = [...others, baseline];
  r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.scenarios.map(s => s.id), ['baseline', 'baby-arrives', 'home-projects-scenario']);
  assert.ok(hasNote(r.notes, /moved back to the first place/));
});

test('sanitize: changes saved on the baseline move to a new scenario instead of being lost', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.scenarios[0].events = [{ id: 'oops', type: 'one_time', label: 'Deck stain', month: '2027-04', amountCents: 61750 }];
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.scenarios[0].events, []);
  const moved = r.state.scenarios.find(s => s.name === 'Changes moved from the current budget');
  assert.ok(moved);
  assert.equal(moved.events[0].label, 'Deck stain');
  assert.equal(moved.events[0].amountCents, 61750);
  assert.ok(hasNote(r.notes, /cannot hold planned changes.*"Deck stain"/));
});

test('sanitize: at most 20 scenarios and 200 changes per scenario', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  for (let i = 0; i < 25; i++) raw.scenarios.push({ id: 'extra-' + i, name: 'Extra ' + i, events: [] });
  raw.scenarios[1].events = Array.from({ length: 205 }, (_, i) => ({ id: 'e' + i, type: 'one_time', label: 'Item ' + i, month: null, amountCents: 100 }));
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.scenarios.length, 20);
  assert.equal(r.state.scenarios[0].id, 'baseline');
  assert.equal(r.state.scenarios[1].events.length, 200);
  assert.ok(hasNote(r.notes, /only 20 scenarios can be kept/));
  assert.ok(hasNote(r.notes, /only 200 changes can be kept in one scenario; 5 more were dropped/));
});

test('sanitize: invalid changes are dropped and named in notes', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  const baby = byId(raw.scenarios, 'baby-arrives');
  baby.events.push({ id: 'x1', type: 'teleport', label: 'Moon trip' });
  baby.events.push({ id: 'x2', type: 'income_change', label: 'Raise', startMonth: '2027-01', jointPerPaycheckCents: 1000 });
  baby.events.push({ id: 'x3', type: 'bill_change', label: 'Refinance', billId: 'mortgage', monthlyCents: 120000 });
  baby.events.push({ id: 'x4', type: 'one_time', label: 'Stroller', month: 'May', amountCents: -5 });
  const r = S.sanitize(raw, profile(), DS);
  const ids = byId(r.state.scenarios, 'baby-arrives').events.map(e => e.id);
  assert.ok(!ids.includes('x1') && !ids.includes('x2') && !ids.includes('x3'));
  const stroller = byId(byId(r.state.scenarios, 'baby-arrives').events, 'x4');
  assert.deepEqual([stroller.month, stroller.amountCents], [null, null]);
  assert.ok(hasNote(r.notes, /"Moon trip".*unknown kind of change "teleport"/));
  assert.ok(hasNote(r.notes, /"Raise".*income is missing/));
  assert.ok(hasNote(r.notes, /"Refinance".*start month is missing.*120000/));
});

test('sanitize: income_change keeps "unchanged" (absent) apart from "unknown" (null)', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.scenarios, 'baby-arrives').events.push({ id: 'raise', type: 'income_change', label: 'Raise', streamId: 'p1-pay', startMonth: '2027-01', endMonth: null, netPerPaycheckCents: 240000 });
  const r = S.sanitize(raw, profile(), DS);
  const events = byId(r.state.scenarios, 'baby-arrives').events;
  const raise = byId(events, 'raise');
  assert.equal(raise.netPerPaycheckCents, 240000);
  assert.equal('jointPerPaycheckCents' in raise, false);
  const leave = byId(events, 'p2-leave');
  assert.equal(leave.jointPerPaycheckCents, null);
  assert.equal('netPerPaycheckCents' in leave, false);
});

test('sanitize: change ids are unique across all scenarios', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.scenarios, 'home-projects-scenario').events[0].id = 'childcare';
  const r = S.sanitize(raw, profile(), DS);
  const all = r.state.scenarios.flatMap(s => s.events.map(e => e.id));
  assert.equal(new Set(all).size, all.length);
  assert.equal(byId(r.state.scenarios, 'home-projects-scenario').events[0].id, 'childcare-2');
});

test('sanitize: compareIds keep existing scenarios only, at most three, never empty', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.compareIds = ['ghost', 'home-projects-scenario', 'home-projects-scenario', 'baseline', 'baby-arrives'];
  let r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.compareIds, ['home-projects-scenario', 'baseline', 'baby-arrives']);
  assert.ok(hasNote(r.notes, /"ghost" no longer exists/));
  raw.compareIds = ['ghost'];
  r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.compareIds, ['baseline', 'baby-arrives']);
  raw.compareIds = 'baseline';
  r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.compareIds, ['baseline', 'baby-arrives']);
  assert.ok(hasNote(r.notes, /compareIds: not a list/));
});

test('sanitize: transaction corrections are validated field by field', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.ledgerEdits = {
    t1: { category: ' Groceries ', categoryReason: 'Receipt', duplicate: 'maybe', reimbursement: 'confirmed', history: [{ at: NOW, field: 'category', from: 'Mixed retail', to: 'Groceries', reason: 'Receipt' }] },
    t2: { kind: 'gift', splits: [{ category: 'Groceries', cents: 1.5 }], note: 'checked' },
    t3: 'nonsense',
    t4: {},
    t5: { planningBaseline: 'exclude', history: 'nope', weird: 1 }
  };
  const r = S.sanitize(raw, profile(), DS);
  const e = r.state.ledgerEdits;
  assert.deepEqual(e.t1, { category: 'Groceries', categoryReason: 'Receipt', reimbursement: 'confirmed', history: [{ at: NOW, field: 'category', from: 'Mixed retail', to: 'Groceries', reason: 'Receipt' }] });
  assert.deepEqual(e.t2, { note: 'checked', history: [] });
  assert.equal('t3' in e, false);
  assert.equal('t4' in e, false);
  assert.deepEqual(e.t5, { planningBaseline: 'exclude', history: [] });
  for (const re of [/ledgerEdits\[t1\]\.duplicate: not one of/, /ledgerEdits\[t2\]\.kind/, /ledgerEdits\[t2\]\.splits/, /ledgerEdits\[t3\]: not a valid correction/, /ledgerEdits\[t5\]\.history: not a list/, /ledgerEdits\[t5\]\.weird/]) {
    assert.ok(hasNote(r.notes, re), String(re));
  }
});

test('sanitize: correction history is kept, capped at the latest 200 entries', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  const history = Array.from({ length: 230 }, (_, i) => ({ at: NOW, field: 'note', from: null, to: 'v' + i, reason: '' }));
  raw.ledgerEdits = { t1: { note: 'v229', history } };
  const r = S.sanitize(raw, profile(), DS);
  const kept = r.state.ledgerEdits.t1.history;
  assert.equal(kept.length, 200);
  assert.equal(kept[0].to, 'v30');
  assert.equal(kept[199].to, 'v229');
  assert.ok(hasNote(r.notes, /only the latest 200 history entries are kept; 30 older ones/));
});

test('sanitize: a correction with valid splits keeps them whole', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.ledgerEdits = { t9: { splits: [{ category: 'Groceries', cents: 4000 }, { category: 'Household & hardware', cents: 2418 }], history: [] } };
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.ledgerEdits.t9.splits, [{ category: 'Groceries', cents: 4000 }, { category: 'Household & hardware', cents: 2418 }]);
  assert.deepEqual(r.notes, []);
});

test('sanitize: unreadable input gives the defaults with a note', () => {
  for (const bad of [null, 42, [], 'not json', '{"broken":', true]) {
    const r = S.sanitize(bad, profile(), DS);
    assert.deepEqual(r.state, base(), preview(bad));
    assert.equal(r.notes.length, 1, preview(bad));
  }
  function preview(v) { return JSON.stringify(v); }
});

test('sanitize: unknown and newer versions are noted', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.version = 7;
  let r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.version, 5);
  assert.ok(hasNote(r.notes, /newer version of the app \(version 7\)/));
  delete raw.version;
  r = S.sanitize(raw, profile(), DS);
  assert.ok(hasNote(r.notes, /version: undefined is not a known/));
});

test('sanitize: a state saved for another data set is attached to the current one with a note', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.datasetId = 'other-household';
  const r = S.sanitize(raw, profile(), DS);
  assert.equal(r.state.datasetId, 'sample');
  assert.ok(hasNote(r.notes, /saved for the data set "other-household" and is now used with "sample"/));
  assert.equal(S.sanitize(raw, profile(), null).state.datasetId, 'other-household');
});

test('sanitize: does not modify its input', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.plan.bills, 'mortgage').monthlyCents = -1;
  raw.scenarios[0].events = [{ type: 'one_time', label: 'Moved', month: null, amountCents: 1 }];
  const before = JSON.stringify(raw);
  deepFreeze(raw);
  S.sanitize(raw, profile(), DS);
  assert.equal(JSON.stringify(raw), before);
});

test('sanitize: is idempotent on messy input', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.bills.push({ id: 'mortgage', label: '  dup  ', monthlyCents: 'lots' });
  raw.plan.targets[' Spaces '] = -3;
  raw.scenarios.push({ name: '   ', events: [{ type: 'recurring', label: 'Gym', startMonth: '2027-02', endMonth: '2027-01', monthlyCents: 4500 }] });
  raw.compareIds = ['nope'];
  raw.ui = { scope: 'everyone', lastRoute: 'http://example.invalid', whatIf: { excludeBusinessCandidates: 'yes' } };
  const first = S.sanitize(raw, profile(), DS);
  assert.ok(first.notes.length > 0);
  const second = S.sanitize(first.state, profile(), DS);
  assert.deepEqual(second.notes, []);
  assert.deepEqual(second.state, first.state);
});

test('sanitize: references, checklist, ui and meta are validated', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.references = [
    { id: 'q3', label: 'Earlier quarter', start: '2026-07-01', end: '2026-09-30', spendingCents: 1234567, source: 'Earlier app' },
    { id: 'bad', label: 'Backwards', start: '2026-09-30', end: '2026-07-01', spendingCents: 1 },
    { id: 'nodate', label: 'No dates', spendingCents: 5 }
  ];
  raw.checklist = { balances: true, baby: 'yes' };
  raw.ui = { scope: 'household', lastRoute: '#/forecast?horizon=36', whatIf: { excludePendingReimbursements: true }, dismissed: { tip1: true } };
  raw.meta = { createdAt: NOW, updatedAt: 'tomorrow', migratedFrom: 9, migrationNotes: ['ok', 3], legacySnapshot: null };
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.references.map(x => x.id), ['q3']);
  assert.deepEqual(r.state.checklist, { balances: true });
  assert.deepEqual(r.state.ui, { scope: 'household', lastRoute: '#/forecast?horizon=36', whatIf: { excludePendingReimbursements: true, excludeBusinessCandidates: false }, dismissed: { tip1: true } });
  assert.equal(r.state.meta.createdAt, NOW);
  assert.equal(r.state.meta.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(r.state.meta.migratedFrom, null);
  assert.deepEqual(r.state.meta.migrationNotes, ['ok']);
  for (const re of [/Backwards.*end date/, /No dates.*start date is missing/, /checklist: dropped entries/, /meta\.updatedAt/, /meta\.migratedFrom/]) assert.ok(hasNote(r.notes, re), String(re));
});

test('sanitize: one personal-spending entry per person', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.personalSpending = [{ personId: 'p1', monthlyCents: 30000 }, { personId: 'p1', monthlyCents: 1 }, { personId: 'p3', monthlyCents: 2 }];
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.plan.personalSpending, [{ personId: 'p1', monthlyCents: 30000, note: '' }]);
  assert.ok(hasNote(r.notes, /second personal-spending entry for p1/));
  assert.ok(hasNote(r.notes, /person is missing or not valid/));
});

test('sanitize: debt promotion and rate range are validated', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  byId(raw.plan.debts, 'store-card').promo = { balanceCents: 50000, expiresMonth: '2027-02', deferredInterest: 'maybe', note: '' };
  byId(raw.plan.debts, 'p1-student-loans').aprRange = [7, 3];
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(byId(r.state.plan.debts, 'store-card').promo, { balanceCents: 50000, expiresMonth: '2027-02', deferredInterest: null, note: '' });
  assert.equal(byId(r.state.plan.debts, 'p1-student-loans').aprRange, null);
  assert.ok(hasNote(r.notes, /promo\.deferredInterest/));
  assert.ok(hasNote(r.notes, /aprRange/));
});

test('sanitize: people are always p1 and p2', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  raw.plan.people = [{ id: 'p2', name: '  Sammy ' }, { id: 'p3', name: 'Extra' }];
  const r = S.sanitize(raw, profile(), DS);
  assert.deepEqual(r.state.plan.people, [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sammy' }]);
  assert.ok(hasNote(r.notes, /only the two people p1 and p2/));
});

test('sanitize: a JSON string is accepted and a workbook wrapper unwrapped', () => {
  const st = base();
  assert.deepEqual(S.sanitize(JSON.stringify(st), profile(), DS).state, st);
  const wrapped = { format: 'household-budget-workbook', version: 5, state: st };
  assert.deepEqual(S.sanitize(wrapped, profile(), DS).state, st);
});

test('sanitize: earlier-version shapes are passed to migrate', () => {
  const r = S.sanitize(legacyV4(), profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 4);
  assert.equal(byId(r.state.plan.incomes, 'p1-pay').netPerPaycheckCents, 300000);
});

// ===================================================================== migrate: sample defaults (v4)

test('migrate v4: records the version, a raw snapshot and its notes', () => {
  const text = JSON.stringify(legacyV4());
  const r = S.migrate(text, profile(), DS);
  assert.equal(r.state.version, 5);
  assert.equal(r.state.meta.migratedFrom, 4);
  assert.equal(r.state.meta.legacySnapshot, text);
  assert.deepEqual(r.state.meta.migrationNotes, r.notes);
  assert.ok(r.notes.length > 10);
});

test('migrate v4: the result is a valid state (sanitize changes nothing)', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const again = S.sanitize(r.state, profile(), DS);
  assert.deepEqual(again.notes, []);
  assert.equal(JSON.stringify(again.state), JSON.stringify(r.state));
});

test('migrate v4: Alex paycheck keeps saved pay, derives the joint portion, keeps the confirmed frequency', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const alex = byId(r.state.plan.incomes, 'p1-pay');
  assert.equal(alex.netPerPaycheckCents, 300000);
  assert.equal(alex.jointPerPaycheckCents, 265000, 'joint = take-home − personal allocation');
  assert.equal(alex.frequency, 'biweekly');
  assert.equal(alex.frequencyStatus, 'confirmed');
  assert.ok(hasNote(r.notes, /kept \$3,000\.00 saved in the earlier version \(the household profile has \$2,240\.00\)/));
  assert.ok(hasNote(r.notes, /\$2,650\.00 per paycheck .*minus the personal allocation of \$350\.00.*profile has \$1,880\.00/));
  assert.ok(hasNote(r.notes, /pay frequency: blank in the earlier version; kept "biweekly"/));
});

test('migrate v4: Sam contribution is carried over as a monthly total with an explanation', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const c = byId(r.state.plan.incomes, 'p2-contribution');
  assert.equal(c.kind, 'contribution');
  assert.equal(c.frequency, 'monthly');
  assert.equal(c.jointPerPaycheckCents, 200000);
  assert.ok(hasNote(r.notes, /stored it as a monthly total/));
  assert.ok(hasNote(r.notes, /\$1,325\.00 twice a month/));
  // Sam's unknown take-home stays unknown.
  assert.equal(byId(r.state.plan.incomes, 'p2-pay').netPerPaycheckCents, null);
});

test('migrate v4: dollars become exact cents', () => {
  const t = S.migrate(legacyV4(), profile(), DS).state.plan.targets;
  assert.equal(t.Groceries, 71246);
  assert.equal(t['Dining & takeout'], 23310);
  assert.equal(t['Mixed retail'], 49875);
  assert.equal(t.Fuel, 15138);
  assert.equal(t['Auto maintenance'], 4250);
  assert.equal(t.Pets, 5512);
  assert.equal(t['Household & hardware'], 9640);
  assert.equal(t['Medical & pharmacy'], 3890);
  assert.equal(t.Travel, 12033);
  assert.equal(t.Subscriptions, 2748);
  assert.equal(t.Entertainment, 1899);
  assert.equal(t['Water & sewer'], 6127);
  assert.equal(t.Vision, 1250);
  assert.equal(t.Uncategorized, 875);

  const legacy = legacyV4();
  Object.assign(legacy.targets, { groceries: 0.29, dining: 1234567.89, shopping: 0.1 + 0.2, fuel: 19.99, pets: 1.005 });
  const t2 = S.migrate(legacy, profile(), DS).state.plan.targets;
  assert.equal(t2.Groceries, 29);
  assert.equal(t2['Dining & takeout'], 123456789);
  assert.equal(t2['Mixed retail'], 30);
  assert.equal(t2.Fuel, 1999);
  assert.equal(t2.Pets, 101);
});

test('migrate v4: bills keep the saved amounts and the notes mention both values', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const bills = r.state.plan.bills;
  assert.equal(byId(bills, 'mortgage').monthlyCents, 146621);
  assert.equal(byId(bills, 'store-card').monthlyCents, 4000);
  assert.equal(byId(bills, 'p1-car').monthlyCents, 18000);
  assert.equal(byId(bills, 'p1-car').fundedFrom, 'p1');
  assert.equal(byId(bills, 'p1-student-loans').monthlyCents, 22000);
  assert.equal(byId(bills, 'p2-car').monthlyCents, 30000);
  assert.equal(byId(bills, 'p2-car').fundedFrom, 'unknown');
  assert.ok(hasNote(r.notes, /Mortgage: kept \$1,466\.21 a month saved in the earlier version \(the household profile has \$1,412\.56\)/));
  // A blank earlier value never erases a known profile value.
  assert.equal(byId(bills, 'life-insurance').monthlyCents, 4000);
  assert.equal(byId(bills, 'life-insurance').status, 'planned');
  assert.ok(hasNote(r.notes, /Life insurance.*blank in the earlier version; kept \$40\.00/));
});

test('migrate v4: the combined energy target is kept whole (no guessed split, no double count)', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const t = r.state.plan.targets;
  assert.equal(t['Energy (gas + electric, migrated)'], 18000);
  assert.equal('Gas & heating' in t, false);
  assert.equal('Electric' in t, false);
  assert.ok(hasNote(r.notes, /instead of guessing a split.*Gas & heating \(\$105\.00\) and Electric \(\$105\.00\) targets were removed/));
});

test('migrate v4: the card-fee reserve becomes a bill and replaces the Fees & interest target', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const fee = r.state.plan.bills.find(b => b.label === 'Annual card-fee reserve (migrated)');
  assert.equal(fee.monthlyCents, 1000);
  assert.equal(fee.fundedFrom, 'joint');
  assert.equal('Fees & interest' in r.state.plan.targets, false);
  assert.ok(hasNote(r.notes, /Fees & interest target \(\$7\.92\) was removed/));
  // phoneInsurance was blank, so the profile's internet and phone bills stay.
  assert.ok(byId(r.state.plan.bills, 'internet'));
});

test('migrate v4: the saved forecast becomes a scenario whose blank amounts stay blank', () => {
  const r = S.migrate(legacyV4(), profile(), DS);
  const sc = r.state.scenarios.find(s => s.name === 'Saved forecast (from earlier version)');
  assert.ok(sc);
  assert.equal(sc.id, 'saved-forecast');
  assert.deepEqual(sc.events.map(e => [e.type, e.label]), [
    ['recurring', 'Childcare'], ['recurring', 'Other baby costs'],
    ['one_time', 'Home repair'], ['one_time', 'Celebration'], ['one_time', 'Family setup']
  ]);
  for (const e of sc.events) {
    assert.equal(e.type === 'one_time' ? e.amountCents : e.monthlyCents, null, e.label + ' stays unknown');
  }
  assert.equal(sc.events[0].startMonth, null);
  assert.deepEqual(r.state.compareIds, ['baseline', 'baby-arrives', 'saved-forecast']);
  assert.equal(r.state.scenarios[0].id, 'baseline');
  assert.deepEqual(r.state.scenarios[0].events, []);
  assert.ok(hasNote(r.notes, /start month \("2031-10"\) and length \(36 months\) were not carried over/));
});

test('migrate v4: view, last page, what-ifs and checklist', () => {
  const legacy = legacyV4();
  legacy.adjustments = { airfare: true, business: false };
  legacy.checks = { baby: true, balances: false };
  legacy.tab = 'future';
  const st = S.migrate(legacy, profile(), DS).state;
  assert.equal(st.ui.scope, 'household');
  assert.equal(st.ui.lastRoute, '#/forecast');
  assert.deepEqual(st.ui.whatIf, { excludePendingReimbursements: true, excludeBusinessCandidates: false });
  assert.deepEqual(st.checklist, { baby: true, balances: false });
  assert.equal(st.plan.settings.incomeTiming, 'conservative');
});

test('migrate: earlier tabs map onto the new routes', () => {
  const routes = { overview: '#/overview', spending: '#/spending', plan: '#/budget', future: '#/forecast', review: '#/review' };
  for (const [tab, route] of Object.entries(routes)) {
    const legacy = legacyV4();
    legacy.tab = tab;
    assert.equal(S.migrate(legacy, profile(), DS).state.ui.lastRoute, route, tab);
  }
  const legacy = legacyV4();
  legacy.tab = 'settings';
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.ui.lastRoute, '#/overview');
  assert.ok(hasNote(r.notes, /tab: "settings" is not a page/));
});

test('migrate: every earlier field is mapped or named in the notes', () => {
  const legacy = legacyV4();
  for (const k of Object.keys(legacy)) assert.ok(k in S.LEGACY_FIELDS, k + ' is documented');
  for (const k of Object.keys(legacy.targets)) assert.ok(k in S.LEGACY_TARGETS, 'targets.' + k + ' is documented');
  const plain = S.migrate(legacy, profile(), DS);
  assert.equal(plain.notes.some(n => /not used by this version/.test(n)), false);
  assert.ok(hasNote(plain.notes, /healthMigrationNotice and auditBudgetNotice/));

  legacy.futureFeature = { colour: 'teal' };
  legacy.forecast.mood = 'hopeful';
  legacy.adjustments.rounding = true;
  const r = S.migrate(legacy, profile(), DS);
  assert.ok(hasNote(r.notes, /^futureFeature: not used by this version; not carried over/));
  assert.ok(hasNote(r.notes, /^forecast\.mood: not used by this version/));
  assert.ok(hasNote(r.notes, /^adjustments\.rounding: not used by this version/));
});

test('migrate: unknown target keys are kept as their own targets with a note', () => {
  const legacy = legacyV4();
  legacy.targets.garden = 35.5;
  legacy.targets.kidsClub = null;
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.plan.targets.garden, 3550);
  assert.equal(r.state.plan.targets.kidsClub, null);
  assert.ok(hasNote(r.notes, /targets\.garden: not a category this version knows; kept as its own target "garden" \(\$35\.50\)/));
});

// ===================================================================== migrate: other versions

test('migrate v2: a combined medical target is preserved and Dental left blank', () => {
  const legacy = { version: 2, planMode: 'joint', targets: { medical: 145.6, groceries: 500 } };
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 2);
  assert.equal(r.state.plan.targets['Medical & pharmacy'], 14560);
  assert.equal(r.state.plan.targets.Dental, null);
  assert.equal(r.state.plan.targets.Groceries, 50000);
  assert.ok(hasNote(r.notes, /combined health target \(\$145\.60\).*preserved on Medical & pharmacy.*Dental is left blank/));
});

test('migrate v2: the combined target replaces a known profile Dental target', () => {
  const p = profile();
  p.plan.targets.Dental = 4500;
  const r = S.migrate({ version: 2, targets: { medical: 100 } }, p, DS);
  assert.equal(r.state.plan.targets.Dental, null);
  assert.ok(hasNote(r.notes, /profile’s Dental target of \$45\.00 is not used/));
});

test('migrate v3 with healthMode combined: a dental value was not counted and is not carried over', () => {
  const r = S.migrate({ version: 3, healthMode: 'combined', targets: { medical: 120, dental: 30 } }, profile(), DS);
  assert.equal(r.state.plan.targets['Medical & pharmacy'], 12000);
  assert.equal(r.state.plan.targets.Dental, null);
  assert.ok(hasNote(r.notes, /targets\.dental: \$30\.00 was not counted by the earlier version while health was combined/));
});

test('migrate v2 with health already separate keeps dental', () => {
  const r = S.migrate({ version: 2, healthMode: 'separate', targets: { medical: 60, dental: 25 } }, profile(), DS);
  assert.equal(r.state.plan.targets['Medical & pharmacy'], 6000);
  assert.equal(r.state.plan.targets.Dental, 2500);
});

test('migrate: an unversioned early budget (v1-like)', () => {
  const legacy = { personAPay: 2500, personAAllocation: 500, personBContribution: 1800, planMode: 'joint', targets: { groceries: 650.5, medical: 80 }, mystery: 1 };
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 0);
  const alex = byId(r.state.plan.incomes, 'p1-pay');
  assert.equal(alex.netPerPaycheckCents, 250000);
  assert.equal(alex.jointPerPaycheckCents, 200000);
  assert.equal(byId(r.state.plan.incomes, 'p2-contribution').jointPerPaycheckCents, 180000);
  assert.equal(r.state.plan.targets.Groceries, 65050);
  assert.equal(r.state.plan.targets['Medical & pharmacy'], 8000);
  assert.equal(r.state.ui.scope, 'joint');
  assert.equal(r.state.scenarios.some(s => s.name === 'Saved forecast (from earlier version)'), false);
  assert.ok(hasNote(r.notes, /^mystery: not used by this version/));
});

test('migrate: the { copyId, state } wrapper of a downloaded copy', () => {
  const inner = legacyV4();
  const text = JSON.stringify({ copyId: 'copy-123', state: inner });
  const r = S.migrate(text, profile(), DS);
  const direct = S.migrate(inner, profile(), DS);
  assert.deepEqual(r.state.plan, direct.state.plan);
  assert.deepEqual(r.state.scenarios, direct.state.scenarios);
  assert.equal(r.state.meta.legacySnapshot, text);
  assert.ok(hasNote(r.notes, /copy saved by the earlier version \(copy "copy-123"\)/));
});

test('migrate: garbage input never throws and gives the defaults with a note', () => {
  for (const bad of [null, undefined, 42, 'not json', '{"a":', [], { foo: 1 }, { version: 9 }, true]) {
    const r = S.migrate(bad, profile(), DS);
    assert.equal(r.state.version, 5);
    assert.deepEqual(r.state.plan, base().plan);
    assert.ok(r.notes.length >= 1);
    assert.equal(r.state.meta.migratedFrom, null);
  }
});

test('migrate: odd field values are noted and skipped, never thrown', () => {
  const legacy = {
    version: 3, personAPay: -5, personAFrequency: 'hourly', personAAllocation: 'lots', personBContribution: { a: 1 },
    targets: 'oops', forecast: [1, 2], checks: 'x', tab: 7, adjustments: null, planMode: 'everyone', incomeBasis: 'weekly',
    vehicleBFunding: 'neighbour', currentCash: NaN, healthMode: 'mixed'
  };
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 3);
  assert.deepEqual(byId(r.state.plan.incomes, 'p1-pay'), byId(base().plan.incomes, 'p1-pay'));
  assert.deepEqual(r.state.plan.targets, base().plan.targets);
  for (const re of [/^personAPay: -5 is not an amount/, /^personAFrequency: "hourly" is not a pay frequency/, /^personAAllocation/, /^personBContribution/,
    /^targets: not readable/, /^forecast: not readable/, /^checks: not readable/, /^tab: 7/, /^adjustments: not readable/,
    /^planMode/, /^incomeBasis/, /^vehicleBFunding/, /^currentCash/]) {
    assert.ok(hasNote(r.notes, re), String(re));
  }
  assert.deepEqual(S.sanitize(r.state, profile(), DS).notes, []);
});

test('migrate: leave, debt end months, growth and dated one-off costs', () => {
  const legacy = legacyV4();
  Object.assign(legacy, { childcare: 1450, babyCosts: 210.25, leaveReduction: 1600 });
  Object.assign(legacy.forecast, {
    babyStart: '2027-05', childcareStart: '2027-09', leaveStart: '2027-05', leaveMonths: 3,
    incomeGrowth: 2.5, expenseGrowth: 3, cashYield: 4.1,
    oneoffs: [{ label: 'Gate <latch>', amount: 2250, month: '2027-02' }, { label: '', amount: null, month: 'soon' }],
    debtEnds: { vehicleA: '2027-11', student: '', vehicleB: 'never', storeCard: '2027-02', boat: '2030-01' }
  });
  const r = S.migrate(legacy, profile(), DS);
  const sc = byId(r.state.scenarios, 'saved-forecast');
  const ev = label => sc.events.find(e => e.label === label);
  assert.deepEqual([ev('Childcare').startMonth, ev('Childcare').monthlyCents], ['2027-09', 145000]);
  assert.deepEqual([ev('Other baby costs').startMonth, ev('Other baby costs').monthlyCents], ['2027-05', 21025]);
  const leave = ev('Parental leave: lower income');
  assert.deepEqual([leave.direction, leave.startMonth, leave.endMonth, leave.monthlyCents], ['income_loss', '2027-05', '2027-07', 160000]);
  assert.deepEqual([ev('Gate <latch>').month, ev('Gate <latch>').amountCents], ['2027-02', 225000]);
  assert.deepEqual([ev('One-off cost').month, ev('One-off cost').amountCents], [null, null]);
  assert.deepEqual(sc.assumptions, { incomeTiming: 'conservative', annualReturnPct: 4.1, costGrowthPct: 3, incomeGrowthPct: 2.5 });
  assert.equal(byId(r.state.plan.bills, 'p1-car').endMonth, '2027-11');
  assert.equal(byId(r.state.plan.bills, 'store-card').endMonth, '2027-02');
  assert.equal(byId(r.state.plan.bills, 'p2-car').endMonth, null);
  for (const re of [/oneoffs\[1\]\.month: "soon" is not a month/, /debtEnds\.vehicleB: "never" is not a month/, /debtEnds\.boat: not a debt this version knows/, /Alex car payment: final payment month 2027-11/]) {
    assert.ok(hasNote(r.notes, re), String(re));
  }
});

test('migrate: leave saved with zero months is not applied, and the note says so', () => {
  const legacy = legacyV4();
  legacy.leaveReduction = 900;
  const r = S.migrate(legacy, profile(), DS);
  const sc = byId(r.state.scenarios, 'saved-forecast');
  assert.equal(sc.events.some(e => e.direction === 'income_loss'), false);
  assert.ok(hasNote(r.notes, /\$900\.00 a month of lower income was saved with a leave length of 0 months/));
});

test('migrate: an earlier forecast with nothing in it creates no scenario', () => {
  const legacy = { version: 4, forecast: { start: '2031-10', months: 12, oneoffs: [], leaveMonths: 0 }, leaveReduction: 0 };
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.scenarios.length, 3);
  assert.ok(hasNote(r.notes, /no scenario was needed/));
});

test('migrate: savings contributions, the cash goal and current cash', () => {
  const legacy = legacyV4();
  Object.assign(legacy, { emergencyFund: 300, anniversaryFund: 0, homeFund: 75.5, otherSavings: 40, cashGoal: 20000, currentCash: 8123.45 });
  const r = S.migrate(legacy, profile(), DS);
  const goals = r.state.plan.savings;
  assert.equal(byId(goals, 'emergency').monthlyCents, 30000);
  assert.equal(byId(goals, 'emergency').targetCents, 2000000);
  assert.equal(byId(goals, 'anniversary-trip').monthlyCents, 0);
  assert.equal(byId(goals, 'home-projects').monthlyCents, 7550);
  const other = byId(goals, 'other-savings');
  assert.equal(other.label, 'Other savings (migrated)');
  assert.equal(other.monthlyCents, 4000);
  assert.equal(other.targetCents, null);
  assert.equal(r.state.plan.balances.jointCashCents, 812345);
  assert.ok(hasNote(r.notes, /"cash available for goals"/));
  assert.ok(hasNote(r.notes, /Emergency cushion target: kept the earlier version’s cash goal of \$20,000\.00 \(the household profile has \$15,000\.00\)/));
});

test('migrate: other income and other expenses', () => {
  const legacy = legacyV4();
  Object.assign(legacy, { otherIncome: 150, otherExpenses: 220.4 });
  const r = S.migrate(legacy, profile(), DS);
  const other = r.state.plan.incomes.find(s => s.kind === 'other');
  assert.deepEqual([other.label, other.netPerPaycheckCents, other.jointPerPaycheckCents, other.frequency, other.personId], ['Other income (migrated)', 15000, 15000, 'monthly', null]);
  assert.equal(r.state.plan.targets['Other expenses (migrated)'], 22040);
});

test('migrate: the vehicle-B funding choice sets who pays the car payment', () => {
  for (const [choice, funded] of [['personal', 'p2'], ['joint', 'joint'], ['unknown', 'unknown']]) {
    const legacy = legacyV4();
    legacy.vehicleBFunding = choice;
    assert.equal(byId(S.migrate(legacy, profile(), DS).state.plan.bills, 'p2-car').fundedFrom, funded, choice);
  }
  const p = profile();
  byId(p.plan.bills, 'p2-car').fundedFrom = 'p2';
  const r = S.migrate(legacyV4(), p, DS);
  assert.equal(byId(r.state.plan.bills, 'p2-car').fundedFrom, 'p2', 'an "unknown" earlier choice does not erase a known profile value');
});

test('migrate: a personal allocation larger than take-home pay is not applied', () => {
  const legacy = legacyV4();
  legacy.personAAllocation = 3500;
  const r = S.migrate(legacy, profile(), DS);
  const alex = byId(r.state.plan.incomes, 'p1-pay');
  assert.equal(alex.jointPerPaycheckCents, 188000);
  assert.match(alex.note, /personal allocation \$3,500\.00/);
  assert.ok(hasNote(r.notes, /personal allocation \(\$3,500\.00\) is more than take-home pay \(\$3,000\.00\)/));
});

test('migrate: a contribution equal to the profile’s monthly amount keeps the profile schedule', () => {
  const legacy = legacyV4();
  legacy.personBContribution = 2650;
  const r = S.migrate(legacy, profile(), DS);
  const c = byId(r.state.plan.incomes, 'p2-contribution');
  assert.equal(c.frequency, 'semimonthly');
  assert.equal(c.jointPerPaycheckCents, 132500);
  assert.ok(hasNote(r.notes, /matches the household profile/));
});

test('migrate: a known phone/internet/insurance allowance replaces the separate phone bills', () => {
  const legacy = legacyV4();
  legacy.targets.phoneInsurance = 210;
  const r = S.migrate(legacy, profile(), DS);
  const bills = r.state.plan.bills;
  assert.equal(byId(bills, 'internet'), undefined);
  assert.equal(byId(bills, 'wireless'), undefined);
  const combined = bills.find(b => b.label === 'Phone, internet & other insurance (migrated)');
  assert.equal(combined.monthlyCents, 21000);
  assert.ok(byId(bills, 'home-insurance'), 'insurance bills stay, with a warning to check for overlap');
  assert.ok(hasNote(r.notes, /"Internet" \(\$75\.00\) and "Wireless phones" \(\$92\.40\) bills were removed.*Check whether it also covers "Home insurance"/));
});

test('migrate: without a profile, streams, bills and goals are created', () => {
  const legacy = legacyV4();
  legacy.emergencyFund = 100;
  const r = S.migrate(legacy, null, DS);
  const { plan } = r.state;
  assert.deepEqual(plan.people.map(p => p.name), ['Partner A', 'Partner B']);
  const pay = byId(plan.incomes, 'p1-pay');
  assert.deepEqual([pay.netPerPaycheckCents, pay.jointPerPaycheckCents, pay.frequency, pay.frequencyStatus], [300000, 265000, 'unknown', 'unknown']);
  assert.equal(byId(plan.incomes, 'p2-contribution').jointPerPaycheckCents, 200000);
  assert.equal(byId(plan.bills, 'mortgage').monthlyCents, 146621);
  assert.equal(byId(plan.bills, 'p1-car').fundedFrom, 'p1');
  assert.equal(byId(plan.bills, 'p2-car').fundedFrom, 'unknown');
  assert.equal(byId(plan.bills, 'life-insurance'), undefined, 'a blank earlier bill is not invented');
  assert.equal(byId(plan.savings, 'emergency').monthlyCents, 10000);
  assert.equal(plan.targets.Dental, null);
  assert.ok(hasNote(r.notes, /Added the bill "Partner A car payment" \(\$180\.00 a month\)/));
  assert.deepEqual(S.sanitize(r.state, null, DS).notes, []);
});

test('migrate: the raw snapshot is capped at 200,000 characters', () => {
  const legacy = legacyV4();
  legacy.bigBlob = 'x'.repeat(250000);
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.meta.legacySnapshot.length, 200000);
  assert.ok(hasNote(r.notes, /only the first 200000 are kept as a snapshot/));
});

test('migrate: a version-5 state is sanitized, not migrated', () => {
  const st = base();
  const r = S.migrate(st, profile(), DS);
  assert.deepEqual(r.state, st);
  assert.deepEqual(r.notes, []);
});

test('migrate: does not modify the earlier object', () => {
  const legacy = deepFreeze(legacyV4());
  const before = JSON.stringify(legacy);
  S.migrate(legacy, profile(), DS);
  assert.equal(JSON.stringify(legacy), before);
});

test('legacyVersionOf: detects earlier saved budgets', () => {
  assert.equal(S.legacyVersionOf({ version: 4, targets: {} }), 4);
  assert.equal(S.legacyVersionOf({ version: '2' }), 2);
  assert.equal(S.legacyVersionOf({ personAPay: 1 }), 0);
  assert.equal(S.legacyVersionOf({ version: 5, plan: {} }), null);
  assert.equal(S.legacyVersionOf({ hello: 1 }), null);
  assert.equal(S.legacyVersionOf([]), null);
});

// ===================================================================== workbooks

test('workbook: export then import returns an equal state', () => {
  let st = S.migrate(legacyV4(), profile(), DS, { now: NOW }).state;
  st = S.setPath(st, 'ui.dismissed.welcome', true);
  st = Object.assign({}, st, { ledgerEdits: { t1: { note: 'checked', history: [{ at: NOW, field: 'note', from: null, to: 'checked', reason: '' }] } } });
  const text = S.exportWorkbook(st, { now: LATER });
  const r = S.importWorkbook(text, profile(), DS);
  assert.deepEqual(r.state, st);
  assert.ok(hasNote(r.notes, /Workbook exported 2026-10-02/));
});

test('workbook: export has the documented envelope', () => {
  const st = S.defaults(profile(), DS, { now: NOW });
  const wb = JSON.parse(S.exportWorkbook(st, { now: LATER }));
  assert.deepEqual(Object.keys(wb), ['format', 'version', 'exportedAt', 'datasetId', 'state']);
  assert.equal(wb.format, 'household-budget-workbook');
  assert.equal(wb.version, 5);
  assert.equal(wb.exportedAt, LATER);
  assert.equal(wb.datasetId, 'sample');
  assert.equal(JSON.parse(S.exportWorkbook(st)).exportedAt, NOW, 'without now, the last update time is used');
  assert.throws(() => S.exportWorkbook(null), isValidationError());
});

test('workbook import: a bare version-5 state', () => {
  const st = base();
  const r = S.importWorkbook(JSON.stringify(st), profile(), DS);
  assert.deepEqual(r.state, st);
});

test('workbook import: an earlier saved state', () => {
  const text = JSON.stringify(legacyV4());
  const r = S.importWorkbook(text, profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 4);
  assert.equal(r.state.meta.legacySnapshot, text);
});

test('workbook import: the earlier { copyId, state } wrapper', () => {
  const r = S.importWorkbook(JSON.stringify({ copyId: 'copy-42', state: legacyV4() }), profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 4);
  assert.ok(hasNote(r.notes, /copy "copy-42"/));
});

test('workbook import: a page downloaded from the earlier app (with \\u003c escapes)', () => {
  const legacy = legacyV4();
  legacy.forecast.oneoffs[0] = { label: 'Fence <repair> & </script> test', amount: 1250.5, month: '2027-04' };
  const embedded = JSON.stringify({ copyId: 'copy-1700000000000', state: legacy }).replace(/</g, '\\u003c');
  assert.equal(embedded.includes('<'), false);
  const html = '<!doctype html>\n<html><head><title>Budget</title>' +
    '<script id="budget-data" type="application/json">{"transactions":[]}</script>' +
    '<script id="budget-state" type="application/json">' + embedded + '</script>' +
    '<script id="budget-app">console.log("app")</script></head><body></body></html>';
  const r = S.importWorkbook(html, profile(), DS);
  assert.equal(r.state.meta.migratedFrom, 4);
  const ev = byId(r.state.scenarios, 'saved-forecast').events.find(e => e.amountCents === 125050);
  assert.equal(ev.label, 'Fence <repair> & </script> test');
  assert.equal(ev.month, '2027-04');
  assert.ok(hasNote(r.notes, /page downloaded from the earlier version/));
  assert.ok(hasNote(r.notes, /copy "copy-1700000000000"/));
});

test('extractEmbeddedState: finds the budget-state script in any attribute order', () => {
  assert.equal(S.extractEmbeddedState('<script type="application/json" id=\'budget-state\'> {"a":1} </script>'), '{"a":1}');
  assert.equal(S.extractEmbeddedState('<SCRIPT id=budget-state>{}</SCRIPT>'), '{}');
  assert.equal(S.extractEmbeddedState('<script id="budget-state-old">{}</script>'), null);
  assert.equal(S.extractEmbeddedState('<p>nothing</p>'), null);
  assert.equal(S.extractEmbeddedState(null), null);
});

test('workbook import: unreadable files throw friendly validation errors', () => {
  const cases = [
    [undefined, /Choose a budget workbook/],
    ['', /empty/],
    ['   \n', /empty/],
    ['not json at all', /could not be read as JSON/],
    ['[1,2,3]', /not a budget workbook/],
    ['{"hello":"world"}', /not recognised/],
    ['<html><body>No budget here</body></html>', /does not contain a saved budget/],
    ['<script id="budget-state">{broken</script>', /inside this page is damaged/],
    [JSON.stringify({ format: 'household-budget-workbook', version: 9, state: {} }), /newer version/],
    [JSON.stringify({ format: 'household-budget-workbook', version: 5 }), /no budget inside/]
  ];
  for (const [input, re] of cases) assert.throws(() => S.importWorkbook(input, profile(), DS), isValidationError(re), String(input).slice(0, 30));
});

test('workbook import: a byte-order mark is ignored', () => {
  const r = S.importWorkbook('﻿' + S.exportWorkbook(base()), profile(), DS);
  assert.deepEqual(r.state, base());
});

test('workbook import: a different data set is noted', () => {
  const st = S.defaults(profile(), 'household-x');
  const r = S.importWorkbook(S.exportWorkbook(st), profile(), DS);
  assert.equal(r.state.datasetId, 'sample');
  assert.ok(hasNote(r.notes, /saved for the data set "household-x" and is now used with "sample"/));
});

// ===================================================================== scenarios

test('addScenario: appends a scenario with a stable id and default assumptions', () => {
  const st = base();
  const a = S.addScenario(st, '  New car  ', { now: NOW });
  const b = S.addScenario(st, '  New car  ', { now: NOW });
  const added = a.scenarios[a.scenarios.length - 1];
  assert.equal(added.name, 'New car');
  assert.match(added.id, /^scenario-[a-z0-9]+$/);
  assert.equal(added.id, b.scenarios[b.scenarios.length - 1].id);
  assert.deepEqual(added.events, []);
  assert.deepEqual(added.assumptions, { incomeTiming: 'actual', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 });
  assert.equal(added.createdAt, NOW);
  assert.equal(a.meta.updatedAt, NOW);
  assert.equal(S.addScenario(st, 'X', { id: 'my-scenario' }).scenarios[3].id, 'my-scenario');
  assert.throws(() => S.addScenario(st, 'X', { id: 'baseline' }), isValidationError(/not available/));
});

test('addScenario: names must be present and at most 80 characters', () => {
  const st = base();
  assert.throws(() => S.addScenario(st, ''), isValidationError(/Give the scenario a name/));
  assert.throws(() => S.addScenario(st, '   '), isValidationError(/Give the scenario a name/));
  assert.throws(() => S.addScenario(st, null), isValidationError(/Give the scenario a name/));
  assert.throws(() => S.addScenario(st, 'x'.repeat(81)), isValidationError(/80 characters or fewer/));
  assert.equal(S.addScenario(st, 'x'.repeat(80)).scenarios.length, 4);
});

test('addScenario: at most 20 scenarios', () => {
  let st = base();
  while (st.scenarios.length < 20) st = S.addScenario(st, 'Scenario ' + st.scenarios.length);
  assert.throws(() => S.addScenario(st, 'One too many'), isValidationError(/up to 20 scenarios/));
});

test('addScenario copyFrom: changes are deep copies with new ids', () => {
  const st = base();
  const next = S.addScenario(st, 'Baby, but later', { copyFrom: 'baby-arrives' });
  const src = byId(next.scenarios, 'baby-arrives');
  const copy = next.scenarios[next.scenarios.length - 1];
  assert.equal(copy.events.length, src.events.length);
  const strip = e => Object.assign({}, e, { id: undefined });
  assert.deepEqual(copy.events.map(strip), src.events.map(strip));
  const allIds = next.scenarios.flatMap(s => s.events.map(e => e.id));
  assert.equal(new Set(allIds).size, allIds.length, 'every change id is unique');
  copy.events.forEach((e, i) => assert.notEqual(e, src.events[i]));
  assert.notEqual(copy.assumptions, src.assumptions);
  copy.events[0].monthlyCents = 1;
  assert.equal(byId(src.events, 'baby-supplies').monthlyCents, 25000);
  assert.equal(copy.description, src.description);
});

test('addScenario copyFrom: an unknown scenario is refused; the baseline copies no changes', () => {
  assert.throws(() => S.addScenario(base(), 'Copy', { copyFrom: 'ghost' }), isValidationError(/no longer exists/));
  const next = S.addScenario(base(), 'Copy of current', { copyFrom: 'baseline' });
  assert.deepEqual(next.scenarios[3].events, []);
});

test('scenario operations never modify their input', () => {
  const st = deepFreeze(base());
  const before = JSON.stringify(st);
  S.addScenario(st, 'A', { copyFrom: 'baby-arrives' });
  S.renameScenario(st, 'baby-arrives', 'B');
  S.deleteScenario(st, 'home-projects-scenario');
  S.addEvent(st, 'baby-arrives', { type: 'one_time', label: 'Crib', month: '2027-04', amountCents: 30000 });
  S.updateEvent(st, 'baby-arrives', 'baby-supplies', { monthlyCents: 30000 });
  S.removeEvent(st, 'baby-arrives', 'childcare');
  assert.equal(JSON.stringify(st), before);
});

test('renameScenario: validates the name and the id', () => {
  const st = base();
  const next = S.renameScenario(st, 'baby-arrives', 'Baby (spring 2027)', { now: NOW });
  assert.equal(byId(next.scenarios, 'baby-arrives').name, 'Baby (spring 2027)');
  assert.equal(byId(next.scenarios, 'baby-arrives').updatedAt, NOW);
  assert.equal(S.renameScenario(st, 'baseline', 'As is').scenarios[0].name, 'As is');
  assert.throws(() => S.renameScenario(st, 'ghost', 'X'), isValidationError(/no longer exists/));
  assert.throws(() => S.renameScenario(st, 'baby-arrives', ' '), isValidationError(/name/));
});

test('deleteScenario: the baseline cannot be deleted', () => {
  assert.throws(() => S.deleteScenario(base(), 'baseline'), isValidationError(/current budget cannot be deleted/));
  assert.throws(() => S.removeScenario(base(), 'baseline'), isValidationError(/cannot be deleted/));
  assert.throws(() => S.deleteScenario(base(), 'ghost'), isValidationError(/no longer exists/));
});

test('deleteScenario: removes it from the comparison, which is never left empty', () => {
  let st = base();
  st = S.deleteScenario(st, 'baby-arrives');
  assert.deepEqual(st.scenarios.map(s => s.id), ['baseline', 'home-projects-scenario']);
  assert.deepEqual(st.compareIds, ['baseline']);
  st = S.setPath(st, 'compareIds', ['home-projects-scenario']);
  st = S.removeScenario(st, 'home-projects-scenario');
  assert.deepEqual(st.compareIds, ['baseline']);
});

test('addEvent: the baseline cannot hold changes and the message points to the budget', () => {
  assert.throws(
    () => S.addEvent(base(), 'baseline', { type: 'one_time', label: 'Roof', month: '2027-01', amountCents: 100 }),
    isValidationError(/edit it on the Budget page/)
  );
});

test('addEvent: validates the change and gives it a unique id', () => {
  const st = base();
  const next = S.addEvent(st, 'home-projects-scenario', { type: 'one_time', label: 'Gutters', month: '2027-05', amountCents: null, goalId: 'home-projects' }, { now: NOW });
  const added = byId(next.scenarios, 'home-projects-scenario').events[3];
  assert.match(added.id, /^event-[a-z0-9]+$/);
  assert.deepEqual(Object.assign({}, added, { id: 'x' }), { id: 'x', type: 'one_time', label: 'Gutters', month: '2027-05', amountCents: null, direction: 'expense', category: null, goalId: 'home-projects', note: '' });
  assert.equal(byId(next.scenarios, 'home-projects-scenario').updatedAt, NOW);
  const dup = S.addEvent(st, 'home-projects-scenario', { id: 'childcare', type: 'one_time', label: 'Dup id', month: null, amountCents: 1 });
  assert.notEqual(byId(dup.scenarios, 'home-projects-scenario').events[3].id, 'childcare');
  const own = S.addEvent(st, 'home-projects-scenario', { id: 'gutters', type: 'one_time', label: 'Gutters', month: null, amountCents: 1 });
  assert.equal(byId(own.scenarios, 'home-projects-scenario').events[3].id, 'gutters');
  for (const [ev, re] of [
    [{ type: 'one_time', label: 'Bad', month: '2027-13', amountCents: 1 }, /Month: Choose a month/],
    [{ type: 'one_time', label: 'Bad', amountCents: -1 }, /Amount: Enter an amount of \$0 or more/],
    [{ type: 'bill_change', label: 'No bill', startMonth: '2027-01' }, /Choose the bill/],
    [{ type: 'mystery' }, /Choose what kind of change/],
    ['nope', /needs its details/]
  ]) assert.throws(() => S.addEvent(st, 'baby-arrives', ev), isValidationError(re));
  assert.throws(() => S.addEvent(st, 'ghost', { type: 'one_time', label: 'x' }), isValidationError(/no longer exists/));
});

test('updateEvent: editing one scenario leaves the others and the baseline byte-identical', () => {
  const st = base();
  const next = S.updateEvent(st, 'baby-arrives', 'childcare', { monthlyCents: 145000, startMonth: '2027-10' });
  assert.equal(byId(byId(next.scenarios, 'baby-arrives').events, 'childcare').monthlyCents, 145000);
  assert.equal(JSON.stringify(byId(next.scenarios, 'baseline')), JSON.stringify(byId(st.scenarios, 'baseline')));
  assert.equal(JSON.stringify(byId(next.scenarios, 'home-projects-scenario')), JSON.stringify(byId(st.scenarios, 'home-projects-scenario')));
  assert.equal(JSON.stringify(next.plan), JSON.stringify(st.plan));
  const before = byId(st.scenarios, 'baby-arrives').events.filter(e => e.id !== 'childcare');
  const after = byId(next.scenarios, 'baby-arrives').events.filter(e => e.id !== 'childcare');
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});

test('updateEvent: editing a copied scenario does not touch its source', () => {
  let st = S.addScenario(base(), 'Copy', { copyFrom: 'baby-arrives' });
  const copy = st.scenarios[st.scenarios.length - 1];
  const sourceBefore = JSON.stringify(byId(st.scenarios, 'baby-arrives'));
  st = S.updateEvent(st, copy.id, copy.events[0].id, { monthlyCents: 99900 });
  assert.equal(JSON.stringify(byId(st.scenarios, 'baby-arrives')), sourceBefore);
  assert.equal(st.scenarios[st.scenarios.length - 1].events[0].monthlyCents, 99900);
});

test('updateEvent: invalid changes are refused; type changes start from the patch', () => {
  const st = base();
  assert.throws(() => S.updateEvent(st, 'baby-arrives', 'childcare', { endMonth: '2027-01' }), isValidationError(/end month must be the same as or after the start month/));
  assert.throws(() => S.updateEvent(st, 'baby-arrives', 'childcare', { monthlyCents: '1450' }), isValidationError(/whole cents/));
  assert.throws(() => S.updateEvent(st, 'baby-arrives', 'ghost', { label: 'x' }), isValidationError(/no longer exists/));
  assert.throws(() => S.updateEvent(st, 'baby-arrives', 'childcare', null), isValidationError(/Nothing to change/));
  const next = S.updateEvent(st, 'baby-arrives', 'birth-costs', { type: 'recurring', startMonth: '2027-05', monthlyCents: 5000 });
  const ev = byId(byId(next.scenarios, 'baby-arrives').events, 'birth-costs');
  assert.deepEqual(ev, { id: 'birth-costs', type: 'recurring', label: 'Birth and hospital costs', startMonth: '2027-05', endMonth: null, monthlyCents: 5000, direction: 'expense', category: null, note: byId(byId(st.scenarios, 'baby-arrives').events, 'birth-costs').note });
  const cleared = S.updateEvent(st, 'baby-arrives', 'p2-leave', { jointPerPaycheckCents: undefined });
  assert.equal('jointPerPaycheckCents' in byId(byId(cleared.scenarios, 'baby-arrives').events, 'p2-leave'), false);
});

test('removeEvent: removes one change, refuses unknown ids', () => {
  const next = S.removeEvent(base(), 'baby-arrives', 'childcare');
  assert.deepEqual(byId(next.scenarios, 'baby-arrives').events.map(e => e.id), ['baby-supplies', 'birth-costs', 'p2-leave']);
  assert.throws(() => S.removeEvent(base(), 'baby-arrives', 'ghost'), isValidationError(/no longer exists/));
});

test('addEvent: at most 200 changes per scenario', () => {
  let st = S.addScenario(base(), 'Many', { id: 'many' });
  const s = byId(st.scenarios, 'many');
  s.events = Array.from({ length: 200 }, (_, i) => ({ id: 'm' + i, type: 'one_time', label: 'M' + i, month: null, amountCents: 1, direction: 'expense', category: null, goalId: null, note: '' }));
  assert.throws(() => S.addEvent(st, 'many', { type: 'one_time', label: 'One more' }), isValidationError(/up to 200 changes/));
});

test('validateEvent: normalizes every kind of change', () => {
  assert.deepEqual(S.validateEvent({ type: 'target_change', category: ' Groceries ', startMonth: '2027-01', monthlyCents: 55000 }),
    { type: 'target_change', label: 'Target change', category: 'Groceries', startMonth: '2027-01', endMonth: null, monthlyCents: 55000, note: '' });
  assert.deepEqual(S.validateEvent({ id: 'g1', type: 'goal', label: 'Wedding gift', goal: { id: 'gift', label: 'Gift', targetCents: 50000, targetMonth: '2027-06', monthlyCents: 5000, spendAtTarget: true } }),
    { id: 'g1', type: 'goal', label: 'Wedding gift', goal: { id: 'gift', label: 'Gift', targetCents: 50000, targetMonth: '2027-06', savedCents: null, monthlyCents: 5000, spendAtTarget: true, note: '' } });
  assert.equal(S.validateEvent({ type: 'recurring', label: 'Childcare', startMonth: null, monthlyCents: null }).startMonth, null, 'a recurring change may have an unknown start');
  assert.throws(() => S.validateEvent({ type: 'income_change', streamId: 'p1-pay' }), isValidationError(/Choose a start month/));
  assert.throws(() => S.validateEvent({ type: 'target_change', startMonth: '2027-01' }), isValidationError(/Choose a category/));
  assert.throws(() => S.validateEvent({ type: 'goal', label: 'x' }), isValidationError(/Describe the savings goal/));
  assert.throws(() => S.validateEvent({ type: 'one_time', label: 'x'.repeat(81) }), isValidationError(/80 characters/));
  assert.throws(() => S.validateEvent({ type: 'recurring', label: 'x', direction: 'sideways', startMonth: '2027-01' }), isValidationError(/Direction/));
});

// ===================================================================== paths

test('getPath: reads by id selectors, map keys and plain fields', () => {
  const st = base();
  assert.equal(S.getPath(st, 'plan.incomes[id=p1-pay].netPerPaycheckCents'), 224000);
  assert.equal(S.getPath(st, 'plan.targets.Groceries'), 60000);
  assert.equal(S.getPath(st, 'plan.targets.Dining & takeout'), 30000);
  assert.equal(S.getPath(st, 'plan.targets["Gas & heating"]'), 10500);
  assert.equal(S.getPath(st, 'plan.bills[id=mortgage].monthlyCents'), 141256);
  assert.equal(S.getPath(st, 'plan.settings.incomeTiming'), 'conservative');
  assert.equal(S.getPath(st, 'ui.scope'), 'joint');
  assert.equal(S.getPath(st, 'plan.personalSpending[personId=p2].monthlyCents'), null);
  assert.equal(S.getPath(st, 'plan.debts[id=store-card].promo.balanceCents'), null);
  assert.equal(S.getPath(st, 'scenarios[id=baby-arrives].events[id=childcare].startMonth'), '2027-09');
  assert.equal(S.getPath(st, 'plan.incomes[0].id'), 'p1-pay');
  assert.equal(S.getPath(st, 'plan.bills[id=ghost].monthlyCents'), undefined);
  assert.equal(S.getPath(st, 'plan.targets.Nonexistent'), undefined);
  const item = S.getPath(st, 'plan.bills[id=mortgage]');
  item.monthlyCents = 1;
  assert.equal(byId(st.plan.bills, 'mortgage').monthlyCents, 141256, 'getPath returns a copy');
  assert.throws(() => S.getPath(st, 'plan.nothing'), isValidationError(/no field "plan\.nothing"/));
  assert.throws(() => S.getPath(st, ''), isValidationError());
});

test('setPath: returns a new state and leaves the input unchanged', () => {
  const st = deepFreeze(base());
  const before = JSON.stringify(st);
  const next = S.setPath(st, 'plan.incomes[id=p1-pay].netPerPaycheckCents', 230000);
  assert.equal(JSON.stringify(st), before);
  assert.equal(byId(next.plan.incomes, 'p1-pay').netPerPaycheckCents, 230000);
  assert.equal(S.getPath(next, 'plan.incomes[id=p1-pay].netPerPaycheckCents'), 230000);
  // Untouched branches are shared, not copied, and untouched values are equal.
  assert.equal(next.scenarios, st.scenarios);
  assert.deepEqual(byId(next.plan.incomes, 'p2-pay'), byId(st.plan.incomes, 'p2-pay'));
});

test('setPath: amounts must be cents or null, with friendly messages', () => {
  const st = base();
  const p = 'plan.bills[id=mortgage].monthlyCents';
  assert.equal(byId(S.setPath(st, p, null).plan.bills, 'mortgage').monthlyCents, null);
  assert.equal(byId(S.setPath(st, p, 0).plan.bills, 'mortgage').monthlyCents, 0);
  assert.throws(() => S.setPath(st, p, -1), isValidationError(/\$0 or more/));
  assert.throws(() => S.setPath(st, p, 12.5), isValidationError(/whole cents/));
  assert.throws(() => S.setPath(st, p, '1200'), isValidationError(/whole cents/));
  assert.throws(() => S.setPath(st, p, 10000000001), isValidationError(/below \$100,000,000/));
  assert.equal(S.setPath(st, 'plan.balances.jointCashCents', -5000).plan.balances.jointCashCents, -5000);
});

test('setPath: enums, months, dates, numbers and booleans', () => {
  const st = base();
  assert.equal(S.setPath(st, 'plan.settings.incomeTiming', 'actual').plan.settings.incomeTiming, 'actual');
  assert.throws(() => S.setPath(st, 'plan.settings.incomeTiming', 'sometimes'), isValidationError(/Choose one of: conservative, average, actual/));
  assert.equal(S.setPath(st, 'plan.settings.comparisonWindow', '6').plan.settings.comparisonWindow, 6);
  assert.throws(() => S.setPath(st, 'plan.settings.comparisonWindow', 4), isValidationError());
  assert.equal(byId(S.setPath(st, 'plan.incomes[id=p2-pay].frequency', 'weekly').plan.incomes, 'p2-pay').frequency, 'weekly');
  assert.throws(() => S.setPath(st, 'plan.savings[id=anniversary-trip].targetMonth', '2027-9'), isValidationError(/YYYY-MM/));
  assert.throws(() => S.setPath(st, 'plan.incomes[id=p1-pay].anchorDate', '2024-02-30'), isValidationError(/YYYY-MM-DD/));
  assert.equal(byId(S.setPath(st, 'plan.debts[id=mortgage].escrowIncluded', 'true').plan.debts, 'mortgage').escrowIncluded, true);
  assert.equal(byId(S.setPath(st, 'plan.debts[id=mortgage].aprPct', 6.125).plan.debts, 'mortgage').aprPct, 6.125);
  assert.throws(() => S.setPath(st, 'plan.debts[id=mortgage].aprPct', 140), isValidationError(/from 0 to 100/));
  assert.deepEqual(byId(S.setPath(st, 'plan.incomes[id=p2-contribution].semimonthlyDays', [15, 1]).plan.incomes, 'p2-contribution').semimonthlyDays, [1, 15]);
  assert.throws(() => S.setPath(st, 'plan.incomes[id=p2-contribution].semimonthlyDays', [5, 5]), isValidationError(/two different days/));
});

test('setPath: labels are trimmed; blank or long labels are refused', () => {
  const st = base();
  assert.equal(byId(S.setPath(st, 'plan.bills[id=internet].label', '  Fiber internet ').plan.bills, 'internet').label, 'Fiber internet');
  assert.throws(() => S.setPath(st, 'plan.bills[id=internet].label', '  '), isValidationError(/Enter a name/));
  assert.throws(() => S.setPath(st, 'plan.bills[id=internet].label', 'x'.repeat(81)), isValidationError(/80 characters or fewer/));
  assert.throws(() => S.setPath(st, 'plan.bills[id=internet].note', 'x'.repeat(501)), isValidationError(/500 characters or fewer/));
  assert.equal(byId(S.setPath(st, 'plan.bills[id=internet].category', '').plan.bills, 'internet').category, null);
});

test('setPath: an end month before the start month is refused', () => {
  let st = S.setPath(base(), 'plan.bills[id=p1-car].startMonth', '2026-01');
  assert.throws(() => S.setPath(st, 'plan.bills[id=p1-car].endMonth', '2025-12'), isValidationError(/end month must be the same as or after/));
  st = S.setPath(st, 'plan.bills[id=p1-car].endMonth', '2028-06');
  assert.equal(byId(st.plan.bills, 'p1-car').endMonth, '2028-06');
});

test('setPath: unknown paths, ids and whole sections are refused', () => {
  const st = base();
  assert.throws(() => S.setPath(st, 'plan.bills[id=ghost].monthlyCents', 1), isValidationError(/could not be found/));
  assert.throws(() => S.setPath(st, 'plan.bills[id=mortgage].colour', 'red'), isValidationError(/no field/));
  assert.throws(() => S.setPath(st, 'plan.settings', {}), isValidationError(/whole section/));
  assert.throws(() => S.setPath(st, 'plan.bills[id=mortgage]', {}), isValidationError(/whole item/));
  assert.throws(() => S.setPath(st, 'version', 6), isValidationError(/no field/));
  assert.throws(() => S.setPath(st, 'datasetId', 'x'), isValidationError(/no field/));
  assert.throws(() => S.setPath(st, 'plan.bills[label=Mortgage].monthlyCents', 1), isValidationError(/no field/));
  assert.throws(() => S.setPath(st, 'plan..bills', 1), isValidationError());
  assert.throws(() => S.setPath(st, '', 1), isValidationError(/No field/));
  assert.throws(() => S.setPath(null, 'ui.scope', 'joint'), isValidationError(/not loaded/));
});

test('setPath: targets can be added, changed and removed, including names with dots', () => {
  let st = base();
  st = S.setPath(st, 'plan.targets.Kids activities', 8000);
  assert.equal(st.plan.targets['Kids activities'], 8000);
  st = S.setPath(st, 'plan.targets.Misc. (cash)', null);
  assert.equal(st.plan.targets['Misc. (cash)'], null);
  st = S.setPath(st, 'plan.targets["A.B"]', 100);
  assert.equal(st.plan.targets['A.B'], 100);
  st = S.setPath(st, 'plan.targets.Groceries', undefined);
  assert.equal('Groceries' in st.plan.targets, false);
  assert.throws(() => S.setPath(st, 'plan.targets.Fuel', -10), isValidationError(/\$0 or more/));
  assert.throws(() => S.setPath(st, 'plan.targets.' + 'x'.repeat(81), 1), isValidationError(/1 to 80 characters/));
});

test('setPath: personal spending entries are created on first write', () => {
  const p = profile();
  p.plan.personalSpending = [];
  const st = S.defaults(p, DS);
  const next = S.setPath(st, 'plan.personalSpending[personId=p2].monthlyCents', 25000);
  assert.deepEqual(next.plan.personalSpending, [{ personId: 'p2', monthlyCents: 25000, note: '' }]);
  assert.throws(() => S.setPath(st, 'plan.personalSpending[personId=p9].monthlyCents', 1), isValidationError(/could not be found/));
});

test('setPath: scenario names, assumptions and changes are validated', () => {
  let st = base();
  st = S.setPath(st, 'scenarios[id=baby-arrives].name', 'Baby (May 2027)');
  assert.equal(byId(st.scenarios, 'baby-arrives').name, 'Baby (May 2027)');
  st = S.setPath(st, 'scenarios[id=baby-arrives].assumptions.costGrowthPct', 3);
  assert.equal(byId(st.scenarios, 'baby-arrives').assumptions.costGrowthPct, 3);
  assert.throws(() => S.setPath(st, 'scenarios[id=baby-arrives].assumptions.annualReturnPct', 40), isValidationError(/from 0 to 25/));
  const before = JSON.stringify(byId(st.scenarios, 'home-projects-scenario'));
  st = S.setPath(st, 'scenarios[id=baby-arrives].events[id=childcare].monthlyCents', 140000);
  assert.equal(byId(byId(st.scenarios, 'baby-arrives').events, 'childcare').monthlyCents, 140000);
  assert.equal(JSON.stringify(byId(st.scenarios, 'home-projects-scenario')), before);
  assert.throws(() => S.setPath(st, 'scenarios[id=baby-arrives].events[id=childcare].endMonth', '2027-01'), isValidationError(/end month/));
  assert.throws(() => S.setPath(st, 'scenarios[id=baby-arrives].events[id=childcare].amountCents', 1), isValidationError(/no field/));
  assert.throws(() => S.setPath(st, 'scenarios[id=baseline].events[id=x].label', 'x'), isValidationError(/could not be found/));
  st = S.setPath(st, 'scenarios[id=baby-arrives].events[id=p2-leave].netPerPaycheckCents', 0);
  assert.equal(byId(byId(st.scenarios, 'baby-arrives').events, 'p2-leave').netPerPaycheckCents, 0);
  st = S.setPath(st, 'scenarios[id=baby-arrives].events[id=p2-leave].netPerPaycheckCents', undefined);
  assert.equal('netPerPaycheckCents' in byId(byId(st.scenarios, 'baby-arrives').events, 'p2-leave'), false);
});

test('setPath: compareIds must name 1 to 3 existing scenarios', () => {
  const st = base();
  assert.deepEqual(S.setPath(st, 'compareIds', ['baby-arrives', 'home-projects-scenario']).compareIds, ['baby-arrives', 'home-projects-scenario']);
  assert.throws(() => S.setPath(st, 'compareIds', []), isValidationError(/at least one/));
  assert.throws(() => S.setPath(st, 'compareIds', ['ghost']), isValidationError(/no longer exists/));
  assert.throws(() => S.setPath(st, 'compareIds', ['baseline', 'baseline']), isValidationError(/only once/));
  const four = S.addScenario(st, 'Four', { id: 'four' });
  assert.throws(() => S.setPath(four, 'compareIds', ['baseline', 'baby-arrives', 'home-projects-scenario', 'four']), isValidationError(/up to 3/));
});

test('setPath: view settings, what-ifs, checklist and notices', () => {
  let st = base();
  st = S.setPath(st, 'ui.scope', 'household');
  assert.equal(st.ui.scope, 'household');
  assert.throws(() => S.setPath(st, 'ui.scope', 'everyone'), isValidationError());
  st = S.setPath(st, 'ui.lastRoute', '#/spending?period=2026-09&cat=Groceries');
  assert.equal(st.ui.lastRoute, '#/spending?period=2026-09&cat=Groceries');
  assert.throws(() => S.setPath(st, 'ui.lastRoute', 'https://example.invalid'), isValidationError(/page address/));
  st = S.setPath(st, 'ui.whatIf.excludeBusinessCandidates', true);
  assert.equal(st.ui.whatIf.excludeBusinessCandidates, true);
  st = S.setPath(st, 'checklist.balances', true);
  assert.deepEqual(st.checklist, { balances: true });
  assert.throws(() => S.setPath(st, 'checklist.balances', 'yes'), isValidationError(/yes or no/));
  st = S.setPath(st, 'ui.dismissed.migration', true);
  assert.equal(st.ui.dismissed.migration, true);
  st = S.setPath(st, 'meta.migrationNotes', []);
  assert.deepEqual(st.meta.migrationNotes, []);
});

test('setPath: debt promotions can be filled in field by field', () => {
  let st = S.setPath(base(), 'plan.debts[id=p2-car].promo.expiresMonth', '2027-08');
  assert.deepEqual(byId(st.plan.debts, 'p2-car').promo, { balanceCents: null, expiresMonth: '2027-08', deferredInterest: null, note: '' });
  st = S.setPath(st, 'plan.debts[id=store-card].promo', null);
  assert.equal(byId(st.plan.debts, 'store-card').promo, null);
  st = S.setPath(st, 'plan.debts[id=store-card].promo', { balanceCents: 75000, deferredInterest: true });
  assert.deepEqual(byId(st.plan.debts, 'store-card').promo, { balanceCents: 75000, expiresMonth: null, deferredInterest: true, note: '' });
  assert.throws(() => S.setPath(st, 'plan.debts[id=store-card].promo', { balanceCents: -1 }), isValidationError(/\$0 or more/));
});

test('setPath: the result always passes sanitize unchanged', () => {
  let st = base();
  st = S.setPath(st, 'plan.targets.Kids activities', 8000);
  st = S.setPath(st, 'plan.personalSpending[personId=p1].monthlyCents', 20000);
  st = S.setPath(st, 'plan.debts[id=p2-car].promo.balanceCents', 1000);
  const r = S.sanitize(st, profile(), DS);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.state, st);
});

test('addItem: validates, fills defaults and generates unique ids', () => {
  const st = deepFreeze(base());
  const next = S.addItem(st, 'bills', { label: 'Gym', category: 'Hobbies', monthlyCents: 4500, fundedFrom: 'joint' }, { now: NOW });
  const added = next.plan.bills[next.plan.bills.length - 1];
  assert.match(added.id, /^bill-[a-z0-9]+$/);
  assert.deepEqual(Object.assign({}, added, { id: 'x' }), { id: 'x', label: 'Gym', category: 'Hobbies', monthlyCents: 4500, fundedFrom: 'joint', type: 'other', debtId: null, status: 'existing', startMonth: null, endMonth: null, note: '' });
  assert.equal(next.meta.updatedAt, NOW);
  const goal = S.addItem(st, 'savings').plan.savings.at(-1);
  assert.deepEqual([goal.label, goal.monthlyCents, goal.targetCents], ['New savings goal', null, null]);
  const twice = S.addItem(S.addItem(st, 'debts'), 'debts');
  const ids = twice.plan.debts.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(S.addItem(st, 'incomes', { id: 'p1-bonus', label: 'Bonus', kind: 'other' }).plan.incomes.at(-1).id, 'p1-bonus');
  assert.throws(() => S.addItem(st, 'incomes', { id: 'p1-pay' }), isValidationError(/already exists/));
  assert.throws(() => S.addItem(st, 'bills', { monthlyCents: -3 }), isValidationError(/Monthly amount: Enter an amount of \$0 or more/));
  assert.throws(() => S.addItem(st, 'bills', { startMonth: '2027-02', endMonth: '2027-01' }), isValidationError(/end month/));
  assert.throws(() => S.addItem(st, 'targets', {}), isValidationError(/incomes, bills, savings or debts/));
  assert.deepEqual(S.sanitize(next, profile(), DS).notes, []);
});

test('addItem: list limits are enforced', () => {
  let st = base();
  while (st.plan.incomes.length < 12) st = S.addItem(st, 'incomes', { label: 'Side job ' + st.plan.incomes.length });
  assert.throws(() => S.addItem(st, 'incomes'), isValidationError(/up to 12 income streams/));
});

test('removeItem: removes by id and clears references to it', () => {
  const st = deepFreeze(base());
  let next = S.removeItem(st, 'bills', 'store-card');
  assert.equal(byId(next.plan.bills, 'store-card'), undefined);
  assert.equal(byId(next.plan.debts, 'store-card').paymentBillId, null);
  next = S.removeItem(st, 'debts', 'mortgage');
  assert.equal(byId(next.plan.bills, 'mortgage').debtId, null);
  next = S.removeItem(st, 'savings', 'home-projects');
  assert.ok(byId(next.scenarios, 'home-projects-scenario').events.every(e => e.goalId === null), 'costs are counted in full once the fund is gone');
  assert.equal(next.scenarios[1], st.scenarios[1], 'untouched scenarios are shared');
  assert.throws(() => S.removeItem(st, 'bills', 'ghost'), isValidationError(/no longer exists/));
  assert.throws(() => S.removeItem(st, 'people', 'p1'), isValidationError());
});

// ===================================================================== storage

test('storage keys', () => {
  assert.equal(S.storageKey('sample'), 'household-budget:v5:sample');
  assert.throws(() => S.storageKey(''), isValidationError());
  assert.deepEqual(S.LEGACY_KEYS(['local-sample', 'copy-1']), ['sample-household-budget-v1-local-sample', 'sample-household-budget-v1-copy-1']);
  assert.deepEqual(S.LEGACY_KEYS(), ['sample-household-budget-v1-local-sample', 'sample-household-budget-v1-local-private', 'sample-household-budget-v1-hosted']);
});

test('storage: save then load returns the same state', () => {
  const storage = memoryStorage();
  const st = S.setPath(base(), 'plan.targets.Groceries', 61000);
  const saved = S.saveToStorage(storage, st);
  assert.equal(saved.ok, true);
  assert.equal(saved.error, null);
  assert.equal(saved.key, 'household-budget:v5:sample');
  const loaded = S.loadFromStorage(storage, 'sample', profile(), DS);
  assert.equal(loaded.source, 'v5');
  assert.deepEqual(loaded.notes, []);
  assert.deepEqual(loaded.state, st);
});

test('storage: nothing saved gives the profile defaults', () => {
  const r = S.loadFromStorage(memoryStorage(), 'sample', profile(), DS, { now: NOW });
  assert.equal(r.source, 'none');
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.state, S.defaults(profile(), DS, { now: NOW }));
});

test('storage: an earlier saved budget is migrated and its key left untouched', () => {
  const legacyText = JSON.stringify(legacyV4());
  const storage = memoryStorage({ 'sample-household-budget-v1-local-sample': legacyText });
  const r = S.loadFromStorage(storage, 'sample', profile(), DS, { legacyCopyIds: ['local-sample'] });
  assert.equal(r.source, 'legacy');
  assert.equal(r.state.meta.migratedFrom, 4);
  assert.equal(storage.getItem('sample-household-budget-v1-local-sample'), legacyText);
  assert.equal(storage.getItem('household-budget:v5:sample'), null, 'loading does not write');
  assert.ok(hasNote(r.notes, /left in place, unchanged/));
  // After saving, the v5 key wins and the earlier key is still there.
  S.saveToStorage(storage, r.state);
  const again = S.loadFromStorage(storage, 'sample', profile(), DS, { legacyCopyIds: ['local-sample'] });
  assert.equal(again.source, 'v5');
  assert.deepEqual(again.state, r.state);
  assert.equal(storage.getItem('sample-household-budget-v1-local-sample'), legacyText);
});

test('storage: the earlier { copyId, state } wrapper under a copy key', () => {
  const storage = memoryStorage({ 'sample-household-budget-v1-copy-99': JSON.stringify({ copyId: 'copy-99', state: legacyV4() }) });
  const r = S.loadFromStorage(storage, 'sample', profile(), DS, { legacyCopyIds: ['local-sample', 'copy-99'] });
  assert.equal(r.source, 'legacy');
  assert.equal(byId(r.state.plan.bills, 'mortgage').monthlyCents, 146621);
});

test('storage: a damaged earlier copy is skipped and the next one used', () => {
  const storage = memoryStorage({
    'sample-household-budget-v1-local-sample': '{not json',
    'sample-household-budget-v1-hosted': JSON.stringify(legacyV4()),
    'sample-household-budget-v1-copy-1': JSON.stringify(legacyV4())
  });
  const r = S.loadFromStorage(storage, 'sample', profile(), DS, { legacyCopyIds: ['local-sample', 'hosted', 'copy-1'] });
  assert.equal(r.source, 'legacy');
  assert.ok(hasNote(r.notes, /copy "local-sample"\) is damaged and was skipped/));
  assert.ok(hasNote(r.notes, /copy "hosted"/));
  assert.ok(hasNote(r.notes, /Other earlier-version copies were also found \("copy-1"\)/));
  assert.equal(storage.getItem('sample-household-budget-v1-local-sample'), '{not json');
});

test('storage: a damaged v5 entry gives defaults, a note and a backup copy', () => {
  const storage = memoryStorage({ 'household-budget:v5:sample': '{"version":5,"plan":' });
  const r = S.loadFromStorage(storage, 'sample', profile(), DS);
  assert.equal(r.source, 'none');
  assert.deepEqual(r.state, base());
  assert.ok(hasNote(r.notes, /damaged and could not be read/));
  assert.equal(storage.getItem('household-budget:v5:sample:unreadable'), '{"version":5,"plan":');
  assert.equal(storage.getItem('household-budget:v5:sample'), '{"version":5,"plan":', 'the damaged entry itself is not deleted');
});

test('storage: a v5 entry with invalid parts is sanitized with notes', () => {
  const st = JSON.parse(JSON.stringify(base()));
  st.plan.targets.Groceries = 'lots';
  const storage = memoryStorage({ 'household-budget:v5:sample': JSON.stringify(st) });
  const r = S.loadFromStorage(storage, 'sample', profile(), DS);
  assert.equal(r.source, 'v5');
  assert.equal(r.state.plan.targets.Groceries, null);
  assert.ok(hasNote(r.notes, /plan\.targets\.Groceries/));
});

test('storage: failures while reading never throw', () => {
  const throwing = { getItem() { throw new Error('SecurityError: access denied'); }, setItem() { throw new Error('denied'); } };
  let r = S.loadFromStorage(throwing, 'sample', profile(), DS);
  assert.equal(r.source, 'none');
  assert.deepEqual(r.state, base());
  assert.ok(hasNote(r.notes, /could not be read from this browser \(SecurityError: access denied\)/));

  r = S.loadFromStorage(null, 'sample', profile(), DS);
  assert.equal(r.source, 'none');
  assert.ok(hasNote(r.notes, /not available/));

  // Only the earlier keys fail: noted, defaults used.
  const partial = { getItem(k) { if (k.startsWith('sample-household')) throw new Error('blocked'); return null; }, setItem() {} };
  r = S.loadFromStorage(partial, 'sample', profile(), DS);
  assert.equal(r.source, 'none');
  assert.ok(hasNote(r.notes, /earlier version’s saved budget \(copy "local-sample"\) could not be read \(blocked\)/));

  // A damaged entry that cannot be backed up is still reported.
  const noWrite = { getItem: () => '{oops', setItem() { throw new Error('read-only'); } };
  r = S.loadFromStorage(noWrite, 'sample', profile(), DS);
  assert.ok(hasNote(r.notes, /backup copy could not be kept \(read-only\)/));
});

test('storage: the dataset id decides the key; the state follows it', () => {
  const storage = memoryStorage();
  const r = S.loadFromStorage(storage, 'private-1', profile(), { datasetId: 'other' });
  assert.equal(r.state.datasetId, 'private-1');
  assert.equal(S.saveToStorage(storage, r.state).key, 'household-budget:v5:private-1');
});

test('storage: saving reports quota and other errors without throwing', () => {
  const quota = { setItem() { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } };
  let res = S.saveToStorage(quota, base());
  assert.equal(res.ok, false);
  assert.match(res.error, /no room left/);

  const legacyQuota = { setItem() { const e = new Error('full'); e.code = 22; throw e; } };
  assert.match(S.saveToStorage(legacyQuota, base()).error, /no room left/);

  const other = { setItem() { throw new Error('disk on fire'); } };
  res = S.saveToStorage(other, base());
  assert.equal(res.ok, false);
  assert.match(res.error, /disk on fire/);

  assert.equal(S.saveToStorage(null, base()).ok, false);
  assert.equal(S.saveToStorage({}, base()).ok, false);
  assert.match(S.saveToStorage(memoryStorage(), { version: 4 }).error, /no valid budget/);
  const cyclic = Object.assign({}, base());
  cyclic.self = cyclic;
  assert.match(S.saveToStorage(memoryStorage(), cyclic).error, /could not be prepared/);
});

// ===================================================================== hostile keys

test('hostile keys: "__proto__" is never stored; names like "constructor" are ordinary', () => {
  const raw = JSON.parse(JSON.stringify(base()));
  const text = JSON.stringify(raw).replace('"targets":{', '"targets":{"__proto__":null,"constructor":4200,');
  const r = S.sanitize(JSON.parse(text), profile(), DS);
  assert.equal(Object.getPrototypeOf(r.state.plan.targets), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(r.state.plan.targets, '__proto__'), false);
  assert.equal(r.state.plan.targets.constructor, 4200);
  assert.ok(hasNote(r.notes, /category name "__proto__" is not usable/));
  assert.deepEqual(S.sanitize(r.state, profile(), DS).notes, []);
});

test('hostile keys: earlier-version values that name Object.prototype members are rejected', () => {
  const legacy = JSON.parse('{"version":4,"incomeBasis":"constructor","vehicleBFunding":"toString","tab":"hasOwnProperty","targets":{"__proto__":5,"groceries":10},"checks":{"__proto__":true}}');
  const r = S.migrate(legacy, profile(), DS);
  assert.equal(r.state.plan.settings.incomeTiming, 'conservative');
  assert.equal(byId(r.state.plan.bills, 'p2-car').fundedFrom, 'unknown');
  assert.equal(r.state.ui.lastRoute, '#/overview');
  assert.equal(r.state.plan.targets.Groceries, 1000);
  assert.equal(Object.getPrototypeOf(r.state.plan.targets), Object.prototype);
  assert.equal(Object.getPrototypeOf(r.state.checklist), Object.prototype);
  for (const re of [/^incomeBasis: "constructor"/, /^vehicleBFunding: "toString"/, /^tab: "hasOwnProperty"/]) assert.ok(hasNote(r.notes, re), String(re));
  assert.deepEqual(S.sanitize(r.state, profile(), DS).notes, []);
});

test('hostile keys: setPath refuses "__proto__" map keys', () => {
  assert.throws(() => S.setPath(base(), 'plan.targets.__proto__', 1), isValidationError(/no field/));
  assert.throws(() => S.setPath(base(), 'checklist.__proto__', true), isValidationError(/no field/));
});

// ===================================================================== hardening review

test('setPath: the person of a personal-spending entry cannot be rewritten (it would duplicate the other person)', () => {
  const st = deepFreeze(base());
  assert.throws(() => S.setPath(st, 'plan.personalSpending[personId=p1].personId', 'p2'), isValidationError(/cannot be changed/));
  // Other fields of the same entry stay writable.
  const next = S.setPath(st, 'plan.personalSpending[personId=p1].monthlyCents', 12000);
  assert.deepEqual(next.plan.personalSpending.map(p => p.personId), ['p1', 'p2']);
  assert.equal(next.plan.personalSpending[0].monthlyCents, 12000);
});

test('sanitize: an invalid saved joint cash amount becomes unknown, never the profile’s balance', () => {
  const p = profile();
  p.plan.balances = { jointCashCents: 412300, asOf: '2026-01-31', note: 'Invented balance.' };
  const raw = JSON.parse(JSON.stringify(S.defaults(p, DS)));
  raw.plan.balances = { jointCashCents: 'lots', asOf: '2026-09-30', note: '' };
  const r = S.sanitize(raw, p, DS);
  // Taking the profile's $4,123.00 would show it as the balance on 2026-09-30, a date it was never true.
  assert.equal(r.state.plan.balances.jointCashCents, null);
  assert.equal(r.state.plan.balances.asOf, '2026-09-30');
  assert.ok(hasNote(r.notes, /plan\.balances\.jointCashCents: "lots" is not valid .*Reset to blank \(unknown\)/));
  // A balance that was never saved still comes from the profile.
  const missing = JSON.parse(JSON.stringify(raw));
  delete missing.plan.balances.jointCashCents;
  assert.equal(S.sanitize(missing, p, DS).state.plan.balances.jointCashCents, 412300);
});

test('migrate: earlier "cash available for goals" does not inherit the profile’s balance date', () => {
  const p = profile();
  p.plan.balances = { jointCashCents: 412300, asOf: '2026-01-31', note: '' };
  const legacy = legacyV4();
  legacy.currentCash = 2500;
  const r = S.migrate(legacy, p, DS);
  assert.equal(r.state.plan.balances.jointCashCents, 250000);
  assert.equal(r.state.plan.balances.asOf, null, 'the earlier version never recorded when its cash figure was true');
  assert.ok(hasNote(r.notes, /balance date 2026-01-31 .*cleared/));
  // The same amount as the profile is the same fact, so its date stays.
  legacy.currentCash = 4123;
  assert.equal(S.migrate(legacy, p, DS).state.plan.balances.asOf, '2026-01-31');
});

test('migrate: the combined energy target also replaces gas and electric bills (no double count)', () => {
  const p = profile();
  delete p.plan.targets['Gas & heating'];
  delete p.plan.targets.Electric;
  p.plan.bills.push(
    { id: 'gas-bill', label: 'Gas budget billing', category: 'Gas & heating', monthlyCents: 9000, fundedFrom: 'joint', type: 'utility', debtId: null, status: 'existing', startMonth: null, endMonth: null, note: '' },
    { id: 'electric-bill', label: 'Electric budget billing', category: 'Electric', monthlyCents: 11000, fundedFrom: 'joint', type: 'utility', debtId: null, status: 'existing', startMonth: null, endMonth: null, note: '' }
  );
  const r = S.migrate(legacyV4(), p, DS);
  assert.equal(r.state.plan.targets['Energy (gas + electric, migrated)'], 18000);
  assert.equal(byId(r.state.plan.bills, 'gas-bill'), undefined);
  assert.equal(byId(r.state.plan.bills, 'electric-bill'), undefined);
  assert.ok(hasNote(r.notes, /"Gas budget billing" \(\$90\.00\) and "Electric budget billing" \(\$110\.00\) bills were removed/));
});

test('migrate: a phone/internet allowance also replaces an Internet & phone target (no double count)', () => {
  const p = profile();
  p.plan.targets['Internet & phone'] = 6000;
  const legacy = legacyV4();
  legacy.targets.phoneInsurance = 210;
  const r = S.migrate(legacy, p, DS);
  assert.equal('Internet & phone' in r.state.plan.targets, false);
  assert.equal(r.state.plan.bills.find(b => b.label === 'Phone, internet & other insurance (migrated)').monthlyCents, 21000);
  assert.ok(hasNote(r.notes, /Internet & phone target \(\$60\.00\) was removed/));
});

test('migrate: the card-fee reserve also replaces a card-fee bill (no double count)', () => {
  const p = profile();
  delete p.plan.targets['Fees & interest'];
  p.plan.bills.push({ id: 'card-fee', label: 'Card annual fee', category: 'Fees & interest', monthlyCents: 792, fundedFrom: 'joint', type: 'other', debtId: null, status: 'existing', startMonth: null, endMonth: null, note: '' });
  const r = S.migrate(legacyV4(), p, DS);
  const fees = r.state.plan.bills.filter(b => b.category === 'Fees & interest');
  assert.deepEqual(fees.map(b => [b.label, b.monthlyCents]), [['Annual card-fee reserve (migrated)', 1000]]);
  assert.ok(hasNote(r.notes, /"Card annual fee" \(\$7\.92\) bill was removed/));
});

test('migrate: changes beyond the per-scenario limit are named in the notes, not dropped silently', () => {
  const legacy = legacyV4();
  legacy.forecast.oneoffs = Array.from({ length: 205 }, (_, i) => ({ label: 'Cost ' + (i + 1), amount: 10, month: '2027-01' }));
  const r = S.migrate(legacy, profile(), DS);
  const sc = r.state.scenarios.find(s => s.name === 'Saved forecast (from earlier version)');
  assert.equal(sc.events.length, 200);
  assert.ok(hasNote(r.notes, /only 200 changes, so 7 changes were not carried over \("Cost 199", "Cost 200"/));
});

test('storage: by default a household data set never carries over the sample page’s earlier budget', () => {
  const sampleCopy = legacyV4();
  const privateCopy = legacyV4();
  privateCopy.personAPay = 2875.4;
  const storage = memoryStorage({
    'sample-household-budget-v1-local-sample': JSON.stringify(sampleCopy),
    'sample-household-budget-v1-local-private': JSON.stringify(privateCopy)
  });
  const household = { datasetId: 'household-1', isSynthetic: false };
  const r = S.loadFromStorage(storage, 'household-1', profile(), household);
  assert.equal(r.source, 'legacy');
  assert.equal(byId(r.state.plan.incomes, 'p1-pay').netPerPaycheckCents, 287540, 'the private copy is used');
  assert.ok(hasNote(r.notes, /copy "local-private"/));
  // With only the sample page's copy present, nothing invented is carried into the household budget.
  const onlySample = memoryStorage({ 'sample-household-budget-v1-local-sample': JSON.stringify(sampleCopy) });
  const r2 = S.loadFromStorage(onlySample, 'household-1', profile(), household);
  assert.equal(r2.source, 'none');
  assert.ok(hasNote(r2.notes, /sample data \(copy "local-sample"\) was found but was not carried over/));
  assert.equal(onlySample.getItem('sample-household-budget-v1-local-sample'), JSON.stringify(sampleCopy), 'left unchanged');
});

test('storage: by default the sample data set never carries over a household’s private earlier budget', () => {
  const storage = memoryStorage({ 'sample-household-budget-v1-local-private': JSON.stringify(legacyV4()) });
  const r = S.loadFromStorage(storage, 'sample', profile(), { datasetId: 'sample', isSynthetic: true });
  assert.equal(r.source, 'none');
  assert.deepEqual(r.state, base());
});

test('storage: by default downloaded copies ("copy-*" keys) are found, newest first', () => {
  const older = legacyV4();
  older.personAPay = 2100;
  const newer = legacyV4();
  newer.personAPay = 2200;
  const storage = memoryStorage({
    'sample-household-budget-v1-copy-1700000000000': JSON.stringify({ copyId: 'copy-1700000000000', state: older }),
    'sample-household-budget-v1-copy-1800000000000': JSON.stringify({ copyId: 'copy-1800000000000', state: newer }),
    'unrelated-key': 'x'
  });
  const r = S.loadFromStorage(storage, 'household-1', profile(), { datasetId: 'household-1', isSynthetic: false });
  assert.equal(r.source, 'legacy');
  assert.equal(byId(r.state.plan.incomes, 'p1-pay').netPerPaycheckCents, 220000);
  assert.ok(hasNote(r.notes, /Other earlier-version copies were also found \("copy-1700000000000"\)/));
  // Storage that cannot list its keys is simply not scanned.
  const noKeys = { getItem: k => storage.getItem(k), setItem() {}, get length() { throw new Error('blocked'); } };
  assert.equal(S.loadFromStorage(noKeys, 'household-1', profile(), { datasetId: 'household-1' }).source, 'none');
});

test('workbook import: an earlier page that holds no saved budget gets a specific message', () => {
  const html = '<!doctype html><html><body><script id="budget-state" type="application/json">{"copyId":"local-private","state":null}</script></body></html>';
  assert.throws(() => S.importWorkbook(html, profile(), DS), isValidationError(/no saved budget inside/));
});
