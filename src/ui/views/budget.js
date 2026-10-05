'use strict';
/*
 * Budget (route #/budget): this month's plan, for a household that mostly looks and now and then
 * adjusts. Everything comes from the Plan screen's model (BudgetEngine.timeline.build, the same
 * cached build), so Budget and Plan always show the same numbers.
 *   1. Hero         "<Month> plan": where each dollar goes (tl.summary)          budget/hero.js
 *   2. So far       planned vs spent by group and category, with a pace marker;
 *                   a category's planned amount is typed in place                budget/month.js
 *   3. Goals        savings goals (progress, reach month, monthly amount) and
 *                   investments                                                  budget/goals.js
 *   4. Coming up    the next planned changes, linked to the chart                budget/goals.js
 *   5. Setup        pay, bills, debts and the goals list, folded away            budget/setup.js
 * What the parts share is in budget/common.js (BudgetUI._budget, private to this view).
 * Route params: section=income|bills|debts|savings opens that setup area (section=targets: the
 * spending section); focus=<element id> focuses a field (links from other views use both).
 * Every edit is undoable from the toast (app.update); the toast adds what the month now nets.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const { amt, signedWhole, model, monthName, setError, AREAS } = B;

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const tl = model(ctx);
    const month = tl && tl.summary ? tl.summary.month : null;
    const header = c.pageHeader({
      eyebrow: 'Budget',
      title: month ? `${monthName(month)} plan` : 'Your plan',
      subtitle: month ? `Joint accounts · ${esc(fmt.monthLong(month))} · the same plan as the chart` : 'Joint accounts',
      actions: month ? `<a class="btn btn-secondary btn-small" id="bud-to-chart" href="${esc(ctx.href('overview'))}">Open the chart</a>` : '',
    });
    const dataNote = ctx.app.datasetError ? c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) }) : '';
    const noData = !tl ? c.card(c.empty(ctx.months.length ? 'The plan could not be worked out from this data.' : 'Load your bank exports to see this month’s plan. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No plan yet', id: 'bud-empty' }) : '';
    return `<div class="bud-page" id="bud-root">
      ${header}
      ${dataNote}
      ${noData}
      ${tl ? B.heroCard(ctx, tl) : ''}
      ${tl ? `<div class="bud-grid">
        <div class="bud-col-main">${B.monthCard(ctx, tl)}</div>
        <div class="bud-col-side">${B.goalsCard(ctx, tl)}${B.comingUpCard(ctx, tl)}</div>
      </div>` : ''}
      ${B.setupDetails(ctx, tl)}
      <p class="sr-only" id="bud-live" aria-live="polite"></p>
    </div>`;
  }

  // ------------------------------------------------------------------ behaviour
  /** Route ?focus= (and ?section=) handled once per navigation. */
  let handledFocus = null;
  /** What the month netted when last shown, to add the consequence of a change to its toast. */
  let shown = null;

  function netOf(tl) {
    const flow = tl ? B.dollarFlow(tl.summary, tl.people) : null;
    return flow ? flow.netCents : null;
  }

  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#bud-root');
    if (!rootEl) return;
    const tl = model(ctx);

    // Enter commits a typed planned amount (the same as leaving the box).
    rootEl.addEventListener('keydown', ev => {
      const el = ev.target;
      if (ev.key !== 'Enter' || !el.matches || !el.matches('input[data-commit]')) return;
      ev.preventDefault();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // ?section= opens a setup area (targets: the spending section) and ?focus= focuses a field,
    // once per navigation; again when the same link is used twice (the app then re-renders the
    // same URL and moves focus to the page title, which this replaces with the field).
    const { section, focus } = ctx.route.params;
    if (!section && !focus) handledFocus = null;
    else {
      const first = handledFocus !== location.hash;
      handledFocus = location.hash;
      const area = AREAS.includes(section) ? document.getElementById('bud-area-' + section) : section === 'targets' ? document.getElementById('bud-month') : null;
      const el = focus ? document.getElementById(focus) : null;
      if (first && area && area.tagName === 'DETAILS') area.open = true;
      if (el) {
        // A heading target (a card it links to) becomes focusable for this purpose only.
        if (!el.matches('a[href], button, input, select, textarea, summary, [tabindex]')) el.setAttribute('tabindex', '-1');
        setTimeout(() => {
          if (!first && !(document.activeElement && document.activeElement.id === 'page-title')) return;
          for (let d = el.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) d.open = true;
          el.focus({ preventScroll: true });
          el.scrollIntoView({ block: 'center' });
        }, 0);
      } else if (first && area) {
        setTimeout(() => {
          const active = document.activeElement;
          // Keyboard focus stays where it is when a link on this page asked to keep it.
          if (active && active !== document.body && active.id !== 'page-title' && rootEl.contains(active)) return;
          area.scrollIntoView({ block: 'start' });
        }, 0);
      }
    }

    // Say what an edit did to the month in the toast, right after a forward change made here.
    const st = ctx.state;
    const net = netOf(tl);
    const stack = ctx.app.undoStack || [];
    const top = stack.length ? stack[stack.length - 1] : null;
    const fresh = st.meta && st.meta.updatedAt && Date.now() - Date.parse(st.meta.updatedAt) < 3000;
    if (shown && shown.plan !== st.plan && top && top.plan === shown.plan && fresh && shown.net !== null && net !== null && net !== shown.net) {
      const toastEl = document.getElementById('toast');
      if (toastEl && !toastEl.hidden) {
        const base = (toastEl.querySelector('span') || {}).textContent || '';
        if (!/a month on this plan/.test(base)) ctx.app.toast(`${base ? base + ' ' : ''}${signedWhole(shown.net)} → ${signedWhole(net)} a month on this plan.`, { undo: true });
      }
    }
    shown = { plan: st.plan, net };
    // Lets tools and browser tests wait for the render that shows the current plan.
    rootEl.__budPlan = st.plan;
  }

  // ------------------------------------------------------------------ actions
  /** Typed amounts: commas and a typographic minus or dash are fine. */
  const typed = value => String(value || '').trim().replace(/[−–—]/g, '-');

  const actions = Object.assign({
    /**
     * A category's planned amount, typed on its row: the category budget (plan.targets) through
     * E.timeline.setTarget, or setRow when the row carries its own amount from the Plan screen
     * (setRow moves it into the budget). Blank clears the budget: the category plans at its
     * history again.
     */
    'budget:set-plan': (ctx, el) => {
      const raw = typed(el.value);
      let cents = null;
      if (raw !== '') {
        try { cents = E.money.inputToCents(raw, { field: 'plan' }); } catch (err) { setError(el.id, err.message || 'Enter an amount in dollars, such as 125 or 125.50.'); return; }
      }
      setError(el.id, null);
      const cat = el.dataset.cat;
      const current = el.dataset.cents === '' ? null : Number(el.dataset.cents);
      const tl = model(ctx);
      if (cents !== null && cents === current && el.dataset.source !== 'history') return;
      // Enter commits, and the browser may fire its own change as well: the second one finds the
      // budget already saved and does nothing.
      const targets = ctx.state.plan.targets || {};
      const rows = (ctx.state.ui.plan && ctx.state.ui.plan.rows) || {};
      const rowCents = rows[el.dataset.row] ? rows[el.dataset.row].cents : undefined;
      if (Object.prototype.hasOwnProperty.call(targets, cat) && targets[cat] === cents && rowCents === undefined) return;
      if (cents === null && el.dataset.source === 'history') { el.value = UI.dom.centsToInputText(current); return; }
      const message = cents === null ? `${cat} plan saved: back to its usual amount.` : `${cat} plan saved: ${amt(cents)} a month.`;
      ctx.app.update(st => (el.dataset.source === 'set'
        ? E.timeline.setRow(st, el.dataset.row, { cents }, tl)
        : E.timeline.setTarget(st, cat, cents)), { message });
    },
  }, B.setupActions);

  UI.views = UI.views || {};
  UI.views.budget = { title: 'Budget', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
