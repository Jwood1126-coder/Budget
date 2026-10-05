#!/usr/bin/env node
'use strict';
/*
 * The plan as the household's assistant reads it: one report of everything the Plan screen works
 * out (headline, this month's plan, the dials, month by month, planned changes and what-ifs, goals,
 * investments, bills, setup sync) plus a "To check" list of what is unknown or assumed.
 *
 *   node tools/plan-report.cjs                  private/budget-data.json + private/household-profile.json
 *                                               -> private/plan-report.md and private/plan-report.json
 *   node tools/plan-report.cjs --sample         the fictional sample; prints the report (Markdown)
 *   node tools/plan-report.cjs --workbook f.json  a workbook exported from the app (Data & privacy):
 *                                               the household's in-browser edits count, then setup sync
 *   node tools/plan-report.cjs --months 24      plan months in the month-by-month tables (1-60; default 12)
 *   node tools/plan-report.cjs --json           print the JSON instead of the Markdown (a private report
 *                                               is still written to its files)
 *   node tools/plan-report.cjs --out path.md    write the Markdown there and the JSON next to it (.json).
 *                                               A private report may only go to private/ or outside
 *                                               this repository.
 *   --data file / --profile file                another dataset or profile (e.g. invented test files)
 *   --today YYYY-MM-DD                          the day the plan is worked out for (default: today)
 *
 * Without a workbook the budget is a new one made from the setup file (E.state.defaults), so the
 * household's own changes in the browser are not in it: export a workbook to include them.
 * Pure engine (src/engine, loaded in the order of src/manifest.json); writes only the report.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PRIVATE_MARKER = '<!-- household-budget: PRIVATE plan report. Do not commit, upload or share. -->';
const REPORT_KIND = 'household-budget-plan-report';
const DEFAULT_MONTHS = 12;

// ------------------------------------------------------------------ engine and inputs

function loadEngine() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  for (const rel of manifest.engine) require(path.join(SRC, rel));
  return globalThis.BudgetEngine;
}

function parseArgs(argv) {
  const args = { sample: false, workbook: null, months: DEFAULT_MONTHS, json: false, out: null, data: null, profile: null, today: null, help: false };
  const value = (i, name) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new Error(name + ' needs a value.');
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = true;
    else if (a === '--json') args.json = true;
    else if (a === '--workbook') args.workbook = value(++i, a);
    else if (a === '--out') args.out = value(++i, a);
    else if (a === '--data') args.data = value(++i, a);
    else if (a === '--profile') args.profile = value(++i, a);
    else if (a === '--today') args.today = value(++i, a);
    else if (a === '--months') {
      const n = Number(value(++i, a));
      if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('--months takes a whole number of months from 1 to 60.');
      args.months = n;
    } else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unknown option: ' + a + ' (see --help).');
  }
  if (args.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today takes a date as YYYY-MM-DD.');
  return args;
}

const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// Symlinks resolved, for a file that may not exist yet (its nearest existing folder is resolved).
function realPath(p) {
  const tail = [];
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { tail.unshift(path.basename(dir)); dir = path.dirname(dir); }
  try { return path.join(fs.realpathSync(dir), ...tail); } catch { return path.resolve(p); }
}
/**
 * A private report stays out of the parts of the repository git can publish: inside this
 * repository only private/ (ignored by git) is allowed; anywhere outside it is the household's
 * choice (the same rule as tools/build.cjs's checkPrivateOut, without dist/). Throws otherwise.
 */
function checkReportOut(out, root = ROOT) {
  const real = realPath(out);
  // Case-insensitive for "is it in the repo" (macOS/Windows folders), exact for the ignored folder.
  if (!isInside(realPath(root).toLowerCase(), real.toLowerCase())) return;
  if (isInside(realPath(path.join(root, 'private')), real) && real !== realPath(path.join(root, 'private'))) return;
  throw new Error('Refusing to write a private plan report to ' + (path.relative(root, out) || '.') + ': inside this repository only private/ is ignored by git. '
    + 'Use the default private/plan-report.md, another path in private/, or a folder outside the repository.');
}

/** The input files: { data, profile, workbook, private } (absolute paths; workbook may be null). */
function pickInputs(args, root = ROOT) {
  const resolve = p => path.resolve(p);
  if (args.sample) {
    return {
      private: false,
      data: args.data ? resolve(args.data) : path.join(root, 'fixtures/sample-data.json'),
      profile: args.profile ? resolve(args.profile) : path.join(root, 'fixtures/sample-profile.json'),
      workbook: args.workbook ? resolve(args.workbook) : null,
    };
  }
  const data = args.data ? resolve(args.data)
    : [path.join(root, 'private/budget-data.json'), path.join(root, 'data/budget-data.json')].find(f => fs.existsSync(f)) || path.join(root, 'private/budget-data.json');
  const profile = args.profile ? resolve(args.profile) : path.join(root, 'private/household-profile.json');
  return { private: true, data, profile, workbook: args.workbook ? resolve(args.workbook) : null };
}

function readJSON(file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    throw new Error('Cannot read the ' + what + ' (' + file + '): ' + (err.code === 'ENOENT' ? 'no such file' : err.message) + '.');
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (err) { throw new Error('The ' + what + ' (' + file + ') is not valid JSON: ' + err.message); }
}

// ------------------------------------------------------------------ the report (pure)

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Everything the report says, as one JSON-able object. Pure: `today` and `now` are passed in.
 * @param {{ E: object, dataset: object, profile: object, workbookText?: string|null, today: string,
 *   now?: string, months?: number, sample?: boolean, sources?: object }} input
 *   dataset: a raw or normalized dataset; profile: the household profile (setup file)
 */
function buildReport(input) {
  const { E, profile, today } = input;
  const months = Number.isInteger(input.months) ? input.months : DEFAULT_MONTHS;
  const now = input.now || today + 'T00:00:00.000Z';
  const dataset = E.ledger.normalizeDataset(input.dataset);

  // The budget: the household's workbook (their in-browser edits) or a new one from the setup file,
  // then setup sync, exactly as the page does when it opens.
  let state, loadNotes = [], setupNotes = [], setupReport = null, budgetSource;
  if (typeof input.workbookText === 'string') {
    const r = E.setupSync.importWorkbook(input.workbookText, profile, dataset, { now });
    state = r.state;
    setupNotes = r.setupNotes || [];
    loadNotes = (r.notes || []).filter(n => !setupNotes.includes(n));
    setupReport = r.setup || null;
    budgetSource = 'workbook';
  } else {
    const s = E.setupSync.apply(E.state.defaults(profile, dataset, { now }), profile, { now });
    state = s.state;
    setupNotes = s.notes;
    setupReport = s.report;
    budgetSource = 'setup file';
  }

  const horizon = E.timeline.HORIZONS.find(h => h >= Math.max(months, 12)) || E.timeline.HORIZONS[E.timeline.HORIZONS.length - 1];
  const settings = Object.assign({}, state.ui.plan, { horizon });
  const txns = E.ledger.applyEdits(dataset, state.ledgerEdits);
  const coverageMap = E.ledger.coverageMap(dataset);
  const build = compare => E.timeline.build({ txns, dataset, plan: state.plan, settings, today, coverageMap, compare });
  const tl = build();
  const people = tl.people;
  const planStart = tl.planStart;
  const in12 = E.months.add(planStart, 11);
  const pointAt = (points, m) => (points || []).find(p => p.month === m) || null;
  const combined = tl.balances.combined;
  const combinedIn12 = combined ? pointAt(combined.points, in12) : null;
  const first = tl.months.find(m => m.month === planStart) || null;
  const summary = tl.summary;
  const monthly = summary && isNum(summary.inCents) && isNum(summary.outCents) ? summary.inCents - summary.outCents : null;

  const lastPlan = E.months.add(planStart, months - 1);
  const actualFrom = E.months.add(planStart, -3);
  const shown = tl.months.filter(m => (m.month >= actualFrom && m.month < planStart && m.complete) || (m.month >= planStart && m.month <= lastPlan));
  const indexOf = m => tl.months.findIndex(x => x.month === m);
  const inv = tl.balances.investments;
  const monthRows = shown.map(m => {
    const i = indexOf(m.month);
    const bal = p => (p ? { cents: p.cents, status: p.status || null } : { cents: null, status: null });
    return {
      month: m.month, status: m.status,
      in: Object.assign(Object.fromEntries(people.map(p => [p.id, m.in[p.id]])), { other: sumKnown([m.in.unassigned, m.in.other]), total: m.in.total }),
      out: { essentials: m.out.essentials, flexible: m.out.flexible, irregular: m.out.irregular, debtAndBusiness: m.out.other, investing: m.out.invest, total: m.out.total },
      savings: m.savings, allAccountsChange: m.combinedChange, leftInChecking: m.net,
      changes: m.changesApplied.map(a => a.id),
      balances: {
        combined: combined ? bal(combined.points[i]) : null,
        accounts: tl.balances.accounts.map(a => Object.assign({ id: a.id, name: a.name }, bal(a.points[i]))),
        investments: inv ? bal(inv.points[i]) : null,
      },
    };
  });

  const dials = tl.dials.map(d => ({
    key: d.key, label: d.label, group: d.group, valueCents: d.planCents, baselineCents: d.baselineCents, source: d.source,
    basis: d.basis, basisKind: d.basisKind || null, needsConfirm: d.needsConfirm === true,
  }));

  const changes = tl.changes.list.map(c => ({
    id: c.id, label: c.label, source: c.source, kind: c.kind, group: c.group, personId: c.personId || null,
    startMonth: c.startMonth, endMonth: c.endMonth, cents: c.cents, accepted: c.accepted, status: c.status,
    scenario: c.scenario || null, template: c.template || null, monthsApplied: c.monthsApplied, note: c.note || '',
  }));

  const planIn12 = combinedIn12 ? combinedIn12.cents : null;
  const whatIfs = tl.scenarios.map(s => {
    const cmp = build(s.name).compare;
    const at = cmp && cmp.points ? pointAt(cmp.points, in12) : null;
    return {
      name: s.name, count: s.count, accepted: s.accepted,
      compare: cmp ? {
        addedIds: cmp.addedIds, unset: cmp.unset, combinedIn12Cents: at ? at.cents : null,
        versusPlanCents: at && isNum(at.cents) && isNum(planIn12) ? at.cents - planIn12 : null,
        lowest: cmp.lowest, runsOut: cmp.runsOut,
      } : null,
    };
  });

  const goals = tl.goals.map(g => ({
    id: g.id, label: g.label, targetCents: g.targetCents, savedCents: g.savedCents, monthlyCents: g.monthlyCents,
    targetMonth: g.targetMonth, spendAtTarget: g.spendAtTarget, cumulativeCents: g.cumulativeCents, reachMonth: g.reachMonth, already: g.already,
  }));

  const investments = inv ? {
    accounts: inv.accounts.map(a => {
      const last = a.points.filter(p => p.cents !== null).pop() || null;
      return { id: a.id, name: a.name, label: a.label, owner: a.owner, ownerName: a.ownerName, primary: a.primary,
        anchor: a.anchor ? { date: a.anchor.date, cents: a.anchor.cents, source: a.anchor.source, label: a.anchor.label } : null,
        end: last ? { month: last.month, cents: last.cents, status: last.status } : null };
    }),
    in12Cents: (pointAt(inv.points, in12) || {}).cents === undefined ? null : pointAt(inv.points, in12).cents,
    missing: inv.missing, returnPct: inv.returnPct, illustrative: inv.illustrative, rule: inv.rule, notes: inv.notes,
  } : null;

  const report = {
    report: REPORT_KIND, version: 1, privateReport: !input.sample, sample: !!input.sample,
    today, budget: budgetSource, sources: input.sources || null,
    household: profile && profile.household && typeof profile.household.name === 'string' ? profile.household.name : null,
    people, planStart, lastComplete: tl.lastComplete, monthsShown: months,
    headline: {
      monthlyCents: monthly, leftInCheckingCents: summary ? summary.leftCents : null,
      combinedIn12: { month: in12, cents: combinedIn12 ? combinedIn12.cents : null, status: combinedIn12 ? combinedIn12.status || null : null },
      lowest: tl.balances.lowest, runsOut: tl.balances.runsOut, balanceMode: tl.balances.mode,
    },
    summary,
    dials, months: monthRows, changes,
    changeTotals: { applied: tl.changes.applied, derived: tl.changes.derived, unset: tl.changes.unset },
    whatIfs, goals, investments, bills: tl.bills,
    balances: {
      mode: tl.balances.mode, accounts: tl.balances.accounts.map(a => ({ id: a.id, name: a.name, group: a.group, anchor: a.anchor ? { date: a.anchor.date, cents: a.anchor.cents, source: a.anchor.source, label: a.anchor.label } : null, dateAssumed: !!a.dateAssumed })),
      missing: tl.balances.missing, assumed: tl.balances.assumed, notes: tl.balances.notes,
    },
    baseline: { setting: tl.baseline.setting, count: tl.baseline.count, label: tl.baseline.label },
    setup: { notes: setupNotes, report: setupReport, loadNotes },
  };
  report.toCheck = toCheck(E, report, state, first);
  return report;
}

const sumKnown = list => (list.some(v => v === null || v === undefined) ? null : list.reduce((s, v) => s + v, 0));

/**
 * The "To check" list: what the plan does not know or assumes, each { kind, text }. Kinds:
 * 'unknown' (an amount not known), 'income' (income not confirmed), 'balance' (a balance not
 * known, or a gap the line assumes nothing moved in), 'history' (the baselines rest on fewer
 * months than asked, or on deposits instead of the pay in Budget), 'change' (a planned change with
 * no amount), 'bill' (a bill the plan leaves alone, and why), 'cash' (the plan runs out, or draws
 * savings down while all accounts lose money).
 */
function toCheck(E, report, state, first) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const fmt = c => E.money.format(c);
  const mon = m => E.months.label(m);
  const plan = state.plan;
  const personName = id => (report.people.find(p => p.id === id) || {}).name || id;

  // Cash: runs out; savings drawn down while every joint account together loses money.
  const h = report.headline;
  if (h.runsOut) add('cash', 'Combined cash goes below $0 in ' + mon(h.runsOut) + (h.lowest ? ' (lowest ' + fmt(h.lowest.cents) + ' in ' + mon(h.lowest.month) + ')' : '') + '.');
  const s = report.summary;
  if (s && isNum(s.savingsCents) && s.savingsCents < 0 && isNum(h.monthlyCents) && h.monthlyCents < 0) {
    add('cash', 'This month’s plan (' + mon(s.month) + ') draws ' + fmt(0 - s.savingsCents) + ' from savings while all joint accounts together lose ' + fmt(0 - h.monthlyCents) + ' a month: the plan spends more than comes in.');
  }
  if (h.balanceMode === 'none') add('balance', 'No balance is known for any joint account: the plan shows money in and out only. Add statement balances to the import config.');

  // Unknown amounts: dials and this month's plan.
  for (const d of report.dials) if (d.valueCents === null) add('unknown', d.label + ': amount not known (' + d.basis + ').');
  if (s) {
    const missing = [];
    if (s.inCents === null) missing.push('money in');
    for (const [k, v] of Object.entries(s.outByGroup || {})) if (v === null) missing.push(k);
    if (s.savingsCents === null) missing.push('net to savings');
    if (missing.length) add('unknown', 'This month’s plan has unknown amounts: ' + missing.join(', ') + '.');
  }
  for (const g of report.goals) {
    if (g.targetCents === null) add('unknown', 'Savings goal “' + g.label + '”: no target amount, so it has no month to be reached.');
    if (g.savedCents === null) add('unknown', 'Savings goal “' + g.label + '”: how much is already saved is not known.');
  }
  for (const d of Array.isArray(plan.debts) ? plan.debts : []) {
    if (d.balanceCents === null) add('unknown', 'Debt “' + d.label + '”: balance not known.');
  }
  for (const p of Array.isArray(plan.personalSpending) ? plan.personalSpending : []) {
    if (p.monthlyCents === null) add('unknown', personName(p.personId) + '’s personal spending is not entered: everything left of their pay is assumed spent.');
  }

  // Income not confirmed.
  for (const d of report.dials) if (d.needsConfirm) add('income', d.label + ': money in is the average of observed deposits, not a confirmed setting — enter the pay in the setup file (' + d.basis + ').');
  for (const st of Array.isArray(plan.incomes) ? plan.incomes : []) {
    const bits = [];
    if (st.status !== 'confirmed') bits.push('status ' + st.status);
    if (st.frequencyStatus !== 'confirmed') bits.push('pay frequency ' + (st.frequency === 'unknown' ? 'unknown' : st.frequency + ' (' + st.frequencyStatus + ')'));
    if (st.kind === 'paycheck' && st.netPerPaycheckCents === null) bits.push('take-home pay not known');
    if (st.kind !== 'other' && st.jointPerPaycheckCents === null) bits.push('amount to joint not known');
    if (bits.length) add('income', '“' + st.label + '” (' + personName(st.personId) + '): ' + bits.join('; ') + '.');
  }

  // Balances: accounts without one, gaps assumed, dates assumed, investments without one.
  for (const m of report.balances.missing || []) add('balance', m.name + ' has no known balance: it is left out of combined cash (never counted as $0).');
  for (const a of report.balances.accounts) if (a.dateAssumed) add('balance', a.name + ': the entered balance has no date; it is taken as of ' + E.dates.label(a.anchor.date) + '.');
  const assumed = report.balances.assumed;
  if (assumed) for (const g of assumed.gaps || [assumed]) add('balance', (g.accounts || []).join(', ') + ': the line assumes nothing moved from ' + E.dates.label(g.from) + ' to ' + E.dates.label(g.to) + ' (' + g.days + ' days not in the data).');
  if (report.investments) for (const n of report.investments.notes) add('balance', n);

  // History the baselines rest on.
  const b = report.baseline;
  if (b.setting !== 'all' && b.count < b.setting) add('history', 'The baselines average ' + b.count + ' complete month' + (b.count === 1 ? '' : 's') + ', fewer than the ' + b.setting + ' asked for (' + b.label + ').');
  if (!b.count) add('history', 'No complete month in the data: the dials have no baseline.');

  // Planned changes without an amount (what-ifs too), never applied as $0.
  for (const c of report.changes) {
    if (c.cents === null) add('change', '“' + c.label + '”' + (c.scenario ? ' (what-if “' + c.scenario + '”)' : '') + ', ' + (c.kind === 'monthly' ? 'from ' : 'in ') + mon(c.startMonth) + ': no amount yet, so it is not applied.');
  }

  // Bills the plan leaves alone, and why.
  const WHY = {
    notJoint: 'paid personally (or by nobody known), so not on the joint plan',
    noAmount: 'no amount, so it is not added',
    noCategory: 'no category, so it cannot be matched to the history and is never added',
    inBudget: 'its category has a budget, which already plans it',
    ended: 'it ended before the plan starts',
  };
  for (const bill of report.bills) if (WHY[bill.status]) add('bill', 'Bill “' + bill.label + '”: ' + WHY[bill.status] + '.');
  if (first && first.status === 'partial') add('history', mon(first.month) + ' is partly covered by the data: the plan is used for it.');
  return out;
}

// ------------------------------------------------------------------ Markdown

/** The report as plain, scannable Markdown. */
function toMarkdown(E, r) {
  const money = c => (c === null || c === undefined ? 'unknown' : E.money.format(c));
  const signed = c => (c === null || c === undefined ? 'unknown' : (c > 0 ? '+' : '') + E.money.format(c));
  const mon = m => (m ? E.months.label(m) : '—');
  const cell = v => String(v === null || v === undefined ? '—' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const row = cells => '| ' + cells.map(cell).join(' | ') + ' |';
  const table = (head, rows) => [row(head), '| ' + head.map(() => '---').join(' | ') + ' |'].concat(rows.map(row));
  const withStatus = (c, st) => (c === null || c === undefined ? 'unknown' : money(c) + (st && st !== 'reconstructed' && st !== 'projected' ? ' (' + st + ')' : ''));
  const L = [];
  if (r.privateReport) L.push(PRIVATE_MARKER, '');
  L.push('# Plan report' + (r.household ? ': ' + r.household : ''), '');
  if (r.sample) L.push('The fictional sample household: invented data, safe to share.', '');
  L.push('Worked out for ' + E.dates.label(r.today) + ' from ' + (r.budget === 'workbook' ? 'the household’s workbook (their changes in the app), with the setup file synced' : 'the setup file as a new budget (no workbook: changes made in the app are not included)') + '. '
    + 'The plan starts ' + mon(r.planStart) + (r.lastComplete ? '; the data is complete through ' + mon(r.lastComplete) : '') + '.', '');

  const h = r.headline;
  L.push('## Headline', '');
  L.push(...table(['', 'Amount'], [
    ['Monthly on this plan (all joint accounts)', signed(h.monthlyCents)],
    ['Left in checking after net to savings', signed(h.leftInCheckingCents)],
    ['Combined cash in 12 months (' + mon(h.combinedIn12.month) + ')', withStatus(h.combinedIn12.cents, h.combinedIn12.status)],
    ['Lowest point', h.lowest ? money(h.lowest.cents) + ' in ' + mon(h.lowest.month) : '—'],
    ['Runs out', h.runsOut ? mon(h.runsOut) : 'no (within the months worked out)'],
  ]), '');

  const s = r.summary;
  if (s) {
    L.push('## This month’s plan (' + mon(s.month) + ')', '');
    const ins = r.people.map(p => p.name + ' ' + money(s.inByPerson[p.id])).concat(['other ' + money(s.inByPerson.other)]);
    L.push('- In: ' + ins.join(' · ') + ' = **' + money(s.inCents) + '**');
    L.push('- Out: Essentials ' + money(s.outByGroup.essentials) + ' · Flexible ' + money(s.outByGroup.flexible) + ' · Irregular ' + money(s.outByGroup.irregular)
      + ' · Debt & business ' + money(s.outByGroup.other) + ' · Investing ' + money(s.investingCents) + ' = **' + money(s.outCents) + '**');
    L.push('- Net to savings: ' + signed(s.savingsCents) + ' · Left over: **' + signed(s.leftCents) + '**', '');
  }

  L.push('## To check (' + r.toCheck.length + ')', '');
  if (!r.toCheck.length) L.push('Nothing: every amount is known and confirmed.');
  for (const t of r.toCheck) L.push('- **' + t.kind + '**: ' + t.text);
  L.push('');

  L.push('## Dials', '');
  L.push(...table(['Dial', 'Plan', 'Baseline', 'Source', 'Basis', 'Confirm?'], r.dials.map(d => [
    d.label, money(d.valueCents), money(d.baselineCents), d.source + (d.basisKind ? ' / ' + d.basisKind : ''), d.basis, d.needsConfirm ? 'yes: not confirmed' : '',
  ])), '');

  L.push('## Month by month: money', '');
  L.push(...table(['Month', 'Status'].concat(r.people.map(p => 'In ' + p.name), ['In other', 'Essentials', 'Flexible', 'Irregular', 'Debt & business', 'Investing', 'Net to savings', 'All accounts', 'Left in checking']),
    r.months.map(m => [mon(m.month), m.status].concat(r.people.map(p => money(m.in[p.id])), [money(m.in.other), money(m.out.essentials), money(m.out.flexible), money(m.out.irregular),
      money(m.out.debtAndBusiness), money(m.out.investing), signed(m.savings), signed(m.allAccountsChange), signed(m.leftInChecking)]))), '');

  L.push('## Month by month: balances (month end)', '');
  const accounts = r.balances.accounts;
  L.push(...table(['Month', 'Combined cash'].concat(accounts.map(a => a.name), r.investments ? ['Investments (not cash)'] : []),
    r.months.map(m => [mon(m.month), m.balances.combined ? withStatus(m.balances.combined.cents, m.balances.combined.status) : '—']
      .concat(m.balances.accounts.map(a => withStatus(a.cents, a.status)), r.investments ? [withStatus(m.balances.investments.cents, m.balances.investments.status)] : []))), '');
  L.push('Statuses: reconstructed from the data and projected are shown as plain amounts; assumed (a gap in the data) and illustrative (a growth rate you entered) are named.', '');

  L.push('## Planned changes', '');
  if (!r.changes.length) L.push('None.');
  else {
    L.push(...table(['Change', 'Status', 'Amount', 'Kind', 'Group', 'When', 'From', 'What-if'], r.changes.map(c => [
      c.label, c.status, c.cents === null ? 'not set' : signed(c.cents) + (c.kind === 'monthly' ? '/mo' : ''), c.kind, c.group,
      c.kind === 'monthly' ? mon(c.startMonth) + ' → ' + (c.endMonth ? mon(c.endMonth) : 'open') : mon(c.startMonth),
      c.source === 'plan' ? (c.template ? 'pack: ' + c.template : 'plan') : c.source, c.scenario,
    ])));
  }
  L.push('');

  L.push('## What-ifs', '');
  if (!r.whatIfs.length) L.push('None.');
  else {
    L.push(...table(['What-if', 'Changes', 'Accepted', 'Would add', 'No amount', 'Combined cash in 12 months', 'vs plan', 'Lowest', 'Runs out'], r.whatIfs.map(w => {
      const c = w.compare || {};
      return [w.name, w.count, w.accepted, (c.addedIds || []).length, (c.unset || []).length, money(c.combinedIn12Cents), signed(c.versusPlanCents),
        c.lowest ? money(c.lowest.cents) + ' in ' + mon(c.lowest.month) : '—', c.runsOut ? mon(c.runsOut) : 'no'];
    })));
  }
  L.push('');

  L.push('## Savings goals', '');
  if (!r.goals.length) L.push('None.');
  else {
    L.push(...table(['Goal', 'Target', 'Saved', 'Monthly', 'Target month', 'Spent at target', 'Reached'], r.goals.map(g => [
      g.label, money(g.targetCents), money(g.savedCents), money(g.monthlyCents), mon(g.targetMonth), g.spendAtTarget ? 'yes' : 'no',
      g.reachMonth ? mon(g.reachMonth) + (g.already ? ' (already)' : '') : 'not within the months worked out',
    ])));
  }
  L.push('');

  L.push('## Investments (never counted as cash)', '');
  if (!r.investments) L.push('No investment account in the data.');
  else {
    const iv = r.investments;
    L.push(...table(['Account', 'Owner', 'Known balance', 'Latest on the line'], iv.accounts.map(a => [
      a.label, a.owner === 'joint' ? 'joint' : a.ownerName || 'personal (owner not known)', a.anchor ? money(a.anchor.cents) + ' — ' + a.anchor.label : '—',
      a.end ? withStatus(a.end.cents, a.end.status) + ' in ' + mon(a.end.month) : '—',
    ])));
    L.push('', '- All investments in 12 months: ' + money(iv.in12Cents));
    L.push('- Growth: ' + (iv.returnPct === null ? 'none assumed' : iv.illustrative));
    for (const n of iv.notes) L.push('- ' + n);
  }
  L.push('');

  L.push('## Bills', '');
  L.push(...table(['Bill', 'On the plan', 'Change'], r.bills.map(b => [b.label, b.status, b.changeId])), '');

  L.push('## Setup sync', '');
  const notes = r.setup.notes.concat(r.setup.loadNotes);
  if (!notes.length) L.push('Nothing to report: the budget already matches the setup file.');
  for (const n of notes) L.push('- ' + n);
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ CLI

const HELP = fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*/, '').replace(/^ \* ?/gm, '');

function localToday() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Run the tool. Returns the exit code (0 ok, 1 failed, 2 bad arguments).
 * @param {string[]} argv
 * @param {{ log?: Function, error?: Function, root?: string }} [io]
 */
function main(argv, { log = console.log, error = console.error, root = ROOT } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (err) { error(err.message); return 2; }
  if (args.help) { log(HELP); return 0; }
  try {
    const files = pickInputs(args, root);
    // Where the report goes, checked before anything is read or worked out.
    let mdPath = null, jsonPath = null;
    if (args.out || files.private) {
      mdPath = path.resolve(args.out || path.join(root, 'private/plan-report.md'));
      jsonPath = /\.md$/i.test(mdPath) ? mdPath.replace(/\.md$/i, '.json') : mdPath + '.json';
      if (files.private) { checkReportOut(mdPath, root); checkReportOut(jsonPath, root); }
    }
    if (files.private && !args.data && !fs.existsSync(files.data)) throw new Error('No private/budget-data.json: run node tools/import.cjs first, or use --sample.');
    if (files.private && !args.profile && !fs.existsSync(files.profile)) throw new Error('No private/household-profile.json: copy fixtures/sample-profile.json there and edit it (docs/SETUP.md), or use --sample.');
    const E = loadEngine();
    const dataset = readJSON(files.data, 'dataset');
    const profile = readJSON(files.profile, 'household profile');
    let workbookText = null;
    if (files.workbook) {
      try { workbookText = fs.readFileSync(files.workbook, 'utf8'); } catch (err) { throw new Error('Cannot read the workbook (' + files.workbook + '): ' + err.message); }
    }
    const rel = p => (p ? (isInside(root, p) ? path.relative(root, p) : path.basename(p)) : null);
    const report = buildReport({
      E, dataset, profile, workbookText, today: args.today || localToday(), months: args.months, sample: !files.private,
      sources: { data: rel(files.data), profile: rel(files.profile), workbook: rel(files.workbook) },
    });
    const md = toMarkdown(E, report) + '\n';
    const json = JSON.stringify(report, null, 2) + '\n';
    if (mdPath) {
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      fs.writeFileSync(mdPath, md);
      fs.writeFileSync(jsonPath, json);
    }
    if (!mdPath || args.json) log(args.json ? json.trimEnd() : md.trimEnd());
    else {
      const h = report.headline;
      log('Wrote ' + path.relative(process.cwd(), mdPath) + ' and ' + path.relative(process.cwd(), jsonPath) + '.');
      log('Monthly on this plan: ' + (h.monthlyCents === null ? 'unknown' : E.money.format(h.monthlyCents)) + '; combined cash in 12 months: '
        + (h.combinedIn12.cents === null ? 'unknown' : E.money.format(h.combinedIn12.cents)) + (h.runsOut ? '; runs out ' + E.months.label(h.runsOut) : '') + '; ' + report.toCheck.length + ' to check.');
      if (files.private) log('PRIVATE REPORT: it holds the household’s figures. Keep it in private/; do not commit, upload or share it.');
    }
    return 0;
  } catch (err) {
    error('Plan report failed: ' + (err && err.message ? err.message : String(err)));
    return 1;
  }
}

module.exports = { parseArgs, pickInputs, checkReportOut, buildReport, toMarkdown, toCheck, main, PRIVATE_MARKER, REPORT_KIND };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
