'use strict';
/*
 * BudgetEngine.timeline, the part every other part shares. The plan screen's model is one module,
 * BudgetEngine.timeline (its contract is at the top of timeline.js and in docs/ARCHITECTURE.md),
 * split by section over these files, loaded in this order (src/manifest.json):
 *
 *   timeline-core.js      shared helpers, the constants, settings(raw); creates E._timeline
 *   timeline-balances.js  known balances (anchors), mirrored savings, the balance lines, the
 *                         investments line
 *   timeline-spending.js  spending groups, the essentials and flexible drill-down (pattern
 *                         badges), the irregular dial's items
 *   timeline-dials.js     observed deposits (hints), the dials, the carry-over of the earlier
 *                         card and bank dials (legacyDialsPlan, carriedOver)
 *   timeline-changes.js   planned changes, the changes worked out from Budget (bills, goals),
 *                         and the packs (templates)
 *   timeline-export.js    toCSV
 *   timeline-writes.js    the screen's validated state writes and the upgrades it applies
 *   timeline.js           build, the Trends series catalogue, and the public E.timeline
 *
 * BudgetEngine._timeline is private to these files (nothing else reads it; the public API is
 * BudgetEngine.timeline). Each part adds what the others use, and reads another part's function
 * only when it runs, through late(name), so the parts load in any order after this file;
 * timeline.js assembles E.timeline from them and loads after all of them.
 *
 * Added here: the helpers isObj, isCents, has, own, plural, sumKnown, roundCents, fail, median
 * and late; settings(raw); the plan vocabulary from BudgetEngine.planSettings (BASELINE_CHOICES,
 * HORIZONS, PAST_CHOICES, MODES, TREND_MA, DEFAULTS, TREND_DEFAULTS, SPEND_GROUPS, SPEND_DIALS,
 * CHANGE_KINDS, CHANGE_GROUPS, SERIES, BALANCE_SERIES, BALANCE_SERIES_PREFIX; LEGACY_DIALS =
 * RETIRED_DIALS, IN_KEYS = PEOPLE); and MERCHANT_KEY and DIAL_LABEL, which more than one part uses.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline = {};

  // ------------------------------------------------------------------ constants
  // Shared with BudgetEngine.state, which saves the plan screen's settings (ui.plan): defined once
  // in plan-settings.js (BudgetEngine.planSettings), loaded before this file. The choices
  // (BASELINE_CHOICES ... TREND_DEFAULTS) are what state's ui.plan descriptor (PLAN_UI) offers;
  // SPEND_GROUPS: everyday spending by how adjustable it is; SPEND_DIALS: the spending dials, each
  // with a card and a bank part; LEGACY_DIALS (= RETIRED_DIALS): dial keys from before spending was
  // grouped (rows saved under them: '<key>-c|m|r-<hash>'); SERIES: the Trends chart's fixed series;
  // IN_KEYS (= PEOPLE): the people a plan holds.
  const PS = E.planSettings;
  const { BASELINE_CHOICES, HORIZONS, PAST_CHOICES, MODES, TREND_MA, DEFAULTS, TREND_DEFAULTS, SPEND_GROUPS, SPEND_DIALS, CHANGE_KINDS, CHANGE_GROUPS, SERIES } = PS;
  const LEGACY_DIALS = PS.RETIRED_DIALS;
  const IN_KEYS = PS.PEOPLE;
  // The Trends chart's balance series: the fixed ones, and the prefix of the per-account keys.
  const { BALANCE_SERIES, BALANCE_SERIES_PREFIX } = PS;
  /** ui.plan.groups key that moves one place (merchant) to a group of its own choosing. */
  const MERCHANT_KEY = 'merchant:';
  const DIAL_LABEL = { inOther: 'Other money in', essentials: 'Essentials', flexible: 'Flexible spending', irregular: 'Irregular costs', savings: 'Net to savings', investing: 'Investing', other: 'Debt & business' };

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => Number.isSafeInteger(v);
  const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const own = (o, k) => (has(o, k) ? o[k] : undefined);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const sumKnown = list => E.money.sumKnown(list);
  /** Whole cents, never −0 (−0 and 0 are the same amount, but not the same value to a strict comparison). */
  const roundCents = x => Math.round(x) || 0;
  const fail = (message, field) => { throw new E.ValidationError(message, field); };

  function median(list) {
    const s = list.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /**
   * late('name'): a function that runs E._timeline[name] when it is called. How a part uses
   * another part's function without depending on which of them loaded first.
   */
  const late = name => (...args) => T[name](...args);

  // ------------------------------------------------------------------ settings

  /**
   * ui.plan as the screen reads it. Checked by BudgetEngine.state.cleanPlanUi, the one validator for
   * ui.plan (state's PLAN_UI table): every default filled in, anything not valid reset or left out
   * as sanitize would, silently; hidden stays null until the household chooses. On top, the plan
   * screen's own quirk: a card or bank amount still among the dials (a budget not checked by
   * state.sanitize, which would move it) waits in legacyDials to be carried over (migrateDials), and,
   * being newer, wins over one already waiting there. legacyDials and cardSplit are always present.
   * @param {*} raw state.ui.plan (anything)
   * @returns {object}
   */
  function settings(raw) {
    const s = isObj(raw) ? raw : {};
    const cfg = E.state.cleanPlanUi(s);
    const legacyDials = isObj(cfg.legacyDials) ? cfg.legacyDials : {};
    for (const k of LEGACY_DIALS) if (isCents(own(s.dials, k))) legacyDials[k] = s.dials[k];
    return Object.assign(cfg, { legacyDials, cardSplit: isObj(cfg.cardSplit) ? cfg.cardSplit : {} });
  }

  Object.assign(T, {
    BASELINE_CHOICES, HORIZONS, PAST_CHOICES, MODES, TREND_MA, DEFAULTS, TREND_DEFAULTS, SPEND_GROUPS, SPEND_DIALS, CHANGE_KINDS, CHANGE_GROUPS, SERIES,
    BALANCE_SERIES, BALANCE_SERIES_PREFIX, LEGACY_DIALS, IN_KEYS, MERCHANT_KEY, DIAL_LABEL,
    isObj, isCents, has, own, plural, sumKnown, roundCents, fail, median, late,
    settings,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
