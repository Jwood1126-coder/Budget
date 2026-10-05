'use strict';
/*
 * BudgetEngine.timeline: planned changes (plan.changes), the changes the plan works out from
 * Budget (bills that start or end, savings goals spent at their target), and the ready-made
 * packs (templates) (timeline-core.js says how the timeline files fit together).
 *
 * Adds to E._timeline: readChanges, changeActiveIn, applyChange, summarizeChanges, billChanges,
 * goalChanges, templates.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, own, fail, CHANGE_KINDS, CHANGE_GROUPS } = T;

  // ------------------------------------------------------------------ planned changes

  /** plan.changes, checked (the engine never trusts its input): unusable entries are skipped. */
  function readChanges(plan) {
    const list = Array.isArray(plan.changes) ? plan.changes : [];
    return list.filter(c => isObj(c) && typeof c.id === 'string' && c.id && CHANGE_KINDS.includes(c.kind) && CHANGE_GROUPS.includes(c.group) && E.months.isMonth(c.startMonth))
      .map(c => ({
        id: c.id, label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : c.id, kind: c.kind, group: c.group,
        personId: c.group === 'income' && typeof c.personId === 'string' && c.personId ? c.personId : null,
        startMonth: c.startMonth,
        endMonth: c.kind === 'monthly' && E.months.isMonth(c.endMonth) && c.endMonth >= c.startMonth ? c.endMonth : null,
        cents: isCents(c.cents) ? c.cents : null, accepted: c.accepted === true,
        template: typeof c.template === 'string' && c.template ? c.template : null,
        scenario: typeof c.scenario === 'string' && c.scenario.trim() ? c.scenario.trim() : null,
        note: typeof c.note === 'string' ? c.note : '',
        source: 'plan', readOnly: false,
      }));
  }

  const changeActiveIn = (c, m) => (c.kind === 'oneTime' ? m === c.startMonth : m >= c.startMonth && (c.endMonth === null || m <= c.endMonth));

  /**
   * Add one planned change to a plan month's amounts: income to its person (other money in when
   * no person, or a person not in the plan), spending to its group and to bank-paid spending,
   * savings to net to savings. Changes worked out from Budget also use 'debt' (a debt-payment
   * bill: debt & business), and `fromSavings` (a savings goal spent: the amount leaves savings
   * and is spent as irregular). Unknown amounts stay unknown.
   */
  function applyChange(row, c, people) {
    const add = (a, b) => (a === null ? null : a + b);
    if (c.group === 'income') {
      const key = c.personId && people.some(p => p.id === c.personId) ? c.personId : 'other';
      row.in[key] = add(row.in[key], c.cents);
      row.in.total = add(row.in.total, c.cents);
    } else if (c.group === 'savings') {
      row.savings = add(row.savings, c.cents);
    } else if (c.group === 'debt') {
      row.out.debt = add(row.out.debt, c.cents);
      row.out.other = add(row.out.other, c.cents);
      row.out.total = add(row.out.total, c.cents);
    } else {
      row.out[c.group] = add(row.out[c.group], c.cents);
      row.out.bank = add(row.out.bank, c.cents);
      row.out.total = add(row.out.total, c.cents);
      if (c.fromSavings) row.savings = add(row.savings, 0 - c.cents);
    }
    row.net = row.in.total === null || row.out.total === null || row.savings === null ? null : row.in.total - row.out.total - row.savings;
    row.combinedChange = row.in.total === null || row.out.total === null ? null : row.in.total - row.out.total;
  }

  /**
   * What the planned changes did: each change with its status ('unset': no amount yet, never
   * applied; 'notAccepted': listed only; 'applied'; 'overridden': worked out from Budget for a
   * dial's baseline while the household set that dial directly (`overridden(c)` says so), so not
   * applied; 'outside': no plan month in its dates), monthsApplied and appliedCents (the ones
   * worked out from Budget too, source 'bill'|'goal').
   * applied, unset and the totals are over the household's own changes (source 'plan'); derived
   * counts the others. Totals count money out of checking as positive (spending and savings +,
   * income −): totalOneTimeCents over the applied one-time changes, monthlyNowCents over the
   * monthly changes applied in the first plan month.
   */
  function summarizeChanges(changes, monthRows, planStart, overridden) {
    const applied = new Map();
    for (const r of monthRows) for (const a of r.changesApplied) applied.set(a.id, (applied.get(a.id) || 0) + 1);
    const list = changes.map(c => {
      const monthsApplied = applied.get(c.id) || 0;
      const status = c.cents === null ? 'unset' : !c.accepted ? 'notAccepted' : monthsApplied ? 'applied' : overridden && overridden(c) ? 'overridden' : 'outside';
      return Object.assign({}, c, { status, monthsApplied, appliedCents: monthsApplied ? monthsApplied * c.cents : 0 });
    });
    const cost = c => (c.group === 'income' ? 0 - c.cents : c.cents);
    const first = monthRows.find(r => r.month === planStart);
    // The counts and totals are the household's own changes; the ones worked out from Budget are only listed.
    const own = list.filter(c => c.source === 'plan');
    const byId = new Map(own.map(c => [c.id, c]));
    return {
      list,
      applied: own.filter(c => c.status === 'applied').length,
      derived: list.length - own.length,
      unset: own.filter(c => c.cents === null).map(c => c.id),
      totalOneTimeCents: own.filter(c => c.status === 'applied' && c.kind === 'oneTime').reduce((s, c) => s + cost(c), 0),
      monthlyNowCents: first ? first.changesApplied.filter(a => byId.has(a.id) && byId.get(a.id).kind === 'monthly').reduce((s, a) => s + cost(byId.get(a.id)), 0) : 0,
    };
  }

  // ------------------------------------------------------------------ changes worked out from Budget

  /**
   * Joint-paid bills with a known amount fill the plan's gaps and end what ends. A bill is SEEN
   * when the baseline window already holds it, so the dials already count it:
   *   - a debt-payment bill (type 'debt'): any debt payment in the baseline months;
   *   - any other bill with a category: any card or bank purchase in the baseline months (one-time,
   *     yearly, regular or everyday; refunds do not count) with a part in that category.
   * A bill with status 'planned', or a start month after the plan start, is never seen, whatever
   * the history holds (it is not being paid yet). From the plan start on:
   *   - seen, with an end month on or after the baseline's first month: from the month after it
   *     (or the plan start, when later) its amount is taken back out ("<label> ends");
   *   - not seen: added from its start month (or the plan start, when later) through its end
   *     month, to essentials, or to debt & business for a debt payment.
   * Left alone: bills paid personally (fundedFrom p1/p2) or by nobody known, amounts not entered or
   * $0, a bill that is not a debt payment and has no category (it cannot be matched to the
   * history, so it is never added: that could count it twice), and a bill whose category has a
   * budget (plan.targets): the budget already plans that category. Each change made is read-only
   * on the plan (the bill is edited in Budget): { …a planned change, source: 'bill', billId,
   * readOnly: true, accepted: true }. `bills` says what happened to every bill.
   * @returns {{ changes: object[], bills: { id, label, status, changeId }[] }}
   *   status: 'seen' | 'ends' | 'added' | 'ended' | 'notJoint' | 'noAmount' | 'noCategory' | 'inBudget'
   */
  function billChanges({ plan, base, byId, planStart, targets }) {
    const list = Array.isArray(plan.bills) ? plan.bills : [];
    const cats = new Set();
    for (const x of base.spends || []) {
      if (!(x.cents > 0)) continue;
      const t = byId.get(x.id);
      const parts = t ? E.ledger.partsOf(t) : [];
      if (parts.length) { for (const p of parts) if (p.spendCents > 0) cats.add(p.category); } else if (t) cats.add(t.category);
    }
    const debtSeen = !!(base.total && base.total.actual && base.total.actual.debt > 0);
    const windowStart = base.start || planStart;
    const changes = [], bills = [];
    for (const b of list) {
      if (!isObj(b) || typeof b.id !== 'string' || !b.id) continue;
      const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : b.id;
      const info = { id: b.id, label, status: null, changeId: null };
      bills.push(info);
      const isDebt = b.type === 'debt';
      const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null;
      if (b.fundedFrom !== 'joint') { info.status = 'notJoint'; continue; }
      if (!isCents(b.monthlyCents) || b.monthlyCents <= 0) { info.status = 'noAmount'; continue; }
      if (!isDebt && !category) { info.status = 'noCategory'; continue; }
      if (!isDebt && isCents(own(targets, category))) { info.status = 'inBudget'; continue; }
      const start = E.months.isMonth(b.startMonth) ? b.startMonth : null;
      const end = E.months.isMonth(b.endMonth) && (!start || b.endMonth >= start) ? b.endMonth : null;
      const seen = b.status !== 'planned' && !(start && start > planStart) && (isDebt ? debtSeen : cats.has(category));
      const common = { kind: 'monthly', group: isDebt ? 'debt' : 'essentials', personId: null, accepted: true, template: null, scenario: null, source: 'bill', billId: b.id, readOnly: true };
      if (seen) {
        if (!end || end < windowStart) { info.status = 'seen'; continue; }
        const after = E.months.add(end, 1);
        info.status = 'ends';
        info.changeId = 'bill-' + b.id + '-ends';
        changes.push(Object.assign({}, common, {
          id: info.changeId, label: label + ' ends', startMonth: after > planStart ? after : planStart, endMonth: null, cents: 0 - b.monthlyCents,
          note: 'From Budget: ' + label + ' is in your history and its last payment is in ' + E.months.label(end) + ', so the plan takes ' + E.money.format(b.monthlyCents) + ' a month back out after it. Edit the bill in Budget.',
        }));
        continue;
      }
      if (end && end < planStart) { info.status = 'ended'; continue; }
      info.status = 'added';
      info.changeId = 'bill-' + b.id;
      const why = b.status === 'planned' ? 'it is planned, not paid yet' : start && start > planStart ? 'it starts in ' + E.months.label(start) : 'your history has no payment for it';
      changes.push(Object.assign({}, common, {
        id: info.changeId, label, startMonth: start && start > planStart ? start : planStart, endMonth: end, cents: b.monthlyCents,
        note: 'From Budget: ' + why + ', so the plan adds ' + E.money.format(b.monthlyCents) + ' a month' + (end ? ' through ' + E.months.label(end) : '') + '. Edit the bill in Budget.',
      }));
    }
    return { changes, bills };
  }

  /**
   * Savings goals spent at their target (spendAtTarget, with a targetMonth), as read-only changes
   * { …a planned change, source: 'goal', goalId, readOnly: true, accepted: true }:
   *   - 'goal-<id>' (with targetCents): in the target month the amount leaves savings and is
   *     spent (kind 'oneTime', group 'irregular', fromSavings: true);
   *   - 'goal-<id>-stops' (with monthlyCents above $0): the goals' monthly amounts make up the
   *     savings dial's baseline, and a goal that is spent is no longer saved for: from the month
   *     after its target month (or planStart, when later) net to savings drops by its monthly
   *     amount (kind 'monthly', group 'savings', cents −monthlyCents, open-ended). It carries
   *     `dial: 'savings'`: it belongs to the dial's baseline, so while the household sets net to
   *     savings directly it is not applied (status 'overridden'); the plan at baseline (the
   *     ghost) always has it.
   * @param {object} plan state.plan
   * @param {string} [planStart] the first plan month
   */
  function goalChanges(plan, planStart) {
    const out = [];
    for (const g of Array.isArray(plan.savings) ? plan.savings : []) {
      if (!isObj(g) || typeof g.id !== 'string' || !g.id || g.spendAtTarget !== true || !E.months.isMonth(g.targetMonth)) continue;
      const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim() : g.id;
      const common = { personId: null, endMonth: null, accepted: true, template: null, scenario: null, source: 'goal', goalId: g.id, readOnly: true };
      if (isCents(g.targetCents) && g.targetCents > 0) {
        out.push(Object.assign({}, common, {
          id: 'goal-' + g.id, label: label + ': spent from savings', kind: 'oneTime', group: 'irregular',
          startMonth: g.targetMonth, cents: g.targetCents, fromSavings: true,
          note: 'From Budget: the savings goal is spent in ' + E.months.label(g.targetMonth) + ', so ' + E.money.format(g.targetCents) + ' leaves savings and is spent that month. Edit the goal in Budget.',
        }));
      }
      if (isCents(g.monthlyCents) && g.monthlyCents > 0) {
        const after = E.months.add(g.targetMonth, 1);
        const start = E.months.isMonth(planStart) && planStart > after ? planStart : after;
        out.push(Object.assign({}, common, {
          id: 'goal-' + g.id + '-stops', label: label + ': monthly saving stops', kind: 'monthly', group: 'savings',
          startMonth: start, cents: 0 - g.monthlyCents, dial: 'savings',
          note: 'From Budget: the goal is spent in ' + E.months.label(g.targetMonth) + ', so its ' + E.money.format(g.monthlyCents) + ' a month stops going to savings from '
            + E.months.label(start) + ' (net to savings starts from the goals’ monthly amounts). Not applied while you set net to savings yourself. Edit the goal in Budget.',
        }));
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ templates

  const ESTIMATE = 'A generic estimate: adjust it to your own quotes and plans.';
  /** Baby: generic US estimates, timed from the due month D: [label, kind, group, months from D, cents, end (months from D), note]. */
  const BABY = [
    ['Car seat', 'oneTime', 'irregular', -2, 25000],
    ['Nursery setup (paint, dresser, glider)', 'oneTime', 'irregular', -2, 90000],
    ['Starter clothes and basics', 'oneTime', 'irregular', -1, 25000],
    ['Feeding gear (bottles, pump accessories)', 'oneTime', 'irregular', -1, 20000],
    ['Baby monitor', 'oneTime', 'irregular', -1, 10000],
    ['Crib and mattress (after the bassinet)', 'oneTime', 'irregular', 4, 35000],
    ['Delivery out-of-pocket (insurance deductible/out-of-pocket max)', 'oneTime', 'irregular', 1, 350000, null, 'Check your plan’s deductible and out-of-pocket maximum. ' + ESTIMATE],
    ['Diapers and wipes', 'monthly', 'essentials', 0, 8500],
    ['Formula / feeding', 'monthly', 'essentials', 0, 12000, null, 'About $0 if breastfeeding. ' + ESTIMATE],
    ['Baby food', 'monthly', 'essentials', 6, 7500],
    ['Clothes as they grow', 'monthly', 'flexible', 0, 4500],
    ['Health copays and medicines', 'monthly', 'essentials', 0, 4000],
    ['Childcare', 'monthly', 'essentials', 3, 120000, null, 'Typical infant daycare; set to $0 for family care. ' + ESTIMATE],
    ['Parental leave: income change', 'monthly', 'income', 0, null, 2, 'Enter the monthly reduction in take-home while on leave (as a negative amount). ' + ESTIMATE],
  ];

  /**
   * The packs: generic placeholder estimates in the style of US national averages (not this
   * household's data, not quotes). Each item is an ordinary planned change the household edits,
   * listed but never accepted for them. Rows, timed from a month M: [label, kind, group, months
   * from M, cents, end (months from M; null or absent = open-ended), note].
   */
  const BABY_FIRST_YEAR = [
    ['Car seat and stroller', 'oneTime', 'irregular', -2, 45000],
    ['Nursery and sleep (crib, mattress, dresser)', 'oneTime', 'irregular', -2, 80000],
    ['Starter clothes, feeding gear and basics', 'oneTime', 'irregular', -1, 50000],
    ['Birth: out-of-pocket hospital costs', 'oneTime', 'irregular', 1, 300000, null, 'Check your plan’s deductible and out-of-pocket maximum. ' + ESTIMATE],
    ['Diapers and wipes', 'monthly', 'essentials', 0, 8000, 11],
    ['Formula and feeding', 'monthly', 'essentials', 0, 15000, 11, 'About $0 if breastfeeding. ' + ESTIMATE],
    ['Baby health: copays and medicines', 'monthly', 'essentials', 0, 5000, 11],
    ['Baby clothes as they grow', 'monthly', 'flexible', 0, 4000, 11],
    ['Parental leave: income change', 'monthly', 'income', 0, null, 2, 'Enter the monthly drop in take-home while on leave (as a negative amount). ' + ESTIMATE],
  ];
  /** A child's ongoing costs from age 1 (months from the due month). */
  const KID_COSTS = [
    ['Kid: food', 'monthly', 'essentials', 12, 20000],
    ['Kid: health (copays, dental, medicines)', 'monthly', 'essentials', 12, 8000],
    ['Kid: diapers until potty-trained', 'monthly', 'essentials', 12, 7000, 35],
    ['Kid: clothes and shoes', 'monthly', 'flexible', 12, 6000],
    ['Kid: activities, toys and outings', 'monthly', 'flexible', 12, 10000],
  ];
  /** Childcare's default monthly amount: a typical full-time infant care cost (it varies a lot by area and kind of care). */
  const CHILDCARE_CENTS = 120000;

  /** Items for addChange (no ids: addChange gives each one) from a pack's rows, timed from month `m`. */
  function packItems(rows, m, template, opts) {
    const scenario = isObj(opts) && typeof opts.scenario === 'string' && opts.scenario.trim() ? opts.scenario.trim().slice(0, 60) : null;
    return rows.map(([label, kind, group, from, cents, end, note]) => Object.assign({
      label, kind, group, personId: null, startMonth: E.months.add(m, from),
      endMonth: kind === 'monthly' && Number.isInteger(end) ? E.months.add(m, end) : null,
      cents, accepted: false, template, note: note || ESTIMATE,
    }, scenario ? { scenario } : {}));
  }
  function dueMonth(dueDate) {
    if (!E.dates.isDate(dueDate)) fail('Enter the due date (YYYY-MM-DD).', 'dueDate');
    return dueDate.slice(0, 7);
  }

  /**
   * New baby, the first year (template 'babyFirstYear'), timed from the due month D: gear and
   * nursery before (D−2, D−1), birth costs (D+1), diapers, feeding, health and clothes monthly
   * through D+11, and the parental leave income change (D..D+2) with no amount (null: unknown,
   * never $0) until it is entered. Childcare and the costs from age 1 are packs of their own.
   * @param {string} dueDate 'YYYY-MM-DD'
   * @param {{ scenario?: string }} [opts] scenario: tag every item with a what-if name (≤ 60 characters)
   * @returns {object[]} items for addChange
   */
  const babyFirstYear = (dueDate, opts) => packItems(BABY_FIRST_YEAR, dueMonth(dueDate), 'babyFirstYear', opts);

  /**
   * Childcare (template 'childcare'): one monthly change from `startMonth`, open-ended, at
   * `monthlyCents` (default CHILDCARE_CENTS, $1,200: a placeholder to replace with a quote).
   */
  function childcare(startMonth, monthlyCents, opts) {
    if (!E.months.isMonth(startMonth)) fail('Choose the month childcare starts (YYYY-MM).', 'startMonth');
    if (monthlyCents !== undefined && monthlyCents !== null && !(isCents(monthlyCents) && monthlyCents >= 0)) fail('Enter the monthly cost of childcare in dollars, or leave it empty for the estimate.', 'monthlyCents');
    const cents = isCents(monthlyCents) ? monthlyCents : CHILDCARE_CENTS;
    return packItems([['Childcare', 'monthly', 'essentials', 0, cents, null,
      'Full-time care for a young child; it varies widely by area and by kind of care (a center, a home daycare, family). ' + ESTIMATE]], startMonth, 'childcare', opts);
  }

  /** Kid costs from age 1 (template 'kidCosts'): monthly from D+12 (diapers through D+35), timed from the due date. */
  const kidCosts = (dueDate, opts) => packItems(KID_COSTS, dueMonth(dueDate), 'kidCosts', opts);

  /**
   * The earlier Baby template (template 'baby'), kept exactly as it was while the screen still
   * offers it; new plans use the three packs above (templates.list). Changes saved from it stay
   * exactly as saved.
   * @param {string} dueDate 'YYYY-MM-DD'
   * @returns {object[]} items for addChange (no ids: addChange gives each one)
   */
  function babyTemplate(dueDate) {
    const due = dueMonth(dueDate);
    return BABY.map(([label, kind, group, from, cents, end, note]) => ({
      label, kind, group, personId: null, startMonth: E.months.add(due, from),
      endMonth: kind === 'monthly' && Number.isInteger(end) ? E.months.add(due, end) : null,
      cents, accepted: false, template: 'baby', note: note || ESTIMATE,
    }));
  }
  const templates = {
    list: () => [
      { key: 'babyFirstYear', label: 'New baby: the first year', needs: ['dueDate'] },
      { key: 'childcare', label: 'Childcare', needs: ['startMonth', 'monthlyCents'], defaultCents: CHILDCARE_CENTS },
      { key: 'kidCosts', label: 'Kid costs from age 1', needs: ['dueDate'] },
    ],
    babyFirstYear, childcare, kidCosts,
    baby: babyTemplate,
  };


  Object.assign(T, { readChanges, changeActiveIn, applyChange, summarizeChanges, billChanges, goalChanges, templates });
})(typeof globalThis !== 'undefined' ? globalThis : this);
