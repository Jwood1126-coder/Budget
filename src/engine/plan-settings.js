'use strict';
/*
 * BudgetEngine.planSettings — the plan screen's vocabulary, defined once (docs/ARCHITECTURE.md §7).
 *
 * Two modules need these names when they load: BudgetEngine.timeline, which draws the plan, and
 * BudgetEngine.state, which saves the household's plan settings in ui.plan. This file loads
 * before both (src/manifest.json) and both read their copies from here, so they cannot drift.
 * Data only (plus isBalanceSeries, the pattern for the per-account balance series keys). The rules
 * for each ui.plan field (default, limit, how it is checked and written) are the one descriptor
 * table in state.js (PLAN_UI), which builds on these lists.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const list = items => Object.freeze(items.slice());

  /** The two people a plan holds (plan.people ids); each has a money-in dial on the plan screen. */
  const PEOPLE = list(['p1', 'p2']);
  /** The plan screen's dials: money in per person and other, money out by how adjustable it is. */
  const DIAL_KEYS = list(PEOPLE.concat(['inOther', 'essentials', 'flexible', 'irregular', 'savings', 'other']));
  /**
   * Card and bank spending were dials before spending was grouped by how adjustable it is; now
   * they are worked out from the spending dials. An amount saved for one waits in
   * ui.plan.legacyDials until the plan screen carries it over (BudgetEngine.timeline.migrateDials).
   * Row ids saved under them start with 'card-' / 'bank-'.
   */
  const RETIRED_DIALS = list(['card', 'bank']);
  /** The groups of everyday spending, by how adjustable it is (ui.plan.groups values). */
  const SPEND_GROUPS = list(['essentials', 'flexible']);
  /** The spending dials: each has a card and a bank part; a direct amount can keep its card part (ui.plan.cardSplit). */
  const SPEND_DIALS = list(['essentials', 'flexible', 'irregular']);
  /** Planned changes (plan.changes): one-time or monthly, added to one group. */
  const CHANGE_KINDS = list(['oneTime', 'monthly']);
  const CHANGE_GROUPS = list(['income', 'essentials', 'flexible', 'irregular', 'savings']);

  /** The monthly series the Trends chart can draw besides one per person ('in-' + person id, first). */
  const SERIES = list([
    { key: 'in-other', name: 'Other money in', group: 'in' },
    { key: 'in-total', name: 'All money in', group: 'in' },
    { key: 'card', name: 'Card purchases', group: 'out' },
    { key: 'bank', name: 'Paid from the bank', group: 'out' },
    { key: 'essentials', name: 'Essentials', group: 'out' },
    { key: 'flexible', name: 'Flexible spending', group: 'out' },
    { key: 'irregular', name: 'Irregular costs', group: 'out' },
    { key: 'other-out', name: 'Debt, business & investments', group: 'out' },
    { key: 'out-total', name: 'All money out', group: 'out' },
    { key: 'to-savings', name: 'Into savings', group: 'savings' },
    { key: 'from-savings', name: 'Out of savings', group: 'savings' },
    { key: 'net', name: 'Left in checking', group: 'net' },
    { key: 'combined-change', name: 'Change in joint cash', group: 'net' },
  ].map(s => Object.freeze(s)));
  /**
   * The Trends chart's balance series (month-end amounts, not amounts per month), besides one per
   * cash account with a balance line (BALANCE_SERIES_PREFIX + account id, named after the
   * account): joint cash combined, and the savings accounts together (when there are two or more).
   */
  const BALANCE_SERIES_PREFIX = 'balance-';
  const BALANCE_SERIES = list([
    { key: 'balance-combined', name: 'Combined cash', group: 'balances' },
    { key: 'balance-savings-total', name: 'Savings total', group: 'balances' },
  ].map(s => Object.freeze(s)));
  /** A balance series key: one of BALANCE_SERIES, or 'balance-' + an account id. */
  const isBalanceSeries = key => typeof key === 'string' && key.length > BALANCE_SERIES_PREFIX.length && key.startsWith(BALANCE_SERIES_PREFIX);
  /**
   * Every series key ui.plan.trends.series can hold: the person series, then SERIES, as listed;
   * and the balance series, which its `includes` accepts as well (account ids come with the data,
   * so they cannot be listed here).
   */
  const TREND_SERIES = (() => {
    const keys = PEOPLE.map(p => 'in-' + p).concat(SERIES.map(s => s.key));
    Object.defineProperty(keys, 'includes', { value: (key, from) => Array.prototype.includes.call(keys, key, from) || isBalanceSeries(key) });
    return Object.freeze(keys);
  })();

  // The choices the plan screen offers for its scalar settings, and their defaults.
  const BASELINE_CHOICES = list([3, 6, 12, 'all']);
  const HORIZONS = list([6, 12, 24, 60]);
  const PAST_CHOICES = list([6, 12, 'all']);
  const MODES = list(['balance', 'flows', 'trends']);
  const TREND_MA = list([0, 3, 6]);
  const DEFAULTS = Object.freeze({ baselineMonths: 12, horizon: 12, past: 12, mode: 'balance', coverFromSavings: true });
  const TREND_DEFAULTS = Object.freeze({ series: list(['card']), ma: 3, trend: true });

  E.planSettings = Object.freeze({
    PEOPLE, DIAL_KEYS, RETIRED_DIALS, SPEND_GROUPS, SPEND_DIALS, CHANGE_KINDS, CHANGE_GROUPS, SERIES, TREND_SERIES,
    BALANCE_SERIES, BALANCE_SERIES_PREFIX, isBalanceSeries,
    BASELINE_CHOICES, HORIZONS, PAST_CHOICES, MODES, TREND_MA, DEFAULTS, TREND_DEFAULTS,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
