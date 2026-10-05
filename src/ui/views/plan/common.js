'use strict';
/*
 * Plan (route #/overview): what its parts share, in the private BudgetUI._plan namespace. The view
 * is split by section; each file adds its part to the namespace, in src/manifest.json order:
 *   plan/common.js    this file: the model (one BudgetEngine.timeline.build per render, ctx.memo),
 *                     formatting, the dial swatches, field errors
 *   plan/chart.js     1. the chart card: Balance / Flows / Trends, Past and Ahead, the Trends picker,
 *                     Export CSV
 *   plan/balances.js  2. the balances strip
 *   plan/dials.js     3. the dials, their drill-downs, the irregular list, who paid in, the headline
 *   plan/changes.js   4. the planned changes drawer and its templates
 *   plan/actions.js   the plan:* actions, and what the next render focuses and announces
 *   views/overview.js the view itself: render composition, 5. More options, afterRender, upgrades
 * Nothing outside the Plan view reads BudgetUI._plan.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  // Dial swatches match the flows chart's columns (validated order: in from blue, out from magenta).
  const DIAL_CLS = { p1: 'series-1', p2: 'series-2', inOther: 'series-muted', essentials: 'series-5', flexible: 'series-4', irregular: 'series-6', savings: 'series-3', other: 'series-muted' };

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
  function model(ctx) {
    return ctx.memo('timeline', () => E.timeline.build({
      txns: ctx.realTxns || ctx.txns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan,
      today: todayIso(), coverageMap: ctx.coverageMap,
    }));
  }

  // ------------------------------------------------------------------ behaviour
  function showError(el, message) {
    const box = el && document.getElementById(el.id + '-error');
    if (!el) return;
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (box) { box.textContent = message || ''; box.hidden = !message; }
  }

  UI._plan = { DIAL_CLS, isCents, whole, exact, amt, plural, inputText, todayIso, shortDate, badgeWithId, model, showError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
