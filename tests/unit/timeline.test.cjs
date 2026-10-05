'use strict';
// Tests for BudgetEngine.timeline: the plan screen's months, dials, drill-down and balances.
// Every household, merchant, date and amount here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const L = E.ledger;
const T = E.timeline;

let seq = 0;
function row(accountId, date, amountCents, fields = {}) {
  seq += 1;
  return Object.assign({ id: 'tl' + String(seq).padStart(5, '0'), accountId, date, description: 'TL ROW ' + seq, amountCents, kind: 'spend', category: 'Groceries' }, fields);
}
const spend = (acct, date, cents, merchant, category, extra = {}) => row(acct, date, -cents, Object.assign({ merchant, category, description: merchant.toUpperCase() + ' 7731' }, extra));
const deposit = (date, cents, personId, extra = {}) => row('chk', date, cents, Object.assign({ kind: 'income', subtype: 'payroll', category: 'Income', merchant: 'Fernhill Labs', description: 'FERNHILL LABS PAYROLL', personId }, extra));
const fromPartner = (date, cents, personId) => row('chk', date, cents, { kind: 'transfer', subtype: 'contribution', category: 'Transfer', merchant: 'Transfer', description: 'ONLINE XFER FROM 5520', personId });
const toSavings = (date, cents) => {
  const out = row('chk', date, -cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings', description: 'XFER TO SAV' });
  const inn = row('sav', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings', description: 'XFER FROM CHK', pairId: out.id });
  out.pairId = inn.id;
  return [out, inn];
};
const cardPayment = (date, cents) => {
  const out = row('chk', date, -cents, { kind: 'card_payment', category: 'Card payment', merchant: 'Card payment', description: 'TL CARD AUTOPAY' });
  const inn = row('card', date, cents, { kind: 'card_payment', category: 'Card payment', merchant: 'Card payment', description: 'PAYMENT RECEIVED', pairId: out.id });
  out.pairId = inn.id;
  return [out, inn];
};

function dataset(txns, { from, to, withSavings = false, savingsCoverage } = {}) {
  const cover = [{ start: from, end: to }];
  const accounts = [
    { id: 'chk', label: 'Test checking', type: 'checking', scope: 'joint', coverage: cover },
    { id: 'card', label: 'Test card', type: 'credit_card', scope: 'joint', coverage: cover, paidInFull: true },
  ];
  if (withSavings) accounts.push({ id: 'sav', label: 'Test savings', type: 'savings', scope: 'joint', coverage: savingsCoverage || cover });
  return L.normalizeDataset({ schemaVersion: 2, datasetId: 'timeline-test', isSynthetic: true, accounts, transactions: txns });
}
const PEOPLE = [{ id: 'p1', name: 'Morgan' }, { id: 'p2', name: 'Ellis' }];
const planWith = (balances = {}) => ({ people: PEOPLE, incomes: [], bills: [], debts: [], targets: {}, savings: [], personalSpending: [], balances: Object.assign({ jointCashCents: null, asOf: null, accounts: {}, accountsAsOf: null, accountDates: {} }, balances) });
function run(ds, { plan = planWith(), settings = {}, edits = {}, today = '2026-06-12' } = {}) {
  return T.build({ txns: L.applyEdits(ds, edits), dataset: ds, plan, settings, today });
}
const point = (line, month) => line.points.find(p => p.month === month);
const account = (r, id) => r.balances.accounts.find(a => a.id === id);

// ------------------------------------------------------------------ a small household (balances)
// Checking and a card, covered 1 March to 31 May 2026. Each month: pay in, a mortgage, groceries.
function small({ withSavings = false } = {}) {
  const txns = [];
  for (const [m, grocer] of [['03', 15000], ['04', 16125], ['05', 17040]]) {
    txns.push(spend('chk', `2026-${m}-02`, 120000, 'Westbrook Home Loans', 'Mortgage'));
    txns.push(deposit(`2026-${m}-06`, 200000, 'p1'));
    txns.push(spend('card', `2026-${m}-10`, grocer, 'Harbor Grocer', 'Groceries'));
    if (withSavings) txns.push(...toSavings(`2026-${m}-20`, 10000));
  }
  return dataset(txns, { from: '2026-03-01', to: '2026-05-31', withSavings });
}
// Plan net −45,000 a month: 2,000 in; 1,500 card, 950 bank, 0 to savings.
const LOSING = { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 95000, savings: 0 } };

test('an entered balance is used at its exact date and worked back to the day before the export starts, never further', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-06-10' } }), settings: LOSING });
  const chk = account(r, 'chk');
  assert.deepEqual(chk.anchor, { date: '2026-06-10', cents: 350000, source: 'entered', label: 'Entered by you, Jun 10, 2026' }, 'the date is never moved');
  assert.equal(r.planStart, '2026-06');
  assert.equal(r.lastComplete, '2026-05');
  // Backward through the covered transactions: 3 months of +2,000 − 1,200 on checking. The balance
  // is dated 10 June and the export ends 31 May, so every one of these rests on 1–10 June having
  // no transactions: they are assumed, not history.
  assert.deepEqual(['2026-02', '2026-03', '2026-04', '2026-05'].map(m => [point(chk, m).cents, point(chk, m).status]),
    [[110000, 'assumed'], [190000, 'assumed'], [270000, 'assumed'], [350000, 'assumed']]);
  assert.equal(point(chk, '2026-03').note, 'Assumes nothing moved between Jun 1 and Jun 10, 2026 (not in your data).');
  // The series starts at the earliest month a balance is known (Feb 28, the day before the export);
  // nothing earlier is invented, and that month's money in and out is unknown, not $0.
  assert.equal(r.firstMonth, '2026-02');
  assert.equal(r.months[0].month, '2026-02');
  assert.equal(r.months[0].complete, false);
  assert.equal(r.months[0].in.total, null);
  assert.equal(r.months[0].net, null);
  assert.ok(!r.months.some(m => m.month < '2026-02'));
  assert.deepEqual(chk.known, { from: '2026-02-28', to: '2026-06-10' });
});

test('balance dated after the export ends: the days in between are a labelled gap with no transactions assumed; the date is not moved', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountsAsOf: '2026-08-12' }), settings: LOSING, today: '2026-08-14' });
  const chk = account(r, 'chk');
  assert.deepEqual(chk.gap, { side: 'after', from: '2026-06-01', to: '2026-08-12', days: 73 });
  assert.equal(chk.anchor.date, '2026-08-12');
  assert.match(chk.note, /The 73 days from Jun 1, 2026 to Aug 12, 2026 are not in your data: no transactions are assumed in them\./);
  assert.ok(r.balances.notes.some(n => /Test checking: Your export ends May 31, 2026/.test(n)), 'the gap is in the notes the screen shows');
  // June and July month-ends fall in the gap: the balance stays at the entered amount there.
  for (const m of ['2026-06', '2026-07']) assert.deepEqual([point(chk, m).cents, point(chk, m).status, point(chk, m).gap], [350000, 'assumed', true], m);
  assert.equal(point(chk, '2026-07').note, 'Assumes nothing moved between Jun 1 and Aug 12, 2026 (not in your data).');
  assert.ok(r.balances.notes.some(n => /Month-end balances worked out across those days are shown as assumed\.$/.test(n)));
  assert.equal(point(chk, '2026-05').gap, false);
  // August: the anchor month, pro-rated from Aug 12 (19 of 31 days left).
  const aug = point(chk, '2026-08');
  assert.deepEqual([aug.cents, aug.status, aug.anchor], [350000 + E.money.divide(-45000 * 19, 31), 'projected', true]);
  // Before the export: worked back through the covered transactions, still across the gap.
  assert.deepEqual([point(chk, '2026-02').cents, point(chk, '2026-02').status], [110000, 'assumed']);
});

test('pro-rating: the anchor month adds net × days left after the anchor date ÷ days in the month; later months the full net', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-06-10' } }), settings: LOSING });
  assert.equal(r.plan.net, -45000);
  const chk = account(r, 'chk');
  assert.equal(point(chk, '2026-06').cents, 350000 + E.money.divide(-45000 * 20, 30), '20 of 30 June days are after the 10th');
  assert.equal(point(chk, '2026-06').cents, 320000);
  assert.equal(point(chk, '2026-07').cents, 275000);
  assert.equal(point(chk, '2026-06').anchor, true);
  assert.match(r.balances.rule, /net × \(days left in the month after that date ÷ days in the month\), rounded to the cent/);
  assert.equal(T.prorate(-45000, 20, 30), -30000);
  assert.equal(T.prorate(10001, 1, 3), 3334, 'rounded to the cent');
});

test('a projected balance below $0 is kept as it is (never floored) and runsOut names the first such month', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-06-10' } }), settings: LOSING });
  const chk = account(r, 'chk');
  assert.equal(point(chk, '2027-01').cents, 5000);
  assert.equal(point(chk, '2027-02').cents, -40000);
  assert.equal(point(chk, '2027-05').cents, -175000, 'still going down: no top-up, no floor');
  assert.equal(r.balances.runsOut, '2027-02');
  assert.deepEqual(r.balances.lowest, { month: '2027-05', cents: -175000 });
  assert.deepEqual(point(r.balances.combined, '2027-05'), { month: '2027-05', cents: -175000, status: 'projected', anchor: false, gap: false, note: null, illustrative: false });
});

test('cover from savings moves a projected checking shortfall from savings, per account only; the combined line is the same either way', () => {
  const ds = small({ withSavings: true });
  const balances = { accounts: { chk: 100000, sav: 50000 }, accountsAsOf: '2026-05-31', accountDates: { sav: '2026-05-31' } };
  // Checking −60,000 a month (2,000 in, 1,500 card, 1,000 bank, 100 to savings); savings +10,000.
  const settings = { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 100000, savings: 10000 }, horizon: 6 };
  const on = run(ds, { plan: planWith(balances), settings, today: '2026-06-02' });
  const off = run(ds, { plan: planWith(balances), settings: Object.assign({}, settings, { coverFromSavings: false }), today: '2026-06-02' });
  const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const vals = (r, id) => months.map(m => point(account(r, id), m).cents);
  assert.deepEqual(vals(off, 'chk'), [40000, -20000, -80000, -140000, -200000], 'without the policy checking goes below $0');
  assert.deepEqual(vals(off, 'sav'), [60000, 70000, 80000, 90000, 100000]);
  assert.deepEqual(vals(on, 'chk'), [40000, 0, 0, -50000, -100000]);
  assert.deepEqual(vals(on, 'sav'), [60000, 50000, 0, 0, 0]);
  assert.deepEqual(on.balances.policy.moves.slice(0, 4), [{ month: '2026-07', cents: 20000 }, { month: '2026-08', cents: 60000 }, { month: '2026-09', cents: 10000 }, { month: '2026-10', cents: 10000 }]);
  assert.equal(on.balances.policy.savingsEmptyMonth, '2026-08');
  assert.deepEqual(off.balances.policy.moves, []);
  assert.deepEqual(on.balances.combined.points, off.balances.combined.points, 'moving money between own accounts changes nothing combined');
  assert.deepEqual(months.map(m => point(on.balances.combined, m).cents), [100000, 50000, 0, -50000, -100000]);
  assert.equal(on.balances.runsOut, '2026-09');
  // Reconstructed months are never changed by the policy.
  assert.deepEqual(point(account(on, 'chk'), '2026-05'), point(account(off, 'chk'), '2026-05'));
});

test('an account with data but no known balance is listed as missing and never summed as $0', () => {
  const ds = small({ withSavings: true });
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-05-31' } }), settings: LOSING });
  assert.deepEqual(r.balances.missing, [{ id: 'sav', name: 'Test savings', type: 'savings' }]);
  assert.deepEqual(r.balances.accounts.map(a => a.id), ['chk']);
  assert.deepEqual(r.balances.combined.members, ['chk']);
  assert.deepEqual(r.balances.combined.points.map(p => p.cents), account(r, 'chk').points.map(p => p.cents));
  assert.ok(r.balances.notes.some(n => /Test savings has no known balance: it is left out of the combined line, not counted as \$0\./.test(n)));
  assert.equal(r.balances.policy.applies, false, 'nothing to move from');
  const anc = T.anchors(planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-05-31' } }), ds);
  assert.equal(anc.simple, false);
  assert.deepEqual(anc.combined, { cents: 350000, asOf: '2026-05-31', members: ['chk'], sameDate: true });
});

test('simple mode: no account balances, so one entered joint cash figure gives an illustrative line', () => {
  const ds = small();
  // Money in − money out = −30,000 a month; moves to savings stay inside joint cash.
  const settings = { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 80000, savings: 25000 } };
  const r = run(ds, { plan: planWith({ jointCashCents: 500000, asOf: '2026-06-15' }), settings });
  assert.equal(r.balances.mode, 'simple');
  assert.equal(r.balances.simple, true);
  assert.equal(r.balances.label, 'Illustrative cash projection from the numbers you entered');
  assert.equal(r.balances.rule, T.SIMPLE_RULE);
  assert.deepEqual(r.balances.accounts, []);
  assert.deepEqual(r.balances.combined.members, []);
  assert.equal(point(r.balances.combined, '2026-05').cents, null, 'nothing before the entered date');
  assert.equal(point(r.balances.combined, '2026-06').cents, 500000 + E.money.divide(-30000 * 15, 30));
  assert.equal(point(r.balances.combined, '2026-07').cents, 455000);
  assert.ok(!r.balances.notes.some(n => /left out of the combined line/.test(n)));
  const anc = T.anchors(planWith({ jointCashCents: 500000, asOf: '2026-06-15' }), ds);
  assert.deepEqual([anc.simple, anc.combined], [true, { cents: 500000, asOf: '2026-06-15', members: [], sameDate: true }]);
  // No date entered: today's balance.
  const undated = run(ds, { plan: planWith({ jointCashCents: 500000 }), settings, today: '2026-06-20' });
  assert.equal(point(undated.balances.combined, '2026-06').cents, 490000);
  assert.ok(undated.balances.notes.some(n => /counts as of today \(Jun 20, 2026\)/.test(n)));
  // Nothing entered at all: no line, and the screen is told why.
  const none = run(ds, { settings });
  assert.equal(none.balances.mode, 'none');
  assert.equal(none.balances.combined, null);
  assert.equal(none.balances.runsOut, null);
});

test('a savings account with a balance but no export is worked back from the savings transfers in the checking export', () => {
  const xfer = (date, cents) => row('chk', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings', description: cents < 0 ? 'XFER TO SAV 0091' : 'XFER FROM SAV 0091' });
  const base = small().transactions;
  const txns = base.concat([xfer('2026-03-20', -10000), xfer('2026-04-20', -10000), xfer('2026-04-25', 4000), xfer('2026-05-20', -10000)]);
  const ds = dataset(txns, { from: '2026-03-01', to: '2026-05-31', withSavings: true, savingsCoverage: [] });
  const plan = planWith({ accounts: { chk: 350000, sav: 80000 }, accountsAsOf: '2026-05-31', accountDates: { sav: '2026-06-10' } });
  const r = run(ds, { plan, settings: { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 95000, savings: 6000 } } });
  const sav = account(r, 'sav');
  assert.deepEqual(sav.mirroredFrom, { id: 'chk', name: 'Test checking' });
  assert.deepEqual(sav.known, { from: '2026-02-28', to: '2026-06-10' }, 'the checking export’s coverage, up to the balance date');
  // To savings on checking = + on savings; from savings = −. Worked back from the 10 June balance,
  // across 1–10 June that the checking export does not cover: assumed.
  assert.deepEqual(['2026-02', '2026-03', '2026-04', '2026-05'].map(m => [point(sav, m).cents, point(sav, m).status]),
    [[54000, 'assumed'], [64000, 'assumed'], [70000, 'assumed'], [80000, 'assumed']]);
  assert.deepEqual(sav.gap, { side: 'after', from: '2026-06-01', to: '2026-06-10', days: 10 });
  assert.equal(point(sav, '2026-06').cents, 80000 + E.money.divide(6000 * 20, 30));
  assert.equal(point(sav, '2026-06').status, 'projected');
  assert.match(sav.note, /worked back from the transfers in Test checking’s export; interest and anything moved from elsewhere are not in it\./);
  assert.ok(r.balances.notes.includes('Test savings: worked back from the transfers in Test checking’s export; interest and anything moved from elsewhere are not in it.'));
  // The combined line now reaches back over the mirrored range.
  const chk = account(r, 'chk');
  assert.deepEqual([point(chk, '2026-02').cents, point(chk, '2026-02').status], [136000, 'reconstructed'], 'checking is dated at the end of its export');
  assert.equal(point(r.balances.combined, '2026-02').cents, 136000 + 54000);
  assert.equal(point(r.balances.combined, '2026-02').status, 'assumed', 'one member rests on the gap');
  assert.equal(point(r.balances.combined, '2026-02').note, 'Assumes nothing moved between Jun 1 and Jun 10, 2026 (not in your data).');
  assert.equal(account(r, 'chk').mirroredFrom, null);
});

test('two savings accounts without exports: the transfers are not split between them by guesswork', () => {
  const xfer = (date, cents) => row('chk', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings', description: 'XFER TO SAV 0091' });
  const txns = small().transactions.concat([xfer('2026-03-20', -10000), xfer('2026-05-20', -10000)]);
  const cover = [{ start: '2026-03-01', end: '2026-05-31' }];
  const ds = L.normalizeDataset({ schemaVersion: 2, datasetId: 'timeline-test', isSynthetic: true, transactions: txns, accounts: [
    { id: 'chk', label: 'Test checking', type: 'checking', scope: 'joint', coverage: cover },
    { id: 'card', label: 'Test card', type: 'credit_card', scope: 'joint', coverage: cover, paidInFull: true },
    { id: 'sav', label: 'Test savings', type: 'savings', scope: 'joint', coverage: [] },
    { id: 'sav2', label: 'Rainy-day savings', type: 'savings', scope: 'joint', coverage: [] },
  ] });
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000, sav: 80000, sav2: 15000 }, accountsAsOf: '2026-05-31' }), settings: LOSING });
  for (const id of ['sav', 'sav2']) {
    const a = account(r, id);
    assert.equal(a.mirroredFrom, null);
    assert.deepEqual(a.known, { from: '2026-05-31', to: '2026-05-31' });
    assert.equal(point(a, '2026-04').cents, null, 'nothing invented before the balance date');
  }
  assert.ok(r.balances.notes.some(n => /^Test savings has no export of its own, and there is more than one savings account \(Test savings, Rainy-day savings\)/.test(n)));
  assert.equal(point(r.balances.combined, '2026-04').cents, null);
  assert.equal(point(r.balances.combined, '2026-05').cents, 350000 + 80000 + 15000);
});

// ------------------------------------------------------------------ assumed vs reconstructed history
// Checking, a card and savings, covered 1 June to 30 September 2026 (or to `to`).
function quarter({ to = '2026-09-30', savings = 'covered' } = {}) {
  const txns = [];
  E.months.range('2026-06', to.slice(0, 7)).forEach((m, i) => {
    const day = d => `${m}-${String(d).padStart(2, '0')}`;
    if (day(1) <= to) txns.push(spend('chk', day(1), 98000, 'Westbrook Home Loans', 'Mortgage'));
    if (day(5) <= to) txns.push(deposit(day(5), 210000, 'p1'));
    if (day(12) <= to) txns.push(spend('card', day(12), 11000 + i * 130, 'Harbor Grocer', 'Groceries'));
    if (day(20) > to) return;
    if (savings === 'covered') txns.push(...toSavings(day(20), 10000));
    else txns.push(row('chk', day(20), -10000, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings', description: 'XFER TO SAV 0091' }));
  });
  return dataset(txns, { from: '2026-06-01', to, withSavings: true, savingsCoverage: savings === 'covered' ? undefined : [] });
}
// Plan: checking −20,000 a month (2,100 in; 1,200 card, 1,000 bank, 100 to savings); savings +10,000.
const QUARTER_DIALS = { dials: { p1: 210000, p2: 0, essentials: 120000, flexible: 100000, savings: 10000 } };
const statuses = r => r.balances.accounts.flatMap(a => a.points.map(p => p.status)).concat(r.balances.combined.points.map(p => p.status));

test('regression: balances dated 2 Oct after an export ending 30 Sep — every earlier point is assumed, not history', () => {
  const ds = quarter();
  const plan = planWith({ accounts: { chk: 412000, sav: 95500 }, accountsAsOf: '2026-10-02' });
  const r = run(ds, { plan, settings: QUARTER_DIALS, today: '2026-10-03' });
  const note = 'Assumes nothing moved between Oct 1 and Oct 2, 2026 (not in your data).';
  for (const id of ['chk', 'sav']) {
    for (const m of ['2026-09', '2026-08']) {
      const p = point(account(r, id), m);
      assert.deepEqual([p.status, p.note, p.illustrative], ['assumed', note, false], id + ' ' + m);
    }
  }
  assert.ok(!statuses(r).includes('reconstructed'), 'nothing is presented as history');
  assert.deepEqual([point(r.balances.combined, '2026-09').status, point(r.balances.combined, '2026-09').note], ['assumed', note]);
  assert.deepEqual(r.balances.assumed, {
    from: '2026-10-01', to: '2026-10-02', days: 2, accounts: ['Test checking', 'Test savings'],
    gaps: [{ side: 'after', from: '2026-10-01', to: '2026-10-02', days: 2, accounts: ['Test checking', 'Test savings'] }],
  });
  assert.equal(r.balances.assumed.days, 2);
  // The entered balances are kept exactly, at their own date…
  assert.deepEqual(account(r, 'chk').anchor, { date: '2026-10-02', cents: 412000, source: 'entered', label: 'Entered by you, Oct 2, 2026' });
  assert.deepEqual(account(r, 'sav').anchor, { date: '2026-10-02', cents: 95500, source: 'entered', label: 'Entered by you, Oct 2, 2026' });
  // …and October starts from them: entered + plan net × 29/31, whatever the gap.
  const oct = id => point(account(r, id), '2026-10');
  assert.deepEqual([oct('chk').cents, oct('chk').status], [412000 + E.money.divide(-20000 * 29, 31), 'projected']);
  assert.deepEqual([oct('sav').cents, oct('sav').status], [95500 + E.money.divide(10000 * 29, 31), 'projected']);
  assert.equal(oct('chk').cents, 412000 + T.prorate(r.plan.net, 29, 31));
  assert.ok(r.balances.notes.some(n => /^Test checking: Your export ends Sep 30, 2026, the balance is dated Oct 2, 2026\. The 2 days from Oct 1, 2026 to Oct 2, 2026 are not in your data: no transactions are assumed in them\. Month-end balances worked out across those days are shown as assumed\.$/.test(n)));
});

test('regression: the same balances dated 30 Sep (the last day of the export) are history: reconstructed, nothing assumed', () => {
  const ds = quarter();
  const r = run(ds, { plan: planWith({ accounts: { chk: 412000, sav: 95500 }, accountsAsOf: '2026-09-30' }), settings: QUARTER_DIALS, today: '2026-10-03' });
  assert.equal(r.balances.assumed, null);
  assert.ok(!statuses(r).includes('assumed'));
  for (const id of ['chk', 'sav']) for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) assert.deepEqual([point(account(r, id), m).status, point(account(r, id), m).note], ['reconstructed', null]);
  assert.equal(point(account(r, 'chk'), '2026-09').cents, 412000);
  assert.equal(point(account(r, 'chk'), '2026-10').cents, 412000 - 20000, 'a full month of plan net from the month end');
  assert.equal(point(r.balances.combined, '2026-09').status, 'reconstructed');
});

test('regression: a balance dated 10 days before the export starts — the points after the gap are assumed', () => {
  const ds = quarter();
  const r = run(ds, { plan: planWith({ accounts: { chk: 300000 }, accountDates: { chk: '2026-05-22' } }), settings: QUARTER_DIALS, today: '2026-10-03' });
  const chk = account(r, 'chk');
  assert.deepEqual(chk.gap, { side: 'before', from: '2026-05-23', to: '2026-05-31', days: 9 });
  assert.equal(r.months[0].month, '2026-05', 'nothing before the balance date');
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
    assert.deepEqual([point(chk, m).status, point(chk, m).note], ['assumed', 'Assumes nothing moved between May 23 and May 31, 2026 (not in your data).'], m);
  }
  assert.equal(point(chk, '2026-05').cents, 300000);
  assert.equal(point(chk, '2026-06').cents, 300000 + 210000 - 98000 - 10000);
  assert.equal(point(chk, '2026-10').status, 'projected');
  assert.deepEqual(r.balances.assumed, { from: '2026-05-23', to: '2026-05-31', days: 9, accounts: ['Test checking'],
    gaps: [{ side: 'before', from: '2026-05-23', to: '2026-05-31', days: 9, accounts: ['Test checking'] }] });
});

test('regression: a gap shorter than a month — the month-end inside it and every month before are assumed; a month-end after the balance date is projected from it', () => {
  // Export ends mid-September; the balance is dated 3 October: September's month-end is in the gap.
  const ds = quarter({ to: '2026-09-15' });
  const r = run(ds, { plan: planWith({ accounts: { chk: 405000 }, accountDates: { chk: '2026-10-03' } }), settings: QUARTER_DIALS, today: '2026-10-05' });
  const chk = account(r, 'chk');
  assert.deepEqual(chk.gap, { side: 'after', from: '2026-09-16', to: '2026-10-03', days: 18 });
  const note = 'Assumes nothing moved between Sep 16 and Oct 3, 2026 (not in your data).';
  for (const m of ['2026-09', '2026-08', '2026-07', '2026-06']) assert.deepEqual([point(chk, m).status, point(chk, m).note], ['assumed', note], m);
  assert.deepEqual([point(chk, '2026-09').cents, point(chk, '2026-09').gap], [405000, true]);
  assert.deepEqual([point(chk, '2026-10').status, point(chk, '2026-10').cents], ['projected', 405000 + E.money.divide(-20000 * 28, 31)]);
  // Balance dated 19 September, a few days after the export ends: September's month-end comes after
  // the balance, so it is projected from it; August was worked back across 16–19 September: assumed.
  const same = run(ds, { plan: planWith({ accounts: { chk: 405000 }, accountDates: { chk: '2026-09-19' } }), settings: QUARTER_DIALS, today: '2026-09-21' });
  const c2 = account(same, 'chk');
  assert.deepEqual([point(c2, '2026-09').status, point(c2, '2026-09').cents], ['projected', 405000 + E.money.divide(-20000 * 11, 30)]);
  assert.deepEqual([point(c2, '2026-08').status, point(c2, '2026-08').note], ['assumed', 'Assumes nothing moved between Sep 16 and Sep 19, 2026 (not in your data).']);
  assert.equal(same.balances.assumed.days, 4);
});

test('regression: a savings account mirrored from checking is assumed when its balance date is after that export ends', () => {
  const ds = quarter({ savings: 'mirrored' });
  const after = run(ds, { plan: planWith({ accounts: { chk: 412000, sav: 95500 }, accountsAsOf: '2026-09-30', accountDates: { sav: '2026-10-02' } }), settings: QUARTER_DIALS, today: '2026-10-03' });
  const sav = account(after, 'sav');
  assert.deepEqual(sav.mirroredFrom, { id: 'chk', name: 'Test checking' });
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) assert.deepEqual([point(sav, m).status, point(sav, m).note], ['assumed', 'Assumes nothing moved between Oct 1 and Oct 2, 2026 (not in your data).'], m);
  assert.equal(point(account(after, 'chk'), '2026-09').status, 'reconstructed');
  assert.equal(point(after.balances.combined, '2026-09').status, 'assumed');
  assert.deepEqual(after.balances.assumed.accounts, ['Test savings']);
  // Dated at the end of the checking export: the mirrored history needs no assumption.
  const onTime = run(ds, { plan: planWith({ accounts: { chk: 412000, sav: 95500 }, accountsAsOf: '2026-09-30' }), settings: QUARTER_DIALS, today: '2026-10-03' });
  assert.equal(point(account(onTime, 'sav'), '2026-08').status, 'reconstructed');
  assert.equal(point(account(onTime, 'sav'), '2026-08').cents, 95500 - 10000);
  assert.equal(onTime.balances.assumed, null);
});

test('account lines say they are illustrative when they are projected; the combined line and simple mode do not', () => {
  const ds = quarter();
  const r = run(ds, { plan: planWith({ accounts: { chk: 412000, sav: 95500 }, accountsAsOf: '2026-09-30' }), settings: QUARTER_DIALS, today: '2026-10-03' });
  assert.equal(r.balances.illustrative, 'Account lines are illustrative: card spending is taken from checking in the month it happens, not when the card is paid; the combined line is not affected.');
  assert.equal(r.balances.illustrative, T.ILLUSTRATIVE);
  const chk = account(r, 'chk'), sav = account(r, 'sav');
  assert.ok(chk.points.filter(p => p.status === 'projected').every(p => p.illustrative === true));
  assert.ok(chk.points.filter(p => p.status !== 'projected').every(p => p.illustrative === false));
  assert.ok(sav.points.every(p => p.illustrative === false), 'savings is not affected by card timing');
  assert.ok(r.balances.combined.points.every(p => p.illustrative === false));
  const simple = run(ds, { plan: planWith({ jointCashCents: 500000, asOf: '2026-09-30' }), settings: QUARTER_DIALS, today: '2026-10-03' });
  assert.equal(simple.balances.illustrative, null);
  assert.equal(simple.balances.assumed, null);
  assert.equal(run(ds, { settings: QUARTER_DIALS, today: '2026-10-03' }).balances.illustrative, null, 'no balances at all');
});

// ------------------------------------------------------------------ a fuller household (dials)
// Nine complete months (Oct 2025 – Jun 2026). Morgan is paid every other Friday into joint;
// Ellis transfers on the 1st and 15th (a weekend payday is paid the Friday before).
function household({ extra = [] } = {}) {
  const txns = [];
  const from = '2025-10-01', to = '2026-06-30';
  for (let d = '2025-10-03'; d <= to; d = E.dates.addDays(d, 14)) txns.push(deposit(d, 214000, 'p1'));
  for (const m of E.months.range('2025-10', '2026-07')) {
    for (const d of E.schedule.paydays({ frequency: 'semimonthly', semimonthlyDays: [1, 15] }, m)) if (d >= from && d <= to) txns.push(fromPartner(d, 96500, 'p2'));
  }
  E.months.range('2025-10', '2026-06').forEach((m, i) => {
    [3, 10, 17, 24].forEach((day, k) => txns.push(spend('card', `${m}-${String(day).padStart(2, '0')}`, 8150 + ((i * 37 + k * 113) % 2000), 'Harbor Grocer', 'Groceries')));
    txns.push(spend('card', `${m}-08`, 2599, 'Lumen Streaming', 'Subscriptions'));
    if (i % 3 !== 2) txns.push(spend('card', `${m}-19`, 2475 + i * 31, 'Pine Cafe', 'Dining & takeout'));
    txns.push(spend('card', `${m}-21`, 3120 + i * 17, 'Tidewater Diner', 'Dining & takeout'));
    if (i % 4 === 1) txns.push(spend('card', `${m}-23`, 640 + i, 'Quill Paper Co', 'Hobbies'));
    if (i % 4 === 3) txns.push(spend('card', `${m}-26`, 410 + i, 'Juniper Gifts', 'Gifts & donations'));
    txns.push(spend('chk', `${m}-01`, 145000, 'Westbrook Home Loans', 'Mortgage'));
    txns.push(spend('chk', `${m}-12`, 8800 + i * 210, 'Copperline Power', 'Electric'));
    txns.push(...cardPayment(`${m}-25`, 45000));
  });
  return dataset(txns.concat(extra), { from: '2025-10-01', to: '2026-06-30' });
}

test('dial hints: biweekly pay is 26 a year and semimonthly 24 a year; they are never treated as the same', () => {
  const r = run(household(), { today: '2026-07-03' });
  const p1 = r.dialsByKey.p1.hint, p2 = r.dialsByKey.p2.hint;
  assert.equal(p1.cadence, 'biweekly');
  assert.equal(p1.perYear, 26);
  assert.equal(p1.typicalIntervalDays, 14);
  assert.equal(p1.lastCents, 214000);
  assert.equal(p1.lastDate, '2026-06-26');
  assert.equal(p1.perMonthCents, E.money.divide(214000 * 26, 12));
  assert.notEqual(p1.perMonthCents, 214000 * 2, 'not "two a month"');
  assert.equal(p2.cadence, 'semimonthly');
  assert.deepEqual(p2.days, [1, 15]);
  assert.equal(p2.perYear, 24);
  assert.equal(p2.perMonthCents, 193000);
  assert.equal(p2.lastDate, '2026-06-15');
  // The hint is a fact beside the dial, not applied. With no pay saved in Budget the dial is the
  // average of the months, and it says that is not a confirmed setting.
  assert.equal(r.dialsByKey.p1.source, 'baseline');
  assert.deepEqual([r.dialsByKey.p1.basisKind, r.dialsByKey.p1.needsConfirm, r.dialsByKey.p1.budgetCents], ['average', true, null]);
  assert.equal(r.dialsByKey.p1.baselineCents, r.dialsByKey.p1.averageCents);
  assert.equal(r.dialsByKey.p1.baselineCents, E.money.divide(r.months.filter(m => m.status === 'actual' && m.complete).slice(-12).reduce((s, m) => s + m.in.p1, 0), 9));
});

// ------------------------------------------------------------------ money in: Budget pay first
const stream = (id, personId, fields) => Object.assign({
  id, label: id, personId, kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: null, frequency: 'semimonthly', frequencyStatus: 'confirmed',
  semimonthlyDays: [1, 15], anchorDate: null, monthlyDay: null, assumedPerMonthIfUnknown: 2, status: 'confirmed', startMonth: null, endMonth: null, note: '',
}, fields);
const withIncomes = incomes => Object.assign(planWith(), { incomes });

test('money in: a person with pay saved in Budget plans at it (semimonthly 2 a month), not at the deposit average', () => {
  const ds = household();
  const plan = withIncomes([stream('Morgan to joint', 'p1', { jointPerPaycheckCents: 198750 })]);
  const r = run(ds, { plan, today: '2026-07-03' });
  const d = r.dialsByKey.p1;
  assert.equal(r.planStart, '2026-07');
  assert.deepEqual([d.budgetCents, d.basisKind, d.needsConfirm, d.source], [397500, 'budget', false, 'baseline']);
  assert.equal(d.baselineCents, d.budgetCents);
  assert.equal(d.planCents, 397500);
  assert.equal(d.basis, 'From Budget: 2 × $1,987.50 to joint (semimonthly)');
  assert.deepEqual(d.budget, { streams: [{ id: 'Morgan to joint', name: 'Morgan to joint', perPaycheckJointCents: 198750, perYear: 24, cadenceLabel: 'Twice a month (semimonthly)', monthlyCents: 397500, assumedCadence: false }], unknown: [] });
  assert.equal(d.averageCents, E.money.divide(L.applyEdits(ds, {}).filter(t => t.personId === 'p1').reduce((s, t) => s + t.amountCents, 0), 9), 'the average is still reported');
  assert.notEqual(d.averageCents, d.budgetCents);
  assert.equal(d.hint.cadence, 'biweekly', 'the deposit hint is unchanged');
  assert.equal(r.plan.in.p1, 397500);
  assert.equal(r.months.find(m => m.month === '2026-09').in.p1, 397500, 'plan months use Budget pay');
  // Set here: the household's own amount wins, and says so.
  const direct = run(ds, { plan, settings: { dials: { p1: 400000 } }, today: '2026-07-03' }).dialsByKey.p1;
  assert.deepEqual([direct.basisKind, direct.basis, direct.planCents, direct.baselineCents, direct.needsConfirm, direct.source], ['direct', 'Set here', 400000, 397500, false, 'direct']);
});

test('money in: no stream, or a stream with an unknown amount, falls back to the labelled average (unknown is not $0)', () => {
  const ds = household();
  const plan = withIncomes([stream('Morgan to joint', 'p1', { jointPerPaycheckCents: 198750 }), stream('Ellis transfer', 'p2', { jointPerPaycheckCents: null })]);
  const r = run(ds, { plan, today: '2026-07-03' });
  const p2 = r.dialsByKey.p2;
  assert.deepEqual([p2.budgetCents, p2.basisKind, p2.needsConfirm], [null, 'average', true]);
  assert.deepEqual(p2.budget, { streams: [], unknown: ['Ellis transfer'] });
  assert.equal(p2.baselineCents, p2.averageCents);
  assert.equal(p2.planCents, p2.averageCents);
  assert.equal(p2.basis, 'Average of Oct 2025–Jun 2026 deposits, 9 months — not a confirmed setting');
  // One known stream and one unknown: still unknown, never summed around the gap.
  const mixed = run(ds, { plan: withIncomes([stream('Morgan to joint', 'p1', { jointPerPaycheckCents: 198750 }), stream('Morgan bonus', 'p1', { kind: 'other', frequency: 'monthly', monthlyDay: 28, jointPerPaycheckCents: null })]), today: '2026-07-03' }).dialsByKey.p1;
  assert.deepEqual([mixed.budgetCents, mixed.basisKind, mixed.budget.unknown], [null, 'average', ['Morgan bonus']]);
  assert.deepEqual(mixed.budget.streams.map(x => x.id), ['Morgan to joint']);
  // No stream at all.
  const none = run(ds, { plan: withIncomes([]), today: '2026-07-03' }).dialsByKey.p2;
  assert.deepEqual([none.budgetCents, none.basisKind, none.needsConfirm, none.budget], [null, 'average', true, { streams: [], unknown: [] }]);
});

test('money in: ended streams and streams that start later are left out; biweekly is 26 a year (2,957.50 for 1,365), never 2 a month', () => {
  const ds = household();
  const plan = withIncomes([
    stream('Morgan old job', 'p1', { kind: 'paycheck', netPerPaycheckCents: 260000, jointPerPaycheckCents: 150000, endMonth: '2026-05' }),
    stream('Morgan new job', 'p1', { kind: 'paycheck', netPerPaycheckCents: 240000, jointPerPaycheckCents: 136500, frequency: 'biweekly', anchorDate: '2026-06-05', startMonth: '2026-06' }),
    stream('Morgan next role', 'p1', { kind: 'paycheck', netPerPaycheckCents: 300000, jointPerPaycheckCents: 200000, startMonth: '2026-11' }),
  ]);
  const r = run(ds, { plan, today: '2026-07-03' });
  const d = r.dialsByKey.p1;
  assert.equal(d.budgetCents, 295750);
  assert.equal(d.budgetCents, E.money.divide(136500 * 26, 12));
  assert.notEqual(d.budgetCents, 2 * 136500);
  assert.deepEqual(d.budget.streams.map(x => [x.id, x.perPaycheckJointCents, x.perYear, x.cadenceLabel, x.monthlyCents]), [['Morgan new job', 136500, 26, 'Every two weeks (biweekly)', 295750]]);
  assert.equal(d.basis, 'From Budget: 26/12 × $1,365.00 to joint (biweekly, 26 a year)');
  assert.equal(r.plan.in.p1, 295750);
});

test('baseline window: 3, 12 (all there are) and "all" complete months, named in the dial basis', () => {
  const ds = household();
  const all = run(ds, { settings: { baselineMonths: 'all' }, today: '2026-07-03' });
  assert.equal(all.baseline.count, 9);
  assert.equal(all.baseline.start, '2025-10');
  assert.equal(all.baseline.end, '2026-06');
  assert.equal(all.dialsByKey.essentials.basis.split(';')[0], 'Average of all 9 complete months, Oct 2025–Jun 2026');
  const twelve = run(ds, { settings: { baselineMonths: 12 }, today: '2026-07-03' });
  assert.equal(twelve.baseline.count, 9);
  assert.match(twelve.dialsByKey.essentials.basis, /^Average of Oct 2025–Jun 2026, 9 months \(all there are\)/);
  const three = run(ds, { settings: { baselineMonths: 3 }, today: '2026-07-03' });
  assert.deepEqual(three.baseline.months, ['2026-04', '2026-05', '2026-06']);
  // No pay saved in Budget here: the person dials stand in with the deposit average, labelled as such.
  assert.equal(three.dialsByKey.p2.basis, 'Average of Apr 2026–Jun 2026 deposits, 3 months — not a confirmed setting');
  // Both bank bills are essentials and stable (monthly, within 10%): each counts at its latest charge,
  // and they are the bank-paid part of the essentials dial.
  assert.equal(three.dialsByKey.essentials.bankCents, 145000 + (8800 + 8 * 210));
  assert.equal(three.dialsByKey.flexible.bankCents, 0, 'everything flexible here is on the card');
  assert.match(three.dialsByKey.essentials.basis, /; regular bills at their latest amount$/);
});

test('drill-down: categories add up to the dial and places to their category; unticking a regular place lowers the dial by exactly its amount', () => {
  const ds = household();
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r = build(state);
  const flex = r.dialsByKey.flexible;
  const cats = flex.drill.rows.filter(x => x.level === 1);
  assert.equal(flex.drill.kind, 'categories');
  assert.equal(flex.baselineCents, cats.reduce((s, c) => s + c.defaultCents, 0), 'dial baseline = Σ categories as they stand by default');
  assert.equal(flex.baselineCents, cats.reduce((s, c) => s + c.planCents, 0));
  for (const c of cats) {
    const children = flex.drill.rows.filter(x => x.parent === c.id);
    assert.equal(c.avgCents, children.reduce((s, k) => s + k.avgCents, 0), c.label + ' average');
    assert.equal(c.defaultCents, children.reduce((s, k) => s + k.defaultCents, 0), c.label + ' default');
  }
  assert.deepEqual(cats.map(c => c.label), ['Dining & takeout', 'Subscriptions', 'Other'], 'the two tiny categories are grouped');
  assert.deepEqual(cats.find(c => c.label === 'Other').members.sort(), ['Gifts & donations', 'Hobbies']);
  assert.equal(cats.find(c => c.label === 'Other').groupKey, null, 'the grouped row is moved per member');
  assert.deepEqual([cats[0].groupKey, cats[0].groupSource], ['Dining & takeout', 'taxonomy']);
  const lumen = flex.drill.rows.find(x => x.label === 'Lumen Streaming');
  assert.deepEqual([lumen.kind, lumen.level, lumen.regular, lumen.avgCents, lumen.months, lumen.txnCount], ['merchant', 2, true, 2599, 9, 9]);
  assert.deepEqual([lumen.stable, lumen.latestCents, lumen.latestDate, lumen.seenMonths, lumen.ofMonths, lumen.defaultCents], [true, 2599, '2026-06-08', 9, 9, 2599]);
  assert.deepEqual([lumen.group, lumen.paidBy, lumen.cardShare, lumen.pattern, lumen.cardCents, lumen.bankCents], ['flexible', 'card', 1, 'bill', 2599, 0]);
  assert.match(lumen.id, /^flexible-m-[0-9a-z]+$/);
  // Places seen in most months get their own row (Pine Cafe: 6 of 9); the rest is one row.
  const kids = label => flex.drill.rows.filter(x => x.parent === cats.find(c => c.label === label).id).map(x => [x.kind, x.label]);
  assert.deepEqual(kids('Dining & takeout'), [['merchant', 'Tidewater Diner'], ['merchant', 'Pine Cafe']]);
  assert.deepEqual(kids('Other'), [['rest', 'Everything in Other']]);
  // Rest rows carry the same fields; there is no single latest charge for many places.
  const otherRest = flex.drill.rows.find(x => x.kind === 'rest' && x.category === 'Other');
  assert.deepEqual([otherRest.latestCents, otherRest.latestDate, otherRest.stable, otherRest.seenMonths, otherRest.ofMonths, otherRest.defaultCents], [null, null, false, 4, 9, otherRest.avgCents]);
  assert.equal(otherRest.pattern, 'occasional', 'seen in 4 of 9 months');
  // Untick the streaming subscription.
  state = T.setRow(state, lumen.id, { included: false });
  assert.deepEqual(state.ui.plan.rows, { [lumen.id]: { included: false } });
  const r2 = build(state);
  const flex2 = r2.dialsByKey.flexible;
  assert.equal(flex2.source, 'rows');
  assert.equal(flex2.baselineCents, flex.baselineCents, 'the baseline itself is unchanged');
  assert.equal(flex2.planCents, flex.baselineCents - 2599);
  const included = flex2.drill.rows.filter(x => x.level === 1 && x.included);
  assert.equal(flex2.planCents, included.reduce((s, c) => s + c.planCents, 0), 'dial = Σ included categories');
  const subs = flex2.drill.rows.find(x => x.label === 'Subscriptions');
  assert.equal(subs.planCents, flex2.drill.rows.filter(x => x.parent === subs.id && x.included).reduce((s, k) => s + k.planCents, 0));
  assert.equal(r2.plan.out.flexible, flex2.planCents);
  assert.equal(r2.plan.out.card, r.plan.out.card - 2599, 'the derived card total follows the row');
  assert.equal(r2.months.find(m => m.month === '2026-08').out.flexible, flex2.planCents, 'plan months use it');
  assert.equal(r2.months.find(m => m.month === '2026-05').out.card, r.months.find(m => m.month === '2026-05').out.card, 'history is unchanged');
  // An amount on a row, then ticking it back: only the amount remains.
  state = T.setRow(state, lumen.id, { cents: 999 });
  state = T.setRow(state, lumen.id, { included: true });
  assert.deepEqual(state.ui.plan.rows, { [lumen.id]: { cents: 999 } });
  assert.equal(build(state).dialsByKey.flexible.planCents, flex.baselineCents - 2599 + 999);
  // Ids are stable from one build to the next.
  assert.deepEqual(build(state).dialsByKey.flexible.drill.rows.map(x => x.id), flex.drill.rows.map(x => x.id));
});

test('a dial set directly wins over row changes and the baseline; clearing it falls back in that order', () => {
  const ds = household();
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const base = build(state).dialsByKey.essentials;
  const grocer = base.drill.rows.find(x => x.label === 'Harbor Grocer');
  state = T.setRow(state, grocer.id, { cents: 30000 });
  state = T.setDial(state, 'essentials', 123456);
  state = T.setDial(state, 'savings', -20001);
  let r = build(state);
  assert.deepEqual([r.dialsByKey.essentials.source, r.dialsByKey.essentials.planCents], ['direct', 123456]);
  assert.deepEqual([r.dialsByKey.savings.source, r.dialsByKey.savings.planCents], ['direct', -20001], 'negative: drawing savings down');
  assert.equal(r.plan.savings, -20001);
  assert.equal(r.plan.net, r.plan.in.total - r.plan.out.total + 20001);
  assert.deepEqual([r.plan.fromSavings, r.plan.toSavings], [20001, 0]);
  assert.equal(r.changed, true);
  // A direct amount still splits into card and bank by how the group was paid.
  const ess = r.dialsByKey.essentials;
  assert.equal(ess.cardCents, Math.round(123456 * ess.cardShare));
  assert.equal(ess.cardCents + ess.bankCents, 123456);
  assert.throws(() => T.setDial(state, 'card', 1000), err => err instanceof E.ValidationError && /worked out from essentials, flexible and irregular/.test(err.message), 'card is not a dial any more');
  state = T.setDial(state, 'essentials', null);
  r = build(state);
  assert.equal(r.dialsByKey.essentials.source, 'rows');
  assert.equal(r.dialsByKey.essentials.planCents, base.baselineCents - grocer.avgCents + 30000);
  state = T.resetDial(state, 'essentials');
  r = build(state);
  assert.deepEqual([r.dialsByKey.essentials.source, r.dialsByKey.essentials.planCents], ['baseline', base.baselineCents]);
  assert.deepEqual(state.ui.plan.rows, {});
  state = T.resetPlan(state);
  assert.deepEqual(state.ui.plan.dials, {});
  assert.equal(build(state).changed, false);
});

test('one-time items: in the irregular allowance by default (one-time costs ÷ months), listed in full, and counted as regular by a planning-baseline edit', () => {
  const big = spend('card', '2026-04-18', 129900, 'Summit Appliance', 'Electronics');
  const ds = household({ extra: [big] });
  const r = run(ds, { today: '2026-07-03' });
  const item = r.baseline.oneTime.find(o => o.id === big.id);
  assert.deepEqual(item, { id: big.id, date: '2026-04-18', month: '2026-04', merchant: 'Summit Appliance', description: 'SUMMIT APPLIANCE 7731', accountLabel: 'Test card', role: 'card', dialKey: 'irregular', cents: 129900, auto: true });
  assert.equal(r.baseline.oneTimeCents, 129900);
  assert.ok(!r.dialsByKey.flexible.drill.rows.some(x => x.category === 'Electronics'), 'kept out of the category rows');
  const irr = r.dialsByKey.irregular;
  assert.equal(irr.drill.kind, 'items');
  assert.deepEqual(irr.drill.rows.map(i => [i.id, i.label, i.date, i.cents, i.monthlyCents, i.included, i.auto]), [[big.id, 'Summit Appliance', '2026-04-18', 129900, E.money.divide(129900, 9), true, true]]);
  assert.equal(irr.baselineCents, E.money.divide(129900, 9), 'one-time costs ÷ months');
  assert.equal(irr.planCents, irr.baselineCents, 'in the plan: nothing is left out automatically');
  assert.equal(irr.basis, 'One-time costs over Oct 2025–Jun 2026 spread per month (1 item, $1,299.00) — electronics');
  assert.equal(r.plan.out.irregular, irr.planCents);
  const april = r.months.find(m => m.month === '2026-04');
  assert.deepEqual(april.oneOffs.map(o => o.id), [big.id]);
  assert.equal(april.oneOffCents, 129900);
  assert.equal(april.out.irregular, 129900, 'the actual month shows it as irregular');
  assert.equal(april.out.essentials + april.out.flexible + april.out.irregular, april.out.card + april.out.bank);
  // "Count it as regular": the household's edit moves it into its category.
  const include = { [big.id]: E.review.editRecord(null, 'planningBaseline', 'include', 'A planned replacement cycle') };
  const r2 = run(ds, { edits: include, today: '2026-07-03' });
  assert.ok(!r2.baseline.oneTime.some(o => o.id === big.id));
  assert.ok(!r2.dialsByKey.irregular.drill.rows.some(i => i.id === big.id), 'no longer listed as one-time');
  assert.deepEqual(r2.baseline.keptIn.map(o => o.id), [big.id]);
  assert.equal(r2.dialsByKey.flexible.baselineCents, r.dialsByKey.flexible.baselineCents + E.money.divide(129900, 9));
  assert.equal(r2.dialsByKey.irregular.baselineCents, 0);
  assert.equal(r2.months.find(m => m.month === '2026-04').out.card, april.out.card, 'actual months always count it');
  // Leaving out an ordinary purchase by hand makes it a one-time cost: in the allowance, not the category.
  const grocery = ds.transactions.find(t => t.merchant === 'Harbor Grocer' && t.date === '2026-05-10');
  const exclude = Object.assign({}, include, { [grocery.id]: E.review.editRecord(null, 'planningBaseline', 'exclude', 'Party supplies') });
  const r3 = run(ds, { edits: exclude, today: '2026-07-03' });
  const manual = r3.baseline.oneTime.find(o => o.id === grocery.id);
  assert.equal(manual.auto, false);
  assert.equal(manual.cents, -grocery.amountCents);
  assert.equal(r3.dialsByKey.irregular.drill.rows.find(i => i.id === grocery.id).auto, false);
  assert.equal(r3.dialsByKey.irregular.baselineCents, E.money.divide(-grocery.amountCents, 9));
  const groceries = rows => rows.find(x => x.level === 1 && x.label === 'Groceries').avgCents;
  assert.equal(groceries(r3.dialsByKey.essentials.drill.rows), E.money.divide(groceries(r2.dialsByKey.essentials.drill.rows) * 9 + grocery.amountCents, 9));
});

test('drill rows and one-time items list the transactions behind them (txnIds, newest first, baseline months only); a category holds its rows’ ids', () => {
  const big = spend('card', '2026-04-18', 129900, 'Summit Appliance', 'Electronics');
  const ds = household({ extra: [big] });
  const today = '2026-07-03';
  const r = run(ds, { today });
  const byId = new Map(ds.transactions.map(t => [t.id, t]));
  const newestFirst = ids => ids.every((id, i) => i === 0 || byId.get(ids[i - 1]).date >= byId.get(id).date);
  const sorted = ids => ids.slice().sort();
  for (const key of ['essentials', 'flexible']) {
    const rows = r.dialsByKey[key].drill.rows;
    for (const row of rows) {
      assert.ok(Array.isArray(row.txnIds) && row.txnIds.length > 0, row.label + ': ids');
      assert.equal(new Set(row.txnIds).size, row.txnIds.length, row.label + ': each transaction once');
      assert.equal(row.txnIds.length, row.txnCount, row.label + ': as many as it counts');
      assert.ok(newestFirst(row.txnIds), row.label + ': newest first');
    }
    // The rows share out their category: together they hold exactly its ids.
    for (const cat of rows.filter(x => x.level === 1)) {
      const kids = rows.filter(x => x.parent === cat.id);
      assert.deepEqual(sorted(kids.flatMap(k => k.txnIds)), sorted(cat.txnIds), cat.label);
      assert.equal(kids.reduce((s, k) => s + k.txnIds.length, 0), cat.txnIds.length, cat.label + ': no transaction in two rows');
    }
  }
  const grocer = r.dialsByKey.essentials.drill.rows.find(x => x.label === 'Harbor Grocer');
  assert.deepEqual(grocer.txnIds, ds.transactions.filter(t => t.merchant === 'Harbor Grocer').sort((a, b) => (a.date < b.date ? 1 : -1)).map(t => t.id));
  assert.equal(grocer.txnIds.length, 36, '4 a month over 9 months');
  // The one-time cost is its own item, and in no category row.
  assert.deepEqual(r.dialsByKey.irregular.drill.rows.map(i => i.txnIds), [[big.id]]);
  const inRows = res => ['essentials', 'flexible'].flatMap(k => res.dialsByKey[k].drill.rows).filter(x => x.txnIds.includes(big.id));
  assert.deepEqual(inRows(r), []);
  // Counted as regular (planningBaseline 'include'): in its category's ids and one of its rows.
  const include = { [big.id]: E.review.editRecord(null, 'planningBaseline', 'include', 'A planned replacement cycle') };
  const r2 = run(ds, { edits: include, today });
  assert.deepEqual(inRows(r2).map(x => [x.level, x.category]), [[1, 'Electronics'], [2, 'Electronics']]);
  assert.ok(!r2.dialsByKey.irregular.drill.rows.some(i => i.txnIds.includes(big.id)));
  // A recategorized purchase moves with its id: a Pine Cafe meal set to Groceries leaves Dining.
  const meal = ds.transactions.find(t => t.merchant === 'Pine Cafe' && t.date.startsWith('2026-05'));
  const r3 = run(ds, { edits: { [meal.id]: E.review.editRecord(null, 'category', 'Groceries', 'Checked the receipt') }, today });
  const holders = res => ['essentials', 'flexible'].flatMap(k => res.dialsByKey[k].drill.rows).filter(x => x.txnIds.includes(meal.id)).map(x => [x.group, x.level, x.label]);
  assert.deepEqual(holders(r), [['flexible', 1, 'Dining & takeout'], ['flexible', 2, 'Pine Cafe']]);
  assert.deepEqual(holders(r3), [['essentials', 1, 'Groceries'], ['essentials', 2, 'Pine Cafe']]);
  // Only the baseline months: with the last 3, each row lists what was bought in them.
  const r4 = run(ds, { settings: { baselineMonths: 3 }, today });
  const months = new Set(r4.baseline.months);
  for (const row of r4.dialsByKey.essentials.drill.rows) assert.ok(row.txnIds.every(id => months.has(byId.get(id).date.slice(0, 7))), row.label);
  assert.equal(r4.dialsByKey.essentials.drill.rows.find(x => x.label === 'Harbor Grocer').txnIds.length, 12);
});

test('the months: actual before planStart, partial for a partly covered month, plan after; a 5-year horizon has 60 plan months', () => {
  // Data runs a little into July: July is partial (what happened so far is kept apart).
  const ds0 = household();
  const july = [deposit('2026-07-10', 214000, 'p1'), spend('card', '2026-07-04', 9120, 'Harbor Grocer', 'Groceries')];
  const ds = L.normalizeDataset(Object.assign({}, ds0, {
    accounts: ds0.accounts.map(a => Object.assign({}, a, { coverage: [{ start: '2025-10-01', end: '2026-07-12' }] })),
    transactions: ds0.transactions.concat(july),
  }));
  const r = run(ds, { settings: { horizon: 60 }, today: '2026-07-14' });
  assert.equal(r.planStart, '2026-07');
  const plan = r.months.filter(m => m.month >= r.planStart);
  assert.equal(plan.length, 60);
  assert.equal(r.lastMonth, '2031-06');
  assert.deepEqual(r.months.slice(-1)[0].month, '2031-06');
  const jul = r.months.find(m => m.month === '2026-07');
  assert.deepEqual([jul.status, jul.current, jul.complete], ['partial', true, false]);
  assert.equal(jul.in.total, r.plan.in.total, 'a partial month uses the plan');
  assert.equal(jul.actualSoFar.in.p1, 214000);
  assert.equal(jul.actualSoFar.out.card, 9120);
  assert.ok(plan.slice(1).every(m => m.status === 'plan'));
  assert.ok(r.months.filter(m => m.month < r.planStart).every(m => m.status === 'actual'));
  const keys = m => [Object.keys(m.in).sort(), Object.keys(m.out).sort()];
  assert.deepEqual(keys(r.months.find(m => m.month === '2026-03')), keys(plan[10]), 'actual and plan months have the same keys');
  assert.deepEqual(Object.keys(plan[10].in).sort(), ['other', 'p1', 'p2', 'total', 'unassigned']);
  assert.deepEqual(r.window, { past: 12, from: '2025-10', to: '2031-06', fromIndex: 0 });
  // Balances run the whole way.
  const withBalance = run(ds, { plan: planWith({ accounts: { chk: 420000 }, accountDates: { chk: '2026-07-12' } }), settings: { horizon: 60 }, today: '2026-07-14' });
  const combined = withBalance.balances.combined.points;
  assert.equal(combined.length, withBalance.months.length);
  assert.equal(combined[combined.length - 1].status, 'projected');
  assert.notEqual(combined[combined.length - 1].cents, null);
});


test('stable regular bills plan at their latest charge; the average is kept beside it', () => {
  // A mortgage due on the 1st, paid a day early once: the July payment landed on 30 June, before
  // the 12-month window, so the window holds 11 payments and averages to 11/12 of the bill.
  const txns = [];
  for (const m of E.months.range('2025-06', '2026-06')) {
    if (m === '2025-07') continue;
    txns.push(spend('chk', m === '2025-06' ? '2025-06-30' : `${m}-01`, 152340, 'Larkspur Home Lending', 'Mortgage'));
  }
  // A utility that varies more than 10%: regular but not stable, so it plans at its average.
  E.months.range('2025-07', '2026-06').forEach((m, i) => txns.push(spend('chk', `${m}-14`, 6100 + (i % 2) * 2900, 'Brightwater Energy', 'Electric')));
  // A weekly shop with the same amount every time: regular, but not once a month, so not "stable".
  E.months.range('2025-07', '2026-06').forEach(m => [2, 9, 16, 23].forEach(d => txns.push(spend('card', `${m}-${String(d).padStart(2, '0')}`, 7250, 'Harbor Grocer', 'Groceries'))));
  const ds = dataset(txns, { from: '2025-06-01', to: '2026-06-30' });
  const r = run(ds, { today: '2026-07-03' });
  const ess = r.dialsByKey.essentials;
  const loan = ess.drill.rows.find(x => x.label === 'Larkspur Home Lending');
  assert.equal(loan.avgCents, E.money.divide(11 * 152340, 12), 'the average is 11/12 of the bill');
  assert.deepEqual([loan.stable, loan.latestCents, loan.latestDate, loan.seenMonths, loan.ofMonths], [true, 152340, '2026-06-01', 11, 12]);
  assert.deepEqual([loan.defaultCents, loan.planCents, loan.pattern, loan.paidBy], [152340, 152340, 'bill', 'bank']);
  const power = ess.drill.rows.find(x => x.label === 'Brightwater Energy');
  assert.deepEqual([power.stable, power.latestCents, power.latestDate, power.seenMonths, power.ofMonths, power.pattern], [false, 9000, '2026-06-14', 12, 12, 'everyday']);
  assert.equal(power.planCents, power.avgCents);
  const grocer = ess.drill.rows.find(x => x.label === 'Harbor Grocer');
  assert.deepEqual([grocer.regular, grocer.stable, grocer.planCents, grocer.pattern, grocer.paidBy], [true, false, 4 * 7250, 'everyday', 'card']);
  assert.equal(ess.baselineCents, 152340 + power.avgCents + 4 * 7250, 'the dial baseline follows the rows');
  assert.deepEqual([ess.bankCents, ess.cardCents], [152340 + power.avgCents, 4 * 7250], 'card and bank worked out from the rows');
  assert.equal(ess.planCents, ess.baselineCents);
  assert.equal(ess.source, 'baseline');
  assert.match(ess.basis, /; regular bills at their latest amount$/);
  assert.equal(r.dialsByKey.flexible.baselineCents, 0, 'nothing flexible here');
  // A row amount the household set still wins over the latest charge.
  const changed = run(ds, { settings: { rows: { [loan.id]: { cents: 150000 } } }, today: '2026-07-03' });
  assert.equal(changed.dialsByKey.essentials.drill.rows.find(x => x.id === loan.id).planCents, 150000);
  assert.equal(changed.dialsByKey.essentials.planCents, 150000 + power.avgCents + 4 * 7250);
  assert.equal(changed.plan.out.bank, 150000 + power.avgCents);
});

test('state: the earlier Home settings become ui.plan once, and the plan screen reads them (the card amount is carried over to the spending dials)', () => {
  const ds = household();
  const raw = JSON.parse(JSON.stringify(E.state.defaults(null, ds)));
  delete raw.ui.plan;
  raw.ui.home = { inCents: null, p1InCents: 410000, p2InCents: null, outCents: null, savedCents: -7525, cardCents: 88000, bankCents: null, baselineMonths: 3, fundingWho: 'both', chartView: 'money', horizon: 24 };
  const once = E.state.sanitize(raw, null, ds);
  const twice = E.state.sanitize(once.state, null, ds);
  assert.deepEqual(twice.state, once.state);
  assert.equal(once.state.ui.home, undefined);
  assert.deepEqual(once.state.ui.plan.dials, { p1: 410000, savings: -7525 });
  assert.deepEqual(once.state.ui.plan.legacyDials, { card: 88000 });
  const build = st => T.build({ txns: L.applyEdits(ds, {}), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r = build(once.state);
  assert.deepEqual(['p1', 'savings', 'essentials', 'flexible'].map(k => [r.dialsByKey[k].source, r.dialsByKey[k].planCents]),
    [['direct', 410000], ['direct', -7525], ['baseline', r.dialsByKey.essentials.baselineCents], ['baseline', r.dialsByKey.flexible.baselineCents]], 'not applied until carried over');
  assert.equal(r.dialsByKey.card, undefined, 'card is not a dial');
  assert.deepEqual(r.migration.dials.from, { card: 88000 });
  const r2 = build(T.migrateDials(once.state, r));
  assert.equal(r2.plan.out.card, 88000, 'carried over: card spending is what was set');
  assert.equal(r2.baseline.count, 3);
  assert.equal(r2.horizon, 24);
});

test('build needs today and the data set; settings fall back to the defaults', () => {
  const ds = small();
  assert.throws(() => T.build({ dataset: ds, plan: planWith() }), err => err instanceof E.ValidationError && err.field === 'today');
  assert.throws(() => T.build({ today: '2026-06-12' }), err => err instanceof E.ValidationError && err.field === 'dataset');
  // Checked by the same rules as a saved budget (state.cleanPlanUi): a row change with a part this
  // version does not know is left out whole, an empty one and a yes/no flag stay as saved.
  assert.deepEqual(T.settings({ horizon: 36, baselineMonths: 'all', dials: { essentials: 1.5, flexible: -4 }, rows: { a: { included: false, x: 1 }, b: {} },
    groups: { Pets: 'essentials', 'merchant:Bayside Club': 'flexible', Travel: 'sometimes' }, irregularOff: { t1: true, t2: false }, trends: { series: ['card', 'card', 'nope', 'in-p2'], ma: 4 } }),
  { baselineMonths: 'all', horizon: 12, past: 12, mode: 'balance', coverFromSavings: true, dials: { flexible: -4 }, rows: { b: {} }, hidden: null,
    groups: { Pets: 'essentials', 'merchant:Bayside Club': 'flexible' }, irregularOff: { t1: true, t2: false }, legacyDials: {}, cardSplit: {}, trends: { series: ['card', 'in-p2'], ma: 3, trend: true } });
  // A card or bank amount still among the dials (not yet checked by state.sanitize) waits to be carried over, and is newer.
  assert.deepEqual(T.settings({ dials: { card: 5000, essentials: 7 }, legacyDials: { card: 1, bank: 2, x: 3 }, cardSplit: { essentials: { cents: 7, card: 3 }, flexible: { cents: 1 }, card: { cents: 1, card: 1 } } }),
    Object.assign(T.settings({}), { dials: { essentials: 7 }, legacyDials: { card: 5000, bank: 2 }, cardSplit: { essentials: { cents: 7, card: 3 } } }));
  assert.equal(T.settings(undefined).hidden, null, 'never chosen');
  assert.deepEqual(T.settings(undefined).trends, { series: ['card'], ma: 3, trend: true });
  assert.equal(T.settings({ mode: 'trends' }).mode, 'trends');
  assert.deepEqual(T.settings({ hidden: [] }).hidden, [], 'an empty choice stays a choice');
});

// ------------------------------------------------------------------ essentials, flexible, irregular
// A household with a warehouse club and an online shop in "Mixed retail", a vet (Pets) and insurance.
function shops({ extra = [] } = {}) {
  const txns = [];
  E.months.range('2025-10', '2026-06').forEach((m, i) => {
    const day = d => `${m}-${String(d).padStart(2, '0')}`;
    txns.push(spend('chk', day(1), 145000, 'Westbrook Home Loans', 'Mortgage'));
    txns.push(spend('chk', day(9), 12400, 'Pinecrest Mutual', 'Other insurance'));
    txns.push(spend('card', day(5), 21000 + i * 100, 'Bayside Warehouse Club', 'Mixed retail'));
    txns.push(spend('card', day(14), 6400 + (i % 3) * 900, 'Riverbend Online', 'Mixed retail'));
    txns.push(spend('card', day(18), 3900 + (i % 2) * 1200, 'Maple Vet Clinic', 'Pets'));
    txns.push(spend('card', day(22), 15500, 'Harbor Grocer', 'Groceries'));
    txns.push(deposit(day(25), 400000, 'p1'));
  });
  return dataset(txns.concat(extra), { from: '2025-10-01', to: '2026-06-30' });
}
const totalSpending = r => r.dialsByKey.essentials.baselineCents + r.dialsByKey.flexible.baselineCents;

test('spending groups follow the taxonomy: mortgage, insurance and groceries are essentials; shopping and pets are flexible', () => {
  const r = run(shops(), { today: '2026-07-03' });
  assert.deepEqual(r.groups.out, ['essentials', 'flexible', 'irregular', 'savings']);
  const labels = key => r.dialsByKey[key].drill.rows.filter(x => x.level === 1).map(x => x.label).sort();
  assert.deepEqual(labels('essentials'), ['Groceries', 'Mortgage', 'Other insurance']);
  assert.deepEqual(labels('flexible'), ['Mixed retail', 'Pets']);
  assert.ok(r.dialsByKey.essentials.drill.rows.every(x => x.group === 'essentials'));
  assert.equal(E.categories.isEssential('Pets'), false);
  assert.equal(E.categories.isEssential('Other insurance'), true);
  for (const c of ['Mortgage', 'Gas & heating', 'Electric', 'Water & sewer', 'Internet & phone', 'Groceries', 'Fuel', 'Auto insurance', 'Home insurance', 'Medical & pharmacy', 'Dental', 'Vision', 'Auto maintenance', 'Debt payment']) assert.equal(E.categories.isEssential(c), true, c);
  for (const c of ['Dining & takeout', 'Mixed retail', 'Entertainment', 'Subscriptions', 'Home improvement', 'Travel', 'Gifts & donations', 'Personal care', 'Pets']) assert.equal(E.categories.isEssential(c), false, c);
});

test('moving a category, or one place, between essentials and flexible: rows follow, a moved place gets its own row, and the totals still add up', () => {
  const ds = shops();
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r0 = build(state);
  const vet = r0.dialsByKey.flexible.drill.rows.find(x => x.label === 'Maple Vet Clinic');
  state = T.setRow(state, vet.id, { cents: 5000 });
  // Pets → essentials, with the timeline so the vet row's change follows it.
  state = T.setGroup(state, 'Pets', 'essentials', build(state));
  assert.deepEqual(state.ui.plan.groups, { Pets: 'essentials' });
  const r1 = build(state);
  const pets = r1.dialsByKey.essentials.drill.rows.find(x => x.level === 1 && x.label === 'Pets');
  assert.deepEqual([pets.groupKey, pets.groupSource, pets.group], ['Pets', 'override', 'essentials']);
  const vet1 = r1.dialsByKey.essentials.drill.rows.find(x => x.label === 'Maple Vet Clinic');
  assert.match(vet1.id, /^essentials-m-/);
  assert.deepEqual(vet1.override, { cents: 5000 }, 'the row change moved with it');
  assert.deepEqual(Object.keys(state.ui.plan.rows), [vet1.id]);
  assert.ok(!r1.dialsByKey.flexible.drill.rows.some(x => x.label === 'Pets'));
  assert.equal(totalSpending(r1), totalSpending(r0), 'the same spending, grouped differently');
  // One place: the warehouse club → essentials, while the online shop stays flexible.
  state = T.setGroup(state, 'merchant:Bayside Warehouse Club', 'essentials');
  const r2 = build(state);
  const club = r2.dialsByKey.essentials.drill.rows.find(x => x.level === 1 && x.label === 'Bayside Warehouse Club');
  assert.deepEqual([club.synthetic, club.merchant, club.groupKey, club.movedFrom, club.kind], [true, 'Bayside Warehouse Club', 'merchant:Bayside Warehouse Club', ['Mixed retail'], 'category']);
  const clubKids = r2.dialsByKey.essentials.drill.rows.filter(x => x.parent === club.id);
  assert.deepEqual(clubKids.map(k => [k.kind, k.label, k.synthetic]), [['merchant', 'Bayside Warehouse Club', true]]);
  assert.equal(club.defaultCents, clubKids[0].defaultCents);
  const mixed = r2.dialsByKey.flexible.drill.rows.find(x => x.level === 1 && x.label === 'Mixed retail');
  assert.deepEqual(r2.dialsByKey.flexible.drill.rows.filter(x => x.parent === mixed.id).map(x => x.label), ['Riverbend Online']);
  const mixed0 = r0.dialsByKey.flexible.drill.rows.find(x => x.level === 1 && x.label === 'Mixed retail');
  assert.equal(mixed.avgCents + club.avgCents, mixed0.avgCents, 'the place left its category: nothing lost, nothing counted twice');
  assert.equal(totalSpending(r2), totalSpending(r0));
  assert.equal(r2.dialsByKey.essentials.planCents + r2.dialsByKey.flexible.planCents, r1.dialsByKey.essentials.planCents + r1.dialsByKey.flexible.planCents);
  // Actual months split the same way, and still add up to card + bank.
  const may = r2.months.find(m => m.month === '2026-05');
  assert.equal(may.out.essentials + may.out.flexible + may.out.irregular, may.out.card + may.out.bank);
  assert.equal(may.out.essentials, 145000 + 12400 + 15500 + (3900 + 1200) + (21000 + 7 * 100), 'mortgage, insurance, groceries, the vet and the club');
  // Back to the default grouping.
  state = T.setGroup(state, 'merchant:Bayside Warehouse Club', null);
  assert.deepEqual(state.ui.plan.groups, { Pets: 'essentials' });
  assert.throws(() => T.setGroup(state, 'Pets', 'sometimes'), err => err instanceof E.ValidationError);
});

test('pattern badges: bill (regular and stable), everyday (most months, not stable), occasional (the rest)', () => {
  const r = run(household(), { today: '2026-07-03' });
  const row = label => r.dialsByKey.essentials.drill.rows.concat(r.dialsByKey.flexible.drill.rows).find(x => x.label === label);
  assert.deepEqual(['Westbrook Home Loans', 'Copperline Power', 'Lumen Streaming', 'Harbor Grocer', 'Everything in Other'].map(l => row(l).pattern), ['bill', 'bill', 'bill', 'everyday', 'occasional']);
  assert.equal(row('Subscriptions').pattern, 'bill', 'a category whose rows are all bills');
  assert.equal(row('Groceries').pattern, 'everyday');
  assert.equal(row('Other').pattern, 'occasional');
  assert.deepEqual([row('Mortgage').paidBy, row('Groceries').paidBy, row('Groceries').cardShare, row('Mortgage').cardShare], ['bank', 'card', 1, 0]);
});

test('irregular: the baseline is one-time costs ÷ months; one can be left out (and put back), and the dial says so', () => {
  const tv = spend('card', '2026-01-18', 99000, 'Summit Appliance', 'Electronics');
  const dentist = spend('chk', '2026-03-07', 162000, 'Brookside Dental Group', 'Dental');
  const trip = spend('card', '2026-05-02', 84000, 'Coastline Air', 'Travel');
  const ds = household({ extra: [tv, dentist, trip] });
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r = build(state);
  const irr = r.dialsByKey.irregular;
  assert.equal(irr.baselineCents, E.money.divide(99000 + 162000 + 84000, 9));
  assert.deepEqual(irr.drill.rows.map(i => i.id), [dentist.id, tv.id, trip.id], 'biggest first');
  assert.equal(irr.basis, 'One-time costs over Oct 2025–Jun 2026 spread per month (3 items, $3,450.00) — dental work, electronics, trips');
  assert.deepEqual([irr.cardCents, irr.bankCents], [E.money.divide(99000 + 84000, 9), irr.planCents - E.money.divide(99000 + 84000, 9)]);
  assert.equal(r.plan.out.total, r.plan.out.essentials + r.plan.out.flexible + irr.planCents + r.plan.out.other);
  // Leave the dentist out.
  state = T.setIrregular(state, dentist.id, false);
  assert.deepEqual(state.ui.plan.irregularOff, { [dentist.id]: true });
  const r2 = build(state);
  const irr2 = r2.dialsByKey.irregular;
  assert.deepEqual([irr2.source, irr2.baselineCents, irr2.planCents], ['rows', irr.baselineCents, E.money.divide(99000 + 84000, 9)]);
  assert.equal(irr2.drill.rows.find(i => i.id === dentist.id).included, false, 'still listed, marked left out');
  assert.match(irr2.basis, /; 1 left out by you$/);
  assert.equal(r2.changed, true);
  // Back in, then reset: nothing left out.
  assert.deepEqual(T.setIrregular(state, dentist.id, true).ui.plan.irregularOff, {});
  assert.deepEqual(T.resetDial(state, 'irregular').ui.plan.irregularOff, {});
  assert.deepEqual(T.resetPlan(state).ui.plan.irregularOff, {});
  // A left-out id that is no longer a one-time cost is reported, not applied.
  const stale = build(T.setIrregular(state, 'tl-gone', false));
  assert.deepEqual(stale.dialsByKey.irregular.drill.orphanIds, ['tl-gone']);
  // Nothing at all: the dial is still there, at $0.
  const none = run(household(), { today: '2026-07-03' }).dialsByKey.irregular;
  assert.deepEqual([none.baselineCents, none.planCents, none.basis], [0, 0, 'No one-time costs over Oct 2025–Jun 2026']);
});

test('card and bank are derived: on the same data they equal the earlier card and bank dial math', () => {
  const ds = household();
  const r = run(ds, { today: '2026-07-03' });
  // The earlier dials, worked out by hand: card = the grocer's average + the stable places at their
  // latest charge (streaming, Pine Cafe, Tidewater Diner) + the tiny categories' average; bank = the
  // two stable bills at their latest charge.
  let grocer = 0;
  E.months.range('2025-10', '2026-06').forEach((m, i) => [0, 1, 2, 3].forEach(k => { grocer += 8150 + ((i * 37 + k * 113) % 2000); }));
  const tiny = (640 + 1) + (640 + 5) + (410 + 3) + (410 + 7);
  const oldCard = E.money.divide(grocer, 9) + 2599 + (2475 + 7 * 31) + (3120 + 8 * 17) + E.money.divide(tiny, 9);
  const oldBank = 145000 + (8800 + 8 * 210);
  assert.equal(r.plan.out.card, oldCard);
  assert.equal(r.plan.out.bank, oldBank);
  assert.equal(r.plan.out.card + r.plan.out.bank, r.plan.out.essentials + r.plan.out.flexible + r.plan.out.irregular);
  assert.deepEqual(['essentials', 'flexible', 'irregular'].map(k => r.dialsByKey[k].cardCents + r.dialsByKey[k].bankCents), ['essentials', 'flexible', 'irregular'].map(k => r.dialsByKey[k].planCents));
  // Actual months keep the card and bank amounts that happened.
  const may = r.months.find(m => m.month === '2026-05');
  const mayTxns = ds.transactions.filter(t => t.date.startsWith('2026-05') && t.kind === 'spend');
  assert.equal(may.out.card, mayTxns.filter(t => t.accountId === 'card').reduce((s, t) => s - t.amountCents, 0));
  assert.equal(may.out.bank, mayTxns.filter(t => t.accountId === 'chk').reduce((s, t) => s - t.amountCents, 0));
});

test('headline numbers: combinedChange = money in − money out (savings moves net to zero); net is what is left in checking', () => {
  const ds = small({ withSavings: true });
  const r = run(ds, { settings: { dials: { p1: 200000, p2: 0, essentials: 120000, flexible: 30000, savings: 25000 } } });
  assert.equal(r.plan.combinedChange, r.plan.in.total - r.plan.out.total);
  assert.equal(r.plan.combinedChange, 200000 - 150000);
  assert.equal(r.plan.net, r.plan.combinedChange - 25000);
  assert.deepEqual([r.plan.toSavings, r.plan.fromSavings], [25000, 0]);
  for (const m of r.months) {
    if (m.in.total === null) { assert.equal(m.combinedChange, null, m.month); continue; }
    assert.equal(m.combinedChange, m.in.total - m.out.total, m.month);
    assert.equal(m.net, m.combinedChange - m.savings, m.month);
  }
  const april = r.months.find(m => m.month === '2026-04');
  assert.equal(april.combinedChange, 200000 - 120000 - 16125, 'actual: pay − mortgage − groceries; the transfer to savings stays inside joint cash');
  const draw = run(ds, { settings: { dials: { savings: -40000 } } });
  assert.deepEqual([draw.plan.toSavings, draw.plan.fromSavings], [0, 40000]);
});

test('the baseline ghost: only when the plan is changed — one plan month at baseline dials, and the combined line it would give', () => {
  const ds = small({ withSavings: true });
  const plan = planWith({ accounts: { chk: 350000, sav: 90000 }, accountsAsOf: '2026-05-31' });
  const same = run(ds, { plan });
  assert.equal(same.changed, false);
  assert.equal(same.baseline.plan, null);
  assert.ok(same.months.every(m => m.baseline === null));
  assert.equal(same.balances.combined.baselinePoints, null);
  const changed = run(ds, { plan, settings: { dials: { flexible: 50000 } } });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.changedBy, { dials: true, changes: false });
  assert.deepEqual(changed.baseline.plan, same.plan, 'the ghost is the plan with nothing changed');
  const plans = changed.months.filter(m => m.month >= changed.planStart);
  assert.ok(plans.every(m => m.baseline && m.baseline.in === same.plan.in.total && m.baseline.out === same.plan.out.total && m.baseline.net === same.plan.net && m.baseline.savings === same.plan.savings && m.baseline.combinedChange === same.plan.combinedChange));
  assert.ok(changed.months.filter(m => m.month < changed.planStart).every(m => m.baseline === null));
  const ghost = changed.balances.combined.baselinePoints;
  assert.equal(ghost.length, changed.balances.combined.points.length);
  changed.balances.combined.points.forEach((p, i) => {
    if (p.status === 'projected') assert.equal(ghost[i], same.balances.combined.points[i].cents, p.month);
    else assert.equal(ghost[i], null, 'history has no ghost: ' + p.month);
  });
  assert.notDeepEqual(changed.balances.combined.points.map(p => p.cents), same.balances.combined.points.map(p => p.cents));
});

// ------------------------------------------------------------------ planned changes
const change = (id, fields) => Object.assign({ id, label: id, kind: 'monthly', group: 'flexible', personId: null, startMonth: '2026-08', endMonth: null, cents: 10000, accepted: true, template: null, note: '' }, fields);

test('planned changes: one-time in its month only, monthly through its end month, income to its person; unset and unaccepted ones are listed, not applied', () => {
  const ds = small();
  const plan = Object.assign(planWith(), { changes: [
    change('roof', { kind: 'oneTime', group: 'irregular', startMonth: '2026-09', cents: 250000 }),
    change('gym', { group: 'flexible', startMonth: '2026-08', endMonth: '2026-10', cents: 6000 }),
    change('raise', { group: 'income', personId: 'p2', startMonth: '2026-06', cents: 30000 }),
    change('side', { group: 'income', personId: null, startMonth: '2026-07', endMonth: '2026-07', cents: 5000 }),
    change('saving', { group: 'savings', startMonth: '2026-12', cents: 20000 }),
    change('leave', { group: 'income', personId: 'p1', startMonth: '2026-08', cents: null }),
    change('maybe', { group: 'essentials', cents: 99999, accepted: false }),
    change('old', { kind: 'oneTime', group: 'irregular', startMonth: '2026-03', cents: 1000 }),
  ] });
  const settings = { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 50000, savings: 0 } };
  const r = run(ds, { plan, settings });
  const at = m => r.months.find(x => x.month === m);
  assert.equal(r.plan.combinedChange, 0, 'the plan itself (dials only) is unchanged');
  assert.deepEqual(at('2026-07').changesApplied.map(a => a.id), ['raise', 'side']);
  assert.deepEqual([at('2026-07').in.p2, at('2026-07').in.other, at('2026-07').in.total], [30000, r.plan.in.other + 5000, 200000 + 35000]);
  assert.deepEqual(at('2026-08').changesApplied.map(a => a.id), ['gym', 'raise']);
  assert.deepEqual(at('2026-08').changesApplied[0], { id: 'gym', label: 'gym', group: 'flexible', cents: 6000 });
  assert.deepEqual([at('2026-08').out.flexible, at('2026-08').out.bank, at('2026-08').out.total], [56000, r.plan.out.bank + 6000, 206000]);
  assert.equal(at('2026-09').out.irregular, r.plan.out.irregular + 250000, 'the one-time change in its month');
  assert.equal(at('2026-10').out.irregular, r.plan.out.irregular, '…and only then');
  assert.equal(at('2026-10').out.flexible, 56000, 'monthly through its end month');
  assert.equal(at('2026-11').out.flexible, 50000, '…and not after');
  assert.equal(at('2026-12').savings, 20000);
  assert.equal(at('2026-12').net, at('2026-12').combinedChange - 20000);
  assert.equal(at('2026-09').combinedChange, 30000 - 6000 - 250000);
  assert.equal(at('2026-09').net, at('2026-09').in.total - at('2026-09').out.total - at('2026-09').savings);
  assert.ok(r.months.every(m => !m.changesApplied.some(a => a.id === 'leave' || a.id === 'maybe' || a.id === 'old')), 'unknown, unaccepted and past changes are not applied');
  assert.deepEqual(r.changes.unset, ['leave']);
  assert.deepEqual(r.changes.list.map(c => [c.id, c.status]), [['roof', 'applied'], ['gym', 'applied'], ['raise', 'applied'], ['side', 'applied'], ['saving', 'applied'], ['leave', 'unset'], ['maybe', 'notAccepted'], ['old', 'outside']]);
  assert.deepEqual([r.changes.list[1].monthsApplied, r.changes.list[1].appliedCents], [3, 18000]);
  assert.equal(r.changes.applied, 5);
  assert.equal(r.changes.totalOneTimeCents, 250000);
  assert.equal(r.changes.monthlyNowCents, -30000, 'income counts against money out (first plan month: the raise)');
  assert.equal(r.changed, true);
  assert.deepEqual(r.changedBy, { dials: true, changes: true });
  // The months before the plan are what happened.
  assert.deepEqual(at('2026-05').changesApplied, []);
});

test('planned changes through state: add, edit, accept and remove; switching kind or group clears what no longer fits', () => {
  const ds = small();
  let st = E.state.defaults(null, ds);
  assert.deepEqual(st.plan.changes, []);
  st = T.addChange(st, { label: 'New car payment', kind: 'monthly', group: 'essentials', startMonth: '2026-09', endMonth: '2029-08', cents: 41000 });
  const id = st.plan.changes[0].id;
  assert.match(id, /^change-/);
  assert.deepEqual(st.plan.changes[0], { id, label: 'New car payment', kind: 'monthly', group: 'essentials', personId: null, startMonth: '2026-09', endMonth: '2029-08', cents: 41000, accepted: false, template: null, note: '' });
  st = T.acceptChanges(st, [id], true);
  assert.equal(st.plan.changes[0].accepted, true);
  st = T.setChange(st, id, { kind: 'oneTime' });
  assert.deepEqual([st.plan.changes[0].kind, st.plan.changes[0].endMonth], ['oneTime', null], 'a one-time change has no end month');
  st = T.setChange(st, id, { group: 'income', personId: 'p1', kind: 'monthly', cents: -50000 });
  assert.deepEqual([st.plan.changes[0].group, st.plan.changes[0].personId, st.plan.changes[0].cents], ['income', 'p1', -50000], 'signed: a drop in income');
  st = T.setChange(st, id, { group: 'flexible' });
  assert.equal(st.plan.changes[0].personId, null, 'only income belongs to a person');
  st = T.setChange(st, id, { cents: null });
  assert.equal(st.plan.changes[0].cents, null, 'unknown stays unknown');
  assert.throws(() => T.setChange(st, id, { endMonth: '2026-01' }), err => err instanceof E.ValidationError, 'end before start');
  assert.throws(() => T.addChange(st, { label: 'x', kind: 'weekly', group: 'flexible', startMonth: '2026-09' }), err => err instanceof E.ValidationError);
  assert.throws(() => T.addChange(st, { label: 'x', group: 'flexible' }), err => err instanceof E.ValidationError, 'a start month is needed');
  assert.throws(() => T.setChange(st, 'nope', { cents: 1 }), err => err instanceof E.ValidationError);
  st = T.acceptChanges(st, id, false);
  assert.equal(st.plan.changes[0].accepted, false);
  st = T.removeChange(st, id);
  assert.deepEqual(st.plan.changes, []);
});

test('the baby template: dated from the due month, every amount present except the leave income, nothing accepted', () => {
  assert.deepEqual(T.templates.list(), [{ key: 'baby', label: 'Baby', needs: ['dueDate'] }]);
  const items = T.templates.baby('2028-05-14');
  const by = label => items.find(i => i.label === label);
  assert.deepEqual(items.map(i => [i.label, i.kind, i.group, i.startMonth, i.endMonth, i.cents]), [
    ['Car seat', 'oneTime', 'irregular', '2028-03', null, 25000],
    ['Nursery setup (paint, dresser, glider)', 'oneTime', 'irregular', '2028-03', null, 90000],
    ['Starter clothes and basics', 'oneTime', 'irregular', '2028-04', null, 25000],
    ['Feeding gear (bottles, pump accessories)', 'oneTime', 'irregular', '2028-04', null, 20000],
    ['Baby monitor', 'oneTime', 'irregular', '2028-04', null, 10000],
    ['Crib and mattress (after the bassinet)', 'oneTime', 'irregular', '2028-09', null, 35000],
    ['Delivery out-of-pocket (insurance deductible/out-of-pocket max)', 'oneTime', 'irregular', '2028-06', null, 350000],
    ['Diapers and wipes', 'monthly', 'essentials', '2028-05', null, 8500],
    ['Formula / feeding', 'monthly', 'essentials', '2028-05', null, 12000],
    ['Baby food', 'monthly', 'essentials', '2028-11', null, 7500],
    ['Clothes as they grow', 'monthly', 'flexible', '2028-05', null, 4500],
    ['Health copays and medicines', 'monthly', 'essentials', '2028-05', null, 4000],
    ['Childcare', 'monthly', 'essentials', '2028-08', null, 120000],
    ['Parental leave: income change', 'monthly', 'income', '2028-05', '2028-07', null],
  ]);
  assert.ok(items.every(i => i.accepted === false && i.template === 'baby' && i.personId === null));
  assert.ok(items.every(i => /estimate/i.test(i.note) && /adjust/.test(i.note)), 'every note says it is an estimate to adjust');
  assert.match(by('Formula / feeding').note, /about \$0 if breastfeeding/i);
  assert.match(by('Childcare').note, /typical infant daycare; set to \$0 for family care/i);
  assert.match(by('Parental leave: income change').note, /monthly reduction in take-home while on leave/);
  // A due date in late December crosses the year both ways.
  const dec = T.templates.baby('2026-12-30');
  assert.deepEqual([dec[0].startMonth, dec[5].startMonth, dec[13].endMonth], ['2026-10', '2027-04', '2027-02']);
  assert.throws(() => T.templates.baby('2027-02-30'), err => err instanceof E.ValidationError && err.field === 'dueDate');
  // Into a plan: listed, nothing applied until accepted; the leave item is reported as unset.
  const ds = small();
  let st = T.addChange(E.state.defaults(null, ds), T.templates.baby('2026-09-20'));
  assert.equal(st.plan.changes.length, 14);
  assert.equal(new Set(st.plan.changes.map(c => c.id)).size, 14, 'each gets its own id');
  const build = s => T.build({ txns: L.applyEdits(ds, s.ledgerEdits), dataset: ds, plan: Object.assign({}, s.plan, { people: PEOPLE }), settings: s.ui.plan, today: '2026-06-12' });
  const before = build(st);
  assert.equal(before.changes.applied, 0);
  assert.deepEqual(before.changes.unset, [st.plan.changes[13].id]);
  st = T.acceptChanges(st, st.plan.changes.map(c => c.id), true);
  const after = build(st);
  assert.equal(after.changes.applied, 13, 'every change with an amount and a month in the plan');
  assert.equal(after.months.find(m => m.month === '2026-07').out.irregular, after.plan.out.irregular + 25000 + 90000, 'car seat and nursery two months before');
  assert.equal(after.changes.totalOneTimeCents, 25000 + 90000 + 25000 + 20000 + 10000 + 35000 + 350000);
  assert.equal(after.changes.monthlyNowCents, 0, 'nothing monthly yet in June');
});

// ------------------------------------------------------------------ balances supplied with the data
const withBalances = (ds, balances) => Object.assign({}, ds, { balances });

test('balances supplied with the data are bank anchors: used unless an entered balance is dated later', () => {
  const ds = withBalances(quarter(), [{ accountId: 'chk', date: '2026-09-30', cents: 412000, source: 'statement' }, { accountId: 'sav', date: '2026-09-15', cents: 80000, source: 'bank', note: 'Posted balance' }, { accountId: 'card', date: '2026-09-30', cents: -5000, source: 'statement' }, { accountId: 'chk', date: 'soon', cents: 1 }]);
  const r = run(ds, { settings: QUARTER_DIALS, today: '2026-10-03' });
  const chk = account(r, 'chk'), sav = account(r, 'sav');
  assert.deepEqual(chk.anchor, { date: '2026-09-30', cents: 412000, source: 'statement', label: 'From your statement, Sep 30, 2026' });
  assert.deepEqual(sav.anchor, { date: '2026-09-15', cents: 80000, source: 'bank', label: 'From your bank data, Sep 15, 2026' });
  assert.deepEqual([point(chk, '2026-09').cents, point(chk, '2026-09').status], [412000, 'reconstructed']);
  assert.equal(point(chk, '2026-08').cents, 412000 - (210000 - 98000 - 10000), 'worked back with the transactions');
  assert.equal(point(sav, '2026-09').cents, 80000 + 10000, 'worked forward over the covered days to the month end');
  assert.match(chk.note, /^From the statement balance supplied with your data for Sep 30, 2026\./);
  assert.deepEqual(r.balances.accounts.map(a => a.id), ['chk', 'sav'], 'the card is not a cash account');
  const anc = T.anchors(planWith(), ds);
  assert.deepEqual(anc.accounts.map(a => [a.id, a.source, a.asOf, a.anchor.label]), [['chk', 'statement', '2026-09-30', 'From your statement, Sep 30, 2026'], ['sav', 'bank', '2026-09-15', 'From your bank data, Sep 15, 2026']]);
  // An entered balance dated later wins; one dated earlier (or the same day) does not.
  const later = run(ds, { plan: planWith({ accounts: { chk: 400000 }, accountDates: { chk: '2026-10-02' } }), settings: QUARTER_DIALS, today: '2026-10-03' });
  assert.deepEqual(account(later, 'chk').anchor, { date: '2026-10-02', cents: 400000, source: 'entered', label: 'Entered by you, Oct 2, 2026' });
  assert.equal(T.anchors(planWith({ accounts: { chk: 400000 }, accountDates: { chk: '2026-10-02' } }), ds).accounts[0].source, 'entered');
  for (const d of ['2026-09-20', '2026-09-30']) {
    const older = run(ds, { plan: planWith({ accounts: { chk: 1 }, accountDates: { chk: d } }), settings: QUARTER_DIALS, today: '2026-10-03' });
    assert.deepEqual([account(older, 'chk').anchor.source, account(older, 'chk').anchor.cents], ['statement', 412000], d);
    assert.match(account(older, 'chk').note, /is not newer than the last balance from your bank, so the bank’s own figure is used\./);
  }
  // Absent or unusable: nothing changes.
  assert.deepEqual(E.balances.suppliedBalances({}), []);
  assert.deepEqual(E.balances.suppliedBalances({ balances: 'x' }), []);
  assert.equal(T.anchors(planWith(), quarter()).accounts.length, 0);
});

test('a savings account with only a supplied balance is worked back from the transfers in checking', () => {
  const ds = withBalances(quarter({ savings: 'mirrored' }), [{ accountId: 'sav', date: '2026-09-30', cents: 95500, source: 'statement' }]);
  const r = run(ds, { plan: planWith({ accounts: { chk: 412000 }, accountsAsOf: '2026-09-30' }), settings: QUARTER_DIALS, today: '2026-10-03' });
  const sav = account(r, 'sav');
  assert.deepEqual(sav.mirroredFrom, { id: 'chk', name: 'Test checking' });
  assert.deepEqual([sav.anchor.source, sav.anchor.label], ['statement', 'From your statement, Sep 30, 2026']);
  assert.equal(point(sav, '2026-08').cents, 95500 - 10000);
  assert.match(sav.note, /^From the statement balance supplied with your data for Sep 30, 2026, worked back from the transfers/);
});

// ------------------------------------------------------------------ series (Trends) and CSV

test('series: every catalogue key is there, aligned with the months; incomplete months are null; plan months use the plan', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-05-31' } }), settings: LOSING });
  // The monthly amounts first; the balance series follow them (next test).
  const flows = r.series.filter(s => s.kind === 'flow');
  assert.deepEqual(r.series.slice(0, flows.length), flows);
  assert.ok(flows.every(s => s.unit === 'perMonth'));
  assert.deepEqual(flows.map(s => s.key), ['in-p1', 'in-p2', 'in-other', 'in-total', 'card', 'bank', 'essentials', 'flexible', 'irregular', 'other-out', 'out-total', 'to-savings', 'from-savings', 'net', 'combined-change']);
  assert.deepEqual(flows.map(s => s.group), ['in', 'in', 'in', 'in', 'out', 'out', 'out', 'out', 'out', 'out', 'out', 'savings', 'savings', 'net', 'net']);
  assert.equal(r.series[0].name, 'Morgan');
  assert.ok(r.series.every(s => s.values.length === r.months.length));
  const s = key => r.series.find(x => x.key === key).values;
  const iFeb = r.months.findIndex(m => m.month === '2026-02'), iApr = r.months.findIndex(m => m.month === '2026-04'), iAug = r.months.findIndex(m => m.month === '2026-08');
  assert.equal(r.months[iFeb].complete, false);
  assert.ok(flows.every(x => x.values[iFeb] === null), 'an incomplete month is unknown in every monthly series');
  assert.deepEqual(['in-p1', 'card', 'bank', 'essentials', 'out-total', 'net', 'combined-change'].map(k => s(k)[iApr]), [200000, 16125, 120000, 136125, 136125, 63875, 63875]);
  assert.deepEqual(['in-total', 'essentials', 'flexible', 'out-total', 'net', 'to-savings', 'from-savings'].map(k => s(k)[iAug]), [200000, 150000, 95000, 245000, -45000, 0, 0]);
  // Every series the chart draws (the person series too) can be chosen and saved in ui.plan.trends.
  for (const k of r.series.map(x => x.key)) assert.ok(E.state.TREND_SERIES.includes(k), k + ' can be saved in ui.plan.trends');
});

test('series: balance lines at month end (combined, each account, savings total), aligned with the balance points, and saveable', () => {
  // Checking, a card and two savings accounts, each with its own export (1 March to 31 May 2026).
  const txns = small({ withSavings: true }).transactions.slice();
  txns.push(row('sav2', '2026-04-30', 1250, { kind: 'income', subtype: 'interest', category: 'Interest', merchant: 'Interest', description: 'INTEREST PAID' }));
  const cover = [{ start: '2026-03-01', end: '2026-05-31' }];
  const ds = L.normalizeDataset({ schemaVersion: 2, datasetId: 'timeline-test', isSynthetic: true, transactions: txns, accounts: [
    { id: 'chk', label: 'Test checking', type: 'checking', scope: 'joint', coverage: cover },
    { id: 'card', label: 'Test card', type: 'credit_card', scope: 'joint', coverage: cover, paidInFull: true },
    { id: 'sav', label: 'Test savings', type: 'savings', scope: 'joint', coverage: cover },
    { id: 'sav2', label: 'Rainy day', type: 'savings', scope: 'joint', coverage: cover },
  ] });
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000, sav: 90000, sav2: 40000 }, accountsAsOf: '2026-05-31' }), settings: LOSING });
  const bal = r.series.filter(s => s.kind === 'balance');
  assert.deepEqual(r.series.slice(-bal.length), bal, 'after the monthly series');
  assert.deepEqual(bal.map(s => [s.key, s.name]), [
    ['balance-combined', 'Combined cash'], ['balance-chk', 'Test checking balance'], ['balance-sav', 'Test savings balance'],
    ['balance-sav2', 'Rainy day balance'], ['balance-savings-total', 'Savings total'],
  ]);
  assert.ok(bal.every(s => s.group === 'balances' && s.unit === 'atMonthEnd' && s.values.length === r.months.length));
  const values = key => bal.find(s => s.key === key).values;
  assert.deepEqual(values('balance-combined'), r.balances.combined.points.map(p => p.cents));
  for (const id of ['chk', 'sav', 'sav2']) assert.deepEqual(values('balance-' + id), account(r, id).points.map(p => p.cents), id);
  assert.deepEqual(values('balance-savings-total'), r.months.map((m, i) => {
    const a = account(r, 'sav').points[i].cents, b = account(r, 'sav2').points[i].cents;
    return a === null || b === null ? null : a + b;
  }));
  // Known before the export starts (worked back), and projected months are there too.
  const iFeb = r.months.findIndex(m => m.month === '2026-02'), iAug = r.months.findIndex(m => m.month === '2026-08');
  assert.equal(values('balance-sav2')[iFeb], 40000 - 1250);
  assert.equal(point(r.balances.combined, '2026-08').status, 'projected');
  assert.ok(bal.every(s => s.values[iAug] !== null), 'projected months are included');
  // Saveable in ui.plan.trends.series: the account keys too, though account ids come with the data.
  let st = E.state.defaults({ people: PEOPLE }, ds);
  st = E.state.setPath(st, 'ui.plan.trends.series', ['balance-combined', 'balance-sav2', 'balance-savings-total', 'net']);
  assert.deepEqual(st.ui.plan.trends.series, ['balance-combined', 'balance-sav2', 'balance-savings-total', 'net']);
  assert.deepEqual(E.state.sanitize(JSON.parse(JSON.stringify(st))).state.ui.plan.trends.series, st.ui.plan.trends.series, 'kept when the budget is opened again');
  assert.deepEqual(run(ds, { settings: st.ui.plan }).settings.trends.series, st.ui.plan.trends.series);
  assert.equal(E.state.TREND_SERIES.includes('balance-'), false, 'a key needs an account id after the prefix');
  // One savings account: no total. Simple mode: the combined line only. No balance known: none.
  const one = run(small({ withSavings: true }), { plan: planWith({ accounts: { chk: 350000, sav: 90000 }, accountsAsOf: '2026-05-31' }), settings: LOSING });
  assert.deepEqual(one.series.filter(s => s.kind === 'balance').map(s => s.key), ['balance-combined', 'balance-chk', 'balance-sav']);
  const simple = run(small(), { plan: planWith({ jointCashCents: 500000, asOf: '2026-05-31' }), settings: LOSING });
  assert.equal(simple.balances.mode, 'simple');
  assert.deepEqual(simple.series.filter(s => s.kind === 'balance').map(s => [s.key, s.values]), [['balance-combined', simple.balances.combined.points.map(p => p.cents)]]);
  const none = run(small(), { settings: LOSING });
  assert.equal(none.balances.combined, null);
  assert.deepEqual(none.series.filter(s => s.kind === 'balance'), []);
});

/** A small RFC 4180 reader for the tests: rows of fields. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test('CSV: a settings block, a blank line, then one row per month; plain dollars, empty for unknown, quoted where needed', () => {
  const odd = spend('card', '2026-04-11', 61234, 'Fox, "The" Outfitters', 'Travel');
  const ds = small({ withSavings: true });
  const ds2 = L.normalizeDataset(Object.assign({}, ds, { transactions: ds.transactions.concat([odd]) }));
  const plan = Object.assign(planWith({ accounts: { chk: 350000, sav: 90000 }, accountsAsOf: '2026-05-31' }), { changes: [change('gym', { label: '=Gym, "Pro"', startMonth: '2026-07', cents: 6000 })] });
  const r = run(ds2, { plan, settings: { dials: { p1: 200000, p2: 0, essentials: 150000, flexible: 95050, savings: -1234 } } });
  const csv = T.toCSV(r);
  assert.equal(csv, T.toCSV(r), 'deterministic');
  assert.ok(csv.includes('\r\n') && csv.endsWith('\r\n'));
  const rows = parseCSV(csv);
  assert.deepEqual(rows.slice(0, 2), [['Settings'], ['key', 'value']]);
  const blank = rows.findIndex(x => x.length === 1 && x[0] === '');
  assert.ok(blank > 2, 'a blank line between the blocks');
  assert.deepEqual(rows[blank + 1], ['Months']);
  const header = rows[blank + 2];
  assert.deepEqual(header, ['month', 'status', 'in_p1', 'in_p2', 'in_other', 'in_total', 'essentials', 'flexible', 'irregular', 'other_out', 'out_total', 'to_savings', 'from_savings', 'combined_change', 'net_checking', 'combined_balance', 'combined_status', 'chk_balance', 'chk_status', 'sav_balance', 'sav_status']);
  const body = rows.slice(blank + 3);
  assert.equal(body.length, r.months.length);
  const cell = (month, col) => body.find(x => x[0] === month)[header.indexOf(col)];
  assert.equal(cell('2026-08', 'status'), 'plan');
  assert.equal(cell('2026-08', 'essentials'), '1500.00');
  assert.equal(cell('2026-08', 'flexible'), '1010.50', '950.50 + the 60.00 gym change');
  assert.equal(cell('2026-08', 'from_savings'), '12.34');
  assert.equal(cell('2026-08', 'to_savings'), '0.00');
  assert.equal(cell('2026-08', 'combined_change'), String((r.months.find(m => m.month === '2026-08').combinedChange / 100).toFixed(2)));
  assert.equal(cell('2026-08', 'combined_status'), 'projected');
  assert.equal(cell('2026-04', 'irregular'), '612.34');
  assert.equal(cell('2026-04', 'chk_status'), 'reconstructed');
  assert.equal(cell('2026-04', 'in_p1'), '2000.00');
  // Unknown is empty, never 0.
  const feb = body.find(x => x[0] === '2026-02');
  assert.deepEqual([feb[header.indexOf('in_total')], feb[header.indexOf('net_checking')]], ['', '']);
  // Settings: key,value rows, with labels quoted and formula-like text made inert.
  const kv = Object.fromEntries(rows.slice(2, blank).map(x => [x[0], x[1]]));
  assert.equal(kv['dial.essentials.plan'], '1500.00');
  assert.equal(kv['dial.savings.plan'], '-12.34');
  assert.equal(kv['dial.essentials.source'], 'direct');
  assert.equal(kv['horizon_months'], '12');
  assert.equal(kv['cover_from_savings'], 'yes');
  assert.equal(kv['one_time.' + odd.id + '.label'], 'Fox, "The" Outfitters');
  assert.equal(kv['one_time.' + odd.id + '.state'], 'in the irregular allowance');
  assert.equal(kv['change.gym.label'], '\'=Gym, "Pro"');
  assert.deepEqual([kv['change.gym.accepted'], kv['change.gym.amount'], kv['change.gym.start'], kv['change.gym.status']], ['yes', '60.00', '2026-07', 'applied']);
  assert.deepEqual([kv['balance.chk.date'], kv['balance.chk.amount'], kv['balance.chk.source']], ['2026-05-31', '3500.00', 'entered']);
  assert.ok(csv.includes('"Fox, ""The"" Outfitters"'), 'RFC 4180 quoting');
  // Cents on request; other people's columns.
  const cents = parseCSV(T.toCSV(r, { format: 'cents', people: [{ id: 'p1', name: 'Morgan' }] }));
  const h2 = cents.find(x => x[0] === 'month');
  assert.equal(h2.indexOf('in_p2'), -1);
  assert.equal(cents.find(x => x[0] === '2026-08')[h2.indexOf('essentials')], '150000');
  assert.throws(() => T.toCSV(null), err => err instanceof E.ValidationError);
});

// ------------------------------------------------------------------ changes saved under the earlier card/bank dials

test('row changes saved under the earlier card and bank dials still apply to the same rows, and migrateRows makes that permanent', () => {
  const ds = household();
  const oldId = (dial, kind, ...parts) => dial + '-' + kind + '-' + E.util.hash(parts.join('\u0001'));
  const lumenOld = oldId('card', 'm', 'Subscriptions', 'Lumen Streaming');
  const mortgageOld = oldId('bank', 'c', 'Mortgage');
  const otherOld = oldId('card', 'c', 'Other');
  const goneOld = oldId('card', 'm', 'Groceries', 'Nobody Market');
  let state = E.state.defaults(null, ds);
  state = E.state.setPath(state, 'ui.plan.rows.' + lumenOld, { included: false });
  state = E.state.setPath(state, 'ui.plan.rows.' + mortgageOld, { cents: 140000 });
  state = E.state.setPath(state, 'ui.plan.rows.' + otherOld, { cents: 1 });
  state = E.state.setPath(state, 'ui.plan.rows.' + goneOld, { cents: 2 });
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r = build(state);
  const lumen = r.dialsByKey.flexible.drill.rows.find(x => x.label === 'Lumen Streaming');
  const mortgage = r.dialsByKey.essentials.drill.rows.find(x => x.level === 1 && x.label === 'Mortgage');
  assert.deepEqual([lumen.included, lumen.legacyId], [false, lumenOld]);
  assert.deepEqual([mortgage.planCents, mortgage.legacyId], [140000, mortgageOld]);
  assert.deepEqual(r.migration.rows, [{ from: lumenOld, to: lumen.id }, { from: mortgageOld, to: mortgage.id }].sort((a, b) => (a.from < b.from ? -1 : 1)));
  assert.deepEqual(r.migration.dropped.sort(), [goneOld, otherOld].sort(), 'the grouped "Other" and a place that is gone cannot be matched');
  const next = T.migrateRows(state, r);
  assert.deepEqual(Object.keys(next.ui.plan.rows).sort(), [lumen.id, mortgage.id].sort());
  assert.deepEqual(next.ui.plan.rows[lumen.id], { included: false });
  assert.ok(next.meta.migrationNotes.includes(r.migration.rowsNote));
  assert.match(r.migration.rowsNote, /^ui\.plan\.rows: spending is now planned as essentials, flexible and irregular\. 2 changes to card and bank spending rows now apply to the same rows there\. 2 changes to card and bank spending rows could not be matched/);
  assert.equal(r.migration.note, r.migration.rowsNote.replace(/^ui\.plan\.rows: /, ''), 'the note to show, without the path');
  assert.equal(r.migration.dials, null, 'no card or bank amount waiting');
  assert.equal(T.migrateDials(next, r), next, 'nothing for migrateDials to do');
  const r2 = build(next);
  assert.equal(r2.migration, null);
  assert.deepEqual([r2.dialsByKey.flexible.planCents, r2.dialsByKey.essentials.planCents], [r.dialsByKey.flexible.planCents, r.dialsByKey.essentials.planCents], 'the same plan after the move');
  assert.equal(T.migrateRows(next, r2), next, 'nothing to do');
  // Resetting a dial with the timeline also clears the earlier changes its rows use.
  const reset = T.resetDial(state, 'flexible', r);
  assert.deepEqual(Object.keys(reset.ui.plan.rows).sort(), [mortgageOld, otherOld, goneOld].sort());
});

// ------------------------------------------------------------------ amounts set for the earlier card and bank dials

const SPEND = ['essentials', 'flexible', 'irregular'];
/** A state with amounts waiting for the earlier card/bank dials, and a build for it. */
function legacyRig(ds, legacy, extra = {}) {
  const st = E.state.defaults(null, ds);
  st.ui.plan = Object.assign({}, st.ui.plan, extra, { legacyDials: legacy });
  if (extra.dials) st.ui.plan.dials = extra.dials;
  const build = s => T.build({ txns: L.applyEdits(ds, s.ledgerEdits), dataset: ds, plan: Object.assign({}, s.plan, { people: PEOPLE }), settings: s.ui.plan, today: '2026-07-03' });
  return { st, build };
}
const baseParts = (r, side) => SPEND.map(k => r.dialsByKey[k][side === 'card' ? 'baselineCardCents' : 'baselineBankCents']);
const sum = list => list.reduce((s, v) => s + v, 0);

test('the earlier card amount is carried over by scaling the card part of the three spending dials: they add up to it exactly, remainder included', () => {
  const ds = household({ extra: [spend('card', '2026-04-18', 129900, 'Summit Appliance', 'Electronics')] });
  const plain = legacyRig(ds, {});
  const r0 = plain.build(plain.st);
  const card = baseParts(r0, 'card'), bank = baseParts(r0, 'bank');
  assert.ok(card.every(v => v > 0), 'every dial has a card part here');
  const C = sum(card), B = sum(bank);
  // An amount whose proportional shares do not round to it: the remainder has somewhere to go.
  let X = 420000;
  while (sum(card.map(c => Math.round(c * X / C))) === X) X += 1;
  const { st, build } = legacyRig(ds, { card: X });
  const r = build(st);
  const mig = r.migration.dials;
  assert.deepEqual(mig.from, { card: X });
  assert.deepEqual(mig.skipped, []);
  const parts = SPEND.map(k => mig.parts[k].card);
  assert.equal(sum(parts), X, 'the card parts add up to the amount set, to the cent');
  const big = card.indexOf(Math.max(...card));
  SPEND.forEach((k, i) => {
    const exact = card[i] * X / C;
    if (i === big) assert.ok(Math.abs(parts[i] - exact) < 3, k + ' takes the remainder');
    else assert.equal(parts[i], Math.round(exact), k);
    assert.equal(mig.parts[k].bank, bank[i], k + ': the bank part stays at its baseline');
    assert.equal(mig.to[k], bank[i] + parts[i], k);
  });
  assert.notEqual(parts[big], Math.round(card[big] * X / C), 'the remainder went to the largest card part');
  assert.equal(mig.note, 'Your earlier card spending setting of ' + E.money.format(X) + ' was carried over by scaling the card part of Essentials, Flexible and Irregular (they now add up to it); adjust them individually from here.');
  assert.equal(r.migration.note, mig.note);
  assert.equal(r.migration.rowsNote, null);
  // Applied: three direct amounts, whose card parts are the ones worked out.
  const next = T.migrateDials(st, r);
  assert.deepEqual(next.ui.plan.dials, Object.fromEntries(SPEND.map(k => [k, mig.to[k]])));
  assert.equal(next.ui.plan.legacyDials, undefined);
  assert.deepEqual(next.ui.plan.cardSplit, Object.fromEntries(SPEND.map(k => [k, { cents: mig.to[k], card: mig.parts[k].card, fromCard: X }])));
  assert.ok(next.meta.migrationNotes.includes(mig.note));
  const r2 = build(next);
  assert.deepEqual(SPEND.map(k => [r2.dialsByKey[k].source, r2.dialsByKey[k].cardCents, r2.dialsByKey[k].bankCents]), SPEND.map((k, i) => ['direct', parts[i], bank[i]]));
  assert.deepEqual([r2.plan.out.card, r2.plan.out.bank], [X, B]);
  assert.equal(sum(SPEND.map(k => r2.dialsByKey[k].planCents)), X + B);
  // Once: nothing is waiting any more.
  assert.equal(r2.migration, null);
  assert.equal(T.migrateDials(next, r2), next);
  assert.equal(T.migrateDials(next, r), next, 'an older build changes nothing either');
  // Moving a dial afterwards: its kept card part no longer applies.
  const moved = T.setDial(next, 'essentials', mig.to.essentials + 1000);
  assert.equal(moved.ui.plan.cardSplit.essentials, undefined);
  const r3 = build(moved);
  assert.equal(r3.dialsByKey.essentials.cardCents, Math.round((mig.to.essentials + 1000) * r3.dialsByKey.essentials.cardShare));
  assert.deepEqual(T.resetPlan(next).ui.plan.cardSplit, {}, 'reset clears the kept card parts');
  assert.deepEqual(T.resetPlan(next).ui.plan.dials, {});
});

test('the earlier bank amount scales the bank parts; card and bank together each add up to what was set', () => {
  const ds = household();
  const r0 = legacyRig(ds, {}).build(legacyRig(ds, {}).st);
  const card = baseParts(r0, 'card'), bank = baseParts(r0, 'bank');
  const Y = 180001;
  const one = legacyRig(ds, { bank: Y });
  const rb = one.build(one.st);
  const mb = rb.migration.dials;
  assert.equal(sum(SPEND.map(k => mb.parts[k].bank)), Y);
  assert.deepEqual(SPEND.map(k => mb.parts[k].card), card, 'card parts stay at their baseline');
  assert.deepEqual(bank.map(b => b > 0), [true, false, false], 'only essentials is paid from the bank here…');
  assert.deepEqual(SPEND.map(k => mb.parts[k].bank), [Y, 0, 0], '…so it takes the whole bank amount');
  assert.equal(mb.note, 'Your earlier bank spending setting of $1,800.01 was carried over by scaling the bank part of Essentials, Flexible and Irregular (they now add up to it); adjust them individually from here.');
  const rb2 = one.build(T.migrateDials(one.st, rb));
  assert.deepEqual([rb2.plan.out.card, rb2.plan.out.bank], [sum(card), Y]);
  // Both.
  const X = 333333;
  const two = legacyRig(ds, { card: X, bank: Y });
  const r = two.build(two.st);
  const m = r.migration.dials;
  assert.deepEqual([sum(SPEND.map(k => m.parts[k].card)), sum(SPEND.map(k => m.parts[k].bank))], [X, Y]);
  assert.equal(m.note, 'Your earlier card spending setting of $3,333.33 and bank spending setting of $1,800.01 were carried over by scaling the card and bank parts of Essentials, Flexible and Irregular (they now add up to them); adjust them individually from here.');
  const r2 = two.build(T.migrateDials(two.st, r));
  assert.deepEqual([r2.plan.out.card, r2.plan.out.bank], [X, Y]);
  assert.deepEqual(SPEND.map(k => r2.dialsByKey[k].planCents), SPEND.map(k => m.to[k]));
});

test('no card spending in the baseline: the whole card amount goes to Flexible; a dial already set is left alone and named', () => {
  // Only bank-paid spending: a mortgage and a utility.
  const txns = [];
  for (const m of E.months.range('2025-10', '2026-06')) {
    txns.push(spend('chk', `${m}-01`, 145000, 'Westbrook Home Loans', 'Mortgage'));
    txns.push(spend('chk', `${m}-15`, 9900, 'Copperline Power', 'Electric'));
  }
  const ds = dataset(txns, { from: '2025-10-01', to: '2026-06-30' });
  const { st, build } = legacyRig(ds, { card: 50000 });
  const r = build(st);
  const m = r.migration.dials;
  assert.deepEqual(SPEND.map(k => m.parts[k].card), [0, 50000, 0]);
  assert.deepEqual(m.to, { essentials: r.dialsByKey.essentials.baselineBankCents, flexible: 50000, irregular: 0 });
  assert.equal(m.note, 'Your earlier card spending setting of $500.00 was carried over by putting the card amount on Flexible (there was no card spending in the baseline to scale); adjust them individually from here.');
  const r2 = build(T.migrateDials(st, r));
  assert.deepEqual([r2.plan.out.card, r2.plan.out.bank, r2.dialsByKey.flexible.cardCents], [50000, 145000 + 9900, 50000]);
  // Flexible already set directly: left alone, and the note says so (and no longer claims a total).
  const set = legacyRig(household(), { card: 400000 }, { dials: { flexible: 61000 } });
  const rs = set.build(set.st);
  assert.deepEqual(rs.migration.dials.skipped, ['flexible']);
  assert.equal(rs.migration.dials.to.flexible, null);
  assert.equal(rs.migration.dials.note, 'Your earlier card spending setting of $4,000.00 was carried over by scaling the card part of Essentials, Flexible and Irregular; adjust them individually from here. Flexible was already set by you and was left as it is.');
  const after = T.migrateDials(set.st, rs);
  assert.equal(after.ui.plan.dials.flexible, 61000);
  assert.equal(after.ui.plan.cardSplit.flexible, undefined);
  assert.deepEqual(Object.keys(after.ui.plan.cardSplit).sort(), ['essentials', 'irregular']);
  // All three already set: nothing to carry over, said plainly; the waiting amount is still cleared.
  const all = legacyRig(household(), { bank: 1 }, { dials: { essentials: 1, flexible: 2, irregular: 3 } });
  const ra = all.build(all.st);
  assert.equal(ra.migration.dials.note, 'Your earlier bank spending setting of $0.01 was not carried over: Essentials, Flexible and Irregular were already set by you.');
  const done = T.migrateDials(all.st, ra);
  assert.deepEqual([done.ui.plan.dials, done.ui.plan.legacyDials], [{ essentials: 1, flexible: 2, irregular: 3 }, undefined]);
});

test('no complete month yet: what was set goes to Flexible; a card dial saved without state.sanitize is carried over and removed too', () => {
  const half = dataset([spend('card', '2026-06-05', 4200, 'Harbor Grocer', 'Groceries')], { from: '2026-06-01', to: '2026-06-15' });
  const { st, build } = legacyRig(half, { card: 1000 });
  const r = build(st);
  assert.equal(r.baseline.count, 0);
  assert.deepEqual(r.migration.dials.to, { essentials: null, flexible: 1000, irregular: null });
  assert.equal(r.migration.dials.note, 'Your earlier card spending setting of $10.00 was carried over to Flexible (there is no baseline yet to scale it by); adjust it from here.');
  assert.deepEqual(T.migrateDials(st, r).ui.plan.dials, { flexible: 1000 });
  // A budget whose dials still hold card (set in memory, as an older page would have saved it).
  const ds = household();
  const raw = E.state.defaults(null, ds);
  raw.ui.plan = Object.assign({}, raw.ui.plan, { dials: { card: 300000, savings: 100 } });
  const b = T.build({ txns: L.applyEdits(ds, {}), dataset: ds, plan: Object.assign({}, raw.plan, { people: PEOPLE }), settings: raw.ui.plan, today: '2026-07-03' });
  assert.deepEqual(b.migration.dials.from, { card: 300000 });
  const next = T.migrateDials(raw, b);
  assert.deepEqual(Object.keys(next.ui.plan.dials).sort(), ['essentials', 'flexible', 'irregular', 'savings']);
  assert.equal(next.ui.plan.dials.card, undefined, 'the old dial is gone');
});

test('row changes and dial amounts from the earlier card dial are carried over together: one note to show, each recorded once', () => {
  const ds = household();
  const oldId = 'card-m-' + E.util.hash(['Subscriptions', 'Lumen Streaming'].join('\u0001'));
  const { st: s0, build } = legacyRig(ds, { card: 250000 });
  const st = E.state.setPath(s0, 'ui.plan.rows.' + oldId, { included: false });
  const r = build(st);
  assert.ok(r.migration.rowsNote && r.migration.dials);
  assert.equal(r.migration.note, r.migration.rowsNote.replace(/^ui\.plan\.rows: /, '') + ' ' + r.migration.dials.note);
  const next = T.migrateDials(T.migrateRows(st, r), r);
  assert.ok(next.meta.migrationNotes.includes(r.migration.rowsNote) && next.meta.migrationNotes.includes(r.migration.dials.note));
  assert.equal(build(next).migration, null);
  assert.equal(build(next).plan.out.card, 250000, 'the direct amounts win over the row change, as the card dial did');
});

test('pendingUpgrade names what the plan screen applies once (migrateRows, migrateDials), with the note to show; applying it twice changes nothing more', () => {
  const ds = household();
  const oldId = 'card-m-' + E.util.hash(['Subscriptions', 'Lumen Streaming'].join('\u0001'));
  const { st: s0, build } = legacyRig(ds, { card: 250000 });
  const st = E.state.setPath(s0, 'ui.plan.rows.' + oldId, { included: false });
  const r = build(st);
  const up = T.pendingUpgrade(r);
  assert.deepEqual(up.steps, ['migrateRows', 'migrateDials']);
  assert.equal(up.note, r.migration.note);
  const next = up.apply(st);
  assert.deepEqual(next, T.migrateDials(T.migrateRows(st, r), r), 'what the plan screen did by hand');
  assert.deepEqual(up.apply(next), next, 'safe to run twice');
  assert.equal(T.pendingUpgrade(build(next)), null, 'nothing left');
  // Only one of the two waiting.
  assert.deepEqual(T.pendingUpgrade(build(s0)).steps, ['migrateDials']);
  const rowsOnly = E.state.setPath(E.state.defaults(null, ds), 'ui.plan.rows.' + oldId, { included: false });
  const rr = build(rowsOnly);
  assert.deepEqual(T.pendingUpgrade(rr).steps, ['migrateRows']);
  assert.deepEqual(T.pendingUpgrade(rr).apply(rowsOnly), T.migrateRows(rowsOnly, rr));
  // No timeline, or nothing waiting.
  for (const tl of [undefined, null, {}, { migration: null }, build(E.state.defaults(null, ds))]) assert.equal(T.pendingUpgrade(tl), null);
});

test('settings: read through state.cleanPlanUi (the one ui.plan validator); its only addition is a card or bank amount still among the dials, which waits in legacyDials', () => {
  const raw = Object.freeze({ horizon: 24, dials: Object.freeze({ card: 5000, bank: -20, essentials: 7, mystery: 1 }), legacyDials: Object.freeze({ card: 1, bank: 2 }), futureField: 1 });
  const cfg = T.settings(raw);
  assert.deepEqual(cfg, Object.assign(E.state.cleanPlanUi(raw), { legacyDials: { card: 5000, bank: -20 }, cardSplit: {} }), 'the dial amounts are newer and win');
  assert.deepEqual(cfg.dials, { essentials: 7 }, 'card and bank are not dials; an unknown dial is left out');
  assert.equal('futureField' in cfg, false, 'a key this version does not know is not read');
  // A blank card dial or one that is not an amount is not moved; nothing waiting: legacyDials is {}.
  assert.deepEqual(T.settings({ dials: { card: null, bank: 'x' }, legacyDials: { bank: 3 } }).legacyDials, { bank: 3 });
  assert.deepEqual(T.settings({ dials: { essentials: 1 } }).legacyDials, {});
  // For a saved budget (checked by sanitize) it is cleanPlanUi with legacyDials and cardSplit always present.
  const ds = household();
  let st = E.state.setPath(E.state.defaults(null, ds), 'ui.plan.cardSplit.essentials', { cents: 3, card: 1 });
  st = E.state.setPath(st, 'ui.plan.legacyDials.bank', 9);
  st = E.state.setPath(st, 'ui.plan.trends.series', ['in-p1', 'net']);
  for (const p of [st.ui.plan, E.state.defaults(null, ds).ui.plan]) {
    assert.deepEqual(T.settings(p), Object.assign({ legacyDials: {}, cardSplit: {} }, E.state.cleanPlanUi(p)));
    assert.deepEqual(E.state.cleanPlanUi(p), p, 'a saved ui.plan is already clean');
  }
});

test('a carried-over amount stays explained until it is kept or changed: per dial and once for the headline; it survives a save and a second upgrade', () => {
  const ds = household();
  const { st, build } = legacyRig(ds, { card: 420000 });
  const before = build(st);
  assert.equal(before.carriedOver, null, 'nothing carried over yet');
  assert.ok(before.dials.every(d => d.carriedOver === null));
  const next = T.migrateDials(st, before);
  const r = build(next);
  const note = 'Carried over from your earlier card spending setting of $4,200.00 (card parts of Essentials, Flexible and Irregular add up to it).';
  for (const k of SPEND) assert.deepEqual(r.dialsByKey[k].carriedOver, { from: 'card', cardTotalCents: 420000, bankTotalCents: null, note }, k);
  assert.ok(r.dials.filter(d => !SPEND.includes(d.key)).every(d => d.carriedOver === null));
  assert.deepEqual(r.carriedOver, { from: 'card', cardTotalCents: 420000, bankTotalCents: null, note, dials: SPEND,
    summary: 'Three dials carry your earlier card spending setting of $4,200.00 — review them, then Keep or Reset.' });
  // Saved and loaded (state.sanitize, then the engine's own settings), and upgraded again: unchanged.
  const saved = E.state.sanitize(JSON.parse(JSON.stringify(next)), null, ds).state;
  assert.deepEqual(saved.ui.plan.cardSplit, next.ui.plan.cardSplit);
  assert.deepEqual(build(saved).carriedOver, r.carriedOver);
  assert.equal(T.migrateDials(saved, build(saved)), saved, 'a second upgrade changes nothing');
  assert.deepEqual(E.state.sanitize(saved, null, ds).state, saved);
  // Keep one: its marker goes, the amount and its card part stay, so the others still add up.
  const kept = T.acceptCarriedOver(next, 'flexible');
  assert.deepEqual(kept.ui.plan.cardSplit.flexible, { cents: next.ui.plan.cardSplit.flexible.cents, card: next.ui.plan.cardSplit.flexible.card });
  assert.equal(kept.ui.plan.dials.flexible, next.ui.plan.dials.flexible);
  const rk = build(kept);
  assert.equal(rk.dialsByKey.flexible.carriedOver, null);
  assert.equal(rk.dialsByKey.flexible.cardCents, r.dialsByKey.flexible.cardCents, 'keeping changes no amount');
  assert.equal(rk.dialsByKey.essentials.carriedOver.note, note);
  assert.equal(rk.carriedOver.summary, 'Two dials carry your earlier card spending setting of $4,200.00 — review them, then Keep or Reset.');
  assert.equal(rk.plan.out.card, 420000);
  assert.equal(T.acceptCarriedOver(kept, 'flexible'), kept, 'nothing left to keep');
  const allKept = T.acceptCarriedOver(next, SPEND);
  assert.equal(build(allKept).carriedOver, null);
  // Changing a dial or resetting it clears its marker; the note then stops claiming a total.
  const changed = T.setDial(next, 'essentials', r.dialsByKey.essentials.planCents + 500);
  const rc = build(changed);
  assert.equal(rc.dialsByKey.essentials.carriedOver, null);
  assert.equal(rc.dialsByKey.irregular.carriedOver.note, 'Carried over from your earlier card spending setting of $4,200.00.');
  assert.equal(rc.carriedOver.summary, 'Two dials carry your earlier card spending setting of $4,200.00 — review them, then Keep or Reset.');
  const reset = build(T.resetDial(next, 'irregular', r));
  assert.deepEqual([reset.dialsByKey.irregular.source, reset.dialsByKey.irregular.carriedOver], ['baseline', null]);
  assert.equal(build(T.resetPlan(next)).carriedOver, null);
  // Card and bank together; one dial left alone because it was set.
  const both = legacyRig(ds, { card: 300000, bank: 160000 });
  const rb = both.build(T.migrateDials(both.st, both.build(both.st)));
  assert.equal(rb.dialsByKey.flexible.carriedOver.note, 'Carried over from your earlier card spending setting of $3,000.00 and bank spending setting of $1,600.00 (card and bank parts of Essentials, Flexible and Irregular add up to them).');
  assert.equal(rb.carriedOver.from, 'both');
  const one = legacyRig(ds, { bank: 160000 }, { dials: { flexible: 1, irregular: 2 } });
  const ro = one.build(T.migrateDials(one.st, one.build(one.st)));
  assert.deepEqual(ro.carriedOver, { from: 'bank', cardTotalCents: null, bankTotalCents: 160000, note: 'Carried over from your earlier bank spending setting of $1,600.00.', dials: ['essentials'],
    summary: 'One dial carries your earlier bank spending setting of $1,600.00 — review it, then Keep or Reset.' });
});

// ------------------------------------------------------------------ carry-over keeps the household's row changes on the other side
// The public synthetic sample (fixtures/sample-data.json, sample-profile.json): Mortgage is paid from
// the bank, Groceries by card. Row changes are saved under the earlier ids ('bank-c-…', 'card-c-…'),
// as an older page saved them; migrateRows carries them over.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const FIX = path.join(__dirname, '..', '..', 'fixtures');
  const sampleDs = L.normalizeDataset(fs.readFileSync(path.join(FIX, 'sample-data.json'), 'utf8'));
  const sampleProfile = () => JSON.parse(fs.readFileSync(path.join(FIX, 'sample-profile.json'), 'utf8'));
  const legacyRow = (dial, category) => dial + '-c-' + E.util.hash(category);
  const MORTGAGE = legacyRow('bank', 'Mortgage'), GROCERIES = legacyRow('card', 'Groceries');
  const buildSample = st => T.build({ txns: L.applyEdits(sampleDs, st.ledgerEdits), dataset: sampleDs, plan: st.plan, settings: st.ui.plan, today: '2026-10-02' });
  /** The sample's state with row changes, dials and earlier card/bank amounts written through state paths. */
  function sampleState({ rows = {}, dials = {}, legacy = {} } = {}) {
    let st = E.state.defaults(sampleProfile(), sampleDs);
    for (const [id, v] of Object.entries(rows)) st = E.state.setPath(st, 'ui.plan.rows.' + id, v);
    for (const [k, v] of Object.entries(dials)) st = E.state.setPath(st, 'ui.plan.dials.' + k, v);
    for (const [k, v] of Object.entries(legacy)) st = E.state.setPath(st, 'ui.plan.legacyDials.' + k, v);
    return st;
  }
  /** What the plan screen does once: migrateRows, then migrateDials, with one build. */
  const upgrade = st => { const tl = buildSample(st); return { tl, next: T.migrateDials(T.migrateRows(st, tl), tl) }; };

  test('regression: a card-only carry-over keeps a bank-side row change (the mortgage row) in the plan', () => {
    const before = buildSample(sampleState({ rows: { [MORTGAGE]: { cents: 76543 } } }));
    assert.equal(before.dialsByKey.essentials.drill.rows.find(r => r.level === 1 && r.label === 'Mortgage').planCents, 76543, 'the row change applies before the upgrade');
    const { tl, next } = upgrade(sampleState({ rows: { [MORTGAGE]: { cents: 76543 } }, legacy: { card: 321987 } }));
    assert.ok(tl.migration.rows.length && tl.migration.dials);
    const after = buildSample(next);
    assert.equal(after.plan.out.card, 321987);
    assert.equal(after.plan.out.bank, before.plan.out.bank, 'the bank side is what the rows give, mortgage change included');
    assert.notEqual(after.plan.out.bank, before.dials.reduce((s, d) => s + (d.baselineBankCents || 0), 0), 'not the baseline');
  });

  test('regression: a bank-only carry-over keeps a card-side row change (the groceries row) in the plan', () => {
    const before = buildSample(sampleState({ rows: { [GROCERIES]: { cents: 43210 } } }));
    const { next } = upgrade(sampleState({ rows: { [GROCERIES]: { cents: 43210 } }, legacy: { bank: 234567 } }));
    const after = buildSample(next);
    assert.equal(after.plan.out.bank, 234567);
    assert.equal(after.plan.out.card, before.plan.out.card, 'the card side is what the rows give, groceries change included');
  });

  test('regression: both amounts replace the rows on both sides; the other dials are not touched', () => {
    const rows = { [MORTGAGE]: { cents: 76543 }, [GROCERIES]: { cents: 43210 } };
    const before = buildSample(sampleState({ rows }));
    const { next } = upgrade(sampleState({ rows, legacy: { card: 321987, bank: 234567 } }));
    const after = buildSample(next);
    assert.deepEqual([after.plan.out.card, after.plan.out.bank], [321987, 234567]);
    assert.equal(['essentials', 'flexible', 'irregular'].reduce((s, k) => s + after.dialsByKey[k].planCents, 0), 556554);
    for (const k of ['p1', 'p2', 'savings']) {
      assert.deepEqual([after.dialsByKey[k].source, after.dialsByKey[k].planCents], [before.dialsByKey[k].source, before.dialsByKey[k].planCents], k);
    }
    assert.deepEqual(Object.keys(next.ui.plan.dials).sort(), ['essentials', 'flexible', 'irregular']);
  });

  test('regression: running the upgrade again changes nothing, and nothing is left to migrate', () => {
    const { next } = upgrade(sampleState({ rows: { [MORTGAGE]: { cents: 76543 }, [GROCERIES]: { cents: 43210 } }, legacy: { card: 321987, bank: 234567 } }));
    const again = buildSample(next);
    assert.equal(again.migration, null);
    assert.equal(T.migrateDials(T.migrateRows(next, again), again), next);
    assert.deepEqual(upgrade(next).next, next);
  });

  test('series: the sample balance lines are in the Trends catalogue, at month end, and can be saved', () => {
    const tl = buildSample(sampleState());
    const bal = tl.series.filter(s => s.kind === 'balance');
    assert.deepEqual(tl.balances.accounts.map(a => [a.id, a.group]), [['joint-checking', 'checking'], ['joint-savings', 'savings']]);
    assert.deepEqual(bal.map(s => [s.key, s.name, s.group, s.unit]), [
      ['balance-combined', 'Combined cash', 'balances', 'atMonthEnd'],
      ['balance-joint-checking', 'Joint checking balance', 'balances', 'atMonthEnd'],
      ['balance-joint-savings', 'Joint savings balance', 'balances', 'atMonthEnd'],
    ], 'one savings account: no savings total');
    assert.deepEqual(bal[0].values, tl.balances.combined.points.map(p => p.cents));
    tl.balances.accounts.forEach((a, i) => assert.deepEqual(bal[i + 1].values, a.points.map(p => p.cents), a.id));
    const iPlan = tl.months.findIndex(m => m.month === tl.planStart);
    assert.equal(tl.balances.combined.points[tl.months.length - 1].status, 'projected');
    assert.ok(bal.every(s => s.values.slice(iPlan).every(v => Number.isSafeInteger(v))), 'every plan month has a projected month-end balance');
    let st = sampleState();
    st = E.state.setPath(st, 'ui.plan.trends.series', bal.map(s => s.key));
    assert.deepEqual(buildSample(st).settings.trends.series, bal.map(s => s.key));
  });

  test('regression: Flexible already set stays as set; Essentials keeps its bank rows with the mortgage change', () => {
    const before = buildSample(sampleState({ rows: { [MORTGAGE]: { cents: 76543 } }, dials: { flexible: 87654 } }));
    const { tl, next } = upgrade(sampleState({ rows: { [MORTGAGE]: { cents: 76543 } }, dials: { flexible: 87654 }, legacy: { card: 321987 } }));
    assert.match(tl.migration.dials.note, /Flexible was already set by you and was left as it is/);
    const after = buildSample(next);
    assert.equal(next.ui.plan.dials.flexible, 87654);
    assert.deepEqual([after.dialsByKey.flexible.source, after.dialsByKey.flexible.planCents], ['direct', 87654]);
    assert.equal(after.dialsByKey.essentials.bankCents, before.dialsByKey.essentials.bankCents);
    assert.equal(after.dialsByKey.irregular.bankCents, before.dialsByKey.irregular.bankCents);
  });
}
