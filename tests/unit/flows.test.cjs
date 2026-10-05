'use strict';
// Tests for BudgetEngine.flows: spending by role and by how it was paid, money into joint by
// person, savings in and out, the baseline (one-time, yearly, regular) and plan funding.
// Every household, merchant, date and amount here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, rowMaker, pair, dataset, jointAccounts, plan: makePlan, paycheck, contribution, monthlyFlows } = require('../helpers/ledger.cjs');

const L = E.ledger;
const F = E.flows;

const row = rowMaker({ prefix: 'f', description: n => 'TEST ROW ' + n });
const buy = (acct, date, cents, merchant, extra = {}) => row(acct, date, -cents, Object.assign({ merchant, description: merchant.toUpperCase() + ' 0042' }, extra));
const refund = (acct, date, cents, merchant) => row(acct, date, cents, { merchant, description: merchant.toUpperCase() + ' CREDIT', flags: ['refund'] });
const pay = (date, cents, extra = {}) => row('chk', date, cents, Object.assign({ kind: 'income', subtype: 'payroll', category: 'Income', description: 'NORTHWIND LTD PAYROLL' }, extra));
const fromPartner = (date, cents, extra = {}) => row('chk', date, cents, Object.assign({ kind: 'transfer', subtype: 'contribution', category: 'Transfer', description: 'ONLINE XFER FROM 7781' }, extra));
const cardPayment = (date, cents) => pair(
  row('chk', date, -cents, { kind: 'card_payment', category: 'Card payment', description: 'TEST CARD AUTOPAY' }),
  row('card', date, cents, { kind: 'card_payment', category: 'Card payment', description: 'PAYMENT THANK YOU' }));
const toSavings = (date, cents) => pair(
  row('chk', date, -cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', description: 'XFER TO SAV' }),
  row('sav', date, cents, { kind: 'transfer', subtype: 'savings', category: 'Transfer', description: 'XFER FROM CHK' }));

const FULL = [{ start: '2026-01-01', end: '2026-03-31' }];
const build = (txns, { months = FULL } = {}) => dataset({ datasetId: 'flows-test', accounts: jointAccounts({ coverage: months, cardExtra: { paidInFull: true } }), transactions: txns });
const PLAN = makePlan({
  people: [{ id: 'p1', name: 'Rowan' }, { id: 'p2', name: 'Quinn' }],
  incomes: [
    paycheck({ id: 'p1-pay', label: 'Rowan pay', personId: 'p1', grossPerPaycheckCents: 455500, netPerPaycheckCents: 310000, jointPerPaycheckCents: 260000 }),
    contribution({ id: 'p2-transfer', label: 'Quinn transfer', personId: 'p2', jointPerPaycheckCents: 175000 }),
  ],
});
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

test('a refund-heavy baseline keeps its sign in history', () => {
  const r = run([buy('card', '2026-01-10', 1000, 'Corner Grocer'), refund('card', '2026-01-11', 9000, 'Gear Barn')]);
  assert.equal(r.base.avg.actual.cardNet, E.money.divide(-8000, 3));
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
  // The ledger's single figure mixes both: net savings + investments.
  const flows = monthlyFlows(r.eff, r.ds, {});
  assert.equal(flows.find(f => f.month === '2026-01').savedCents, jan.savingsNet + jan.investNet);
});

test('everything reconciles with the ledger’s month-by-month totals, to the cent', () => {
  const txns = [
    pay('2026-01-15', 260000), pay('2026-01-30', 260000), fromPartner('2026-01-10', 175000), fromPartner('2026-01-25', 175000),
    buy('card', '2026-01-04', 23456, 'Corner Grocer'), refund('card', '2026-01-09', 1234, 'Corner Grocer'), ...cardPayment('2026-01-28', 22222),
    buy('chk', '2026-01-01', 131277, 'Hillside Mortgage', { category: 'Mortgage' }), ...toSavings('2026-01-16', 40000),
    row('chk', '2026-01-22', 99999, { kind: 'income', subtype: 'other', category: 'Income', description: 'PEER PAYMENT RECEIVED' }),
  ];
  const r = run(txns);
  const a = r.month('2026-01').actual;
  const f = monthlyFlows(r.eff, r.ds, { attribute: E.balances.incomeAttribution(PLAN) }).find(x => x.month === '2026-01');
  assert.equal(a.moneyIn, f.inCents);
  assert.equal(a.consumption + a.debt + a.business, f.outCents);
  assert.equal(a.left, f.leftCents);
  assert.equal(a.p1, f.bySource.p1);
  assert.equal(a.p2, f.bySource.p2);
  assert.equal(a.unassigned + a.interest, f.bySource.other);
  assert.equal(a.cardNet, 23456 - 1234);
  assert.equal(a.bankNet, 131277);
});

test('month by month: full months only; a purchase marked as a business cost still left the account', () => {
  const biz = buy('chk', '2026-02-11', 30000, 'Tool Depot', { category: 'Household & hardware' });
  const txns = [pay('2026-01-05', 300000), buy('chk', '2026-01-10', 100000, 'Corner Grocer'), ...toSavings('2026-01-20', 25000),
    pay('2026-02-05', 300000), biz, row('chk', '2026-02-20', -60000, { kind: 'debt_payment', subtype: 'loan', category: 'Debt', description: 'AUTO LOAN PMT' })];
  const edits = { [biz.id]: { business: 'business', reason: 'work tools', history: [] } };
  const partial = build(txns, { months: [{ start: '2026-01-01', end: '2026-02-14' }] });
  const rows = F.breakdown(L.applyEdits(partial, edits), partial, { months: ['2026-01', '2026-02'], plan: PLAN });
  const jan = rows[0].actual;
  assert.deepEqual([jan.moneyIn, jan.consumption + jan.debt + jan.business, jan.savingsNet + jan.investNet, jan.left, jan.business], [300000, 100000, 25000, 175000, 0]);
  assert.equal(rows[1].coverage, 'partial', 'the exports end mid-February');
  assert.equal(rows[1].actual, null, 'a partial month is unknown, not small');
  const full = build(txns, { months: [{ start: '2026-01-01', end: '2026-02-28' }] });
  const eff = L.applyEdits(full, edits);
  const feb = F.breakdown(eff, full, { months: ['2026-02'], plan: PLAN })[0].actual;
  assert.equal(feb.debt + feb.business, 90000, 'debt payment + business purchase');
  assert.equal(feb.business, 30000);
  assert.equal(feb.consumption, 0, 'a business cost is not household spending');
  const f = monthlyFlows(eff, full, { months: ['2026-02'] })[0];
  assert.deepEqual([f.outCents, f.businessCents, f.leftCents], [feb.consumption + feb.debt + feb.business, feb.business, feb.left], 'agrees with the ledger’s totals');
});

test('month by month: a one-off left out of the plan still counts in the actual figures, not the planning ones', () => {
  const big = buy('chk', '2026-01-15', 200000, 'Molar Bay Dental', { category: 'Dental' });
  const ds = build([pay('2026-01-05', 300000), big]);
  const eff = L.applyEdits(ds, { [big.id]: { planningBaseline: 'exclude', reason: 'one-off', history: [] } });
  const jan = F.breakdown(eff, ds, { months: ['2026-01'], plan: PLAN })[0];
  assert.equal(jan.actual.consumption, 200000);
  assert.equal(jan.planning.consumption, 0);
  assert.equal(monthlyFlows(eff, ds, { months: ['2026-01'] })[0].outCents, jan.actual.consumption);
  assert.equal(monthlyFlows(eff, ds, { months: ['2026-01'], planning: true })[0].outCents, jan.planning.consumption);
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
