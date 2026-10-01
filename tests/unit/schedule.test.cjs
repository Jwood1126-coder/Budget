'use strict';
// Tests for BudgetEngine.schedule: paycheck dates, counts per timing mode and the frequency
// table. All streams and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const S = E.schedule;

const ANCHOR = '2024-10-04'; // a Friday payday for an invented biweekly paycheck
const biweekly = (extra = {}) => Object.assign({ id: 'pay-a', label: 'Partner A paycheck', frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: ANCHOR }, extra);
const weekday = d => E.dates.weekday(d);

// ------------------------------------------------------------------ weekly / biweekly

test('biweekly: exactly 26 paydays in any 364-day window, 14 days apart', () => {
  const start = '2026-01-01';
  const end = E.dates.addDays(start, 363);
  const dates = [];
  for (const m of E.months.range(E.months.of(start), E.months.of(end))) dates.push(...S.paydays(biweekly(), m));
  const inWindow = dates.filter(d => d >= start && d <= end);
  assert.equal(inWindow.length, 26);
  for (let i = 1; i < inWindow.length; i++) assert.equal(E.dates.daysBetween(inWindow[i - 1], inWindow[i]), 14);
});

test('biweekly: a calendar year has exactly two 3-paycheck months for this anchor', () => {
  const months = E.months.range('2026-01', '2026-12');
  const counts = months.map(m => S.count(biweekly(), m, 'actual'));
  const three = months.filter((m, i) => counts[i].count === 3);
  assert.deepEqual(three, ['2026-05', '2026-10']);
  assert.equal(counts.reduce((a, c) => a + c.count, 0), 26);
  assert.ok(counts.every(c => c.basis === 'actual' && c.assumption === null));
});

test('biweekly: 3-paycheck month dates are listed', () => {
  const c = S.count(biweekly(), '2026-10', 'actual');
  assert.equal(c.count, 3);
  assert.deepEqual(c.dates, ['2026-10-02', '2026-10-16', '2026-10-30']);
});

test('biweekly: an anchor in the future produces the same cadence as one in the past', () => {
  const future = biweekly({ anchorDate: '2027-04-02' }); // 65 fortnights after the past anchor
  for (const m of ['2024-01', '2025-06', '2026-10', '2027-02', '2028-12']) {
    assert.deepEqual(S.paydays(future, m), S.paydays(biweekly(), m), m);
  }
});

test('biweekly: anchor date itself is a payday and months before the anchor work', () => {
  assert.ok(S.paydays(biweekly(), '2024-10').includes(ANCHOR));
  const before = S.paydays(biweekly(), '2023-01');
  assert.ok(before.length >= 2);
  for (const d of before) assert.equal(E.dates.daysBetween(d, ANCHOR) % 14, 0);
});

test('weekly: five paydays in a five-Friday month, four otherwise', () => {
  const s = { frequency: 'weekly', anchorDate: '2026-10-02' };
  assert.deepEqual(S.paydays(s, '2026-10'), ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
  assert.equal(S.count(s, '2026-11').count, 4);
});

test('weekly/biweekly follow the anchor exactly (no weekend roll)', () => {
  const saturday = { frequency: 'biweekly', anchorDate: '2026-08-01' };
  assert.equal(weekday('2026-08-01'), 6);
  const dates = S.paydays(saturday, '2026-08');
  assert.deepEqual(dates, ['2026-08-01', '2026-08-15', '2026-08-29']);
  assert.ok(dates.every(d => weekday(d) === 6));
});

test('weekly/biweekly without an anchor: paydays null', () => {
  assert.equal(S.paydays(biweekly({ anchorDate: null }), '2026-10'), null);
  assert.equal(S.paydays({ frequency: 'weekly' }, '2026-10'), null);
});

// ------------------------------------------------------------------ semimonthly / monthly

test('semimonthly: day 31 means the last day; February clamps and rolls back from the weekend', () => {
  const s = { frequency: 'semimonthly', semimonthlyDays: [15, 31] };
  // 2026-02-15 is a Sunday and 2026-02-28 a Saturday: both move to the previous Friday.
  assert.deepEqual(S.paydays(s, '2026-02'), ['2026-02-13', '2026-02-27']);
  // Leap year: 29 February 2028 is a Tuesday.
  assert.deepEqual(S.paydays(s, '2028-02'), ['2028-02-15', '2028-02-29']);
});

test('semimonthly: 30-day month uses the 30th for day 31', () => {
  const s = { frequency: 'semimonthly', semimonthlyDays: [15, 31] };
  assert.deepEqual(S.paydays(s, '2026-09'), ['2026-09-15', '2026-09-30']);
});

test('semimonthly: defaults to the 15th and last day', () => {
  assert.deepEqual(S.paydays({ frequency: 'semimonthly' }, '2026-09'), ['2026-09-15', '2026-09-30']);
});

test('semimonthly: Sunday the 31st rolls back to Friday the 29th', () => {
  assert.equal(weekday('2026-05-31'), 0);
  assert.deepEqual(S.paydays({ frequency: 'semimonthly' }, '2026-05'), ['2026-05-15', '2026-05-29']);
});

test('semimonthly: a 1st on Saturday rolls to the prior Friday but still counts for its own month', () => {
  const s = { frequency: 'semimonthly', semimonthlyDays: [1, 15] };
  assert.equal(weekday('2026-08-01'), 6);
  const aug = S.count(s, '2026-08', 'actual');
  assert.equal(aug.count, 2);
  assert.deepEqual(aug.dates, ['2026-07-31', '2026-08-14']);
  // July is not credited with a third payday.
  assert.equal(S.count(s, '2026-07', 'actual').count, 2);
});

test('semimonthly: always 2 a month under actual timing across a year', () => {
  const s = { frequency: 'semimonthly', semimonthlyDays: [1, 15] };
  for (const m of E.months.range('2026-01', '2026-12')) assert.equal(S.count(s, m, 'actual').count, 2, m);
});

test('monthly: day 31 clamps to the month length, then the weekend rule applies', () => {
  const s = { frequency: 'monthly', monthlyDay: 31 };
  assert.deepEqual(S.paydays(s, '2026-04'), ['2026-04-30']);
  assert.deepEqual(S.paydays(s, '2026-02'), ['2026-02-27']); // 28th is a Saturday
  assert.deepEqual(S.paydays(s, '2026-01'), ['2026-01-30']); // 31st is a Saturday
});

test('monthly: falls back to the anchor day when monthlyDay is missing', () => {
  assert.deepEqual(S.paydays({ frequency: 'monthly', anchorDate: '2026-01-10' }, '2026-09'), ['2026-09-10']);
});

test('monthly without a day: actual timing falls back to a typical month with an assumption', () => {
  const c = S.count({ label: 'Side income', frequency: 'monthly' }, '2026-09', 'actual');
  assert.equal(c.count, 1);
  assert.equal(c.basis, 'typical');
  assert.match(c.assumption, /No payday of the month entered for Side income/);
});

// ------------------------------------------------------------------ count / timing modes

test('count: conservative timing uses a typical month', () => {
  assert.equal(S.count(biweekly(), '2026-10', 'conservative').count, 2);
  assert.equal(S.count(biweekly(), '2026-10', 'conservative').basis, 'typical');
  assert.equal(S.count({ frequency: 'weekly', anchorDate: '2026-10-02' }, '2026-10', 'conservative').count, 4);
  assert.equal(S.count({ frequency: 'semimonthly' }, '2026-10', 'conservative').count, 2);
  assert.equal(S.count({ frequency: 'monthly', monthlyDay: 1 }, '2026-10', 'conservative').count, 1);
});

test('count: average timing is fractional and reports paychecks per year', () => {
  const c = S.count(biweekly(), '2026-10', 'average');
  assert.equal(c.count, 26 / 12);
  assert.equal(c.basis, 'average');
  assert.equal(c.perYear, 26);
  assert.equal(S.count({ frequency: 'weekly', anchorDate: ANCHOR }, '2026-10', 'average').count, 52 / 12);
  assert.equal(S.count({ frequency: 'semimonthly' }, '2026-10', 'average').count, 2);
});

test('count: actual timing is the default', () => {
  assert.equal(S.count(biweekly(), '2026-10').count, 3);
  assert.equal(S.count(biweekly(), '2026-10').basis, 'actual');
});

test('count: biweekly without an anchor in actual timing falls back to 2 with an assumption', () => {
  const c = S.count(biweekly({ anchorDate: null }), '2026-10', 'actual');
  assert.equal(c.count, 2);
  assert.equal(c.basis, 'typical');
  assert.deepEqual(c.dates, []);
  assert.match(c.assumption, /No payday date entered for Partner A paycheck: counting a typical month of 2 paychecks/);
});

test('count: unknown frequency uses the explicit assumption with clear wording', () => {
  const s = { id: 'pay-b', label: 'Partner B paycheck', frequency: 'unknown', frequencyStatus: 'unknown' };
  for (const timing of ['actual', 'conservative', 'average']) {
    const c = S.count(s, '2026-10', timing);
    assert.equal(c.count, 2);
    assert.equal(c.basis, 'assumed');
    assert.equal(c.assumption, 'Pay frequency not confirmed: assuming 2 paychecks a month for Partner B paycheck.');
  }
  assert.equal(S.paydays(s, '2026-10'), null);
});

test('count: unknown frequency respects assumedPerMonthIfUnknown (singular wording)', () => {
  const c = S.count({ label: 'Partner B paycheck', frequency: 'unknown', assumedPerMonthIfUnknown: 1 }, '2026-10');
  assert.equal(c.count, 1);
  assert.match(c.assumption, /assuming 1 paycheck a month/);
});

test('count: missing or invalid frequency is treated as unknown', () => {
  assert.equal(S.count({ label: 'X' }, '2026-10').basis, 'assumed');
  assert.equal(S.count({ label: 'X', frequency: 'fortnightly-ish' }, '2026-10').basis, 'assumed');
});

test('count: a set frequency marked as unconfirmed carries an assumption', () => {
  const c = S.count(biweekly({ frequencyStatus: 'unknown' }), '2026-10', 'conservative');
  assert.equal(c.count, 2);
  assert.match(c.assumption, /Pay frequency not confirmed: assuming biweekly pay/);
});

test('count: startMonth/endMonth limit the stream (0 outside, basis none)', () => {
  const s = biweekly({ startMonth: '2026-11', endMonth: '2027-01' });
  assert.deepEqual(S.count(s, '2026-10'), { count: 0, basis: 'none', dates: [], assumption: null, perYear: null });
  assert.equal(S.count(s, '2026-11').count, 2);
  assert.equal(S.count(s, '2027-01', 'average').count, 26 / 12);
  assert.equal(S.count(s, '2027-02', 'conservative').count, 0);
  // An unknown-frequency stream outside its window does not get the assumed count.
  assert.equal(S.count({ frequency: 'unknown', endMonth: '2026-01' }, '2026-10').count, 0);
});

test('count: a stream that starts in its anchor month is not paid before its first payday', () => {
  // A new job whose first biweekly check is Friday Jan 15: January has 2 checks (15, 29),
  // not 3 — the Jan 1 date is before the stream existed.
  const s = { label: 'New job', frequency: 'biweekly', frequencyStatus: 'confirmed', anchorDate: '2027-01-15', startMonth: '2027-01' };
  const jan = S.count(s, '2027-01');
  assert.equal(jan.count, 2);
  assert.deepEqual(jan.dates, ['2027-01-15', '2027-01-29']);
  assert.equal(S.count(s, '2027-02').count, 2);
  // Without a start month the anchor is just one known payday: earlier dates still count.
  assert.equal(S.count(Object.assign({}, s, { startMonth: null }), '2027-01').count, 3);
  // An anchor in an earlier month than startMonth does not trim anything.
  assert.equal(S.count(Object.assign({}, s, { anchorDate: '2026-12-18' }), '2027-01').count, 3);
  // Typical/average timing is unchanged.
  assert.equal(S.count(s, '2027-01', 'conservative').count, 2);
});

test('count/paydays: invalid inputs throw ValidationError', () => {
  assert.throws(() => S.count(biweekly(), '2026-13'), E.ValidationError);
  assert.throws(() => S.count(biweekly(), '2026-10', 'sometimes'), E.ValidationError);
  assert.throws(() => S.paydays(biweekly(), 'October'), E.ValidationError);
  assert.throws(() => S.count(null, '2026-10'), E.ValidationError);
});

// ------------------------------------------------------------------ perMonth / frequencyTable

test('perMonth: conservative and average values per contract', () => {
  assert.equal(S.perMonth('weekly', 'conservative'), 4);
  assert.equal(S.perMonth('weekly', 'average'), 52 / 12);
  assert.equal(S.perMonth('biweekly', 'conservative'), 2);
  assert.equal(S.perMonth('biweekly', 'average'), 26 / 12);
  assert.equal(S.perMonth('semimonthly', 'average'), 2);
  assert.equal(S.perMonth('monthly', 'average'), 1);
  assert.equal(S.perMonth('unknown', 'average'), null);
  assert.throws(() => S.perMonth('weekly', 'actual'), E.ValidationError);
});

test('frequencyTable: typical, 3-check, average month and extra checks per year', () => {
  const rows = S.frequencyTable(100000);
  const by = Object.fromEntries(rows.map(r => [r.frequency, r]));
  assert.deepEqual(rows.map(r => r.frequency), ['weekly', 'biweekly', 'semimonthly', 'monthly']);
  assert.equal(by.biweekly.typicalMonthCents, 200000);
  assert.equal(by.biweekly.highMonthChecks, 3);
  assert.equal(by.biweekly.highMonthCents, 300000);
  assert.equal(by.biweekly.averageMonthCents, 216667);
  assert.equal(by.biweekly.extraChecksPerYear, 2);
  assert.equal(by.biweekly.annualCents, 2600000);
  assert.equal(by.weekly.typicalMonthCents, 400000);
  assert.equal(by.weekly.highMonthCents, 500000);
  assert.equal(by.weekly.averageMonthCents, 433333);
  assert.equal(by.weekly.extraChecksPerYear, 4);
  assert.equal(by.semimonthly.highMonthCents, null);
  assert.equal(by.semimonthly.extraChecksPerYear, 0);
  assert.equal(by.monthly.averageMonthCents, 100000);
  for (const r of rows) assert.ok(r.label && r.note);
});

test('frequencyTable: unknown amount gives null money but keeps the counts', () => {
  const rows = S.frequencyTable(null);
  for (const r of rows) {
    assert.equal(r.typicalMonthCents, null);
    assert.equal(r.averageMonthCents, null);
    assert.equal(r.annualCents, null);
  }
  assert.equal(rows.find(r => r.frequency === 'biweekly').extraChecksPerYear, 2);
  assert.throws(() => S.frequencyTable(12.5), E.ValidationError);
});
