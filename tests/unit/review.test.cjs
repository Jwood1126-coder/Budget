'use strict';
// Tests for BudgetEngine.review: review queues, duplicate detection, spikes, reimbursement
// pairs and the edit-record audit trail. All data is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const L = E.ledger;
const R = E.review;

let seq = 0;
function tx(date, amountCents, fields = {}) {
  seq += 1;
  return Object.assign({
    id: 'r' + String(seq).padStart(4, '0'),
    accountId: 'card',
    date,
    description: 'SAMPLE SHOP ' + seq,
    amountCents,
    kind: 'spend',
    category: 'Groceries'
  }, fields);
}

const DEFAULT_ACCOUNTS = [
  { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] },
  { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [{ start: '2026-01-15', end: '2026-09-30' }] },
  { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] }
];

function build(transactions, accounts = DEFAULT_ACCOUNTS, extra = {}) {
  return L.normalizeDataset(Object.assign({ schemaVersion: 2, datasetId: 'review-test', isSynthetic: true, accounts, transactions }, extra));
}

const AT = n => '2026-09-' + String(n).padStart(2, '0') + 'T12:00:00.000Z';

function queueScenario() {
  const txns = [
    tx('2026-04-18', -8000, { id: 'unc1', accountId: 'chk', description: 'ZELLE PAYMENT TO J SMITH', category: 'Uncategorized' }),
    tx('2026-04-20', -3100, { id: 'low1', confidence: 'low' }),
    tx('2026-04-21', -2700, { id: 'ncr1', flags: ['needs_category_review'] }),
    tx('2026-05-06', -21000, { id: 'mix1', description: 'SAMPLE WAREHOUSE #1', category: 'Mixed retail', flags: ['mixed_retail'] }),
    tx('2026-05-20', -18000, { id: 'mix2', description: 'SAMPLE WAREHOUSE #1', category: 'Mixed retail', flags: ['mixed_retail'] }),
    tx('2026-03-14', -6418, { id: 'tg1', description: 'TARGET 00012345', merchant: 'Target' }),
    tx('2026-03-15', -6418, { id: 'tg2', description: 'TARGET 00012345', merchant: 'Target' }),
    tx('2026-06-02', -25000, { id: 'sv-out', accountId: 'chk', description: 'TRANSFER TO SAVINGS', kind: 'transfer', subtype: 'savings', category: 'Transfer', pairId: 'sv-in' }),
    tx('2026-06-02', 25000, { id: 'sv-in', accountId: 'sav', description: 'TRANSFER FROM CHECKING', kind: 'transfer', subtype: 'savings', category: 'Transfer', pairId: 'sv-out' }),
    tx('2026-06-25', -91234, { id: 'cp-chk', accountId: 'chk', description: 'SAMPLE BANK CARD AUTOPAY', kind: 'card_payment', category: 'Card payment', pairId: 'cp-card' }),
    tx('2026-06-25', 91234, { id: 'cp-card', accountId: 'card', description: 'AUTOMATIC PAYMENT - THANK YOU', kind: 'card_payment', category: 'Card payment', pairId: 'cp-chk' }),
    tx('2026-06-01', 132500, { id: 'contrib', accountId: 'chk', description: 'ONLINE TRANSFER FROM SAM PERSONAL', kind: 'transfer', subtype: 'contribution', category: 'Transfer' }),
    tx('2026-05-11', 50000, { id: 'odd-in', accountId: 'chk', description: 'ONLINE TRANSFER FROM CHK 0000', kind: 'transfer', subtype: 'internal', category: 'Transfer', flags: ['unpaired_transfer'] }),
    tx('2026-07-08', -48660, { id: 'air', description: 'SAMPLE AIRLINES', category: 'Travel', flags: ['reimbursement_candidate'], matchIds: ['dep'] }),
    tx('2026-08-21', 48660, { id: 'dep', accountId: 'chk', description: 'MOBILE DEPOSIT', kind: 'income', subtype: 'other', category: 'Income' }),
    tx('2026-07-12', -8899, { id: 'hd1', description: 'SAMPLE HARDWARE #1', category: 'Household & hardware', flags: ['business_candidate'] }),
    tx('2026-07-19', -4512, { id: 'hd2', description: 'SAMPLE HARDWARE #2', category: 'Household & hardware', flags: ['business_candidate'] }),
    tx('2026-02-10', -4500, { id: 'dent-feb', description: 'BRIGHT SMILE SAMPLE', category: 'Dental' }),
    tx('2026-08-04', -86000, { id: 'dent1', description: 'BRIGHT SMILE SAMPLE', category: 'Dental' }),
    tx('2026-08-11', -71540, { id: 'dent2', description: 'SAMPLE ENDODONTICS', category: 'Dental' }),
    tx('2026-08-25', -41230, { id: 'dent3', description: 'SAMPLE ENDODONTICS', category: 'Dental' })
  ];
  const ds = build(txns);
  let mixEdit = R.editRecord(null, 'splits', [{ category: 'Groceries', cents: 12000 }, { category: 'Household & hardware', cents: 6000 }], 'Receipt checked', AT(2));
  let hdEdit = R.editRecord(null, 'business', 'household', '', AT(5));
  const edits = { mix2: mixEdit, hd2: hdEdit };
  return { ds, edits, rows: L.applyEdits(ds, edits) };
}

// ======================================================================= queues

test('queues: counts per queue on a mixed dataset', () => {
  const { ds, edits, rows } = queueScenario();
  const q = R.queues(ds, rows, edits);
  assert.deepEqual(q.counts, {
    uncertain: 3,
    mixedRetail: 1,
    duplicates: 1,
    transfers: 1,
    transfersPaired: 2,
    transfersExpected: 1,
    reimbursements: 1,
    business: 1,
    spikes: 1,
    coverageGaps: 1,
    edited: 2,
    orphanEdits: 0
  });
});

test('queues: uncertain lists low confidence, review-flagged and uncategorized spending', () => {
  const { ds, edits, rows } = queueScenario();
  const q = R.queues(ds, rows, edits);
  assert.deepEqual(q.uncertain.map(t => t.id).sort(), ['low1', 'ncr1', 'unc1']);
  // A category decision resolves the item.
  const decided = Object.assign({}, edits, { unc1: R.editRecord(null, 'category', 'Gifts & donations', 'Birthday gift', AT(9)) });
  const q2 = R.queues(ds, L.applyEdits(ds, decided), decided);
  assert.deepEqual(q2.uncertain.map(t => t.id).sort(), ['low1', 'ncr1']);
});

test('queues: mixed retail lists unsplit, uncategorized-by-user rows only', () => {
  const { ds, edits, rows } = queueScenario();
  assert.deepEqual(R.queues(ds, rows, edits).mixedRetail.map(t => t.id), ['mix1']);
});

test('queues: transfers are paired once; contributions from outside are expected', () => {
  const { ds, edits, rows } = queueScenario();
  const { paired, unpaired } = R.queues(ds, rows, edits).transfers;
  assert.deepEqual(paired.map(p => p.ids), [['sv-out', 'sv-in'], ['cp-chk', 'cp-card']]);
  assert.ok(paired.every(p => p.amountsMatch));
  assert.equal(paired[0].cents, 25000);
  const contrib = unpaired.find(t => t.id === 'contrib');
  assert.equal(contrib.expected, true);
  assert.match(contrib.reason, /personal account/);
  const odd = unpaired.find(t => t.id === 'odd-in');
  assert.equal(odd.expected, false);
  assert.match(odd.reason, /No matching opposite transfer found/);
});

test('queues: reimbursements pair the charge with its deposit and default to pending', () => {
  const { ds, edits, rows } = queueScenario();
  const [r] = R.queues(ds, rows, edits).reimbursements;
  assert.deepEqual([r.chargeId, r.depositId, r.cents, r.status], ['air', 'dep', 48660, 'pending']);
  assert.equal(r.charge.id, 'air');
  assert.equal(r.deposit.id, 'dep');
});

test('queues: business candidates carry their status', () => {
  const { ds, edits, rows } = queueScenario();
  const q = R.queues(ds, rows, edits);
  assert.deepEqual(q.business.map(t => [t.id, t.businessStatus]), [['hd1', 'pending'], ['hd2', 'household']]);
});

test('queues: coverage gaps name the accounts that are missing days', () => {
  const { ds, edits, rows } = queueScenario();
  const [gap] = R.queues(ds, rows, edits).coverageGaps;
  assert.equal(gap.month, '2026-01');
  assert.equal(gap.status, 'partial');
  assert.equal(gap.coveredDays, 17);
  assert.deepEqual(gap.missing, [{ accountId: 'card', label: 'Joint card', coveredDays: 17, totalDays: 31, missingDays: 14 }]);
});

test('queues: edited rows include their history, newest edit first', () => {
  const { ds, edits, rows } = queueScenario();
  const q = R.queues(ds, rows, edits);
  assert.deepEqual(q.edited.map(t => t.id), ['hd2', 'mix2']);
  assert.equal(q.edited[1].history.length, 1);
  assert.equal(q.edited[1].history[0].field, 'splits');
  assert.equal(q.edited[1].history[0].reason, 'Receipt checked');
});

test('queues: edits for transactions no longer in the data are reported, not dropped', () => {
  const { ds, edits, rows } = queueScenario();
  const withOrphan = Object.assign({}, edits, { 'gone-123': R.editRecord(null, 'note', 'From an older import', '', AT(1)) });
  const q = R.queues(ds, rows, withOrphan);
  assert.deepEqual(q.orphanEdits.map(o => o.id), ['gone-123']);
  assert.equal(q.counts.orphanEdits, 1);
});

test('queues: without ledgerEdits the edits carried on effective rows are used', () => {
  const { ds, rows } = queueScenario();
  const q = R.queues(ds, rows);
  assert.equal(q.counts.edited, 2);
  assert.equal(q.counts.mixedRetail, 1);
  assert.equal(q.counts.orphanEdits, 0);
  assert.equal(q.edited.find(t => t.id === 'mix2').history[0].field, 'splits');
});

test('queues: decisions clear duplicates, reimbursements and business items', () => {
  const { ds, edits } = queueScenario();
  let next = Object.assign({}, edits);
  next.tg2 = R.editRecord(null, 'duplicate', 'exclude', 'Posted twice', AT(10));
  next.air = R.editRecord(null, 'reimbursement', 'confirmed', 'Employer repaid', AT(11));
  next.hd1 = R.editRecord(null, 'business', 'business', 'Side project', AT(12));
  const rows = L.applyEdits(ds, next);
  const q = R.queues(ds, rows, next);
  assert.equal(q.counts.duplicates, 0);
  assert.equal(q.counts.reimbursements, 0);
  assert.equal(q.reimbursements[0].status, 'confirmed');
  assert.equal(q.counts.business, 0);
  assert.equal(q.counts.edited, 5);
  assert.ok(!q.uncertain.concat(q.mixedRetail).some(t => t.id === 'tg2'));
});

// ======================================================================= duplicates

function dupRows(pairs, accounts) {
  return L.applyEdits(build(pairs, accounts), {});
}

test('duplicateCandidates: identical rows one day apart are a high-confidence candidate', () => {
  const rows = dupRows([tx('2026-03-14', -6418, { id: 'a', description: 'TARGET 00012345' }), tx('2026-03-15', -6418, { id: 'b', description: 'TARGET 00012345' })]);
  const [d] = R.duplicateCandidates(rows);
  assert.deepEqual(d.ids, ['a', 'b']);
  assert.equal(d.confidence, 'high');
  assert.equal(d.daysApart, 1);
  assert.equal(d.reason, 'Same account and amount ($64.18), 1 day apart, identical descriptions.');
});

test('duplicateCandidates: similar descriptions within 3 days are candidates', () => {
  const rows = dupRows([
    tx('2026-03-01', -2599, { id: 'a', description: 'SAMPLE BOOKS ONLINE ORDER 1234', merchant: 'Sample Books A' }),
    tx('2026-03-04', -2599, { id: 'b', description: 'SAMPLE BOOKS ONLINE ORDER 9876', merchant: 'Sample Books B' })
  ]);
  const [d] = R.duplicateCandidates(rows);
  assert.deepEqual(d.ids, ['a', 'b']);
  assert.equal(d.confidence, 'medium'); // 4 of 5 tokens shared = 0.8
  assert.match(d.reason, /3 days apart, similar descriptions/);
});

test('duplicateCandidates: the same merchant counts even when descriptions differ', () => {
  const rows = dupRows([
    tx('2026-03-01', -1500, { id: 'a', description: 'SQ *CORNER CAFE 01', merchant: 'Corner Cafe' }),
    tx('2026-03-01', -1500, { id: 'b', description: 'CORNERCAFE MOBILE PAY', merchant: 'Corner Cafe' })
  ]);
  const [d] = R.duplicateCandidates(rows);
  assert.equal(d.confidence, 'low');
  assert.match(d.reason, /on the same day, the same merchant/);
});

test('duplicateCandidates: different account, amount, distance or text are not candidates', () => {
  const base = { description: 'TARGET 00012345', merchant: 'Target' };
  const cases = [
    [tx('2026-03-01', -6418, Object.assign({}, base)), tx('2026-03-02', -6418, Object.assign({}, base, { accountId: 'chk' }))],
    [tx('2026-03-01', -6418, Object.assign({}, base)), tx('2026-03-02', -6419, Object.assign({}, base))],
    [tx('2026-03-01', -6418, Object.assign({}, base)), tx('2026-03-05', -6418, Object.assign({}, base))],
    [tx('2026-03-01', -6418, { description: 'SAMPLE GROCER 12', merchant: 'Sample Grocer' }), tx('2026-03-02', -6418, { description: 'SAMPLE PHARMACY 7', merchant: 'Sample Pharmacy' })]
  ];
  for (const pair of cases) assert.deepEqual(R.duplicateCandidates(dupRows(pair)), []);
});

test('duplicateCandidates: pairs already decided are left out', () => {
  const ds = build([tx('2026-03-14', -6418, { id: 'a', description: 'TARGET 00012345' }), tx('2026-03-15', -6418, { id: 'b', description: 'TARGET 00012345' })]);
  for (const decision of ['keep', 'exclude']) {
    const edits = { b: R.editRecord(null, 'duplicate', decision, '', AT(1)) };
    assert.deepEqual(R.duplicateCandidates(L.applyEdits(ds, edits), edits), []);
    assert.deepEqual(R.duplicateCandidates(L.applyEdits(ds, edits)), [], 'reads decisions from effective rows too');
  }
});

test('duplicateCandidates: three copies produce every pair within the window', () => {
  const rows = dupRows(['2026-03-01', '2026-03-02', '2026-03-03'].map((d, i) => tx(d, -999, { id: 'c' + i, description: 'SAMPLE STREAMING' })));
  assert.deepEqual(R.duplicateCandidates(rows).map(d => d.ids.join('+')).sort(), ['c0+c1', 'c0+c2', 'c1+c2']);
});

test('similarity: token overlap relative to the longer description', () => {
  assert.equal(R.similarity('TARGET 00012345', 'target 00012345'), 1);
  assert.equal(R.similarity('A B C', 'A B D'), 2 / 3);
  assert.equal(R.similarity('', 'A'), 0);
});

// ======================================================================= spikes

function spikeDataset(rows, extra) {
  return build(rows, DEFAULT_ACCOUNTS, extra);
}

test('spikes: a category month well above its trailing average is listed with its ids', () => {
  const { ds, rows } = queueScenario();
  const [s] = R.spikes(rows, ds);
  assert.equal(s.month, '2026-08');
  assert.equal(s.category, 'Dental');
  assert.equal(s.totalCents, 198770);
  assert.equal(s.usualCents, 750); // $45 over Feb–Jul (6 full months)
  assert.deepEqual(s.ids, ['dent1', 'dent2', 'dent3']);
  assert.deepEqual(s.priorMonths, ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
});

test('spikes: needs at least two prior full months', () => {
  // Card coverage starts Jan 15, so Feb has no full prior month and March has only February.
  const ds = spikeDataset([tx('2026-02-10', -90000, { category: 'Travel' }), tx('2026-03-10', -90000, { category: 'Electronics' }), tx('2026-04-10', -90000, { category: 'Hobbies' })]);
  const out = R.spikes(L.applyEdits(ds, {}), ds);
  assert.deepEqual(out.map(s => s.month), ['2026-04']);
});

test('spikes: both the minimum amount and the multiple must be reached', () => {
  const rows = [];
  for (const m of ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) rows.push(tx(m + '-05', -20000, { category: 'Groceries' }));
  rows.push(tx('2026-08-05', -59999, { category: 'Groceries' })); // under 3x $200
  rows.push(tx('2026-08-06', -45000, { category: 'Pets' })); // over 3x $0 but under $500
  const ds = spikeDataset(rows);
  assert.deepEqual(R.spikes(L.applyEdits(ds, {}), ds), []);
  const ds2 = spikeDataset(rows.concat([tx('2026-08-07', -1, { category: 'Groceries' })]));
  const [s] = R.spikes(L.applyEdits(ds2, {}), ds2);
  assert.deepEqual([s.category, s.totalCents, s.usualCents], ['Groceries', 60000, 20000]);
});

test('spikes: options change the minimum, multiple and window', () => {
  const ds = spikeDataset([tx('2026-04-10', -3000, { category: 'Pets' }), tx('2026-06-10', -9000, { category: 'Pets' })]);
  const rows = L.applyEdits(ds, {});
  assert.deepEqual(R.spikes(rows, ds), []);
  const out = R.spikes(rows, ds, { minCents: 5000, multiple: 2, window: 3 });
  assert.deepEqual(out.map(s => [s.month, s.category, s.usualCents]), [['2026-06', 'Pets', 1000]]);
});

test('spikes: excluded rows do not count and planning-excluded amounts are reported', () => {
  const { ds } = queueScenario();
  const edits = {
    dent3: R.editRecord(null, 'duplicate', 'exclude', 'test', AT(1)),
    dent1: R.editRecord(null, 'planningBaseline', 'exclude', 'One-off episode', AT(2))
  };
  const [s] = R.spikes(L.applyEdits(ds, edits), ds);
  assert.equal(s.totalCents, 157540);
  assert.equal(s.planningExcludedCents, 86000);
  assert.deepEqual(s.ids, ['dent1', 'dent2']);
});

// ======================================================================= annual bills are not spikes

const TWO_YEARS = [
  { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2025-01-01', end: '2026-09-30' }] },
  { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: [{ start: '2025-01-01', end: '2026-09-30' }] }
];

/** Groceries every month plus `rows`, over Jan 2025 – Sep 2026. */
function yearsDataset(rows, extra) {
  const base = E.months.range('2025-01', '2026-09').map(m => tx(m + '-03', -30000, { category: 'Groceries' }));
  return build(base.concat(rows), TWO_YEARS, extra);
}
const insurance = (date, cents = -110400) => tx(date, cents, { accountId: 'chk', description: 'SAMPLE MUTUAL HOME POLICY', category: 'Home insurance' });

test('spikes: a bill paid once a year is not a spike, in either year', () => {
  const ds = yearsDataset([insurance('2025-03-20'), insurance('2026-03-20')]);
  const rows = L.applyEdits(ds, {});
  assert.deepEqual(R.spikes(rows, ds).filter(s => s.category === 'Home insurance'), []);
  // On request they are returned, marked annual, with the matching payment.
  const all = R.spikes(rows, ds, { includeAnnual: true }).filter(s => s.category === 'Home insurance');
  assert.deepEqual(all.map(s => [s.month, s.annual, s.annualMatch]), [
    ['2026-03', true, { month: '2025-03', cents: 110400 }],
    ['2025-03', true, { month: '2026-03', cents: 110400 }]
  ]);
});

test('spikes: a payment 11 or 13 months earlier also marks an annual bill; 10 months does not', () => {
  for (const [earlier, annual] of [['2025-02-20', true], ['2025-04-20', true], ['2025-05-20', false]]) {
    const ds = yearsDataset([insurance(earlier), insurance('2026-03-20')]);
    const s = R.spikes(L.applyEdits(ds, {}), ds, { includeAnnual: true }).find(x => x.month === '2026-03');
    assert.equal(s.annual, annual, earlier);
    assert.equal(R.spikes(L.applyEdits(ds, {}), ds).some(x => x.month === '2026-03'), !annual, earlier);
  }
});

test('spikes: the year-apart payment must be at least half of this month', () => {
  const half = yearsDataset([insurance('2025-03-20', -55200), insurance('2026-03-20')]);
  assert.ok(!R.spikes(L.applyEdits(half, {}), half).some(s => s.month === '2026-03'));
  const small = yearsDataset([insurance('2025-03-20', -55199), insurance('2026-03-20')]);
  const [s] = R.spikes(L.applyEdits(small, {}), small).filter(x => x.month === '2026-03');
  assert.equal(s.category, 'Home insurance');
  assert.equal(s.annual, false);
  assert.equal(s.annualMatch, null);
});

test('spikes: a year-apart payment in a month that is not fully covered does not count', () => {
  const ds = yearsDataset([insurance('2025-03-20'), insurance('2026-03-20')], { coverageOverrides: { '2025-03': { status: 'partial', note: 'Statement missing' } } });
  const out = R.spikes(L.applyEdits(ds, {}), ds);
  assert.deepEqual(out.filter(s => s.category === 'Home insurance').map(s => s.month), ['2026-03']);
});

test('spikes: on the sample data, annual home insurance is not a spike but the August 2026 dental episode is', () => {
  const ds = L.normalizeDataset(require('../../fixtures/sample-data.json'));
  const rows = L.applyEdits(ds, {});
  const out = R.spikes(rows, ds);
  assert.ok(!out.some(s => s.category === 'Home insurance'), JSON.stringify(out.map(s => s.month + ' ' + s.category)));
  const dental = out.find(s => s.category === 'Dental');
  assert.equal(dental.month, '2026-08');
  assert.equal(dental.annual, false);
  const q = R.queues(ds, rows, {});
  assert.equal(q.counts.spikes, out.length);
  assert.ok(!q.spikes.some(s => s.category === 'Home insurance'));
  assert.deepEqual(q.annualSpikes.map(s => s.month + ' ' + s.category), ['2026-03 Home insurance', '2025-03 Home insurance']);
});

// ======================================================================= reimbursement pairs

test('reimbursementPairs: links work from either side and carry the edited status', () => {
  const ds = build([
    tx('2026-07-08', -48660, { id: 'air', category: 'Travel', flags: ['reimbursement_candidate'] }),
    tx('2026-08-21', 48660, { id: 'dep', accountId: 'chk', kind: 'income', subtype: 'other', matchIds: ['air'] })
  ]);
  const edits = { dep: R.editRecord(null, 'reimbursement', 'not_reimbursed', 'It was a gift', AT(3)) };
  const pairs = R.reimbursementPairs(L.applyEdits(ds, edits));
  assert.deepEqual(pairs.map(p => [p.chargeId, p.depositId, p.cents, p.status]), [['air', 'dep', 48660, 'not_reimbursed']]);
});

test('reimbursementPairs: a flagged charge without a deposit and a flagged lone deposit', () => {
  const ds = build([
    tx('2026-07-08', -30000, { id: 'conf', category: 'Travel', flags: ['reimbursement_candidate'] }),
    tx('2026-08-21', 12000, { id: 'lone', accountId: 'chk', kind: 'income', subtype: 'other', flags: ['reimbursement_candidate'] })
  ]);
  const pairs = R.reimbursementPairs(L.applyEdits(ds, {}));
  assert.deepEqual(pairs.map(p => [p.chargeId, p.depositId, p.cents, p.status]), [['conf', null, 30000, 'pending'], [null, 'lone', 12000, 'pending']]);
});

test('reimbursementPairs: linked rows nobody flagged or decided are not listed', () => {
  const ds = build([
    tx('2026-07-08', -30000, { id: 'c', matchIds: ['d'] }),
    tx('2026-07-20', 30000, { id: 'd', accountId: 'chk', kind: 'income', subtype: 'other' })
  ]);
  assert.deepEqual(R.reimbursementPairs(L.applyEdits(ds, {})), []);
});

// ======================================================================= transfer expectations

test('transfers: the other side is expected to be missing when its account is not in the data', () => {
  const accounts = [{ id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: [{ start: '2026-01-01', end: '2026-09-30' }] }];
  const ds = build([
    tx('2026-06-02', -25000, { id: 'sv', accountId: 'chk', kind: 'transfer', subtype: 'savings' }),
    tx('2026-06-25', -50000, { id: 'cp', accountId: 'chk', kind: 'card_payment' })
  ], accounts);
  const { unpaired } = R.queues(ds, L.applyEdits(ds, {}), {}).transfers;
  assert.deepEqual(unpaired.map(t => [t.id, t.expected]), [['sv', true], ['cp', true]]);
  assert.match(unpaired[0].reason, /No savings account is in the data/);
  assert.match(unpaired[1].reason, /No credit card account is in the data/);
});

test('transfers: the other side is expected when its export does not cover the date', () => {
  const ds = build([tx('2026-01-05', -50000, { id: 'cp', accountId: 'chk', kind: 'card_payment' })]);
  const [u] = R.queues(ds, L.applyEdits(ds, {}), {}).transfers.unpaired;
  assert.equal(u.expected, true);
  assert.match(u.reason, /credit card account export does not cover Jan 5, 2026/);
});

test('transfers: a pairId pointing outside the data is unpaired and not expected', () => {
  const ds = build([tx('2026-06-02', -25000, { id: 'sv', accountId: 'chk', kind: 'transfer', subtype: 'savings', pairId: 'missing' })]);
  const [u] = R.queues(ds, L.applyEdits(ds, {}), {}).transfers.unpaired;
  assert.equal(u.expected, false);
  assert.match(u.reason, /\(missing\) is not in the data/);
});

// ======================================================================= editRecord

test('editRecord: appends history and returns a new object', () => {
  const prev = Object.freeze({ history: Object.freeze([]) });
  const e1 = R.editRecord(prev, 'category', 'Pets', 'Pet food, not groceries', AT(1));
  assert.notEqual(e1, prev);
  assert.deepEqual(e1, {
    category: 'Pets',
    categoryReason: 'Pet food, not groceries',
    history: [{ at: AT(1), field: 'category', from: null, to: 'Pets', reason: 'Pet food, not groceries' }]
  });
  const e2 = R.editRecord(e1, 'category', 'Household & hardware', 'Litter and bowls', AT(2));
  assert.equal(e2.history.length, 2);
  assert.deepEqual(e2.history[1], { at: AT(2), field: 'category', from: 'Pets', to: 'Household & hardware', reason: 'Litter and bowls' });
  assert.equal(e1.history.length, 1, 'previous edit untouched');
});

test('editRecord: category, kind and splits require a reason', () => {
  for (const [field, value] of [['category', 'Pets'], ['kind', 'transfer'], ['splits', [{ category: 'Pets', cents: 100 }]]]) {
    for (const reason of ['', '   ', undefined, null]) {
      assert.throws(() => R.editRecord(null, field, value, reason, AT(1)), E.ValidationError, field + ' / ' + JSON.stringify(reason));
    }
  }
  assert.throws(() => R.editRecord(null, 'category', null, '', AT(1)), E.ValidationError, 'clearing also needs a reason');
});

test('editRecord: other fields need no reason', () => {
  const e = R.editRecord(undefined, 'duplicate', 'keep', undefined, AT(1));
  assert.equal(e.duplicate, 'keep');
  assert.equal(e.history[0].reason, '');
  const n = R.editRecord(e, 'note', 'Checked with Alex', '', AT(2));
  assert.equal(n.note, 'Checked with Alex');
});

test('editRecord: null or undefined removes the field and still logs it', () => {
  const e1 = R.editRecord(null, 'kind', 'transfer', 'Moved to savings', AT(1));
  assert.equal(e1.kindReason, 'Moved to savings');
  const e2 = R.editRecord(e1, 'kind', null, 'Back to the imported kind', AT(2));
  assert.equal('kind' in e2, false);
  assert.equal('kindReason' in e2, false);
  assert.deepEqual(e2.history[1], { at: AT(2), field: 'kind', from: 'transfer', to: null, reason: 'Back to the imported kind' });
  const e3 = R.editRecord(R.editRecord(null, 'planningBaseline', 'exclude', '', AT(3)), 'planningBaseline', undefined, '', AT(4));
  assert.equal('planningBaseline' in e3, false);
  assert.equal(e3.history.length, 2);
});

test('editRecord: values are validated', () => {
  assert.throws(() => R.editRecord(null, 'kind', 'gift', 'why', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'reimbursement', 'yes', '', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'business', 'maybe', '', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'duplicate', 'remove', '', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'planningBaseline', 'skip', '', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'splits', [{ category: 'Pets', cents: 1.5 }], 'why', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'splits', [{ category: ' ', cents: 100 }], 'why', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'splits', [], 'why', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'category', '   ', 'why', AT(1)), E.ValidationError);
  assert.throws(() => R.editRecord(null, 'amountCents', 5, 'why', AT(1)), E.ValidationError);
});

test('editRecord: splits are stored as clean copies', () => {
  const parts = [{ category: ' Groceries ', cents: 12000, extra: true }, { category: 'Pets', cents: 6000 }];
  const e = R.editRecord(null, 'splits', parts, 'Receipt', AT(1));
  assert.deepEqual(e.splits, [{ category: 'Groceries', cents: 12000 }, { category: 'Pets', cents: 6000 }]);
  parts[1].cents = 1;
  assert.equal(e.splits[1].cents, 6000);
  assert.equal(e.history[0].to[1].cents, 6000);
});

test('editRecord: the timestamp is supplied by the caller (null when missing)', () => {
  assert.equal(R.editRecord(null, 'note', 'x', '', undefined).history[0].at, null);
});

test('editRecord output is understood by applyEdits', () => {
  const ds = build([tx('2026-05-06', -21000, { id: 'w', category: 'Mixed retail' })]);
  let edit = R.editRecord(null, 'splits', [{ category: 'Groceries', cents: 15000 }, { category: 'Pets', cents: 6000 }], 'Receipt', AT(1));
  edit = R.editRecord(edit, 'planningBaseline', 'exclude', '', AT(2));
  const [t] = L.applyEdits(ds, { w: edit });
  assert.equal(t.edited, true);
  assert.equal(t.planningExcluded, true);
  assert.deepEqual(t.parts.map(p => p.category), ['Groceries', 'Pets']);
});

// ======================================================================= hardening

test('hardening: business items carry a status field (default pending) that consumers read', () => {
  const { ds, edits, rows } = queueScenario();
  const q = R.queues(ds, rows, edits);
  assert.deepEqual(q.business.map(t => [t.id, t.status]), [['hd1', 'pending'], ['hd2', 'household']]);
  // Items are copies: the effective rows passed in are not modified.
  assert.equal(rows.find(t => t.id === 'hd1').status, undefined);
  assert.equal(q.counts.business, 1);
});

test('hardening: a decided business item no longer shows as pending on the Overview list', () => {
  if (!E.attention) return; // attention.js is optional for this group
  const ds = build([tx('2026-03-10', -8899, { id: 'hw', flags: ['business_candidate'] })]);
  const edits = { hw: R.editRecord(null, 'business', 'household', '', AT(1)) };
  const items = E.attention.list({ dataset: ds, txns: L.applyEdits(ds, edits), state: { ledgerEdits: edits, ui: {}, scenarios: [] } });
  assert.ok(!items.some(i => i.id === 'business'), items.map(i => i.title).join('; '));
});

function reimbursedTransferDataset() {
  return build([
    tx('2026-03-01', -40000, { id: 'concert', description: 'SAMPLE TICKETS', category: 'Entertainment', flags: ['reimbursement_candidate'], matchIds: ['payback'] }),
    tx('2026-03-09', 40000, { id: 'payback', accountId: 'chk', description: 'ONLINE TRANSFER FROM 0000', kind: 'transfer', subtype: 'internal', category: 'Transfer', flags: ['reimbursement_candidate', 'unpaired_transfer'], matchIds: ['concert'] })
  ]);
}

test('hardening: a transfer confirmed as a reimbursement is no longer an unexplained transfer', () => {
  const ds = reimbursedTransferDataset();
  const pending = R.queues(ds, L.applyEdits(ds, {}), {});
  assert.equal(pending.counts.transfers, 1);
  const edits = { concert: R.editRecord(null, 'reimbursement', 'confirmed', '', AT(1)) };
  const q = R.queues(ds, L.applyEdits(ds, edits), edits);
  const [u] = q.transfers.unpaired;
  assert.equal(u.id, 'payback');
  assert.equal(u.expected, true);
  assert.match(u.reason, /reimbursement/);
  assert.equal(q.counts.transfers, 0);
  // A "not reimbursed" decision leaves the transfer question open.
  const no = { concert: R.editRecord(null, 'reimbursement', 'not_reimbursed', '', AT(1)) };
  assert.equal(R.queues(ds, L.applyEdits(ds, no), no).counts.transfers, 1);
});

test('hardening: spike options left undefined fall back to the defaults', () => {
  const { ds, rows } = queueScenario();
  const expected = R.spikes(rows, ds).map(s => s.month + s.category);
  assert.ok(expected.length > 0);
  assert.deepEqual(R.spikes(rows, ds, { minCents: undefined, multiple: undefined, window: undefined }).map(s => s.month + s.category), expected);
  assert.deepEqual(R.queues(ds, rows, {}, { spikes: { window: undefined } }).spikes.map(s => s.month + s.category), expected);
});

test('hardening: duplicate candidates have one order whatever order the sort sees them in', () => {
  const rows = dupRows(['2026-03-01', '2026-03-02', '2026-03-02', '2026-03-03'].map((d, i) =>
    tx(d, -500, { id: 'abcd'[i], description: 'SAMPLE CAFE', merchant: 'Sample Cafe' })));
  const expected = ['b+c', 'b+d', 'c+d', 'a+b', 'a+c', 'a+d']; // newest first, then by ids
  assert.deepEqual(R.duplicateCandidates(rows).map(d => d.ids.join('+')), expected);
  // Engines differ in how they order items a comparator cannot tell apart. Emulate that by
  // handing every sort its input reversed: a total order gives the same result.
  const original = Array.prototype.sort;
  Array.prototype.sort = function (cmp) {
    const copy = Array.from(this).reverse();
    original.call(copy, cmp);
    for (let i = 0; i < copy.length; i++) this[i] = copy[i];
    return this;
  };
  let reversed;
  try { reversed = R.duplicateCandidates(rows).map(d => d.ids.join('+')); } finally { Array.prototype.sort = original; }
  assert.deepEqual(reversed, expected);
});

test('queues: a confirmed reimbursement deposit leaves the uncertain queue', () => {
  const ds = E.ledger.normalizeDataset(require('../../fixtures/sample-data.json'));
  const deposit = ds.transactions.find(t => t.description === 'MOBILE DEPOSIT');
  const charge = ds.transactions.find(t => (t.matchIds || []).includes(deposit.id) || (deposit.matchIds || []).includes(t.id));
  assert.ok(deposit && charge, 'sample has the reimbursement pair');
  const before = E.review.queues(ds, E.ledger.applyEdits(ds, {}), {});
  assert.ok(before.uncertain.some(t => t.id === deposit.id), 'unknown deposit starts as uncertain');
  const edits = { [charge.id]: E.review.editRecord(null, 'reimbursement', 'confirmed', 'Employer paid it back', '2026-10-01T00:00:00Z') };
  const after = E.review.queues(ds, E.ledger.applyEdits(ds, edits), edits);
  assert.ok(!after.uncertain.some(t => t.id === deposit.id), 'answered by the reimbursement decision');
});
