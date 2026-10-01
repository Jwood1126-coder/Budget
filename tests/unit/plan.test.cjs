'use strict';
// Tests for BudgetEngine.plan: joint vs household monthly budgets, personal allocations,
// unknown amounts and whatChanged. The household ("Alex & Sam") and all amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const P = E.plan;

/**
 * Invented household: Alex's biweekly paycheck is split ($2,240 net, $1,880 to joint, $360 to
 * Alex's personal account, which pays Alex's car and student loans). Sam transfers $1,325 into
 * joint on the 1st and 15th; Sam's full pay is unknown. Sam's car payment has unknown funding.
 */
function basePlan() {
  return {
    people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }],
    incomes: [
      { id: 'alex-pay', label: 'Alex paycheck', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 224000, jointPerPaycheckCents: 188000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2024-10-04', status: 'confirmed', startMonth: null, endMonth: null },
      { id: 'sam-pay', label: 'Sam paycheck', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: null, jointPerPaycheckCents: null, frequency: 'unknown', frequencyStatus: 'unknown', anchorDate: null, status: 'unknown' },
      { id: 'sam-contrib', label: 'Sam contribution', personId: 'p2', kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: 132500, frequency: 'semimonthly', frequencyStatus: 'observed', semimonthlyDays: [1, 15], status: 'observed' }
    ],
    bills: [
      { id: 'mortgage', label: 'Mortgage', category: 'Mortgage', monthlyCents: 141256, fundedFrom: 'joint', type: 'housing', debtId: 'mortgage', status: 'existing', startMonth: null, endMonth: null },
      { id: 'internet', label: 'Internet', category: 'Internet & phone', monthlyCents: 7500, fundedFrom: 'joint', type: 'utility', status: 'existing' },
      { id: 'alex-car', label: 'Alex car loan', category: 'Auto loan', monthlyCents: 24500, fundedFrom: 'p1', type: 'debt', status: 'existing' },
      { id: 'alex-loans', label: 'Alex student loans', category: 'Education', monthlyCents: 28950, fundedFrom: 'p1', type: 'debt', status: 'existing' },
      { id: 'sam-car', label: 'Sam car loan', category: 'Auto loan', monthlyCents: 37200, fundedFrom: 'unknown', type: 'debt', status: 'existing' },
      { id: 'life', label: 'Life insurance', category: 'Life insurance', monthlyCents: 4000, fundedFrom: 'joint', type: 'insurance', status: 'planned' }
    ],
    debts: [{ id: 'mortgage', label: 'Mortgage', balanceCents: 14800000 }],
    targets: { Groceries: 70000, 'Dining & takeout': 25000 },
    savings: [
      { id: 'cushion', label: 'Emergency cushion', targetCents: 1500000, targetMonth: null, savedCents: null, monthlyCents: 15000, spendAtTarget: false },
      { id: 'trip', label: 'Anniversary trip', targetCents: 240000, targetMonth: '2027-09', savedCents: 0, monthlyCents: 20000, spendAtTarget: true }
    ],
    personalSpending: [],
    balances: { jointCashCents: null, asOf: null, note: '' },
    settings: { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 }
  };
}

/** Same household with Sam's pay known: $3,000 net monthly, none of it deposited to joint directly. */
function knownPayPlan() {
  const plan = basePlan();
  plan.incomes[1] = Object.assign({}, plan.incomes[1], { netPerPaycheckCents: 300000, frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 1 });
  return plan;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** knownPayPlan() with Sam's transfer to joint unknown (e.g. during parental leave). */
function unknownTransferPlan() {
  const plan = knownPayPlan();
  plan.incomes[2] = Object.assign({}, plan.incomes[2], { jointPerPaycheckCents: null });
  return plan;
}

const line = (summary, id) => summary.income.lines.find(l => l.id === id);
const billLine = (summary, id) => summary.bills.lines.find(l => l.id === id);
const person = (summary, id) => summary.personal.find(p => p.personId === id);

// ------------------------------------------------------------------ joint scope

test('joint: counts only joint deposits from a split paycheck plus contributions', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  assert.equal(s.scope, 'joint');
  assert.equal(s.timing, 'conservative');
  assert.equal(line(s, 'alex-pay').cents, 2 * 188000);
  assert.equal(line(s, 'alex-pay').perPaycheckCents, 188000);
  assert.equal(line(s, 'sam-contrib').cents, 2 * 132500);
  assert.equal(s.income.totalCents, 641000);
  assert.equal(s.income.knownCents, 641000);
});

test('joint: a paycheck with no joint portion from someone who contributes is not counted twice', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  assert.equal(line(s, 'sam-pay'), undefined);
  const nc = s.income.notCounted.find(n => n.id === 'sam-pay');
  assert.ok(nc, 'Sam paycheck listed as not counted');
  assert.match(nc.reason, /contribution/);
  assert.ok(s.assumptions.some(a => /Sam paycheck: no joint portion entered/.test(a)));
  assert.ok(!s.missing.some(m => m.id === 'sam-pay'));
});

test('joint: paycheck with an unknown joint portion and no contribution is missing, total null', () => {
  const plan = basePlan();
  plan.incomes = plan.incomes.filter(s => s.id !== 'sam-contrib');
  const s = P.monthly(plan, { scope: 'joint' });
  assert.equal(s.income.totalCents, null);
  assert.equal(s.income.knownCents, 376000);
  assert.equal(s.income.lowerBoundCents, 376000);
  assert.equal(s.remainingCents, null);
  assert.ok(s.missing.some(m => m.id === 'sam-pay' && m.area === 'income'));
});

test('joint: only joint-funded bills; personal bills excluded with an explanation', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  assert.deepEqual(s.bills.lines.map(b => b.id), ['mortgage', 'internet', 'life']);
  assert.equal(s.bills.totalCents, 141256 + 7500 + 4000);
  assert.deepEqual(s.bills.excludedPersonal.map(b => b.id), ['alex-car', 'alex-loans']);
  assert.ok(s.assumptions.some(a => /paid from personal allocations: Alex car loan \(Alex\), Alex student loans \(Alex\)/.test(a)));
});

test('joint: unknown-funding bill is listed as excluded and missing, never silently dropped', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  assert.deepEqual(s.bills.excludedUnknownFunding, [{ id: 'sam-car', label: 'Sam car loan', cents: 37200 }]);
  const m = s.missing.find(x => x.id === 'sam-car');
  assert.equal(m.area, 'bills');
  assert.match(m.label, /who pays it is not confirmed/);
  assert.ok(!billLine(s, 'sam-car'));
});

test('joint: remaining = income − targets − bills − savings', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  assert.equal(s.spending.targetsCents, 95000);
  assert.equal(s.savings.totalCents, 35000);
  assert.equal(s.outflowCents, 95000 + 152756);
  assert.equal(s.remainingCents, 641000 - 247756 - 35000);
  assert.equal(s.personalSpendingCents, 0);
});

// ------------------------------------------------------------------ household scope

test('household: full take-home, contribution not added as income', () => {
  const s = P.monthly(knownPayPlan(), { scope: 'household' });
  assert.equal(line(s, 'alex-pay').cents, 448000);
  assert.equal(line(s, 'sam-pay').cents, 300000);
  assert.equal(line(s, 'sam-contrib'), undefined);
  assert.equal(s.income.totalCents, 748000);
  const nc = s.income.notCounted.find(n => n.id === 'sam-contrib');
  assert.equal(nc.cents, 265000);
  assert.match(nc.reason, /not extra household income/);
});

test('household: includes every bill regardless of who pays it', () => {
  const s = P.monthly(knownPayPlan(), { scope: 'household' });
  assert.equal(s.bills.totalCents, 141256 + 7500 + 24500 + 28950 + 37200 + 4000);
  assert.ok(billLine(s, 'sam-car'));
  assert.deepEqual(s.bills.excludedUnknownFunding, []);
});

test('household: allocation pays personal bills first; leftover counted once as personal spending', () => {
  const s = P.monthly(knownPayPlan(), { scope: 'household' });
  const alex = person(s, 'p1');
  assert.equal(alex.allocationCents, 2 * (224000 - 188000));
  assert.equal(alex.billsCents, 24500 + 28950);
  assert.equal(alex.leftoverCents, 72000 - 53450);
  assert.equal(alex.spendingCents, 18550);
  assert.equal(alex.source, 'allocation');
  // Sam's allocation is the whole paycheck (no direct deposit to joint); the contribution comes out of it.
  const sam = person(s, 'p2');
  assert.equal(sam.allocationCents, 300000);
  assert.equal(sam.contributionsCents, 265000);
  assert.equal(sam.spendingCents, 35000);
  assert.equal(s.personalSpendingCents, 18550 + 35000);
});

test('household: money is counted once — remaining equals joint remaining minus unknown-funding bills', () => {
  const plan = knownPayPlan();
  const joint = P.monthly(plan, { scope: 'joint' });
  const household = P.monthly(plan, { scope: 'household' });
  assert.equal(household.remainingCents, 321044);
  assert.equal(household.remainingCents, joint.remainingCents - 37200);
});

test('household: an unknown-funding bill next to a fully counted personal share is disclosed as a possible double count', () => {
  // Sam's car payment has no confirmed paying account. Household scope counts it as a bill, and
  // Alex's and Sam's personal shares are counted in full as personal spending. If one of them
  // actually pays the car from that share, the car is inside their personal spending too.
  const s = P.monthly(knownPayPlan(), { scope: 'household' });
  const note = s.assumptions.find(a => /Sam car loan/.test(a) && /personal spending/.test(a));
  assert.ok(note, s.assumptions.join('\n'));
  assert.match(note, /\$372\.00/);
  assert.match(note, /counted twice/);
  // Not needed when no personal share is counted from pay (Sam's pay unknown, no estimate).
  const plan = basePlan();
  plan.incomes[0] = Object.assign({}, plan.incomes[0], { jointPerPaycheckCents: 224000 }); // Alex keeps nothing personally
  plan.bills = plan.bills.filter(b => b.fundedFrom !== 'p1');
  const t = P.monthly(plan, { scope: 'household' });
  assert.ok(!t.assumptions.some(a => /counted twice/.test(a)), t.assumptions.join('\n'));
  // And never in joint scope, where the bill is excluded instead.
  assert.ok(!P.monthly(knownPayPlan(), { scope: 'joint' }).assumptions.some(a => /counted twice/.test(a)));
});

test('household: allocation leftover is not added again from a personal-spending estimate', () => {
  const plan = knownPayPlan();
  plan.personalSpending = [{ personId: 'p1', monthlyCents: 50000, note: 'guess' }];
  const s = P.monthly(plan, { scope: 'household' });
  assert.equal(person(s, 'p1').spendingCents, 18550);
  assert.ok(s.assumptions.some(a => /not added on top/.test(a)));
});

test('household: personal bills above the allocation give a shortfall warning, not a verdict', () => {
  const plan = knownPayPlan();
  plan.bills.push({ id: 'alex-phone', label: 'Alex phone', monthlyCents: 30000, fundedFrom: 'p1', type: 'utility', status: 'existing' });
  const s = P.monthly(plan, { scope: 'household' });
  const alex = person(s, 'p1');
  assert.equal(alex.leftoverCents, 72000 - 83450);
  assert.equal(alex.spendingCents, 0);
  assert.equal(alex.shortfallCents, 11450);
  const w = s.warnings.find(x => /Alex's personal bills/.test(x));
  assert.ok(w);
  assert.match(w, /Check whether other personal money covers this/);
  assert.doesNotMatch(w, /inadequate/i);
});

test('household: unknown partner pay -> null total with known part and an "at least" lower bound', () => {
  const s = P.monthly(basePlan(), { scope: 'household' });
  assert.equal(s.income.totalCents, null);
  assert.equal(s.income.knownCents, 448000);
  assert.equal(s.income.lowerBoundCents, 448000 + 265000);
  assert.equal(s.remainingCents, null);
  assert.ok(s.missing.some(m => m.id === 'sam-pay' && m.area === 'income'));
  // Sam's personal spending is unknown too.
  assert.equal(person(s, 'p2').spendingCents, null);
  assert.ok(s.missing.some(m => m.id === 'personal:p2'));
  assert.equal(s.complete, false);
});

test('household: someone known only through contributions has unknown pay', () => {
  const plan = basePlan();
  plan.incomes = plan.incomes.filter(s => s.id !== 'sam-pay');
  const s = P.monthly(plan, { scope: 'household' });
  assert.equal(s.income.totalCents, null);
  assert.ok(s.missing.some(m => m.id === 'pay:p2'));
  assert.equal(s.income.lowerBoundCents, 448000 + 265000);
});

test('household: personal-spending estimate is used when the allocation is unknown', () => {
  const plan = basePlan();
  plan.personalSpending = [{ personId: 'p2', monthlyCents: 40000, note: '' }];
  const s = P.monthly(plan, { scope: 'household' });
  const sam = person(s, 'p2');
  assert.equal(sam.spendingCents, 40000);
  assert.equal(sam.source, 'estimate');
  assert.ok(!s.missing.some(m => m.id === 'personal:p2'));
  assert.equal(s.personalSpendingCents, 18550 + 40000);
});

test('household: an unknown transfer to joint makes that person\'s personal spending and the remaining amount unknown', () => {
  const plan = deepFreeze(unknownTransferPlan());
  const s = P.monthly(plan, { scope: 'household' });
  // Take-home pay is still fully known.
  assert.equal(s.income.totalCents, 748000);
  const sam = person(s, 'p2');
  assert.equal(sam.allocationCents, 300000);
  assert.equal(sam.contributionsCents, null);
  assert.equal(sam.spendingCents, null);
  assert.equal(sam.leftoverCents, null);
  assert.equal(sam.source, 'missing');
  assert.equal(sam.unknownBecause, 'contribution');
  const m = s.missing.find(x => x.id === 'personal:p2');
  assert.ok(m, s.missing.map(x => x.label).join('\n'));
  assert.equal(m.label, "Sam's personal spending can't be worked out while their transfer to joint is unknown");
  assert.equal(m.area, 'targets');
  assert.deepEqual(m.streamIds, ['sam-contrib']);
  // Unknown never improves the result: nothing is left over to report.
  assert.equal(s.remainingCents, null);
  assert.equal(s.remainingUnknownReason, 'personal_spending');
  assert.equal(s.complete, false);
  // Alex's known personal share is unaffected.
  assert.equal(person(s, 'p1').spendingCents, 18550);
  assert.equal(s.personalSpendingCents, 18550);
});

test('household: with the transfer unknown, a personal-spending estimate is not swapped in for the allocation', () => {
  const plan = unknownTransferPlan();
  plan.personalSpending = [{ personId: 'p2', monthlyCents: 10000, note: 'guess' }];
  deepFreeze(plan);
  const s = P.monthly(plan, { scope: 'household' });
  assert.equal(person(s, 'p2').spendingCents, null);
  assert.equal(s.remainingCents, null);
  assert.ok(s.missing.some(x => x.id === 'personal:p2'));
  // The same plan with the transfer known counts the allocation, not the estimate.
  const known = knownPayPlan();
  known.personalSpending = [{ personId: 'p2', monthlyCents: 10000, note: 'guess' }];
  assert.equal(person(P.monthly(known, { scope: 'household' }), 'p2').spendingCents, 35000);
});

test('household: a known remaining amount is reported with no unknown reason', () => {
  const s = P.monthly(knownPayPlan(), { scope: 'household' });
  assert.equal(s.remainingUnknownReason, null);
  assert.equal(person(s, 'p2').unknownBecause, null);
  assert.equal(P.monthly(basePlan(), { scope: 'household' }).remainingUnknownReason, 'income');
});

test('joint: an unknown transfer to joint still makes joint income unknown (behaviour unchanged)', () => {
  const plan = deepFreeze(unknownTransferPlan());
  const s = P.monthly(plan, { scope: 'joint' });
  assert.equal(s.income.totalCents, null);
  assert.equal(s.income.knownCents, 376000);
  assert.equal(line(s, 'sam-contrib').cents, null);
  assert.ok(s.missing.some(m => m.id === 'sam-contrib' && m.area === 'income' && /amount reaching the joint account is not entered/.test(m.label)));
  assert.equal(s.remainingCents, null);
  assert.equal(s.remainingUnknownReason, 'income');
  // Personal spending is not part of the joint budget, so it is not listed as missing there.
  assert.ok(!s.missing.some(m => m.id === 'personal:p2'));
  assert.equal(s.personalSpendingCents, 0);
});

test('whatChanged: an unknown transfer to joint gives null deltas and says why', () => {
  const r = P.whatChanged(knownPayPlan(), unknownTransferPlan(), { scope: 'household' });
  assert.equal(r.remainingDeltaCents, null);
  assert.equal(r.annualDeltaCents, null);
  assert.ok(r.lines.some(l => /cannot be calculated because Sam's personal spending can't be worked out while their transfer to joint is unknown/.test(l)), r.lines.join('\n'));
});

test('contribution streams describe their schedule assumption in transfers, not paychecks', () => {
  const plan = knownPayPlan();
  plan.incomes[2] = Object.assign({}, plan.incomes[2], { frequency: 'unknown', frequencyStatus: 'observed', assumedPerMonthIfUnknown: 2 });
  deepFreeze(plan);
  for (const scope of ['joint', 'household']) {
    const s = P.monthly(plan, { scope });
    const l = line(s, 'sam-contrib');
    if (scope === 'joint') {
      assert.equal(l.assumption, 'Transfer schedule not confirmed: assuming 2 transfers a month for Sam contribution.');
      assert.ok(s.assumptions.includes(l.assumption), s.assumptions.join('\n'));
    }
    assert.ok(!s.assumptions.some(a => /paychecks? a month for Sam contribution/.test(a)), s.assumptions.join('\n'));
  }
  // A known frequency marked unknown, and actual timing with no transfer dates.
  const q = knownPayPlan();
  q.incomes[2] = Object.assign({}, q.incomes[2], { frequency: 'weekly', frequencyStatus: 'unknown', anchorDate: null });
  const a = line(P.monthly(q, { scope: 'joint', month: '2026-10', timing: 'actual' }), 'sam-contrib').assumption;
  assert.equal(a, 'Transfer schedule not confirmed: assuming weekly transfers for Sam contribution. No transfer date entered for Sam contribution: counting a typical month of 4 transfers (weekly) instead of actual transfer dates.');
  // Paychecks keep their wording.
  const pay = basePlan();
  assert.equal(line(P.monthly(pay, { scope: 'household' }), 'sam-pay').assumption, 'Pay frequency not confirmed: assuming 2 paychecks a month for Sam paycheck.');
});

// ------------------------------------------------------------------ missing amounts, labels

test('null target -> missing (targets) and excluded from the total', () => {
  const plan = basePlan();
  plan.targets.Fuel = null;
  const s = P.monthly(plan, { scope: 'joint' });
  assert.equal(s.spending.targetsCents, 95000);
  assert.deepEqual(s.spending.lines.find(l => l.category === 'Fuel'), { category: 'Fuel', cents: null });
  assert.ok(s.missing.some(m => m.area === 'targets' && /Fuel/.test(m.label)));
  assert.ok(s.assumptions.some(a => /left out of the totals/.test(a)));
});

test('null bill amount -> missing (bills) and excluded from the total', () => {
  const plan = basePlan();
  plan.bills.push({ id: 'water', label: 'Water', monthlyCents: null, fundedFrom: 'joint', type: 'utility', status: 'estimate' });
  const s = P.monthly(plan, { scope: 'joint' });
  assert.equal(s.bills.totalCents, 152756);
  assert.equal(billLine(s, 'water').cents, null);
  assert.ok(s.missing.some(m => m.id === 'water' && m.area === 'bills' && /amount not entered/.test(m.label)));
});

test('null savings contribution -> missing (savings)', () => {
  const plan = basePlan();
  plan.savings.push({ id: 'projects', label: 'Home projects', targetCents: null, savedCents: null, monthlyCents: null, spendAtTarget: false });
  const s = P.monthly(plan, { scope: 'joint' });
  assert.equal(s.savings.totalCents, 35000);
  assert.ok(s.missing.some(m => m.id === 'projects' && m.area === 'savings'));
});

test('planned bill is included but labelled', () => {
  const s = P.monthly(basePlan(), { scope: 'joint' });
  const life = billLine(s, 'life');
  assert.equal(life.cents, 4000);
  assert.equal(life.planned, true);
  assert.equal(life.status, 'planned');
  assert.match(life.note, /Planned/);
  assert.ok(s.assumptions.some(a => /planned bills .*Life insurance/.test(a)));
});

test('unknown cash balance and debt balance are reported as missing facts', () => {
  const plan = basePlan();
  plan.debts.push({ id: 'card', label: 'Store card', balanceCents: null });
  const s = P.monthly(plan, { scope: 'joint' });
  assert.ok(s.missing.some(m => m.area === 'balances'));
  assert.ok(s.missing.some(m => m.area === 'debts' && m.id === 'card'));
});

// ------------------------------------------------------------------ months & timing

test('bills respect startMonth/endMonth when a month is given', () => {
  const plan = basePlan();
  plan.bills[1] = Object.assign({}, plan.bills[1], { endMonth: '2026-12' });
  plan.bills[5] = Object.assign({}, plan.bills[5], { startMonth: '2027-02' });
  assert.ok(billLine(P.monthly(plan, { month: '2026-12' }), 'internet'));
  assert.ok(!billLine(P.monthly(plan, { month: '2027-01' }), 'internet'));
  assert.ok(!billLine(P.monthly(plan, { month: '2027-01' }), 'life'));
  assert.ok(billLine(P.monthly(plan, { month: '2027-02' }), 'life'));
  // Without a month, the plan as entered is shown.
  assert.ok(billLine(P.monthly(plan, {}), 'internet'));
});

test('personal bills that have ended no longer reduce the allocation', () => {
  const plan = knownPayPlan();
  plan.bills[2] = Object.assign({}, plan.bills[2], { endMonth: '2026-11' });
  const s = P.monthly(plan, { scope: 'household', month: '2026-12', timing: 'conservative' });
  assert.equal(person(s, 'p1').billsCents, 28950);
  assert.equal(person(s, 'p1').spendingCents, 72000 - 28950);
});

test('income streams respect startMonth/endMonth', () => {
  const plan = basePlan();
  plan.incomes[2] = Object.assign({}, plan.incomes[2], { startMonth: '2027-01' });
  const s = P.monthly(plan, { scope: 'joint', month: '2026-12', timing: 'conservative' });
  assert.equal(line(s, 'sam-contrib').cents, 0);
  assert.equal(s.income.totalCents, 376000);
});

test('a stream outside its window pays a known $0 even when its amount is unknown', () => {
  const plan = basePlan();
  plan.incomes[1] = Object.assign({}, plan.incomes[1], { startMonth: '2027-06' }); // Sam starts a new job later
  plan.incomes = plan.incomes.filter(s => s.id !== 'sam-contrib');
  const before = P.monthly(plan, { scope: 'household', month: '2027-05', timing: 'conservative' });
  assert.equal(line(before, 'sam-pay').cents, 0);
  assert.equal(before.income.totalCents, 448000);
  assert.ok(!before.missing.some(m => m.id === 'sam-pay'));
  const after = P.monthly(plan, { scope: 'household', month: '2027-06', timing: 'conservative' });
  assert.equal(after.income.totalCents, null);
  assert.ok(after.missing.some(m => m.id === 'sam-pay'));
});

test('timing: conservative, average and actual give different joint income', () => {
  const plan = basePlan();
  assert.equal(P.monthly(plan, { timing: 'conservative', month: '2026-10' }).income.totalCents, 376000 + 265000);
  const avg = P.monthly(plan, { timing: 'average', month: '2026-10' });
  assert.equal(line(avg, 'alex-pay').cents, E.money.divide(188000 * 26, 12));
  assert.equal(line(avg, 'alex-pay').basis, 'average');
  assert.equal(avg.income.totalCents, 407333 + 265000);
  const actual = P.monthly(plan, { timing: 'actual', month: '2026-10' });
  assert.equal(line(actual, 'alex-pay').count, 3);
  assert.equal(actual.income.totalCents, 3 * 188000 + 265000);
  const actualNov = P.monthly(plan, { timing: 'actual', month: '2026-11' });
  assert.equal(line(actualNov, 'alex-pay').count, 2);
});

test('timing defaults to plan.settings.incomeTiming; actual without a month falls back', () => {
  const plan = basePlan();
  plan.settings = Object.assign({}, plan.settings, { incomeTiming: 'average' });
  assert.equal(P.monthly(plan, {}).timing, 'average');
  const s = P.monthly(basePlan(), { timing: 'actual' });
  assert.equal(s.timing, 'conservative');
  assert.equal(s.requestedTiming, 'actual');
  assert.ok(s.assumptions.some(a => /Actual paydays need a specific month/.test(a)));
});

test('household allocation uses the same rounding as income lines under average timing', () => {
  const s = P.monthly(knownPayPlan(), { scope: 'household', timing: 'average' });
  const net = E.money.divide(224000 * 26, 12);
  const joint = E.money.divide(188000 * 26, 12);
  assert.equal(person(s, 'p1').allocationCents, net - joint);
});

test('unknown frequency assumption is surfaced when it affects a total', () => {
  const plan = knownPayPlan();
  plan.incomes[1] = Object.assign({}, plan.incomes[1], { frequency: 'unknown', assumedPerMonthIfUnknown: 2, netPerPaycheckCents: 150000 });
  const s = P.monthly(plan, { scope: 'household' });
  assert.equal(line(s, 'sam-pay').basis, 'assumed');
  assert.equal(line(s, 'sam-pay').cents, 300000);
  assert.ok(s.assumptions.includes('Pay frequency not confirmed: assuming 2 paychecks a month for Sam paycheck.'));
});

test('spend-at-target savings stop after their target month', () => {
  const s = P.monthly(basePlan(), { month: '2027-10' });
  assert.deepEqual(s.savings.lines.map(l => l.id), ['cushion']);
  assert.equal(P.monthly(basePlan(), { month: '2027-09' }).savings.totalCents, 35000);
});

// ------------------------------------------------------------------ validation & purity

test('invalid options throw ValidationError', () => {
  assert.throws(() => P.monthly(basePlan(), { scope: 'everyone' }), E.ValidationError);
  assert.throws(() => P.monthly(basePlan(), { month: '2026-13' }), E.ValidationError);
  assert.throws(() => P.monthly(basePlan(), { timing: 'weekly' }), E.ValidationError);
  assert.throws(() => P.monthly(null, {}), E.ValidationError);
});

test('monthly does not mutate the plan', () => {
  const plan = knownPayPlan();
  const before = JSON.stringify(plan);
  P.monthly(plan, { scope: 'household', month: '2026-10', timing: 'actual' });
  P.monthly(plan, { scope: 'joint' });
  assert.equal(JSON.stringify(plan), before);
});

// ------------------------------------------------------------------ whatChanged

test('whatChanged: target increase lowers remaining by the same amount, annualised ×12', () => {
  const before = basePlan();
  const after = basePlan();
  after.targets.Groceries = 80000;
  const r = P.whatChanged(before, after, { scope: 'joint' });
  assert.equal(r.remainingDeltaCents, -10000);
  assert.equal(r.annualDeltaCents, -120000);
  assert.ok(r.lines.includes('Groceries target: $700.00 → $800.00 (+$100.00).'));
  assert.ok(r.lines.some(l => /Money left each month \(joint accounts\)/.test(l)));
});

test('whatChanged: with a month, the annual delta sums the next 12 months', () => {
  const before = basePlan();
  const after = basePlan();
  after.incomes[0] = Object.assign({}, after.incomes[0], { jointPerPaycheckCents: 190000 });
  const r = P.whatChanged(before, after, { scope: 'joint', month: '2026-10', timing: 'actual' });
  assert.equal(r.remainingDeltaCents, 3 * 2000); // three paychecks in October 2026
  assert.equal(r.annualDeltaCents, 26 * 2000); // 26 paychecks between Oct 2026 and Sep 2027
  assert.ok(r.lines.some(l => /Alex paycheck: joint portion per paycheck \$1,880.00 → \$1,900.00/.test(l)));
});

test('whatChanged: added and removed bills are described; unknown income gives null deltas', () => {
  const before = basePlan();
  const after = basePlan();
  after.bills = after.bills.filter(b => b.id !== 'internet');
  after.bills.push({ id: 'daycare', label: 'Childcare', monthlyCents: 90000, fundedFrom: 'joint', type: 'other', status: 'planned' });
  const r = P.whatChanged(before, after, { scope: 'household' });
  assert.equal(r.remainingDeltaCents, null);
  assert.equal(r.annualDeltaCents, null);
  assert.ok(r.lines.some(l => /^Added bill: Childcare/.test(l)));
  assert.ok(r.lines.includes('Removed bill: Internet.'));
  assert.ok(r.lines.some(l => /cannot be calculated because some income is unknown/.test(l)));
});

test('whatChanged: a removed personal-spending estimate is described, not silently skipped', () => {
  const before = knownPayPlan();
  before.personalSpending = [{ personId: 'p2', monthlyCents: 50000, note: '' }];
  const after = knownPayPlan();
  after.personalSpending = [];
  const r = P.whatChanged(before, after, { scope: 'household' });
  assert.ok(r.lines.some(l => /^Sam's personal spending: \$500.00 → not entered\.$/.test(l)), r.lines.join('\n'));
});

test('whatChanged: payday changes that move money between months are described', () => {
  const before = basePlan();
  const after = basePlan();
  after.incomes[0] = Object.assign({}, after.incomes[0], { anchorDate: '2024-10-11' });
  after.incomes[1] = Object.assign({}, after.incomes[1], { assumedPerMonthIfUnknown: 3 });
  after.incomes[2] = Object.assign({}, after.incomes[2], { semimonthlyDays: [5, 20] });
  const r = P.whatChanged(before, after, { scope: 'joint', month: '2026-10', timing: 'actual' });
  assert.ok(r.lines.some(l => /^Alex paycheck: payday used for timing Oct 4, 2024 → Oct 11, 2024\.$/.test(l)), r.lines.join('\n'));
  assert.ok(r.lines.some(l => /^Sam paycheck: paychecks a month assumed while the frequency is unknown not set → 3\.$/.test(l)), r.lines.join('\n'));
  assert.ok(r.lines.some(l => /^Sam contribution: twice-a-month paydays 1, 15 → 5, 20\.$/.test(l)), r.lines.join('\n'));
});

test('negative plan amounts are treated as not entered (missing), never as refunds that shrink outflow', () => {
  const plan = basePlan();
  plan.bills.push({ id: 'oops', label: 'Typo bill', monthlyCents: -50000, fundedFrom: 'joint', type: 'other', status: 'existing' });
  plan.targets.Gifts = -10000;
  plan.savings.push({ id: 'neg', label: 'Negative saving', monthlyCents: -2000, spendAtTarget: false });
  const s = P.monthly(plan, { scope: 'joint' });
  const clean = P.monthly(basePlan(), { scope: 'joint' });
  assert.equal(s.bills.totalCents, clean.bills.totalCents);
  assert.equal(s.spending.targetsCents, clean.spending.targetsCents);
  assert.equal(s.savings.totalCents, clean.savings.totalCents);
  assert.equal(s.remainingCents, clean.remainingCents);
  assert.ok(s.missing.some(m => m.id === 'oops' && m.area === 'bills'));
  assert.ok(s.missing.some(m => m.id === 'target:Gifts' && m.area === 'targets'));
  assert.ok(s.missing.some(m => m.id === 'neg' && m.area === 'savings'));
  // A negative take-home is not usable either.
  const pay = basePlan();
  pay.incomes[0] = Object.assign({}, pay.incomes[0], { jointPerPaycheckCents: -188000 });
  const q = P.monthly(pay, { scope: 'joint' });
  assert.equal(q.income.totalCents, null);
  assert.ok(q.missing.some(m => m.id === 'alex-pay' && m.area === 'income'));
});
