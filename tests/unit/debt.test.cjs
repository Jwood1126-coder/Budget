'use strict';
// Tests for BudgetEngine.debt: lower bounds, illustrative amortization, rate ranges, promotional
// financing checks and labelled summaries. All debts and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const D = E.debt;

// ------------------------------------------------------------------ paymentsLowerBound

test('paymentsLowerBound: ceil(balance / payment), labelled as a 0% floor', () => {
  const r = D.paymentsLowerBound(100000, 30000);
  assert.equal(r.months, 4);
  assert.equal(r.isLowerBound, true);
  assert.match(r.note, /floor/);
  assert.match(r.note, /0% interest/);
});

test('paymentsLowerBound: exact multiple does not round up', () => {
  assert.equal(D.paymentsLowerBound(90000, 30000).months, 3);
  assert.equal(D.paymentsLowerBound(1, 30000).months, 1);
});

test('paymentsLowerBound: unknown balance or payment gives null, never a guess', () => {
  assert.equal(D.paymentsLowerBound(null, 30000).months, null);
  assert.equal(D.paymentsLowerBound(100000, null).months, null);
  assert.equal(D.paymentsLowerBound(100000, 0).months, null);
  assert.match(D.paymentsLowerBound(null, 30000).note, /Balance not entered/);
});

test('paymentsLowerBound: zero balance needs zero payments; bad input throws', () => {
  assert.equal(D.paymentsLowerBound(0, 30000).months, 0);
  assert.throws(() => D.paymentsLowerBound(100.5, 30000), E.ValidationError);
});

test('paymentsLowerBound: a known $0 payment never pays the balance down (it is not "not entered")', () => {
  const r = D.paymentsLowerBound(100000, 0);
  assert.equal(r.months, null);
  assert.doesNotMatch(r.note, /not entered/);
  assert.match(r.note, /\$0\.00 payment/);
});

test('negative payments are rejected instead of producing a verdict', () => {
  assert.throws(() => D.paymentsLowerBound(100000, -100), E.ValidationError);
  assert.throws(() => D.amortize({ balanceCents: 100000, aprPct: 5, paymentCents: -100 }), E.ValidationError);
  assert.throws(() => D.promoCheck({ promoBalanceCents: 100000, expiresMonth: '2027-04', paymentCents: -500, fromMonth: '2026-10' }), E.ValidationError);
  // summary(): a bill with a negative amount is treated as having no payment, never judged.
  const s = D.summary({ id: 'card', label: 'Store card', balanceCents: 100000, promo: { balanceCents: 100000, expiresMonth: '2027-04', deferredInterest: false } },
    { id: 'card-pay', monthlyCents: -500, fundedFrom: 'joint' }, { month: '2026-10' });
  assert.equal(s.promo.status, 'needs_info');
  assert.equal(s.lines.find(l => l.key === 'payment').status, 'unknown');
});

// ------------------------------------------------------------------ amortize

test('amortize: small example verified by hand', () => {
  // $1,000 at 12% APR (1% a month), $500 payments:
  //   month 1: interest $10.00, balance 1000 + 10 − 500 = $510.00
  //   month 2: interest  $5.10, balance  510 + 5.10 − 500 = $15.10
  //   month 3: interest  $0.15 (0.151 rounded), final payment $15.25
  const r = D.amortize({ balanceCents: 100000, aprPct: 12, paymentCents: 50000 });
  assert.equal(r.months, 3);
  assert.equal(r.interestCents, 1000 + 510 + 15);
  assert.equal(r.finalPaymentCents, 1525);
  assert.equal(r.totalPaidCents, 100000 + 1525);
  assert.equal(r.neverPaysOff, false);
  assert.equal(r.illustrative, true);
  assert.match(r.note, /Illustration only, at an assumed 12% APR/);
  assert.match(r.note, /Not a payoff date/);
});

test('amortize: 0% APR matches the lower bound with no interest', () => {
  const r = D.amortize({ balanceCents: 100000, aprPct: 0, paymentCents: 30000 });
  assert.equal(r.months, D.paymentsLowerBound(100000, 30000).months);
  assert.equal(r.interestCents, 0);
  assert.equal(r.finalPaymentCents, 10000);
});

test('amortize: with interest it never takes fewer months than the 0% floor', () => {
  const floor = D.paymentsLowerBound(500000, 20000).months;
  const r = D.amortize({ balanceCents: 500000, aprPct: 9.5, paymentCents: 20000 });
  assert.ok(r.months >= floor);
  assert.ok(r.interestCents > 0);
});

test('amortize: payment equal to or below the monthly interest never pays off', () => {
  // $10,000 at 24% APR accrues $200.00 interest a month.
  for (const payment of [20000, 19999, 5000]) {
    const r = D.amortize({ balanceCents: 1000000, aprPct: 24, paymentCents: payment });
    assert.equal(r.months, null, String(payment));
    assert.equal(r.neverPaysOff, true);
    assert.match(r.note, /never be paid off/);
  }
  assert.equal(D.amortize({ balanceCents: 1000000, aprPct: 24, paymentCents: 20001 }).neverPaysOff, false);
});

test('amortize: requires an explicit rate — unknown rate gives no estimate', () => {
  const r = D.amortize({ balanceCents: 100000, aprPct: null, paymentCents: 5000 });
  assert.equal(r.months, null);
  assert.equal(r.interestCents, null);
  assert.equal(r.neverPaysOff, false);
  assert.ok(r.missing.some(m => /interest rate/.test(m)));
  assert.match(r.note, /not available/);
});

test('amortize: missing balance or payment is reported', () => {
  assert.ok(D.amortize({ balanceCents: null, aprPct: 5, paymentCents: 5000 }).missing.includes('balance'));
  assert.ok(D.amortize({ balanceCents: 1000, aprPct: 5, paymentCents: null }).missing.includes('monthly payment'));
});

test('amortize: stops at maxMonths without claiming it never pays off', () => {
  const r = D.amortize({ balanceCents: 10000000, aprPct: 6, paymentCents: 60000, maxMonths: 12 });
  assert.equal(r.months, null);
  assert.equal(r.neverPaysOff, false);
  assert.equal(r.exceedsMaxMonths, true);
});

test('amortize: invalid inputs throw ValidationError', () => {
  assert.throws(() => D.amortize({ balanceCents: 1000, aprPct: -1, paymentCents: 100 }), E.ValidationError);
  assert.throws(() => D.amortize({ balanceCents: 1000, aprPct: 'six', paymentCents: 100 }), E.ValidationError);
  assert.throws(() => D.amortize({ balanceCents: 1000, aprPct: 5, paymentCents: 100, maxMonths: 0 }), E.ValidationError);
});

// ------------------------------------------------------------------ illustrativeRange

test('illustrativeRange: fastest uses the lower rate and is never slower than slowest', () => {
  const r = D.illustrativeRange({ balanceCents: 1421280, paymentCents: 28950, aprMin: 3.73, aprMax: 6.28 });
  assert.equal(r.fastest.aprPct, 3.73);
  assert.equal(r.slowest.aprPct, 6.28);
  assert.ok(r.fastest.months <= r.slowest.months);
  assert.ok(r.fastest.interestCents < r.slowest.interestCents);
  assert.equal(r.illustrative, true);
  assert.match(r.note, /Illustration only/);
  assert.match(r.note, /not a payoff date/);
});

test('illustrativeRange: reversed inputs are put in order', () => {
  const a = D.illustrativeRange({ balanceCents: 500000, paymentCents: 15000, aprMin: 8, aprMax: 2 });
  assert.equal(a.fastest.aprPct, 2);
  assert.equal(a.slowest.aprPct, 8);
  assert.ok(a.fastest.months <= a.slowest.months);
});

test('illustrativeRange: missing rates give no illustration', () => {
  const r = D.illustrativeRange({ balanceCents: 500000, paymentCents: 15000, aprMin: null, aprMax: 6 });
  assert.equal(r.fastest.months, null);
  assert.ok(r.missing.length > 0);
  assert.match(r.note, /not available/);
});

test('illustrativeRange: a payment below interest at the high rate is reported as never', () => {
  const r = D.illustrativeRange({ balanceCents: 1000000, paymentCents: 15000, aprMin: 10, aprMax: 20 });
  assert.equal(r.fastest.neverPaysOff, false);
  assert.equal(r.slowest.neverPaysOff, true);
  assert.match(r.note, /never/);
});

// ------------------------------------------------------------------ promoCheck

test('promoCheck: on track when payments clear the balance by the end month', () => {
  const r = D.promoCheck({ promoBalanceCents: 120000, expiresMonth: '2027-09', paymentCents: 10000, fromMonth: '2026-10', deferredInterest: false });
  assert.equal(r.status, 'on_track');
  assert.equal(r.monthsLeft, 12);
  assert.equal(r.requiredMonthlyCents, 10000);
  assert.equal(r.projectedRemainingCents, 0);
  assert.deepEqual(r.missing, []);
});

test('promoCheck: short only when payment × months is less than the balance', () => {
  const r = D.promoCheck({ promoBalanceCents: 120000, expiresMonth: '2027-09', paymentCents: 5500, fromMonth: '2026-10', deferredInterest: false });
  assert.equal(r.status, 'short');
  assert.equal(r.projectedRemainingCents, 120000 - 12 * 5500);
  assert.equal(r.shortByCents, 54000);
  assert.equal(r.requiredMonthlyCents, 10000);
  assert.match(r.notes[0], /would remain after Sep 2027/);
});

test('promoCheck: months are inclusive of both the start and end month', () => {
  assert.equal(D.promoCheck({ promoBalanceCents: 5000, expiresMonth: '2026-10', paymentCents: 5000, fromMonth: '2026-10' }).monthsLeft, 1);
  assert.equal(D.promoCheck({ promoBalanceCents: 5000, expiresMonth: '2026-12', paymentCents: 5000, fromMonth: '2026-10' }).monthsLeft, 3);
  assert.equal(D.promoCheck({ promoBalanceCents: 5000, expiresMonth: '2027-01', paymentCents: 5000, fromMonth: '2026-10' }).monthsLeft, 4);
});

test('promoCheck: required monthly payment rounds up to the cent', () => {
  const r = D.promoCheck({ promoBalanceCents: 100000, expiresMonth: '2026-12', paymentCents: 33334, fromMonth: '2026-10' });
  assert.equal(r.requiredMonthlyCents, 33334);
  assert.equal(r.status, 'on_track');
  assert.equal(D.promoCheck({ promoBalanceCents: 100000, expiresMonth: '2026-12', paymentCents: 33333, fromMonth: '2026-10' }).status, 'short');
});

test('promoCheck: exactly enough is on track (boundary)', () => {
  const r = D.promoCheck({ promoBalanceCents: 90000, expiresMonth: '2026-12', paymentCents: 30000, fromMonth: '2026-10' });
  assert.equal(r.status, 'on_track');
});

test('promoCheck: unknown promo balance -> needs_info even with a small payment', () => {
  const r = D.promoCheck({ promoBalanceCents: null, expiresMonth: '2027-04', paymentCents: 100, fromMonth: '2026-10' });
  assert.equal(r.status, 'needs_info');
  assert.ok(r.missing.some(m => /Promotional balance/.test(m)));
  assert.equal(r.projectedRemainingCents, null);
  assert.equal(r.requiredMonthlyCents, null);
});

test('promoCheck: unknown end month -> needs_info and listed', () => {
  const r = D.promoCheck({ promoBalanceCents: 198035, expiresMonth: null, paymentCents: 5500, fromMonth: '2026-10' });
  assert.equal(r.status, 'needs_info');
  assert.ok(r.missing.includes('Promotion end month'));
  assert.equal(r.monthsLeft, null);
});

test('promoCheck: both facts missing are both listed', () => {
  const r = D.promoCheck({ promoBalanceCents: null, expiresMonth: null, paymentCents: 5500, fromMonth: '2026-10' });
  assert.equal(r.status, 'needs_info');
  assert.equal(r.missing.length, 2);
});

test('promoCheck: an end month already passed asks for current facts instead of judging', () => {
  const r = D.promoCheck({ promoBalanceCents: 50000, expiresMonth: '2026-08', paymentCents: 5500, fromMonth: '2026-10' });
  assert.equal(r.status, 'needs_info');
  assert.equal(r.monthsLeft, 0);
  assert.ok(r.missing.some(m => /current promotion end month/.test(m)));
});

test('promoCheck: deferred-interest note when true or unknown, never when false', () => {
  const base = { promoBalanceCents: 120000, expiresMonth: '2027-09', paymentCents: 10000, fromMonth: '2026-10' };
  const unknown = D.promoCheck(Object.assign({}, base, { deferredInterest: null }));
  assert.ok(unknown.notes.some(n => /not confirmed/.test(n) && /defers interest/.test(n)));
  const missingField = D.promoCheck(base);
  assert.ok(missingField.notes.some(n => /not confirmed/.test(n)));
  const yes = D.promoCheck(Object.assign({}, base, { deferredInterest: true }));
  assert.ok(yes.notes.some(n => /marked as deferred interest/.test(n) && /may be charged/.test(n)));
  const no = D.promoCheck(Object.assign({}, base, { deferredInterest: false }));
  assert.ok(!no.notes.some(n => /defer/i.test(n)));
});

test('promoCheck: zero promo balance is on track', () => {
  const r = D.promoCheck({ promoBalanceCents: 0, expiresMonth: '2027-01', paymentCents: 0, fromMonth: '2026-10', deferredInterest: false });
  assert.equal(r.status, 'on_track');
  assert.equal(r.requiredMonthlyCents, 0);
});

// ------------------------------------------------------------------ summary

const mortgage = { id: 'mortgage', label: 'Mortgage', ownerId: 'joint', balanceCents: 14800000, balanceAsOf: '2026-09-01', balanceStatus: 'approximate', aprPct: null, aprRange: null, aprStatus: 'unknown', paymentBillId: 'mortgage', promo: null, loanCount: null, repaymentPlan: null, termStatus: 'unknown', escrowIncluded: null, note: '' };
const mortgageBill = { id: 'mortgage', label: 'Mortgage', category: 'Mortgage', monthlyCents: 141256, fundedFrom: 'joint', type: 'housing', debtId: 'mortgage', status: 'existing' };
const lineOf = (s, key) => s.lines.find(l => l.key === key);

test('summary: housing debt lists balance, payment, APR status and the escrow unknown note', () => {
  const s = D.summary(mortgage, mortgageBill);
  assert.equal(lineOf(s, 'balance').value, '$148,000.00 (approximate, as of Sep 1, 2026)');
  assert.equal(lineOf(s, 'balance').status, 'approximate');
  assert.equal(lineOf(s, 'payment').value, '$1,412.56 a month, paid from joint');
  assert.equal(lineOf(s, 'apr').status, 'unknown');
  assert.equal(lineOf(s, 'escrow').status, 'unknown');
  assert.ok(s.warnings.some(w => /Escrow unknown/.test(w)));
  assert.ok(s.warnings.some(w => /Interest rate not confirmed: no payoff date/.test(w)));
  assert.equal(lineOf(s, 'paymentsLeft').value, 'At least 105 payments (assumes 0% interest)');
  assert.equal(lineOf(s, 'illustration'), undefined);
});

test('summary: escrow known either way is stated plainly', () => {
  assert.match(lineOf(D.summary(Object.assign({}, mortgage, { escrowIncluded: true }), mortgageBill), 'escrow').value, /Included/);
  assert.match(lineOf(D.summary(Object.assign({}, mortgage, { escrowIncluded: false }), mortgageBill), 'escrow').value, /budget property tax/);
});

test('summary: non-housing debt has no escrow line', () => {
  const car = { id: 'car', label: 'Car loan', balanceCents: 590000, balanceAsOf: null, balanceStatus: 'approximate', aprStatus: 'unknown', termStatus: 'unknown' };
  const s = D.summary(car, { id: 'car', label: 'Car loan', monthlyCents: 24500, fundedFrom: 'p1', type: 'debt' });
  assert.equal(lineOf(s, 'escrow'), undefined);
  assert.ok(s.warnings.includes('Date of the balance not entered.'));
  assert.match(lineOf(s, 'payment').value, /personal account \(p1\)/);
});

test('summary: displayed APR range across several loans', () => {
  const loans = { id: 'loans', label: 'Student loans', balanceCents: 1421280, balanceAsOf: '2026-09-01', balanceStatus: 'statement', aprPct: null, aprRange: [3.73, 6.28], aprStatus: 'displayed', loanCount: 6, repaymentPlan: null, termStatus: 'unknown' };
  const s = D.summary(loans, { id: 'loans', label: 'Student loans', monthlyCents: 28950, fundedFrom: 'p1', type: 'debt' });
  assert.equal(lineOf(s, 'apr').value, '3.73%–6.28% (displayed range, not confirmed)');
  assert.equal(lineOf(s, 'loans').value, '6 loans');
  assert.equal(lineOf(s, 'plan').status, 'unknown');
  assert.ok(s.warnings.includes('Repayment plan not confirmed.'));
  assert.match(lineOf(s, 'balance').value, /statement balance/);
});

test('summary: store card promotion with unverified terms needs info and lists what is missing', () => {
  const card = { id: 'card', label: 'Store card', balanceCents: 198035, balanceAsOf: '2026-09-05', balanceStatus: 'statement', aprStatus: 'unknown', termStatus: 'unknown', promo: { balanceCents: null, expiresMonth: null, deferredInterest: null, note: '' } };
  const s = D.summary(card, { id: 'card', label: 'Store card', monthlyCents: 5500, fundedFrom: 'joint', type: 'debt' }, { month: '2026-10' });
  assert.equal(s.promo.status, 'needs_info');
  assert.equal(lineOf(s, 'promo').status, 'needs_info');
  assert.match(lineOf(s, 'promo').value, /promotional balance/);
  assert.match(lineOf(s, 'promo').value, /promotion end month/);
  assert.ok(s.warnings.some(w => /Promotion: Promotional balance/.test(w)));
  assert.ok(s.warnings.some(w => /Promotion: Promotion end month/.test(w)));
  assert.ok(s.warnings.some(w => /whether interest is deferred is not confirmed/.test(w)));
});

test('summary: promotion with known facts reports short/on track', () => {
  const card = { id: 'card', label: 'Store card', balanceCents: 198035, balanceStatus: 'statement', aprStatus: 'unknown', promo: { balanceCents: 120000, expiresMonth: '2027-09', deferredInterest: true } };
  const s = D.summary(card, { id: 'card', label: 'Store card', monthlyCents: 5500, fundedFrom: 'joint', type: 'debt' }, { month: '2026-10' });
  assert.equal(s.promo.status, 'short');
  assert.match(lineOf(s, 'promo').value, /\$100\.00 a month needed through Sep 2027/);
});

test('summary: missing payment bill and missing balance are warnings', () => {
  const s = D.summary({ id: 'x', label: 'Family loan', balanceCents: null, aprStatus: 'unknown' }, null);
  assert.equal(lineOf(s, 'balance').value, 'Unknown');
  assert.equal(lineOf(s, 'payment').value, 'No payment bill linked');
  assert.ok(s.warnings.includes('Balance not entered.'));
  assert.ok(s.warnings.includes('No monthly payment is linked to this debt.'));
  assert.equal(s.lowerBound.months, null);
});

test('summary: a confirmed rate adds a labelled illustration in months, never a date', () => {
  const car = { id: 'car', label: 'Car loan', balanceCents: 590000, balanceAsOf: '2026-09-01', balanceStatus: 'confirmed', aprPct: 5.9, aprStatus: 'confirmed', termStatus: 'confirmed' };
  const s = D.summary(car, { id: 'car', label: 'Car loan', monthlyCents: 24500, fundedFrom: 'p1', type: 'debt' });
  const ill = lineOf(s, 'illustration');
  assert.equal(ill.status, 'illustrative');
  assert.match(ill.value, /^About \d+ months at 5.9%/);
  assert.doesNotMatch(ill.value, /20\d\d/);
  assert.ok(!s.warnings.some(w => /Interest rate not confirmed/.test(w)));
});

test('summary: requires a debt object', () => {
  assert.throws(() => D.summary(null, null), E.ValidationError);
});

test('summary: an APR marked confirmed but with no rate entered is still listed as a missing fact', () => {
  const d = Object.assign({}, mortgage, { aprStatus: 'confirmed', aprPct: null, aprRange: null });
  const s = D.summary(d, mortgageBill);
  assert.equal(lineOf(s, 'apr').status, 'unknown');
  assert.ok(s.warnings.some(w => /Interest rate not entered/.test(w)), s.warnings.join('\n'));
  assert.equal(lineOf(s, 'illustration'), undefined);
});
