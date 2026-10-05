'use strict';
/*
 * Plan (route #/overview): one chart that does most of the work, the balances it starts from,
 * the dials underneath and the planned changes. Everything comes from BudgetEngine.timeline.build,
 * worked out once per render (ctx.memo).
 *   1. Chart     balance lines, money in and out each month, or chosen monthly series and balances
 *                (Trends), on one timeline; past and ahead; Export CSV               plan/chart.js
 *   2. Balances  the known balance of each joint cash account: the bank's figure when the data has
 *                one (a different one can be entered), else an amount and date the household
 *                enters                                                              plan/balances.js
 *   3. Dials     money in by person; money out by how adjustable it is: essentials, flexible,
 *                irregular (one-time costs spread per month), net to savings, other. Essentials and
 *                flexible open into categories and places (each can move to the other group), the
 *                irregular dial into its one-time costs. The headline adds the dials up. plan/dials.js
 *   4. Planned changes   dated one-time or monthly changes (and templates), applied once accepted
 *                                                                                    plan/changes.js
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
  const { amt, inputText, model, showError, chartCard, balancesCard, dialsCard, sumOf, valuesOf, changesHtml, actions, takeNext } = P;

  const BASELINES = [{ value: 3, label: 'Last 3' }, { value: 6, label: 'Last 6' }, { value: 12, label: 'Last 12' }, { value: 'all', label: 'All' }];

  /** The upgrade note already handled this session (E.timeline.pendingUpgrade is applied once). */
  let migrated = null;

  // ------------------------------------------------------------------ 5. more options
  function moreHtml(ctx, tl) {
    const body = `${c.segmented({ label: 'Baseline: complete months to average', name: 'plan-baseline', options: BASELINES, value: tl.baseline.setting, action: 'plan:baseline' })}
      <p class="fine" id="plan-baseline-label">${esc(tl.baseline.label)}. One-time costs go into the irregular dial, spread per month; yearly bills are spread over 12 months.</p>
      <label class="check plan-cover" for="plan-cover"><input type="checkbox" id="plan-cover" data-action="plan:cover"${tl.settings.coverFromSavings ? ' checked' : ''}><span>When checking would go below $0 in a plan month, move the shortfall from savings (only the account lines; the combined line is never changed)</span></label>
      <p class="plan-links"><a href="${esc(ctx.href('budget'))}">Pay and bills in detail → Budget</a><a href="${esc(ctx.href('review'))}">Fix a transaction → Transactions</a></p>`;
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
    const sample = ctx.dataset.isSynthetic ? '<p class="fine plan-sample" id="plan-sample">This is a fictional sample household. Load your own bank exports in Data &amp; privacy; they stay on this device.</p>' : '';
    return `<div class="plan-page">${header(tl)}<div class="plan" id="plan-root">
        ${chartCard(ctx, tl)}
        ${balancesCard(ctx, tl)}
        ${dialsCard(ctx, tl)}
        ${changesHtml(ctx, tl)}
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
    });
    // Enter commits a typed amount (the same as leaving the box).
    rootEl.addEventListener('keydown', ev => {
      const el = ev.target;
      if (ev.key !== 'Enter' || !el.matches || !el.matches('input[data-commit]')) return;
      ev.preventDefault();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
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
