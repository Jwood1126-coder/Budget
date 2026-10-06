'use strict';
/*
 * Edit plan (route #/budget): the one place for the plan's inputs. Everything comes from the same
 * BudgetEngine.timeline.build as the Overview (ctx.memo('timeline')), so both show one plan.
 *   1. Money in and out   the dials: money in by person; money out as essentials, flexible,
 *                         irregular, net to savings and other, each with its Reset ("Reset all to
 *                         baseline" too); essentials and flexible open into categories → places →
 *                         transactions (amounts, moves between groups, recategorize)  plan/dials.js
 *   2. Planned changes    the list to edit, groups as one folded row, + Custom change plan/changes.js
 *   3. Savings goals      one card per goal, its monthly amount editable            budget/goals.js
 *   4. Pay, bills, debts  the setup editors, folded by area                         budget/setup.js
 *   5. Settings           baseline months, cover a checking shortfall from savings   this file
 * What the budget parts share is in budget/common.js (BudgetUI._budget); the plan parts and
 * plan:* actions are BudgetUI._plan's (plan/*.js), wired by P.wire after each render.
 * Route params: section=income|bills|debts|savings opens that setup area, section=targets opens
 * the category lists; focus=<element id> focuses a field (links from other views use both).
 * Every edit is undoable from the toast (app.update); the toast adds what the month now nets.
 */
(function (root) {
  const UI = root.BudgetUI;
  const { esc, domId } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const P = UI._plan;
  const { signedWhole, model, AREAS } = B;

  const BASELINES = [{ value: 3, label: 'Last 3' }, { value: 6, label: 'Last 6' }, { value: 12, label: 'Last 12' }, { value: 'all', label: 'All' }];

  // ------------------------------------------------------------------ 5. settings
  function settingsHtml(ctx, tl) {
    const body = `${c.segmented({ label: 'Baseline: complete months to average', name: 'plan-baseline', options: BASELINES, value: tl.baseline.setting, action: 'plan:baseline' })}
      <p class="fine" id="plan-baseline-label">${esc(tl.baseline.label)}.</p>
      <label class="check plan-cover" for="plan-cover"><input type="checkbox" id="plan-cover" data-action="plan:cover"${tl.settings.coverFromSavings ? ' checked' : ''}><span>Cover a checking shortfall from savings</span></label>`;
    return c.disclosure('Settings', body, { id: 'plan-more', cls: 'card plan-more' });
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const tl = model(ctx);
    const month = tl && tl.summary ? tl.summary.month : null;
    const header = c.pageHeader({
      title: 'Edit plan',
      subtitle: month ? `Joint accounts · amounts a month, from ${esc(fmt.monthLong(month))}` : 'Joint accounts',
    });
    const dataNote = ctx.app.datasetError ? c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) }) : '';
    const noData = !tl ? c.card(c.empty(ctx.months.length ? 'The plan could not be worked out from this data.' : 'Load your bank exports to start the plan. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No plan yet', id: 'bud-empty' }) : '';
    return `<div class="bud-page" id="bud-root">
      ${header}
      ${dataNote}
      ${noData}
      <div class="plan bud-edit" id="plan-root">
        ${tl ? P.dialsCard(ctx, tl) : ''}
        ${tl ? P.changesHtml(ctx, tl) : ''}
        ${tl ? B.goalsCard(ctx, tl) : ''}
        ${B.setupDetails(ctx, tl)}
        ${tl ? settingsHtml(ctx, tl) : ''}
        <p class="sr-only" id="plan-live" aria-live="polite"></p>
      </div>
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

  /**
   * A field a link asks for: by id; a category's budget field (bud-target-<category>, from the
   * Transactions and Spending views) is that category's row amount in the lists.
   */
  function fieldFor(focus) {
    if (!focus) return null;
    const el = document.getElementById(focus);
    if (el) return el;
    if (!/^bud-target-/.test(focus)) return null;
    return Array.from(document.querySelectorAll('input[data-action="plan:row-cents"]')).find(x => domId('bud-target', x.dataset.name || '') === focus) || null;
  }

  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#bud-root');
    if (!rootEl) return;
    const tl = model(ctx);
    const planRoot = rootEl.querySelector('#plan-root');
    if (planRoot && tl) P.wire(planRoot, ctx);

    // ?section= opens a setup area (targets: the category lists) and ?focus= focuses a field,
    // once per navigation; again when the same link is used twice (the app then re-renders the
    // same URL and moves focus to the page title, which this replaces with the field).
    const { section, focus } = ctx.route.params;
    if (!section && !focus) handledFocus = null;
    else {
      const first = handledFocus !== location.hash;
      handledFocus = location.hash;
      const area = AREAS.includes(section) ? document.getElementById('bud-area-' + section) : section === 'targets' ? document.getElementById('plan-dials') : null;
      if (first && section === 'targets') for (const d of rootEl.querySelectorAll('#plan-drill-essentials, #plan-drill-flexible')) d.open = true;
      const el = fieldFor(focus);
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
  const actions = Object.assign({}, P.actions, B.setupActions);

  UI.views = UI.views || {};
  UI.views.budget = { title: 'Edit plan', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
