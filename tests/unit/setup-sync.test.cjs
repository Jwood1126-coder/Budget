'use strict';
// Tests for BudgetEngine.setupSync: the setup file's (household profile's) values reaching a saved
// budget through a three-way merge. Every household, amount and id here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const S = E.state;
const Y = E.setupSync;

const DS = { datasetId: 'invented' };
const T0 = '2031-03-01T09:00:00.000Z';
const T1 = '2031-04-01T09:00:00.000Z';
const T2 = '2031-05-01T09:00:00.000Z';

/** An invented setup file. */
function profile() {
  return {
    schemaVersion: 1,
    isSynthetic: true,
    household: { name: 'Robin & Casey (invented)', people: [{ id: 'p1', name: 'Robin' }, { id: 'p2', name: 'Casey' }] },
    plan: {
      people: [{ id: 'p1', name: 'Robin' }, { id: 'p2', name: 'Casey' }],
      incomes: [{ id: 'pay-r', label: 'Robin pay', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: 150000, jointPerPaycheckCents: 120000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2031-01-03', status: 'confirmed' }],
      bills: [
        { id: 'rent', label: 'Rent', category: 'Mortgage', monthlyCents: 140000, fundedFrom: 'joint', type: 'housing' },
        { id: 'stream', label: 'Streaming', category: 'Subscriptions', monthlyCents: 1500, fundedFrom: 'joint', type: 'subscription' }
      ],
      debts: [{ id: 'car', label: 'Car loan', ownerId: 'joint', balanceCents: 900000 }],
      savings: [{ id: 'cushion', label: 'Cushion', targetCents: 500000, monthlyCents: 20000 }],
      changes: [{ id: 'gym', label: 'Gym', kind: 'monthly', group: 'flexible', startMonth: '2031-06', endMonth: '2031-12', cents: 4000 }],
      targets: { 'Dining & takeout': 30000, Groceries: 60000 },
      settings: { incomeTiming: 'average' },
      balances: { jointCashCents: 250000, asOf: '2031-02-28' }
    },
    planUi: { baselineMonths: 6, dials: { flexible: 50000 }, groups: { Pets: 'essentials' } },
    notes: ['Invented for tests.']
  };
}

const copy = v => JSON.parse(JSON.stringify(v));
const byId = (list, id) => list.find(x => x.id === id);
/** A budget saved in a browser and opened again: through JSON and sanitize. */
const reload = (state, prof) => {
  const r = S.sanitize(copy(state), prof, DS);
  assert.deepEqual(r.notes, [], 'reloading a synced budget leaves no notes of its own');
  return r.state;
};
/** A budget first opened with `prof`, synced and saved (the base is `prof`). */
function opened(prof = profile()) {
  const r = Y.apply(S.defaults(prof, DS, { now: T0 }), prof, { now: T0 });
  assert.deepEqual(r.report.kept, []);
  return reload(r.state, prof);
}
/** The plan and ui.plan only (what the merge may change). */
const managed = st => copy({ plan: st.plan, ui: st.ui.plan });

test('the setup-managed paths are one table, including profile.planUi fields', () => {
  const paths = Y.MANAGED.map(r => r.path);
  for (const p of ['plan.incomes', 'plan.bills', 'plan.debts', 'plan.savings', 'plan.changes', 'plan.targets', 'plan.settings',
    'plan.balances', 'plan.people', 'ui.plan.dials', 'ui.plan.rows', 'ui.plan.groups', 'ui.plan.irregularOff',
    'ui.plan.baselineMonths', 'ui.plan.coverFromSavings', 'ui.plan.investReturnPct']) assert.ok(paths.includes(p), p);
  assert.equal(byId(Y.MANAGED.map(r => ({ id: r.path, kind: r.kind })), 'plan.targets').kind, 'map');
  assert.equal(byId(Y.MANAGED.map(r => ({ id: r.path, kind: r.kind })), 'plan.bills').kind, 'list');
});

test('a new budget: the first run records the base, keeps the plan and applies planUi', () => {
  const prof = profile();
  const st = S.defaults(prof, DS, { now: T0 });
  const r = Y.apply(st, prof, { now: T0 });
  assert.equal(r.report.first, true);
  assert.deepEqual(managed(r.state).plan, managed(st).plan, 'the plan already is the profile’s');
  // ui.plan starts from its defaults in every budget, so the profile's planUi is applied.
  assert.equal(r.state.ui.plan.baselineMonths, 6);
  assert.deepEqual(r.state.ui.plan.dials, { flexible: 50000 });
  assert.deepEqual(r.state.ui.plan.groups, { Pets: 'essentials' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.notes, ['Your setup file updated 3 settings (Flexible on the plan, Pets grouping, Months averaged).']);
  // Without planUi nothing changes and nothing is said.
  const plain = profile();
  delete plain.planUi;
  const r0 = Y.apply(S.defaults(plain, DS, { now: T0 }), plain, { now: T0 });
  assert.deepEqual(r0.notes, []);
  assert.equal(r0.changed, false);
  assert.deepEqual(managed(r0.state), managed(S.defaults(plain, DS, { now: T0 })));
  assert.ok(/^v2-/.test(r.state.meta.setup.hash));
  assert.equal(r.state.meta.setup.appliedAt, T0);
  assert.equal(byId(r.state.meta.setup.base.plan.bills, 'rent').monthlyCents, 140000);
  assert.equal(r.state.meta.setup.base.plan.targets['Dining & takeout'], 30000);
  assert.equal(r.state.meta.setup.base.ui.plan.baselineMonths, 6);
  assert.equal(st.meta.setup, undefined, 'the input is not changed');
});

test('first run on an existing budget keeps every saved value that differs and records the profile as base', () => {
  const prof = profile();
  let st = S.defaults(prof, DS, { now: T0 });
  st = S.setPath(st, 'plan.bills[id=rent].monthlyCents', 145000);
  st = S.setPath(st, 'plan.targets.Groceries', 65000);
  st = S.setPath(st, 'ui.plan.baselineMonths', 3);
  st = S.setPath(st, 'ui.plan.dials.flexible', 47000);
  st = S.setPath(st, 'ui.plan.groups.Pets', 'essentials');
  st = S.removeItem(st, 'bills', 'stream');
  st = S.addItem(st, 'bills', { id: 'phone', label: 'Phone', monthlyCents: 5000 });
  const saved = reload(st, prof);
  const r = Y.apply(saved, prof, { now: T1 });
  assert.deepEqual(managed(r.state), managed(saved), 'nothing saved is overwritten on the first run');
  assert.equal(r.report.first, true);
  assert.equal(r.changed, false);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^Your setup file is now linked to this budget; 5 settings here differ from it and were kept \(/);
  assert.match(r.notes[0], /Rent amount/);
  assert.deepEqual(r.report.kept.sort(), ['Flexible on the plan', 'Groceries target', 'Months averaged', 'Rent amount', 'Streaming (removed here)']);
  assert.equal(byId(r.state.meta.setup.base.plan.bills, 'rent').monthlyCents, 140000, 'base := profile');
  // A later profile change to a field the household changed is still theirs.
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 150000;
  p2.plan.bills[1].monthlyCents = 2000; // the bill the household removed here
  const r2 = Y.apply(reload(r.state, prof), p2, { now: T2 });
  assert.equal(byId(r2.state.plan.bills, 'rent').monthlyCents, 145000);
  assert.ok(!byId(r2.state.plan.bills, 'stream'), 'the bill removed here stays removed');
});

test('a later profile change flows to every field the household left alone', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 142500;
  p2.plan.targets['Dining & takeout'] = 25000;
  p2.plan.settings.incomeTiming = 'actual';
  p2.plan.balances.jointCashCents = 300000;
  p2.plan.people[1].name = 'Casey Q';
  p2.plan.incomes[0].netPerPaycheckCents = 155000;
  p2.plan.debts[0].aprPct = 6.5;
  p2.plan.savings[0].targetCents = 600000;
  p2.plan.changes[0].cents = 4500;
  const r = Y.apply(st, p2, { now: T1 });
  const plan = r.state.plan;
  assert.equal(byId(plan.bills, 'rent').monthlyCents, 142500);
  assert.equal(plan.targets['Dining & takeout'], 25000);
  assert.equal(plan.settings.incomeTiming, 'actual');
  assert.equal(plan.balances.jointCashCents, 300000);
  assert.equal(byId(plan.people, 'p2').name, 'Casey Q');
  assert.equal(byId(plan.incomes, 'pay-r').netPerPaycheckCents, 155000);
  assert.equal(byId(plan.debts, 'car').aprPct, 6.5);
  assert.equal(byId(plan.savings, 'cushion').targetCents, 600000);
  assert.equal(byId(plan.changes, 'gym').cents, 4500);
  assert.equal(r.changed, true);
  assert.equal(r.state.meta.updatedAt, T1);
  assert.equal(r.state.meta.setup.appliedAt, T1);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^Your setup file updated 9 settings \(Robin pay take-home pay, Rent amount, Car loan interest rate, …\)\.$/);
  assert.ok(r.report.updated.includes('Dining & takeout target'));
  assert.ok(r.report.updated.includes('Casey’s name'));
  // Everything else is exactly as saved.
  const expected = copy(st.plan);
  Object.assign(byId(expected.bills, 'rent'), { monthlyCents: 142500 });
  assert.deepEqual(byId(plan.bills, 'stream'), byId(expected.bills, 'stream'));
  assert.equal(byId(r.state.meta.setup.base.plan.bills, 'rent').monthlyCents, 142500, 'the base follows the profile');
});

test('fields the household changed here are kept, and the note says so', () => {
  let st = opened();
  st = S.setPath(st, 'plan.targets.Groceries', 70000);
  st = S.setPath(st, 'plan.bills[id=rent].note', 'Our own note');
  st = S.setPath(st, 'plan.settings.comparisonWindow', 6);
  st = reload(st, profile());
  const p2 = profile();
  p2.plan.targets.Groceries = 62000;           // changed here and in the profile: theirs
  p2.plan.bills[0].monthlyCents = 141000;       // same item, a field they left alone: flows
  p2.plan.bills[0].note = 'Setup note';         // changed here: kept
  p2.plan.targets['Dining & takeout'] = 28000;  // left alone: flows
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(r.state.plan.targets.Groceries, 70000);
  assert.equal(byId(r.state.plan.bills, 'rent').note, 'Our own note');
  assert.equal(byId(r.state.plan.bills, 'rent').monthlyCents, 141000);
  assert.equal(r.state.plan.targets['Dining & takeout'], 28000);
  assert.equal(r.state.plan.settings.comparisonWindow, 6, 'a household change the profile did not touch: kept, not mentioned');
  assert.deepEqual(r.notes, ['Your setup file updated 2 settings (Rent amount, Dining & takeout target); kept 2 you changed here (Rent note, Groceries target).']);
  // The base records the profile's values, so the household's stay theirs next time too.
  assert.equal(r.state.meta.setup.base.plan.targets.Groceries, 62000);
  const p3 = copy(p2);
  p3.plan.targets.Groceries = 64000;
  const r3 = Y.apply(reload(r.state, p2), p3, { now: T2 });
  assert.equal(r3.state.plan.targets.Groceries, 70000);
  assert.deepEqual(r3.notes, ['Your setup file changed 1 setting you changed here; kept yours (Groceries target).']);
});

test('only the changed parts of an item flow: a household value equal to the new profile value is not a conflict', () => {
  let st = opened();
  st = reload(S.setPath(st, 'plan.targets.Groceries', 61000), profile());
  const p2 = profile();
  p2.plan.targets.Groceries = 61000;
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(r.state.plan.targets.Groceries, 61000);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.report.kept, []);
});

test('items new in the profile are added, at the end, as the profile has them', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills.push({ id: 'water', label: 'Water', category: 'Water & sewer', monthlyCents: 4200, type: 'utility', fundedFrom: 'joint' });
  p2.plan.changes.push({ id: 'trip', label: 'Trip', kind: 'oneTime', group: 'irregular', startMonth: '2031-08', cents: 120000, scenario: 'Summer' });
  p2.plan.targets.Fuel = 15000;
  const r = Y.apply(st, p2, { now: T1 });
  const bills = r.state.plan.bills;
  assert.deepEqual(bills.map(b => b.id), ['rent', 'stream', 'water']);
  assert.equal(byId(bills, 'water').monthlyCents, 4200);
  assert.equal(byId(bills, 'water').status, 'existing', 'checked like a new budget: defaults filled');
  const trip = byId(r.state.plan.changes, 'trip');
  assert.equal(trip.cents, 120000);
  assert.equal(trip.accepted, false, 'never accepted automatically');
  assert.equal(r.state.plan.targets.Fuel, 15000);
  assert.match(r.notes[0], /Your setup file updated 3 settings \(Water \(new\), Trip \(new\), Fuel target\)\./);
});

test('the setup file never erases: items and entries it no longer has stay, are named, and are only removed in the app', () => {
  let st = opened();
  st = reload(S.setPath(st, 'plan.savings[id=cushion].savedCents', 12000), profile());
  const p2 = profile();
  p2.plan.bills = p2.plan.bills.filter(b => b.id !== 'stream');
  p2.plan.savings = [];
  delete p2.plan.targets['Dining & takeout'];
  p2.plan.targets.Groceries = 61000; // a real change still flows
  const r = Y.apply(st, p2, { now: T1 });
  assert.deepEqual(byId(r.state.plan.bills, 'stream'), byId(st.plan.bills, 'stream'));
  assert.deepEqual(byId(r.state.plan.savings, 'cushion'), byId(st.plan.savings, 'cushion'));
  assert.equal(r.state.plan.targets['Dining & takeout'], 30000);
  assert.equal(r.state.plan.targets.Groceries, 61000);
  assert.deepEqual(r.report.updated, ['Groceries target']);
  assert.deepEqual(r.report.gone, ['Streaming', 'Cushion', 'Dining & takeout target']);
  assert.ok(r.notes.some(n => /^3 entries are no longer in your setup file and were kept here \(Streaming, Cushion, Dining & takeout target\); remove them in the app/.test(n)), r.notes.join(' | '));
  // B keeps them, so a later file that has one again (with a new value) still reaches it.
  assert.ok(byId(r.state.meta.setup.base.plan.bills, 'stream'));
  const p3 = copy(p2);
  p3.plan.bills.push({ id: 'stream', label: 'Streaming', category: 'Subscriptions', monthlyCents: 1800, fundedFrom: 'joint', type: 'subscription' });
  const r3 = Y.apply(reload(r.state, p2), p3, { now: T2 });
  assert.equal(byId(r3.state.plan.bills, 'stream').monthlyCents, 1800);
  // The household removes one in the app: it stays removed, whatever the file says.
  const removed = reload(S.removeItem(r3.state, 'bills', 'stream'), p3);
  const p4 = copy(p3);
  byId(p4.plan.bills, 'stream').monthlyCents = 1900;
  assert.ok(!byId(Y.apply(removed, p4, { now: T2 }).state.plan.bills, 'stream'));
});

test('an incomplete setup file erases nothing: missing parts, items, fields and unknown values keep what is saved', () => {
  let st = opened();
  st = reload(S.setPath(st, 'plan.incomes[id=pay-r].netPerPaycheckCents', 155000), profile()); // the household's own value
  const before = managed(st);
  // No plan at all, then no planUi either: nothing changes, nothing is noted.
  for (const p of [{ schemaVersion: 1, household: profile().household }, Object.assign(profile(), { plan: undefined, planUi: undefined })]) {
    const r = Y.apply(st, p, { now: T1 });
    assert.deepEqual(managed(r.state), before);
    assert.deepEqual([r.changed, r.notes], [false, []]);
  }
  // Whole lists, maps and groups left out: kept as they are.
  const partial = profile();
  for (const k of ['incomes', 'bills', 'debts', 'savings', 'changes', 'targets', 'settings', 'balances']) delete partial.plan[k];
  delete partial.planUi.dials;
  let r = Y.apply(st, partial, { now: T1 });
  assert.deepEqual(managed(r.state), before);
  assert.equal(r.changed, false);
  // Items without some of their fields, and fields set to null (unknown): the saved values stay.
  const thin = profile();
  thin.plan.bills = [{ id: 'rent', label: 'Rent' }, { id: 'stream', label: 'Streaming', category: 'Subscriptions', monthlyCents: null, fundedFrom: 'joint', type: 'subscription' }];
  thin.plan.incomes = [{ id: 'pay-r', label: 'Robin pay', personId: 'p1', kind: 'paycheck', netPerPaycheckCents: null, jointPerPaycheckCents: 125000 }];
  thin.plan.targets = { Groceries: null };
  thin.plan.balances = { jointCashCents: null };
  thin.plan.settings = {};
  r = Y.apply(st, thin, { now: T1 });
  const out = r.state.plan;
  assert.deepEqual(byId(out.bills, 'rent'), byId(st.plan.bills, 'rent'));
  assert.equal(byId(out.bills, 'stream').monthlyCents, 1500);
  assert.equal(byId(out.incomes, 'pay-r').netPerPaycheckCents, 155000, 'the household’s value');
  assert.equal(byId(out.incomes, 'pay-r').jointPerPaycheckCents, 125000, 'a real change still flows');
  assert.equal(byId(out.incomes, 'pay-r').frequency, 'biweekly');
  assert.deepEqual(out.targets, st.plan.targets);
  assert.deepEqual(out.balances, st.plan.balances);
  assert.deepEqual(out.settings, st.plan.settings);
  assert.deepEqual(r.report.updated, ['Robin pay amount to joint']);
  // Running again with the same file changes nothing more.
  assert.deepEqual(Y.apply(r.state, thin, { now: T2 }).state, r.state);
});

test('items and entries the household added are never touched', () => {
  let st = opened();
  st = S.addItem(st, 'bills', { id: 'phone', label: 'Phone', category: 'Internet & phone', monthlyCents: 6000 });
  st = S.setPath(st, 'plan.targets.Pets', 4000);
  st = S.setPath(st, 'ui.plan.dials.savings', 25000);
  st = reload(st, profile());
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 139000;
  p2.planUi.dials.flexible = 45000;
  const r = Y.apply(st, p2, { now: T1 });
  assert.deepEqual(byId(r.state.plan.bills, 'phone'), byId(st.plan.bills, 'phone'));
  assert.equal(r.state.plan.targets.Pets, 4000);
  assert.equal(r.state.ui.plan.dials.savings, 25000);
  assert.equal(r.state.ui.plan.dials.flexible, 45000);
  assert.deepEqual(r.report.kept, []);
});

test('an item with the same id as a new profile item, added here first, stays the household’s', () => {
  let st = opened();
  st = reload(S.addItem(st, 'bills', { id: 'water', label: 'Our water', monthlyCents: 3000 }), profile());
  const p2 = profile();
  p2.plan.bills.push({ id: 'water', label: 'Water', monthlyCents: 4200 });
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(byId(r.state.plan.bills, 'water').label, 'Our water');
  assert.equal(byId(r.state.plan.bills, 'water').monthlyCents, 3000);
  assert.equal(r.state.plan.bills.filter(b => b.id === 'water').length, 1);
});

test('maps merge key by key (targets, dials, groups, rows, one-time costs left out)', () => {
  let st = opened();
  st = S.setPath(st, 'ui.plan.groups.Pets', 'flexible');          // changed here
  st = S.setPath(st, 'ui.plan.rows.flexible-cat-abc', { cents: 1000 });
  st = reload(st, profile());
  const p2 = profile();
  p2.planUi.groups = { Pets: 'essentials', 'merchant:Corner Gym': 'flexible' };
  p2.planUi.rows = { 'essentials-cat-xyz': { included: false } };
  p2.planUi.irregularOff = { 'tx-invented-1': true };
  p2.planUi.dials = { flexible: 50000, essentials: 210000 };
  const r = Y.apply(st, p2, { now: T1 });
  const ui = r.state.ui.plan;
  assert.deepEqual(ui.groups, { Pets: 'flexible', 'merchant:Corner Gym': 'flexible' });
  assert.deepEqual(ui.rows, { 'flexible-cat-abc': { cents: 1000 }, 'essentials-cat-xyz': { included: false } });
  assert.deepEqual(ui.irregularOff, { 'tx-invented-1': true });
  assert.deepEqual(ui.dials, { flexible: 50000, essentials: 210000 });
  assert.ok(r.report.updated.includes('Corner Gym grouping'));
  assert.ok(r.report.updated.includes('Essentials on the plan'));
  // A key gone from the profile is never removed here (the setup file does not erase).
  let st2 = reload(r.state, p2);
  st2 = reload(S.setPath(st2, 'ui.plan.dials.essentials', 220000), p2);
  const p3 = copy(p2);
  p3.planUi.dials = {};
  p3.planUi.groups = { Pets: 'essentials' };
  const r3 = Y.apply(st2, p3, { now: T2 });
  assert.deepEqual(r3.state.ui.plan.dials, { flexible: 50000, essentials: 220000 });
  assert.deepEqual(r3.state.ui.plan.groups, { Pets: 'flexible', 'merchant:Corner Gym': 'flexible' });
  assert.deepEqual(r3.report.gone, ['Flexible on the plan', 'Essentials on the plan', 'Corner Gym grouping']);
});

test('profile.planUi: plan-screen settings merge like the plan, checked with the ui.plan rules', () => {
  const prof = profile();
  const st = opened(prof);
  assert.equal(st.ui.plan.baselineMonths, 6);
  // Left alone here: a later value flows.
  const p2 = profile();
  p2.planUi.baselineMonths = 3;
  p2.planUi.coverFromSavings = false;
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(r.state.ui.plan.baselineMonths, 3);
  assert.equal(r.state.ui.plan.coverFromSavings, false);
  // Changed here: kept.
  const mine = reload(S.setPath(r.state, 'ui.plan.baselineMonths', 12), p2);
  const p3 = copy(p2);
  p3.planUi.baselineMonths = 6;
  const r3 = Y.apply(mine, p3, { now: T2 });
  assert.equal(r3.state.ui.plan.baselineMonths, 12);
  assert.deepEqual(r3.report.kept, ['Months averaged']);
  // First run on a budget saved before setup sync: a setting the household changed from its
  // default is theirs; one still at its default takes the profile's value.
  let older = S.defaults(prof, DS, { now: T0 });
  older = reload(S.setPath(older, 'ui.plan.coverFromSavings', false), prof);
  const r4 = Y.apply(older, p3, { now: T1 });
  assert.equal(r4.state.ui.plan.coverFromSavings, false, 'the household’s (the default is true)');
  assert.equal(r4.state.ui.plan.baselineMonths, 6, 'still at its default: the profile’s');
  // Fields the profile does not manage are left alone (horizon, mode...).
  const p5 = copy(p3);
  p5.planUi.horizon = 60;
  p5.planUi.mode = 'trends';
  const r5 = Y.apply(reload(r3.state, p3), p5, { now: T2 });
  assert.equal(r5.state.ui.plan.horizon, 12);
  assert.equal(r5.state.ui.plan.mode, 'balance');
  assert.equal(r5.report, null, 'nothing managed changed: same hash');
});

test('a ui.plan field this version does not have is ignored until it does', () => {
  const known = S.PLAN_UI.map(d => d.name);
  const st = opened();
  const p2 = profile();
  p2.planUi.investReturnPct = 4;
  const r = Y.apply(st, p2, { now: T1 });
  if (known.includes('investReturnPct')) {
    assert.equal(r.state.ui.plan.investReturnPct, 4);
  } else {
    assert.equal(r.state.ui.plan.investReturnPct, undefined);
    assert.deepEqual(r.notes, [], 'not named as a problem: it is for a newer version');
  }
});

test('a field added to the format after the base was recorded flows when the household never set it', () => {
  const st = opened();
  // A base recorded by an earlier version had no "note" on the bill (simulated).
  const old = copy(st);
  delete byId(old.meta.setup.base.plan.bills, 'rent').note;
  old.meta.setup.hash = 'v1-earlier';
  const p2 = profile();
  p2.plan.bills[0].note = 'From setup';
  const r = Y.apply(reload(old, profile()), p2, { now: T1 });
  assert.equal(byId(r.state.plan.bills, 'rent').note, 'From setup');
});

test('idempotent: a second run changes nothing and says nothing; a forced re-merge changes nothing either', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 99000;
  p2.plan.bills.push({ id: 'water', label: 'Water', monthlyCents: 4200 });
  p2.planUi.dials.essentials = 200000;
  const r1 = Y.apply(st, p2, { now: T1 });
  const r2 = Y.apply(r1.state, p2, { now: T2 });
  assert.equal(r2.state, r1.state, 'same hash: the very same state back');
  assert.deepEqual(r2.notes, []);
  assert.equal(r2.report, null);
  // Even with the hash forgotten, merging again finds nothing to change.
  const forced = copy(r1.state);
  forced.meta.setup.hash = 'forgotten';
  const r3 = Y.apply(forced, p2, { now: T2 });
  assert.deepEqual(managed(r3.state), managed(r1.state));
  assert.deepEqual(r3.state.meta.setup.base, r1.state.meta.setup.base);
  assert.deepEqual(r3.notes, []);
  // Saving and reloading keeps it that way.
  const r4 = Y.apply(reload(r1.state, p2), p2, { now: T2 });
  assert.deepEqual(r4.notes, []);
  assert.equal(r4.report, null);
});

test('an unchanged profile hash means no work; parts the setup file does not manage do not count', () => {
  const st = opened();
  const p2 = profile();
  p2.notes = ['A different note'];
  p2.scenarios = [{ id: 'sc-x', name: 'What if', events: [] }];
  p2.references = [{ id: 'r1', label: 'Ref', start: '2031-01-01', end: '2031-01-31', spendingCents: 100 }];
  p2.plan.personalSpending = [{ personId: 'p1', monthlyCents: 5000 }];
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(r.state, st);
  assert.deepEqual(r.notes, []);
  assert.equal(r.changed, false);
  assert.equal(r.report, null);
  // Key order does not matter either.
  const reordered = profile();
  reordered.plan.targets = { Groceries: 60000, 'Dining & takeout': 30000 };
  assert.equal(Y.apply(st, reordered, {}).state, st);
});

test('without a profile, or with a profile that has no plan, nothing is done', () => {
  const st = opened();
  assert.equal(Y.apply(st, null).state, st);
  assert.equal(Y.apply(st, undefined).state, st);
  assert.equal(Y.apply(null, profile()).report, null);
});

test('strict: a profile value that is not valid is not applied; the saved value stays with a note', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = -500;             // not an amount
  p2.plan.bills[1].monthlyCents = 1800;              // valid: flows
  p2.plan.targets.Groceries = 'lots';                // not an amount
  p2.plan.settings.incomeTiming = 'sometimes';       // not a choice
  p2.planUi.baselineMonths = 7;                      // not a choice
  p2.planUi.dials.card = 1000;                       // card spending is not a dial
  const r = Y.apply(st, p2, { now: T1 });
  assert.equal(byId(r.state.plan.bills, 'rent').monthlyCents, 140000);
  assert.equal(byId(r.state.plan.bills, 'stream').monthlyCents, 1800);
  assert.equal(r.state.plan.targets.Groceries, 60000);
  assert.equal(r.state.plan.settings.incomeTiming, 'average');
  assert.equal(r.state.ui.plan.baselineMonths, 6);
  assert.ok(!('card' in r.state.ui.plan.dials));
  assert.deepEqual(r.report.invalid, ['Rent amount', 'Groceries target', 'Income timing', 'Card on the plan', 'Months averaged']);
  assert.equal(r.notes.length, 2);
  assert.equal(r.notes[0], 'Your setup file updated 1 setting (Streaming amount).');
  assert.equal(r.notes[1], 'Your setup file has 5 values this version could not use (Rent amount, Groceries target, Income timing, …); kept what was here.');
  // The base keeps its earlier value there, so a corrected file flows (the household left it alone).
  assert.equal(byId(r.state.meta.setup.base.plan.bills, 'rent').monthlyCents, 140000);
  const p3 = copy(p2);
  p3.plan.bills[0].monthlyCents = 143000;
  const r3 = Y.apply(reload(r.state, p2), p3, { now: T2 });
  assert.equal(byId(r3.state.plan.bills, 'rent').monthlyCents, 143000);
});

test('strict: a merged item that fails the checks stays exactly as saved, with a note', () => {
  let st = opened();
  st = reload(S.setPath(st, 'plan.changes[id=gym].endMonth', '2031-08'), profile()); // household's end month
  const p2 = profile();
  p2.plan.changes[0].startMonth = '2031-10';   // after the household's end month
  p2.plan.changes[0].endMonth = '2032-03';
  p2.plan.changes[0].cents = 5000;             // valid on its own, but part of the same item
  const r = Y.apply(st, p2, { now: T1 });
  assert.deepEqual(byId(r.state.plan.changes, 'gym'), byId(st.plan.changes, 'gym'));
  assert.deepEqual(r.report.updated, []);
  assert.deepEqual(r.report.invalid.sort(), ['Gym amount', 'Gym start month']);
  assert.match(r.notes.join(' '), /could not use \(Gym start month, Gym amount\); kept what was here\./);
  // The base keeps the earlier values for that item, so it is tried again when the file changes.
  assert.equal(byId(r.state.meta.setup.base.plan.changes, 'gym').startMonth, '2031-06');
  // Reloading the result leaves no notes: nothing invalid was saved.
  reload(r.state, p2);
});

test('strict: an item the profile cannot give (no id, or missing what it needs) is not added; one in the base is not removed', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills.push({ label: 'No id', monthlyCents: 100 });
  p2.plan.changes.push({ id: 'bad', label: 'No start', kind: 'monthly', group: 'flexible', cents: 100 });
  p2.plan.debts[0].ownerId = 'neighbour';            // invalid field: the debt itself stays
  p2.plan.savings = [{ id: 'cushion', targetCents: 'x' }, { id: 'cushion', label: 'Twice' }]; // repeated id
  const r = Y.apply(st, p2, { now: T1 });
  assert.ok(!r.state.plan.bills.some(b => b.label === 'No id'));
  assert.ok(!byId(r.state.plan.changes, 'bad'));
  assert.equal(byId(r.state.plan.debts, 'car').ownerId, 'joint');
  assert.deepEqual(byId(r.state.plan.savings, 'cushion'), byId(st.plan.savings, 'cushion'), 'not removed because the file broke it');
  assert.ok(r.report.invalid.includes('No id'));
  assert.ok(r.report.invalid.includes('No start'));
  assert.ok(r.report.invalid.includes('Car loan owner id'));
  assert.ok(r.report.invalid.includes('Cushion'));
  assert.deepEqual(r.report.updated, []);
});

test('strict: a list or map that is not readable changes nothing', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills = 'none';
  p2.plan.targets = [1, 2];
  p2.planUi = 'six months';
  const r = Y.apply(st, p2, { now: T1 });
  assert.deepEqual(managed(r.state), managed(st));
  assert.ok(r.report.invalid.length >= 3);
});

test('fields kept as saved from a newer copy of the app survive the merge', () => {
  const st = opened();
  const raw = copy(st);
  byId(raw.plan.bills, 'rent').futureField = { x: 1 };
  raw.plan.futureList = [1];
  const loaded = S.sanitize(raw, profile(), DS).state;
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 150000;
  p2.plan.bills = p2.plan.bills.filter(b => b.id !== 'stream');
  const r = Y.apply(loaded, p2, { now: T1 });
  assert.deepEqual(byId(r.state.plan.bills, 'rent').futureField, { x: 1 });
  assert.equal(byId(r.state.plan.bills, 'rent').monthlyCents, 150000);
  assert.deepEqual(r.state.plan.futureList, [1]);
  // An item gone from the profile is kept, with its extra field.
  assert.ok(byId(r.state.plan.bills, 'stream'));
});

test('meta.setup is part of the saved format: sanitize keeps it, a workbook carries it, problems are noted', () => {
  const st = opened();
  const p2 = profile();
  p2.plan.bills[0].monthlyCents = 150000;
  const synced = Y.apply(st, p2, { now: T1 }).state;
  const again = S.sanitize(copy(synced), p2, DS);
  assert.deepEqual(again.notes, []);
  assert.deepEqual(again.state.meta.setup, synced.meta.setup);
  const wb = S.exportWorkbook(synced, { now: T2 });
  const imported = S.importWorkbook(wb, p2, DS);
  assert.deepEqual(imported.state.meta.setup, synced.meta.setup);
  // Forward compatible: a key inside meta.setup this version does not know is kept as saved.
  const raw = copy(synced);
  raw.meta.setup.futureKey = 'x';
  const kept = S.sanitize(raw, p2, DS);
  assert.equal(kept.state.meta.setup.futureKey, 'x');
  assert.ok(kept.notes.some(n => /meta\.setup\.futureKey/.test(n)));
  // A damaged base is reset (noted); the next sync then runs as a first run and overwrites nothing.
  const bad = copy(synced);
  bad.meta.setup.base = 'broken';
  const r = S.sanitize(bad, p2, DS);
  assert.equal(r.state.meta.setup.base, null);
  assert.ok(r.notes.some(n => /^meta\.setup\.base:/.test(n)));
  const p3 = copy(p2);
  p3.plan.bills[0].monthlyCents = 1;
  const r2 = Y.apply(r.state, p3, { now: T2 });
  assert.equal(r2.report.first, true);
  assert.equal(byId(r2.state.plan.bills, 'rent').monthlyCents, 150000);
  // A budget without meta.setup (saved before setup sync) is valid and has none.
  const older = copy(synced);
  delete older.meta.setup;
  assert.equal(S.sanitize(older, p2, DS).state.meta.setup, undefined);
});

test('the load paths: loadFromStorage and importWorkbook run the merge after loading, notes after the load notes', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const prof = profile();
  const first = Y.loadFromStorage(storage, DS.datasetId, prof, DS, { now: T0 });
  assert.equal(first.source, 'none');
  assert.ok(first.state.meta.setup, 'a new budget records the base straight away');
  assert.deepEqual(first.setupNotes, ['Your setup file updated 3 settings (Flexible on the plan, Pets grouping, Months averaged).']);
  S.saveToStorage(storage, S.setPath(first.state, 'plan.targets.Groceries', 66000));
  const p2 = profile();
  p2.plan.targets.Groceries = 61000;
  p2.plan.targets['Dining & takeout'] = 31000;
  const second = Y.loadFromStorage(storage, DS.datasetId, p2, DS, { now: T1 });
  assert.equal(second.source, 'v5');
  assert.equal(second.state.plan.targets.Groceries, 66000);
  assert.equal(second.state.plan.targets['Dining & takeout'], 31000);
  assert.deepEqual(second.setupNotes, ['Your setup file updated 1 setting (Dining & takeout target); kept 1 you changed here (Groceries target).']);
  assert.deepEqual(second.notes.slice(-1), second.setupNotes);
  assert.equal(second.setup.updated.length, 1);
  // A workbook exported on another device brings its own base; the merge runs against this profile.
  const wb = S.exportWorkbook(first.state, { now: T0 });
  const imp = Y.importWorkbook(wb, p2, DS, { now: T2 });
  assert.equal(imp.state.plan.targets['Dining & takeout'], 31000);
  assert.ok(imp.notes.some(n => /^Workbook exported/.test(n)));
  assert.match(imp.setupNotes[0], /^Your setup file updated 2 settings/);
  assert.throws(() => Y.importWorkbook('not json', p2, DS), err => err instanceof E.ValidationError);
});

test('upgrades inside version 5 run before the merge', () => {
  const st = opened();
  const raw = copy(st);
  raw.ui.plan.dials = { card: 40000, flexible: 50000 };
  const loaded = S.sanitize(raw, profile(), DS);
  assert.ok(loaded.notes.some(n => /carried over/.test(n)));
  const p2 = profile();
  p2.planUi.dials.flexible = 52000;
  const r = Y.apply(loaded.state, p2, { now: T1 });
  assert.equal(r.state.ui.plan.dials.flexible, 52000);
  assert.ok(!('card' in r.state.ui.plan.dials));
  assert.deepEqual(r.state.ui.plan.legacyDials, { card: 40000 });
});

test('deep equality over JSON values', () => {
  assert.ok(Y.equal({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }));
  assert.ok(Y.equal({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!Y.equal({ a: 1 }, { a: 1, b: null }));
  assert.ok(!Y.equal([1, 2], [2, 1]));
  assert.ok(!Y.equal(0, null));
});

// ------------------------------------------------------------------ the Plan screen's Reset
// A Reset puts back what the setup file supplied (B), so the saved value equals B again and the
// setup file's later values still reach it; a key it never supplied is removed, as before.
const TL = E.timeline;
/** A setup file that supplies two dials, a row and a one-time cost left out. */
function resetProfile() {
  const p = profile();
  p.planUi = { dials: { flexible: 50000, essentials: 210000 }, rows: { 'flexible-c-abc': { included: false } }, irregularOff: { 'tx-invented-1': true } };
  return p;
}

test('baseValue: what the setup file supplied last time, read as the merge reads it', () => {
  const prof = resetProfile();
  const st = opened(prof);
  assert.equal(Y.baseValue(st, 'ui.plan.dials.flexible'), 50000);
  assert.deepEqual(Y.baseValue(st, 'ui.plan.dials'), { flexible: 50000, essentials: 210000 });
  assert.deepEqual(Y.baseValue(st, 'ui.plan.rows.flexible-c-abc'), { included: false });
  assert.equal(Y.baseValue(st, 'ui.plan.dials.savings'), undefined, 'a dial it did not supply');
  assert.equal(Y.baseValue(st, 'plan.targets.Groceries'), 60000);
  assert.equal(Y.baseValue(st, 'plan.bills.rent').monthlyCents, 140000, 'a list item by id');
  assert.equal(Y.baseValue(st, 'ui.plan.hidden'), undefined, 'not setup-managed');
  // A copy: changing it changes nothing saved.
  Y.baseValue(st, 'ui.plan.rows')['flexible-c-abc'].included = true;
  assert.deepEqual(st.meta.setup.base.ui.plan.rows, { 'flexible-c-abc': { included: false } });
  // No setup file yet, or a part it left out: nothing.
  assert.equal(Y.baseValue(S.defaults(prof, DS, { now: T0 }), 'ui.plan.dials.flexible'), undefined);
  const without = profile();
  delete without.planUi;
  assert.equal(Y.baseValue(opened(without), 'ui.plan.dials'), undefined);
});

test('Reset of a dial the setup file supplied puts its value back, and a later setup file reaches it', () => {
  const prof = resetProfile();
  let st = opened(prof);
  // The household moves flexible, ticks the row back in, changes a row of its own and sets savings.
  st = TL.setDial(st, 'flexible', 47000);
  st = TL.setRow(st, 'flexible-c-abc', { included: true });
  st = TL.setRow(st, 'flexible-m-xyz', { cents: 1200 });
  st = TL.setDial(st, 'savings', 30000);
  assert.deepEqual(st.ui.plan.rows, { 'flexible-m-xyz': { cents: 1200 } });
  const reset = reload(TL.resetDial(st, 'flexible'), prof);
  assert.deepEqual(reset.ui.plan.dials, { flexible: 50000, essentials: 210000, savings: 30000 }, 'the setup value, not removed; savings untouched');
  assert.deepEqual(reset.ui.plan.rows, { 'flexible-c-abc': { included: false } }, 'its rows: the setup file’s back, the household’s own removed');
  assert.deepEqual(reset.ui.plan.irregularOff, { 'tx-invented-1': true }, 'another dial’s list stays');
  // The setup file changes: the new values flow, as if the dial had never been touched.
  const p2 = resetProfile();
  p2.planUi.dials.flexible = 60000;
  p2.planUi.rows['flexible-c-abc'] = { cents: 2500 };
  const r = Y.apply(reset, p2, { now: T1 });
  assert.deepEqual(r.state.ui.plan.dials, { flexible: 60000, essentials: 210000, savings: 30000 });
  assert.deepEqual(r.state.ui.plan.rows, { 'flexible-c-abc': { cents: 2500 } });
  assert.deepEqual(r.report.kept, []);
  assert.deepEqual(r.notes, ['Your setup file updated 2 settings (Flexible on the plan, A spending row on the plan).']);
  // And the next one too (Reset left no mark behind).
  const p3 = copy(p2);
  p3.planUi.dials.flexible = 65000;
  assert.equal(Y.apply(reload(r.state, p2), p3, { now: T2 }).state.ui.plan.dials.flexible, 65000);
  // Clearing the box instead is the household's choice: the dial stays off the setup value.
  const cleared = Y.apply(reload(TL.setDial(reset, 'flexible', null), prof), p2, { now: T1 });
  assert.equal(cleared.state.ui.plan.dials.flexible, undefined);
});

test('Reset of a dial the setup file never supplied removes the change, as before', () => {
  const prof = resetProfile();
  let st = opened(prof);
  st = TL.setDial(st, 'savings', 30000);
  st = TL.setRow(st, 'essentials-m-xyz', { cents: 900 });
  const reset = TL.resetDial(TL.resetDial(st, 'savings'), 'essentials');
  // essentials has a setup value: back to it; savings has none: removed (back to its baseline).
  assert.deepEqual(reset.ui.plan.dials, { flexible: 50000, essentials: 210000 });
  assert.deepEqual(reset.ui.plan.rows, { 'flexible-c-abc': { included: false } });
  // A budget with no setup file: exactly as before.
  let plain = S.defaults(null, DS, { now: T0 });
  plain = TL.setRow(TL.setDial(plain, 'flexible', 47000), 'flexible-m-xyz', { cents: 1200 });
  plain = TL.setIrregular(plain, 'tx-invented-2', false);
  const back = TL.resetDial(TL.resetDial(plain, 'flexible'), 'irregular');
  assert.deepEqual([back.ui.plan.dials, back.ui.plan.rows, back.ui.plan.irregularOff], [{}, {}, {}]);
  assert.deepEqual(TL.resetPlan(TL.setDial(plain, 'savings', 100)).ui.plan.dials, {});
});

test('Reset of irregular puts the setup file’s one-time costs back out of the allowance, and only those', () => {
  const prof = resetProfile();
  let st = opened(prof);
  st = TL.setIrregular(st, 'tx-invented-1', true);
  st = TL.setIrregular(st, 'tx-invented-2', false);
  assert.deepEqual(st.ui.plan.irregularOff, { 'tx-invented-2': true });
  const reset = TL.resetDial(st, 'irregular');
  assert.deepEqual(reset.ui.plan.irregularOff, { 'tx-invented-1': true });
  const p2 = resetProfile();
  p2.planUi.irregularOff = { 'tx-invented-1': true, 'tx-invented-3': true };
  assert.deepEqual(Y.apply(reload(reset, prof), p2, { now: T1 }).state.ui.plan.irregularOff, { 'tx-invented-1': true, 'tx-invented-3': true });
});

test('Reset all puts every setup value back and removes the rest; later setup values flow everywhere', () => {
  const prof = resetProfile();
  let st = opened(prof);
  st = TL.setDial(TL.setDial(TL.setDial(st, 'flexible', 47000), 'essentials', null), 'savings', 30000);
  st = TL.setRow(TL.setRow(st, 'flexible-c-abc', { included: true }), 'essentials-m-xyz', { cents: 900 });
  st = TL.setIrregular(TL.setIrregular(st, 'tx-invented-1', true), 'tx-invented-2', false);
  st = S.setPath(st, 'ui.plan.groups.Pets', 'flexible');
  const reset = reload(TL.resetPlan(st), prof);
  assert.deepEqual(reset.ui.plan.dials, { flexible: 50000, essentials: 210000 });
  assert.deepEqual(reset.ui.plan.rows, { 'flexible-c-abc': { included: false } });
  assert.deepEqual(reset.ui.plan.irregularOff, { 'tx-invented-1': true });
  assert.deepEqual(reset.ui.plan.groups, { Pets: 'flexible' }, 'groups stay');
  assert.deepEqual(reset.plan.targets, st.plan.targets, 'budgets stay');
  const p2 = resetProfile();
  p2.planUi.dials = { flexible: 61000, essentials: 205000 };
  p2.planUi.rows = { 'flexible-c-abc': { cents: 3000 } };
  p2.planUi.irregularOff = { 'tx-invented-4': true };
  const r = Y.apply(reset, p2, { now: T1 });
  assert.deepEqual(r.state.ui.plan.dials, { flexible: 61000, essentials: 205000 });
  assert.deepEqual(r.state.ui.plan.rows, { 'flexible-c-abc': { cents: 3000 } });
  assert.deepEqual(r.state.ui.plan.irregularOff, { 'tx-invented-1': true, 'tx-invented-4': true }, 'a cost the file no longer has stays (it never erases)');
  assert.ok(!r.report.kept.some(k => /on the plan|spending row|one-time cost/.test(k)), 'nothing on the dials is held back as the household’s');
});
