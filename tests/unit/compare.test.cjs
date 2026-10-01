'use strict';
// Tests for BudgetEngine.compare: usual-spend comparisons, trends, planning baselines and
// plan vs actual. All households, merchants and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const L = E.ledger;
const C = E.compare;

let seq = 0;
/** One spending row on the 10th of `month` (or `day`). Positive `cents` = money spent. */
function spend(month, cents, category = 'Groceries', fields = {}) {
  seq += 1;
  const day = String(fields.day || 10).padStart(2, '0');
  const row = Object.assign({
    id: 's' + String(seq).padStart(5, '0'),
    accountId: 'card',
    date: month + '-' + day,
    description: 'SAMPLE MERCHANT ' + category.toUpperCase(),
    amountCents: 0 - cents,
    kind: 'spend',
    category
  }, fields);
  delete row.day;
  return row;
}

/**
 * Dataset with joint checking + joint card (and a personal account). Coverage defaults to
 * 2025-01-01 .. 2026-12-31 for both joint accounts.
 */
function build(txns, { start = '2025-01-01', end = '2026-12-31', cardStart, cardEnd, overrides } = {}) {
  return L.normalizeDataset({
    schemaVersion: 2,
    datasetId: 'compare-test',
    isSynthetic: true,
    accounts: [
      { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start, end }] },
      { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [{ start: cardStart || start, end: cardEnd || end }] },
      { id: 'sam-chk', label: 'Sam personal', type: 'checking', scope: 'personal', ownerId: 'p2', coverage: [{ start, end }] }
    ],
    transactions: txns,
    coverageOverrides: overrides
  });
}

const effective = (ds, edits = {}) => L.applyEdits(ds, edits);
const cat = (result, name) => result.categories.find(c => c.category === name);

function usualFor(txns, opts, buildOpts, edits) {
  const ds = build(txns, buildOpts);
  return C.usual(effective(ds, edits), ds, opts);
}

// ======================================================================= the basic rule

test('usual: the example from the contract, with the exact explanation', () => {
  const r = usualFor([spend('2026-06', 26000), spend('2026-07', 26000), spend('2026-08', 26000), spend('2026-09', 41200)], { month: '2026-09', window: 3 });
  const g = cat(r, 'Groceries');
  assert.equal(g.actualCents, 41200);
  assert.equal(g.averageCents, 26000);
  assert.equal(g.diffCents, 15200);
  assert.equal(g.pct, 58);
  assert.equal(g.signal, 'higher');
  assert.equal(g.group, 'Food');
  assert.equal(g.explanation, 'Sep 2026 $412 vs usual $260 (average of Jun–Aug 2026, 3 full months). +$152 (+58%) exceeds both $100 and 25%, so it is marked higher than usual.');
});

test('usual: the selected month never enters its own baseline', () => {
  const r = usualFor([spend('2026-06', 10000), spend('2026-07', 20000), spend('2026-08', 30000), spend('2026-09', 900000)], { month: '2026-09', window: 3 });
  assert.deepEqual(r.baselineMonths, ['2026-06', '2026-07', '2026-08']);
  assert.ok(!r.baselineMonths.includes('2026-09'));
  assert.equal(cat(r, 'Groceries').averageCents, 20000);
  assert.equal(r.usableCount, 3);
  assert.deepEqual(r.excludedMonths, []);
});

test('usual: 3, 6 and 12 month windows use the months immediately before', () => {
  const txns = [];
  // Sep 2025 .. Aug 2026: 1,000 cents per month index so each window has a distinct average.
  E.months.range('2025-09', '2026-08').forEach((m, i) => txns.push(spend(m, (i + 1) * 1000)));
  txns.push(spend('2026-09', 5000));
  const ds = build(txns);
  const rows = effective(ds);
  const r3 = C.usual(rows, ds, { month: '2026-09', window: 3 });
  const r6 = C.usual(rows, ds, { month: '2026-09', window: 6 });
  const r12 = C.usual(rows, ds, { month: '2026-09', window: 12 });
  assert.deepEqual(r3.baselineMonths, ['2026-06', '2026-07', '2026-08']);
  assert.equal(r6.baselineMonths[0], '2026-03');
  assert.equal(r12.baselineMonths[0], '2025-09');
  assert.equal(cat(r3, 'Groceries').averageCents, 11000); // (10+11+12) * 1000 / 3
  assert.equal(cat(r6, 'Groceries').averageCents, 9500); // (7..12) * 1000 / 6
  assert.equal(cat(r12, 'Groceries').averageCents, 6500); // (1..12) * 1000 / 12
  assert.equal(r12.window, 12);
});

test('usual: the default window is 3 months and invalid windows or months are rejected', () => {
  const ds = build([spend('2026-09', 1000)]);
  assert.equal(C.usual(effective(ds), ds, { month: '2026-09' }).window, 3);
  assert.throws(() => C.usual(effective(ds), ds, { month: '2026-09', window: 0 }), E.ValidationError);
  assert.throws(() => C.usual(effective(ds), ds, { month: '2026-9' }), E.ValidationError);
  assert.throws(() => C.usual(effective(ds), ds, {}), E.ValidationError);
});

test('usual: partial baseline months are left out, not zero-filled', () => {
  const txns = [spend('2026-06', 30000), spend('2026-07', 2000), spend('2026-08', 30000), spend('2026-09', 30000)];
  const r = usualFor(txns, { month: '2026-09', window: 3 }, { overrides: { '2026-07': { status: 'partial', note: 'Card export missing late July' } } });
  assert.deepEqual(r.baselineMonths, ['2026-06', '2026-08']);
  assert.equal(r.usableCount, 2);
  assert.equal(cat(r, 'Groceries').averageCents, 30000); // (300 + 300) / 2, not / 3
  assert.deepEqual(r.excludedMonths.map(e => e.month), ['2026-07']);
  assert.match(r.excludedMonths[0].reason, /Marked partial \(Card export missing late July\)/);
  assert.match(cat(r, 'Groceries').explanation, /average of Jun 2026 and Aug 2026, 2 full months; left out: Jul 2026/);
});

test('usual: computed partial months give a days-covered reason', () => {
  const r = usualFor([spend('2026-07', 1000, 'Groceries', { day: 20 }), spend('2026-09', 1000)], { month: '2026-09', window: 3 }, { cardStart: '2026-07-15' });
  assert.deepEqual(r.excludedMonths, [
    { month: '2026-06', reason: 'Only 0 of 30 days covered' },
    { month: '2026-07', reason: 'Only 17 of 31 days covered' }
  ]);
});

test('usual: a covered month with no activity counts as $0', () => {
  const r = usualFor([spend('2026-07', 30000, 'Dental'), spend('2026-08', 30000, 'Dental'), spend('2026-09', 60000, 'Dental')], { month: '2026-09', window: 3 });
  const d = cat(r, 'Dental');
  assert.equal(d.averageCents, 20000); // June counts as $0
  assert.equal(d.monthsWithActivity, 2);
  assert.equal(d.signal, 'higher');
  // With activity in only one of the three months, the average is still computed with $0 months.
  const q = usualFor([spend('2026-07', 30000, 'Dental'), spend('2026-09', 30000, 'Dental')], { month: '2026-09', window: 3 });
  assert.equal(cat(q, 'Dental').averageCents, 10000);
  assert.equal(cat(q, 'Dental').monthsWithActivity, 1);
});

// ======================================================================= irregular categories

/** Annual home insurance: $1,104 every March. */
const annual = (...years) => years.map(y => spend(y + '-03', 110400, 'Home insurance'));

test('usual: a category paid once in the baseline is irregular, not lower, in the months it is not paid', () => {
  const r = usualFor(annual(2025, 2026).concat([spend('2026-09', 26000)]), { month: '2026-09', window: 6 });
  const h = cat(r, 'Home insurance');
  assert.equal(r.usableCount, 6);
  assert.equal(h.actualCents, 0);
  assert.equal(h.monthsWithActivity, 1);
  assert.equal(h.averageCents, 18400);
  assert.equal(h.signal, 'irregular');
  assert.equal(h.diffCents, null);
  assert.equal(h.pct, null);
  assert.deepEqual(h.irregular, { month: '2026-03', cents: 110400 });
  assert.equal(h.explanation, "Paid in only 1 of the last 6 full months (Mar 2026: $1,104), so a monthly average isn't meaningful. Sep 2026 ($0) is not marked higher or lower.");
});

test('usual: an annual payment is irregular, not higher, in the month it is paid', () => {
  const r = usualFor(annual(2025, 2026), { month: '2026-03', window: 12 });
  const h = cat(r, 'Home insurance');
  assert.equal(h.actualCents, 110400);
  assert.equal(h.signal, 'irregular');
  assert.equal(h.explanation, "Paid in only 1 of the last 12 full months (Mar 2025: $1,104), so a monthly average isn't meaningful. Mar 2026 ($1,104) is not marked higher or lower.");
});

test('usual: a baseline with no activity at all is still "new", not irregular', () => {
  const r = usualFor(annual(2025, 2026), { month: '2026-03', window: 6 });
  const h = cat(r, 'Home insurance');
  assert.equal(h.monthsWithActivity, 0);
  assert.equal(h.signal, 'new');
});

test('usual: irregular needs at least 3 usable months; with fewer the usual rule applies', () => {
  // June is partial, so only July and August are usable: one active month of two.
  const r = usualFor([spend('2026-07', 30000, 'Clothing'), spend('2026-09', 100)], { month: '2026-09', window: 3 }, { cardStart: '2026-06-15' });
  const c = cat(r, 'Clothing');
  assert.equal(r.usableCount, 2);
  assert.equal(c.signal, 'lower');
  assert.equal(c.diffCents, -15000);
});

test('usual: irregular explanations list months left out of the baseline', () => {
  const r = usualFor([spend('2026-04', 30000, 'Clothing'), spend('2026-09', 100)], { month: '2026-09', window: 6 }, { cardStart: '2026-03-20' });
  const c = cat(r, 'Clothing');
  assert.equal(r.usableCount, 5);
  assert.equal(c.signal, 'irregular');
  assert.equal(c.explanation, "Paid in only 1 of the last 5 full months (Apr 2026: $300), so a monthly average isn't meaningful. Sep 2026 ($0) is not marked higher or lower. Left out: Mar 2026 (only 12 of 31 days covered).");
});

test('usual: a partial selected month stays partial_month even for an irregular category', () => {
  const r = usualFor(annual(2025, 2026).concat([spend('2026-09', 1000, 'Groceries', { day: 2 })]), { month: '2026-09', window: 6 }, { cardEnd: '2026-09-12' });
  assert.equal(cat(r, 'Home insurance').signal, 'partial_month');
});

test('usual: two or more active baseline months use the usual rule', () => {
  const r = usualFor([spend('2026-04', 30000, 'Clothing'), spend('2026-07', 30000, 'Clothing'), spend('2026-09', 100)], { month: '2026-09', window: 6 });
  const c = cat(r, 'Clothing');
  assert.equal(c.monthsWithActivity, 2);
  assert.equal(c.signal, 'lower');
});

test('usual: on the sample data, annual home insurance is irregular in 6- and 12-month windows', () => {
  const ds = L.normalizeDataset(require('../../fixtures/sample-data.json'));
  const rows = effective(ds);
  const s6 = cat(C.usual(rows, ds, { month: '2026-09', window: 6 }), 'Home insurance');
  assert.equal(s6.signal, 'irregular');
  assert.match(s6.explanation, /^Paid in only 1 of the last 6 full months \(Mar 2026: \$1,104\), so a monthly average isn't meaningful\./);
  assert.equal(cat(C.usual(rows, ds, { month: '2026-03', window: 12 }), 'Home insurance').signal, 'irregular');
  assert.equal(cat(C.usual(rows, ds, { month: '2026-08', window: 6 }), 'Home insurance').signal, 'irregular');
});

test('usual: a zero baseline is "new" with no percentage', () => {
  const r = usualFor([spend('2026-07', 5000, 'Groceries'), spend('2026-09', 4500, 'Pets')], { month: '2026-09', window: 3 });
  const p = cat(r, 'Pets');
  assert.equal(p.averageCents, 0);
  assert.equal(p.signal, 'new');
  assert.equal(p.pct, null);
  assert.equal(p.diffCents, 4500);
  assert.equal(p.explanation, 'No Pets spending in Jun–Aug 2026 (3 full months), so $45 in Sep 2026 is new.');
});

test('usual: a category gone quiet shows the drop against its usual', () => {
  const r = usualFor([spend('2026-06', 30000, 'Hobbies'), spend('2026-07', 30000, 'Hobbies'), spend('2026-08', 30000, 'Hobbies'), spend('2026-09', 100)], { month: '2026-09', window: 3 });
  const h = cat(r, 'Hobbies');
  assert.equal(h.actualCents, 0);
  assert.equal(h.signal, 'lower');
  assert.equal(h.pct, -100);
});

test('usual: a negative (net refund) baseline is refund_baseline with no percentage', () => {
  const r = usualFor([spend('2026-06', -5000, 'Clothing'), spend('2026-09', 2000, 'Clothing')], { month: '2026-09', window: 3 });
  const c = cat(r, 'Clothing');
  assert.equal(c.averageCents, -1667);
  assert.equal(c.signal, 'refund_baseline');
  assert.equal(c.pct, null);
  assert.equal(c.diffCents, 3667);
  assert.match(c.explanation, /net refund of \$16\.67/);
  assert.equal(c.irregular, null); // a single refund is not a payment, so not 'irregular'
});

test('usual: fewer usable months than minMonths is limited_history and never flagged', () => {
  const r = usualFor([spend('2026-08', 1000), spend('2026-09', 900000)], { month: '2026-09', window: 3 }, { cardStart: '2026-07-15' });
  const g = cat(r, 'Groceries');
  assert.equal(r.usableCount, 1);
  assert.equal(g.signal, 'limited_history');
  assert.equal(g.averageCents, 1000);
  assert.equal(g.diffCents, 899000);
  assert.equal(g.pct, 89900);
  assert.match(g.explanation, /Only 1 full month of history; at least 2 are needed/);
});

test('usual: no usable month means no_history and a null average', () => {
  const r = usualFor([spend('2025-01', 5000)], { month: '2025-01', window: 3 });
  const g = cat(r, 'Groceries');
  assert.equal(r.usableCount, 0);
  assert.equal(g.signal, 'no_history');
  assert.equal(g.averageCents, null);
  assert.equal(g.diffCents, null);
  assert.equal(g.pct, null);
  assert.equal(r.totals.averageCents, null);
  assert.equal(r.totals.diffCents, null);
  assert.match(g.explanation, /^No full months in Oct–Dec 2024 to compare with/);
});

test('usual: a partial selected month is labelled and never flagged', () => {
  const r = usualFor([spend('2026-06', 1000), spend('2026-07', 1000), spend('2026-08', 1000), spend('2026-09', 500000, 'Groceries', { day: 5 })],
    { month: '2026-09', window: 3 }, { cardEnd: '2026-09-12' });
  const g = cat(r, 'Groceries');
  assert.equal(r.selectedCoverage.status, 'partial');
  assert.equal(g.signal, 'partial_month');
  assert.equal(g.explanation, 'Only 12 of 30 days covered; not compared.');
  assert.equal(g.diffCents, null);
  assert.equal(g.pct, null);
  assert.equal(g.averageCents, 1000);
  assert.equal(r.totals.diffCents, null);
});

test('usual: a selected month marked partial by override cites the note', () => {
  const r = usualFor([spend('2026-08', 1000), spend('2026-09', 1000)], { month: '2026-09' }, { overrides: { '2026-09': { status: 'partial', note: 'Statement not closed yet.' } } });
  assert.equal(cat(r, 'Groceries').explanation, 'Sep 2026 coverage is marked partial (Statement not closed yet); not compared.');
});

test('usual: threshold needs both the dollar and the percentage condition', () => {
  const cases = [
    // [baseline per month, selected, expected signal, explanation fragment]
    [26000, 37000, 'higher', 'exceeds both $100 and 25%'],
    [100000, 115000, 'typical', 'is over $100 but under 25% of usual'],
    [20000, 29000, 'typical', 'is over 25% but under $100'],
    [20000, 21000, 'typical', 'is under both $100 and 25%'],
    [40000, 20000, 'lower', 'exceeds both $100 and 25%, so it is marked lower than usual'],
    [40000, 50000, 'higher', 'meets both $100 and 25%']
  ];
  for (const [base, selected, signal, fragment] of cases) {
    const r = usualFor([spend('2026-06', base), spend('2026-07', base), spend('2026-08', base), spend('2026-09', selected)], { month: '2026-09' });
    const g = cat(r, 'Groceries');
    assert.equal(g.signal, signal, base + ' -> ' + selected);
    assert.ok(g.explanation.includes(fragment), g.explanation);
  }
});

test('usual: rule overrides change the threshold', () => {
  const txns = [spend('2026-06', 20000), spend('2026-07', 20000), spend('2026-08', 20000), spend('2026-09', 25000)];
  assert.equal(cat(usualFor(txns, { month: '2026-09' }), 'Groceries').signal, 'typical');
  const r = usualFor(txns, { month: '2026-09', rule: { minDiffCents: 2500, minPct: 10 } });
  assert.equal(cat(r, 'Groceries').signal, 'higher');
  assert.equal(r.rule.minMonths, 2);
});

// ======================================================================= seasonal

function heatingTxns(dec2026) {
  return [
    spend('2025-12', 19000, 'Gas & heating', { accountId: 'chk' }),
    spend('2026-09', 4000, 'Gas & heating', { accountId: 'chk' }),
    spend('2026-10', 7000, 'Gas & heating', { accountId: 'chk' }),
    spend('2026-11', 12000, 'Gas & heating', { accountId: 'chk' }),
    spend('2026-12', dec2026, 'Gas & heating', { accountId: 'chk' })
  ];
}

test('usual: seasonal categories compare with the same month last year', () => {
  const r = usualFor(heatingTxns(23500), { month: '2026-12' });
  const h = cat(r, 'Gas & heating');
  assert.equal(h.signal, 'seasonal_typical'); // the trailing average ($77) would have said "higher"
  assert.deepEqual(h.seasonal, { lastYearMonth: '2025-12', lastYearCents: 19000, lastYearCovered: true });
  assert.equal(h.averageCents, 7667);
  assert.equal(h.basis, 'last_year');
  assert.equal(h.basisCents, 19000);
  assert.equal(h.diffCents, 4500);
  assert.equal(h.pct, 24);
  assert.ok(h.explanation.startsWith('Gas & heating costs follow the seasons, so Dec 2026 is compared with Dec 2025 ($190) instead of the trailing average.'));
  assert.match(h.explanation, /typical for the season/);
});

test('usual: seasonal categories are flagged with the same threshold rule', () => {
  const h = cat(usualFor(heatingTxns(40000), { month: '2026-12' }), 'Gas & heating');
  assert.equal(h.signal, 'seasonal_higher');
  assert.match(h.explanation, /marked higher than last year/);
  const low = cat(usualFor(heatingTxns(5000), { month: '2026-12' }), 'Gas & heating');
  assert.equal(low.signal, 'seasonal_lower');
});

test('usual: seasonal without last-year data is seasonal_unknown and not flagged', () => {
  const r = usualFor(heatingTxns(40000).slice(1), { month: '2026-12' }, { start: '2026-01-01' });
  const h = cat(r, 'Gas & heating');
  assert.equal(h.signal, 'seasonal_unknown');
  assert.deepEqual(h.seasonal, { lastYearMonth: '2025-12', lastYearCents: null, lastYearCovered: false });
  assert.equal(h.basis, 'average');
  assert.match(h.explanation, /Dec 2025 is not fully covered, so Dec 2026 \(\$400\) is not judged against the trailing average/);
});

test('usual: seasonal with a partial last-year month is seasonal_unknown', () => {
  const r = usualFor(heatingTxns(40000), { month: '2026-12' }, { overrides: { '2025-12': { status: 'partial' } } });
  assert.equal(cat(r, 'Gas & heating').signal, 'seasonal_unknown');
});

test('usual: seasonal with a covered but empty last-year month is new', () => {
  const r = usualFor([spend('2026-12', 9000, 'Electric', { accountId: 'chk' })], { month: '2026-12' });
  const e = cat(r, 'Electric');
  assert.equal(e.signal, 'new');
  assert.equal(e.seasonal.lastYearCents, 0);
  assert.equal(e.pct, null);
});

test('usual: extra seasonal categories can be supplied', () => {
  const txns = [spend('2025-12', 10000, 'Gifts & donations'), spend('2026-09', 1000, 'Gifts & donations'), spend('2026-10', 1000, 'Gifts & donations'),
    spend('2026-11', 1000, 'Gifts & donations'), spend('2026-12', 11000, 'Gifts & donations')];
  assert.equal(cat(usualFor(txns, { month: '2026-12' }), 'Gifts & donations').signal, 'higher');
  assert.equal(cat(usualFor(txns, { month: '2026-12', seasonalCategories: ['Gifts & donations'] }), 'Gifts & donations').signal, 'seasonal_typical');
});

// ======================================================================= planning, edits, lists

function dentalScenario() {
  const ds = build([
    spend('2026-06', 4500, 'Dental', { id: 'routine-jun' }),
    spend('2026-08', 86000, 'Dental', { id: 'ep1' }),
    spend('2026-08', 71540, 'Dental', { id: 'ep2', day: 11 }),
    spend('2026-08', 41230, 'Dental', { id: 'ep3', day: 25 }),
    spend('2026-09', 4500, 'Dental', { id: 'routine-sep' })
  ]);
  const edits = {};
  for (const id of ['ep1', 'ep2', 'ep3']) edits[id] = { planningBaseline: 'exclude', history: [] };
  return { ds, rows: effective(ds, edits) };
}

test('usual: planning mode leaves out excluded rows from the usual but not from actuals', () => {
  const { ds, rows } = dentalScenario();
  const actual = C.usual(rows, ds, { month: '2026-09' });
  const planning = C.usual(rows, ds, { month: '2026-09', planning: true });
  const a = cat(actual, 'Dental'), p = cat(planning, 'Dental');
  assert.equal(a.averageCents, 67757); // (45 + 0 + 1,987.70) / 3
  assert.equal(a.signal, 'lower');
  assert.equal(p.averageCents, 1500);
  assert.equal(p.actualCents, a.actualCents);
  assert.equal(p.signal, 'typical');
  assert.equal(planning.planning, true);
  assert.equal(p.planningExcludedCents, 198770);
  assert.match(p.explanation, /For planning, \$1,988 marked as excluded from planning \(Aug 2026\) is left out of the usual \(\$678 with it\)\./);
  assert.ok(!a.explanation.includes('For planning'));
  assert.equal(planning.totals.averageCents, 1500);
  assert.equal(actual.totals.averageCents, 67757);
});

test('usual: planning mode notes excluded spending inside the selected month', () => {
  const { ds, rows } = dentalScenario();
  const p = cat(C.usual(rows, ds, { month: '2026-08', planning: true }), 'Dental');
  assert.equal(p.actualCents, 198770);
  assert.match(p.explanation, /Aug 2026 includes \$1,988 marked as excluded from planning; it still counts in actual spending\./);
});

test('usual: duplicates and confirmed reimbursements do not count', () => {
  const ds = build([
    spend('2026-06', 10000), spend('2026-07', 10000), spend('2026-08', 10000),
    spend('2026-09', 10000, 'Groceries', { id: 'g1' }), spend('2026-09', 10000, 'Groceries', { id: 'g2', day: 11 }),
    spend('2026-09', 48660, 'Travel', { id: 'air' })
  ]);
  const rows = effective(ds, { g2: { duplicate: 'exclude', history: [] }, air: { reimbursement: 'confirmed', history: [] } });
  const r = C.usual(rows, ds, { month: '2026-09' });
  assert.equal(cat(r, 'Groceries').actualCents, 10000);
  assert.equal(cat(r, 'Travel'), undefined);
});

test('usual: splits land in their categories', () => {
  const ds = build([spend('2026-06', 5000, 'Pets'), spend('2026-07', 5000, 'Pets'), spend('2026-08', 5000, 'Pets'), spend('2026-09', 21000, 'Mixed retail', { id: 'wh' })]);
  const rows = effective(ds, { wh: { splits: [{ category: 'Groceries', cents: 15000 }, { category: 'Pets', cents: 6000 }], history: [] } });
  const r = C.usual(rows, ds, { month: '2026-09' });
  assert.equal(cat(r, 'Pets').actualCents, 6000);
  assert.equal(cat(r, 'Groceries').actualCents, 15000);
  assert.equal(cat(r, 'Mixed retail'), undefined);
});

test('usual: categories come from the selected and baseline months, sorted by actual; totals add up', () => {
  const r = usualFor([
    spend('2026-02', 99900, 'Travel'), // outside the 3-month window
    spend('2026-06', 9000, 'Hobbies'),
    spend('2026-08', 20000), spend('2026-09', 25000),
    spend('2026-09', 140000, 'Mortgage', { accountId: 'chk' }),
    spend('2026-08', 140000, 'Mortgage', { accountId: 'chk' })
  ], { month: '2026-09' });
  assert.deepEqual(r.categories.map(c => c.category), ['Mortgage', 'Groceries', 'Hobbies']);
  assert.equal(r.totals.actualCents, 165000);
  assert.equal(r.totals.averageCents, 56333); // (9,000 + 160,000) / 3
  assert.equal(r.totals.diffCents, 165000 - 56333);
});

test('usual: a requested category is returned even without activity', () => {
  const r = usualFor([spend('2026-09', 5000)], { month: '2026-09', category: 'Vision' });
  assert.equal(r.categories.length, 1);
  const v = r.categories[0];
  assert.equal(v.category, 'Vision');
  assert.equal(v.actualCents, 0);
  assert.equal(v.averageCents, 0);
  assert.equal(v.signal, 'typical');
  assert.equal(r.totals.actualCents, 0);
});

test('usual: category results list the selected month transaction ids', () => {
  const r = usualFor([spend('2026-09', 5000, 'Groceries', { id: 'x1' }), spend('2026-09', 7000, 'Groceries', { id: 'x2', day: 12 })], { month: '2026-09' });
  assert.deepEqual(cat(r, 'Groceries').ids, ['x1', 'x2']);
});

// ======================================================================= trend

test('trend: monthly spending with coverage; uncovered empty months are unknown (null)', () => {
  const ds = build([spend('2026-01', 5000), spend('2026-02', 7000, 'Pets'), spend('2026-03', 9000)], { start: '2026-01-01', end: '2026-02-28' });
  const rows = effective(ds);
  const all = C.trend(rows, ds, { months: ['2025-12', '2026-01', '2026-02', '2026-03'] });
  assert.deepEqual(all.map(r => [r.month, r.spendCents, r.coverage.status]), [
    ['2025-12', null, 'none'], ['2026-01', 5000, 'full'], ['2026-02', 7000, 'full'], ['2026-03', 9000, 'none']
  ]);
  const groceries = C.trend(rows, ds, { category: 'Groceries', months: ['2026-01', '2026-02'] });
  assert.deepEqual(groceries.map(r => r.spendCents), [5000, 0]);
  assert.equal(C.trend(rows, ds).length, L.months(ds).length);
});

// ======================================================================= planningBaseline

test('planningBaseline: averages over full months up to and including endMonth', () => {
  const { ds, rows } = dentalScenario();
  const pb = C.planningBaseline(rows, ds, { endMonth: '2026-08', window: 3 });
  assert.deepEqual(pb.Dental, { actualAvgCents: 67757, adjustedAvgCents: 1500, excludedCents: 198770, usableCount: 3, months: ['2026-06', '2026-07', '2026-08'] });
  const sep = C.planningBaseline(rows, ds, { endMonth: '2026-09', window: 2 });
  assert.equal(sep.Dental.actualAvgCents, 101635); // (1,987.70 + 45) / 2
  assert.equal(sep.Dental.adjustedAvgCents, 2250);
});

test('planningBaseline: skips partial months and defaults endMonth to the latest complete month', () => {
  const ds = build([spend('2026-06', 3000), spend('2026-07', 6000), spend('2026-08', 9000)], { overrides: { '2026-07': { status: 'partial' } }, end: '2026-08-31' });
  const pb = C.planningBaseline(effective(ds), ds, { window: 3 });
  assert.deepEqual(pb.Groceries.months, ['2026-06', '2026-08']);
  assert.equal(pb.Groceries.actualAvgCents, 6000);
  assert.equal(pb.Groceries.usableCount, 2);
  const empty = build([], { start: '2026-01-05', end: '2026-01-20' });
  assert.deepEqual(C.planningBaseline([], empty, { window: 3 }), {});
});

// ======================================================================= planVsActual

const PLAN = {
  targets: { Groceries: 30000, 'Dining & takeout': null },
  bills: [
    { id: 'b-mort', label: 'Mortgage', category: 'Mortgage', monthlyCents: 141256, fundedFrom: 'joint', status: 'existing' },
    { id: 'b-net', label: 'Internet', category: 'Internet & phone', monthlyCents: 7500, fundedFrom: 'joint', status: 'existing' },
    { id: 'b-cell', label: 'Wireless', category: 'Internet & phone', monthlyCents: 9240, fundedFrom: 'joint', status: 'existing' },
    { id: 'b-car', label: 'Car payment', category: 'Auto insurance', monthlyCents: 24500, fundedFrom: 'p1', status: 'existing' },
    { id: 'b-life', label: 'Life insurance', category: 'Life insurance', monthlyCents: 4000, fundedFrom: 'joint', status: 'planned' },
    { id: 'b-ended', label: 'Old phone plan', category: 'Electronics', monthlyCents: 3000, fundedFrom: 'joint', status: 'existing', endMonth: '2026-05' }
  ],
  settings: { comparisonWindow: 3 }
};

function planScenario(buildOpts) {
  const txns = [];
  for (const m of ['2026-06', '2026-07', '2026-08']) {
    txns.push(spend(m, 26000), spend(m, 141256, 'Mortgage', { accountId: 'chk' }), spend(m, 16740, 'Internet & phone', { accountId: 'chk' }));
  }
  txns.push(
    spend('2026-09', 41200),
    spend('2026-09', 141256, 'Mortgage', { accountId: 'chk' }),
    spend('2026-09', 7500, 'Internet & phone', { accountId: 'chk' }),
    spend('2026-09', 9240, 'Internet & phone', { accountId: 'chk', day: 22 }),
    spend('2026-09', 5000, 'Dining & takeout'),
    spend('2026-09', 3000, 'Pets'),
    spend('2026-09', 80000, 'Hobbies', { accountId: 'sam-chk' }) // personal spending: not part of joint plan
  );
  const ds = build(txns, buildOpts);
  return { ds, rows: effective(ds) };
}

test('planVsActual: targets and joint bills vs actual, with usual and adjusted usual', () => {
  const { ds, rows } = planScenario();
  const out = C.planVsActual(PLAN, rows, ds, { month: '2026-09' });
  const by = name => out.find(r => r.category === name);
  const g = by('Groceries');
  assert.deepEqual([g.kind, g.label, g.plannedCents, g.actualCents, g.usualCents, g.adjustedUsualCents, g.diffToPlanCents, g.status],
    ['target', 'Groceries', 30000, 41200, 26000, 26000, 11200, 'over']);
  const m = by('Mortgage');
  assert.deepEqual([m.kind, m.label, m.plannedCents, m.actualCents, m.status], ['bill', 'Mortgage', 141256, 141256, 'on_plan']);
  const net = by('Internet & phone');
  assert.deepEqual([net.kind, net.label, net.plannedCents, net.actualCents, net.status], ['bill', 'Internet + Wireless', 16740, 16740, 'on_plan']);
  assert.equal(net.sources.length, 2);
});

test('planVsActual: unknown targets and unplanned spending are no_plan', () => {
  const { ds, rows } = planScenario();
  const out = C.planVsActual(PLAN, rows, ds, { month: '2026-09' });
  const dining = out.find(r => r.category === 'Dining & takeout');
  assert.deepEqual([dining.plannedCents, dining.actualCents, dining.diffToPlanCents, dining.status], [null, 5000, null, 'no_plan']);
  const pets = out.find(r => r.category === 'Pets');
  assert.deepEqual([pets.plannedCents, pets.actualCents, pets.usualCents, pets.status, pets.sources], [null, 3000, 0, 'no_plan', []]);
  assert.equal(out[out.length - 1].category, 'Pets'); // unplanned rows come after planned ones
});

test('planVsActual: personal-funded, planned-only and ended bills are not joint plan rows', () => {
  const { ds, rows } = planScenario();
  const out = C.planVsActual(PLAN, rows, ds, { month: '2026-09' });
  for (const name of ['Auto insurance', 'Life insurance', 'Electronics']) assert.equal(out.find(r => r.category === name), undefined, name);
  assert.equal(out.find(r => r.category === 'Hobbies'), undefined); // personal-account spending
  const all = C.planVsActual(PLAN, rows, ds, { month: '2026-09', scope: 'all' });
  assert.equal(all.find(r => r.category === 'Hobbies').status, 'no_plan');
});

test('planVsActual: under plan and a missing bill amount', () => {
  const { ds, rows } = planScenario();
  const plan = Object.assign({}, PLAN, { targets: { Groceries: 50000 }, bills: [{ id: 'b-net', label: 'Internet', category: 'Internet & phone', monthlyCents: null, fundedFrom: 'joint' }] });
  const out = C.planVsActual(plan, rows, ds, { month: '2026-09' });
  const g = out.find(r => r.category === 'Groceries');
  assert.deepEqual([g.diffToPlanCents, g.status], [-8800, 'under']);
  const net = out.find(r => r.category === 'Internet & phone');
  assert.deepEqual([net.plannedCents, net.status], [null, 'no_plan']);
});

test('planVsActual: a partial month marks every row partial_month', () => {
  const { ds, rows } = planScenario({ cardEnd: '2026-09-12' });
  const out = C.planVsActual(PLAN, rows, ds, { month: '2026-09' });
  assert.ok(out.length > 0);
  for (const r of out) assert.equal(r.status, 'partial_month');
  assert.equal(out.find(r => r.category === 'Groceries').diffToPlanCents, 11200);
});

test('planVsActual: adjusted usual follows planning exclusions; usual is null without history', () => {
  const { ds, rows } = dentalScenario();
  const out = C.planVsActual({ targets: { Dental: 5000 } }, rows, ds, { month: '2026-09', window: 3 });
  const d = out.find(r => r.category === 'Dental');
  assert.equal(d.usualCents, 67757);
  assert.equal(d.adjustedUsualCents, 1500);
  const early = build([spend('2025-01', 5000)]);
  const first = C.planVsActual({ targets: { Groceries: 4000 } }, effective(early), early, { month: '2025-01' });
  assert.equal(first[0].usualCents, null);
  assert.equal(first[0].adjustedUsualCents, null);
  assert.equal(first[0].status, 'over');
});

test('describeMonths: ranges, single months and gaps', () => {
  assert.equal(C.describeMonths(['2026-06', '2026-07', '2026-08']), 'Jun–Aug 2026');
  assert.equal(C.describeMonths(['2025-11', '2025-12', '2026-01']), 'Nov 2025–Jan 2026');
  assert.equal(C.describeMonths(['2026-08']), 'Aug 2026');
  assert.equal(C.describeMonths(['2026-06', '2026-08']), 'Jun 2026 and Aug 2026');
  assert.equal(C.describeMonths([]), 'no months');
});

// ======================================================================= hardening

test('hardening: rule values left undefined keep the defaults instead of disabling the rule', () => {
  const txns = [spend('2026-06', 26000), spend('2026-07', 26000), spend('2026-08', 26000), spend('2026-09', 37000)];
  const r = usualFor(txns, { month: '2026-09', rule: { minPct: undefined, minDiffCents: null, minMonths: undefined } });
  assert.deepEqual(r.rule, C.RULE);
  assert.equal(cat(r, 'Groceries').signal, 'higher');
});

test('hardening: a percentage just under the limit is never shown rounded up to the limit', () => {
  // $600 usual, +$149.70 is 24.95%: under 25%, so "+25%" would contradict "under 25%".
  const txns = [spend('2026-06', 60000), spend('2026-07', 60000), spend('2026-08', 60000), spend('2026-09', 74970)];
  const g = cat(usualFor(txns, { month: '2026-09' }), 'Groceries');
  assert.equal(g.signal, 'typical');
  assert.equal(g.pct, 25); // the numeric field keeps whole-percent rounding
  assert.ok(g.explanation.includes('(+24.9%) is over $100 but under 25% of usual'), g.explanation);
  // The same on the way down.
  const down = [spend('2026-06', 60000), spend('2026-07', 60000), spend('2026-08', 60000), spend('2026-09', 45030)];
  const d = cat(usualFor(down, { month: '2026-09' }), 'Groceries');
  assert.equal(d.signal, 'typical');
  assert.ok(d.explanation.includes('(−24.9%) is over $100 but under 25% of usual'), d.explanation);
});

test('hardening: seasonal explanations use the same exact percentage wording', () => {
  const txns = [
    spend('2025-12', 60000, 'Gas & heating', { accountId: 'chk' }),
    spend('2026-12', 74970, 'Gas & heating', { accountId: 'chk' })
  ];
  const g = cat(usualFor(txns, { month: '2026-12' }), 'Gas & heating');
  assert.equal(g.signal, 'seasonal_typical');
  assert.ok(g.explanation.includes('(+24.9%) is over $100 but under 25% of last year'), g.explanation);
});

test('hardening: whole percentages are unchanged when they do not touch the limit', () => {
  const txns = [spend('2026-06', 26000), spend('2026-07', 26000), spend('2026-08', 26000), spend('2026-09', 41200)];
  const g = cat(usualFor(txns, { month: '2026-09' }), 'Groceries');
  assert.ok(g.explanation.includes('(+58%) exceeds both $100 and 25%'), g.explanation);
});

test('hardening: a partly reimbursed charge counts only its unreimbursed part in comparisons and trends', () => {
  const txns = [
    spend('2026-06', 10000, 'Travel'), spend('2026-07', 10000, 'Travel'), spend('2026-08', 10000, 'Travel'),
    spend('2026-09', 50000, 'Travel', { id: 'flight', flags: ['reimbursement_candidate'], matchIds: ['payback'] }),
    { id: 'payback', accountId: 'chk', date: '2026-09-20', description: 'MOBILE DEPOSIT', amountCents: 30000, kind: 'income', subtype: 'other', category: 'Income', flags: ['reimbursement_candidate'] }
  ];
  const ds = build(txns);
  const rows = effective(ds, { flight: { reimbursement: 'confirmed', history: [] } });
  const travel = cat(C.usual(rows, ds, { month: '2026-09' }), 'Travel');
  assert.equal(travel.actualCents, 20000);
  assert.equal(C.trend(rows, ds, { months: ['2026-09'], category: 'Travel' })[0].spendCents, 20000);
  const row = C.planVsActual({ targets: { Travel: 15000 } }, rows, ds, { month: '2026-09' }).find(r => r.category === 'Travel');
  assert.deepEqual([row.actualCents, row.diffToPlanCents, row.status], [20000, 5000, 'over']);
});
