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
const LOSING = { dials: { p1: 200000, p2: 0, card: 150000, bank: 95000, savings: 0 } };

test('an entered balance is used at its exact date and worked back to the day before the export starts, never further', () => {
  const ds = small();
  const r = run(ds, { plan: planWith({ accounts: { chk: 350000 }, accountDates: { chk: '2026-06-10' } }), settings: LOSING });
  const chk = account(r, 'chk');
  assert.deepEqual(chk.anchor, { date: '2026-06-10', cents: 350000, source: 'entered' }, 'the date is never moved');
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
  const settings = { dials: { p1: 200000, p2: 0, card: 150000, bank: 100000, savings: 10000 }, horizon: 6 };
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
  const settings = { dials: { p1: 200000, p2: 0, card: 150000, bank: 80000, savings: 25000 } };
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
  const r = run(ds, { plan, settings: { dials: { p1: 200000, p2: 0, card: 150000, bank: 95000, savings: 6000 } } });
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
const QUARTER_DIALS = { dials: { p1: 210000, p2: 0, card: 120000, bank: 100000, savings: 10000 } };
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
  assert.deepEqual(account(r, 'chk').anchor, { date: '2026-10-02', cents: 412000, source: 'entered' });
  assert.deepEqual(account(r, 'sav').anchor, { date: '2026-10-02', cents: 95500, source: 'entered' });
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
  assert.equal(all.dialsByKey.card.basis.split(';')[0], 'Average of all 9 complete months, Oct 2025–Jun 2026');
  const twelve = run(ds, { settings: { baselineMonths: 12 }, today: '2026-07-03' });
  assert.equal(twelve.baseline.count, 9);
  assert.match(twelve.dialsByKey.bank.basis, /^Average of Oct 2025–Jun 2026, 9 months \(all there are\)/);
  const three = run(ds, { settings: { baselineMonths: 3 }, today: '2026-07-03' });
  assert.deepEqual(three.baseline.months, ['2026-04', '2026-05', '2026-06']);
  // No pay saved in Budget here: the person dials stand in with the deposit average, labelled as such.
  assert.equal(three.dialsByKey.p2.basis, 'Average of Apr 2026–Jun 2026 deposits, 3 months — not a confirmed setting');
  // Both bank bills are stable (monthly, within 10%): each counts at its latest charge.
  assert.equal(three.dialsByKey.bank.baselineCents, 145000 + (8800 + 8 * 210));
  assert.match(three.dialsByKey.bank.basis, /; regular bills at their latest amount$/);
});

test('drill-down: categories add up to the dial and places to their category; unticking a regular place lowers the dial by exactly its amount', () => {
  const ds = household();
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const r = build(state);
  const card = r.dialsByKey.card;
  const cats = card.drill.rows.filter(x => x.level === 1);
  assert.equal(card.baselineCents, cats.reduce((s, c) => s + c.defaultCents, 0), 'dial baseline = Σ categories as they stand by default');
  assert.equal(card.baselineCents, cats.reduce((s, c) => s + c.planCents, 0));
  for (const c of cats) {
    const children = card.drill.rows.filter(x => x.parent === c.id);
    assert.equal(c.avgCents, children.reduce((s, k) => s + k.avgCents, 0), c.label + ' average');
    assert.equal(c.defaultCents, children.reduce((s, k) => s + k.defaultCents, 0), c.label + ' default');
  }
  assert.deepEqual(cats.map(c => c.label), ['Groceries', 'Dining & takeout', 'Subscriptions', 'Other'], 'the two tiny categories are grouped');
  assert.deepEqual(cats.find(c => c.label === 'Other').members.sort(), ['Gifts & donations', 'Hobbies']);
  const lumen = card.drill.rows.find(x => x.label === 'Lumen Streaming');
  assert.deepEqual([lumen.kind, lumen.level, lumen.regular, lumen.avgCents, lumen.months, lumen.txnCount], ['merchant', 2, true, 2599, 9, 9]);
  assert.deepEqual([lumen.stable, lumen.latestCents, lumen.latestDate, lumen.seenMonths, lumen.ofMonths, lumen.defaultCents], [true, 2599, '2026-06-08', 9, 9, 2599]);
  assert.match(lumen.id, /^card-m-[0-9a-z]+$/);
  // Places seen in most months get their own row (Pine Cafe: 6 of 9); the rest is one row.
  const kids = label => card.drill.rows.filter(x => x.parent === cats.find(c => c.label === label).id).map(x => [x.kind, x.label]);
  assert.deepEqual(kids('Dining & takeout'), [['merchant', 'Tidewater Diner'], ['merchant', 'Pine Cafe']]);
  assert.deepEqual(kids('Other'), [['rest', 'Everything in Other']]);
  // Rest rows carry the same fields; there is no single latest charge for many places.
  const otherRest = card.drill.rows.find(x => x.kind === 'rest' && x.category === 'Other');
  assert.deepEqual([otherRest.latestCents, otherRest.latestDate, otherRest.stable, otherRest.seenMonths, otherRest.ofMonths, otherRest.defaultCents], [null, null, false, 4, 9, otherRest.avgCents]);
  // Untick the streaming subscription.
  state = T.setRow(state, lumen.id, { included: false });
  assert.deepEqual(state.ui.plan.rows, { [lumen.id]: { included: false } });
  const r2 = build(state);
  const card2 = r2.dialsByKey.card;
  assert.equal(card2.source, 'rows');
  assert.equal(card2.baselineCents, card.baselineCents, 'the baseline itself is unchanged');
  assert.equal(card2.planCents, card.baselineCents - 2599);
  const included = card2.drill.rows.filter(x => x.level === 1 && x.included);
  assert.equal(card2.planCents, included.reduce((s, c) => s + c.planCents, 0), 'dial = Σ included categories');
  const subs = card2.drill.rows.find(x => x.label === 'Subscriptions');
  assert.equal(subs.planCents, card2.drill.rows.filter(x => x.parent === subs.id && x.included).reduce((s, k) => s + k.planCents, 0));
  assert.equal(r2.plan.out.card, card2.planCents);
  assert.equal(r2.months.find(m => m.month === '2026-08').out.card, card2.planCents, 'plan months use it');
  assert.equal(r2.months.find(m => m.month === '2026-05').out.card, r.months.find(m => m.month === '2026-05').out.card, 'history is unchanged');
  // An amount on a row, then ticking it back: only the amount remains.
  state = T.setRow(state, lumen.id, { cents: 999 });
  state = T.setRow(state, lumen.id, { included: true });
  assert.deepEqual(state.ui.plan.rows, { [lumen.id]: { cents: 999 } });
  assert.equal(build(state).dialsByKey.card.planCents, card.baselineCents - 2599 + 999);
  // Ids are stable from one build to the next.
  assert.deepEqual(build(state).dialsByKey.card.drill.rows.map(x => x.id), card.drill.rows.map(x => x.id));
});

test('a dial set directly wins over row changes and the baseline; clearing it falls back in that order', () => {
  const ds = household();
  let state = E.state.defaults(null, ds);
  const build = st => T.build({ txns: L.applyEdits(ds, st.ledgerEdits), dataset: ds, plan: Object.assign({}, st.plan, { people: PEOPLE }), settings: st.ui.plan, today: '2026-07-03' });
  const base = build(state).dialsByKey.card;
  const grocer = base.drill.rows.find(x => x.label === 'Harbor Grocer');
  state = T.setRow(state, grocer.id, { cents: 30000 });
  state = T.setDial(state, 'card', 123456);
  state = T.setDial(state, 'savings', -20001);
  let r = build(state);
  assert.deepEqual([r.dialsByKey.card.source, r.dialsByKey.card.planCents], ['direct', 123456]);
  assert.deepEqual([r.dialsByKey.savings.source, r.dialsByKey.savings.planCents], ['direct', -20001], 'negative: drawing savings down');
  assert.equal(r.plan.savings, -20001);
  assert.equal(r.plan.net, r.plan.in.total - r.plan.out.total + 20001);
  assert.equal(r.changed, true);
  state = T.setDial(state, 'card', null);
  r = build(state);
  assert.equal(r.dialsByKey.card.source, 'rows');
  assert.equal(r.dialsByKey.card.planCents, base.baselineCents - grocer.avgCents + 30000);
  state = T.resetDial(state, 'card');
  r = build(state);
  assert.deepEqual([r.dialsByKey.card.source, r.dialsByKey.card.planCents], ['baseline', base.baselineCents]);
  assert.deepEqual(state.ui.plan.rows, {});
  state = T.resetPlan(state);
  assert.deepEqual(state.ui.plan.dials, {});
  assert.equal(build(state).changed, false);
});

test('one-time items: left out of the dial by default, listed in full, and counted again by a planning-baseline edit', () => {
  const big = spend('card', '2026-04-18', 129900, 'Summit Appliance', 'Electronics');
  const ds = household({ extra: [big] });
  const r = run(ds, { today: '2026-07-03' });
  const item = r.baseline.oneTime.find(o => o.id === big.id);
  assert.deepEqual(item, { id: big.id, date: '2026-04-18', month: '2026-04', merchant: 'Summit Appliance', description: 'SUMMIT APPLIANCE 7731', accountLabel: 'Test card', role: 'card', dialKey: 'card', cents: 129900, auto: true });
  assert.equal(r.baseline.oneTimeCents, 129900);
  assert.ok(!r.dialsByKey.card.drill.rows.some(x => x.category === 'Electronics'), 'kept out of the rows too');
  assert.match(r.dialsByKey.card.basis, /1 one-time item left out/);
  const april = r.months.find(m => m.month === '2026-04');
  assert.deepEqual(april.oneOffs.map(o => o.id), [big.id]);
  assert.equal(april.oneOffCents, 129900);
  // "Count it": the household's edit wins.
  const include = { [big.id]: E.review.editRecord(null, 'planningBaseline', 'include', 'A planned replacement cycle') };
  const r2 = run(ds, { edits: include, today: '2026-07-03' });
  assert.ok(!r2.baseline.oneTime.some(o => o.id === big.id));
  assert.deepEqual(r2.baseline.keptIn.map(o => o.id), [big.id]);
  assert.equal(r2.dialsByKey.card.baselineCents, r.dialsByKey.card.baselineCents + E.money.divide(129900, 9));
  assert.equal(r2.months.find(m => m.month === '2026-04').out.card, april.out.card, 'actual months always count it');
  // Leaving out an ordinary purchase by hand.
  const grocery = ds.transactions.find(t => t.merchant === 'Harbor Grocer' && t.date === '2026-05-10');
  const exclude = Object.assign({}, include, { [grocery.id]: E.review.editRecord(null, 'planningBaseline', 'exclude', 'Party supplies') });
  const r3 = run(ds, { edits: exclude, today: '2026-07-03' });
  const manual = r3.baseline.oneTime.find(o => o.id === grocery.id);
  assert.equal(manual.auto, false);
  assert.equal(manual.cents, -grocery.amountCents);
  const groceries = rows => rows.find(x => x.level === 1 && x.label === 'Groceries').avgCents;
  assert.equal(groceries(r3.dialsByKey.card.drill.rows), E.money.divide(groceries(r2.dialsByKey.card.drill.rows) * 9 + grocery.amountCents, 9));
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
  const bank = r.dialsByKey.bank;
  const loan = bank.drill.rows.find(x => x.label === 'Larkspur Home Lending');
  assert.equal(loan.avgCents, E.money.divide(11 * 152340, 12), 'the average is 11/12 of the bill');
  assert.deepEqual([loan.stable, loan.latestCents, loan.latestDate, loan.seenMonths, loan.ofMonths], [true, 152340, '2026-06-01', 11, 12]);
  assert.deepEqual([loan.defaultCents, loan.planCents], [152340, 152340]);
  const power = bank.drill.rows.find(x => x.label === 'Brightwater Energy');
  assert.deepEqual([power.stable, power.latestCents, power.latestDate, power.seenMonths, power.ofMonths], [false, 9000, '2026-06-14', 12, 12]);
  assert.equal(power.planCents, power.avgCents);
  assert.equal(bank.baselineCents, 152340 + power.avgCents, 'the dial baseline follows the rows');
  assert.equal(bank.planCents, bank.baselineCents);
  assert.equal(bank.source, 'baseline');
  assert.match(bank.basis, /; regular bills at their latest amount$/);
  const grocer = r.dialsByKey.card.drill.rows.find(x => x.label === 'Harbor Grocer');
  assert.deepEqual([grocer.regular, grocer.stable, grocer.planCents], [true, false, 4 * 7250]);
  assert.doesNotMatch(r.dialsByKey.card.basis, /latest amount/);
  // A row amount the household set still wins over the latest charge.
  const changed = run(ds, { settings: { rows: { [loan.id]: { cents: 150000 } } }, today: '2026-07-03' });
  assert.equal(changed.dialsByKey.bank.drill.rows.find(x => x.id === loan.id).planCents, 150000);
  assert.equal(changed.dialsByKey.bank.planCents, 150000 + power.avgCents);
});

test('state: the earlier Home settings become ui.plan once, and the plan screen reads them', () => {
  const ds = household();
  const raw = JSON.parse(JSON.stringify(E.state.defaults(null, ds)));
  delete raw.ui.plan;
  raw.ui.home = { inCents: null, p1InCents: 410000, p2InCents: null, outCents: null, savedCents: -7525, cardCents: 88000, bankCents: null, baselineMonths: 3, fundingWho: 'both', chartView: 'money', horizon: 24 };
  const once = E.state.sanitize(raw, null, ds);
  const twice = E.state.sanitize(once.state, null, ds);
  assert.deepEqual(twice.state, once.state);
  assert.equal(once.state.ui.home, undefined);
  const r = T.build({ txns: L.applyEdits(ds, {}), dataset: ds, plan: Object.assign({}, once.state.plan, { people: PEOPLE }), settings: once.state.ui.plan, today: '2026-07-03' });
  assert.deepEqual(['p1', 'card', 'savings'].map(k => [r.dialsByKey[k].source, r.dialsByKey[k].planCents]), [['direct', 410000], ['direct', 88000], ['direct', -7525]]);
  assert.equal(r.baseline.count, 3);
  assert.equal(r.horizon, 24);
});

test('build needs today and the data set; settings fall back to the defaults', () => {
  const ds = small();
  assert.throws(() => T.build({ dataset: ds, plan: planWith() }), err => err instanceof E.ValidationError && err.field === 'today');
  assert.throws(() => T.build({ today: '2026-06-12' }), err => err instanceof E.ValidationError && err.field === 'dataset');
  assert.deepEqual(T.settings({ horizon: 36, baselineMonths: 'all', dials: { card: 1.5, bank: -4 }, rows: { a: { included: false, x: 1 }, b: {} } }),
    { baselineMonths: 'all', horizon: 12, past: 12, mode: 'balance', coverFromSavings: true, dials: { bank: -4 }, rows: { a: { included: false } }, hidden: null });
  assert.equal(T.settings(undefined).hidden, null, 'never chosen');
  assert.deepEqual(T.settings({ hidden: [] }).hidden, [], 'an empty choice stays a choice');
});
