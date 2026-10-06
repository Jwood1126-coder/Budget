'use strict';
/*
 * Overview (route #/overview; #/forecast redirects here): where are we, and where are we heading?
 * Everything comes from BudgetEngine.timeline.build, worked out once per render (ctx.memo).
 *   1. Balances   checking and savings, each with its date and source, and the combined total;
 *                 the balance editors folded under them                            plan/balances.js
 *   2. The month  the plan month's income, outgoing and margin (three tiles)        plan/tiles.js
 *   3. Chart      two panels on one month axis: balances (checking, savings, combined) and money
 *                 in and out each month (income, outgoing, net to savings); markers for planned
 *                 changes and goals; Past and Ahead; the below-$0 warning          plan/chart.js
 *   4. Breakdown  a month chosen on the chart (or a tile): income by person, outgoing by group
 *                 and category; shown only on demand (?month=YYYY-MM)              plan/month.js
 *   5. Coming up  the next few planned changes, bills, pay and goals               plan/changes.js
 * Editing happens in Edit plan (#/budget). The plan:* actions are in plan/actions.js.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { model, tilesHtml, chartCard, balancesCard, comingHtml, monthHtml, showMonth, actions } = P;

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const last = ctx.months.length ? ctx.months[ctx.months.length - 1] : null;
    const header = tl => c.pageHeader({
      title: 'Overview',
      subtitle: last ? `Joint accounts · your data through ${esc(fmt.date(E.months.end((tl && tl.lastComplete) || last)))}` : 'Joint accounts',
    });
    if (ctx.app.datasetError) return header() + c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) });
    if (!ctx.months.length) {
      return header() + c.card(c.empty('Load your bank exports to see where you are. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No data yet' });
    }
    const tl = model(ctx);
    const month = String(ctx.route.params.month || '');
    const sample = ctx.dataset.isSynthetic ? '<p class="fine plan-sample" id="plan-sample">A fictional sample household. Load your own exports in Data &amp; privacy; they stay on this device.</p>' : '';
    return `<div class="plan-page ov-page">${header(tl)}<div class="plan ov" id="plan-root">
        ${balancesCard(ctx, tl)}
        ${tilesHtml(ctx, tl)}
        ${chartCard(ctx, tl)}
        <div id="plan-month-box" class="ov-month-box">${E.months.isMonth(month) ? monthHtml(ctx, tl, month) : ''}</div>
        ${comingHtml(ctx, tl)}
        <p class="sr-only" id="plan-live" aria-live="polite"></p>
        ${sample}
      </div></div>`;
  }

  // ------------------------------------------------------------------ behaviour
  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#plan-root');
    if (!rootEl) return;
    P.wire(rootEl, ctx);
    // A month chosen on either chart panel opens its breakdown in place (the chart is not redrawn,
    // so a readout open on a phone stays); a click or Enter also brings the breakdown into view.
    rootEl.addEventListener('chart:select', ev => {
      const d = ev.detail || {};
      if (d.month) showMonth(ctx, d.month, { focus: false, scroll: d.via !== 'touch' });
    });
  }

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Overview', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
