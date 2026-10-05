'use strict';
// Unit tests for tools/plan-report.cjs: the fictional sample and small invented files in a temp
// folder. Never the private/ folder.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../helpers/ledger.cjs');
const R = require('../../tools/plan-report.cjs');

const E = H.E;
const ROOT = path.resolve(__dirname, '..', '..');
const TODAY = '2026-07-08';
let tmp;

/** Run main and capture what it prints. */
function run(argv) {
  const out = [], err = [];
  const code = R.main(argv, { log: s => out.push(s), error: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** An invented household: six full months on joint checking, savings and a card, with balances. */
function inventedData() {
  const row = H.rowMaker({ prefix: 'pr', description: n => 'PR ROW ' + n });
  const txns = [];
  for (const m of E.months.range('2026-01', '2026-06')) {
    const d = day => `${m}-${String(day).padStart(2, '0')}`;
    txns.push(row('chk', d(1), 500000, { kind: 'income', subtype: 'payroll', category: 'Income', merchant: 'Quillmoor Works', personId: 'p1' }));
    txns.push(row('chk', d(3), -180000, { category: 'Mortgage', merchant: 'Brightwater Lending' }));
    txns.push(row('card', d(10), -70000, { category: 'Groceries', merchant: 'Harbor Grocer' }));
    txns.push(row('card', d(14), -25000, { category: 'Dining & takeout', merchant: 'Pine Cafe' }));
    txns.push(...H.pair(row('chk', d(20), -40000, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings' }),
      row('sav', d(20), 40000, { kind: 'transfer', subtype: 'savings', category: 'Transfer', merchant: 'Savings' })));
  }
  return H.rawDataset({
    datasetId: 'report-test', accounts: H.jointAccounts({ coverage: [{ start: '2026-01-01', end: '2026-06-30' }], cardExtra: { paidInFull: true } })
      .concat([{ id: 'ira', label: 'Retirement', type: 'investment', scope: 'personal', ownerId: 'p2', coverage: [] }]),
    transactions: txns,
    balances: [{ accountId: 'chk', date: '2026-06-30', cents: 300000, source: 'statement' }, { accountId: 'sav', date: '2026-06-30', cents: 900000, source: 'statement' },
      { accountId: 'ira', date: '2026-06-30', cents: 1500000, source: 'statement' }],
  });
}

function inventedProfile(extra = {}) {
  return Object.assign({
    schemaVersion: 1, isSynthetic: true,
    household: { name: 'Test household (invented)', people: [{ id: 'p1', name: 'Rowan' }, { id: 'p2', name: 'Kai' }] },
    plan: {
      people: [{ id: 'p1', name: 'Rowan' }, { id: 'p2', name: 'Kai' }],
      incomes: [H.paycheck({ id: 'p1-pay', label: 'Rowan pay', netPerPaycheckCents: 300000, jointPerPaycheckCents: 250000 }),
        H.contribution({ id: 'p2-in', label: 'Kai to joint', jointPerPaycheckCents: null })],
      bills: [{ id: 'kai-phone', label: 'Kai phone', category: 'Internet & phone', monthlyCents: 6000, fundedFrom: 'p2', type: 'utility', status: 'existing' }],
      targets: { 'Dining & takeout': 20000 },
      savings: [{ id: 'trip', label: 'Trip', targetCents: 120000, targetMonth: '2026-10', savedCents: 0, monthlyCents: 30000, spendAtTarget: true }],
      changes: [
        { id: 'roof', label: 'Roof patch', kind: 'oneTime', group: 'irregular', startMonth: '2026-09', cents: null, scenario: 'Fix-up' },
        { id: 'bonus', label: 'Bonus', kind: 'oneTime', group: 'income', personId: 'p1', startMonth: '2026-12', cents: 80000, scenario: 'Fix-up' },
      ],
    },
  }, extra);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-report-'));
  fs.writeFileSync(path.join(tmp, 'data.json'), JSON.stringify(inventedData()));
  fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify(inventedProfile()));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('tools/plan-report.cjs', () => {
  test('arguments: defaults, and friendly errors', () => {
    assert.deepEqual(R.parseArgs([]), { sample: false, workbook: null, months: 12, json: false, out: null, data: null, profile: null, today: null, help: false });
    assert.deepEqual(R.parseArgs(['--sample', '--months', '24', '--json', '--today', '2026-10-05']).months, 24);
    for (const bad of [['--months', '0'], ['--months', '61'], ['--months', 'x'], ['--today', 'Oct 5'], ['--workbook'], ['--wat']]) assert.throws(() => R.parseArgs(bad), Error, bad.join(' '));
    assert.equal(run(['--months', '0']).code, 2);
  });

  test('--sample prints the whole report to stdout, Markdown or JSON, with no private marker', () => {
    const md = run(['--sample', '--today', '2026-10-05']);
    assert.equal(md.code, 0, md.err);
    for (const h of ['# Plan report: Alex & Sam (sample)', '## Headline', '## This month’s plan (Oct 2026)', '## To check', '## Dials', '## Month by month: money',
      '## Month by month: balances (month end)', '## Planned changes', '## What-ifs', '## Savings goals', '## Investments (never counted as cash)', '## Bills', '## Setup sync']) assert.ok(md.out.includes(h), h);
    assert.ok(!md.out.includes(R.PRIVATE_MARKER));
    assert.match(md.out, /\| Sample brokerage \(joint\) \| joint \| \$14,020\.25 — From your statement, Sep 30, 2026 \|/);
    assert.match(md.out, /\| Anniversary trip: monthly saving stops \| outside \| −\$200\.00\/mo \|/);
    const js = run(['--sample', '--today', '2026-10-05', '--json']);
    const r = JSON.parse(js.out);
    assert.deepEqual([r.report, r.privateReport, r.sample, r.planStart, r.budget], [R.REPORT_KIND, false, true, '2026-10', 'setup file']);
    assert.deepEqual(r.headline.combinedIn12.month, '2027-09');
    assert.equal(r.headline.monthlyCents, r.summary.inCents - r.summary.outCents);
    assert.equal(r.months.filter(m => m.status === 'plan').length, 12);
    assert.deepEqual(r.whatIfs.map(w => w.name), ['Baby arrives (May 2027)', 'Home projects'], 'the profile’s scenarios are what-ifs');
    assert.ok(r.dials.every(d => 'needsConfirm' in d && 'basis' in d && 'source' in d && 'baselineCents' in d));
    // --months: more plan months (the horizon grows to fit).
    const long = JSON.parse(run(['--sample', '--today', '2026-10-05', '--json', '--months', '18']).out);
    assert.equal(long.months.filter(m => m.status === 'plan').length, 18);
  });

  test('a private report (invented files) goes to its files, marked private, with every section filled', () => {
    const out = path.join(tmp, 'out', 'report.md');
    const res = run(['--data', path.join(tmp, 'data.json'), '--profile', path.join(tmp, 'profile.json'), '--out', out, '--today', TODAY]);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /PRIVATE REPORT/);
    const md = fs.readFileSync(out, 'utf8');
    const r = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'report.json'), 'utf8'));
    assert.ok(md.startsWith(R.PRIVATE_MARKER));
    assert.deepEqual([r.privateReport, r.household, r.planStart], [true, 'Test household (invented)', '2026-07']);
    // Each dial with its value, baseline, basis, needsConfirm and source.
    const kai = r.dials.find(d => d.key === 'p2');
    assert.deepEqual([kai.basisKind, kai.needsConfirm], ['average', true]);
    // Goals, the spent goal's stop, investments (personal, labelled), bills and what-ifs.
    assert.deepEqual(r.changes.filter(c => c.source === 'goal').map(c => [c.id, c.startMonth, c.cents, c.status]), [['goal-trip', '2026-10', 120000, 'applied'], ['goal-trip-stops', '2026-11', -30000, 'applied']]);
    assert.deepEqual(r.investments.accounts.map(a => [a.label, a.owner, a.ownerName]), [['Retirement (Kai)', 'p2', 'Kai']]);
    assert.deepEqual(r.whatIfs.map(w => [w.name, w.count, w.compare.addedIds, w.compare.unset, w.compare.versusPlanCents]), [['Fix-up', 2, ['bonus'], ['roof'], 80000]]);
    assert.deepEqual(r.bills.map(b => [b.id, b.status]), [['kai-phone', 'notJoint']]);
    // To check: unknown amounts, unconfirmed income, unset changes, bills left alone.
    const kinds = r.toCheck.map(t => t.kind);
    for (const k of ['income', 'change', 'bill']) assert.ok(kinds.includes(k), k);
    assert.ok(r.toCheck.some(t => /“Roof patch” \(what-if “Fix-up”\), in Sep 2026: no amount yet/.test(t.text)));
    assert.ok(r.toCheck.some(t => /Bill “Kai phone”: paid personally/.test(t.text)));
    assert.ok(r.toCheck.some(t => /Kai: money in is the average of observed deposits/.test(t.text)));
    assert.ok(!r.toCheck.some(t => t.kind === 'cash'), 'the plan does not run out or draw savings down');
    for (const h of ['## Headline', '## To check', '| Fix-up |', '| Retirement (Kai) | Kai |']) assert.ok(md.includes(h), h);
  });

  test('To check flags savings drawn down while all joint accounts lose money', () => {
    const p = inventedProfile({ planUi: { dials: { savings: -50000, essentials: 700000 } } });
    const r = R.buildReport({ E, dataset: inventedData(), profile: p, today: TODAY, sample: false });
    assert.ok(r.summary.savingsCents < 0 && r.headline.monthlyCents < 0);
    const flag = r.toCheck.find(t => t.kind === 'cash' && /draws \$500\.00 from savings/.test(t.text));
    assert.ok(flag, JSON.stringify(r.toCheck.map(t => t.text)));
    assert.ok(r.toCheck.some(t => /^Combined cash goes below \$0 in /.test(t.text)));
    assert.match(r.setup.notes[0] || '', /^Your setup file updated/, 'planUi reaches the plan through setup sync');
  });

  test('--workbook: the household’s in-browser edits count, and setup sync runs on them', () => {
    const ds = E.ledger.normalizeDataset(inventedData());
    let st = E.setupSync.apply(E.state.defaults(inventedProfile(), ds), inventedProfile(), { now: '2026-07-01T00:00:00.000Z' }).state;
    st = E.timeline.setDial(st, 'flexible', 12345);
    const wb = path.join(tmp, 'household-workbook.json');
    fs.writeFileSync(wb, E.state.exportWorkbook(st, { datasetId: ds.datasetId, now: '2026-07-01T00:00:00.000Z' }));
    // The setup file changed since: a new target reaches the budget; the dial set in the app stays.
    const p2 = inventedProfile();
    p2.plan.targets = { 'Dining & takeout': 20000, Groceries: 65000 };
    fs.writeFileSync(path.join(tmp, 'profile2.json'), JSON.stringify(p2));
    const res = run(['--data', path.join(tmp, 'data.json'), '--profile', path.join(tmp, 'profile2.json'), '--workbook', wb, '--out', path.join(tmp, 'wb', 'r.md'), '--today', TODAY, '--json']);
    assert.equal(res.code, 0, res.err);
    const r = JSON.parse(res.out);
    assert.equal(r.budget, 'workbook');
    assert.deepEqual([r.dials.find(d => d.key === 'flexible').valueCents, r.dials.find(d => d.key === 'flexible').source], [12345, 'direct']);
    assert.match(r.setup.notes.join(' '), /Your setup file updated 1 setting \(Groceries target/);
    assert.ok(fs.existsSync(path.join(tmp, 'wb', 'r.json')), '--json still writes the private files');
  });

  test('refuses to write a private report inside the repository anywhere but private/', () => {
    for (const rel of ['plan-report.md', 'fixtures/plan-report.md', 'docs/plan-report.md', 'dist/plan-report.md', 'src/x/report.md', 'private']) {
      assert.throws(() => R.checkReportOut(path.join(ROOT, rel)), /Refusing to write a private plan report/, rel);
    }
    assert.doesNotThrow(() => R.checkReportOut(path.join(ROOT, 'private/plan-report.md')));
    assert.doesNotThrow(() => R.checkReportOut(path.join(ROOT, 'private/reports/october.md')));
    assert.doesNotThrow(() => R.checkReportOut(path.join(tmp, 'anywhere', 'report.md')), 'outside the repository: the household’s choice');
    // Through the CLI: refused before anything is read or written.
    const target = path.join(ROOT, 'fixtures', 'plan-report-test.md');
    const res = run(['--data', path.join(tmp, 'data.json'), '--profile', path.join(tmp, 'profile.json'), '--out', target, '--today', TODAY]);
    assert.equal(res.code, 1);
    assert.match(res.err, /Refusing to write a private plan report to fixtures\/plan-report-test\.md/);
    assert.ok(!fs.existsSync(target) && !fs.existsSync(target.replace(/\.md$/, '.json')));
    // A symlink out of private/ into the repository is resolved, not trusted by its name.
    const fakeRoot = fs.mkdtempSync(path.join(tmp, 'repo-'));
    fs.mkdirSync(path.join(fakeRoot, 'private'));
    fs.mkdirSync(path.join(fakeRoot, 'docs'));
    fs.symlinkSync(path.join(fakeRoot, 'docs'), path.join(fakeRoot, 'private', 'link'));
    assert.throws(() => R.checkReportOut(path.join(fakeRoot, 'private', 'link', 'r.md'), fakeRoot), /Refusing/);
    assert.doesNotThrow(() => R.checkReportOut(path.join(fakeRoot, 'private', 'r.md'), fakeRoot));
  });

  test('a missing input is a plain error, not a stack trace', () => {
    const res = run(['--data', path.join(tmp, 'nope.json'), '--profile', path.join(tmp, 'profile.json'), '--out', path.join(tmp, 'x.md')]);
    assert.equal(res.code, 1);
    assert.match(res.err, /^Plan report failed: Cannot read the dataset \(.*nope\.json\): no such file\.$/);
  });
});
