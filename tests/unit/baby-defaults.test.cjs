'use strict';
// Tests for BudgetEngine.babyDefaults: the baby-cost defaults (setup, supplies, childcare with its
// yearly membership fee), their timing, the one canonical group and counting each cost once.
// Every household, date, amount and id here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const S = E.state;
const B = E.babyDefaults;
const L = E.ledger;

const DS = { datasetId: 'invented-baby' };
const T0 = '2031-03-01T09:00:00.000Z';
const copy = v => JSON.parse(JSON.stringify(v));
const byId = (list, id) => list.find(x => x.id === id);
const ids = st => st.plan.changes.map(c => c.id);

/** An invented setup file; `scenario` adds a saved baby what-if (copied into plan.changes as 'sc-…'). */
function profile({ due, scenario = false, events } = {}) {
  const p = {
    schemaVersion: 1,
    isSynthetic: true,
    household: { name: 'Robin & Casey (invented)', people: [{ id: 'p1', name: 'Robin' }, { id: 'p2', name: 'Casey' }] },
    plan: {
      people: [{ id: 'p1', name: 'Robin' }, { id: 'p2', name: 'Casey' }],
      incomes: [{ id: 'pay-c', label: 'Casey pay', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: 140000, jointPerPaycheckCents: 100000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2031-01-03', status: 'confirmed' }],
      settings: Object.assign({ incomeTiming: 'average' }, due ? { babyDueDate: due } : {}),
    },
    notes: ['Invented for tests.'],
  };
  if (scenario) {
    p.scenarios = [{
      id: 'arrival', name: 'Little one arrives (Aug 2031)',
      events: events || [
        { id: 'supplies', type: 'recurring', label: 'Baby supplies', startMonth: '2031-08', endMonth: null, monthlyCents: null, direction: 'expense', category: 'Baby & childcare' },
        { id: 'birth', type: 'one_time', label: 'Birth and hospital costs', month: '2031-08', amountCents: null, direction: 'expense', category: 'Medical & pharmacy' },
        { id: 'leave', type: 'income_change', label: 'Casey parental leave', streamId: 'pay-c', startMonth: '2031-08', endMonth: '2031-10', jointPerPaycheckCents: null },
        { id: 'care', type: 'recurring', label: 'Childcare', startMonth: '2031-12', endMonth: null, monthlyCents: null, direction: 'expense', category: 'Baby & childcare' },
      ],
    }];
  }
  return p;
}
/** A new budget from the setup file, synced (as the page opens it), before the defaults ran. */
const opened = prof => E.setupSync.apply(S.defaults(prof, DS, { now: T0 }), prof, { now: T0 }).state;
const GROUP = 'Little one arrives (Aug 2031)';

// ------------------------------------------------------------------ timing

test('an exact due date: setup the month before, supplies from the birth month, childcare from the month of date + 42 days', () => {
  const st = opened(profile({ due: '2031-08-03' }));
  const r = B.ensure(st, { now: T0 });
  assert.equal(r.changed, true);
  assert.deepEqual(ids(r.state).filter(id => id.startsWith('baby-default-')), ['baby-default-setup', 'baby-default-supplies', 'baby-default-childcare']);
  const [setup, supplies, care] = ['setup', 'supplies', 'childcare'].map(k => byId(r.state.plan.changes, 'baby-default-' + k));
  assert.deepEqual([setup.kind, setup.startMonth, setup.cents, setup.group], ['oneTime', '2031-07', 200000, 'irregular']);
  assert.deepEqual([supplies.kind, supplies.startMonth, supplies.endMonth, supplies.cents], ['monthly', '2031-08', null, 45000]);
  assert.deepEqual([care.kind, care.startMonth, care.cents, care.yearlyCents], ['monthly', '2031-09', 180000, 15000], '3 Aug + 42 days = 14 Sep');
  for (const c of [setup, supplies, care]) {
    assert.equal(c.accepted, true, 'the defaults are included');
    assert.equal(c.scenario, 'New baby', 'no copied what-if: one new group');
    assert.match(c.label, /\(estimate\)$/);
    assert.equal(c.derived.precision, 'day');
    assert.equal(c.derived.startMonth, c.startMonth);
  }
  assert.match(supplies.note, /feeding \$200, diapers and wipes \$100, clothing \$50, care \$35, toys \$25 and a \$40 contingency/);
  assert.match(care.note, /not a booking/);
  assert.deepEqual(r.state.meta.babyDefaults, { done: ['setup', 'supplies', 'childcare'] });
  assert.equal(r.state.meta.updatedAt, T0);
  assert.equal(st.plan.changes.length, 0, 'the input is not changed');
  const status = B.status(r.state);
  assert.deepEqual([status.timing, status.dueDate, status.birthMonth, status.group], ['day', '2031-08-03', '2031-08', 'New baby']);
  assert.match(status.caveat, /medical costs, insurance premium changes and parental-leave pay are unknown, not \$0/);
  // A date late in the month: + 42 days crosses two month ends.
  const late = B.ensure(opened(profile({ due: '2031-08-25' }))).state;
  assert.equal(byId(late.plan.changes, 'baby-default-childcare').startMonth, '2031-10');
});

test('no due date: a copied baby what-if gives a month-level estimate (flagged), childcare two months after the birth month', () => {
  const st = opened(profile({ scenario: true }));
  assert.ok(st.plan.changes.some(c => c.id === 'sc-care'), 'the what-if was copied');
  const r = B.ensure(st);
  const care = byId(r.state.plan.changes, 'sc-care');
  assert.deepEqual([care.startMonth, care.cents, care.yearlyCents, care.accepted, care.label], ['2031-10', 180000, 15000, true, 'Childcare (estimate)'], 'the untouched placeholder is filled and re-timed');
  assert.equal(care.derived.precision, 'month');
  const supplies = byId(r.state.plan.changes, 'sc-supplies');
  assert.deepEqual([supplies.startMonth, supplies.cents, supplies.accepted], ['2031-08', 45000, true]);
  const setup = byId(r.state.plan.changes, 'baby-default-setup');
  assert.deepEqual([setup.startMonth, setup.scenario, setup.derived.precision], ['2031-07', GROUP, 'month'], 'added to the same group');
  assert.ok(!byId(r.state.plan.changes, 'baby-default-supplies') && !byId(r.state.plan.changes, 'baby-default-childcare'), 'filled placeholders, not extra rows');
  for (const id of ['sc-birth', 'sc-leave']) assert.deepEqual(byId(r.state.plan.changes, id), byId(st.plan.changes, id), id + ' stays unknown, as copied');
  assert.match(r.notes.join(' '), /birth month .*an estimate until you enter the due date/);
  const status = B.status(r.state);
  assert.deepEqual([status.timing, status.dueDate, status.birthMonth, status.group], ['month', null, '2031-08', GROUP]);
});

test('no due date and no baby what-if: timing unknown, nothing written or applied; the defaults are listed as "date needed"', () => {
  const st = opened(profile());
  const r = B.ensure(st, { now: T0 });
  assert.equal(r.changed, false);
  assert.equal(r.state, st, 'the same budget back');
  assert.deepEqual(r.notes, [], 'asked for only in the settings');
  const status = B.status(st);
  assert.equal(status.timing, 'unknown');
  assert.deepEqual(status.items.map(it => [it.role, it.cents, it.startMonth, it.dateNeeded]), [['setup', 200000, null, true], ['supplies', 45000, null, true], ['childcare', 180000, null, true]]);
});

test('the due date the household saved in the app wins over the setup file’s (the setup sync merge rule)', () => {
  const prof = profile({ due: '2031-08-03' });
  let st = B.ensure(opened(prof)).state;
  st = S.setPath(st, 'plan.settings.babyDueDate', '2031-09-20');
  st = B.follow(opened(prof), st);
  const prof2 = profile({ due: '2031-08-10' });
  const synced = E.setupSync.apply(st, prof2, { now: T0 }).state;
  assert.equal(synced.plan.settings.babyDueDate, '2031-09-20', 'saved here: kept');
  const r = B.ensure(synced);
  assert.equal(r.changed, false);
  assert.equal(byId(r.state.plan.changes, 'baby-default-childcare').startMonth, '2031-11', '20 Sep + 42 days = 1 Nov');
  // Left alone here, a new date in the setup file flows in.
  const fresh = B.ensure(opened(prof)).state;
  const flowed = E.setupSync.apply(fresh, prof2, { now: T0 }).state;
  assert.equal(flowed.plan.settings.babyDueDate, '2031-08-10');
});

test('a new due date re-times only start months still as the defaults wrote them', () => {
  let st = B.ensure(opened(profile({ due: '2031-08-03' }))).state;
  st = E.timeline.setChange(st, 'baby-default-supplies', { startMonth: '2031-09' });
  const prev = st;
  st = S.setPath(st, 'plan.settings.babyDueDate', '2031-10-12');
  const next = B.follow(prev, st, { now: T0 });
  assert.equal(byId(next.plan.changes, 'baby-default-setup').startMonth, '2031-09');
  assert.equal(byId(next.plan.changes, 'baby-default-childcare').startMonth, '2031-11', '12 Oct + 42 days = 23 Nov');
  assert.equal(byId(next.plan.changes, 'baby-default-supplies').startMonth, '2031-09', 'moved by the household: kept');
  assert.equal(byId(next.plan.changes, 'baby-default-childcare').derived.startMonth, '2031-11');
  assert.equal(B.follow(next, next), next, 'the same date: nothing to do');
  assert.equal(B.ensure(next).changed, false, 'and running it again changes nothing');
});

test('in a copied group: a date the household moved, an explicit $0 and an amount left unaccepted are kept; defaults are added beside them', () => {
  const base = opened(profile({ scenario: true }));
  const st = copy(base);
  byId(st.plan.changes, 'sc-care').startMonth = '2032-01';                    // moved by the household
  Object.assign(byId(st.plan.changes, 'sc-supplies'), { cents: 0, accepted: true }); // an explicit $0, included
  st.plan.changes.push({ id: 'my-gear', label: 'Stroller and car seat', kind: 'oneTime', group: 'irregular', personId: null, startMonth: '2031-06', endMonth: null, cents: 90000, accepted: false, template: null, scenario: GROUP, note: '' });
  const r = B.ensure(S.sanitize(st, profile({ scenario: true }), DS).state);
  const care = byId(r.state.plan.changes, 'sc-care');
  assert.deepEqual([care.startMonth, care.cents, care.accepted], ['2032-01', null, false], 'not provably untouched: left alone');
  assert.deepEqual([byId(r.state.plan.changes, 'sc-supplies').cents, byId(r.state.plan.changes, 'sc-supplies').accepted], [0, true], 'the $0 stays');
  assert.equal(byId(r.state.plan.changes, 'baby-default-supplies'), undefined, 'supplies are covered by the household’s own $0');
  const gear = byId(r.state.plan.changes, 'my-gear');
  assert.deepEqual([gear.cents, gear.accepted], [90000, false], 'an amount left unaccepted is a choice: kept');
  assert.ok(byId(r.state.plan.changes, 'baby-default-setup'), 'the setup default is added');
  assert.ok(byId(r.state.plan.changes, 'baby-default-childcare'), 'childcare gets the default row; the moved placeholder stays as it is');
});

// ------------------------------------------------------------------ the plan: counted once

let seq = 0;
function txn(date, cents, fields) {
  seq += 1;
  return Object.assign({ id: 'bd' + String(seq).padStart(4, '0'), accountId: 'chk', date, description: 'BD ROW ' + seq, amountCents: cents, kind: 'spend', category: 'Groceries', merchant: 'Maple Grocer' }, fields || {});
}
/** Three covered months (Jan to Mar 2031): the plan starts in April 2031. */
function dataset() {
  const txns = [];
  for (const m of ['01', '02', '03']) {
    txns.push(txn(`2031-${m}-05`, 300000, { kind: 'income', subtype: 'payroll', category: 'Income', merchant: 'Quillfield Co', description: 'QUILLFIELD PAYROLL', personId: 'p2' }));
    txns.push(txn(`2031-${m}-09`, -50000));
  }
  return L.normalizeDataset({ schemaVersion: 2, datasetId: 'invented-baby', isSynthetic: true,
    accounts: [{ id: 'chk', label: 'Test checking', type: 'checking', scope: 'joint', coverage: [{ start: '2031-01-01', end: '2031-03-31' }] }], transactions: txns });
}
const DSET = dataset();
const build = (st, compare) => E.timeline.build({ txns: L.applyEdits(DSET, st.ledgerEdits), dataset: DSET, plan: st.plan, settings: Object.assign({}, st.ui.plan, { horizon: 24 }), today: '2031-04-02', compare });
const monthOf = (tl, m) => tl.months.find(r => r.month === m);
const changeOf = (tl, id) => tl.changes.list.find(c => c.id === id);

test('the plan counts each default once: setup in its month, supplies monthly, childcare with its yearly fee in the first care month and every 12 months after', () => {
  const st = B.ensure(opened(profile({ due: '2031-05-20' }))).state; // setup Apr, supplies May, childcare from Jul (20 May + 42 = 1 Jul)
  const tl = build(st);
  assert.equal(tl.planStart, '2031-04');
  const base = tl.plan.out.total;
  const extra = m => monthOf(tl, m).out.total - base;
  assert.equal(extra('2031-04'), 200000);
  assert.equal(extra('2031-05'), 45000);
  assert.equal(extra('2031-06'), 45000);
  assert.equal(extra('2031-07'), 45000 + 180000 + 15000, 'the membership fee in the first care month');
  assert.equal(extra('2031-08'), 225000);
  assert.equal(extra('2032-06'), 225000);
  assert.equal(extra('2032-07'), 240000, 'and 12 months later');
  // The months' applied list holds each change once, with that month's amount.
  for (const r of tl.months.filter(x => x.month >= tl.planStart)) {
    const seen = r.changesApplied.map(a => a.id);
    assert.equal(new Set(seen).size, seen.length, r.month + ': nothing applied twice');
    assert.equal(r.changesApplied.reduce((s, a) => s + a.cents, 0), r.out.total - base, r.month + ': the applied amounts are the whole difference');
  }
  assert.equal(byId(monthOf(tl, '2031-07').changesApplied, 'baby-default-childcare').cents, 195000);
  // tl.summary is the first plan month: the setup cost.
  assert.deepEqual(tl.summary.changes.items.map(a => [a.id, a.cents]), [['baby-default-setup', 200000]]);
  assert.equal(tl.summary.changes.outCents, 200000);
  const care = changeOf(tl, 'baby-default-childcare');
  assert.deepEqual([care.status, care.monthsApplied, care.appliedCents, care.yearlyCents, care.babyRole, care.precision], ['applied', 21, 21 * 180000 + 2 * 15000, 15000, 'childcare', 'day']);
  assert.equal(tl.changes.totalOneTimeCents, 200000);
  assert.deepEqual(tl.changes.overlaps, []);
});

test('an alternative childcare quote stays unaccepted, is never added on top of the default, and replaces it (fee not doubled) once chosen', () => {
  const st0 = copy(opened(profile({ scenario: true, events: [
    { id: 'supplies', type: 'recurring', label: 'Baby supplies', startMonth: '2031-05', endMonth: null, monthlyCents: null, direction: 'expense', category: 'Baby & childcare' },
    { id: 'care', type: 'recurring', label: 'Childcare', startMonth: '2031-05', endMonth: null, monthlyCents: null, direction: 'expense', category: 'Baby & childcare' },
  ] })));
  st0.plan.changes.push({ id: 'quote-oaks', label: 'Childcare quote: Little Oaks', kind: 'monthly', group: 'essentials', personId: null, startMonth: '2031-08', endMonth: null, cents: 210000, accepted: false, template: null, scenario: 'Little one arrives (Aug 2031)', note: '' });
  const st = B.ensure(st0).state;
  assert.deepEqual([byId(st.plan.changes, 'quote-oaks').accepted, byId(st.plan.changes, 'quote-oaks').cents], [false, 210000], 'not activated alongside the default');
  assert.equal(byId(st.plan.changes, 'sc-care').startMonth, '2031-07', 'the untouched placeholder (at the birth month) becomes the default, two months on');
  let tl = build(st);
  assert.equal(changeOf(tl, 'quote-oaks').status, 'notAccepted');
  assert.equal(changeOf(tl, 'sc-care').status, 'applied');
  const cmp = build(st, GROUP).compare;
  assert.ok(!cmp.addedIds.includes('quote-oaks'), 'the what-if comparison does not add the alternative on top either');
  // Chosen: the quote counts, the default is held back (its fee too), and the overlap is named.
  const chosen = E.timeline.acceptChanges(st, ['quote-oaks']);
  tl = build(chosen);
  assert.equal(changeOf(tl, 'sc-care').status, 'overlap');
  assert.deepEqual(tl.changes.overlaps.map(o => [o.kind, o.role, o.id, o.with]), [['alternative', 'childcare', 'sc-care', ['quote-oaks']]]);
  const base = tl.plan.out.total;
  assert.equal(monthOf(tl, '2031-08').out.total - base, 45000 + 210000, 'supplies and the chosen quote, no default childcare, no second fee');
  assert.ok(byId(chosen.plan.changes, 'sc-care'), 'nothing removed');
});

test('a New baby pack accepted beside the defaults is flagged and counted once (the defaults it covers are held back)', () => {
  const st = B.ensure(opened(profile({ due: '2031-06-10' }))).state;
  const pack = E.timeline.templates.babyFirstYear('2031-06-10', { scenario: 'New baby' }).map(x => Object.assign(x, { accepted: true }));
  const withPack = E.timeline.addChange(st, pack);
  const tl = build(withPack);
  const held = tl.changes.overlaps.filter(o => o.kind === 'pack').map(o => [o.role, o.id, o.template]);
  assert.deepEqual(held, [['setup', 'baby-default-setup', 'babyFirstYear'], ['supplies', 'baby-default-supplies', 'babyFirstYear']]);
  assert.equal(changeOf(tl, 'baby-default-setup').status, 'overlap');
  assert.equal(changeOf(tl, 'baby-default-childcare').status, 'applied', 'the pack has no childcare');
  for (const r of tl.months) assert.ok(!r.changesApplied.some(a => a.id === 'baby-default-supplies'), r.month + ': supplies counted once (the pack’s)');
  assert.equal(withPack.plan.changes.length, st.plan.changes.length + pack.length, 'nothing deleted');
  // Unaccepted, the pack no longer holds anything back.
  const off = E.timeline.acceptChanges(withPack, withPack.plan.changes.filter(c => c.template).map(c => c.id), false);
  assert.deepEqual(build(off).changes.overlaps, []);
});

// ------------------------------------------------------------------ keeping the household's edits

test('idempotent, and later edits survive reload and a workbook round trip; a removed default is not made again', () => {
  const prof = profile({ scenario: true, due: '2031-08-03' });
  let st = B.ensure(opened(prof), { now: T0 }).state;
  assert.equal(B.ensure(st).state, st, 'a second run is a no-op');
  st = E.timeline.setChange(st, 'sc-supplies', { cents: 38000 });
  st = E.timeline.removeChange(st, 'baby-default-setup');
  const reloaded = S.sanitize(copy(st), prof, DS);
  assert.deepEqual(reloaded.notes, []);
  assert.deepEqual(B.ensure(reloaded.state).state, reloaded.state);
  const text = S.exportWorkbook(st, { now: T0 });
  const imported = E.setupSync.importWorkbook(text, prof, DS, { now: T0 }).state;
  const again = B.ensure(imported, { now: T0 });
  assert.equal(again.changed, false);
  assert.equal(byId(again.state.plan.changes, 'sc-supplies').cents, 38000, 'the household’s amount stays');
  assert.equal(byId(again.state.plan.changes, 'baby-default-setup'), undefined, 'removed by the household: not made again');
  assert.deepEqual(byId(again.state.plan.changes, 'sc-care').derived, byId(st.plan.changes, 'sc-care').derived);
  assert.deepEqual(again.state.meta.babyDefaults, { done: ['setup', 'supplies', 'childcare'] });
});

test('the saved format: babyDueDate, yearlyCents and derived are optional fields checked like the rest', () => {
  const st = B.ensure(opened(profile({ due: '2031-08-03' }))).state;
  assert.throws(() => S.setPath(st, 'plan.settings.babyDueDate', '2031-13-01'), err => err instanceof E.ValidationError);
  assert.equal(S.setPath(st, 'plan.settings.babyDueDate', null).plan.settings.babyDueDate, null, 'cleared: not known');
  assert.throws(() => S.setPath(st, 'plan.changes[id=baby-default-childcare].yearlyCents', 15.5), err => err instanceof E.ValidationError);
  const bad = copy(st);
  bad.plan.changes.find(c => c.id === 'baby-default-childcare').yearlyCents = 'lots';
  const r = S.sanitize(bad, profile(), DS);
  assert.equal(byId(r.state.plan.changes, 'baby-default-childcare').yearlyCents, null, 'an unreadable amount becomes unknown, never $0');
  assert.equal(S.VERSION, 5);
  assert.equal(B.roleOf({ label: 'Day care (part-time)', group: 'essentials' }), 'childcare');
  assert.equal(B.roleOf({ label: 'Casey parental leave', group: 'income' }), null, 'leave lowers income: never a default’s cost');
});
