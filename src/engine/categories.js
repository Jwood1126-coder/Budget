'use strict';
/*
 * Default household category taxonomy. Categories are plain strings so imported data and
 * user corrections may introduce new ones; unknown names fall into the 'Other' group.
 * `seasonal` marks categories whose normal level depends on the time of year (heating,
 * cooling). Comparisons judge those against the same month last year instead of the
 * trailing average.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const UNCATEGORIZED = 'Uncategorized';
  const MIXED_RETAIL = 'Mixed retail';

  const DEFAULT = [
    { name: 'Mortgage', group: 'Housing', essential: true },
    { name: 'Home maintenance & repairs', group: 'Housing', essential: true },
    { name: 'Home improvement', group: 'Housing' },
    { name: 'Property tax & HOA', group: 'Housing', essential: true },
    { name: 'Gas & heating', group: 'Utilities', essential: true, seasonal: true },
    { name: 'Electric', group: 'Utilities', essential: true, seasonal: true },
    { name: 'Water & sewer', group: 'Utilities', essential: true },
    { name: 'Trash & municipal', group: 'Utilities', essential: true },
    { name: 'Internet & phone', group: 'Utilities', essential: true },
    { name: 'Groceries', group: 'Food', essential: true },
    { name: 'Dining & takeout', group: 'Food' },
    { name: MIXED_RETAIL, group: 'Shopping' },
    { name: 'Household & hardware', group: 'Shopping' },
    { name: 'Clothing', group: 'Shopping' },
    { name: 'Electronics', group: 'Shopping' },
    { name: 'Fuel', group: 'Transportation', essential: true },
    { name: 'Auto maintenance', group: 'Transportation', essential: true },
    { name: 'Auto insurance', group: 'Transportation', essential: true },
    { name: 'Parking & tolls', group: 'Transportation' },
    { name: 'Rideshare & transit', group: 'Transportation' },
    { name: 'Medical & pharmacy', group: 'Health', essential: true },
    { name: 'Dental', group: 'Health', essential: true },
    { name: 'Vision', group: 'Health', essential: true },
    { name: 'Home insurance', group: 'Insurance', essential: true },
    { name: 'Life insurance', group: 'Insurance', essential: true },
    { name: 'Other insurance', group: 'Insurance' },
    { name: 'Baby & childcare', group: 'Family', essential: true },
    { name: 'Pets', group: 'Family', essential: true },
    { name: 'Personal care', group: 'Family' },
    { name: 'Education', group: 'Family' },
    { name: 'Entertainment', group: 'Leisure' },
    { name: 'Subscriptions', group: 'Leisure' },
    { name: 'Hobbies', group: 'Leisure' },
    { name: 'Travel', group: 'Travel' },
    { name: 'Gifts & donations', group: 'Giving' },
    { name: 'Fees & interest', group: 'Fees' },
    { name: 'Cash withdrawals', group: 'Other' },
    { name: UNCATEGORIZED, group: 'Other' }
  ];

  const GROUP_ORDER = ['Housing', 'Utilities', 'Food', 'Shopping', 'Transportation', 'Health', 'Insurance', 'Family', 'Leisure', 'Travel', 'Giving', 'Fees', 'Other'];

  const byName = new Map(DEFAULT.map(c => [c.name, c]));

  function find(name) { return byName.get(name) || null; }
  function groupOf(name) { return byName.get(name)?.group || 'Other'; }
  function isSeasonal(name, extraSeasonal) {
    if (Array.isArray(extraSeasonal) && extraSeasonal.includes(name)) return true;
    return !!byName.get(name)?.seasonal;
  }
  function isEssential(name) { return !!byName.get(name)?.essential; }
  function names() { return DEFAULT.map(c => c.name); }
  /** Sort category names by group order then by the taxonomy order; unknown names last, alphabetically. */
  function sortNames(list) {
    const order = new Map(DEFAULT.map((c, i) => [c.name, i]));
    return [...list].sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(groupOf(a)), gb = GROUP_ORDER.indexOf(groupOf(b));
      if (ga !== gb) return ga - gb;
      const ia = order.has(a) ? order.get(a) : 1e6, ib = order.has(b) ? order.get(b) : 1e6;
      return ia !== ib ? ia - ib : a.localeCompare(b);
    });
  }

  E.categories = { DEFAULT, GROUP_ORDER, UNCATEGORIZED, MIXED_RETAIL, find, groupOf, isSeasonal, isEssential, names, sortNames };
})(typeof globalThis !== 'undefined' ? globalThis : this);
