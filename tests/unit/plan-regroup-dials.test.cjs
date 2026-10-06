'use strict';
// Moving spending between Essentials and Flexible while one of the two is set directly: the amount
// the household set stays exactly as saved, and what moved is added to or taken off it as a
// regrouping adjustment (ui.plan.dialShift), so the month's total stays what was planned. Two ways
// in: a category moved on the plan screen (timeline.setGroup), and an amount set while only exact
// taxonomy names were essential (an imported 'Natural gas', 'Electricity' or the energy aggregate
// was planned as flexible then), marked when the saved budget loads (ui.plan.groupsRead 'exact')
// and carried over once on the plan screen (timeline.regroupDials).
// Every name, amount and date here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');
const E = loadEngine();
const C = E.categories;
const T = E.timeline;

const ENERGY = 'Energy (gas + electric, migrated)';

/** A year of invented checking history (2032), one charge per category per month on the 14th. */
function dataset(monthly) {
  const transactions = [];
  let seq = 0;
  for (let i = 1; i <= 12; i++) {
    const month = '2032-' + String(i).padStart(2, '0');
    for (const [category, dollars, merchant] of monthly) {
      transactions.push({ id: 'rg-' + (++seq), accountId: 'checking', date: month + '-14', amountCents: -100 * dollars, kind: 'spend', category, merchant, description: merchant });
    }
  }
  return E.ledger.normalizeDataset({ schemaVersion: 2, datasetId: 'plan-regroup-dials', isSynthetic: true,
    accounts: [{ id: 'checking', label: 'Invented checking', type: 'checking', scope: 'joint', coverage: [{ start: '2032-01-01', end: '2032-12-31' }] }], transactions });
}
function planOf(fields = {}) {
  return Object.assign({ people: [{ id: 'p1', name: 'Odile' }, { id: 'p2', name: 'Bram' }], incomes: [], bills: [], debts: [], targets: {}, savings: [], personalSpending: [],
    balances: { jointCashCents: null, asOf: null, accounts: {}, accountsAsOf: null, accountDates: {} } }, fields);
}
const PROFILE = { isSynthetic: true, household: { name: 'Invented household' }, plan: planOf() };
// Natural gas ($120) moved from Flexible to Essentials; Groceries ($400) was always essential;
// Dining & takeout ($90) and Hobbies ($60) were always flexible.
const HISTORY = [['Natural gas', 120, 'Invented Gas Utility'], ['Groceries', 400, 'Invented Market'], ['Dining & takeout', 90, 'Invented Diner'], ['Hobbies', 60, 'Invented Craft Shop']];
const DS = dataset(HISTORY);

/** A new budget (as saved now) with these dials. */
function budget(dials, ds = DS) {
  let st = E.state.defaults(PROFILE, ds);
  for (const [k, v] of Object.entries(dials)) st = T.setDial(st, k, v);
  return st;
}
/** A budget as saved before groupsRead existed: no mark, these dials (and optionally groups, targets, row changes). */
function savedBefore(ds, dials, { groups, targets, rows } = {}) {
  const st = E.state.defaults({ isSynthetic: true, household: { name: 'Invented household' }, plan: planOf(targets ? { targets } : {}) }, ds);
  const raw = JSON.parse(JSON.stringify(st));
  raw.ui.plan.dials = dials;
  if (groups) raw.ui.plan.groups = groups;
  if (rows) raw.ui.plan.rows = rows;
  delete raw.ui.plan.groupsRead;
  return raw;
}
const load = (raw, ds = DS) => E.state.sanitize(raw, null, ds);
const build = (st, ds = DS) => T.build({ txns: E.ledger.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: st.plan, settings: st.ui.plan, today: '2033-01-06' });
/** The month's essentials + flexible spending as planned (the dials), and all money out. */
const spending = tl => tl.plan.out.essentials + tl.plan.out.flexible;
const outTotal = tl => tl.months.find(m => m.month === tl.planStart).out.total;
/** The plan as the household made it: the same budget with each moved category in its earlier group. */
const asBefore = (st, groups, ds = DS) => build(Object.assign({}, st, { ui: Object.assign({}, st.ui, { plan: Object.assign({}, st.ui.plan, { groupsRead: 'resolved', groups }) }) }), ds);
const catRow = (tl, key, category) => tl.dialsByKey[key].drill.rows.find(r => r.level === 1 && r.category === category) || null;
const shiftOf = st => (st.ui.plan.dialShift ? JSON.parse(JSON.stringify(st.ui.plan.dialShift)) : {});
const GAS = '“Natural gas”, now read as Gas & heating and planned in Essentials';

test('categories.isEssentialByName: the reading before imported names were resolved (exact taxonomy names only)', () => {
  for (const name of ['Gas & heating', 'Electric', 'Groceries', 'Debt payment']) assert.equal(C.isEssentialByName(name), true, name);
  for (const name of ['Natural gas', 'Electricity', 'Groceries & meal kits', 'Electric bill', ENERGY, 'Dining & takeout', 'Restaurants', '', null]) assert.equal(C.isEssentialByName(name), false, String(name));
  // The reading now differs exactly there.
  for (const name of ['Natural gas', 'Electricity', 'Groceries & meal kits', 'Electric bill', ENERGY]) assert.equal(C.isEssential(name), true, name);
});

// ------------------------------------------------------------------ moving a category on the plan screen

test('setGroup with Flexible set directly: the moved category’s amount comes off Flexible as an adjustment; the dial and the total stay', () => {
  const st = budget({ flexible: 30000 });
  const tl = build(st);
  assert.equal(catRow(tl, 'flexible', 'Hobbies').planCents, 6000);
  const moved = T.setGroup(st, 'Hobbies', 'essentials', tl);
  assert.deepEqual(moved.ui.plan.dials, { flexible: 30000 }, 'the amount set stays as saved');
  assert.deepEqual(moved.ui.plan.groups, { Hobbies: 'essentials' });
  assert.deepEqual(shiftOf(moved), { flexible: { cents: -6000, categories: ['Hobbies'] } });
  const after = build(moved);
  assert.equal(outTotal(after), outTotal(tl), 'the month’s money out is the same');
  const d = after.dialsByKey.flexible;
  assert.deepEqual([d.source, d.planCents, d.shift], ['direct', 24000, { cents: -6000, categories: ['Hobbies'], setCents: 30000 }]);
  assert.match(d.basis, /\. Set here: \$300\.00, less \$60\.00 for Hobbies, now planned in Essentials$/);
  assert.equal(after.dialsByKey.essentials.shift, null);
  // Moved back: the adjustment goes with it.
  const back = T.setGroup(moved, 'Hobbies', null, after);
  assert.deepEqual([back.ui.plan.dials, shiftOf(back), back.ui.plan.groups, 'dialShift' in back.ui.plan], [{ flexible: 30000 }, {}, {}, false]);
  assert.equal(build(back).dialsByKey.flexible.planCents, 30000);
  // A second category adds to it; moving one back takes only its part out.
  const two = T.setGroup(moved, 'Dining & takeout', 'essentials', after);
  assert.deepEqual(shiftOf(two), { flexible: { cents: -15000, categories: ['Hobbies', 'Dining & takeout'] } });
  assert.equal(outTotal(build(two)), outTotal(tl));
  assert.match(build(two).dialsByKey.flexible.basis, /less \$150\.00 for Hobbies and Dining & takeout, now planned in Essentials$/);
  const one = T.setGroup(two, 'Hobbies', 'flexible', build(two));
  assert.deepEqual(shiftOf(one), { flexible: { cents: -9000, categories: ['Dining & takeout'] } });
});

test('setGroup with Essentials set directly: the moved category’s amount is added to Essentials; both or neither set: no adjustment', () => {
  const st = budget({ essentials: 40000 });
  const tl = build(st);
  const moved = T.setGroup(st, 'Hobbies', 'essentials', tl);
  assert.deepEqual([moved.ui.plan.dials, shiftOf(moved)], [{ essentials: 40000 }, { essentials: { cents: 6000, categories: ['Hobbies'] } }]);
  const after = build(moved);
  assert.equal(outTotal(after), outTotal(tl));
  assert.equal(after.dialsByKey.essentials.planCents, 46000);
  assert.match(after.dialsByKey.essentials.basis, /Set here: \$400\.00, plus \$60\.00 for Hobbies, now planned here$/);
  // Out of Essentials into Flexible (Flexible from history): the amount comes back off.
  const out = T.setGroup(st, 'Groceries', 'flexible', tl);
  assert.deepEqual(shiftOf(out), { essentials: { cents: -40000, categories: ['Groceries'] } });
  assert.equal(outTotal(build(out)), outTotal(tl));
  // Both set directly: their total already holds everything; neither: the baselines follow the move.
  for (const dials of [{ essentials: 40000, flexible: 30000 }, {}]) {
    const s = budget(dials);
    const t = build(s);
    const m = T.setGroup(s, 'Hobbies', 'essentials', t);
    assert.deepEqual([m.ui.plan.dials, shiftOf(m)], [dials, {}], JSON.stringify(dials));
    assert.equal(outTotal(build(m)), outTotal(t), JSON.stringify(dials));
  }
  // Without the timeline the amount is not known: refused while one dial is set directly (the screen always passes it).
  assert.throws(() => T.setGroup(st, 'Hobbies', 'essentials'), /can’t be moved while Essentials is set to an amount here and Flexible is not/);
  assert.match(T.moveBlocked(st, 'Hobbies', 'essentials'), /Reset Essentials, or set Flexible too, then move it\.$/);
  assert.equal(T.moveBlocked(st, 'Hobbies', 'essentials', tl), null);
});

test('a new amount set for the dial, or a reset, removes the adjustment; a workbook keeps it', () => {
  const st = budget({ flexible: 30000 });
  const moved = T.setGroup(st, 'Hobbies', 'essentials', build(st));
  const tl = build(moved);
  assert.deepEqual(shiftOf(T.setDial(moved, 'flexible', 25000)), {}, 'a new amount is chosen as the groups are now');
  assert.equal(build(T.setDial(moved, 'flexible', 25000)).dialsByKey.flexible.planCents, 25000);
  assert.deepEqual(shiftOf(T.setDial(moved, 'flexible', null)), {});
  assert.deepEqual(shiftOf(T.setDial(moved, 'irregular', 1000)), { flexible: { cents: -6000, categories: ['Hobbies'] } }, 'another dial leaves it');
  assert.deepEqual(shiftOf(T.resetDial(moved, 'flexible', tl)), {});
  assert.deepEqual(shiftOf(T.resetPlan(moved)), {});
  // Saved, loaded and through a workbook: kept as it is.
  const reloaded = load(JSON.parse(JSON.stringify(moved)));
  assert.deepEqual([shiftOf(reloaded.state), reloaded.notes], [shiftOf(moved), []]);
  const wb = E.state.exportWorkbook(moved, { now: '2033-01-06T00:00:00.000Z' });
  const imported = E.setupSync.importWorkbook(wb, PROFILE, DS).state;
  assert.deepEqual([imported.ui.plan.dials, shiftOf(imported)], [{ flexible: 30000 }, { flexible: { cents: -6000, categories: ['Hobbies'] } }]);
  const tlIn = build(imported);
  assert.deepEqual([tlIn.dialsByKey.flexible.planCents, tlIn.dialsByKey.flexible.shift], [24000, { cents: -6000, categories: ['Hobbies'], setCents: 30000 }]);
  assert.equal(tlIn.dialsByKey.flexible.basis, build(moved).dialsByKey.flexible.basis, 'the provenance reads the same after the round trip');
  assert.equal(outTotal(tlIn), outTotal(tl));
  // Moving it back after the round trip still takes exactly its part out.
  assert.equal('dialShift' in T.setGroup(imported, 'Hobbies', null, tlIn).ui.plan, false);
});

test('moving a category there and back, again and again: the total holds at every step and the adjustment goes back to nothing', () => {
  for (const dials of [{ flexible: 30000 }, { essentials: 40000 }]) {
    let st = budget(dials);
    const start = build(st);
    for (let trip = 1; trip <= 3; trip++) {
      st = T.setGroup(st, 'Hobbies', 'essentials', build(st));
      const there = build(st);
      assert.equal(outTotal(there), outTotal(start), JSON.stringify(dials) + ' trip ' + trip + ' there');
      assert.deepEqual(st.ui.plan.dials, dials);
      const key = Object.keys(dials)[0];
      assert.deepEqual(shiftOf(st), { [key]: { cents: key === 'flexible' ? -6000 : 6000, categories: ['Hobbies'] } });
      assert.deepEqual(there.dialsByKey[key].shift.categories, ['Hobbies'], 'the dial says what moved');
      assert.match(there.dialsByKey[key].basis, /for Hobbies, now planned /);
      st = T.setGroup(st, 'Hobbies', null, there);
      const back = build(st);
      assert.equal(outTotal(back), outTotal(start), JSON.stringify(dials) + ' trip ' + trip + ' back');
      assert.equal('dialShift' in st.ui.plan, false, 'no stale adjustment left in the saved budget');
      assert.deepEqual([back.dialsByKey[key].shift, back.dialsByKey[key].planCents, back.dialsByKey[key].basis.includes('Set here')], [null, dials[key], false]);
      assert.deepEqual(st.ui.plan.groups, {});
    }
  }
});

test('reset or edit either dial after moves: only that dial’s adjustment goes; the other one stays and still applies', () => {
  // Essentials set directly; Hobbies moved in (Essentials +$60). Then Flexible set directly too and
  // carried an adjustment of its own (as the one-time upgrade or an earlier move leaves it).
  let st = budget({ essentials: 40000 });
  st = T.setGroup(st, 'Hobbies', 'essentials', build(st));
  st = T.setDial(st, 'flexible', 30000);
  st = E.state.setPath(st, 'ui.plan.dialShift.flexible', { cents: -9000, categories: ['Dining & takeout'] });
  const both = build(st);
  assert.deepEqual([both.dialsByKey.essentials.planCents, both.dialsByKey.flexible.planCents], [46000, 21000]);
  // Reset Essentials: back to its baseline, its adjustment gone; Flexible's stays.
  const resetE = T.resetDial(st, 'essentials', both);
  assert.deepEqual([resetE.ui.plan.dials, shiftOf(resetE)], [{ flexible: 30000 }, { flexible: { cents: -9000, categories: ['Dining & takeout'] } }]);
  const tlE = build(resetE);
  assert.deepEqual([tlE.dialsByKey.essentials.source, tlE.dialsByKey.essentials.planCents, tlE.dialsByKey.flexible.planCents], ['baseline', tlE.dialsByKey.essentials.baselineCents, 21000]);
  // A new amount typed for Flexible: exactly that amount, its adjustment gone; Essentials' stays.
  const editF = T.setDial(st, 'flexible', 25000);
  assert.deepEqual(shiftOf(editF), { essentials: { cents: 6000, categories: ['Hobbies'] } });
  const tlF = build(editF);
  assert.deepEqual([tlF.dialsByKey.flexible.planCents, tlF.dialsByKey.flexible.shift, tlF.dialsByKey.essentials.planCents], [25000, null, 46000]);
  // Both edited or reset: nothing left at all.
  assert.equal('dialShift' in T.setDial(editF, 'essentials', 41000).ui.plan, false);
  assert.equal('dialShift' in T.resetPlan(st).ui.plan, false);
  // An adjustment applies only while its dial is set directly: cleared with "Use the rows".
  const rows = T.setDial(st, 'essentials', null);
  assert.deepEqual([shiftOf(rows), build(rows).dialsByKey.essentials.source], [{ flexible: { cents: -9000, categories: ['Dining & takeout'] } }, 'baseline']);
});

// ------------------------------------------------------------------ an amount set before names were resolved

test('Flexible set directly before: marked on loading, counted twice until the screen upgrade adds the adjustment; the amount stays', () => {
  const loaded = load(savedBefore(DS, { flexible: 30000 }));
  assert.equal(loaded.state.ui.plan.groupsRead, 'exact');
  const markNote = 'ui.plan.dials: imported category names are now read as the category they stand for (an imported “Natural gas” is Gas & heating, an essential), so spending may have moved between Essentials and Flexible since you set Flexible ($300.00). The next time Plan opens, the plan adds or takes off what moved, once, so nothing is counted twice or left out; the amount you set stays as it is.';
  assert.ok(loaded.notes.includes(markNote), 'the mark is noted');
  assert.equal(loaded.state.meta.migrationNotes.filter(n => n === markNote).length, 1);

  const tl = build(loaded.state);
  const old = asBefore(loaded.state, { 'Natural gas': 'flexible' });
  // As the household planned it: Essentials $400 (Groceries), Flexible $300 (which held the gas).
  assert.equal(spending(old), 70000);
  // The build reflects the saved budget: Flexible as set, Essentials' baseline now holds the gas too.
  assert.deepEqual([tl.dialsByKey.flexible.planCents, tl.dialsByKey.flexible.source, tl.dialsByKey.essentials.planCents], [30000, 'direct', 52000]);
  assert.equal(spending(tl), spending(old) + 12000, 'counted twice until the upgrade is applied');
  const note = 'Flexible is planned at $180.00: the $300.00 you set, less $120.00 for ' + GAS + ', so it is not counted twice.';
  assert.deepEqual(tl.migration.regroupDials, {
    moved: [{ category: 'Natural gas', from: 'flexible', to: 'essentials' }], set: 'flexible', cents: 12000,
    shift: { dial: 'flexible', setCents: 30000, cents: -12000, categories: ['Natural gas'], plannedCents: 18000 }, note: 'ui.plan.dialShift.flexible: ' + note,
  });
  assert.equal(tl.migration.note, note, 'shown once, without its path');

  const up = T.pendingUpgrade(tl);
  assert.deepEqual([up.steps, up.note], [['regroupDials'], note]);
  const after = up.apply(loaded.state);
  assert.deepEqual(after.ui.plan.dials, { flexible: 30000 }, 'the amount set stays as saved');
  assert.deepEqual(shiftOf(after), { flexible: { cents: -12000, categories: ['Natural gas'] } });
  assert.equal(after.ui.plan.groupsRead, 'resolved');
  assert.equal(after.meta.migrationNotes.filter(n => n === 'ui.plan.dialShift.flexible: ' + note).length, 1);
  const now = build(after);
  assert.equal(spending(now), spending(old), 'the month spends what the household planned');
  assert.deepEqual([now.dialsByKey.essentials.planCents, now.dialsByKey.flexible.planCents, now.dialsByKey.flexible.source], [52000, 18000, 'direct']);
  assert.match(now.dialsByKey.flexible.basis, /Set here: \$300\.00, less \$120\.00 for Natural gas, now planned in Essentials$/);
  assert.equal(now.migration, null);
  assert.equal(T.pendingUpgrade(now), null, 'nothing left to carry over');
  // Idempotent: applying again changes nothing; loading the upgraded budget does not mark it again.
  assert.deepEqual(up.apply(after), after);
  assert.deepEqual(up.apply(up.apply(after)), after);
  const again = load(JSON.parse(JSON.stringify(after)));
  assert.deepEqual([again.state.ui.plan, again.notes], [after.ui.plan, []]);
  assert.equal(T.pendingUpgrade(build(again.state)), null);
  // Through a workbook: the adjustment and its provenance are kept, and nothing runs again.
  const wb = E.state.exportWorkbook(after, { now: '2033-01-06T00:00:00.000Z' });
  const imported = E.setupSync.importWorkbook(wb, PROFILE, DS).state;
  assert.deepEqual([imported.ui.plan.dials, shiftOf(imported), imported.ui.plan.groupsRead], [{ flexible: 30000 }, shiftOf(after), 'resolved']);
  const tlIn = build(imported);
  assert.equal(T.pendingUpgrade(tlIn), null);
  assert.deepEqual([spending(tlIn), tlIn.dialsByKey.flexible.basis], [spending(old), now.dialsByKey.flexible.basis]);
});

test('Essentials set directly before: what moved is added to it, so the moved spending is not left out', () => {
  const loaded = load(savedBefore(DS, { essentials: 40000 }));
  assert.equal(loaded.state.ui.plan.groupsRead, 'exact');
  assert.match(loaded.notes.join(' '), /since you set Essentials \(\$400\.00\)\. The next time Plan opens, the plan adds or takes off what moved/);
  const tl = build(loaded.state);
  const old = asBefore(loaded.state, { 'Natural gas': 'flexible' });
  assert.equal(spending(old), 40000 + 27000);
  assert.equal(tl.dialsByKey.flexible.planCents, 15000, 'Flexible’s baseline no longer holds the gas');
  assert.equal(spending(tl), spending(old) - 12000, 'left out until the upgrade is applied');
  const note = 'Essentials is planned at $520.00: the $400.00 you set, plus $120.00 for ' + GAS + ', so it is not left out.';
  assert.deepEqual(tl.migration.regroupDials, {
    moved: [{ category: 'Natural gas', from: 'flexible', to: 'essentials' }], set: 'essentials', cents: 12000,
    shift: { dial: 'essentials', setCents: 40000, cents: 12000, categories: ['Natural gas'], plannedCents: 52000 }, note: 'ui.plan.dialShift.essentials: ' + note,
  });
  const up = T.pendingUpgrade(tl);
  const after = up.apply(loaded.state);
  assert.deepEqual([after.ui.plan.dials, shiftOf(after), after.ui.plan.groupsRead], [{ essentials: 40000 }, { essentials: { cents: 12000, categories: ['Natural gas'] } }, 'resolved']);
  assert.ok(after.meta.migrationNotes.includes('ui.plan.dialShift.essentials: ' + note));
  assert.equal(spending(build(after)), spending(old));
  assert.deepEqual(up.apply(after), after, 'safe to run twice');
});

test('set before, both set directly or the category grouped by the household: no adjustment, only the mark goes', () => {
  const both = load(savedBefore(DS, { essentials: 40000, flexible: 30000 }));
  assert.equal(both.state.ui.plan.groupsRead, 'exact');
  assert.match(both.notes.join(' '), /since you set Essentials \(\$400\.00\) and Flexible \(\$300\.00\)\. Together they still hold all of it, so both stay as you set them\./);
  const tlBoth = build(both.state);
  assert.deepEqual(tlBoth.migration.regroupDials, { moved: [{ category: 'Natural gas', from: 'flexible', to: 'essentials' }], set: null, cents: null, shift: null, note: null });
  assert.equal(tlBoth.migration.note, '');
  const upBoth = T.pendingUpgrade(tlBoth);
  assert.deepEqual(upBoth.steps, ['regroupDials']);
  const afterBoth = upBoth.apply(both.state);
  assert.deepEqual([afterBoth.ui.plan.dials, shiftOf(afterBoth), afterBoth.ui.plan.groupsRead], [{ essentials: 40000, flexible: 30000 }, {}, 'resolved']);
  assert.deepEqual(afterBoth.meta.migrationNotes, both.state.meta.migrationNotes, 'nothing changed, nothing noted');
  assert.equal(T.pendingUpgrade(build(afterBoth)), null);
  // The household's own group for the category (either group) is never treated as moved.
  for (const group of ['flexible', 'essentials']) {
    const chosen = load(savedBefore(DS, { flexible: 30000 }, { groups: { 'Natural gas': group } }));
    assert.equal(chosen.state.ui.plan.groupsRead, 'exact');
    const tl = build(chosen.state);
    assert.deepEqual(tl.migration.regroupDials, { moved: [], set: 'flexible', cents: null, shift: null, note: null }, group);
    const after = T.pendingUpgrade(tl).apply(chosen.state);
    assert.deepEqual([after.ui.plan.dials, shiftOf(after), after.ui.plan.groupsRead, after.meta.migrationNotes], [{ flexible: 30000 }, {}, 'resolved', chosen.state.meta.migrationNotes], group);
  }
});

test('set before, neither set directly: never marked; a new budget is never marked either', () => {
  const neither = load(savedBefore(DS, { p1: 500000, irregular: 2500 }));
  assert.equal(neither.state.ui.plan.groupsRead, 'resolved');
  assert.equal(neither.notes.some(n => /imported category names/.test(n)), false);
  assert.equal(build(neither.state).migration, null);
  const fresh = E.state.defaults(PROFILE, DS);
  assert.equal(fresh.ui.plan.groupsRead, 'resolved');
  assert.equal(E.state.cleanPlanUi({}).groupsRead, 'resolved');
  assert.equal(T.settings({ dials: { flexible: 30000 } }).groupsRead, 'resolved', 'a ui.plan never loaded through sanitize is not marked');
  const set = budget({ flexible: 30000 });
  assert.equal(build(set).migration, null);
  const reloaded = load(JSON.parse(JSON.stringify(set)));
  assert.deepEqual([reloaded.state.ui.plan.groupsRead, reloaded.notes], ['resolved', []]);
  // The upgrade entry itself: only the earlier shape with an amount applies.
  const entry = E.state.V5_UPGRADES.find(u => u.id === 'ui.plan.groupsRead');
  assert.equal(entry.applies(savedBefore(DS, { flexible: 0 })), true, '$0 is an amount');
  assert.equal(entry.applies(savedBefore(DS, { flexible: null })), false);
  assert.equal(entry.applies(JSON.parse(JSON.stringify(set))), false, 'saved since: carries groupsRead');
  for (const odd of [null, {}, { ui: null }, { ui: { plan: 'x' } }, { ui: { plan: { dials: 'x' } } }]) assert.equal(entry.applies(odd), false, JSON.stringify(odd));
});

test('set before, then changed after the timeline was built: left as it is; setting it on the screen ends the wait', () => {
  const loaded = load(savedBefore(DS, { flexible: 30000 }));
  const tl = build(loaded.state);
  // Changed some other way (e.g. setup sync) after the build: not the amount the plan worked from.
  const changed = E.state.setPath(loaded.state, 'ui.plan.dials.flexible', 25000);
  const after = T.pendingUpgrade(tl).apply(changed);
  assert.deepEqual([after.ui.plan.dials, shiftOf(after), after.ui.plan.groupsRead], [{ flexible: 25000 }, {}, 'resolved']);
  assert.equal(after.meta.migrationNotes.some(n => /^ui\.plan\.dialShift\./.test(n)), false, 'nothing changed, nothing noted');
  // Set on the plan screen: chosen as the groups are read now, so there is nothing left to carry over.
  assert.equal(T.setDial(loaded.state, 'flexible', 25000).ui.plan.groupsRead, 'resolved');
  assert.equal(T.setDial(loaded.state, 'essentials', 41000).ui.plan.groupsRead, 'resolved');
  assert.equal(T.setDial(loaded.state, 'irregular', 1000).ui.plan.groupsRead, 'exact');
  assert.equal(T.setDial(loaded.state, 'flexible', null).ui.plan.groupsRead, 'exact', 'clearing it sets nothing new');
  // A timeline built without the mark does nothing to a marked budget (the next build will).
  const unmarked = build(Object.assign({}, loaded.state, { ui: Object.assign({}, loaded.state.ui, { plan: Object.assign({}, loaded.state.ui.plan, { groupsRead: 'resolved' }) }) }));
  assert.equal(T.regroupDials(loaded.state, unmarked), loaded.state);
  // A card part kept for the amount set is left as saved (it applies while the plan amount equals it).
  const split = E.state.setPath(loaded.state, 'ui.plan.cardSplit.flexible', { cents: 30000, card: 10000 });
  const done = T.pendingUpgrade(build(split)).apply(split);
  assert.deepEqual([done.ui.plan.dials.flexible, done.ui.plan.cardSplit], [30000, { flexible: { cents: 30000, card: 10000 } }]);
});

test('set before: the plan amount never goes below $0, while the amount set stays', () => {
  const loaded = load(savedBefore(DS, { flexible: 5000 }));
  const tl = build(loaded.state);
  assert.deepEqual([tl.migration.regroupDials.cents, tl.migration.regroupDials.shift.cents, tl.migration.regroupDials.shift.plannedCents], [12000, -12000, 0]);
  assert.match(tl.migration.note, /^Flexible is planned at \$0\.00: the \$50\.00 you set, less \$120\.00 for /);
  const after = T.pendingUpgrade(tl).apply(loaded.state);
  assert.deepEqual([after.ui.plan.dials, build(after).dialsByKey.flexible.planCents], [{ flexible: 5000 }, 0]);
});

test('set before: aliases, the energy aggregate and split purchases move together; d is measured once over all of them', () => {
  const ds = dataset([['Natural gas', 120, 'Invented Gas Utility'], ['Electricity', 50, 'Invented Power Co'], ['Groceries', 400, 'Invented Market'],
    ['Dining & takeout', 90, 'Invented Diner'], ['Mixed retail', 150, 'Invented Warehouse Club']]);
  const raw = savedBefore(ds, { flexible: 40000 }, { targets: { [ENERGY]: 20000 } });
  // Each warehouse purchase split: $100 of it groceries (an imported label), $50 mixed retail.
  raw.ledgerEdits = {};
  for (const t of ds.transactions.filter(x => x.merchant === 'Invented Warehouse Club')) raw.ledgerEdits[t.id] = { splits: [{ category: 'Groceries & meal kits', cents: 10000 }, { category: 'Mixed retail', cents: 5000 }] };
  const loaded = load(raw, ds);
  assert.equal(loaded.state.ui.plan.groupsRead, 'exact');
  const tl = build(loaded.state, ds);
  const r = tl.migration.regroupDials;
  assert.deepEqual(r.moved.map(m => [m.category, m.from, m.to]), [['Electricity', 'flexible', 'essentials'], [ENERGY, 'flexible', 'essentials'],
    ['Groceries & meal kits', 'flexible', 'essentials'], ['Natural gas', 'flexible', 'essentials']]);
  // Essentials now: Groceries $400 + the energy budget $200 (gas and electricity in it at $0) + the split's $100.
  assert.equal(tl.dialsByKey.essentials.planCents, 70000);
  assert.deepEqual([r.cents, r.shift.cents, r.shift.plannedCents], [30000, -30000, 10000]);
  assert.equal(tl.migration.note, 'Flexible is planned at $100.00: the $400.00 you set, less $300.00 for “Electricity” (Electric), “' + ENERGY + '” (Gas & heating + Electric), “Groceries & meal kits” (Groceries) and “Natural gas” (Gas & heating), now read as the categories they stand for and planned in Essentials, so they are not counted twice.');
  const old = asBefore(loaded.state, Object.fromEntries(r.moved.map(m => [m.category, m.from])), ds);
  const after = T.pendingUpgrade(tl).apply(loaded.state);
  assert.deepEqual(after.ui.plan.dials, { flexible: 40000 });
  assert.equal(spending(build(after, ds)), spending(old));
  assert.equal(spending(old), 40000 + 40000);
});

test('set before: d is what the group not set directly plans, so a change saved for the moved category’s row counts at that amount', () => {
  // While Natural gas was flexible the household lowered its row to $100 (then set Flexible directly,
  // which won). Under the reading now the change applies to its Essentials row (migrateRows moves it),
  // so Essentials grows by $100, not by the $120 baseline.
  const flexOld = build(Object.assign({}, load(savedBefore(DS, {})).state, { ui: { plan: { groups: { 'Natural gas': 'flexible' } } } }));
  const gasFlexId = catRow(flexOld, 'flexible', 'Natural gas').id;
  const loaded = load(savedBefore(DS, { flexible: 30000 }, { rows: { [gasFlexId]: { cents: 10000 } } }));
  const tl = build(loaded.state);
  assert.equal(catRow(tl, 'essentials', 'Natural gas').planCents, 10000);
  assert.deepEqual([tl.migration.regroupDials.cents, tl.migration.regroupDials.shift.cents], [10000, -10000]);
  const up = T.pendingUpgrade(tl);
  assert.deepEqual(up.steps, ['migrateRows', 'regroupDials']);
  assert.match(up.note, /moved with its category to the other group.* Flexible is planned at \$200\.00: the \$300\.00 you set, less \$100\.00 for /);
  const after = up.apply(loaded.state);
  assert.deepEqual([after.ui.plan.dials, shiftOf(after)], [{ flexible: 30000 }, { flexible: { cents: -10000, categories: ['Natural gas'] } }]);
  // As planned before: Essentials $400 + Flexible $300 (the gas row change did not count under a direct Flexible).
  assert.equal(spending(build(after)), 70000);
  assert.deepEqual(up.apply(after), after);
});

test('plan report: a workbook saved before names were resolved is reported as the Plan screen shows it, upgrade applied and named', () => {
  const R = require('../../tools/plan-report.cjs');
  const wb = JSON.parse(E.state.exportWorkbook(E.state.defaults(PROFILE, DS)));
  wb.state = savedBefore(DS, { flexible: 30000 });
  const r = R.buildReport({ E, dataset: DS, profile: PROFILE, workbookText: JSON.stringify(wb), today: '2033-01-06', sample: false });
  const flex = r.dials.find(d => d.key === 'flexible');
  assert.deepEqual([flex.valueCents, flex.source], [18000, 'direct'], 'the adjustment applies, as on the Plan screen');
  assert.match(flex.basis, /Set here: \$300\.00, less \$120\.00 for Natural gas, now planned in Essentials$/);
  assert.deepEqual(r.setup.upgrade, { steps: ['regroupDials'], note: 'Flexible is planned at $180.00: the $300.00 you set, less $120.00 for ' + GAS + ', so it is not counted twice.' });
  assert.match(R.toMarkdown(E, r), /- Applied as the Plan screen does when it opens \(regroupDials\): Flexible is planned at \$180\.00: /);
  // A budget with nothing waiting: no upgrade line.
  assert.equal(R.buildReport({ E, dataset: DS, profile: PROFILE, today: '2033-01-06', sample: false }).setup.upgrade, null);
});

// ------------------------------------------------------------------ moves the adjustment cannot measure are refused

test('with one spending dial set directly ($0 included), a whole place, a category in "Other" and a combined budget’s member cannot be moved; saved state is unchanged', () => {
  // Two categories under $20 a month share the "Other" row; the energy budget plans its members at $0.
  const ds = dataset(HISTORY.concat([['Postage', 10, 'Invented Post Office'], ['Shoe repair', 8, 'Invented Cobbler'], ['Electricity', 100, 'Invented Power Co']]));
  const withEnergy = dials => {
    let st = E.state.defaults({ isSynthetic: true, household: { name: 'Invented household' }, plan: planOf({ targets: { [ENERGY]: 30000 } }) }, ds);
    for (const [k, v] of Object.entries(dials)) st = T.setDial(st, k, v);
    return st;
  };
  const cases = [
    ['merchant:Invented Craft Shop', 'essentials', /^A whole place can’t be moved/],
    ['Postage', 'essentials', /^A category grouped into “Other” can’t be moved/],
    ['Electricity', 'flexible', /^A category planned through a combined budget can’t be moved/],
    [ENERGY, 'flexible', /^A combined budget can’t be moved/],
  ];
  for (const dials of [{ flexible: 40000 }, { essentials: 40000 }, { flexible: 0 }, { essentials: 0 }]) {
    const st = withEnergy(dials);
    const tl = build(st, ds);
    const total = outTotal(tl);
    for (const [key, to, reason] of cases) {
      const label = key + ' with ' + JSON.stringify(dials);
      assert.match(T.moveBlocked(st, key, to, tl) || '', reason, label);
      // Refused every time it is tried, with the same reason; nothing saved, the total unchanged.
      for (let i = 0; i < 3; i++) assert.throws(() => T.setGroup(st, key, to, tl), err => reason.test(err.message), label);
      assert.deepEqual([st.ui.plan.dials, st.ui.plan.groups, st.ui.plan.dialShift], [dials, {}, undefined], label);
      assert.equal(outTotal(build(st, ds)), total, label);
    }
    // A category with a row of its own still moves, with its adjustment, and the total holds;
    // out of a dial set to less than its amount ($0 here) it would not: refused, with the reason.
    const [key, to] = dials.flexible !== undefined ? ['Hobbies', 'essentials'] : ['Groceries', 'flexible'];
    if (Object.values(dials)[0] === 0) {
      assert.throws(() => T.setGroup(st, key, to, tl), err => /can’t be moved out of (Flexible|Essentials): \1 is set to \$0\.00 here, less than its \$[\d,]+\.\d\d a month/.test(err.message), key);
    } else {
      assert.equal(outTotal(build(T.setGroup(st, key, to, tl), ds)), total, key + ' with ' + JSON.stringify(dials));
    }
    // Into the dial set to $0: added to it, the total holds.
    const [inKey, inTo] = dials.flexible !== undefined ? ['Groceries', 'flexible'] : ['Hobbies', 'essentials'];
    assert.equal(outTotal(build(T.setGroup(st, inKey, inTo, tl), ds)), total, inKey + ' into ' + JSON.stringify(dials));
  }
  // Both set directly, or neither: every move keeps the total, so none is refused.
  for (const dials of [{ essentials: 40000, flexible: 30000 }, {}]) {
    const st = withEnergy(dials);
    const tl = build(st, ds);
    for (const [key, to] of cases) {
      assert.equal(T.moveBlocked(st, key, to, tl), null, key);
      const m = T.setGroup(st, key, to, tl);
      if (Object.keys(dials).length) assert.equal(outTotal(build(m, ds)), outTotal(tl), key);
    }
  }
  // Putting back a place moved earlier (while neither dial was set) is a move too.
  const placed = T.setGroup(withEnergy({}), 'merchant:Invented Craft Shop', 'essentials', build(withEnergy({}), ds));
  const later = T.setDial(placed, 'flexible', 40000);
  assert.match(T.moveBlocked(later, 'merchant:Invented Craft Shop', null, build(later, ds)), /^A whole place can’t be moved/);
});
