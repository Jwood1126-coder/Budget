'use strict';
// Tests for the Budget view's pure helpers (src/ui/views/budget/common.js: BudgetUI._budget):
// where each dollar goes, the month's pace, spent against planned, what is coming up, a goal's
// progress and the sparkline. The UI files are plain IIFEs that attach to globalThis, so they load
// in node after the engine core. All names and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadEngine, SRC } = require('../load-engine.cjs');

loadEngine({ only: ['core.js'] });
require(path.join(SRC, 'ui/core.js'));
require(path.join(SRC, 'ui/components.js'));
require(path.join(SRC, 'ui/views/budget/common.js'));
const B = globalThis.BudgetUI._budget;

const PEOPLE = [{ id: 'p1', name: 'Rowan' }, { id: 'p2', name: 'Quinn' }];
const summary = (extra = {}) => Object.assign({
  month: '2026-10', inCents: 600000, inByPerson: { p1: 350000, p2: 240000, other: 10000 },
  outByGroup: { essentials: 250000, flexible: 120000, irregular: 15000, other: 5000 },
  outCents: 390000, savingsCents: 50000, investingCents: 0, leftCents: 160000,
}, extra);
const sum = list => list.reduce((s, x) => s + x.cents, 0);
const keys = list => list.map(x => x.key);

test('dollarFlow: money in by person, money out by group, savings and left over; both sides balance', () => {
  const f = B.dollarFlow(summary(), PEOPLE);
  assert.deepEqual(keys(f.inSide), ['p1', 'p2', 'other']);
  assert.deepEqual(keys(f.outSide), ['essentials', 'flexible', 'irregular', 'other', 'savings', 'left']);
  assert.equal(f.outSide.find(x => x.key === 'other').label, 'Debt & business');
  assert.equal(f.inSide[0].label, 'Rowan');
  assert.equal(sum(f.inSide), sum(f.outSide));
  assert.equal(f.totalCents, 600000);
  assert.equal(f.outSide.find(x => x.key === 'left').cents, 160000, 'left over is in − out − savings');
  assert.equal(f.netCents, 210000, 'the headline is in − out: what the cash accounts move by');
  assert.equal(f.toSavingsCents, 50000);
  assert.equal(f.fromSavingsCents, 0);
  assert.ok(Math.abs(f.inSide.reduce((s, x) => s + x.share, 0) - 1) < 1e-9, 'shares add up to the bar');
});

test('dollarFlow: savings drawn down is "From savings" on the in side, never an out segment', () => {
  // The plan takes $300 a month out of savings: checking keeps in − out + 300.
  const f = B.dollarFlow(summary({ savingsCents: -30000, leftCents: 240000 }), PEOPLE);
  assert.ok(!f.outSide.some(x => x.key === 'savings'));
  const draw = f.inSide.find(x => x.key === 'fromSavings');
  assert.deepEqual([draw.label, draw.cents, draw.draw], ['From savings', 30000, true]);
  assert.equal(sum(f.inSide), sum(f.outSide));
  assert.equal(f.outSide.find(x => x.key === 'left').cents, 240000);
  assert.equal(f.netCents, 210000, 'the headline does not count the draw as money gained');
  assert.equal(f.fromSavingsCents, 30000);
  assert.equal(f.toSavingsCents, 0);
});

test('dollarFlow: investing out, money back from investments in; a short month shows "Short by" on the in side', () => {
  let f = B.dollarFlow(summary({ investingCents: 20000, outCents: 410000, leftCents: 140000 }), PEOPLE);
  assert.ok(f.outSide.some(x => x.key === 'investing' && x.cents === 20000));
  assert.equal(f.outSide.find(x => x.key === 'left').cents, 140000);
  assert.equal(f.netCents, 190000);
  f = B.dollarFlow(summary({ investingCents: -20000, outCents: 370000, leftCents: 180000 }), PEOPLE);
  assert.ok(f.inSide.some(x => x.key === 'fromInvesting' && x.cents === 20000 && x.draw));
  assert.equal(sum(f.inSide), sum(f.outSide));
  // Out (390,000) + savings (50,000) beyond in (400,000): short by 40,000.
  f = B.dollarFlow(summary({ inCents: 400000, inByPerson: { p1: 250000, p2: 150000 }, leftCents: -40000 }), PEOPLE);
  const short = f.inSide.find(x => x.key === 'short');
  assert.deepEqual([short.label, short.cents, short.warn], ['Short by', 40000, true]);
  assert.ok(!f.outSide.some(x => x.key === 'left'));
  assert.equal(f.short, true);
  assert.equal(sum(f.inSide), sum(f.outSide));
  assert.equal(f.netCents, 10000, 'in − out is still positive: the shortfall is what savings take');
});

test('dollarFlow: zero amounts are left out; no summary, no flow', () => {
  const f = B.dollarFlow(summary({ inByPerson: { p1: 600000, p2: 0, other: 0 }, outByGroup: { essentials: 250000, flexible: 120000, irregular: 0, other: 20000 } }), PEOPLE);
  assert.deepEqual(keys(f.inSide), ['p1']);
  assert.deepEqual(keys(f.outSide), ['essentials', 'flexible', 'other', 'savings', 'left']);
  assert.equal(B.dollarFlow(null, PEOPLE), null);
  assert.equal(B.dollarFlow({ month: '2026-10', inCents: null }, PEOPLE), null);
});

test('paceOf: covered days over the days of the month, clamped', () => {
  assert.equal(B.paceOf(12, 31), 12 / 31);
  assert.equal(B.paceOf(40, 30), 1);
  assert.equal(B.paceOf(null, 30), null);
  assert.equal(B.paceOf(5, 0), null);
});

test('progressOf: over, ahead of the month, within the plan, and no plan', () => {
  let p = B.progressOf(30000, 60000, null);
  assert.deepEqual([p.status, p.fillPct, p.leftCents, p.overCents], ['ok', 50, 30000, 0]);
  p = B.progressOf(66000, 60000, null);
  assert.deepEqual([p.status, p.overCents, p.fillPct], ['over', 6000, 100]);
  assert.ok(Math.abs(p.overPct - 10) < 1e-9);
  // A third of the month gone, two thirds of the plan spent: ahead of pace.
  assert.equal(B.progressOf(40000, 60000, 1 / 3).status, 'ahead');
  assert.equal(B.progressOf(22000, 60000, 1 / 3).status, 'ok', 'about on pace');
  assert.equal(B.progressOf(4000, 3000, 0.1).status, 'over', 'over wins over ahead');
  assert.equal(B.progressOf(1300, 2000, 0.2).status, 'ok', 'less than $10 beyond the pace is not ahead');
  assert.equal(B.progressOf(1500, 2000, 0.2).status, 'ahead');
  p = B.progressOf(2500, 0, null);
  assert.deepEqual([p.status, p.overCents], ['over', 2500], 'spending against a plan of $0');
  assert.equal(B.progressOf(0, 0, null).status, 'ok');
  assert.equal(B.progressOf(null, 5000, 0.5).status, 'none', 'nothing recorded yet');
});

test('upcoming: changes from the plan month on, in month order, goal reach markers included, at most the limit', () => {
  const changes = [
    { id: 'a', label: 'Childcare', kind: 'monthly', group: 'essentials', startMonth: '2027-02', cents: 120000, status: 'notAccepted', source: 'plan' },
    { id: 'b', label: 'Old raise', kind: 'monthly', group: 'income', startMonth: '2026-05', cents: 20000, status: 'applied', source: 'plan' },
    { id: 'c', label: 'Insurance', kind: 'monthly', group: 'essentials', startMonth: '2026-10', cents: 4000, status: 'applied', source: 'bill' },
    { id: 'd', label: 'Far away', kind: 'oneTime', group: 'irregular', startMonth: '2031-01', cents: 9000, status: 'outside', source: 'plan' },
    { id: 'e', label: 'Leave', kind: 'monthly', group: 'income', startMonth: '2027-02', cents: null, status: 'unset', source: 'plan', endMonth: '2027-05' },
  ];
  const markers = [{ kind: 'goal', id: 'g1', month: '2027-01', label: 'Cushion reached', cents: 500000 }];
  const list = B.upcoming(changes, markers, '2026-10', 6);
  assert.deepEqual(list.map(x => x.id), ['c', 'reach-g1', 'a', 'e']);
  assert.equal(list[3].cents, null, 'an unknown amount stays unknown');
  assert.equal(list[3].endMonth, '2027-05');
  assert.equal(list[1].kind, 'goal');
  assert.deepEqual(B.upcoming(changes, markers, '2026-10', 2).map(x => x.id), ['c', 'reach-g1']);
  assert.deepEqual(B.upcoming(null, null, '2026-10'), []);
});

test('goalView: progress from saved and target, and where the plan gets the goal', () => {
  let v = B.goalView({ targetCents: 200000, savedCents: 50000, reachMonth: '2027-04' });
  assert.deepEqual([v.progress, v.reach, v.month], [0.25, 'month', '2027-04']);
  v = B.goalView({ targetCents: 200000, savedCents: null, reachMonth: null });
  assert.deepEqual([v.progress, v.reach, v.saved], [null, 'beyond', null], 'saved unknown: no progress, never 0%');
  assert.equal(B.goalView({ targetCents: 200000, savedCents: 250000, reachMonth: null }).reach, 'reached');
  assert.equal(B.goalView({ targetCents: 200000, savedCents: 0, already: true }).reach, 'reached');
  assert.equal(B.goalView({ targetCents: null, savedCents: 1000, monthlyCents: 5000 }).reach, 'noTarget');
  assert.equal(B.goalView({ targetCents: 200000, savedCents: 250000 }).progress, 1, 'capped at full');
});

test('sparkPath: known values as a line, unknown ones as gaps, the projected part apart; too few values: null', () => {
  const s = B.sparkPath([100, 200, null, 300, 400, 500], 100, 20, 4);
  assert.match(s.d, /^M2 18L/, 'starts at the lowest value at the bottom left');
  assert.equal((s.d.match(/M/g) || []).length, 2, 'a gap starts a new line');
  assert.match(s.dProjected, /^M/);
  assert.deepEqual([s.min, s.max], [100, 500]);
  assert.deepEqual(s.last, { x: 98, y: 2 });
  assert.deepEqual(s.dots, [], 'every known value here has a neighbour');
  const lonely = B.sparkPath([100, null, 200, 300], 100, 20, null);
  assert.equal(lonely.dots.length, 1, 'a value with no known neighbour is a dot');
  assert.equal(lonely.dProjected, '');
  assert.equal(B.sparkPath([100, null], 100, 20), null);
});
