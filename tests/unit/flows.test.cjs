'use strict';
// Tests for BudgetEngine.flows: spending by role and by how it was paid, money into joint by
// person, savings in and out, the baseline (one-time, yearly, regular) and Home's plan.
// Every household, merchant, date and amount here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const L = E.ledger;
const F = E.flows;

let seq = 0;
function row(accountId, date, amountCents, fields = {}) {
  seq += 1;
  return Object.assign({ id: 'f' + String(seq).padStart(5, '0'), accountId, date, description: 'TEST ROW ' + seq, amountCents, kind: 'spend', category: 'Groceries' }, fields);
}
const buy = (acct, date, cents, merchant, extra = {}) => row(acct, date, -cents, Object.assign({ merchant, description: merchant.toUpperCase() + ' 0042' }, extra));
const refund = (acct, date, cents, merchant) => row(acct, date, cents, { merchant, description: merchant.toUpperCase() + ' CREDIT', flags: ['refund'] });
const pay = (date, cents, extra = {}) => row('chk', date, cents, Object.assign({ kind: 'income', subtype: 'payroll', category: 'Income', description: 'NORTHWIND LTD PAYROLL' }, extra));
const fromPartner = (date, cents, extra = {}) => row('chk', date, cents, Object.assign({ kind: 'transfer', subtype: 'contribution', category: 'Transfer', description: 'ONLINE XFER FROM 7781' }, extra));
const cardPayment = (date, cents) => {
  const out = row('chk', date, -cents, { kind: 'card_payment', category: 'Card payment', description: 'TEST CARD AUTOPAY' });
  const inn = row('card', date, cents, { kind: 'card_payment', category: 'Card payment', description: 'PAYMENT THANK YOU', pairId: out.id });
  out.pairId = inn.id;
  return [out, inn];
};
const toSavings = (date, cents) => {
  const out = row('chk', date, -cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', description: 'XFER TO SAV' });
  const inn = row('sav', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', description: 'XFER FROM CHK', pairId: out.id });
  out.pairId = inn.id;
  return [out, inn];
};

const FULL = [{ start: '2026-01-01', end: '2026-03-31' }];
function build(txns, { months = FULL } = {}) {
  return L.normalizeDataset({
    schemaVersion: 2, datasetId: 'flows-test', isSynthetic: true,
    accounts: [
      { id: 'chk', label: 'Test checking', type: 'checking', scope: 'joint', coverage: months },
      { id: 'sav', label: 'Test savings', type: 'savings', scope: 'joint', coverage: months },
      { id: 'card', label: 'Test card', type: 'credit_card', scope: 'joint', coverage: months, paidInFull: true },
    ],
    transactions: txns,
  });
}
const PLAN = {
  people: [{ id: 'p1', name: 'Rowan' }, { id: 'p2', name: 'Quinn' }],
  incomes: [
    { id: 'p1-pay', label: 'Rowan pay', personId: 'p1', kind: 'paycheck', grossPerPaycheckCents: 455500, netPerPaycheckCents: 310000, jointPerPaycheckCents: 260000, frequency: 'semimonthly', frequencyStatus: 'confirmed', semimonthlyDays: [15, 31], status: 'confirmed', startMonth: null, endMonth: null },
    { id: 'p2-transfer', label: 'Quinn transfer', personId: 'p2', kind: 'contribution', netPerPaycheckCents: null, jointPerPaycheckCents: 175000, frequency: 'unknown', frequencyStatus: 'unknown', assumedPerMonthIfUnknown: 2, status: 'observed', startMonth: null, endMonth: null },
  ],
  bills: [], targets: [], goals: [], debts: [], personalSpending: [], settings: { incomeTiming: 'conservative' },
};
function run(txns, { edits = {}, plan = PLAN, count = 12 } = {}) {
  const ds = build(txns);
  const eff = L.applyEdits(ds, edits);
  const rows = F.breakdown(eff, ds, { plan });
  return { ds, eff, rows, base: F.baseline(rows, { count }), month: m => rows.find(r => r.month === m) };
}

test('a card purchase and the checking payment that settles it count as one expense', () => {
  const r = run([buy('card', '2026-01-05', 12000, 'Corner Grocer'), ...cardPayment('2026-01-20', 12000)]);
  const jan = r.month('2026-01').actual;
  assert.equal(jan.cardPurchases, 12000);
  assert.equal(jan.cardNet, 12000);
  assert.equal(jan.bankNet, 0, 'the payment from checking is not bank-paid spending');
  assert.equal(jan.consumption, 12000, 'counted once');
  assert.equal(jan.cardRepayments, 12000, 'reported apart');
});

test('a refund reduces card spending once, also when it posts in a later month', () => {
  const r = run([buy('card', '2026-01-10', 30000, 'Gear Barn'), refund('card', '2026-02-03', 30000, 'Gear Barn'), buy('card', '2026-02-12', 5000, 'Corner Grocer')]);
  assert.equal(r.month('2026-01').actual.cardNet, 30000);
  const feb = r.month('2026-02').actual;
  assert.equal(feb.cardRefunds, 30000);
  assert.equal(feb.cardNet, 5000 - 30000, 'a refund-heavy month stays negative in the actual figures');
  assert.equal(r.base.total.actual.cardNet, 5000, 'over the months: once');
});

test('a refund-heavy baseline keeps its sign in history; planned card spending starts at $0 and says why', () => {
  const r = run([buy('card', '2026-01-10', 1000, 'Corner Grocer'), refund('card', '2026-01-11', 9000, 'Gear Barn')]);
  assert.equal(r.base.avg.actual.cardNet, E.money.divide(-8000, 3));
  const sc = F.scenario({ base: r.base, funding: F.planFunding(PLAN, { month: '2026-04' }), home: {}, people: ['p1', 'p2'] });
  assert.equal(sc.lines.card.baseline, 0);
  assert.equal(sc.lines.card.signedBaseline, E.money.divide(-8000, 3), 'the signed figure is kept for the explanation');
});

test('bank-paid and card spending with the same category stay apart, by how they were paid', () => {
  const r = run([buy('card', '2026-01-08', 4500, 'Pharma Plus', { category: 'Medical' }), buy('chk', '2026-01-09', 21000, 'Valley Clinic', { category: 'Medical' })]);
  const jan = r.month('2026-01').actual;
  assert.equal(jan.cardNet, 4500);
  assert.equal(jan.bankNet, 21000);
  assert.equal(jan.consumption, 25500);
});

test('transfers between own accounts are not pay or spending; debt payments and investments are separate and counted once', () => {
  const r = run([
    row('chk', '2026-01-02', 50000, { kind: 'transfer', subtype: 'internal', category: 'Transfer', description: 'XFER FROM OTHER CHK' }),
    row('chk', '2026-01-03', -50000, { kind: 'transfer', subtype: 'internal', category: 'Transfer', description: 'XFER TO OTHER CHK' }),
    row('chk', '2026-01-14', -4500, { kind: 'debt_payment', subtype: 'store_card', category: 'Debt payment', description: 'STORE CARD PMT' }),
    row('chk', '2026-01-20', -8800, { kind: 'transfer', subtype: 'investment', category: 'Transfer', description: 'BROKERAGE DEPOSIT' }),
  ]);
  const jan = r.month('2026-01').actual;
  assert.equal(jan.moneyIn, 0);
  assert.equal(jan.consumption, 0);
  assert.equal(jan.debt, 4500);
  assert.equal(jan.investNet, 8800);
  assert.equal(jan.savingsNet, 0, 'investments are not cash savings');
  assert.equal(jan.left, -13300);
});

test('savings: gross in, gross out, net, interest and investments are kept apart and add up to the cent', () => {
  const r = run([
    ...toSavings('2026-01-05', 65000),
    row('chk', '2026-01-20', 117300, { kind: 'transfer', subtype: 'savings', category: 'Transfer', description: 'XFER FROM SAV' }),
    row('sav', '2026-01-31', 61, { kind: 'income', subtype: 'interest', category: 'Income', description: 'INTEREST PAID' }),
    row('chk', '2026-01-21', -2500, { kind: 'transfer', subtype: 'investment', category: 'Transfer', description: 'BROKERAGE DEPOSIT' }),
  ]);
  const jan = r.month('2026-01').actual;
  assert.equal(jan.savingsIn, 65000);
  assert.equal(jan.savingsOut, 117300);
  assert.equal(jan.savingsNet, 65000 - 117300, 'a drawdown, not "saved"');
  assert.equal(jan.interest, 61);
  assert.equal(jan.investNet, 2500);
  // The old single figure mixed both: net savings + investments.
  const flows = E.balances.monthlyFlows(r.eff, r.ds, {});
  assert.equal(flows.find(f => f.month === '2026-01').savedCents, jan.savingsNet + jan.investNet);
});

test('everything reconciles with the month-by-month flows, to the cent', () => {
  const txns = [
    pay('2026-01-15', 260000), pay('2026-01-30', 260000), fromPartner('2026-01-10', 175000), fromPartner('2026-01-25', 175000),
    buy('card', '2026-01-04', 23456, 'Corner Grocer'), refund('card', '2026-01-09', 1234, 'Corner Grocer'), ...cardPayment('2026-01-28', 22222),
    buy('chk', '2026-01-01', 131277, 'Hillside Mortgage', { category: 'Mortgage' }), ...toSavings('2026-01-16', 40000),
    row('chk', '2026-01-22', 99999, { kind: 'income', subtype: 'other', category: 'Income', description: 'PEER PAYMENT RECEIVED' }),
  ];
  const r = run(txns);
  const a = r.month('2026-01').actual;
  const f = E.balances.monthlyFlows(r.eff, r.ds, { attribute: E.balances.incomeAttribution(PLAN) }).find(x => x.month === '2026-01');
  assert.equal(a.moneyIn, f.inCents);
  assert.equal(a.consumption + a.debt + a.business, f.outCents);
  assert.equal(a.left, f.leftCents);
  assert.equal(a.p1, f.bySource.p1);
  assert.equal(a.p2, f.bySource.p2);
  assert.equal(a.unassigned + a.interest, f.bySource.other);
  assert.equal(a.cardNet, 23456 - 1234);
  assert.equal(a.bankNet, 131277);
});

test('money into joint by person: provisional matches are marked, can be corrected, and unassigned money stays unassigned', () => {
  const txns = [pay('2026-01-15', 260000), fromPartner('2026-01-10', 175000), row('chk', '2026-01-12', 175000, { kind: 'income', subtype: 'other', category: 'Income', description: 'WEB XFER IN 0099' }), row('chk', '2026-01-22', 27125, { kind: 'income', subtype: 'other', category: 'Income', description: 'UNEXPLAINED DEPOSIT' })];
  const r = run(txns);
  const jan = r.month('2026-01').actual;
  assert.equal(jan.p1, 260000);
  assert.equal(jan.p1Provisional, 260000, 'matched by the pay in Budget, not confirmed');
  assert.equal(jan.p2, 350000, 'the partner transfer and the same-amount deposit');
  assert.equal(jan.p2Provisional, 350000);
  assert.equal(jan.unassigned, 27125, 'an unexplained credit is not anyone’s pay');
  const credit = r.month('2026-01').credits.find(c => c.cents === 27125);
  assert.equal(credit.who, null);
  // Corrections: the deposit matched by amount is not Quinn's; the payroll is confirmed as Rowan's.
  const amountMatched = r.month('2026-01').credits.find(c => c.description === 'WEB XFER IN 0099');
  assert.equal(amountMatched.basis, 'amount');
  const payroll = r.month('2026-01').credits.find(c => c.description === 'NORTHWIND LTD PAYROLL');
  const edits = { [amountMatched.id]: { person: 'none' }, [payroll.id]: { person: 'p1' } };
  const fixed = run(txns, { edits }).rows.find(x => x.month === '2026-01');
  assert.equal(fixed.actual.p2, 175000);
  assert.equal(fixed.actual.unassigned, 27125 + 175000);
  assert.equal(fixed.actual.p1Provisional, 0, 'confirmed');
  assert.equal(fixed.actual.moneyIn, jan.moneyIn, 'money in itself never changes');
  assert.equal(L.applyEdits(build(txns), edits).find(t => t.id === amountMatched.id).description, 'WEB XFER IN 0099', 'the original description is kept');
});

test('plan funding: semimonthly pay is 2 paychecks a month; take-home minus what is kept equals the joint part', () => {
  const pf = F.planFunding(PLAN, { month: '2026-04' });
  const rowan = pf.people.p1.streams[0];
  assert.equal(rowan.count, 2);
  assert.deepEqual(rowan.perPaycheck, { gross: 455500, net: 310000, joint: 260000, kept: 50000 });
  assert.deepEqual(rowan.monthly, { gross: 911000, net: 620000, kept: 100000, joint: 520000 });
  assert.equal(rowan.monthly.net - rowan.monthly.kept, rowan.monthly.joint);
  assert.equal(pf.people.p1.jointCents, 520000);
  assert.equal(pf.people.p2.jointCents, 350000, 'two transfers a month while the schedule is not confirmed');
  // The same with the yearly-average setting: semimonthly is still 24 a year.
  assert.equal(F.planFunding(PLAN, { month: '2026-04', timing: 'average' }).people.p1.jointCents, 520000);
});

test('plan funding: biweekly pay uses its own cadence and leaves semimonthly alone', () => {
  const plan = JSON.parse(JSON.stringify(PLAN));
  plan.incomes.push({ id: 'p2-pay', label: 'Quinn pay', personId: 'p2', kind: 'paycheck', netPerPaycheckCents: 200000, jointPerPaycheckCents: 120000, frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2026-01-09', status: 'confirmed', startMonth: null, endMonth: null });
  const typical = F.planFunding(plan, { month: '2026-04' });
  const avg = F.planFunding(plan, { month: '2026-04', timing: 'average' });
  const q = p => p.people.p2.streams.find(s => s.id === 'p2-pay');
  assert.equal(q(typical).monthly.joint, 240000, 'a typical month: 2 paychecks');
  assert.equal(q(avg).monthly.joint, 260000, 'yearly average: 26 ÷ 12 paychecks');
  assert.equal(typical.people.p1.jointCents, 520000);
  assert.equal(avg.people.p1.jointCents, 520000, 'semimonthly unchanged');
});

test('the household plan counts joint contributions only: what is kept personally is not taken off again', () => {
  const r = run([buy('chk', '2026-01-02', 100000, 'Hillside Mortgage', { category: 'Mortgage' }), buy('chk', '2026-02-02', 100000, 'Hillside Mortgage', { category: 'Mortgage' }), buy('chk', '2026-03-02', 100000, 'Hillside Mortgage', { category: 'Mortgage' })]);
  const sc = F.scenario({ base: r.base, funding: F.planFunding(PLAN, { month: '2026-04' }), home: {}, people: ['p1', 'p2'] });
  assert.equal(sc.lines.funding.value, 520000 + 350000, 'joint parts, not gross or full take-home');
  assert.equal(sc.lines.bank.value, 100000);
  assert.equal(sc.remainder, 870000 - 100000, 'the 1,000.00 kept personally each month is not subtracted');
});

test('editing the plan never changes past months; a pay stub never creates a deposit', () => {
  const txns = [pay('2026-01-15', 260000), pay('2026-02-15', 260000)];
  const before = run(txns).rows.map(r => r.actual && r.actual.p1);
  const plan = JSON.parse(JSON.stringify(PLAN));
  plan.incomes[0].netPerPaycheckCents = 350000;
  plan.incomes[0].jointPerPaycheckCents = 300000;
  plan.incomes[0].grossPerPaycheckCents = 500000;
  const after = run(txns, { plan });
  assert.deepEqual(after.rows.map(r => r.actual && r.actual.p1), before);
  assert.equal(after.eff.length, txns.length, 'no row is created from the plan');
  assert.equal(F.planFunding(plan, { month: '2026-04' }).people.p1.jointCents, 600000);
});

test('Home plan: one card amount, separate from bank-paid bills; a drawdown raises the remainder; $0 is an amount', () => {
  const txns = [];
  for (const m of ['01', '02', '03']) {
    txns.push(buy('card', `2026-${m}-05`, 200000, 'Corner Grocer'), buy('chk', `2026-${m}-01`, 137500, 'Hillside Mortgage', { category: 'Mortgage' }), ...cardPayment(`2026-${m}-25`, 200000));
  }
  const r = run(txns);
  const funding = F.planFunding(PLAN, { month: '2026-04' });
  const sc = home => F.scenario({ base: r.base, funding, home, people: ['p1', 'p2'] });
  const base = sc({});
  assert.equal(base.lines.card.value, 200000, 'card repayments are not added on top');
  assert.equal(base.lines.bank.value, 137500);
  const moreCards = sc({ cardCents: 260000 });
  assert.equal(moreCards.lines.bank.value, 137500, 'bank-paid bills do not move with card spending');
  assert.equal(moreCards.remainder, base.remainder - 60000, 'exactly the difference, once');
  const drawdown = sc({ savedCents: -123648 });
  assert.equal(drawdown.remainder, base.remainder - base.lines.savings.value + 123648);
  const zero = sc({ savedCents: 0, bankCents: 0 });
  assert.equal(zero.lines.savings.value, 0);
  assert.equal(zero.lines.savings.changed, true, 'zero is the household’s setting, not the baseline');
  assert.equal(zero.lines.bank.value, 0);
  const people = sc({ p2InCents: 0 });
  assert.equal(people.lines.funding.value, 520000);
});

test('baseline: a big purchase at a place that is not regular is one-time (left out of the plan, kept in history) unless counted as regular', () => {
  const txns = [];
  for (const m of ['01', '02', '03']) txns.push(buy('card', `2026-${m}-03`, 60000, 'Corner Grocer'), buy('chk', `2026-${m}-01`, 137500, 'Hillside Mortgage', { category: 'Mortgage' }));
  const dentist = buy('card', '2026-02-18', 193045, 'Molar Bay Dental', { category: 'Dental' });
  txns.push(dentist);
  const r = run(txns);
  assert.deepEqual(r.base.oneTime.map(o => [o.id, o.role, o.auto]), [[dentist.id, 'card', true]]);
  assert.equal(r.base.total.actual.cardNet, 3 * 60000 + 193045, 'still spending in the actual months');
  assert.equal(r.base.total.planning.cardNet, 3 * 60000, 'left out of the plan');
  assert.equal(r.base.total.planning.bankNet, 3 * 137500, 'only from the card side: the scope it was paid from');
  assert.equal(r.base.kinds.card.oneTime, 193045);
  assert.equal(r.base.kinds.card.regular, 180000, 'the same place every month');
  assert.equal(r.base.kinds.bank.regular, 3 * 137500, 'the mortgage repeats, so it is never a one-time cost');
  // The household says it is regular: back in the plan.
  const kept = run(txns, { edits: { [dentist.id]: { planningBaseline: 'include' } } });
  assert.equal(kept.base.oneTime.length, 0);
  assert.equal(kept.base.keptRegular.length, 1);
  assert.equal(kept.base.total.planning.cardNet, 3 * 60000 + 193045);
  // Or left out by hand (any size): the same.
  const small = buy('chk', '2026-03-20', 12000, 'Town Fair');
  const chosen = run(txns.concat([small]), { edits: { [small.id]: { planningBaseline: 'exclude' } } });
  assert.ok(chosen.base.oneTime.some(o => o.id === small.id && o.auto === false && o.role === 'bank'));
  assert.equal(chosen.base.total.planning.bankNet, 3 * 137500);
});

test('baseline: one-time means "not a regular place", not "only once": two big charges in one month are both one-time; a big charge at a regular place is not', () => {
  const months = [{ start: '2026-01-01', end: '2026-06-30' }];
  const txns = [];
  for (const m of ['01', '02', '03', '04', '05', '06']) txns.push(buy('card', `2026-${m}-04`, 61250 + Number(m) * 75, 'Corner Grocer'));
  // The same practice twice in one month (an earlier rule kept these because they look alike).
  const first = buy('card', '2026-04-07', 123200, 'Molar Bay Dental', { category: 'Dental' });
  const second = buy('card', '2026-04-21', 103100, 'Molar Bay Dental', { category: 'Dental' });
  // A big week at the regular grocer is still groceries.
  const bigShop = buy('card', '2026-05-28', 88015, 'Corner Grocer');
  // Seen in 2 of 6 months, below the 60% needed to be regular: both big charges are one-time.
  const shopA = buy('chk', '2026-02-12', 70500, 'Lakeside Furniture', { category: 'Household & hardware' });
  const shopB = buy('chk', '2026-05-15', 52080, 'Lakeside Furniture', { category: 'Household & hardware' });
  const ds = build(txns.concat([first, second, bigShop, shopA, shopB]), { months });
  const rows = F.breakdown(L.applyEdits(ds, {}), ds, { plan: PLAN });
  const b = F.baseline(rows, { count: 6 });
  assert.equal(b.regularAt, 4);
  assert.deepEqual(b.oneTime.map(o => o.id).sort(), [first.id, second.id, shopA.id, shopB.id].sort());
  assert.ok(b.oneTime.every(o => o.auto));
  assert.equal(b.spends.find(x => x.id === bigShop.id).kind, 'regular');
  assert.equal(b.total.planning.cardNet, txns.reduce((s, t) => s - t.amountCents, 0) + 88015);
  assert.equal(b.total.planning.bankNet, 0);
  // "Count it" on one of them still wins.
  const kept = F.baseline(F.breakdown(L.applyEdits(ds, { [second.id]: { planningBaseline: 'include' } }), ds, { plan: PLAN }), { count: 6 });
  assert.deepEqual(kept.keptRegular.map(o => o.id), [second.id]);
  assert.ok(!kept.oneTime.some(o => o.id === second.id));
});

test('baseline: a yearly bill is spread as 1/12 a month, not counted as a one-time cost', () => {
  const months = [{ start: '2025-01-01', end: '2026-03-31' }];
  const txns = [buy('chk', '2025-02-10', 120000, 'Harbor Insurance'), buy('chk', '2026-02-11', 126000, 'Harbor Insurance')];
  const ds = build(txns, { months });
  const rows = F.breakdown(L.applyEdits(ds, {}), ds, { plan: PLAN });
  const b3 = F.baseline(rows, { count: 3 });
  assert.equal(b3.oneTime.length, 0);
  assert.equal(b3.yearly.length, 1);
  assert.equal(b3.yearly[0].spreadCents, Math.round(126000 * 3 / 12));
  assert.equal(b3.total.planning.bankNet, 31500, 'a quarter of a year of it');
  assert.equal(b3.avg.planning.bankNet, 10500, '1/12 a month');
  assert.equal(b3.total.actual.bankNet, 126000, 'history unchanged');
});
