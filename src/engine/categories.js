'use strict';
/*
 * Default household category taxonomy. Categories are plain strings so imported data and
 * user corrections may introduce new ones; unknown names fall into the 'Other' group.
 * `seasonal` marks categories whose normal level depends on the time of year (heating,
 * cooling). Comparisons judge those against the same month last year instead of the
 * trailing average. `essential` marks spending that is hard to cut (housing, utilities,
 * groceries, fuel, insurance, routine health, car upkeep, childcare, debt payments): the plan
 * screen groups it as "essentials" and everything else as "flexible" (dining, shopping,
 * entertainment, subscriptions, home improvement, travel, gifts, personal care, pets...).
 * Imported labels that name a taxonomy category in other words ('Natural gas', 'Groceries & meal
 * kits') resolve to it (`resolve`), and the lookups below follow the category they resolve to.
 * An aggregate (AGGREGATES) is a budget name that stands for several taxonomy categories together
 * (the earlier version's combined energy target): it is not a category of its own.
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
    { name: 'Other insurance', group: 'Insurance', essential: true },
    { name: 'Baby & childcare', group: 'Family', essential: true },
    { name: 'Pets', group: 'Family' },
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

  /**
   * Budget names that stand for several taxonomy categories together: name -> members. The
   * earlier version kept electricity and natural gas as one target, migrated under this name
   * (state.ENERGY_TARGET) without guessing a split. The plan counts such a budget once for all of
   * its members (timeline drill-down), and it is essential or seasonal when its members are.
   */
  const AGGREGATES = Object.freeze({
    'Energy (gas + electric, migrated)': Object.freeze(['Gas & heating', 'Electric']),
  });

  /**
   * Labels that name a taxonomy category in other words: the earlier version's category names
   * (the same mapping as its budget keys, state.LEGACY_TARGETS; its natural gas and electricity are
   * the energy aggregate's members). Matched like taxonomy names: ignoring case, spacing,
   * punctuation and '&' / 'and'.
   */
  const ALIASES = Object.freeze({
    'Natural gas': 'Gas & heating', 'Electricity': 'Electric', 'Municipal payments': 'Water & sewer',
    'Groceries & meal kits': 'Groceries', 'Dining & drinks': 'Dining & takeout', 'Shopping & mixed retail': MIXED_RETAIL,
    'Home & hardware': 'Household & hardware', 'Fuel & charging': 'Fuel', 'Vehicle care & registration': 'Auto maintenance',
    'Travel & parking': 'Travel', 'Apps & subscriptions': 'Subscriptions', 'Uncategorized / review': UNCATEGORIZED,
  });

  /**
   * Keyword families for other imported labels: the first family (in this order) with a phrase
   * that appears in the label as whole words gives its category ('Electric bill', 'Car
   * insurance', 'Child care'). Only words that name a necessity without doubt are listed: a bare
   * 'gas' (fuel or heating?) or 'health' (care or fitness?) is not guessed.
   */
  const FAMILIES = [
    ['Gas & heating', ['natural gas', 'heating', 'heating oil', 'propane']],
    ['Electric', ['electric', 'electricity']],
    ['Water & sewer', ['water', 'sewer', 'sewage']],
    ['Trash & municipal', ['trash', 'garbage', 'recycling']],
    ['Internet & phone', ['internet', 'broadband', 'phone bill', 'phone service', 'cell phone', 'mobile phone', 'wireless service']],
    ['Groceries', ['grocery', 'groceries', 'supermarket', 'supermarkets', 'meal kit', 'meal kits']],
    ['Fuel', ['fuel', 'gasoline', 'gas station', 'gas stations', 'charging', 'ev charging']],
    ['Mortgage', ['mortgage', 'rent']],
    ['Property tax & HOA', ['property tax', 'property taxes', 'hoa']],
    ['Auto insurance', ['auto insurance', 'car insurance', 'vehicle insurance']],
    ['Home insurance', ['home insurance', 'homeowners insurance', 'renters insurance']],
    ['Life insurance', ['life insurance']],
    ['Other insurance', ['insurance']],
    ['Auto maintenance', ['auto maintenance', 'car maintenance', 'auto repair', 'auto repairs', 'car repair', 'car repairs']],
    ['Home maintenance & repairs', ['home maintenance', 'home repair', 'home repairs']],
    ['Medical & pharmacy', ['medical', 'pharmacy', 'doctor', 'doctors', 'healthcare', 'health care', 'prescription', 'prescriptions']],
    ['Dental', ['dental', 'dentist']],
    ['Vision', ['vision', 'optical', 'eye care', 'optometrist']],
    ['Baby & childcare', ['childcare', 'child care', 'daycare', 'day care']],
  ];

  /** A label as plain words between spaces: lower case, '&' and '+' as 'and', other punctuation a space. */
  const wordsOf = name => ' ' + String(name).toLowerCase().replace(/[&+]/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const byWords = new Map();
  for (const c of DEFAULT) byWords.set(wordsOf(c.name), c.name);
  for (const [alias, name] of Object.entries(ALIASES)) byWords.set(wordsOf(alias), name);
  const families = FAMILIES.map(([name, phrases]) => ({ name, phrases: phrases.map(wordsOf) }));

  /**
   * The taxonomy category a label stands for, or null: the category itself; null for an aggregate
   * (several categories) and for an unknown label; else the category or alias with the same words
   * ('groceries', 'Natural gas'); else the first keyword family that matches.
   */
  function resolve(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    if (byName.has(name)) return name;
    if (Object.prototype.hasOwnProperty.call(AGGREGATES, name)) return null;
    const words = wordsOf(name);
    if (byWords.has(words)) return byWords.get(words);
    const family = families.find(f => f.phrases.some(p => words.includes(p)));
    return family ? family.name : null;
  }
  /** The taxonomy categories an aggregate budget name stands for (a copy), or null when it is not one. */
  function membersOf(name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(AGGREGATES, name) ? AGGREGATES[name].slice() : null;
  }
  /** The taxonomy entry a label resolves to, or the entries an aggregate stands for. */
  const entriesOf = name => (membersOf(name) || [resolve(name)]).map(n => byName.get(n)).filter(Boolean);

  function find(name) { return byName.get(name) || null; }
  function groupOf(name) {
    const groups = new Set(entriesOf(name).map(c => c.group));
    return groups.size === 1 ? groups.values().next().value : 'Other';
  }
  function isSeasonal(name, extraSeasonal) {
    if (Array.isArray(extraSeasonal) && extraSeasonal.includes(name)) return true;
    return entriesOf(name).some(c => c.seasonal);
  }
  /** Names outside the spending taxonomy that are still essential (a debt payment recorded as spending). */
  const ESSENTIAL_EXTRA = new Set(['Debt payment']);
  function isEssential(name) {
    if (ESSENTIAL_EXTRA.has(name)) return true;
    const list = entriesOf(name);
    return list.length > 0 && list.every(c => c.essential);
  }
  /**
   * The reading before imported names were resolved: essential only for a taxonomy category of
   * exactly that name (or ESSENTIAL_EXTRA); an alias, a keyword family, an aggregate or an unknown
   * name was flexible. Only for carrying over amounts the household set under that reading
   * (timeline: ui.plan.groupsRead 'exact'); everything else uses isEssential.
   */
  function isEssentialByName(name) {
    const c = byName.get(name);
    return !!(c && c.essential) || ESSENTIAL_EXTRA.has(name);
  }
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

  E.categories = { DEFAULT, GROUP_ORDER, UNCATEGORIZED, MIXED_RETAIL, AGGREGATES, ALIASES, find, resolve, membersOf, groupOf, isSeasonal, isEssential, isEssentialByName, names, sortNames };
})(typeof globalThis !== 'undefined' ? globalThis : this);
