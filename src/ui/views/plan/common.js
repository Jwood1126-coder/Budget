'use strict';
/*
 * Overview (route #/overview) and Edit plan (route #/budget): what their plan parts share, in the
 * private BudgetUI._plan namespace. Each file adds its part, in src/manifest.json order:
 *   plan/common.js    this file: the model (one BudgetEngine.timeline.build per render, ctx.memo),
 *                     formatting, the dial swatches, the planned changes' groups and short labels,
 *                     field errors
 *   plan/tiles.js     Overview: the plan month's income, outgoing and margin (three tiles)
 *   plan/chart.js     Overview: two stacked panels on one month axis (balances; money in and out
 *                     each month), Past and Ahead, Export CSV, the below-$0 warning
 *   plan/balances.js  Overview: checking and savings, each with its date and source, the combined
 *                     total, and the balance editors (folded)
 *   plan/month.js     Overview: one month's breakdown (a month chosen on the chart, or a tile)
 *   plan/dials.js     Edit plan: the dials and their drill-downs (categories → places →
 *                     transactions), the irregular list, who paid in
 *   plan/changes.js   Edit plan: the planned changes to edit; Overview: the short Coming up list
 *   plan/actions.js   the plan:* actions (both screens), wire() (the behaviour both screens share)
 *                     and what the next render focuses and announces
 * views/overview.js and views/budget.js compose the two screens. Nothing else reads BudgetUI._plan.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  // Dial swatches match the flows chart's columns (validated order: in from blue, out from magenta).
  const DIAL_CLS = { p1: 'series-1', p2: 'series-2', inOther: 'series-muted', essentials: 'series-5', flexible: 'series-4', irregular: 'series-6', savings: 'series-3', investing: 'series-4', other: 'series-muted' };

  // ------------------------------------------------------------------ formatting
  const isCents = v => Number.isSafeInteger(v);
  const whole = cents => fmt.money(cents, { whole: true });
  const exact = cents => fmt.money(cents);
  /** Dollars, with cents only when there are any: $2,222.02, $250. */
  const amt = fmt.amount;
  const plural = (n, word, many) => n + ' ' + (n === 1 ? word : many || word + 's');
  /** Amount for an exact-entry box: cents kept, thousands separated, an ASCII minus. */
  const inputText = UI.dom.centsToInputText;
  const pad = n => String(n).padStart(2, '0');
  /** The real local date, 'YYYY-MM-DD'. */
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** "Sep 30" this year, "Sep 30, 2025" otherwise. */
  function shortDate(date) {
    const label = fmt.date(date);
    return date && date.slice(0, 4) === todayIso().slice(0, 4) ? label.replace(/, \d{4}$/, '') : label;
  }
  /** A tiny "badge" carrying its own id (tests and aria-describedby can find it). */
  const badgeWithId = (id, text, tone, opts) => c.badge(text, tone, opts).replace('<span class="badge', `<span id="${esc(id)}" class="badge`);

  // ------------------------------------------------------------------ model
  /**
   * The plan, worked out once per render (ctx.memo('timeline'): Edit plan's helpers read the same
   * build). A ?compare= left in an address by the retired Compare control is ignored.
   */
  function model(ctx) {
    return ctx.memo('timeline', () => E.timeline.build({
      txns: ctx.realTxns || ctx.txns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan,
      today: todayIso(), coverageMap: ctx.coverageMap,
    }));
  }

  // ------------------------------------------------------------------ packs and short labels
  /**
   * The packs a planned change can come from (its `template`), with the name the screen shows, the
   * what-if they are tagged with when added here, and their colour. 'baby' is the earlier Baby
   * template: changes saved from it are ordinary changes, shown under the same name.
   */
  const PACKS = {
    babyFirstYear: { name: 'New baby', cls: 'series-5' },
    baby: { name: 'Baby', cls: 'series-5' },
    childcare: { name: 'Childcare', cls: 'series-4' },
    kidCosts: { name: 'Kid costs', cls: 'series-6' },
  };
  /** A change's pack ({ name, cls }) or null for one of the household's own. */
  const packOf = ch => (ch && ch.template && PACKS[ch.template]) || null;
  /** The colour of a what-if copied from a saved scenario (no pack). */
  const SCENARIO_CLS = 'series-2';
  /**
   * The group a planned change is listed under: its what-if's name (packs added here carry their
   * pack's name; changes copied from a saved scenario carry the scenario's), else its pack's name
   * (a pack added without a what-if, the earlier Baby template), else '' (one of the household's
   * own, or worked out from Budget: listed on its own).
   */
  const groupKeyOf = ch => (!ch || ch.readOnly ? '' : ch.scenario || (packOf(ch) ? packOf(ch).name : ''));
  /** A group's element id: plan-grp-<slug>-<hash> (its accept box adds -on). */
  const groupIdOf = key => UI.dom.domId('plan-grp', key);
  /** A short name for a change, for the chart and the timeline strip: no brackets, before a colon, ≤ 22 characters. */
  function shortLabel(label) {
    let t = String(label || '').replace(/\s*\([^)]*\)/g, '').trim();
    const colon = t.indexOf(':');
    if (colon > 2 && !/^(kid|baby)$/i.test(t.slice(0, colon).trim())) t = t.slice(0, colon).trim();
    else if (colon > 0) t = t.slice(colon + 1).trim().replace(/^./, x => x.toUpperCase());
    return t.length > 22 ? t.slice(0, 21).trimEnd() + '…' : t;
  }
  /** Whole dollars, compact for a label: $450, $1.2k, $12k; signed when asked. */
  function compact(cents, { signed = false } = {}) {
    if (!isCents(cents)) return '';
    const a = Math.abs(cents) / 100;
    const body = a >= 10000 ? Math.round(a / 1000) + 'k' : a >= 1000 ? (Math.round(a / 100) / 10).toString().replace(/\.0$/, '') + 'k' : String(Math.round(a));
    return (cents < 0 ? '−' : signed && cents > 0 ? '+' : '') + '$' + body;
  }

  // ------------------------------------------------------------------ behaviour
  function showError(el, message) {
    const box = el && document.getElementById(el.id + '-error');
    if (!el) return;
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (box) { box.textContent = message || ''; box.hidden = !message; }
  }

  UI._plan = { DIAL_CLS, isCents, whole, exact, amt, plural, inputText, todayIso, shortDate, badgeWithId, model, PACKS, packOf, SCENARIO_CLS, groupKeyOf, groupIdOf, shortLabel, compact, showError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
