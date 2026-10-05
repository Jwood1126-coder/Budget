'use strict';
/*
 * BudgetEngine.timeline — the plan screen's whole model in one call: what happened, the plan from
 * a handful of dials and dated planned changes, and where the joint balances head, month by month.
 *
 *   build(input)      everything the screen draws, worked out once per render (see build's JSDoc)
 *   anchors(plan, ds) the known balances the line starts from: per account (entered with its own
 *                     date, a balance supplied with the data, or the export's running balance),
 *                     else the one joint cash figure ("simple" mode). Forecast reads its starting
 *                     cash through this too.
 *   settings(raw)     ui.plan with every default filled in (BudgetEngine.state.cleanPlanUi, plus
 *                     the earlier card/bank dials still among the dials moved to legacyDials)
 *   toCSV(tl, opts)   the plan as a spreadsheet: its settings, then one row per month
 *   templates         ready-made planned changes (templates.baby(dueDate)), never accepted for you
 *   setDial / setRow / resetDial / resetPlan / setGroup / setIrregular / addChange / setChange /
 *   removeChange / acceptChanges / migrateRows   validated state writes for the screen
 *   pendingUpgrade(tl) the upgrades the screen applies once (migrateRows, migrateDials), named
 *
 * The module is split by section over src/engine/timeline-*.js (timeline-core.js lists them and
 * how they share their functions); this file holds build, the Trends series catalogue and the
 * public BudgetEngine.timeline, and loads after the others.
 *
 * Months: from the first month with data (or the earliest month a balance can be worked back
 * to) through planStart + horizon − 1. planStart is the month after the last month every
 * spending account's export covers in full. Months before it are 'actual' (incomplete ones carry
 * null amounts: unknown, never $0); a month from planStart on that has some data is 'partial'
 * (what happened so far is kept apart; the plan is used for the projection); the rest are 'plan'.
 *
 * Dials: one "money in" dial per person in the plan, at the pay saved in Budget (flows.planFunding,
 * annual-average timing) or, when that is not known, the deposit average labelled as not confirmed
 * (plus "Other money in" when the baseline has deposits nobody can be matched to, or interest),
 * and "money out" dials grouped by how adjustable the spending is: essentials (categories the
 * taxonomy marks essential, or the household moved there), flexible (the rest of everyday
 * spending), irregular (every one-time cost of the baseline months, spread per month), savings
 * (signed: below $0 draws savings down) and other (debt payments, business purchases and
 * investments, only when the baseline has any). Card and bank spending are no longer dials: they
 * are worked out from the spending dials (each row knows how it was paid), because the account
 * lines take card spending from checking when it happens.
 * Each dial's baseline is the average of the chosen complete months (BudgetEngine.flows.baseline,
 * yearly bills spread). A dial set directly wins; else changes to its drill-down rows (or, for
 * irregular, the one-time costs left out); else the baseline. Amounts are never clamped: integer
 * cents, negatives allowed. In the essentials and flexible drill-downs a stable regular bill
 * (about once a month, every charge within 10% of the median) counts at its latest charge; the
 * dial's baseline is the sum of the rows as they stand by default. Nothing is left out of the plan
 * automatically: every one-time cost is in the irregular allowance, counted as regular spending
 * (the planningBaseline 'include' edit) or left out by the household (ui.plan.irregularOff).
 *
 * Planned changes (plan.changes): accepted changes with an amount add to plan months from their
 * start month (one-time: that month only; monthly: through the end month when set). A change
 * without an amount is listed and reported, never applied as $0.
 *
 * Balances: each anchored account is worked back and forward with its own transactions
 * ('reconstructed'); after its last known day each month adds the month's net ('projected').
 * Nothing is floored at $0. The optional "cover from savings" policy moves a projected checking
 * shortfall from savings, per account only; the combined line is the same either way.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, plural, sumKnown, late, settings, IN_KEYS, LEGACY_DIALS, SERIES, BALANCE_SERIES, BALANCE_SERIES_PREFIX } = T;
  // The other parts' functions build uses, looked up when called.
  const anchors = late('anchors'), mirrorPlan = late('mirrorPlan'), balancesFor = late('balancesFor');
  const spendGroups = late('spendGroups');
  const buildDials = late('buildDials'), planMonth = late('planMonth'), legacyDialsPlan = late('legacyDialsPlan');
  const readChanges = late('readChanges'), changeActiveIn = late('changeActiveIn'), applyChange = late('applyChange'), summarizeChanges = late('summarizeChanges');

  /** The money-out dials, in the order the screen shows them ('other' only when it has an amount). */
  const OUT_DIALS = ['essentials', 'flexible', 'irregular', 'savings', 'other'];

  // ------------------------------------------------------------------ month amounts

  const IN_EMPTY = people => Object.assign(Object.fromEntries(people.map(p => [p.id, null])), { unassigned: null, other: null, total: null });
  const OUT_EMPTY = () => ({ essentials: null, flexible: null, irregular: null, card: null, bank: null, debt: null, business: null, invest: null, other: null, total: null });

  /**
   * One month's amounts from a flows.breakdown `actual` object and its spending by group
   * ({ essentials, flexible, irregular }, which add up to card + bank).
   */
  function fromActual(a, people, g) {
    const ids = new Set(people.map(p => p.id));
    const inn = {};
    let elsewhere = 0;
    for (const p of people) inn[p.id] = IN_KEYS.includes(p.id) ? a[p.id] : 0;
    for (const k of IN_KEYS) if (!ids.has(k)) elsewhere += a[k];
    inn.unassigned = a.unassigned + elsewhere;
    inn.other = a.interest;
    inn.total = a.moneyIn;
    const out = { essentials: g.essentials, flexible: g.flexible, irregular: g.irregular, card: a.cardNet, bank: a.bankNet, debt: a.debt, business: a.business, invest: a.investNet };
    out.other = out.debt + out.business + out.invest;
    out.total = out.card + out.bank + out.other;
    return { in: inn, out, savings: a.savingsNet, net: a.left, combinedChange: inn.total - out.total };
  }

  function dialKeyOf(item, people) {
    switch (item.role) {
      case 'card': case 'bank': return 'irregular';
      case 'savings': return 'savings';
      case 'debt': case 'business': case 'investment': return 'other';
      case 'credit': return item.who && people.some(p => p.id === item.who) ? item.who : 'inOther';
      case 'interest': return 'inOther';
      default: return null;
    }
  }

  function oneOffItem(x, people, auto) {
    return {
      id: x.id, date: x.date, month: x.date.slice(0, 7), merchant: x.merchant, description: x.description, accountLabel: x.accountLabel,
      role: x.role, dialKey: dialKeyOf(x, people), cents: x.cents, auto,
    };
  }
  const spendCentsOf = list => list.reduce((s, o) => s + (o.role === 'card' || o.role === 'bank' ? o.cents : 0), 0);

  // ------------------------------------------------------------------ series (Trends)

  /**
   * The series the chart can draw as lines, aligned with `months`. First the monthly amounts
   * (kind 'flow', unit 'perMonth'): actual months from what happened (null when the month is not
   * complete), partial and plan months from the plan. Then the balances (balanceSeriesOf).
   */
  function seriesOf(months, people, balances) {
    const col = f => months.map(m => { const v = f(m); return v === undefined ? null : v; });
    const list = people.map(p => ({ key: 'in-' + p.id, name: p.name, group: 'in', kind: 'flow', unit: 'perMonth', values: col(m => m.in[p.id]) }));
    const value = {
      'in-other': m => sumKnown([m.in.unassigned, m.in.other]),
      'in-total': m => m.in.total,
      'card': m => m.out.card,
      'bank': m => m.out.bank,
      'essentials': m => m.out.essentials,
      'flexible': m => m.out.flexible,
      'irregular': m => m.out.irregular,
      'other-out': m => m.out.other,
      'out-total': m => m.out.total,
      'to-savings': m => (m.savings === null ? null : Math.max(0, m.savings)),
      'from-savings': m => (m.savings === null ? null : Math.max(0, 0 - m.savings)),
      'net': m => m.net,
      'combined-change': m => m.combinedChange,
    };
    for (const s of SERIES) list.push({ key: s.key, name: s.name, group: s.group, kind: 'flow', unit: 'perMonth', values: col(value[s.key]) });
    return list.concat(balanceSeriesOf(balances));
  }

  /**
   * The balance series (kind 'balance', unit 'atMonthEnd', group 'balances'): month-end cents of
   * each balance line there is, aligned with the months like its points (null where the line is
   * not known; projected months included). balance-combined: the combined line (either mode);
   * 'balance-' + account id: each account's line, named after the account; balance-savings-total:
   * the savings accounts' lines added up, when there are two or more (null in a month where any of
   * them is unknown). An account whose id would give one of the fixed keys has no series of its own.
   */
  function balanceSeriesOf(balances) {
    const [combined, savingsTotal] = BALANCE_SERIES;
    const line = (key, name, values) => ({ key, name, group: 'balances', kind: 'balance', unit: 'atMonthEnd', values });
    const list = [];
    if (balances.combined) list.push(line(combined.key, combined.name, balances.combined.points.map(p => p.cents)));
    for (const a of balances.accounts) {
      const key = BALANCE_SERIES_PREFIX + a.id;
      if (!BALANCE_SERIES.some(s => s.key === key)) list.push(line(key, a.name + ' balance', a.points.map(p => p.cents)));
    }
    const savings = balances.accounts.filter(a => a.group === 'savings');
    if (savings.length >= 2) list.push(line(savingsTotal.key, savingsTotal.name, savings[0].points.map((p, i) => sumKnown(savings.map(a => a.points[i].cents)))));
    return list;
  }

  // ------------------------------------------------------------------ build

  /**
   * Everything the plan screen shows, in one call.
   * @param {{ txns: object[], dataset: object, plan: object, settings?: object, today: string,
   *   coverageMap?: object }} input
   *   txns: effective transactions (ledger.applyEdits, no what-if; planning-baseline edits are
   *   read from them); plan: state.plan (plan.changes: planned changes); settings: state.ui.plan;
   *   today: 'YYYY-MM-DD' (explicit, so results are reproducible); coverageMap:
   *   ledger.coverageMap(dataset) when already known.
   * @returns {object} see docs/ARCHITECTURE.md (BudgetEngine.timeline)
   */
  function build(input) {
    if (!isObj(input) || !isObj(input.dataset)) throw new E.ValidationError('The timeline needs the data set.', 'dataset');
    if (!E.dates.isDate(input.today)) throw new E.ValidationError('The timeline needs today’s date (YYYY-MM-DD).', 'today');
    const dataset = input.dataset;
    const txns = Array.isArray(input.txns) ? input.txns : [];
    const plan = isObj(input.plan) ? input.plan : {};
    const cfg = settings(input.settings);
    const today = input.today;
    const todayMonth = today.slice(0, 7);
    const people = (Array.isArray(plan.people) ? plan.people : []).filter(p => isObj(p) && typeof p.id === 'string' && p.id)
      .map(p => ({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id }));

    const dataMonths = E.ledger.months(dataset);
    const cov = isObj(input.coverageMap) ? input.coverageMap : E.ledger.coverageMap(dataset);
    const covOf = m => cov[m] || null;
    let lastComplete = null;
    for (let i = dataMonths.length - 1; i >= 0; i--) if (covOf(dataMonths[i]) && covOf(dataMonths[i]).status === 'full') { lastComplete = dataMonths[i]; break; }
    const planStart = lastComplete ? E.months.add(lastComplete, 1) : (dataMonths.length ? dataMonths[0] : todayMonth);
    const lastMonth = E.months.add(planStart, cfg.horizon - 1);

    const rows = E.flows.breakdown(txns, dataset, { months: dataMonths, coverageMap: cov, plan });
    const full = rows.filter(r => r.actual).length;
    const requested = cfg.baselineMonths;
    const base = E.flows.baseline(rows, { count: requested === 'all' ? Math.max(full, 1) : requested, endMonth: lastComplete || undefined });
    const byId = new Map(txns.map(t => [t.id, t]));
    // Pay saved in Budget for the first plan month (ended streams out, later ones not yet in).
    let funding = null;
    try { funding = E.flows.planFunding(plan, { month: planStart, timing: 'average' }); } catch (err) { funding = null; }
    const { dials, parts, windowText, legacy, superseded, carriedOver } = buildDials({ base, people, cfg, byId, requested, funding });
    const planValues = planMonth(dials, parts, people, false);

    // What happened so far in partly covered months (kept apart from the month's amounts).
    const partial = dataMonths.filter(m => covOf(m) && covOf(m).status === 'partial');
    const soFar = new Map(E.flows.breakdown(txns, dataset, { months: partial, coverageMap: Object.fromEntries(partial.map(m => [m, { status: 'full' }])), plan }).map(r => [r.month, r]));
    // One-time or not, for every purchase in a month with data: the baseline window's own
    // classification (the irregular dial's items), else one over every month with data.
    const wide = rows.map(r => soFar.get(r.month) || r).filter(r => r.actual);
    const kindOf = new Map();
    if (wide.length) for (const x of E.flows.baseline(wide, { count: wide.length }).spends) kindOf.set(x.id, x.kind);
    for (const x of base.spends) kindOf.set(x.id, x.kind);
    const groupsOf = list => spendGroups(list, kindOf, byId, cfg);
    const autoOneTime = base.oneTime.filter(o => o.auto).map(o => oneOffItem(o, people, true));
    const oneOffsIn = (r, m) => {
      const manual = r.oneOffs.map(o => oneOffItem(o, people, false));
      const seen = new Set(manual.map(o => o.id));
      return manual.concat(autoOneTime.filter(o => o.month === m && !seen.has(o.id)));
    };
    const changes = readChanges(plan);

    // Months: from the first month with data, or earlier when a balance is known before it.
    const anc = anchors(plan, dataset, txns);
    let first = dataMonths.length ? dataMonths[0] : planStart;
    const earlier = d => { if (E.dates.isDate(d) && d.slice(0, 7) < first) first = d.slice(0, 7); };
    for (const a of E.balances.cashAccounts(dataset)) {
      const starts = a.coverage.map(r => r.start).filter(E.dates.isDate).sort();
      if (starts.length && anc.accounts.some(x => x.id === a.id)) earlier(E.dates.addDays(starts[0], -1));
    }
    const mirrors = mirrorPlan(anc, dataset, txns);
    for (const m of mirrors.byId.values()) {
      const starts = m.source.coverage.map(r => r.start).filter(E.dates.isDate).sort();
      if (starts.length) earlier(E.dates.addDays(starts[0], -1));
    }
    for (const d of Object.values(anc.enteredAsOf)) earlier(d);
    for (const a of anc.accounts) if (a.source !== 'entered') earlier(a.asOf);
    if (anc.simple && anc.combined && anc.combined.asOf) earlier(anc.combined.asOf);
    if (first > planStart) first = planStart;
    let months = E.months.range(first, lastMonth);

    const rowByMonth = new Map(rows.map(r => [r.month, r]));
    const monthRows = months.map(m => {
      const c = covOf(m);
      const coverage = c ? c.status : 'none';
      const r = rowByMonth.get(m);
      const sf = soFar.get(m);
      const actualSoFar = sf && sf.actual ? Object.assign(fromActual(sf.actual, people, groupsOf(sf.spends)), {
        oneOffs: oneOffsIn(sf, m), oneOffCents: spendCentsOf(oneOffsIn(sf, m)), coveredDays: c.coveredDays, totalDays: c.totalDays,
      }) : null;
      if (m < planStart) {
        if (r && r.actual) {
          const oneOffs = oneOffsIn(r, m);
          return Object.assign({ month: m, status: 'actual', current: m === todayMonth, complete: true, coverage }, fromActual(r.actual, people, groupsOf(r.spends)),
            { oneOffs, oneOffCents: spendCentsOf(oneOffs), actualSoFar: null, changesApplied: [], baseline: null });
        }
        return { month: m, status: 'actual', current: m === todayMonth, complete: false, coverage, in: IN_EMPTY(people), out: OUT_EMPTY(), savings: null, net: null, combinedChange: null,
          oneOffs: [], oneOffCents: null, actualSoFar, changesApplied: [], baseline: null };
      }
      const row = {
        month: m, status: coverage === 'partial' ? 'partial' : 'plan', current: m === todayMonth, complete: false, coverage,
        in: Object.assign({}, planValues.in), out: Object.assign({}, planValues.out), savings: planValues.savings, net: planValues.net, combinedChange: planValues.combinedChange,
        oneOffs: [], oneOffCents: 0, actualSoFar, changesApplied: [], baseline: null,
      };
      for (const ch of changes) {
        if (!ch.accepted || ch.cents === null || !changeActiveIn(ch, m)) continue;
        applyChange(row, ch, people);
        row.changesApplied.push({ id: ch.id, label: ch.label, group: ch.group, cents: ch.cents });
      }
      return row;
    });
    const changeSummary = summarizeChanges(changes, monthRows, planStart);
    const changedBy = { dials: dials.some(d => d.source !== 'baseline'), changes: changeSummary.applied > 0 };
    const changed = changedBy.dials || changedBy.changes;
    // The plan with no changes (every dial at its baseline, no planned changes): the chart's ghost.
    const ghost = changed ? planMonth(dials, parts, people, true) : null;
    if (ghost) for (const r of monthRows) if (r.month >= planStart) r.baseline = { in: ghost.in.total, out: ghost.out.total, savings: ghost.savings, net: ghost.net, combinedChange: ghost.combinedChange };
    const rowsByMonth = new Map(monthRows.map(r => [r.month, r]));
    const balanceInput = { txns, dataset, plan, months, cfg, today, anc, mirrors };
    const balances = balancesFor(Object.assign({ rowsByMonth }, balanceInput));
    if (balances.combined) {
      balances.combined.baselinePoints = null;
      if (ghost) {
        const ghostRows = new Map(monthRows.map(r => [r.month, r.month >= planStart ? Object.assign({}, r, { in: ghost.in, out: ghost.out, savings: ghost.savings, net: ghost.net }) : r]));
        const g = balancesFor(Object.assign({ rowsByMonth: ghostRows }, balanceInput));
        balances.combined.baselinePoints = balances.combined.points.map((p, i) => (p.status === 'projected' && g.combined ? g.combined.points[i].cents : null));
      }
    }

    // Leading months before the data with no known balance add nothing: drop them.
    const dataStart = dataMonths.length ? dataMonths[0] : planStart;
    let drop = 0;
    while (drop < months.length && months[drop] < dataStart) {
      const known = (balances.combined && balances.combined.points[drop].cents !== null) || balances.accounts.some(a => a.points[drop].cents !== null);
      if (known) break;
      drop++;
    }
    if (drop) {
      months = months.slice(drop);
      monthRows.splice(0, drop);
      for (const a of balances.accounts) a.points = a.points.slice(drop);
      if (balances.combined) {
        balances.combined.points = balances.combined.points.slice(drop);
        if (balances.combined.baselinePoints) balances.combined.baselinePoints = balances.combined.baselinePoints.slice(drop);
      }
    }

    const pastFrom = cfg.past === 'all' ? months[0] : (E.months.add(planStart, 0 - cfg.past) < months[0] ? months[0] : E.months.add(planStart, 0 - cfg.past));
    const spendOneTime = base.oneTime.map(o => oneOffItem(o, people, o.auto));
    const seen = new Set(spendOneTime.map(o => o.id));
    const otherOneTime = base.oneOffs.filter(o => !seen.has(o.id) && o.role !== 'card' && o.role !== 'bank').map(o => oneOffItem(o, people, false));
    const oneTime = spendOneTime.concat(otherOneTime);
    const dialsByKey = Object.fromEntries(dials.map(d => [d.key, d]));
    // Settings saved under the earlier card/bank dials: row changes (which still apply, and which
    // cannot) and amounts set for the dials themselves (carried over to the spending dials).
    const legacyIds = Object.keys(cfg.rows).filter(id => LEGACY_DIALS.some(k => id.startsWith(k + '-'))).sort();
    const dialMigration = legacyDialsPlan(dialsByKey, cfg);
    let migration = null;
    if (legacyIds.length || dialMigration) {
      const moved = legacy.slice().sort((a, b) => (a.from < b.from ? -1 : 1));
      const dropped = legacyIds.filter(id => !moved.some(l => l.from === id));
      const rowsNote = !legacyIds.length ? null : ('ui.plan.rows: spending is now planned as essentials, flexible and irregular. '
        + (moved.length ? plural(moved.length, 'change') + ' to card and bank spending rows now apply to the same rows there. ' : '')
        + (dropped.length ? plural(dropped.length, 'change') + ' to card and bank spending rows could not be matched to a row in the new grouping and ' + (dropped.length === 1 ? 'was' : 'were') + ' removed.' : '')).trim();
      migration = {
        rows: moved, dropped, superseded: superseded.slice().sort(), rowsNote, dials: dialMigration,
        // What to tell the household, once: the row note (without its path) and the dial note.
        note: [rowsNote ? rowsNote.replace(/^ui\.plan\.rows: /, '') : null, dialMigration ? dialMigration.note : null].filter(Boolean).join(' '),
      };
    }

    return {
      today, todayMonth, planStart, lastComplete, firstMonth: months[0], lastMonth, horizon: cfg.horizon,
      months: monthRows,
      window: { past: cfg.past, from: pastFrom, to: lastMonth, fromIndex: months.indexOf(pastFrom) },
      people,
      dials, dialsByKey,
      groups: { in: dials.filter(d => d.group === 'in').map(d => d.key), out: OUT_DIALS.filter(k => dialsByKey[k]) },
      plan: planValues,
      changed, changedBy,
      changes: changeSummary,
      baseline: {
        setting: requested, count: base.count, months: base.months, start: base.start, end: base.end, label: windowText,
        oneTime, oneTimeCents: spendCentsOf(oneTime),
        keptIn: base.keptRegular.map(o => oneOffItem(o, people, true)),
        yearly: base.yearly.map(o => Object.assign(oneOffItem(o, people, true), { spreadCents: o.spreadCents })),
        regularAt: base.regularAt,
        plan: ghost,
      },
      balances,
      series: seriesOf(monthRows, people, balances),
      migration,
      carriedOver,
      settings: cfg,
    };
  }

  // ------------------------------------------------------------------ the public API
  // Assembled from the parts, which have all loaded by now: the same names, in the same order, as
  // when the timeline was one file.
  Object.assign(T, { OUT_DIALS, build });
  const PUBLIC = [
    'BASELINE_CHOICES', 'HORIZONS', 'PAST_CHOICES', 'MODES', 'DEFAULTS', 'TREND_MA', 'TREND_DEFAULTS', 'SPEND_GROUPS', 'SPEND_DIALS', 'LEGACY_DIALS', 'OUT_DIALS', 'MERCHANT_KEY', 'CHANGE_KINDS', 'CHANGE_GROUPS', 'SERIES',
    'TINY_CATEGORY_CENTS', 'STABLE_MIN_CHARGES', 'STABLE_SPREAD', 'OTHER_CATEGORY', 'SIMPLE_LABEL', 'RULE', 'SIMPLE_RULE', 'ILLUSTRATIVE', 'DIAL_LABEL',
    'build', 'anchors', 'settings', 'depositHint', 'prorate', 'toCSV', 'templates',
    'setDial', 'setRow', 'resetDial', 'resetPlan', 'setGroup', 'setIrregular', 'addChange', 'setChange', 'removeChange', 'acceptChanges', 'migrateRows', 'migrateDials', 'acceptCarriedOver',
    'pendingUpgrade',
  ];
  const missing = PUBLIC.filter(k => T[k] === undefined);
  if (missing.length) throw new Error('BudgetEngine.timeline: ' + missing.join(', ') + ' not loaded (src/manifest.json lists every timeline-*.js file before timeline.js).');
  E.timeline = Object.fromEntries(PUBLIC.map(k => [k, T[k]]));
})(typeof globalThis !== 'undefined' ? globalThis : this);
