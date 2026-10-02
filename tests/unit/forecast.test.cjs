'use strict';
// Tests for BudgetEngine.forecast: month-by-month projections, events, savings goals,
// balances, returns, growth, scenario comparison and input safety. All data is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const F = E.forecast;

const START = '2026-10';

/**
 * Simple invented household: Alex is paid $5,000 net on the 1st of each month, $4,000 of which
 * lands in joint. Joint pays the mortgage ($1,500) and a phone bill ($100); groceries target $600.
 * Joint net each month = 4,000 − 1,500 − 100 − 600 = $1,800 (and the same in household scope,
 * where Alex's $1,000 personal share is counted as personal spending).
 */
function simplePlan(extra = {}) {
  return Object.assign({
    people: [{ id: 'p1', name: 'Alex' }],
    incomes: [{ id: 'alex-pay', label: 'Alex paycheck', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 500000, jointPerPaycheckCents: 400000, frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 1, status: 'confirmed', startMonth: null, endMonth: null }],
    bills: [
      { id: 'mortgage', label: 'Mortgage', category: 'Mortgage', monthlyCents: 150000, fundedFrom: 'joint', type: 'housing', status: 'existing', startMonth: null, endMonth: null },
      { id: 'phone', label: 'Phone', category: 'Internet & phone', monthlyCents: 10000, fundedFrom: 'joint', type: 'utility', status: 'existing', startMonth: null, endMonth: null }
    ],
    debts: [],
    targets: { Groceries: 60000 },
    savings: [],
    personalSpending: [],
    balances: { jointCashCents: null, asOf: null, note: '' },
    settings: { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 }
  }, extra);
}

const NET = 180000;

function scenario(events = [], assumptions = {}) {
  return { id: 'sc-1', name: 'Test scenario', description: '', events, assumptions: Object.assign({ incomeTiming: 'conservative', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 }, assumptions) };
}

const baseline = (assumptions) => Object.assign(scenario([], assumptions), { id: 'baseline', name: 'Current plan' });

function run(plan, sc, opts = {}) {
  return F.project(plan, sc, Object.assign({ startMonth: START, months: 12, scope: 'joint' }, opts));
}

const row = (p, month) => p.rows.find(r => r.month === month);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const trip = (extra = {}) => Object.assign({ id: 'trip', label: 'Trip', targetCents: 240000, targetMonth: '2027-04', savedCents: 100000, monthlyCents: 20000, spendAtTarget: true, note: '' }, extra);

// ------------------------------------------------------------------ basics

test('project: shape, months and a steady net with no events', () => {
  const p = run(simplePlan(), baseline());
  assert.equal(p.scenarioId, 'baseline');
  assert.equal(p.scope, 'joint');
  assert.equal(p.rows.length, 12);
  assert.equal(p.rows[0].month, '2026-10');
  assert.equal(p.rows[11].month, '2027-09');
  for (const r of p.rows) {
    assert.equal(r.incomeCents, 400000);
    assert.equal(r.billsCents, 160000);
    assert.equal(r.spendingCents, 60000);
    assert.equal(r.netCents, NET);
  }
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
  assert.equal(p.summary.totalIncomeCents, 12 * 400000);
  assert.equal(p.summary.totalOutCents, 12 * 220000);
  assert.equal(p.complete, true);
});

test('project: null scenario means the plan with no events', () => {
  const p = run(simplePlan(), null);
  assert.equal(p.scenarioId, 'baseline');
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
});

test('project: household scope counts the personal share once, matching joint here', () => {
  const p = run(simplePlan(), baseline(), { scope: 'household' });
  assert.equal(p.rows[0].incomeCents, 500000);
  assert.equal(p.rows[0].spendingCents, 60000 + 100000);
  assert.equal(p.rows[0].netCents, NET);
});

// ------------------------------------------------------------------ income timing

function biweeklyPlan() {
  return simplePlan({
    incomes: [{ id: 'alex-pay', label: 'Alex paycheck', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 224000, jointPerPaycheckCents: 188000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2024-10-04' }],
    bills: [], targets: {}
  });
}

test('actual timing shows 3-paycheck months; the year still totals 26 paychecks', () => {
  const p = run(biweeklyPlan(), baseline({ incomeTiming: 'actual' }));
  const three = p.rows.filter(r => r.incomeLines[0].count === 3).map(r => r.month);
  assert.deepEqual(three, ['2026-10', '2027-04']);
  assert.equal(row(p, '2026-10').incomeCents, 3 * 188000);
  assert.equal(row(p, '2026-11').incomeCents, 2 * 188000);
  assert.equal(row(p, '2026-10').incomeLines[0].basis, 'actual');
  assert.equal(p.summary.totalIncomeCents, 26 * 188000);
  assert.ok(p.assumptions[0].startsWith('Income counts the actual paydays'));
});

test('average timing spreads the extra paychecks evenly (no 3-check months)', () => {
  const p = run(biweeklyPlan(), baseline({ incomeTiming: 'average' }));
  for (const r of p.rows) {
    assert.equal(r.incomeLines[0].count, 26 / 12);
    assert.equal(r.incomeCents, E.money.divide(188000 * 26, 12));
    assert.equal(r.incomeLines[0].basis, 'average');
  }
  assert.ok(p.rows.every(r => r.incomeLines[0].count < 3));
});

test('conservative timing never counts on the third paycheck', () => {
  const p = run(biweeklyPlan(), baseline({ incomeTiming: 'conservative' }));
  assert.ok(p.rows.every(r => r.incomeCents === 2 * 188000));
});

test('scenario timing defaults to the plan setting', () => {
  const sc = scenario();
  delete sc.assumptions.incomeTiming;
  const plan = biweeklyPlan();
  plan.settings = Object.assign({}, plan.settings, { incomeTiming: 'actual' });
  assert.equal(run(plan, sc).timing, 'actual');
});

// ------------------------------------------------------------------ one-time events & goals

test('one-time expense is counted once, in its month', () => {
  const base = run(simplePlan(), baseline());
  const p = run(simplePlan(), scenario([{ id: 'ev-repair', type: 'one_time', label: 'Car repair', month: '2026-12', amountCents: 50000, direction: 'expense', category: 'Auto maintenance', goalId: null }]));
  assert.equal(row(p, '2026-12').oneTimeCents, 50000);
  assert.equal(p.rows.filter(r => r.oneTimeCents > 0).length, 1);
  assert.equal(p.summary.totalOutCents - base.summary.totalOutCents, 50000);
  assert.equal(base.summary.endCumulativeCents - p.summary.endCumulativeCents, 50000);
  assert.equal(row(p, '2026-12').eventLines.length, 1);
  assert.equal(row(p, '2026-12').eventLines[0].signedCents, -50000);
});

test('one-time income adds to income once', () => {
  const p = run(simplePlan(), scenario([{ id: 'ev-gift', type: 'one_time', label: 'Gift', month: '2027-01', amountCents: 30000, direction: 'income', category: null, goalId: null }]));
  assert.equal(row(p, '2027-01').incomeCents, 430000);
  assert.equal(row(p, '2027-02').incomeCents, 400000);
});

test('one-time event outside the horizon has no effect and is not missing', () => {
  const p = run(simplePlan(), scenario([{ id: 'ev-late', type: 'one_time', label: 'Later', month: '2030-01', amountCents: null, direction: 'expense' }]));
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
  assert.equal(p.missing.length, 0);
});

test('spend-at-target goal: contributions earmark, target spent once in the target month', () => {
  const p = run(simplePlan({ savings: [trip()] }), baseline());
  // Oct–Apr: 7 contributions of $200 on top of $1,000 saved = $2,400.
  assert.equal(row(p, '2026-10').contributionsCents, 20000);
  assert.equal(row(p, '2026-10').netCents, NET); // contributions are not subtracted from cash
  assert.equal(row(p, '2026-10').unassignedCents, NET - 20000);
  assert.equal(row(p, '2027-04').oneTimeCents, 240000);
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 240000);
  assert.equal(row(p, '2027-04').eventLines.filter(l => l.type === 'goal_spend').length, 1);
  assert.equal(row(p, '2027-05').contributionsCents, 0);
  assert.equal(row(p, '2027-04').goals.trip, 0);
  assert.equal(p.summary.endCumulativeCents, 12 * NET - 240000);
  const g = p.goals.find(x => x.id === 'trip');
  assert.equal(g.status, 'funded');
  assert.equal(g.projectedCents, 240000);
  assert.equal(g.spentMonth, '2027-04');
  // Spending pre-saved money is not a contribution shortfall.
  assert.equal(row(p, '2027-04').goalDrawsCents, 240000);
  assert.ok(!p.summary.contributionShortfallMonths.includes('2027-04'));
  assert.ok(p.summary.negativeMonths.includes('2027-04')); // cash does go down that month
});

test('spend-at-target goal short of target: full cost leaves cash once, shortfall reported', () => {
  const p = run(simplePlan({ savings: [trip({ savedCents: 0 })] }), baseline());
  const g = p.goals.find(x => x.id === 'trip');
  assert.equal(g.status, 'short');
  assert.equal(g.shortfallCents, 240000 - 7 * 20000);
  assert.equal(row(p, '2027-04').oneTimeCents, 240000);
  assert.ok(row(p, '2027-04').warnings.some(w => /Trip: \$1,000.00 short/.test(w)));
});

test('goal-linked one-time event is not double counted with the goal spend', () => {
  const ev = { id: 'ev-trip', type: 'one_time', label: 'Trip booking', month: '2027-04', amountCents: 260000, direction: 'expense', category: 'Travel', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip()] }), scenario([ev]));
  const mar = row(p, '2027-04');
  assert.equal(mar.oneTimeCents, 260000);
  assert.equal(mar.eventLines.length, 1);
  assert.equal(mar.eventLines[0].fromGoalCents, 240000);
  assert.equal(mar.goalDrawsCents, 240000);
  assert.ok(mar.warnings.some(w => /\$200.00 more than the Trip goal holds/.test(w)));
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 260000);
  assert.equal(p.goals.find(x => x.id === 'trip').status, 'funded');
  assert.ok(p.assumptions.some(a => /Trip: paid for by a linked one-time event/.test(a)));
});

test('goal-linked event before the target month pays part of the goal; the rest is still spent in the target month', () => {
  // A $1,000 linked expense is part of the $2,400 trip, not the whole trip: the other $1,400
  // must still leave cash in the target month (previously it silently vanished).
  const ev = { id: 'ev-early', type: 'one_time', label: 'Flights booked', month: '2027-01', amountCents: 100000, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip()] }), scenario([ev]));
  assert.equal(row(p, '2027-01').oneTimeCents, 100000);
  assert.equal(row(p, '2027-01').goals.trip, 100000 + 4 * 20000 - 100000);
  assert.equal(row(p, '2027-02').contributionsCents, 20000); // the goal is not finished yet
  assert.equal(row(p, '2027-04').oneTimeCents, 140000);
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 240000); // the trip costs its target, once
  assert.equal(p.summary.endCumulativeCents, 12 * NET - 240000);
  assert.equal(row(p, '2027-04').goals.trip, 0);
  const g = p.goals.find(x => x.id === 'trip');
  assert.equal(g.status, 'funded');
  assert.equal(g.spentMonth, '2027-04');
  assert.ok(!p.summary.contributionShortfallMonths.includes('2027-04'));
  assert.ok(p.assumptions.some(a => /Trip: linked one-time events pay \$1,000.00 of the \$2,400.00 target; the remaining \$1,400.00 is spent in Apr 2027/.test(a)));
});

test('a partial linked draw does not over-earmark: contributions stop once the rest of the target is held', () => {
  // Fully saved by January ($2,400), then $500 of it is spent early: the goal only needs $1,900
  // for the rest of the trip, so no further contributions are needed.
  const ev = { id: 'ev-dep', type: 'one_time', label: 'Deposit', month: '2027-01', amountCents: 50000, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip({ savedCents: 240000 })] }), scenario([ev]));
  assert.ok(p.rows.every(r => r.contributionsCents === 0));
  assert.equal(row(p, '2027-04').oneTimeCents, 190000);
  assert.equal(row(p, '2027-04').goalDrawsCents, 190000);
  assert.equal(row(p, '2027-04').goals.trip, 0);
  assert.equal(p.goals[0].status, 'funded');
});

test('goal-linked events that cover the whole target before the target month replace the goal spend', () => {
  const ev = { id: 'ev-early', type: 'one_time', label: 'Trip (moved earlier)', month: '2027-01', amountCents: 240000, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip()] }), scenario([ev]));
  assert.equal(row(p, '2027-01').oneTimeCents, 240000);
  assert.equal(row(p, '2027-04').oneTimeCents, 0);
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 240000);
  assert.equal(row(p, '2027-02').contributionsCents, 0); // spent goal stops contributing
  const g = p.goals.find(x => x.id === 'trip');
  assert.equal(g.spentMonth, '2027-01');
  assert.equal(g.status, 'short'); // $1,800 held when it was paid for in January
  assert.equal(g.shortfallCents, 60000);
  assert.match(g.note, /Jan 2027/);
  assert.ok(p.assumptions.some(a => /Trip: paid for by a linked one-time event/.test(a)));
});

test('goal-linked event dated before the forecast starts: only the rest of the goal is spent', () => {
  const past = amount => ({ id: 'ev-past', type: 'one_time', label: 'Deposit paid', month: '2026-06', amountCents: amount, direction: 'expense', goalId: 'trip' });
  const partial = run(simplePlan({ savings: [trip()] }), scenario([past(50000)]));
  assert.equal(row(partial, '2027-04').oneTimeCents, 190000);
  assert.equal(partial.rows.reduce((a, r) => a + r.oneTimeCents, 0), 190000);
  assert.equal(partial.goals[0].status, 'funded');

  const whole = run(simplePlan({ savings: [trip()] }), scenario([past(240000)]));
  assert.equal(whole.rows.reduce((a, r) => a + r.oneTimeCents, 0), 0);
  assert.ok(whole.rows.every(r => r.contributionsCents === 0));
  assert.equal(whole.goals[0].status, 'funded');
});

test('goal-linked event after the target month is the spending: nothing extra in the target month', () => {
  const ev = { id: 'ev-late', type: 'one_time', label: 'Trip (moved later)', month: '2027-06', amountCents: 240000, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip()] }), scenario([ev]));
  assert.equal(row(p, '2027-04').oneTimeCents, 0);
  assert.equal(row(p, '2027-05').goals.trip, 240000); // kept for the later payment
  assert.equal(row(p, '2027-06').oneTimeCents, 240000);
  assert.equal(row(p, '2027-06').goalDrawsCents, 240000);
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 240000);
  assert.equal(p.goals[0].status, 'funded');
  assert.equal(p.goals[0].spentMonth, '2027-06');
});

test('spend-at-target goal with no target but a linked event: the rest of its cost is reported missing', () => {
  const ev = { id: 'ev-dep', type: 'one_time', label: 'Deposit', month: '2027-02', amountCents: 50000, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip({ targetCents: null })] }), scenario([ev]));
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 50000); // only the known part is counted
  assert.ok(p.missing.some(m => m.id === 'trip' && /target amount not entered/.test(m.label)));
  assert.equal(p.complete, false);
  assert.equal(p.goals[0].status, 'no_target');
});

test('goal-linked event with no amount: the goal target is still spent and the event is missing', () => {
  const ev = { id: 'ev-blank', type: 'one_time', label: 'Hotel', month: '2027-04', amountCents: null, direction: 'expense', goalId: 'trip' };
  const p = run(simplePlan({ savings: [trip()] }), scenario([ev]));
  assert.equal(row(p, '2027-04').oneTimeCents, 240000); // the known estimate is not dropped
  assert.ok(p.missing.some(m => m.id === 'ev-blank' && m.source === 'event'));
  assert.equal(p.complete, false);
});

test('one-time event drawing on a keep goal: outflow once, goal balance reduced', () => {
  const cushion = { id: 'cushion', label: 'Cushion', targetCents: 500000, targetMonth: null, savedCents: 300000, monthlyCents: 10000, spendAtTarget: false };
  const ev = { id: 'ev-roof', type: 'one_time', label: 'Roof repair', month: '2026-11', amountCents: 80000, direction: 'expense', goalId: 'cushion' };
  const p = run(simplePlan({ savings: [cushion] }), scenario([ev]));
  const nov = row(p, '2026-11');
  assert.equal(nov.oneTimeCents, 80000);
  assert.equal(nov.goals.cushion, 300000 + 2 * 10000 - 80000);
  assert.equal(nov.unassignedCents, NET - 80000 - 10000 + 80000);
  assert.equal(row(p, '2026-12').contributionsCents, 10000);
  assert.ok(p.assumptions.some(a => /Roof repair draws on the Cushion goal: the cost is counted once/.test(a)));
  assert.ok(!p.assumptions.some(a => /Cushion: paid for by a linked one-time event/.test(a)));
});

test('one-time event linked to an unknown goal is still counted once with a warning', () => {
  const ev = { id: 'ev-x', type: 'one_time', label: 'Mystery', month: '2026-10', amountCents: 1000, direction: 'expense', goalId: 'nope' };
  const p = run(simplePlan(), scenario([ev]));
  assert.equal(row(p, '2026-10').oneTimeCents, 1000);
  assert.ok(row(p, '2026-10').warnings.some(w => /linked savings goal not found/.test(w)));
});

test('keep goal stops contributing once a known target is reached', () => {
  const cushion = { id: 'cushion', label: 'Cushion', targetCents: 50000, targetMonth: null, savedCents: 20000, monthlyCents: 20000, spendAtTarget: false };
  const p = run(simplePlan({ savings: [cushion] }), baseline());
  assert.deepEqual(p.rows.slice(0, 4).map(r => r.contributionsCents), [20000, 10000, 0, 0]);
  assert.deepEqual(p.rows.slice(0, 3).map(r => r.goals.cushion), [40000, 50000, 50000]);
  const g = p.goals[0];
  assert.equal(g.status, 'funded');
  assert.equal(g.reachedMonth, '2026-11');
  assert.equal(g.contributedCents, 30000);
});

test('keep goal with no target keeps contributing; status no_target', () => {
  const fund = { id: 'projects', label: 'Home projects', targetCents: null, targetMonth: null, savedCents: 0, monthlyCents: 10000, spendAtTarget: false };
  const p = run(simplePlan({ savings: [fund] }), baseline());
  assert.ok(p.rows.every(r => r.contributionsCents === 10000));
  assert.equal(p.goals[0].status, 'no_target');
  assert.equal(p.goals[0].projectedCents, 120000);
});

test('unknown saved amount: projected from $0, balance hidden, status unknown_start', () => {
  const cushion = { id: 'cushion', label: 'Cushion', targetCents: 1500000, targetMonth: null, savedCents: null, monthlyCents: 15000, spendAtTarget: false };
  const p = run(simplePlan({ savings: [cushion] }), baseline());
  assert.ok(p.rows.every(r => r.goals.cushion === null));
  const g = p.goals[0];
  assert.equal(g.status, 'unknown_start');
  assert.equal(g.projectedCents, null);
  assert.equal(g.atLeastCents, 12 * 15000);
  assert.equal(g.shortfallCents, null);
  assert.ok(p.assumptions.some(a => /Cushion: amount already saved is unknown/.test(a)));
});

test('missing monthly contribution: reported once, status missing_amount', () => {
  const g = { id: 'g', label: 'Car fund', targetCents: 100000, targetMonth: null, savedCents: 0, monthlyCents: null, spendAtTarget: false };
  const p = run(simplePlan({ savings: [g] }), baseline());
  assert.equal(p.missing.filter(m => m.id === 'g').length, 1);
  assert.equal(p.goals[0].status, 'missing_amount');
  assert.ok(p.rows.every(r => r.contributionsCents === 0));
});

test('spend-at-target goal with no target amount: its spending is missing, not $0', () => {
  const p = run(simplePlan({ savings: [trip({ targetCents: null })] }), baseline());
  assert.equal(row(p, '2027-04').oneTimeCents, 0);
  assert.ok(p.missing.some(m => m.id === 'trip' && /target amount not entered/.test(m.label)));
  assert.equal(p.goals[0].status, 'no_target');
  assert.equal(p.complete, false);
});

test('goal with a target month beyond the horizon is judged by extending contributions', () => {
  const g = trip({ targetMonth: '2028-03', savedCents: 0, targetCents: 360000, monthlyCents: 20000 });
  const p = run(simplePlan({ savings: [g] }), baseline());
  assert.equal(p.rows.reduce((a, r) => a + r.oneTimeCents, 0), 0);
  const res = p.goals[0];
  assert.equal(res.status, 'funded'); // 18 contributions by Mar 2028 = $3,600
  assert.match(res.note, /after the forecast horizon/);
});

test('contributions start at max(startMonth, now)', () => {
  const g = { id: 'g', label: 'Fund', targetCents: null, savedCents: 0, monthlyCents: 10000, spendAtTarget: false };
  const p = run(simplePlan({ savings: [g] }), baseline(), { now: '2027-01' });
  assert.deepEqual(p.rows.slice(0, 4).map(r => r.contributionsCents), [0, 0, 0, 10000]);
  const q = run(simplePlan({ savings: [g] }), baseline(), { now: '2025-01' });
  assert.equal(q.rows[0].contributionsCents, 10000);
});

test('contribution shortfall months: income after spending does not cover planned savings', () => {
  const g = { id: 'big', label: 'Big goal', targetCents: null, savedCents: 0, monthlyCents: 200000, spendAtTarget: false };
  const p = run(simplePlan({ savings: [g] }), baseline());
  assert.equal(p.rows[0].unassignedCents, NET - 200000);
  assert.equal(p.summary.contributionShortfallMonths.length, 12);
  assert.deepEqual(p.summary.negativeMonths, []);
});

test('scenario goal event adds a goal to this scenario only', () => {
  const plan = simplePlan();
  const sc = scenario([{ id: 'ev-goal', type: 'goal', label: 'Baby fund', goal: { id: 'baby', label: 'Baby fund', targetCents: 300000, targetMonth: '2027-05', savedCents: 0, monthlyCents: 25000, spendAtTarget: false } }]);
  const p = run(plan, sc);
  assert.equal(p.goals.length, 1);
  assert.equal(p.goals[0].id, 'baby');
  assert.equal(p.rows[0].contributionsCents, 25000);
  assert.equal(run(plan, baseline()).goals.length, 0);
  assert.equal(plan.savings.length, 0);
});

// ------------------------------------------------------------------ balances & returns

test('unknown starting balance: balance null, cumulative change still reported', () => {
  const p = run(simplePlan(), baseline());
  assert.ok(p.rows.every(r => r.balanceCents === null));
  assert.equal(p.rows[2].cumulativeCents, 3 * NET);
  assert.equal(p.summary.endBalanceCents, null);
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
  assert.equal(p.summary.firstNegativeBalanceMonth, null);
  assert.ok(p.assumptions.some(a => /Joint cash balance not entered/.test(a)));
});

test('known balance with negative months: balance path, first negative month, lowest point', () => {
  const plan = simplePlan({ targets: { Groceries: 300000 }, balances: { jointCashCents: 100000, asOf: '2026-09-30', note: '' } });
  const p = run(plan, baseline());
  assert.equal(p.rows[0].netCents, -60000);
  assert.equal(p.rows[0].balanceCents, 40000);
  assert.equal(p.rows[1].balanceCents, -20000);
  assert.equal(p.summary.firstNegativeBalanceMonth, '2026-11');
  assert.equal(p.summary.negativeMonths.length, 12);
  assert.equal(p.summary.lowest.month, '2027-09');
  assert.equal(p.summary.lowest.balanceCents, 100000 - 12 * 60000);
  assert.equal(p.summary.endCumulativeCents, -12 * 60000);
  assert.ok(p.assumptions.some(a => /Starting joint cash balance: \$1,000.00 as of Sep 30, 2026/.test(a)));
});

test('return is 0 by default, even with a known positive balance', () => {
  const p = run(simplePlan({ balances: { jointCashCents: 1000000 } }), baseline());
  assert.ok(p.rows.every(r => r.returnCents === 0));
  assert.equal(p.summary.endBalanceCents, 1000000 + 12 * NET);
  assert.ok(p.assumptions.includes('No interest or investment return is assumed (0%).'));
});

test('a positive return applies only to a positive known balance and is labelled hypothetical', () => {
  const plan = simplePlan({ targets: { Groceries: 240000 }, balances: { jointCashCents: 1000000 } }); // net 0
  const p = run(plan, baseline({ annualReturnPct: 6 }));
  assert.equal(p.rows[0].returnCents, 5000);
  assert.equal(p.rows[1].returnCents, E.money.divide(1005000 * 6, 1200));
  assert.equal(p.rows[1].balanceCents, 1005000 + 5025);
  assert.ok(p.assumptions.some(a => /Hypothetical 6% annual return/.test(a)));
});

test('no return on an unknown balance or a negative balance; negative rates are ignored', () => {
  const unknown = run(simplePlan(), baseline({ annualReturnPct: 6 }));
  assert.ok(unknown.rows.every(r => r.returnCents === null));
  assert.equal(unknown.summary.endCumulativeCents, 12 * NET);
  assert.ok(unknown.assumptions.some(a => /no return is applied because the starting cash balance is unknown/.test(a)));

  const negative = run(simplePlan({ targets: { Groceries: 300000 }, balances: { jointCashCents: -50000 } }), baseline({ annualReturnPct: 6 }));
  assert.ok(negative.rows.every(r => r.returnCents === 0));

  const negRate = run(simplePlan({ balances: { jointCashCents: 1000000 } }), baseline({ annualReturnPct: -5 }));
  assert.ok(negRate.rows.every(r => r.returnCents === 0));
});

// ------------------------------------------------------------------ bills, changes, recurring

test('a bill stops after its end month', () => {
  const plan = simplePlan();
  plan.bills[1] = Object.assign({}, plan.bills[1], { endMonth: '2026-12' });
  const p = run(plan, baseline());
  assert.equal(row(p, '2026-12').billsCents, 160000);
  assert.equal(row(p, '2027-01').billsCents, 150000);
  assert.ok(p.assumptions.some(a => /Phone \(final payment Dec 2026\)/.test(a)));
  assert.ok(p.assumptions.includes('Bills continue at their current amounts every month unless a final payment month is set.'));
});

test('bill_change to 0 stops a bill for its range', () => {
  const ev = { id: 'ev-cut', type: 'bill_change', label: 'Cancel phone', billId: 'phone', startMonth: '2027-01', endMonth: null, monthlyCents: 0 };
  const p = run(simplePlan(), scenario([ev]));
  assert.equal(row(p, '2026-12').billsCents, 160000);
  assert.equal(row(p, '2027-01').billsCents, 150000);
  assert.equal(row(p, '2027-09').billsCents, 150000);
});

test('bill_change respects the plan bill’s own end month', () => {
  const plan = simplePlan();
  plan.bills[1] = Object.assign({}, plan.bills[1], { endMonth: '2026-12' });
  const ev = { id: 'ev-up', type: 'bill_change', label: 'Phone price rise', billId: 'phone', startMonth: '2026-11', endMonth: null, monthlyCents: 20000 };
  const p = run(plan, scenario([ev]));
  assert.equal(row(p, '2026-10').billsCents, 160000);
  assert.equal(row(p, '2026-11').billsCents, 170000);
  assert.equal(row(p, '2027-01').billsCents, 150000);
});

test('bill_change with an unknown amount is missing for those months, credited to the event', () => {
  const ev = { id: 'ev-q', type: 'bill_change', label: 'New phone plan', billId: 'phone', startMonth: '2027-01', endMonth: '2027-02', monthlyCents: null };
  const p = run(simplePlan(), scenario([ev]));
  assert.equal(row(p, '2027-01').billsCents, 150000);
  assert.equal(row(p, '2027-04').billsCents, 160000);
  const m = p.missing.filter(x => x.id === 'ev-q');
  assert.equal(m.length, 1);
  assert.equal(m[0].source, 'event');
});

test('income_change: leave months then pay is restored', () => {
  const ev = { id: 'ev-leave', type: 'income_change', label: 'Unpaid leave', streamId: 'alex-pay', startMonth: '2027-01', endMonth: '2027-04', netPerPaycheckCents: 0, jointPerPaycheckCents: 0 };
  const p = run(simplePlan(), scenario([ev]), { scope: 'household' });
  assert.equal(row(p, '2026-12').incomeCents, 500000);
  assert.equal(row(p, '2027-01').incomeCents, 0);
  assert.equal(row(p, '2027-04').incomeCents, 0);
  assert.equal(row(p, '2027-05').incomeCents, 500000);
  assert.equal(row(p, '2027-01').netCents, -220000);
});

test('income_change: an undefined field is unchanged; null is unknown and missing', () => {
  const ev = { id: 'ev-part', type: 'income_change', label: 'Part-time', streamId: 'alex-pay', startMonth: '2027-01', endMonth: '2027-02', netPerPaycheckCents: null };
  const joint = run(simplePlan(), scenario([ev]), { scope: 'joint' });
  assert.equal(row(joint, '2027-01').incomeCents, 400000); // joint portion unchanged
  const household = run(simplePlan(), scenario([ev]), { scope: 'household' });
  assert.equal(row(household, '2027-01').incomeCents, null);
  assert.equal(row(household, '2027-01').netCents, null);
  assert.equal(row(household, '2027-04').incomeCents, 500000);
  assert.equal(row(household, '2027-04').cumulativeCents, null); // unknown contaminates the running total
  assert.ok(household.missing.some(m => m.id === 'ev-part' && m.source === 'event'));
});

test('recurring expense with no end month continues to the horizon', () => {
  const ev = { id: 'ev-care', type: 'recurring', label: 'Childcare', startMonth: '2027-05', endMonth: null, monthlyCents: 90000, direction: 'expense', category: 'Baby & childcare' };
  const p = run(simplePlan(), scenario([ev]), { months: 24 });
  assert.equal(row(p, '2027-04').spendingCents, 60000);
  assert.equal(row(p, '2027-05').spendingCents, 150000);
  assert.equal(row(p, '2028-09').spendingCents, 150000);
  assert.equal(p.rows.filter(r => r.spendingCents === 150000).length, 17);
});

test('recurring income and income loss change income for their range', () => {
  const evs = [
    { id: 'ev-side', type: 'recurring', label: 'Side job', startMonth: '2026-11', endMonth: '2026-12', monthlyCents: 20000, direction: 'income' },
    { id: 'ev-loss', type: 'recurring', label: 'Reduced hours', startMonth: '2027-02', endMonth: '2027-02', monthlyCents: 50000, direction: 'income_loss' }
  ];
  const p = run(simplePlan(), scenario(evs));
  assert.equal(row(p, '2026-11').incomeCents, 420000);
  assert.equal(row(p, '2027-01').incomeCents, 400000);
  assert.equal(row(p, '2027-02').incomeCents, 350000);
});

test('target_change sets a target for its range only', () => {
  const ev = { id: 'ev-groc', type: 'target_change', label: 'Bigger shop', category: 'Groceries', startMonth: '2027-01', endMonth: '2027-04', monthlyCents: 80000 };
  const p = run(simplePlan(), scenario([ev]));
  assert.equal(row(p, '2026-12').spendingCents, 60000);
  assert.equal(row(p, '2027-02').spendingCents, 80000);
  assert.equal(row(p, '2027-05').spendingCents, 60000);
});

// ------------------------------------------------------------------ missing & unknown

test('missing amounts are reported once and never counted as $0', () => {
  const plan = simplePlan({ targets: { Groceries: 60000, Fuel: null } });
  const evs = [
    { id: 'ev-quote', type: 'one_time', label: 'Window replacement', month: '2027-02', amountCents: null, direction: 'expense' },
    { id: 'ev-care', type: 'recurring', label: 'Childcare', startMonth: '2027-05', endMonth: null, monthlyCents: null, direction: 'expense' },
    { id: 'ev-when', type: 'one_time', label: 'Electrical panel', month: null, amountCents: 300000, direction: 'expense' }
  ];
  const p = run(plan, scenario(evs));
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
  const ids = p.missing.map(m => m.id).sort();
  assert.deepEqual(ids, ['ev-care', 'ev-quote', 'ev-when', 'target:Fuel']);
  assert.equal(p.missing.find(m => m.id === 'target:Fuel').source, 'plan');
  assert.equal(p.missing.find(m => m.id === 'ev-quote').source, 'event');
  assert.equal(row(p, '2027-02').eventLines[0].cents, null);
  assert.equal(p.complete, false);
  assert.ok(p.assumptions.some(a => /4 missing amounts are left out of the totals \(not treated as \$0\)/.test(a)));
});

test('joint scope: a bill with unknown funding is excluded and listed as missing once', () => {
  const plan = simplePlan();
  plan.bills.push({ id: 'car-b', label: 'Partner B car', monthlyCents: 37200, fundedFrom: 'unknown', type: 'debt', status: 'existing' });
  const p = run(plan, baseline());
  assert.equal(p.rows[0].billsCents, 160000);
  assert.equal(p.missing.filter(m => m.id === 'car-b').length, 1);
  const h = run(plan, baseline(), { scope: 'household' });
  assert.equal(h.rows[0].billsCents, 160000 + 37200);
});

test('household scope with unknown income: net and cumulative null, known part reported', () => {
  const plan = simplePlan({
    people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }],
    incomes: [
      simplePlan().incomes[0],
      { id: 'sam-pay', label: 'Sam paycheck', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: null, jointPerPaycheckCents: null, frequency: 'unknown', frequencyStatus: 'unknown' },
      { id: 'sam-contrib', label: 'Sam contribution', personId: 'p2', kind: 'contribution', jointPerPaycheckCents: 132500, frequency: 'semimonthly', frequencyStatus: 'observed', semimonthlyDays: [1, 15] }
    ]
  });
  const p = run(plan, baseline(), { scope: 'household' });
  for (const r of p.rows) {
    assert.equal(r.incomeCents, null);
    assert.equal(r.netCents, null);
    assert.equal(r.cumulativeCents, null);
    assert.equal(r.unassignedCents, null);
    assert.equal(r.incomeKnownCents, 500000);
    assert.equal(r.incomeLowerBoundCents, 500000 + 265000);
  }
  assert.equal(p.summary.totalIncomeCents, null);
  assert.equal(p.summary.totalIncomeKnownCents, 12 * 500000);
  assert.equal(p.summary.endCumulativeCents, null);
  assert.equal(p.summary.lowest.month, null);
  assert.equal(p.summary.unknownNetMonths.length, 12);
  assert.equal(p.complete, false);
  // Joint scope of the same plan is fully known.
  const j = run(plan, baseline(), { scope: 'joint' });
  assert.equal(j.rows[0].incomeCents, 400000 + 265000);
  assert.notEqual(j.summary.endCumulativeCents, null);
});

/**
 * Two-earner plan with both take-home pays known: Alex as in simplePlan; Sam earns $3,000 net on
 * the 1st, all paid into Sam's personal account, and transfers $1,325 into joint on the 1st and
 * 15th. Household scope: Sam's personal spending = 3,000 − 2,650 = $350.
 */
function twoEarnerPlan() {
  return simplePlan({
    people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }],
    incomes: [
      simplePlan().incomes[0],
      { id: 'sam-pay', label: 'Sam paycheck', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: 300000, jointPerPaycheckCents: null, frequency: 'monthly', frequencyStatus: 'confirmed', monthlyDay: 1 },
      { id: 'sam-contrib', label: 'Sam contribution', personId: 'p2', kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: 132500, frequency: 'semimonthly', frequencyStatus: 'observed', semimonthlyDays: [1, 15] }
    ]
  });
}

/** Sam's transfer to joint becomes unknown May–Jul 2027 (parental leave). */
const leave = () => scenario([{ id: 'leave', type: 'income_change', label: 'Sam parental leave', streamId: 'sam-contrib', startMonth: '2027-05', endMonth: '2027-07', jointPerPaycheckCents: null }]);

test('household scope: an unknown transfer to joint makes net and cumulative unknown instead of looking better', () => {
  const plan = deepFreeze(twoEarnerPlan());
  const sc = deepFreeze(leave());
  const base = run(plan, baseline(), { scope: 'household' });
  const p = run(plan, sc, { scope: 'household' });
  // Before the leave both agree.
  for (const m of ['2026-10', '2026-11', '2027-04']) {
    assert.equal(row(p, m).netCents, row(base, m).netCents);
    assert.equal(row(p, m).cumulativeCents, row(base, m).cumulativeCents);
  }
  assert.equal(row(base, '2027-05').netCents, 800000 - 160000 - 60000 - 100000 - 35000);
  for (const m of ['2027-05', '2027-06', '2027-07']) {
    const r = row(p, m);
    assert.equal(r.incomeCents, 800000, 'take-home pay is still known');
    assert.equal(r.netCents, null);
    assert.equal(r.unassignedCents, null);
    assert.equal(r.netUnknownReason, 'personal_spending');
  }
  // Cumulative stays unknown from the first unknown month on, as for unknown income.
  for (const r of p.rows.filter(x => x.month >= '2027-05')) assert.equal(r.cumulativeCents, null);
  assert.equal(row(p, '2027-08').netCents, row(base, '2027-08').netCents);
  assert.equal(row(p, '2027-08').netUnknownReason, null);
  assert.equal(p.summary.endCumulativeCents, null);
  assert.deepEqual(p.summary.unknownNetMonths, ['2027-05', '2027-06', '2027-07']);
  assert.equal(p.complete, false);
  const m = p.missing.find(x => /personal spending/.test(x.label));
  assert.deepEqual(m, { label: "Sam parental leave: Sam's personal spending can't be worked out while their transfer to joint is unknown", source: 'event', id: 'leave' });
  assert.equal(base.complete, true);
  assert.equal(base.rows[0].netUnknownReason, null);
});

test('joint scope: an unknown transfer to joint makes joint income unknown (unchanged)', () => {
  const plan = deepFreeze(twoEarnerPlan());
  const p = run(plan, deepFreeze(leave()), { scope: 'joint' });
  const r = row(p, '2027-06');
  assert.equal(r.incomeCents, null);
  assert.equal(r.incomeKnownCents, 400000);
  assert.equal(r.netCents, null);
  assert.equal(r.netUnknownReason, 'income');
  assert.equal(row(p, '2026-12').incomeCents, 400000 + 265000);
  assert.ok(p.missing.some(x => x.source === 'event' && x.id === 'leave' && /amount reaching the joint account is not entered/.test(x.label)));
  assert.ok(!p.missing.some(x => /personal spending/.test(x.label)));
});

test('contribution streams with an unconfirmed schedule are described in transfers', () => {
  const plan = twoEarnerPlan();
  plan.incomes[2] = Object.assign({}, plan.incomes[2], { frequency: 'unknown', frequencyStatus: 'observed' });
  const p = run(deepFreeze(plan), baseline());
  assert.ok(p.assumptions.includes('Transfer schedule not confirmed: assuming 2 transfers a month for Sam contribution.'), p.assumptions.join('\n'));
  assert.ok(!p.assumptions.some(a => /paychecks a month for Sam contribution/.test(a)));
  assert.equal(p.rows[0].incomeLines.find(l => l.id === 'sam-contrib').assumption, 'Transfer schedule not confirmed: assuming 2 transfers a month for Sam contribution.');
});

test('unknown pay frequency appears as a readable assumption', () => {
  const plan = simplePlan();
  plan.incomes = [Object.assign({}, plan.incomes[0], { frequency: 'unknown', frequencyStatus: 'unknown', netPerPaycheckCents: 250000, jointPerPaycheckCents: 200000 })];
  const p = run(plan, baseline());
  assert.equal(p.rows[0].incomeCents, 400000);
  assert.ok(p.assumptions.includes('Pay frequency not confirmed: assuming 2 paychecks a month for Alex paycheck.'));
});

// ------------------------------------------------------------------ growth

test('growth rates default to 0', () => {
  const p = run(simplePlan(), baseline(), { months: 24 });
  assert.equal(p.rows[0].spendingCents, p.rows[23].spendingCents);
  assert.equal(p.rows[0].billsCents, p.rows[23].billsCents);
  assert.equal(p.rows[0].incomeCents, p.rows[23].incomeCents);
  assert.ok(p.assumptions.includes('No cost or income growth is assumed (0% a year).'));
});

test('cost growth steps yearly and leaves fixed loan/housing payments alone; income growth applies to pay', () => {
  const p = run(simplePlan(), baseline({ costGrowthPct: 10, incomeGrowthPct: 5 }), { months: 13 });
  assert.equal(p.rows[11].spendingCents, 60000);
  assert.equal(p.rows[12].spendingCents, 66000);
  assert.equal(p.rows[12].billsCents, 150000 + 11000);
  assert.equal(p.rows[12].incomeCents, 420000);
  assert.ok(p.assumptions.some(a => /Costs grow 10% a year/.test(a)));
});

// ------------------------------------------------------------------ compare

test('compare: one column per scenario and aligned summary rows with deltas', () => {
  const plan = simplePlan();
  const repair = scenario([{ id: 'ev-repair', type: 'one_time', label: 'Repair', month: '2026-12', amountCents: 50000, direction: 'expense' }]);
  const c = F.compare(plan, [baseline(), repair], { startMonth: START, months: 12, scope: 'joint' });
  assert.deepEqual(c.columns.map(col => col.scenarioId), ['baseline', 'sc-1']);
  assert.deepEqual(c.columns.map(col => col.name), ['Current plan', 'Test scenario']);
  const end = c.rows.find(r => r.key === 'endCumulative');
  assert.deepEqual(end.values, [12 * NET, 12 * NET - 50000]);
  assert.deepEqual(end.deltas, [null, -50000]);
  assert.match(end.label, /Sep 2027/);
  for (const r of c.rows) assert.equal(r.values.length, 2);
  assert.deepEqual(c.rows.find(r => r.key === 'missing').values, [0, 0]);
  assert.throws(() => F.compare(plan, [], { startMonth: START, months: 12 }), E.ValidationError);
});

// ------------------------------------------------------------------ isolation & validation

test('project does not mutate deep-frozen plan or scenario', () => {
  const plan = simplePlan({ savings: [trip(), { id: 'cushion', label: 'Cushion', targetCents: 50000, savedCents: null, monthlyCents: 10000, spendAtTarget: false }], balances: { jointCashCents: 200000, asOf: null } });
  const sc = scenario([
    { id: 'e1', type: 'one_time', label: 'Trip extra', month: '2027-04', amountCents: 30000, direction: 'expense', goalId: 'trip' },
    { id: 'e2', type: 'income_change', label: 'Raise', streamId: 'alex-pay', startMonth: '2027-01', endMonth: null, netPerPaycheckCents: 520000 },
    { id: 'e3', type: 'bill_change', label: 'Phone', billId: 'phone', startMonth: '2027-01', endMonth: null, monthlyCents: 0 },
    { id: 'e4', type: 'target_change', label: 'Food', category: 'Groceries', startMonth: '2027-01', endMonth: null, monthlyCents: 65000 },
    { id: 'e5', type: 'goal', label: 'Baby', goal: { id: 'baby', label: 'Baby', targetCents: 100000, savedCents: 0, monthlyCents: 10000, spendAtTarget: true, targetMonth: '2027-05' } },
    { id: 'e6', type: 'recurring', label: 'Care', startMonth: '2027-06', endMonth: null, monthlyCents: 50000, direction: 'expense' }
  ], { costGrowthPct: 3, incomeGrowthPct: 2, annualReturnPct: 1 });
  const before = JSON.stringify({ plan, sc });
  deepFreeze(plan);
  deepFreeze(sc);
  const p1 = F.project(plan, sc, { startMonth: START, months: 24, scope: 'household' });
  const p2 = F.project(plan, sc, { startMonth: START, months: 24, scope: 'household' });
  assert.equal(JSON.stringify({ plan, sc }), before);
  assert.deepEqual(p1, p2); // repeatable: no hidden state carried between runs
  F.compare(plan, [sc, baseline()], { startMonth: START, months: 12 });
  assert.equal(JSON.stringify({ plan, sc }), before);
});

test('scenarios are isolated: projecting one does not change another', () => {
  const plan = simplePlan({ savings: [trip()] });
  const fresh = run(plan, baseline());
  run(plan, scenario([{ id: 'x', type: 'one_time', label: 'Draw', month: '2026-11', amountCents: 100000, direction: 'expense', goalId: 'trip' }]));
  assert.deepEqual(run(plan, baseline()), fresh);
});

test('invalid inputs throw ValidationError', () => {
  const plan = simplePlan();
  const bad = [
    { startMonth: '2026-13', months: 12 },
    { startMonth: null, months: 12 },
    { startMonth: START, months: 0 },
    { startMonth: START, months: 121 },
    { startMonth: START, months: 1.5 },
    { startMonth: START, months: '12' },
    { startMonth: START, months: 12, scope: 'everyone' },
    { startMonth: START, months: 12, now: 'soon' }
  ];
  for (const opts of bad) assert.throws(() => F.project(plan, baseline(), opts), E.ValidationError, JSON.stringify(opts));
  assert.throws(() => F.project(plan, baseline({ incomeTiming: 'weekly' }), { startMonth: START, months: 12 }), E.ValidationError);
  assert.throws(() => F.project(plan, baseline({ costGrowthPct: 'lots' }), { startMonth: START, months: 12 }), E.ValidationError);
  assert.throws(() => F.project(null, baseline(), { startMonth: START, months: 12 }), E.ValidationError);
  assert.throws(() => F.project(plan, 'baseline', { startMonth: START, months: 12 }), E.ValidationError);
  assert.equal(F.project(plan, baseline(), { startMonth: START, months: 1 }).rows.length, 1);
  assert.equal(F.project(plan, baseline(), { startMonth: START, months: 120 }).rows.length, 120);
});

test('events of unknown type or pointing at missing plan items are ignored with a note', () => {
  const evs = [
    { id: 'a', type: 'lottery', label: 'Lottery win' },
    { id: 'b', type: 'bill_change', label: 'Gym', billId: 'gym', startMonth: '2027-01', endMonth: null, monthlyCents: 0 },
    { id: 'c', type: 'income_change', label: 'Bonus', streamId: 'nobody', startMonth: '2027-01', endMonth: null, netPerPaycheckCents: 1 }
  ];
  const p = run(simplePlan(), scenario(evs));
  assert.equal(p.summary.endCumulativeCents, 12 * NET);
  assert.ok(p.assumptions.some(a => /Lottery win" has an unknown type/.test(a)));
  assert.ok(p.assumptions.some(a => /Gym" refers to a bill that is not in the plan/.test(a)));
  assert.ok(p.assumptions.some(a => /Bonus" refers to an income that is not in the plan/.test(a)));
});

test('assumptions are complete and readable', () => {
  const plan = simplePlan({ savings: [trip()] });
  const p = run(plan, baseline());
  const text = p.assumptions.join('\n');
  assert.match(text, /typical month/);
  assert.match(text, /Joint accounts only/);
  assert.match(text, /Bills continue/);
  assert.match(text, /No cost or income growth/);
  assert.match(text, /No interest or investment return/);
  assert.match(text, /Joint cash balance not entered/);
  assert.match(text, /not subtracted from cash a second time/);
  assert.ok(p.assumptions.every(a => typeof a === 'string' && a.length > 10));
  assert.equal(new Set(p.assumptions).size, p.assumptions.length);
});

test('balance dated inside the forecast applies from the following month (no double counting)', () => {
  const E2 = E;
  const plan = E2.util.clone(basePlanForBalance());
  plan.balances = { jointCashCents: 150000, asOf: '2026-09-30', note: '' };
  const scenario = { id: 'baseline', name: 'Base', events: [], assumptions: { incomeTiming: 'conservative', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 } };
  const p = E2.forecast.project(plan, scenario, { startMonth: '2026-08', months: 4, scope: 'joint' });
  const byMonth = Object.fromEntries(p.rows.map(r => [r.month, r]));
  assert.equal(byMonth['2026-08'].balanceCents, null);
  assert.equal(byMonth['2026-09'].balanceCents, null);
  assert.equal(byMonth['2026-10'].balanceCents, 150000 + byMonth['2026-10'].netCents);
  assert.equal(byMonth['2026-11'].balanceCents, 150000 + byMonth['2026-10'].netCents + byMonth['2026-11'].netCents);
  assert.ok(p.assumptions.some(a => /balances start in Oct 2026/.test(a)));
  // Without a date, the balance is today's and applies from the first month.
  plan.balances.asOf = null;
  const q = E2.forecast.project(plan, scenario, { startMonth: '2026-08', months: 2, scope: 'joint' });
  assert.equal(q.rows[0].balanceCents, 150000 + q.rows[0].netCents);
});

function basePlanForBalance() {
  return {
    people: [{ id: 'p1', name: 'Partner A' }, { id: 'p2', name: 'Partner B' }],
    incomes: [{ id: 'pa', label: 'Pay', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 200000, jointPerPaycheckCents: 200000, frequency: 'semimonthly', frequencyStatus: 'confirmed', anchorDate: null, semimonthlyDays: [15, 31], monthlyDay: 1, assumedPerMonthIfUnknown: 2, status: 'confirmed', startMonth: null, endMonth: null, note: '' }],
    bills: [{ id: 'rent', label: 'Housing', category: 'Mortgage', monthlyCents: 150000, fundedFrom: 'joint', type: 'housing', debtId: null, status: 'existing', startMonth: null, endMonth: null, note: '' }],
    debts: [], targets: { Groceries: 60000 }, savings: [], personalSpending: [],
    balances: { jointCashCents: null, asOf: null, note: '' },
    settings: { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 },
  };
}

test('summary.lowestBalance only considers months with a known balance', () => {
  const plan = basePlanForBalance();
  plan.balances = { jointCashCents: 50000, asOf: '2026-10-31', note: '' };
  plan.targets = { Groceries: 60000 };
  const scenario = { id: 'baseline', name: 'Base', events: [{ id: 'big', type: 'one_time', label: 'Repair', month: '2026-12', amountCents: 300000, direction: 'expense', category: 'Home maintenance & repairs', goalId: null, note: '' }], assumptions: { incomeTiming: 'conservative', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 } };
  const p = E.forecast.project(plan, scenario, { startMonth: '2026-10', months: 4, scope: 'joint' });
  assert.equal(p.rows[0].balanceCents, null, 'October is before the balance applies');
  assert.equal(p.summary.lowestBalance.month, '2026-12');
  assert.equal(p.summary.lowestBalance.balanceCents, p.rows[2].balanceCents);
  const cmp = E.forecast.compare(plan, [scenario], { startMonth: '2026-10', months: 4, scope: 'joint' });
  assert.ok(cmp.rows.some(r => r.key === 'lowestBalance'));
});

test('household: an unknown transfer during leave makes outflow unknown, never smaller than the baseline', () => {
  const profile = require('../../fixtures/sample-profile.json');
  const st = E.state.defaults(profile, null);
  const plan = E.util.clone(st.plan);
  const pay = plan.incomes.find(i => i.personId === 'p2' && i.kind === 'paycheck');
  Object.assign(pay, { netPerPaycheckCents: 200000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2026-10-09' });
  const baseline = st.scenarios[0];
  const baby = st.scenarios.find(s => s.events.some(e => e.type === 'income_change'));
  const opts = { startMonth: '2026-10', months: 12, scope: 'household' };
  const b = E.forecast.project(plan, baseline, opts);
  const k = E.forecast.project(plan, baby, opts);
  assert.equal(k.summary.totalOutCents, null, 'unknown months make the total unknown');
  assert.ok(k.summary.totalOutKnownCents !== undefined);
  const cmp = E.forecast.compare(plan, [baseline, baby], opts);
  const out = cmp.rows.find(r => r.key === 'totalOut');
  assert.equal(out.values[1], null);
  assert.ok(out.deltas[1] === null, 'no saving can come from an unknown');
});
