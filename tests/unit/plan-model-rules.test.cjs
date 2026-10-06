'use strict';
// The three plan-model rules behind tests/unit/review-model-regressions.test.cjs, one at a time:
// imported category names resolve to the taxonomy, an aggregate budget counts once for its
// members, and current debt bills the history holds are not diluted by its average. Every name,
// amount and date here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');
const E = loadEngine();
const C = E.categories;
const T = E.timeline;

const ENERGY = 'Energy (gas + electric, migrated)';

/** A year of invented card-free checking history (2031), one charge per category per month. */
function dataset(monthly, extra = []) {
  const transactions = [];
  let seq = 0;
  for (let i = 1; i <= 12; i++) {
    const month = '2031-' + String(i).padStart(2, '0');
    for (const [category, dollars, merchant] of monthly) {
      transactions.push({ id: 'syn-' + (++seq), accountId: 'checking', date: month + '-14', amountCents: -100 * dollars, kind: 'spend', category, merchant: merchant || category + ' Co', description: merchant || category });
    }
    for (const x of extra) if (x.months.includes(i)) transactions.push({ id: 'syn-' + (++seq), accountId: 'checking', date: month + '-20', amountCents: -100 * x.dollars, kind: x.kind, category: x.category, merchant: x.merchant, description: x.merchant });
  }
  return E.ledger.normalizeDataset({ schemaVersion: 2, datasetId: 'plan-model-rules', isSynthetic: true,
    accounts: [{ id: 'checking', label: 'Invented checking', type: 'checking', scope: 'joint', coverage: [{ start: '2031-01-01', end: '2031-12-31' }] }], transactions });
}
function planOf(fields = {}) {
  return Object.assign({ people: [{ id: 'p1', name: 'Wren' }, { id: 'p2', name: 'Tamsin' }], incomes: [], bills: [], debts: [], targets: {}, savings: [], personalSpending: [],
    balances: { jointCashCents: null, asOf: null, accounts: {}, accountsAsOf: null, accountDates: {} } }, fields);
}
function build(ds, plan, settings = {}) {
  return T.build({ txns: E.ledger.applyEdits(ds, {}), dataset: ds, plan, settings: Object.assign({ baselineMonths: 12 }, settings), today: '2032-01-05' });
}
const rowsOf = (tl, key) => tl.dialsByKey[key].drill.rows;
const catRow = (tl, key, category) => rowsOf(tl, key).find(r => r.level === 1 && r.category === category) || null;
const energyHistory = [['Natural gas', 100, 'Invented Gas Utility'], ['Electricity', 50, 'Invented Power Co']];

// ------------------------------------------------------------------ imported names resolve to the taxonomy

test('categories.resolve: taxonomy names, the same words, the earlier version’s labels and keyword families; nothing guessed otherwise', () => {
  assert.equal(C.resolve('Groceries'), 'Groceries');
  assert.equal(C.resolve('  gas AND heating '), 'Gas & heating');
  assert.equal(C.resolve('Natural gas'), 'Gas & heating');
  assert.equal(C.resolve('Electricity'), 'Electric');
  assert.equal(C.resolve('Groceries & meal kits'), 'Groceries');
  assert.equal(C.resolve('Fuel & charging'), 'Fuel');
  assert.equal(C.resolve('Municipal payments'), 'Water & sewer');
  assert.equal(C.resolve('Vehicle care & registration'), 'Auto maintenance');
  // Keyword families: whole words only, the first family in order.
  assert.equal(C.resolve('Electric bill'), 'Electric');
  assert.equal(C.resolve('Car insurance'), 'Auto insurance');
  assert.equal(C.resolve('Pet insurance'), 'Other insurance');
  assert.equal(C.resolve('Child care'), 'Baby & childcare');
  assert.equal(C.resolve('Gas & fuel'), 'Fuel');
  assert.equal(C.resolve('Rental car'), null, 'not the word "rent"');
  // Ambiguous, unknown or not one category: null.
  assert.equal(C.resolve('Gas'), null);
  assert.equal(C.resolve('Restaurants'), null);
  assert.equal(C.resolve(ENERGY), null);
  assert.equal(C.resolve(''), null);
  assert.equal(C.resolve(null), null);
  // Every alias names a real taxonomy category.
  for (const name of Object.values(C.ALIASES)) assert.ok(C.find(name), name);
});

test('categories: essential, seasonal and group follow the category a name resolves to; an aggregate follows its members', () => {
  for (const name of ['Natural gas', 'Electricity', 'Groceries & meal kits', 'Fuel & charging', 'Water bill', 'Dentist']) assert.equal(C.isEssential(name), true, name);
  for (const name of ['Dining & drinks', 'Restaurants', 'Gas', 'Uncategorized / review']) assert.equal(C.isEssential(name), false, name);
  assert.equal(C.isEssential('Debt payment'), true);
  assert.equal(C.isSeasonal('Natural gas'), true);
  assert.equal(C.isSeasonal('Groceries & meal kits'), false);
  assert.equal(C.groupOf('Electricity'), 'Utilities');
  assert.equal(C.groupOf('Restaurants'), 'Other');
  assert.deepEqual(C.membersOf(ENERGY), ['Gas & heating', 'Electric']);
  assert.equal(C.membersOf('Electric'), null);
  assert.equal(C.isEssential(ENERGY), true);
  assert.equal(C.isSeasonal(ENERGY), true);
  assert.equal(C.groupOf(ENERGY), 'Utilities');
  // The migration writes the same name, and replaces the same categories' targets.
  assert.equal(E.state.ENERGY_TARGET, ENERGY);
});

test('plan: imported essentials are planned as essentials; the household’s own group still wins', () => {
  const ds = dataset([['Natural gas', 100], ['Groceries & meal kits', 200], ['Fuel & charging', 60], ['Dining & drinks', 40]]);
  const tl = build(ds, planOf());
  for (const c of ['Natural gas', 'Groceries & meal kits', 'Fuel & charging']) {
    assert.equal(catRow(tl, 'essentials', c).groupSource, 'taxonomy', c);
    assert.equal(catRow(tl, 'flexible', c), null, c);
  }
  assert.ok(catRow(tl, 'flexible', 'Dining & drinks'));
  const moved = build(ds, planOf(), { groups: { 'Groceries & meal kits': 'flexible' } });
  assert.equal(catRow(moved, 'flexible', 'Groceries & meal kits').groupSource, 'override');
});

test('plan: a change saved while an imported category was planned in the other group still applies, and the screen upgrade moves it', () => {
  const ds = dataset([['Natural gas', 100], ['Electricity', 50]]);
  const first = build(ds, planOf());
  const row = catRow(first, 'essentials', 'Electricity');
  const kid = rowsOf(first, 'essentials').find(r => r.parent === row.id);
  const flexId = id => 'flexible' + id.slice('essentials'.length);
  let st = E.state.defaults({ isSynthetic: true, household: { name: 'Invented' }, plan: planOf() }, ds);
  st = E.state.setPath(st, 'ui.plan.rows.' + flexId(kid.id), { cents: 6500 });
  const tl = build(ds, st.plan, st.ui.plan);
  const now = rowsOf(tl, 'essentials').find(r => r.id === kid.id);
  assert.equal(now.planCents, 6500, 'the saved amount still applies');
  assert.equal(now.legacyId, flexId(kid.id));
  assert.deepEqual(tl.migration.rows, [{ from: flexId(kid.id), to: kid.id }]);
  const up = T.pendingUpgrade(tl);
  assert.deepEqual(up.steps, ['migrateRows']);
  const after = up.apply(st);
  assert.deepEqual(after.ui.plan.rows, { [kid.id]: { cents: 6500 } }, 'moved, not lost');
  assert.equal(T.pendingUpgrade(build(ds, after.plan, after.ui.plan)), null, 'nothing left to move');
  assert.match(after.meta.migrationNotes.join(' '), /moved with its category/);
});

// ------------------------------------------------------------------ an aggregate budget counts once

test('aggregate budget: its members keep their rows and history but plan at $0; the budget counts once', () => {
  const ds = dataset(energyHistory.concat([['Groceries', 200]]));
  const plan = planOf({ targets: { [ENERGY]: 15000 } });
  const tl = build(ds, plan);
  const gas = catRow(tl, 'essentials', 'Natural gas'), power = catRow(tl, 'essentials', 'Electricity'), energy = catRow(tl, 'essentials', ENERGY);
  assert.deepEqual([gas.source, gas.aggregate, gas.planCents, gas.defaultCents, gas.avgCents], ['aggregate', ENERGY, 0, 10000, 10000]);
  assert.deepEqual([power.source, power.planCents, power.defaultCents], ['aggregate', 0, 5000]);
  assert.deepEqual([energy.source, energy.budgetCents, energy.planCents, energy.history, energy.aggregate], ['budget', 15000, 15000, false, null]);
  assert.deepEqual([energy.covers, gas.covers], [['Electricity', 'Natural gas'], []], 'the Budget month spends the members against it');
  assert.equal(catRow(tl, 'flexible', ENERGY), null, 'planned with its members, as essentials');
  const d = tl.dialsByKey.essentials;
  assert.equal(d.baselineCents, 15000 + 20000);
  assert.equal(d.drill.rowsCents, 15000 + 20000);
  assert.deepEqual(plan.targets, { [ENERGY]: 15000 }, 'the saved budget is untouched');
  // No budget for the aggregate (null: not set): the members plan from their history.
  const none = build(ds, planOf({ targets: { [ENERGY]: null } }));
  assert.deepEqual([catRow(none, 'essentials', 'Natural gas').source, catRow(none, 'essentials', 'Natural gas').planCents], ['history', 10000]);
});

test('aggregate budget: changes to its members move it by exactly what they change', () => {
  const ds = dataset(energyHistory);
  const plan = planOf({ targets: { [ENERGY]: 15000 } });
  const tl = build(ds, plan);
  const gas = catRow(tl, 'essentials', 'Natural gas');
  const place = rowsOf(tl, 'essentials').find(r => r.parent === gas.id);
  const total = t => rowsOf(t, 'essentials').filter(r => r.level === 1 && r.included).reduce((s, r) => s + r.planCents, 0);
  // A place under a member given an amount: the aggregate moves by the difference.
  const set = build(ds, plan, { rows: { [place.id]: { cents: 12000 } } });
  assert.equal(catRow(set, 'essentials', ENERGY).planCents, 17000);
  assert.equal(catRow(set, 'essentials', 'Natural gas').planCents, 0);
  assert.equal(total(set), 17000);
  // A member left out: its history comes out of the aggregate.
  const out = build(ds, plan, { rows: { [gas.id]: { included: false } } });
  assert.equal(catRow(out, 'essentials', ENERGY).planCents, 5000);
  assert.equal(total(out), 5000);
  // A member given an amount of its own (a negative one stays a row change): planned at it, its history out of the aggregate.
  const own = build(ds, plan, { rows: { [gas.id]: { cents: -1000 } } });
  assert.deepEqual([catRow(own, 'essentials', 'Natural gas').source, catRow(own, 'essentials', 'Natural gas').planCents], ['set', -1000]);
  assert.equal(catRow(own, 'essentials', ENERGY).planCents, 5000);
  // The baseline (no change on this screen) stays the budget.
  for (const t of [set, out, own]) assert.equal(t.dialsByKey.essentials.baselineCents, 15000);
});

test('aggregate budget: members planned elsewhere take their share out of it (their own budget, or their history in the other group)', () => {
  const ds = dataset(energyHistory);
  // The plan screen writes a member's amount as that category's budget: carved out of the aggregate.
  const split = build(ds, planOf({ targets: { [ENERGY]: 15000, 'Natural gas': 11000 } }));
  assert.deepEqual([catRow(split, 'essentials', 'Natural gas').source, catRow(split, 'essentials', 'Natural gas').planCents], ['budget', 11000]);
  assert.equal(catRow(split, 'essentials', 'Electricity').planCents, 0);
  assert.deepEqual([catRow(split, 'essentials', ENERGY).planCents, catRow(split, 'essentials', ENERGY).budgetMovedCents], [4000, 11000]);
  assert.deepEqual(catRow(split, 'essentials', ENERGY).covers, ['Electricity']);
  assert.equal(split.dialsByKey.essentials.baselineCents, 15000);
  // Both split off above the aggregate: never below $0.
  const over = build(ds, planOf({ targets: { [ENERGY]: 15000, 'Natural gas': 11000, 'Gas & heating': null, Electricity: 6000 } }));
  assert.equal(catRow(over, 'essentials', ENERGY).planCents, 0);
  // A member the household moved to the other group plans there from its history.
  const moved = build(ds, planOf({ targets: { [ENERGY]: 15000 } }), { groups: { Electricity: 'flexible' } });
  assert.deepEqual([catRow(moved, 'flexible', 'Electricity').source, catRow(moved, 'flexible', 'Electricity').planCents], ['history', 5000]);
  assert.equal(catRow(moved, 'essentials', ENERGY).planCents, 10000);
  assert.equal(moved.dialsByKey.essentials.baselineCents + moved.dialsByKey.flexible.baselineCents, 15000);
});

test('aggregate budget: a small member keeps a row of its own (never grouped into "Other")', () => {
  const ds = dataset([['Natural gas', 100], ['Electricity', 12], ['Water & sewer', 9], ['Trash & municipal', 8]]);
  const tl = build(ds, planOf({ targets: { [ENERGY]: 15000 } }));
  assert.equal(catRow(tl, 'essentials', 'Electricity').source, 'aggregate');
  assert.deepEqual(catRow(tl, 'essentials', 'Other').members, ['Water & sewer', 'Trash & municipal']);
  assert.equal(tl.dialsByKey.essentials.baselineCents, 15000 + 900 + 800);
});

// ------------------------------------------------------------------ current debt bills beat a diluted average

const installment = (fields = {}) => Object.assign({ id: 'loan', label: 'Invented installment', type: 'debt', category: null, fundedFrom: 'joint', monthlyCents: 8000, status: 'existing', startMonth: null, endMonth: null }, fields);
const paid = (months, dollars = 80, merchant = 'Invented Lender') => ({ months, dollars, kind: 'debt_payment', category: 'Debt payment', merchant });

test('debt: a current debt bill the history holds plans at its amount, not the window average', () => {
  const ds = dataset([['Groceries', 200]], [paid([10, 11, 12])]);
  const tl = build(ds, planOf({ bills: [installment()] }));
  const other = tl.dialsByKey.other;
  assert.equal(other.baselineCents, 8000);
  assert.match(other.basis, /current debt bills from Budget \(\$80\.00 a month, not the average of \$20\.00\)/);
  assert.deepEqual(tl.bills.map(b => b.status), ['seen'], 'still seen: not added a second time');
  assert.equal(tl.months.find(m => m.month === '2032-01').out.debt, 8000);
  assert.equal(tl.months.find(m => m.month === '2032-06').out.debt, 8000);
});

test('debt: a payment lowered on purpose plans at the current bill, keeping none of the older, higher history', () => {
  // Paid $120 a month all year; the bill now says $80 (refinanced). Not max($80, $120).
  const ds = dataset([['Groceries', 200]], [paid([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 120)]);
  const tl = build(ds, planOf({ bills: [installment()] }));
  const other = tl.dialsByKey.other;
  assert.equal(other.baselineCents, 8000);
  assert.equal(other.planCents, 8000);
  assert.deepEqual(other.debtCheck, { billsCents: 8000, averageCents: 12000 });
  assert.match(other.basis, /current debt bills from Budget \(\$80\.00 a month, not the average of \$120\.00\)\. Your history paid more toward debts than these bills/);
  assert.deepEqual(tl.bills.map(b => b.status), ['seen'], 'still seen: not added a second time');
  for (const m of ['2032-01', '2032-06', '2032-12']) assert.equal(tl.months.find(x => x.month === m).out.debt, 8000, m);
  // Raised again later: the bill's amount, whichever side of the average it is.
  assert.equal(build(ds, planOf({ bills: [installment({ monthlyCents: 15000 })] })).dialsByKey.other.baselineCents, 15000);
  assert.equal(build(ds, planOf({ bills: [installment({ monthlyCents: 15000 })] })).dialsByKey.other.debtCheck, null, 'the bills are more: nothing to check');
});

test('debt: an explicit $0 debt bill is a current amount (no fallback to the history); with no debt in the history a bill is added; personal bills stay out', () => {
  const ds = dataset([['Groceries', 200]], [paid([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 200)]);
  // Paid off (or paused) at $0: the history's $200 is not planned.
  const zero = build(ds, planOf({ bills: [installment({ monthlyCents: 0 })] }));
  assert.equal(zero.dialsByKey.other.baselineCents, 0);
  assert.deepEqual(zero.dialsByKey.other.debtCheck, { billsCents: 0, averageCents: 20000 });
  assert.deepEqual(zero.bills.map(b => b.status), ['seen']);
  assert.equal(zero.months.find(m => m.month === '2032-01').out.debt, 0);
  // Ended in the window: its last payment is in the history, so nothing of it is left after.
  const ended = build(ds, planOf({ bills: [installment({ endMonth: '2031-12' })] }));
  assert.equal(ended.months.find(m => m.month === '2032-01').out.debt, 0);
  // No debt payment in the history at all: the bill is added from the plan start.
  const none = dataset([['Groceries', 200]]);
  const added = build(none, planOf({ bills: [installment()] }));
  assert.deepEqual(added.bills.map(b => b.status), ['added']);
  assert.equal(added.months.find(m => m.month === '2032-01').out.debt, 8000);
  assert.equal(build(none, planOf({ bills: [installment({ monthlyCents: 0 })] })).months.find(m => m.month === '2032-01').out.debt, 0);
  // A personal bill (paid from one person's own money) never enters joint spending: the history stays.
  const personal = build(ds, planOf({ bills: [installment({ fundedFrom: 'p2', monthlyCents: 0 })] }));
  assert.equal(personal.dialsByKey.other.baselineCents, 20000);
  assert.equal(personal.dialsByKey.other.debtCheck, null);
});

test('debt: without double counting — the bills are the debt payments (a larger average is flagged, not added); an ending bill takes out exactly what it counts', () => {
  // Another debt with no bill is paid every month too: the average (80×3/12 + 150) is more than the
  // bill. The history cannot be split by bill, so the bill is the debt part and the dial says so.
  const both = dataset([['Groceries', 200]], [paid([10, 11, 12]), paid([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 150, 'Invented Store Card')]);
  const other = build(both, planOf({ bills: [installment()] })).dialsByKey.other;
  assert.equal(other.baselineCents, 8000);
  assert.deepEqual(other.debtCheck, { billsCents: 8000, averageCents: 2000 + 15000 });
  assert.match(other.basis, /if a debt payment is missing from your bills, add it in Edit plan, or set this amount here/);
  // With the store card listed as a bill too, both count and nothing is flagged.
  const card = installment({ id: 'store-card', label: 'Invented store card', monthlyCents: 15000 });
  const listed = build(both, planOf({ bills: [installment(), card] })).dialsByKey.other;
  assert.equal(listed.baselineCents, 8000 + 15000);
  assert.equal(listed.debtCheck, null);
  // A bill ending in the plan: $80 until its end month, then $0 (not $20 − $80).
  const ds = dataset([['Groceries', 200]], [paid([10, 11, 12])]);
  const tl = build(ds, planOf({ bills: [installment({ endMonth: '2032-03' })] }));
  assert.deepEqual(tl.bills.map(b => b.status), ['ends']);
  assert.equal(tl.months.find(m => m.month === '2032-03').out.debt, 8000);
  assert.equal(tl.months.find(m => m.month === '2032-04').out.debt, 0);
});

test('debt: bills that are not current joint debt payments the history holds leave the average alone', () => {
  const ds = dataset([['Groceries', 200]], [paid([10, 11, 12])]);
  const base = b => build(ds, planOf({ bills: [b] })).dialsByKey.other.baselineCents;
  assert.equal(base(installment({ fundedFrom: 'p1' })), 2000, 'paid personally');
  assert.equal(base(installment({ monthlyCents: null })), 2000, 'no amount');
  assert.equal(base(installment({ endMonth: '2030-12' })), 2000, 'ended before the window');
  // Planned (not paid yet): added from the plan start as a change of its own, on top of the history.
  const planned = build(ds, planOf({ bills: [installment({ status: 'planned' })] }));
  assert.equal(planned.dialsByKey.other.baselineCents, 2000);
  assert.equal(planned.months.find(m => m.month === '2032-01').out.debt, 10000);
  // A dial set directly wins.
  const direct = build(ds, planOf({ bills: [installment()] }), { dials: { other: 3000 } });
  assert.equal(direct.months.find(m => m.month === '2032-01').out.debt, 3000);
});

test('a bill in a category an aggregate budget covers (or under an imported alias) is covered by that budget, not added again', () => {
  const tx = [];
  let n = 0;
  const add = (m, c, d) => tx.push({ id: 'agg-' + (++n), accountId: 'checking', date: m + '-15', amountCents: -100 * d, kind: 'spend', category: c, merchant: c, description: c });
  for (let i = 1; i <= 12; i++) { const m = '2025-' + String(i).padStart(2, '0'); add(m, 'Natural gas', 100); add(m, 'Electricity', 50); }
  const ds = E.ledger.normalizeDataset({ schemaVersion: 2, datasetId: 'agg-bill', isSynthetic: true,
    accounts: [{ id: 'checking', label: 'Example checking', type: 'checking', scope: 'joint', coverage: [{ start: '2025-01-01', end: '2025-12-31' }] }], transactions: tx });
  const plan = { people: [{ id: 'p1', name: 'Person A' }], incomes: [], debts: [], savings: [], personalSpending: [], balances: {},
    bills: [{ id: 'el', label: 'Electric bill', type: 'utility', category: 'Electric', fundedFrom: 'joint', monthlyCents: 5000, status: 'existing' }],
    targets: { 'Energy (gas + electric, migrated)': 15000 } };
  const run = p => E.timeline.build({ txns: E.ledger.applyEdits(ds, {}), dataset: ds, plan: p, settings: { baselineMonths: 12 }, today: '2026-01-06' });
  const tl = run(plan);
  assert.deepEqual(tl.bills.map(b => [b.id, b.status]), [['el', 'inBudget']]);
  assert.equal(tl.months.find(m => m.month === '2026-01').out.essentials, 15000, 'energy counted once');
  // Without the aggregate budget the Electric bill is seen in its alias's history ('Electricity'), not added on top.
  const noBudget = run(Object.assign({}, plan, { targets: {} }));
  assert.deepEqual(noBudget.bills.map(b => [b.id, b.status]), [['el', 'seen']]);
});
