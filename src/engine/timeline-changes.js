'use strict';
/*
 * BudgetEngine.timeline: planned changes (plan.changes) and the ready-made ones (templates)
 * (timeline-core.js says how the timeline files fit together).
 *
 * Adds to E._timeline: readChanges, changeActiveIn, applyChange, summarizeChanges, templates.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, fail, CHANGE_KINDS, CHANGE_GROUPS } = T;

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
        template: typeof c.template === 'string' && c.template ? c.template : null, note: typeof c.note === 'string' ? c.note : '',
      }));
  }

  const changeActiveIn = (c, m) => (c.kind === 'oneTime' ? m === c.startMonth : m >= c.startMonth && (c.endMonth === null || m <= c.endMonth));

  /**
   * Add one planned change to a plan month's amounts: income to its person (other money in when
   * no person, or a person not in the plan), spending to its group and to bank-paid spending,
   * savings to net to savings. Unknown amounts stay unknown.
   */
  function applyChange(row, c, people) {
    const add = (a, b) => (a === null ? null : a + b);
    if (c.group === 'income') {
      const key = c.personId && people.some(p => p.id === c.personId) ? c.personId : 'other';
      row.in[key] = add(row.in[key], c.cents);
      row.in.total = add(row.in.total, c.cents);
    } else if (c.group === 'savings') {
      row.savings = add(row.savings, c.cents);
    } else {
      row.out[c.group] = add(row.out[c.group], c.cents);
      row.out.bank = add(row.out.bank, c.cents);
      row.out.total = add(row.out.total, c.cents);
    }
    row.net = row.in.total === null || row.out.total === null || row.savings === null ? null : row.in.total - row.out.total - row.savings;
    row.combinedChange = row.in.total === null || row.out.total === null ? null : row.in.total - row.out.total;
  }

  /**
   * What the planned changes did: each change with its status ('unset': no amount yet, never
   * applied; 'notAccepted': listed only; 'applied'; 'outside': no plan month in its dates),
   * monthsApplied and appliedCents. Totals count money out of checking as positive (spending and
   * savings +, income −): totalOneTimeCents over the applied one-time changes, monthlyNowCents
   * over the monthly changes applied in the first plan month.
   */
  function summarizeChanges(changes, monthRows, planStart) {
    const applied = new Map();
    for (const r of monthRows) for (const a of r.changesApplied) applied.set(a.id, (applied.get(a.id) || 0) + 1);
    const list = changes.map(c => {
      const monthsApplied = applied.get(c.id) || 0;
      const status = c.cents === null ? 'unset' : !c.accepted ? 'notAccepted' : monthsApplied ? 'applied' : 'outside';
      return Object.assign({}, c, { status, monthsApplied, appliedCents: monthsApplied ? monthsApplied * c.cents : 0 });
    });
    const cost = c => (c.group === 'income' ? 0 - c.cents : c.cents);
    const first = monthRows.find(r => r.month === planStart);
    const byId = new Map(list.map(c => [c.id, c]));
    return {
      list,
      applied: list.filter(c => c.status === 'applied').length,
      unset: list.filter(c => c.cents === null).map(c => c.id),
      totalOneTimeCents: list.filter(c => c.status === 'applied' && c.kind === 'oneTime').reduce((s, c) => s + cost(c), 0),
      monthlyNowCents: first ? first.changesApplied.filter(a => byId.get(a.id).kind === 'monthly').reduce((s, a) => s + cost(byId.get(a.id)), 0) : 0,
    };
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
   * The baby template: planned changes timed from the due month, all listed but not accepted
   * (accepted: false) so nothing reaches the plan until the household says so. The parental
   * leave change has no amount (null: unknown, never $0) until it is entered.
   * @param {string} dueDate 'YYYY-MM-DD'
   * @returns {object[]} items for addChange (no ids: addChange gives each one)
   */
  function babyTemplate(dueDate) {
    if (!E.dates.isDate(dueDate)) fail('Enter the due date (YYYY-MM-DD).', 'dueDate');
    const due = dueDate.slice(0, 7);
    return BABY.map(([label, kind, group, from, cents, end, note]) => ({
      label, kind, group, personId: null, startMonth: E.months.add(due, from),
      endMonth: kind === 'monthly' && Number.isInteger(end) ? E.months.add(due, end) : null,
      cents, accepted: false, template: 'baby', note: note || ESTIMATE,
    }));
  }
  const templates = {
    list: () => [{ key: 'baby', label: 'Baby', needs: ['dueDate'] }],
    baby: babyTemplate,
  };

  Object.assign(T, { readChanges, changeActiveIn, applyChange, summarizeChanges, templates });
})(typeof globalThis !== 'undefined' ? globalThis : this);
