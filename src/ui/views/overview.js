'use strict';
/*
 * Plan (route #/overview; #/forecast redirects here): the numbers that matter, one chart that does
 * most of the work, what is coming up, the dials and the balances the chart starts from.
 * Everything comes from BudgetEngine.timeline.build, worked out once per render (ctx.memo).
 *   0. Tiles     monthly on this plan, cash in 12 months, savings and investments now → then, the
 *                lowest point when the plan goes below $0                          plan/tiles.js
 *   1. Chart     balance lines (and investments), money in and out each month, or chosen monthly
 *                series and balances (Trends), on one timeline; markers for changes and goals;
 *                Compare a what-if; past and ahead; Export CSV                      plan/chart.js
 *   2. Coming up the planned changes, packs, bills and goals on a strip across the plan's
 *                months, the list to edit them, packs and a change to add          plan/changes.js
 *   3. Dials     money in by person; money out by how adjustable it is: essentials, flexible,
 *                irregular (one-time costs spread per month), net to savings, investing, other.
 *                Essentials and flexible open into categories and places (each can move to the
 *                other group), the irregular dial into its one-time costs; each place, "everything
 *                else" row and item into its transactions, whose categories can be changed there.
 *                The headline adds the dials up.                                   plan/dials.js
 *   4. Balances  the known balance of each joint cash account: the bank's figure when the data has
 *                one (a different one can be entered), else an amount and date the household
 *                enters                                                              plan/balances.js
 *   5. More      baseline window, cover-from-savings, links to the detail views     this file
 * The plan:* actions are in plan/actions.js; what the parts share (the model, formatting) is in
 * plan/common.js, on the private BudgetUI._plan namespace. This file composes the page, wires it
 * after each render and applies the saved-state upgrades the plan screen owns, once.
 * Text boxes and sliders commit on change through app.update (undoable). While a slider is being
 * dragged only its own box and the headline follow; the chart follows on release.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { amt, inputText, model, showError, tilesHtml, updateMonthTile, chartCard, balancesCard, dialsCard, sumOf, valuesOf, changesHtml, actions, takeNext, fillTxns, keyedCategory } = P;

  const BASELINES = [{ value: 3, label: 'Last 3' }, { value: 6, label: 'Last 6' }, { value: 12, label: 'Last 12' }, { value: 'all', label: 'All' }];

  /** The upgrade note already handled this session (E.timeline.pendingUpgrade is applied once). */
  let migrated = null;

  // ------------------------------------------------------------------ 5. more options
  function moreHtml(ctx, tl) {
    const body = `${c.segmented({ label: 'Baseline: complete months to average', name: 'plan-baseline', options: BASELINES, value: tl.baseline.setting, action: 'plan:baseline' })}
      <p class="fine" id="plan-baseline-label">${esc(tl.baseline.label)}.</p>
      <label class="check plan-cover" for="plan-cover"><input type="checkbox" id="plan-cover" data-action="plan:cover"${tl.settings.coverFromSavings ? ' checked' : ''}><span>Cover a checking shortfall from savings (account lines only)</span></label>
      <p class="plan-links"><a href="${esc(ctx.href('budget'))}">Pay and bills → Budget</a><a href="${esc(ctx.href('review'))}">Fix a transaction → Transactions</a></p>`;
    return c.disclosure('More options', body, { id: 'plan-more', cls: 'plan-more' });
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const last = ctx.months.length ? ctx.months[ctx.months.length - 1] : null;
    const header = tl => c.pageHeader({
      title: 'Plan',
      subtitle: last ? `Joint accounts · your data through ${esc(fmt.date(E.months.end((tl && tl.lastComplete) || last)))}` : 'Joint accounts',
    });
    if (ctx.app.datasetError) return header() + c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) });
    if (!ctx.months.length) {
      return header() + c.card(c.empty('Load your bank exports to see your plan. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No data yet' });
    }
    const tl = model(ctx);
    const sample = ctx.dataset.isSynthetic ? '<p class="fine plan-sample" id="plan-sample">A fictional sample household. Load your own exports in Data &amp; privacy; they stay on this device.</p>' : '';
    return `<div class="plan-page">${header(tl)}<div class="plan" id="plan-root">
        ${tilesHtml(ctx, tl)}
        ${chartCard(ctx, tl)}
        ${changesHtml(ctx, tl)}
        ${dialsCard(ctx, tl)}
        ${balancesCard(ctx, tl)}
        ${moreHtml(ctx, tl)}
        <p class="sr-only" id="plan-live" aria-live="polite"></p>
        ${sample}
      </div></div>`;
  }

  // ------------------------------------------------------------------ behaviour
  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#plan-root');
    if (!rootEl) return;
    const tl = model(ctx);
    // Row changes and card/bank amounts saved under the earlier card and bank dials: carried over
    // once, in one change, with one note.
    const upgrade = E.timeline.pendingUpgrade(tl);
    if (upgrade && migrated !== upgrade.note) {
      migrated = upgrade.note;
      const note = String(upgrade.note || '');
      setTimeout(() => {
        try {
          ctx.app.update(upgrade.apply, { message: note, undoable: false });
        } catch (err) { console.warn('Earlier plan settings were not carried over:', err.message); }
      }, 0);
    }
    // A slider being dragged: its box, its spoken value and the headline follow at once.
    rootEl.addEventListener('input', ev => {
      const el = ev.target;
      if (!el.matches || !el.matches('input.dial-range')) return;
      const key = el.dataset.dial;
      const cents = Math.round(Number(el.value) * 100);
      const dial = el.closest('.dial');
      dial.dataset.cents = String(cents);
      dial.dataset.dirty = '1';
      const box = document.getElementById('plan-dial-' + key);
      if (box) { box.value = inputText(cents); showError(box, null); }
      el.setAttribute('aria-valuetext', amt(cents) + ' a month');
      const overrides = {};
      for (const x of rootEl.querySelectorAll('.dial[data-dirty]')) overrides[x.dataset.dial] = Number(x.dataset.cents);
      const sum = rootEl.querySelector('#plan-sum');
      if (sum) sum.innerHTML = sumOf(tl, valuesOf(tl, overrides)).html;
      updateMonthTile(rootEl, tl, valuesOf(tl, overrides));
    });
    // Enter commits a typed amount (the same as leaving the box).
    rootEl.addEventListener('keydown', ev => {
      const el = ev.target;
      if (ev.key !== 'Enter' || !el.matches || !el.matches('input[data-commit]')) return;
      ev.preventDefault();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // A row's transactions are drawn when their list opens (lists open before a re-render come back drawn).
    rootEl.addEventListener('toggle', ev => {
      const d = ev.target;
      if (d.matches && d.matches('details.plan-txns') && d.open && !d.querySelector('.plan-tx-list')) fillTxns(ctx, d);
    }, true);
    // Category selects: a change made with the keys of a closed list waits for Enter or leaving it.
    keyedCategory(rootEl);
    // Legend toggles are drawn by the chart itself; only the choice is saved (no re-render).
    const card = rootEl.querySelector('#plan-chart-card');
    if (card) {
      card.addEventListener('chart:hidden', ev => {
        if (card.dataset.mode === 'trends') return;
        const list = ev.detail && Array.isArray(ev.detail.hidden) ? ev.detail.hidden.slice(0, E.state.LIMITS.planHidden || 40) : [];
        try {
          ctx.app.update(st => E.state.setPath(st, 'ui.plan.hidden', list), { undoable: false, rerender: false });
        } catch (err) { console.warn('Chart series choice not saved:', err.message); }
      });
    }
    const next = takeNext();
    if (next.focus) {
      const target = typeof next.focus === 'function' ? next.focus(rootEl) : rootEl.querySelector(next.focus);
      if (target) target.focus({ preventScroll: true });
    }
    if (next.announce) {
      const live = rootEl.querySelector('#plan-live');
      const text = sumOf(tl, valuesOf(tl)).text;
      if (live) setTimeout(() => { live.textContent = text; }, 120);
    }
  }

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Plan', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
