'use strict';
/*
 * Forecast: create, name, save and compare scenarios, projected month by month.
 *
 * Layout
 *   - Header: scope (joint / whole household), horizon (12/24/36/60 months) and start month.
 *   - Scenarios: the current budget (baseline, always first, holds no changes) and the saved
 *     scenarios. Select one to edit it, tick up to three to compare (writes state.compareIds),
 *     create (optionally as a copy), copy, rename inline and delete (confirmation dialog).
 *   - Comparison: one line per compared scenario (change in cash, or the projected balance when
 *     the joint cash balance is known) and a side-by-side table from BudgetEngine.forecast.compare
 *     with differences against the first column.
 *   - Selected scenario: a result strip, its description, its dated changes (events) with inline
 *     editors and an add-a-change menu of templates, and how it is calculated (income timing,
 *     optional hypothetical growth and return). Next to it: what the forecast leaves out because
 *     an amount or date is missing (each with a way to fix it) and the assumptions, then the
 *     savings goals.
 *   - Month by month: one expandable row per month (details with stable ids) with paychecks,
 *     money in and out, net, money set aside for goals and the running change in cash. Rows with
 *     cash going down, a negative balance, uncovered goal contributions or missing amounts carry
 *     text badges. A full table version sits in a disclosure.
 *
 * Rules
 *   - Scenarios never change historical actuals or the budget: every edit here goes through
 *     BudgetEngine.state (setPath via data-bind, or addScenario / addEvent / updateEvent / ...)
 *     on one scenario, in one app.update, so it is validated and undoable from the toast.
 *   - Unknown is not $0: blank amounts and dates are listed as missing and left out of totals;
 *     when income is unknown the running totals are unknown too, and the page says what to enter.
 *   - Investment return is 0 unless the household sets it, and is labelled hypothetical.
 *
 * Route params: scenario (id being edited; default the first saved scenario, else the baseline),
 * compare (comma-separated ids, max 3; default state.compareIds), horizon (12|24|36|60, default
 * 24), start (YYYY-MM, default ctx.forecastStart).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc, domId } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const BASELINE = E.state.BASELINE_ID;
  const LIMITS = E.state.LIMITS || {};
  const MAX_COMPARE = LIMITS.compareIds || 3;
  const MAX_SCENARIOS = LIMITS.scenarios || 20;
  const MAX_EVENTS = LIMITS.events || 200;
  const HORIZONS = [12, 24, 36, 60];
  const DEFAULT_HORIZON = 24;
  const SCOPE_OPTIONS = [{ value: 'joint', label: 'Joint accounts' }, { value: 'household', label: 'Whole household' }];
  const TIMING = {
    actual: { short: 'Actual paydays', option: 'Actual paydays (recommended)' },
    conservative: { short: 'Typical month', option: 'Typical month' },
    average: { short: 'Annual average', option: 'Annual average' },
  };
  const TYPE_LABEL = {
    one_time: 'One-time', recurring: 'Every month', income_change: 'Income change',
    bill_change: 'Bill change', target_change: 'Target change', goal: 'Savings goal',
  };
  const FREQ_TEXT = { weekly: 'weekly', biweekly: 'every other week (biweekly)', semimonthly: 'twice a month', monthly: 'once a month' };
  const GOAL_STATUS = {
    funded: ['Funded', 'good'],
    short: ['Short', 'bad'],
    unknown_start: ['Starting amount unknown', 'warn'],
    missing_amount: ['Monthly amount missing', 'warn'],
    no_target: ['No target set', 'neutral'],
  };

  // Templates for the add-a-change menu. Amounts (and usually dates) are left blank on purpose:
  // the change is listed as missing until the household enters them, never counted as $0.
  const oneTime = (label, category, direction = 'expense') => ({ type: 'one_time', label, month: null, amountCents: null, direction, category, goalId: null, note: '' });
  const monthly = (label, category, direction = 'expense') => ({ type: 'recurring', label, startMonth: null, endMonth: null, monthlyCents: null, direction, category, note: '' });
  const TEMPLATE_GROUPS = [
    { label: 'Home and travel', items: [
      { key: 'repair-insulation', label: 'Home repair: insulation', make: () => oneTime('Attic insulation', 'Home improvement') },
      { key: 'repair-windows', label: 'Home repair: windows', make: () => oneTime('Window replacement', 'Home improvement') },
      { key: 'repair-electrical', label: 'Home repair: electrical', make: () => oneTime('Electrical work', 'Home improvement') },
      { key: 'trip', label: 'Vacation or trip', make: () => oneTime('Trip', 'Travel') },
    ] },
    { label: 'Baby', items: [
      { key: 'childcare', label: 'Childcare (monthly)', make: () => monthly('Childcare', 'Baby & childcare') },
      { key: 'baby-supplies', label: 'Baby supplies (monthly)', make: () => monthly('Baby supplies', 'Baby & childcare') },
      { key: 'birth', label: 'Birth or medical costs', make: () => oneTime('Birth and medical costs', 'Medical & pharmacy') },
      { key: 'leave', label: 'Parental leave', form: 'leave' },
    ] },
    { label: 'Income, bills and targets', items: [
      { key: 'income-once', label: 'Extra income (one-time)', make: () => oneTime('Extra income', null, 'income') },
      { key: 'income-monthly', label: 'Extra income (monthly)', make: () => monthly('Extra monthly income', null, 'income') },
      { key: 'debt-off', label: 'Debt paid off', form: 'debt' },
      { key: 'target', label: 'Change a spending target', form: 'target' },
      { key: 'goal', label: 'New savings goal', make: () => ({ type: 'goal', label: 'New savings goal', goal: { label: 'New savings goal', targetCents: null, targetMonth: null, savedCents: null, monthlyCents: null, spendAtTarget: false, note: '' } }) },
    ] },
    { label: 'Anything else', items: [
      { key: 'custom-once', label: 'Other one-time cost', make: () => oneTime('One-time cost', null) },
      { key: 'custom-monthly', label: 'Other monthly cost', make: () => monthly('Monthly cost', null) },
    ] },
  ];
  const TEMPLATES = Object.fromEntries(TEMPLATE_GROUPS.flatMap(g => g.items).map(t => [t.key, t]));
  const FORM_TITLE = { leave: 'Parental leave', debt: 'Debt paid off', target: 'Change a spending target' };

  // View-local, temporary UI state (not saved): which scenario is being renamed and which
  // add-a-change form is open. Focus requests run after the next render.
  const ui = { renaming: null, adding: null };
  let pendingFocus = null;

  // ------------------------------------------------------------------ small helpers
  const whole = v => fmt.money(v, { whole: true });
  const signedWhole = v => fmt.money(v, { whole: true, signed: true });
  const money = v => fmt.money(v);
  const known = v => v !== null && v !== undefined;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const nowIso = () => new Date().toISOString();
  const monthName = m => (m ? fmt.month(m) : '');
  const listText = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
  const short = (text, max = 22) => (String(text).length > max ? String(text).slice(0, max - 1).trimEnd() + '…' : String(text));
  const evPath = (sid, eid, field) => `scenarios[id=${sid}].events[id=${eid}].${field}`;
  const fieldId = (eid, field) => domId('fc-ev-' + field.replace(/[^A-Za-z0-9]+/g, '-'), eid);
  const isMoneyInput = v => E.money.isCents(v);
  /** Add data-message to a bound field from components.js, so its change toasts with Undo. */
  const withMessage = (html, message) => html.replace(' data-bind="', ` data-message="${esc(message)}" data-bind="`);

  function btn(label, { id, action, variant = 'secondary', small = true, data = {}, ariaLabel, type = 'button', disabled = false, extra = '' } = {}) {
    const dataAttrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
    return `<button type="${type}"${id ? ` id="${esc(id)}"` : ''} class="btn btn-${variant}${small ? ' btn-small' : ''}"${action ? ` data-action="${esc(action)}"` : ''}${dataAttrs}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}${disabled ? ' disabled' : ''}>${label}${extra}</button>`;
  }

  function setError(id, message) {
    const el = document.getElementById(id);
    const err = document.getElementById(id + '-error');
    if (el) { if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    if (err) { err.textContent = message || ''; err.hidden = !message; }
    if (message && el) el.focus();
  }

  function focusEl(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center' });
    return true;
  }

  // ------------------------------------------------------------------ route
  function routeOf(ctx) {
    const p = ctx.route.params || {};
    const scenarios = ctx.state.scenarios;
    const order = scenarios.map(s => s.id);
    const ids = new Set(order);
    const horizon = HORIZONS.includes(Number(p.horizon)) ? Number(p.horizon) : DEFAULT_HORIZON;
    const bounds = startBounds(ctx);
    const start = E.months.isMonth(p.start) && p.start >= bounds.min && p.start <= bounds.max ? p.start : ctx.forecastStart;
    // Comparison columns keep the scenario order (the current budget first), so differences
    // are always measured against the same reference.
    const pick = list => { const set = new Set(list.filter(id => ids.has(id))); return order.filter(id => set.has(id)).slice(0, MAX_COMPARE); };
    const fromUrl = typeof p.compare === 'string' && p.compare ? pick(p.compare.split(',')) : [];
    const compareFromUrl = fromUrl.length > 0;
    let compare = compareFromUrl ? fromUrl : pick(ctx.state.compareIds || []);
    if (!compare.length) compare = order.slice(0, 1);
    const selected = scenarios.find(s => s.id === p.scenario) || scenarios.find(s => s.id !== BASELINE) || scenarios[0];
    return { horizon, start, compare, compareFromUrl, selected, staleScenario: !!p.scenario && !ids.has(p.scenario) };
  }

  /** Route params for a link, keeping only what differs from the defaults. `over` wins. */
  function linkParams(ctx, R, over = {}) {
    const out = {};
    const scenario = has(over, 'scenario') ? over.scenario : (ctx.route.params.scenario && !R.staleScenario ? R.selected.id : undefined);
    if (scenario) out.scenario = scenario;
    const compare = has(over, 'compare') ? over.compare : (R.compareFromUrl ? R.compare.join(',') : undefined);
    if (compare) out.compare = compare;
    const horizon = Number(has(over, 'horizon') ? over.horizon : R.horizon);
    if (horizon && horizon !== DEFAULT_HORIZON) out.horizon = String(horizon);
    const start = has(over, 'start') ? over.start : R.start;
    if (start && start !== ctx.forecastStart) out.start = start;
    return out;
  }

  function sameParams(a, b) {
    const ka = Object.keys(a).filter(k => a[k] !== '' && a[k] !== undefined);
    const kb = Object.keys(b).filter(k => b[k] !== '' && b[k] !== undefined);
    return ka.length === kb.length && ka.every(k => String(a[k]) === String(b[k]));
  }

  /** Move to new params without losing the focused control; re-render when nothing changes. */
  function go(ctx, params, { focus } = {}) {
    if (focus) pendingFocus = focus;
    if (sameParams(ctx.route.params || {}, params)) ctx.app.render();
    else ctx.app.navigate('forecast', params, { keepFocus: true });
  }

  /** A link that changes params without moving focus off the link (stable id required). */
  function navLink(ctx, params, inner, { id, cls = '', current = false } = {}) {
    const same = sameParams(ctx.route.params || {}, params);
    const nav = same ? '' : ` data-action="navigate" data-view="forecast" data-params="${esc(JSON.stringify(params))}" data-keep-focus="1"`;
    return `<a${id ? ` id="${esc(id)}"` : ''} class="${esc(cls)}" href="${esc(ctx.href('forecast', params))}"${nav}${current ? ' aria-current="true"' : ''}>${inner}</a>`;
  }

  // ------------------------------------------------------------------ projections
  const projOpts = (ctx, R) => ({ startMonth: R.start, months: R.horizon, scope: ctx.scope });
  const scenarioById = (ctx, id) => ctx.state.scenarios.find(s => s.id === id);

  /**
   * The plan with its starting cash read through E.timeline.anchors, the same accessor the plan
   * screen uses: the sum of the accounts with a known balance when there are any (asOf = the
   * latest of their dates), else the joint cash entered in Budget.
   */
  function cashPlan(ctx) {
    return ctx.memo('fc-cash-plan', () => {
      const plan = ctx.state.plan;
      const start = E.timeline.anchors(plan, ctx.dataset, ctx.realTxns || ctx.txns).combined;
      return Object.assign({}, plan, { balances: Object.assign({}, plan.balances, { jointCashCents: start ? start.cents : null, asOf: start ? start.asOf : null }) });
    });
  }

  function comparison(ctx, R) {
    const opts = projOpts(ctx, R);
    return ctx.memo('fc-compare:' + R.compare.join(',') + JSON.stringify(opts), () => E.forecast.compare(cashPlan(ctx), R.compare.map(id => scenarioById(ctx, id)), opts));
  }

  function projection(ctx, R, scenario) {
    const opts = projOpts(ctx, R);
    let cmp = null;
    try { cmp = comparison(ctx, R); } catch { cmp = null; }
    const col = cmp && cmp.columns.find(x => x.scenarioId === scenario.id);
    if (col) return col.projection;
    return ctx.memo('fc-proj:' + scenario.id + JSON.stringify(opts), () => E.forecast.project(cashPlan(ctx), scenario, opts));
  }

  function balanceKnown(ctx) {
    const b = cashPlan(ctx).balances;
    return !!b && E.money.isCents(b.jointCashCents);
  }

  /** Category history ("Usual"), kept apart from targets. Uses the same window as Budget. */
  function usualFor(ctx, category) {
    if (!category || !ctx.latestComplete) return null;
    const win = ctx.state.plan.settings.comparisonWindow || 3;
    const base = ctx.memo('fc-usual:' + win, () => E.compare.planningBaseline(ctx.txns, ctx.dataset, { window: win }));
    const row = base[category];
    if (!row || !row.usableCount) return null;
    // Planning hint: use the planning baseline (rows the household left out of planning, such as
    // a one-off episode, do not count), falling back to the plain average.
    const cents = row.adjustedAvgCents !== undefined && row.adjustedAvgCents !== null ? row.adjustedAvgCents : row.actualAvgCents;
    return { cents, months: row.months || [], count: row.usableCount };
  }

  function spendingLink(ctx, category, months) {
    const list = months && months.length ? months : ctx.months.slice(-12);
    if (!list.length) return null;
    const period = list.length === 1 ? list[0] : list[0] + '..' + list[list.length - 1];
    return ctx.href('spending', category ? { period, cat: category } : { period });
  }

  /** Where in Budget a missing plan input is fixed (same field ids as the Budget view). */
  function budgetFix(ctx, m) {
    const plan = ctx.state.plan;
    const id = String(m.id || '');
    const bid = (kind, key) => domId('bud-' + kind, String(key));
    if (id.startsWith('target:')) return ctx.href('budget', { section: 'targets', focus: bid('target', id.slice(7)) });
    if (id.startsWith('personal:')) {
      // Blocked by an unknown transfer into joint: that amount is the field to fill in.
      const blocked = (plan.incomes || []).find(s => s.personId === id.slice(9) && s.kind === 'contribution' && !E.money.isCents(s.jointPerPaycheckCents));
      return ctx.href('budget', { section: 'income', focus: blocked ? bid('inc-joint', blocked.id) : bid('personal', id.slice(9)) });
    }
    if (id.startsWith('pay:')) return ctx.href('budget', { section: 'income', focus: 'bud-add-income-name' });
    if (id === 'jointCash') return ctx.href('budget', { section: 'savings', focus: 'bud-cash' });
    const stream = (plan.incomes || []).find(s => s.id === id);
    if (stream) return ctx.href('budget', { section: 'income', focus: bid(ctx.scope === 'joint' || stream.kind === 'contribution' ? 'inc-joint' : 'inc-net', id) });
    const bill = (plan.bills || []).find(b => b.id === id);
    if (bill) return ctx.href('budget', { section: 'bills', focus: bid(bill.fundedFrom === 'unknown' && ctx.scope === 'joint' ? 'bill-from' : 'bill-amt', id) });
    const goal = (plan.savings || []).find(g => g.id === id);
    if (goal) return ctx.href('budget', { section: 'savings', focus: bid('goal-monthly', id) });
    return ctx.href('budget');
  }

  // ------------------------------------------------------------------ events: facts
  /** Blank amounts/dates on an event, in form order. */
  function eventGaps(ev) {
    const out = [];
    switch (ev.type) {
      case 'one_time':
        if (ev.amountCents === null || ev.amountCents === undefined) out.push({ field: 'amountCents', text: 'Amount missing' });
        if (!ev.month) out.push({ field: 'month', text: 'Month not set' });
        break;
      case 'recurring':
        if (ev.monthlyCents === null || ev.monthlyCents === undefined) out.push({ field: 'monthlyCents', text: 'Amount missing' });
        if (!ev.startMonth) out.push({ field: 'startMonth', text: 'Start month not set' });
        break;
      case 'income_change':
        if (has(ev, 'jointPerPaycheckCents') && ev.jointPerPaycheckCents === null) out.push({ field: 'jointPerPaycheckCents', text: 'Joint amount unknown' });
        if (has(ev, 'netPerPaycheckCents') && ev.netPerPaycheckCents === null) out.push({ field: 'netPerPaycheckCents', text: 'Take-home unknown' });
        break;
      case 'bill_change':
      case 'target_change':
        if (ev.monthlyCents === null || ev.monthlyCents === undefined) out.push({ field: 'monthlyCents', text: 'Amount missing' });
        break;
      case 'goal':
        if (!ev.goal || ev.goal.targetCents === null) out.push({ field: 'goal.targetCents', text: 'Target missing' });
        if (!ev.goal || ev.goal.monthlyCents === null) out.push({ field: 'goal.monthlyCents', text: 'Monthly amount missing' });
        break;
      default:
    }
    return out;
  }

  /** 'in' | 'before' | 'after' the forecast months, or null when undated. */
  function eventRange(ev, R) {
    const end = E.months.add(R.start, R.horizon - 1);
    if (ev.type === 'goal') return 'in';
    if (ev.type === 'one_time') {
      if (!ev.month) return null;
      return ev.month < R.start ? 'before' : ev.month > end ? 'after' : 'in';
    }
    if (!ev.startMonth) return null;
    if (ev.startMonth > end) return 'after';
    if (ev.endMonth && ev.endMonth < R.start) return 'before';
    return 'in';
  }

  function eventWhen(ev) {
    if (ev.type === 'goal') return ev.goal && ev.goal.targetMonth ? 'By ' + monthName(ev.goal.targetMonth) : 'No target month';
    if (ev.type === 'one_time') return ev.month ? monthName(ev.month) : 'Month not set';
    if (!ev.startMonth) return 'Start not set';
    if (ev.endMonth === ev.startMonth) return monthName(ev.startMonth) + ' only';
    return 'From ' + monthName(ev.startMonth) + (ev.endMonth ? ' to ' + monthName(ev.endMonth) : '');
  }

  function eventAmount(ctx, ev) {
    const miss = ''; // the "Amount missing" badge says it once
    switch (ev.type) {
      case 'one_time':
        if (!known(ev.amountCents)) return miss;
        return ev.direction === 'income' ? `<span class="tone-good">+${esc(whole(ev.amountCents))}</span> in` : `${esc(whole(ev.amountCents))} cost`;
      case 'recurring':
        if (!known(ev.monthlyCents)) return miss;
        if (ev.direction === 'income') return `<span class="tone-good">+${esc(whole(ev.monthlyCents))}</span> a month`;
        if (ev.direction === 'income_loss') return `${esc(whole(ev.monthlyCents))} a month less income`;
        return `${esc(whole(ev.monthlyCents))} a month`;
      case 'income_change': {
        if (!has(ev, 'jointPerPaycheckCents') && !has(ev, 'netPerPaycheckCents')) return 'No change entered';
        const part = (f, word) => (has(ev, f) && known(ev[f]) ? `${word}: ${esc(money(ev[f]))}` : '');
        const parts = [part('jointPerPaycheckCents', 'To joint'), part('netPerPaycheckCents', 'Take-home')].filter(Boolean);
        return parts.length ? parts.join(' · ') + ' per paycheck' : '';
      }
      case 'bill_change':
        if (!known(ev.monthlyCents)) return miss;
        return ev.monthlyCents === 0 ? 'Stops ($0)' : `${esc(whole(ev.monthlyCents))} a month`;
      case 'target_change':
        return known(ev.monthlyCents) ? `${esc(whole(ev.monthlyCents))} a month` : miss;
      case 'goal':
        return ev.goal && known(ev.goal.targetCents) ? `Target ${esc(whole(ev.goal.targetCents))}` : '';
      default:
        return '';
    }
  }

  /** Every savings goal this scenario sees: the plan's, replaced or added by goal events. */
  function goalOptions(ctx, s) {
    const map = new Map((ctx.state.plan.savings || []).map(g => [g.id, g.label]));
    for (const ev of s.events) if (ev.type === 'goal' && ev.goal && ev.goal.id) map.set(ev.goal.id, ev.goal.label || ev.label);
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }

  /** Why a projection's running totals are unknown, and the input that fixes it. */
  function unknownInfo(ctx, proj, scenario) {
    const first = proj.rows.find(r => r.netCents === null);
    if (!first) return null;
    const plan = ctx.state.plan;
    const incomeIds = new Set((plan.incomes || []).map(s => s.id));
    const evType = id => { const ev = scenario && scenario.events.find(e => e.id === id); return ev ? ev.type : null; };
    const personal = first.netUnknownReason === 'personal_spending';
    const item = proj.missing.find(m => {
      const id = String(m.id || '');
      if (m.source === 'event') return evType(m.id) === 'income_change';
      return personal ? id.startsWith('personal:') : (incomeIds.has(m.id) || id.startsWith('pay:'));
    }) || null;
    const all = proj.rows.every(r => r.netCents === null);
    const why = personal ? "someone's personal spending can't be worked out because their transfer to joint is unknown" : 'some income is not entered';
    return { month: first.month, all, personal, item, text: (all ? 'Unknown in every month: ' : `Unknown from ${monthName(first.month)}: `) + why + '.' };
  }

  /** Every month's net is unknown, so counts such as "months with cash going down" are unknown too. */
  const noKnownMonth = proj => proj.summary.unknownNetMonths.length === proj.rows.length;

  /** Lowest known value of the measure shown (balance or change in cash) and its month. */
  function lowestOf(proj, bal) {
    let lo = null;
    for (const r of proj.rows) {
      const v = bal ? r.balanceCents : r.cumulativeCents;
      if (known(v) && (lo === null || v < lo.cents)) lo = { cents: v, month: r.month };
    }
    return lo;
  }

  /** First month with a projected balance: the entered balance already includes its own month. */
  function balanceOpenMonth(ctx) {
    const asOf = cashPlan(ctx).balances.asOf;
    return asOf && E.dates.isDate(asOf) ? E.months.of(E.dates.addDays(asOf, 1)) : null;
  }

  /** Earliest and latest start month offered: ten years either side of the default start. */
  const startBounds = ctx => ({ min: E.months.add(ctx.forecastStart, -120), max: E.months.add(ctx.forecastStart, 120) });

  /** Link or button that fixes one missing item (Budget for plan inputs, the event field here). */
  function fixControl(ctx, R, m, scenario, { label = 'Fix' } = {}) {
    if (!m) return '';
    if (m.source === 'event' && scenario) {
      const ev = scenario.events.find(e => e.id === m.id);
      if (ev) {
        const gap = eventGaps(ev)[0];
        const target = gap ? fieldId(ev.id, gap.field) : domId('fc-ev', ev.id);
        if (scenario.id === R.selected.id) return btn(`${esc(label)}<span class="sr-only">: ${esc(m.label)}</span>`, { action: 'fc:focus', data: { target } });
        return `<a class="btn btn-small btn-secondary" href="${esc(ctx.href('forecast', linkParams(ctx, R, { scenario: scenario.id })))}" data-action="fc:goto" data-scenario="${esc(scenario.id)}" data-target="${esc(target)}">${esc(label)}<span class="sr-only">: ${esc(m.label)}</span></a>`;
      }
    }
    return `<a class="btn btn-small btn-secondary" href="${esc(budgetFix(ctx, m))}">${esc(label === 'Fix' ? 'Fix in Budget' : label)}<span class="sr-only">: ${esc(m.label)}</span></a>`;
  }

  function settingsText(a) {
    const t = TIMING[a.incomeTiming] ? TIMING[a.incomeTiming].short : 'Budget setting';
    const pct = v => (v > 0 ? '+' : '') + (v || 0) + '%';
    const parts = [t];
    parts.push((a.costGrowthPct || a.incomeGrowthPct) ? `costs ${pct(a.costGrowthPct)} a year, pay ${pct(a.incomeGrowthPct)} a year` : 'no growth');
    parts.push(a.annualReturnPct > 0 ? `hypothetical return ${a.annualReturnPct}%` : 'no return (0%)');
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------ header
  function header(ctx, R) {
    const scopeCtl = c.segmented({ label: 'Show', name: 'scope', options: SCOPE_OPTIONS, value: ctx.scope, action: 'set-scope' });
    const horizonCtl = c.segmented({ label: 'Months ahead', name: 'fc-horizon', options: HORIZONS.map(h => ({ value: h, label: String(h) })), value: R.horizon, action: 'fc:horizon' });
    const b = startBounds(ctx);
    const startCtl = `<div class="field fc-start"><label for="fc-start">Starting month</label><input id="fc-start" type="month" value="${esc(R.start)}" min="${esc(b.min)}" max="${esc(b.max)}" data-action="fc:start" aria-describedby="fc-start-error"><p class="field-error" id="fc-start-error" role="alert" hidden></p></div>`;
    return c.pageHeader({
      eyebrow: 'Forecast',
      title: 'Plan ahead with scenarios',
      subtitle: `What planned changes, such as a baby, home repairs or a trip, do to your ${ctx.scope === 'joint' ? 'joint accounts' : 'household'} month by month.`,
      actions: `<div class="fc-controls">${scopeCtl}${horizonCtl}${startCtl}</div>`,
    });
  }

  function startNote(ctx, R) {
    const lastData = ctx.months.length ? ctx.months[ctx.months.length - 1] : null;
    const end = E.months.add(R.start, R.horizon - 1);
    const parts = [`Forecast: <strong>${esc(fmt.month(R.start))} – ${esc(fmt.month(end))}</strong> (${R.horizon} months)`];
    if (R.start === ctx.forecastStart) parts.push(lastData ? `starting the month after your latest imported data (${esc(fmt.month(lastData))}).` : 'starting this month.');
    else parts.push(`— ${navLink(ctx, linkParams(ctx, R, { start: undefined }), `start in ${esc(fmt.month(ctx.forecastStart))} instead`, { id: 'fc-start-reset' })}.`);
    let warn = '';
    if (lastData && R.start <= lastData) {
      const link = spendingLink(ctx, null, ctx.months.filter(m => m >= R.start));
      warn = c.notice({ tone: 'warn', title: 'This start month overlaps your imported data.', body: `The forecast is built from your budget, not from what actually happened. ${link ? `<a href="${esc(link)}">See what actually happened in Spending</a>.` : ''}` });
    }
    return `<p class="fc-rule">${c.badge('Safe to explore', 'info')} Scenarios never change what actually happened or your budget. Edits here only affect the scenario you are editing.</p>
      <p class="fine fc-range">${parts.join(', ')}</p>${warn}`;
  }

  // ------------------------------------------------------------------ scenario bar
  function scenarioRow(ctx, R, s) {
    const isBase = s.id === BASELINE;
    const selected = s.id === R.selected.id;
    const inCmp = R.compare.includes(s.id);
    const cmpDisabled = !inCmp && R.compare.length >= MAX_COMPARE;
    const cmpId = domId('fc-cmp', s.id);
    const gapsN = s.events.filter(ev => eventGaps(ev).length).length;
    const meta = isBase
      ? 'Your budget as entered. It cannot hold changes and is always kept; to change it, edit the budget.'
      : [s.description ? short(s.description, 120) : '', plural(s.events.length, 'change')].filter(Boolean).join(' · ');
    const badges = [
      // The current budget is shown, not edited here (it cannot hold changes).
      selected ? c.badge(isBase ? 'Showing' : 'Editing', 'good') : '',
      gapsN ? c.badge(plural(gapsN, 'change') + ' missing amounts', 'warn') : '',
    ].filter(Boolean).join(' ');
    const name = navLink(ctx, linkParams(ctx, R, { scenario: s.id }), esc(s.name), { id: domId('fc-sel', s.id), cls: 'fc-sc-name', current: selected });
    const actions = isBase
      ? `${btn('Copy into a new scenario', { id: domId('fc-dup', s.id), action: 'fc:duplicate', data: { id: s.id } })}<a class="btn btn-small btn-ghost" href="${esc(ctx.href('budget'))}">Edit the budget</a>`
      : [
        btn('Rename', { id: domId('fc-ren', s.id), action: 'fc:rename-open', data: { id: s.id }, ariaLabel: 'Rename ' + s.name }),
        btn('Copy', { id: domId('fc-dup', s.id), action: 'fc:duplicate', data: { id: s.id }, ariaLabel: 'Copy ' + s.name + ' into a new scenario' }),
        btn('Delete', { id: domId('fc-del', s.id), action: 'fc:delete', variant: 'danger', data: { id: s.id }, ariaLabel: 'Delete ' + s.name }),
      ].join('');
    const rename = ui.renaming === s.id && !isBase ? `<form class="fc-rename inline-form" data-action="fc:rename" data-id="${esc(s.id)}" aria-label="Rename ${esc(s.name)}">
        <div class="field"><label for="fc-rename-name">New name</label><input id="fc-rename-name" name="name" value="${esc(s.name)}" maxlength="${LIMITS.label || 80}" autocomplete="off" aria-describedby="fc-rename-name-error"><p class="field-error" id="fc-rename-name-error" role="alert" hidden></p></div>
        <div class="inline-form-actions">${btn('Save name', { id: 'fc-rename-save', type: 'submit', variant: 'primary' })}${btn('Cancel', { id: 'fc-rename-cancel', action: 'fc:rename-cancel', data: { id: s.id } })}</div>
      </form>` : '';
    return `<li class="fc-sc${selected ? ' is-selected' : ''}" data-scenario-id="${esc(s.id)}">
      <div class="fc-sc-main">${name} ${badges}<p class="fc-sc-meta">${esc(meta)}</p></div>
      <div class="fc-sc-compare"><label class="check" for="${esc(cmpId)}"><input type="checkbox" id="${esc(cmpId)}" data-action="fc:compare" data-id="${esc(s.id)}"${inCmp ? ' checked' : ''}${cmpDisabled ? ' disabled aria-describedby="fc-cmp-limit"' : ''}> Compare</label></div>
      <div class="fc-sc-actions">${actions}</div>
      ${rename}
    </li>`;
  }

  function newScenarioForm(ctx) {
    const st = ctx.state;
    const full = st.scenarios.length >= MAX_SCENARIOS;
    const opts = [`<option value="">Nothing yet: the current budget only</option>`]
      .concat(st.scenarios.filter(s => s.id !== BASELINE).map(s => `<option value="${esc(s.id)}">A copy of “${esc(s.name)}”</option>`)).join('');
    return `<form class="fc-new" data-action="fc:create" aria-labelledby="fc-new-h">
      <h3 id="fc-new-h">New scenario</h3>
      ${full ? `<p class="fine">You have ${MAX_SCENARIOS} scenarios, the most that can be kept. Delete one you no longer need first.</p>` : ''}
      <div class="fc-new-grid">
        <div class="field"><label for="fc-new-name">Name</label><input id="fc-new-name" name="name" maxlength="${LIMITS.label || 80}" autocomplete="off" placeholder="e.g. New roof next spring" aria-required="true" aria-describedby="fc-new-name-error"${full ? ' disabled' : ''}><p class="field-error" id="fc-new-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="fc-new-from">Start with</label><select id="fc-new-from" name="copyFrom"${full ? ' disabled' : ''}>${opts}</select></div>
        <div class="fc-new-submit">${btn('Create scenario', { id: 'fc-new-submit', type: 'submit', variant: 'primary', small: false, disabled: full })}</div>
      </div>
    </form>`;
  }

  function scenarioBar(ctx, R) {
    const full = R.compare.length >= MAX_COMPARE;
    return `<section class="card fc-bar" id="fc-scenarios" aria-labelledby="fc-scenarios-h">
      <div class="card-head"><div><h2 id="fc-scenarios-h" tabindex="-1">Scenarios</h2><p class="card-sub">Select a scenario to edit it. Tick up to ${MAX_COMPARE} to compare them side by side.</p></div></div>
      <ul class="fc-sc-list">${ctx.state.scenarios.map(s => scenarioRow(ctx, R, s)).join('')}</ul>
      <p class="fine" id="fc-cmp-limit"${full ? '' : ' hidden'}>${MAX_COMPARE} scenarios are being compared, the most at once. Untick one to compare another.</p>
      ${newScenarioForm(ctx)}
    </section>`;
  }

  // ------------------------------------------------------------------ comparison
  function compareCard(ctx, R, cmp) {
    const cols = cmp.columns;
    const first = cols[0];
    const bal = balanceKnown(ctx);
    const scenarios = cols.map(col => scenarioById(ctx, col.scenarioId));
    const infos = cols.map((col, i) => unknownInfo(ctx, col.projection, scenarios[i]));
    const end = first.projection.endMonth;
    const labels = first.projection.rows.map(r => r.month);
    const measure = bal ? 'balanceCents' : 'cumulativeCents';
    const where = ctx.scope === 'joint' ? 'joint cash' : 'household cash';
    const title = bal ? 'Projected joint cash balance' : `Change in ${where} since the start of ${fmt.month(R.start)}`;
    const series = cols.map(col => ({ name: col.name, values: col.projection.rows.map(r => r[measure]) }));
    const anyKnown = series.some(s => s.values.some(known));

    const gaps = cols.map((col, i) => (infos[i] ? `<li><strong>${esc(col.name)}</strong>: ${esc(infos[i].text)}${infos[i].item ? ` <span class="fc-cause">Missing: ${esc(infos[i].item.label)}.</span>` : ''} ${fixControl(ctx, R, infos[i].item, scenarios[i], { label: 'Enter it' })}</li>` : '')).filter(Boolean);
    const measureNote = bal
      ? `Each line is one scenario's projected joint cash, starting from the balance entered in Budget${ctx.scope === 'household' ? ' (money in personal accounts is not included)' : ''}.`
      : `Each line is one scenario's running change in ${where}, starting at $0. <a href="${esc(budgetFix(ctx, { id: 'jointCash' }))}">Enter today's joint cash balance</a> to see projected balances instead.`;
    const chart = anyKnown
      ? c.lineChart({ id: 'fc-chart', title, series, labels, tableCaption: title + ' by month', description: measureNote + (gaps.length ? ' A line stops where the month is unknown.' : '') })
      : c.notice({ tone: 'warn', title: 'The chart needs complete income.', body: 'Every month is unknown in these scenarios, so there is nothing to draw yet.' });

    const rowsBy = Object.fromEntries(cmp.rows.map(r => [r.key, r]));
    const cell = (key, i, { signed = false, tone = true } = {}) => {
      const row = rowsBy[key];
      const v = row.values[i];
      const col = cols[i];
      if (v === null || v === undefined) {
        return `<span class="fc-unknown" data-key="${esc(key)}" data-scenario="${esc(col.scenarioId)}" data-cents="">Unknown</span>${infos[i] ? `<small>${esc(infos[i].all ? 'Income missing' : 'Unknown from ' + monthName(infos[i].month))}</small>` : ''}`;
      }
      const d = row.deltas[i];
      const delta = i === 0 ? '' : `<small class="fc-delta">${d === null ? 'Difference unknown' : d === 0 ? 'Same' : esc(fmt.diff(d, { whole: true }))}<span class="sr-only"> compared with ${esc(first.name)}</span></small>`;
      return `<span class="fc-v${tone && v < 0 ? ' tone-bad' : ''}" data-key="${esc(key)}" data-scenario="${esc(col.scenarioId)}" data-cents="${v}">${esc(signed ? signedWhole(v) : whole(v))}</span>${delta}`;
    };
    const per = fn => Object.fromEntries(cols.map((col, i) => ['c' + i, fn(i, col)]));
    // When later months are unknown, a lowest point or a count can only describe the known months.
    const knownOnly = i => (cols[i].projection.summary.unknownNetMonths.length ? '<small class="fc-known-only">Known months only</small>' : '');
    const noneKnown = (i, key, col) => `<span class="fc-unknown" data-key="${esc(key)}" data-scenario="${esc(col.scenarioId)}">Unknown</span><small>No month is known yet</small>`;
    const display = [
      { label: 'Money coming in', ...per(i => cell('totalIncome', i, { tone: false })) },
      { label: 'Money going out', ...per(i => cell('totalOut', i, { tone: false })) },
      { label: `<strong>Change in cash by ${esc(fmt.month(end))}</strong>`, ...per(i => cell('endCumulative', i, { signed: true })) },
      ...(bal ? [{ label: `<strong>Cash at the end of ${esc(fmt.month(end))}</strong>`, ...per(i => cell('endBalance', i)) }] : []),
      { label: bal ? 'Lowest balance' : 'Lowest point (change in cash)', ...per((i, col) => {
        const lo = lowestOf(col.projection, bal);
        if (!lo) return noneKnown(i, 'lowest', col);
        const v = lo.cents;
        return `<span class="fc-v${v < 0 ? ' tone-bad' : ''}" data-key="lowest" data-scenario="${esc(col.scenarioId)}" data-cents="${v}">${esc(bal ? whole(v) : signedWhole(v))}</span><small>${esc(fmt.month(lo.month))}</small>${knownOnly(i)}`;
      }) },
      { label: 'Months with more going out than coming in', ...per((i, col) => {
        if (noKnownMonth(col.projection)) return noneKnown(i, 'negativeMonths', col);
        const list = col.projection.summary.negativeMonths;
        return `<span class="fc-v${list.length ? ' tone-warn' : ''}" data-key="negativeMonths" data-scenario="${esc(col.scenarioId)}">${list.length}</span>${list.length ? `<small>${esc(list.slice(0, 4).map(fmt.month).join(', ') + (list.length > 4 ? '…' : ''))}</small>` : ''}${knownOnly(i)}`;
      }) },
      ...(bal ? [{ label: 'First month cash falls below $0', ...per((i, col) => {
        const m = col.projection.summary.firstNegativeBalanceMonth;
        if (m) return `<span class="tone-bad">${esc(fmt.month(m))}</span>`;
        if (!lowestOf(col.projection, true)) return noneKnown(i, 'firstNegativeBalance', col);
        return '<span>None</span>' + knownOnly(i);
      }) }] : []),
      { label: 'Set aside for savings goals', ...per(i => cell('savedForGoals', i, { tone: false })) },
      { label: 'Savings goals', ...per((i, col) => {
        const goals = col.projection.goals;
        if (!goals.length) return '<span>None</span>';
        const funded = goals.filter(g => g.status === 'funded').length;
        const shortList = goals.filter(g => g.status === 'short');
        const unclear = goals.filter(g => ['unknown_start', 'missing_amount'].includes(g.status));
        return `<span class="fc-v" data-key="goalsFunded" data-scenario="${esc(col.scenarioId)}">${funded} of ${goals.length} funded</span>${shortList.length ? `<small class="tone-bad">Short: ${esc(shortList.map(g => g.label + ' ' + whole(g.shortfallCents)).join(', '))}</small>` : ''}${unclear.length ? `<small>Unclear: ${esc(unclear.map(g => g.label).join(', '))}</small>` : ''}`;
      }) },
      { label: 'Missing amounts (left out of totals)', ...per((i, col) => {
        const n = col.projection.missing.length;
        return `<span class="fc-v${n ? ' tone-warn' : ''}" data-key="missing" data-scenario="${esc(col.scenarioId)}">${n}</span>`;
      }) },
      { label: 'How it is calculated', ...per((i, col) => `<small class="fc-settings-text">${esc(settingsText(scenarios[i].assumptions || {}))}</small>`) },
    ];
    const columns = [{ key: 'label', label: 'Compared', html: r => r.label }]
      .concat(cols.map((col, i) => ({ key: 'c' + i, label: col.name, align: 'right', html: r => r['c' + i], cls: 'fc-cmp-col' })));
    const table = c.table({ caption: `Scenario comparison, ${fmt.month(R.start)} – ${fmt.month(end)}`, columns, rows: display, cls: 'fc-cmp-table' });

    const settingsDiffer = new Set(scenarios.map(s => JSON.stringify(s.assumptions || {}))).size > 1;
    const mismatch = settingsDiffer ? c.notice({
      tone: 'warn',
      title: 'These scenarios are calculated differently.',
      body: 'Their income timing, growth or return settings differ, so the differences below are not only from their changes.',
      actions: btn(`Use the settings of “${esc(short(first.name, 40))}” for all ${cols.length}`, { id: 'fc-align', action: 'fc:align-settings' }),
    }) : '';
    const legendNote = cols.length > 1 ? `<p class="fine">Differences (+ or −) compare each scenario with <strong>${esc(first.name)}</strong>.</p>` : '<p class="fine">Tick another scenario above to compare it with this one.</p>';
    const unknownList = gaps.length ? `<ul class="fc-unknown-list">${gaps.join('')}</ul>` : '';
    return `<section class="card fc-compare" id="fc-compare" aria-labelledby="fc-compare-h">
      <div class="card-head"><div><h2 id="fc-compare-h">Compare scenarios</h2><p class="card-sub">${esc(ctx.scope === 'joint' ? 'Joint accounts' : 'Whole household')}, ${esc(fmt.month(R.start))} – ${esc(fmt.month(end))}. ${esc(bal ? 'Projected balance.' : 'Change in cash from the start.')}</p></div></div>
      ${mismatch}
      ${chart}
      ${unknownList}
      ${legendNote}
      ${table}
    </section>`;
  }

  // ------------------------------------------------------------------ selected scenario: result + settings
  function resultStrip(ctx, R, proj, baseProj) {
    const s = R.selected;
    const sm = proj.summary;
    const bal = proj.startBalanceCents !== null;
    const end = fmt.month(proj.endMonth);
    const value = bal ? sm.endBalanceCents : sm.endCumulativeCents;
    const info = unknownInfo(ctx, proj, s);
    let sub;
    if (value === null) sub = esc(info ? info.text : 'Unknown.');
    else if (s.id !== BASELINE && baseProj) {
      const b = bal ? baseProj.summary.endBalanceCents : baseProj.summary.endCumulativeCents;
      const d = b === null ? null : value - b;
      sub = d === null ? 'The current budget is unknown here, so no difference.' : d === 0 ? 'Same as the current budget.' : `<strong class="${d < 0 ? 'tone-bad' : 'tone-good'}">${esc(signedWhole(d))}</strong> compared with the current budget.`;
    } else sub = bal ? 'Projected from the balance entered in Budget.' : 'If the budget is followed exactly.';
    const neg = sm.negativeMonths;
    const goals = proj.goals;
    const funded = goals.filter(g => g.status === 'funded').length;
    const partly = sm.unknownNetMonths.length > 0;
    const negMetric = noKnownMonth(proj)
      ? { value: 'Unknown', tone: '', sub: 'No month is known yet' }
      : {
        value: String(neg.length),
        tone: neg.length ? 'warn' : '',
        sub: (neg.length ? esc(neg.slice(0, 3).map(fmt.month).join(', ') + (neg.length > 3 ? '…' : '')) : 'None') + (partly ? ` <span class="fc-known-only">(known months only: ${esc(plural(sm.unknownNetMonths.length, 'month'))} unknown)</span>` : ''),
      };
    return `<div class="metrics fc-result" aria-label="Result for ${esc(s.name)}">
      ${c.metric({
        label: bal ? `Cash at the end of ${end}` : `Change in cash by ${end}`,
        value: value === null ? 'Unknown' : (bal ? whole(value) : signedWhole(value)),
        tone: value !== null && value < 0 ? 'bad' : '',
        status: value !== null && proj.missing.length ? c.badge('Incomplete', 'warn') : '',
        sub: sub + (value !== null && proj.missing.length ? ` <span class="fc-known-only">Leaves out ${esc(plural(proj.missing.length, 'missing amount'))}.</span>` : ''),
      })}
      ${c.metric({ label: 'Months with more going out', ...negMetric })}
      ${c.metric({ label: 'Missing amounts', value: String(proj.missing.length), tone: proj.missing.length ? 'warn' : '', sub: proj.missing.length ? 'Left out of these totals, not counted as $0' : 'Everything needed is entered' })}
      ${c.metric({ label: 'Savings goals funded', value: goals.length ? `${funded} of ${goals.length}` : '—', tone: goals.some(g => g.status === 'short') ? 'warn' : '', sub: goals.length ? 'See the goals panel' : 'No goals yet' })}
    </div>`;
  }

  function timingHelp(ctx, R) {
    const streams = (ctx.state.plan.incomes || []).filter(st => st.frequency && st.frequency !== 'unknown');
    const end = E.months.add(R.start, R.horizon - 1);
    const months = E.months.range(R.start, end);
    const lines = streams.map(st => {
      let extra = '';
      if (st.frequency === 'biweekly' || st.frequency === 'weekly') {
        const typical = E.schedule.TYPICAL[st.frequency];
        const hits = months.filter(m => { try { return E.schedule.count(st, m, 'actual').count > typical; } catch { return false; } });
        extra = hits.length ? ` With actual paydays, ${listText(hits.map(fmt.month))} ${hits.length === 1 ? 'has' : 'have'} an extra ${st.kind === 'contribution' ? 'transfer' : 'paycheck'} in this forecast.` : '';
      }
      return `<li><strong>${esc(st.label)}</strong>: ${esc(FREQ_TEXT[st.frequency] || st.frequency)}.${esc(extra)}</li>`;
    });
    return `<p>Biweekly pay (every other Friday) gives 26 paychecks a year, so two or three months a year have <strong>three</strong>. Twice-monthly pay (for example the 1st and 15th) is always two a month.</p>
      <ul class="fc-help-list">
        <li><strong>Actual paydays</strong> count the real paydays in each month: the extra paychecks land in the months they really arrive.</li>
        <li><strong>Typical month</strong> counts 2 biweekly paychecks every month and leaves the extra ones out, as a cushion.</li>
        <li><strong>Annual average</strong> spreads them evenly (26 ÷ 12 ≈ 2.17 a month): smooth, but no real month looks like that.</li>
      </ul>
      ${lines.length ? `<p>In this budget:</p><ul class="fc-help-list">${lines.join('')}</ul>` : ''}`;
  }

  function settingsSection(ctx, R) {
    const s = R.selected;
    const a = s.assumptions || {};
    const base = `scenarios[id=${s.id}].assumptions.`;
    const timingSel = withMessage(c.selectField({
      id: 'fc-timing', label: 'Count paychecks using', path: base + 'incomeTiming', value: a.incomeTiming,
      options: Object.entries(TIMING).map(([value, t]) => ({ value, label: t.option })),
      help: 'Actual paydays are recommended for forecasts: they show the months with an extra paycheck. Bills and spending targets are monthly amounts either way.',
    }), `Income timing changed for “${s.name}”.`);
    const rate = (id, field, label, help, min, max) => `<div class="field">
        <label for="${id}">${esc(label)} <span class="fc-hypo">optional, hypothetical</span></label>
        <div class="fc-pct"><input id="${id}" type="number" inputmode="decimal" step="0.1" min="${min}" max="${max}" value="${esc(String(a[field] ?? 0))}" data-action="fc:rate" data-field="${field}" data-scenario="${esc(s.id)}" aria-describedby="${id}-help ${id}-error"><span aria-hidden="true">%</span></div>
        <p class="field-help" id="${id}-help">${help}</p>
        <p class="field-error" id="${id}-error" role="alert" hidden></p>
      </div>`;
    return `<details class="disclosure fc-settings" id="fc-settings">
      <summary>How this scenario is calculated: <span class="fc-settings-text">${esc(settingsText(a))}</span></summary>
      <div class="disclosure-body">
        ${s.id === BASELINE ? '<p class="fine">These settings change only how the forecast is calculated, not your budget.</p>' : ''}
        <div class="fc-settings-grid">
          ${timingSel}
          ${rate('fc-cost-growth', 'costGrowthPct', 'Cost growth, % a year', 'Applies to spending targets and non-loan bills every 12 months. 0 means today’s amounts.', -50, 50)}
          ${rate('fc-income-growth', 'incomeGrowthPct', 'Pay growth, % a year', 'Applies to paychecks every 12 months, not to transfers between your accounts.', -50, 50)}
          ${rate('fc-return', 'annualReturnPct', 'Annual return on cash, %', 'Stays 0 unless you set it. Applied only to a known, positive cash balance. An illustration, not a promise.', 0, 25)}
        </div>
        <div class="fc-timing-help">${timingHelp(ctx, R)}</div>
      </div>
    </details>`;
  }

  // ------------------------------------------------------------------ selected scenario: events
  function categoryOptions(ctx, current, { allowNone = true } = {}) {
    const names = new Set(UI.shared && UI.shared.categoryOptions ? UI.shared.categoryOptions(ctx) : E.categories.names());
    if (current) names.add(current);
    const list = E.categories.sortNames([...names]);
    return (allowNone ? [{ value: '__null__', label: 'No category' }] : []).concat(list.map(n => ({ value: n, label: n })));
  }

  function changeAmountField(ctx, s, ev, field, label, help, current) {
    const id = fieldId(ev.id, field);
    if (!has(ev, field)) {
      return `<div class="field fc-mode-field">
        <p class="fc-label">${esc(label)}</p>
        <p class="fc-unchanged">Unchanged: uses the budget amount${current !== null && current !== undefined ? ` (${esc(money(current))})` : ''}.</p>
        ${btn('Set an amount for this change', { id: id + '-set', action: 'fc:ev-mode', data: { scenario: s.id, event: ev.id, field, mode: 'set' } })}
      </div>`;
    }
    const status = ev[field] === null ? c.badge('Unknown', 'warn') : '';
    return `<div class="fc-mode-field">${withMessage(c.moneyField({ id, label, path: evPath(s.id, ev.id, field), cents: ev[field], help: help + ' Blank = unknown (listed as missing).', placeholder: 'Unknown', status }), `Saved in “${s.name}”. Your budget is unchanged.`)}
      ${btn('Use the budget amount instead', { id: id + '-keep', action: 'fc:ev-mode', variant: 'ghost', data: { scenario: s.id, event: ev.id, field, mode: 'keep' } })}</div>`;
  }

  function goalField(s, ev, field, label, type, value, { help = '', options } = {}) {
    const id = fieldId(ev.id, 'goal.' + field);
    const data = `data-action="fc:goal-field" data-scenario="${esc(s.id)}" data-event="${esc(ev.id)}" data-field="${field}" data-type="${type}" aria-describedby="${id}-help ${id}-error"`;
    const status = type === 'money' && value === null && ['targetCents', 'monthlyCents'].includes(field) ? ' ' + c.badge('Missing', 'warn') : '';
    let input;
    if (type === 'money') input = `<div class="input-money"><span aria-hidden="true">$</span><input id="${id}" type="text" inputmode="decimal" autocomplete="off" value="${esc(UI.dom.centsToInput(value))}" placeholder="Not entered" ${data}></div>`;
    else if (type === 'month') input = `<input id="${id}" type="month" value="${esc(value || '')}" ${data}>`;
    else if (type === 'bool') input = `<select id="${id}" ${data}>${options.map(o => `<option value="${o.value}"${String(value) === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    else if (type === 'note') input = `<textarea id="${id}" rows="2" maxlength="${LIMITS.note || 500}" ${data.replace('data-type="note"', 'data-type="text"')}>${esc(value || '')}</textarea>`;
    else input = `<input id="${id}" type="text" value="${esc(value || '')}" maxlength="${LIMITS.label || 80}" ${data}>`;
    return `<div class="field${type === 'note' ? ' fc-note' : ''}"><label for="${id}">${esc(label)}${status}</label>${input}<p class="field-help" id="${id}-help">${help}</p><p class="field-error" id="${id}-error" role="alert" hidden></p></div>`;
  }

  function eventForm(ctx, R, s, ev) {
    const plan = ctx.state.plan;
    const msg = `Saved in “${s.name}”. Your budget is unchanged.`;
    const P = f => evPath(s.id, ev.id, f);
    const F = f => fieldId(ev.id, f);
    const bind = html => withMessage(html, msg);
    const label = () => bind(c.textField({ id: F('label'), label: 'Name', path: P('label'), value: ev.label, maxlength: LIMITS.label || 80 }));
    const note = () => `<div class="field fc-note"><label for="${esc(F('note'))}">Note (optional)</label><textarea id="${esc(F('note'))}" rows="2" maxlength="${LIMITS.note || 500}" data-bind="${esc(P('note'))}" data-type="text" data-message="${esc(msg)}" aria-describedby="${esc(F('note'))}-error">${esc(ev.note || '')}</textarea><p class="field-error" id="${esc(F('note'))}-error" role="alert" hidden></p></div>`;
    const missingBadge = v => (v === null || v === undefined ? c.badge('Missing', 'warn') : '');
    const cat = (required = false) => bind(c.selectField({ id: F('category'), label: 'Category', path: P('category'), value: ev.category || (required ? '' : '__null__'), options: categoryOptions(ctx, ev.category, { allowNone: !required }), help: categoryHelp(ctx, ev.category) }));
    const startHelp = 'Blank = not known yet; the change is left out and listed as missing until you set it.';
    let fields = [];
    let facts = '';
    switch (ev.type) {
      case 'one_time': {
        const goals = goalOptions(ctx, s);
        fields = [
          label(),
          bind(c.moneyField({ id: F('amountCents'), label: 'Amount', path: P('amountCents'), cents: ev.amountCents, help: 'Blank = not known yet (listed as missing, not counted as $0).', placeholder: 'Not entered', status: missingBadge(ev.amountCents) })),
          bind(c.monthField({ id: F('month'), label: 'Month', path: P('month'), value: ev.month, help: 'When the money moves. ' + (ev.month ? '' : startHelp) })),
          bind(c.selectField({ id: F('direction'), label: 'Money in or out', path: P('direction'), value: ev.direction, options: [{ value: 'expense', label: 'Money out (a cost)' }, { value: 'income', label: 'Money in' }] })),
          cat(),
          ev.direction === 'expense' && goals.length ? bind(c.selectField({ id: F('goalId'), label: 'Paid from a savings goal', path: P('goalId'), value: ev.goalId || '__null__', options: [{ value: '__null__', label: 'No, from everyday cash' }].concat(goals.map(g => ({ value: g.id, label: g.label }))), help: 'The cost still counts once; the goal pays what it holds and other cash pays the rest.' })) : '',
          note(),
        ];
        break;
      }
      case 'recurring':
        fields = [
          label(),
          bind(c.moneyField({ id: F('monthlyCents'), label: 'Amount each month', path: P('monthlyCents'), cents: ev.monthlyCents, help: 'Blank = not known yet (listed as missing).', placeholder: 'Not entered', status: missingBadge(ev.monthlyCents) })),
          bind(c.monthField({ id: F('startMonth'), label: 'First month', path: P('startMonth'), value: ev.startMonth, help: ev.startMonth ? '' : startHelp })),
          bind(c.monthField({ id: F('endMonth'), label: 'Last month (optional)', path: P('endMonth'), value: ev.endMonth, help: 'Blank = keeps going.' })),
          bind(c.selectField({ id: F('direction'), label: 'What it does', path: P('direction'), value: ev.direction, options: [{ value: 'expense', label: 'A cost each month' }, { value: 'income', label: 'Extra income each month' }, { value: 'income_loss', label: 'Less income each month' }] })),
          cat(),
          note(),
        ];
        break;
      case 'income_change': {
        const streams = plan.incomes || [];
        const stream = streams.find(x => x.id === ev.streamId);
        const opts = streams.map(x => ({ value: x.id, label: x.label }));
        if (!stream) opts.unshift({ value: ev.streamId, label: 'Removed from the budget (ignored)' });
        const isTransfer = stream && stream.kind === 'contribution';
        fields = [
          label(),
          bind(c.selectField({ id: F('streamId'), label: 'Income that changes', path: P('streamId'), value: ev.streamId, options: opts, help: stream ? '' : 'This income is no longer in the budget, so the change is ignored. Choose another.' })),
          bind(c.monthField({ id: F('startMonth'), label: 'First month', path: P('startMonth'), value: ev.startMonth })),
          bind(c.monthField({ id: F('endMonth'), label: 'Last month', path: P('endMonth'), value: ev.endMonth, help: 'Blank = the change keeps going.' })),
          changeAmountField(ctx, s, ev, 'jointPerPaycheckCents', isTransfer ? 'Transfer into joint each time' : 'Reaching joint per paycheck', 'During these months.', stream ? stream.jointPerPaycheckCents : null),
          isTransfer ? '' : changeAmountField(ctx, s, ev, 'netPerPaycheckCents', 'Take-home per paycheck', 'Counts in the whole-household view.', stream ? stream.netPerPaycheckCents : null),
          note(),
        ];
        if (stream) facts = `<p class="fine">In the budget, ${esc(stream.label)} is ${esc(stream.frequency && FREQ_TEXT[stream.frequency] ? FREQ_TEXT[stream.frequency] : 'on an unknown schedule')}${known(stream.jointPerPaycheckCents) ? `, ${esc(money(stream.jointPerPaycheckCents))} reaching joint each time` : ''}${known(stream.netPerPaycheckCents) ? `, ${esc(money(stream.netPerPaycheckCents))} take-home` : ''}. Outside these months it stays as in the budget.</p>`;
        break;
      }
      case 'bill_change': {
        const bills = plan.bills || [];
        const bill = bills.find(b => b.id === ev.billId);
        const opts = bills.map(b => ({ value: b.id, label: b.label + (b.type === 'debt' ? ' (debt)' : '') }));
        if (!bill) opts.unshift({ value: ev.billId, label: 'Removed from the budget (ignored)' });
        fields = [
          label(),
          bind(c.selectField({ id: F('billId'), label: 'Bill', path: P('billId'), value: ev.billId, options: opts })),
          bind(c.moneyField({ id: F('monthlyCents'), label: 'New amount each month', path: P('monthlyCents'), cents: ev.monthlyCents, help: '0 = the bill stops. Blank = unknown (listed as missing).', placeholder: 'Not entered', status: missingBadge(ev.monthlyCents) })),
          bind(c.monthField({ id: F('startMonth'), label: 'First month with the new amount', path: P('startMonth'), value: ev.startMonth })),
          bind(c.monthField({ id: F('endMonth'), label: 'Last month (optional)', path: P('endMonth'), value: ev.endMonth, help: 'Blank = from then on.' })),
          note(),
        ];
        if (bill) facts = `<p class="fine">In the budget: ${esc(bill.label)} ${known(bill.monthlyCents) ? esc(money(bill.monthlyCents)) + ' a month' : '(amount not entered)'}, paid from ${esc(bill.fundedFrom === 'joint' ? 'joint accounts' : bill.fundedFrom === 'unknown' ? 'an account not confirmed yet' : ctx.person(bill.fundedFrom) + "'s own account")}.${bill.fundedFrom !== 'joint' && ctx.scope === 'joint' ? ' It is outside the joint view, so this change shows only in the whole-household view.' : ''}</p>`;
        break;
      }
      case 'target_change': {
        const current = (plan.targets || {})[ev.category];
        fields = [
          label(),
          bind(c.selectField({ id: F('category'), label: 'Category', path: P('category'), value: ev.category, options: categoryOptions(ctx, ev.category, { allowNone: false }) })),
          bind(c.moneyField({ id: F('monthlyCents'), label: 'Your new monthly target', path: P('monthlyCents'), cents: ev.monthlyCents, help: 'Blank = not decided (listed as missing).', placeholder: 'Not entered', status: missingBadge(ev.monthlyCents) })),
          bind(c.monthField({ id: F('startMonth'), label: 'First month', path: P('startMonth'), value: ev.startMonth })),
          bind(c.monthField({ id: F('endMonth'), label: 'Last month (optional)', path: P('endMonth'), value: ev.endMonth, help: 'Blank = from then on.' })),
          note(),
        ];
        const usual = usualFor(ctx, ev.category);
        const usualLink = usual ? spendingLink(ctx, ev.category, usual.months) : null;
        facts = `<p class="fine">Your target in the budget now: <strong>${has(plan.targets, ev.category) ? esc(known(current) ? money(current) + ' a month' : 'not entered') : 'none'}</strong>.
          <span class="fc-usual-note">Usual (history, not a target): ${usual ? `${esc(money(usual.cents))} a month over ${esc(plural(usual.count, 'full month'))}${usualLink ? ` · <a href="${esc(usualLink)}">see the spending</a>` : ''}` : 'no complete months of history yet'}.</span></p>`;
        break;
      }
      case 'goal': {
        const g = ev.goal || {};
        fields = [
          goalField(s, ev, 'label', 'Goal name', 'text', ev.label),
          goalField(s, ev, 'targetCents', 'Target amount', 'money', g.targetCents ?? null, { help: 'Blank = not decided (listed as missing).' }),
          goalField(s, ev, 'targetMonth', 'Target month (optional)', 'month', g.targetMonth, { help: 'Blank = no date; judged at the end of the forecast.' }),
          goalField(s, ev, 'savedCents', 'Already saved for it', 'money', g.savedCents ?? null, { help: 'Enter 0 if nothing is saved yet. Blank = unknown.' }),
          goalField(s, ev, 'monthlyCents', 'Set aside each month', 'money', g.monthlyCents ?? null, { help: 'Blank = not decided (listed as missing).' }),
          goalField(s, ev, 'spendAtTarget', 'At the target month', 'bool', g.spendAtTarget ? 'true' : 'false', { options: [{ value: 'false', label: 'Keep the money (a cushion)' }, { value: 'true', label: 'Spend it (a trip, a purchase)' }] }),
          goalField(s, ev, 'note', 'Note (optional)', 'note', g.note || ''),
        ];
        facts = '<p class="fine">This goal exists only in this scenario. Money set aside stays in your accounts; it counts as spending only when it is spent.</p>';
        break;
      }
      default:
        fields = [`<p class="fine">This kind of change cannot be edited here.</p>`];
    }
    return `${facts}<div class="form-grid fc-ev-form">${fields.filter(Boolean).join('')}</div>`;
  }

  function categoryHelp(ctx, category) {
    if (!category) return '';
    const usual = usualFor(ctx, category);
    if (!usual) return '';
    const link = spendingLink(ctx, category, usual.months);
    return `Usual (history): ${esc(whole(usual.cents))} a month over ${usual.count} full month${usual.count === 1 ? '' : 's'}${link ? ` · <a href="${esc(link)}">see the spending</a>` : ''}.`;
  }

  function eventItem(ctx, R, s, ev) {
    const gaps = eventGaps(ev);
    const range = eventRange(ev, R);
    const usual = ev.type === 'target_change' ? usualFor(ctx, ev.category) : null;
    const badges = gaps.map(g => c.badge(g.text, 'warn'))
      .concat(range === 'after' ? [c.badge('After this forecast', 'info')] : range === 'before' ? [c.badge('Before this forecast', 'info')] : [])
      .join(' ');
    const meta = [TYPE_LABEL[ev.type] || ev.type, eventWhen(ev), ev.category && ev.type !== 'target_change' ? ev.category : '', ev.type === 'target_change' ? ev.category : ''].filter(Boolean).join(' · ');
    const usualLine = usual ? `<span class="fc-usual">Usual: ${esc(whole(usual.cents))} a month (history)</span>` : '';
    const amountHtml = eventAmount(ctx, ev);
    return `<li class="fc-ev${gaps.length ? ' has-gaps' : ''}" data-event-id="${esc(ev.id)}">
      <details class="fc-ev-details" id="${esc(domId('fc-ev', ev.id))}"${gaps.length ? ' open' : ''}>
        <summary class="fc-ev-sum">
          <span class="fc-ev-main"><h4 class="fc-ev-h">${esc(ev.label)}</h4><span class="fc-ev-meta">${esc(meta)}</span></span>
          <span class="fc-ev-amt">${amountHtml && ev.type === 'target_change' ? '<span class="fc-target-tag">Your target</span> ' : ''}${amountHtml}${usualLine}</span>
          ${badges ? `<span class="fc-ev-badges">${badges}</span>` : ''}
        </summary>
        <div class="fc-ev-body">
          ${eventForm(ctx, R, s, ev)}
          <div class="fc-ev-foot">${btn(`Remove this change<span class="sr-only">: ${esc(ev.label)}</span>`, { id: domId('fc-ev-remove', ev.id), action: 'fc:remove-event', variant: 'danger', data: { scenario: s.id, event: ev.id } })}</div>
        </div>
      </details>
    </li>`;
  }

  function templateForm(ctx, R, s) {
    if (!ui.adding || ui.adding.scenarioId !== s.id) return '';
    const kind = TEMPLATES[ui.adding.key] && TEMPLATES[ui.adding.key].form;
    if (!kind) return '';
    const plan = ctx.state.plan;
    const fld = (id, label, input, help = '') => `<div class="field"><label for="${id}">${label}</label>${input}<p class="field-help" id="${id}-help">${help}</p><p class="field-error" id="${id}-error" role="alert" hidden></p></div>`;
    const month = (id, name) => `<input id="${id}" name="${name}" type="month" aria-describedby="${id}-help ${id}-error">`;
    const moneyIn = (id, name) => `<div class="input-money"><span aria-hidden="true">$</span><input id="${id}" name="${name}" type="text" inputmode="decimal" autocomplete="off" placeholder="Unknown" aria-describedby="${id}-help ${id}-error"></div>`;
    let body = '';
    let intro = '';
    if (kind === 'leave') {
      // Leave changes everything a person brings in: their take-home pay AND what reaches joint
      // (a paycheck's joint share or a transfer from their own account). One change per income.
      const people = (plan.people || []).filter(pp => (plan.incomes || []).some(x => x.personId === pp.id && (x.kind === 'paycheck' || x.kind === 'contribution')));
      const streamsOf = pid => (plan.incomes || []).filter(x => x.personId === pid && (x.kind === 'paycheck' || x.kind === 'contribution'));
      intro = 'Changes everything the person brings in during leave: their take-home pay and what reaches the joint account. Leave the amounts blank if you do not know them yet: those months are then listed as unknown instead of guessed.';
      body = fld('fc-tpl-stream', 'Who is on leave', `<select id="fc-tpl-stream" name="personId" aria-describedby="fc-tpl-stream-help fc-tpl-stream-error">${people.map(pp => `<option value="${esc(pp.id)}">${esc(pp.name)} (${esc(streamsOf(pp.id).map(x => x.label).join(' + '))})</option>`).join('')}</select>`, 'Each of their incomes gets its own change, so the joint view and the whole-household view both reflect the leave.')
        + fld('fc-tpl-start', 'First month of leave', month('fc-tpl-start', 'startMonth'), 'Required.')
        + fld('fc-tpl-end', 'Last month of leave', month('fc-tpl-end', 'endMonth'), 'Blank = the change keeps going.')
        + fld('fc-tpl-joint', 'Reaching joint per paycheck or transfer during leave', moneyIn('fc-tpl-joint', 'joint'), 'Blank = unknown.')
        + fld('fc-tpl-net', 'Take-home per paycheck during leave', moneyIn('fc-tpl-net', 'net'), 'Blank = unknown.');
    } else if (kind === 'debt') {
      const bills = (plan.bills || []).slice().sort((a, b) => (a.type === 'debt' ? 0 : 1) - (b.type === 'debt' ? 0 : 1));
      intro = 'Stops a bill from a month on, for example the month after the final loan payment.';
      body = fld('fc-tpl-bill', 'Bill that ends', `<select id="fc-tpl-bill" name="billId" aria-describedby="fc-tpl-bill-help fc-tpl-bill-error">${bills.map(b => `<option value="${esc(b.id)}">${esc(b.label)}${b.type === 'debt' ? ' (debt)' : ''}</option>`).join('')}</select>`, 'A bill paid from a personal account changes only the whole-household view, and only if that person’s personal spending is estimated in Budget; otherwise the freed money is assumed spent.')
        + fld('fc-tpl-start', 'First month without the payment', month('fc-tpl-start', 'startMonth'), 'Required.');
    } else if (kind === 'target') {
      const targets = Object.keys(plan.targets || {});
      const rest = categoryOptions(ctx, null, { allowNone: false }).map(o => o.value).filter(n => !targets.includes(n));
      intro = 'Sets a different monthly spending target for one category from a month on. Your target, not history.';
      body = fld('fc-tpl-cat', 'Category', `<select id="fc-tpl-cat" name="category" aria-describedby="fc-tpl-cat-help fc-tpl-cat-error"><optgroup label="Categories with a target">${targets.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</optgroup><optgroup label="Other categories">${rest.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</optgroup></select>`)
        + fld('fc-tpl-start', 'First month', month('fc-tpl-start', 'startMonth'), 'Required.')
        + fld('fc-tpl-end', 'Last month (optional)', month('fc-tpl-end', 'endMonth'), 'Blank = from then on.')
        + fld('fc-tpl-amount', 'New monthly target', moneyIn('fc-tpl-amount', 'amount'), 'Blank = not decided (listed as missing).');
    }
    return `<form class="fc-tpl-form" data-action="fc:add-form" data-kind="${esc(kind)}" aria-labelledby="fc-tpl-h">
      <h4 id="fc-tpl-h">${esc(FORM_TITLE[kind])}</h4>
      <p class="fine">${esc(intro)}</p>
      <div class="form-grid">${body}</div>
      <div class="inline-form-actions">${btn('Add to this scenario', { id: 'fc-tpl-submit', type: 'submit', variant: 'primary' })}${btn('Cancel', { id: 'fc-tpl-cancel', action: 'fc:add-cancel' })}</div>
    </form>`;
  }

  function addMenu(ctx, R, s) {
    const full = s.events.length >= MAX_EVENTS;
    const groups = TEMPLATE_GROUPS.map(g => `<div class="fc-tpl-group" role="group" aria-labelledby="${esc(domId('fc-tpl-g', g.label))}">
        <p class="fc-tpl-group-label" id="${esc(domId('fc-tpl-g', g.label))}">${esc(g.label)}</p>
        <div class="fc-tpl-buttons">${g.items.map(t => btn(esc(t.label), { id: 'fc-tpl-' + t.key, action: 'fc:template', data: { template: t.key }, disabled: full })).join('')}</div>
      </div>`).join('');
    return `<div class="fc-add" id="fc-add">
      <h3 id="fc-add-h" tabindex="-1">Add a change</h3>
      <p class="fine">Pick a starting point. Amounts start blank and are listed as missing until you enter them; nothing is guessed.${full ? ` This scenario has ${MAX_EVENTS} changes, the most it can hold.` : ''}</p>
      <div class="fc-tpl-groups">${groups}</div>
      ${templateForm(ctx, R, s)}
    </div>`;
  }

  function eventsSection(ctx, R, s) {
    const list = s.events.length
      ? `<ul class="fc-ev-list">${s.events.map(ev => eventItem(ctx, R, s, ev)).join('')}</ul>`
      : c.empty('No changes yet. Add one below: a repair, a trip, childcare, leave, a paid-off debt…');
    return `<div class="fc-events">
      <h3 id="fc-events-h" tabindex="-1">Changes in this scenario${s.events.length ? ` (${s.events.length})` : ''}</h3>
      <p class="fine">Each change applies only to “${esc(s.name)}”. Open a change to edit it.</p>
      ${list}
      ${addMenu(ctx, R, s)}
    </div>`;
  }

  function editorCard(ctx, R, proj, baseProj) {
    const s = R.selected;
    const isBase = s.id === BASELINE;
    const desc = isBase
      ? `<div class="fc-base-note">${c.notice({ tone: 'info', title: 'This is your budget as entered.', body: 'It cannot hold planned changes, so it always shows where your current budget leads. To change the budget itself, edit it in Budget. To explore a change, start a scenario from it.', actions: `<a class="btn btn-small btn-secondary" href="${esc(ctx.href('budget'))}">Edit the budget</a>${btn('Start a scenario from the current budget', { id: 'fc-base-dup', action: 'fc:duplicate', variant: 'primary', data: { id: s.id } })}` })}</div>`
      : `<div class="field fc-desc"><label for="fc-desc">Description (optional)</label><textarea id="fc-desc" rows="3" maxlength="${LIMITS.note || 500}" data-bind="scenarios[id=${esc(s.id)}].description" data-type="text" data-message="${esc(`Description saved for “${s.name}”.`)}" aria-describedby="fc-desc-error" placeholder="What this scenario explores">${esc(s.description || '')}</textarea><p class="field-error" id="fc-desc-error" role="alert" hidden></p></div>`;
    return `<section class="card fc-editor" id="fc-editor" aria-labelledby="fc-editor-h">
      <div class="card-head"><div><p class="eyebrow">${isBase ? 'Selected: current budget' : 'Selected scenario'}</p><h2 id="fc-editor-h" tabindex="-1">${esc(s.name)}</h2></div></div>
      ${resultStrip(ctx, R, proj, baseProj)}
      ${desc}
      ${isBase ? '' : eventsSection(ctx, R, s)}
      ${settingsSection(ctx, R)}
    </section>`;
  }

  // ------------------------------------------------------------------ missing & assumptions, goals
  function missingCard(ctx, R, proj) {
    const s = R.selected;
    const evIds = new Set(s.events.map(e => e.id));
    const fromEvents = proj.missing.filter(m => m.source === 'event' && evIds.has(m.id));
    const fromPlan = proj.missing.filter(m => !(m.source === 'event' && evIds.has(m.id)));
    const item = m => `<li><span>${esc(m.label)}</span>${fixControl(ctx, R, m, s, { label: m.source === 'event' && evIds.has(m.id) ? 'Enter it' : 'Fix' })}</li>`;
    const outside = s.events.filter(ev => ['before', 'after'].includes(eventRange(ev, R)));
    let body;
    if (!proj.missing.length) {
      body = c.notice({ tone: 'good', title: 'Nothing is missing.', body: 'Every amount and date this forecast needs is entered.' });
    } else {
      body = c.notice({
        tone: 'warn',
        title: `Not included because the amount or date is missing (${proj.missing.length}):`,
        body: `${fromEvents.length ? `<p class="fc-miss-group">In this scenario's changes</p><ul class="fc-miss-list" id="fc-missing-events">${fromEvents.map(item).join('')}</ul>` : ''}
          ${fromPlan.length ? `<p class="fc-miss-group">In your budget</p><ul class="fc-miss-list" id="fc-missing-plan">${fromPlan.map(item).join('')}</ul>` : ''}
          <p class="fine">These are left out of every total here, not counted as $0, so the real picture may be worse.</p>`,
      });
    }
    const outsideNote = outside.length ? `<p class="fine">Outside ${esc(fmt.month(R.start))} – ${esc(fmt.month(proj.endMonth))}, so not in these numbers: ${esc(listText(outside.map(ev => `${ev.label} (${eventWhen(ev)})`)))}.</p>` : '';
    const extra = [
      'Bills and spending targets are monthly amounts. A bill paid once or twice a year (such as home insurance) is spread evenly here, so the month it is actually paid will look better than in your bank account.',
      'Spending targets are your plan, not a prediction: if you usually spend more than a target, the forecast is too optimistic.',
    ];
    const assumptions = proj.assumptions.concat(extra);
    // The three that change the numbers most stay visible; the full list is one click away.
    const key = [proj.assumptions[0], extra[0], proj.startBalanceCents === null ? 'Joint cash balance not entered: the forecast shows the change in cash, not a balance.' : null].filter(Boolean);
    return `<section class="card fc-missing" id="fc-missing" aria-labelledby="fc-missing-h">
      <div class="card-head"><div><h2 id="fc-missing-h" tabindex="-1">What this forecast leaves out</h2><p class="card-sub">For “${esc(s.name)}”.</p></div></div>
      ${body}
      ${outsideNote}
      <ul class="fc-key-assumptions">${key.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
      <details class="disclosure fc-assumptions" id="fc-assumptions">
        <summary>All assumptions (${assumptions.length})</summary>
        <div class="disclosure-body"><ul class="fc-assume-list">${assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>
      </details>
    </section>`;
  }

  function goalsCard(ctx, R, proj) {
    const s = R.selected;
    const goals = proj.goals;
    const planGoals = new Set((ctx.state.plan.savings || []).map(g => g.id));
    const eventFor = id => s.events.find(ev => ev.type === 'goal' && ev.goal && ev.goal.id === id);
    if (!goals.length) {
      return c.card(c.empty('No savings goals in this scenario.', `<a class="btn btn-small btn-secondary" href="${esc(ctx.href('budget', { section: 'savings' }))}">Add one in Budget</a>`), { title: 'Savings goals', id: 'fc-goals' });
    }
    const items = goals.map(g => {
      const ev = eventFor(g.id);
      const [text, tone] = GOAL_STATUS[g.status] || [g.status, 'neutral'];
      const statusText = g.status === 'short' ? `Short by ${whole(g.shortfallCents)}` : text;
      const target = known(g.targetCents) ? `${whole(g.targetCents)}${g.targetMonth ? ' by ' + fmt.month(g.targetMonth) : ''}` : 'Not set';
      const projected = known(g.projectedCents) ? whole(g.projectedCents) : known(g.atLeastCents) ? `At least ${whole(g.atLeastCents)}` : 'Unknown';
      const fix = ev
        ? btn(`Edit<span class="sr-only">: ${esc(g.label)}</span>`, { action: 'fc:focus', data: { target: domId('fc-ev', ev.id) } })
        : planGoals.has(g.id) ? `<a class="btn btn-small btn-ghost" href="${esc(ctx.href('budget', { section: 'savings', focus: domId('bud-goal-monthly', String(g.id)) }))}">Edit in Budget<span class="sr-only">: ${esc(g.label)}</span></a>` : '';
      return `<li class="fc-goal" data-goal-id="${esc(g.id)}">
        <div class="fc-goal-head"><h3>${esc(g.label)}</h3>${c.badge(statusText, tone)}${ev ? ' ' + c.badge('This scenario only', 'neutral') : ''}</div>
        <dl class="kv fc-goal-kv">
          <dt>Target</dt><dd>${esc(target)}</dd>
          <dt>Projected${g.spendAtTarget && g.targetMonth ? ' before spending' : ''}</dt><dd>${esc(projected)}</dd>
          <dt>Set aside in this forecast</dt><dd>${esc(whole(g.contributedCents))}</dd>
          ${g.spentMonth ? `<dt>Spent</dt><dd>${esc(fmt.month(g.spentMonth))}</dd>` : ''}
        </dl>
        ${g.note ? `<p class="fine">${esc(g.note)}</p>` : ''}
        ${fix ? `<div class="fc-goal-fix">${fix}</div>` : ''}
      </li>`;
    }).join('');
    return `<section class="card fc-goals" id="fc-goals" aria-labelledby="fc-goals-h">
      <div class="card-head"><div><h2 id="fc-goals-h">Savings goals</h2><p class="card-sub">Money set aside stays in your accounts; it leaves only when a goal is spent.</p></div></div>
      <ul class="fc-goal-list">${items}</ul>
    </section>`;
  }

  // ------------------------------------------------------------------ month by month
  function paycheckInfo(ctx, r) {
    const streams = new Map((ctx.state.plan.incomes || []).map(s => [s.id, s]));
    const items = [];
    let extra = 0;
    for (const l of r.incomeLines) {
      const st = streams.get(l.id);
      if (!st || st.kind !== 'paycheck' || l.basis === 'none') continue;
      const name = st.personId ? ctx.person(st.personId) : st.label;
      const n = Number.isInteger(l.count) ? String(l.count) : l.count.toFixed(2);
      const isExtra = l.basis === 'actual' && E.schedule.TYPICAL[st.frequency] && l.count > E.schedule.TYPICAL[st.frequency];
      if (isExtra) extra = Math.max(extra, l.count);
      items.push({ name, n, assumed: l.basis === 'assumed' || !!l.assumption, isExtra });
    }
    return { items, extra };
  }

  function monthFlags(r, pay, bal) {
    const out = [];
    if (pay.extra) out.push(`<span class="fc-flag-extra">${c.badge(pay.extra + ' paychecks', 'info')}</span>`);
    if (r.netCents === null) out.push(`<span class="fc-flag-unknown">${c.badge(r.netUnknownReason === 'personal_spending' ? 'Personal spending unknown' : 'Income unknown', 'warn')}</span>`);
    else if (r.netCents < 0) out.push(`<span class="fc-flag-neg">${c.badge('Cash goes down', 'bad')}</span>`);
    if (bal && r.balanceCents !== null && r.balanceCents < 0) out.push(c.badge('Below $0', 'bad'));
    if (r.unassignedCents !== null && r.unassignedCents < 0) out.push(c.badge('Goals not covered', 'warn'));
    if (r.eventLines.some(l => l.cents === null)) out.push(`<span class="fc-flag-missing">${c.badge('Missing amount', 'warn')}</span>`);
    return out;
  }

  function monthBody(ctx, R, proj, r) {
    const streams = new Map((ctx.state.plan.incomes || []).map(s => [s.id, s]));
    const line = (label, amount, note = '', cls = '') => `<li class="${cls}"><span>${label}${note ? `<small>${note}</small>` : ''}</span><strong class="num">${amount}</strong></li>`;
    const monthShort = fmt.month(r.month).split(' ')[0];
    const inLines = r.incomeLines.filter(l => l.basis !== 'none').map(l => {
      const st = streams.get(l.id);
      const word = st && st.kind === 'contribution' ? 'transfer' : 'paycheck';
      let how = '';
      if (l.basis === 'actual') {
        let dates = [];
        try { dates = (st && E.schedule.paydays(st, r.month)) || []; } catch { dates = []; }
        how = `${plural(l.count, word === 'transfer' ? 'transfer' : 'payday')}${dates.length ? ` (${monthShort} ${listText(dates.map(d => String(Number(d.slice(8)))))})` : ''}`;
      } else if (l.basis === 'average') how = `${l.count.toFixed(2)} ${word}s a month on average`;
      else if (l.basis === 'typical') how = `${plural(l.count, word)} (typical month)`;
      else if (l.basis === 'assumed') how = `${plural(l.count, word)} (assumed: schedule unknown)`;
      if (known(l.perPaycheckCents) && how) how += ` × ${money(l.perPaycheckCents)}`;
      return line(esc(l.label), l.cents === null ? '<span class="fc-unknown">Unknown</span>' : esc(money(l.cents)), esc(how));
    });
    const evIn = r.eventLines.filter(l => l.direction === 'income' || l.direction === 'income_loss').map(l => line(esc(l.label), l.cents === null ? '<span class="fc-unknown">Missing</span>' : esc(l.direction === 'income' ? '+' + money(l.cents) : '−' + money(l.cents)), l.cents === null ? 'Not counted until the amount is entered' : (l.direction === 'income' ? 'Scenario change' : 'Scenario change: less income')));
    const recurringOut = r.eventLines.filter(l => l.type === 'recurring' && l.direction === 'expense');
    const recurringKnown = recurringOut.reduce((a, l) => a + (l.cents || 0), 0);
    const targets = r.spendingCents - recurringKnown;
    const unsetTargets = proj.missing.filter(m => m.source === 'plan' && String(m.id || '').startsWith('target:')).length;
    const outLines = [
      line(`<a href="${esc(ctx.href('budget', { section: 'targets' }))}">${esc(ctx.scope === 'household' ? 'Spending targets and personal spending' : 'Spending targets')}</a>`, esc(money(targets)), 'From your budget' + (unsetTargets ? `; leaves out ${plural(unsetTargets, 'target')} not entered` : '')),
      ...recurringOut.map(l => line(esc(l.label), l.cents === null ? '<span class="fc-unknown">Missing</span>' : esc(money(l.cents)), l.cents === null ? 'Not counted until the amount is entered' : 'Scenario change, every month')),
      line(`<a href="${esc(ctx.href('budget', { section: 'bills' }))}">Bills</a>`, esc(money(r.billsCents)), 'Monthly amounts from your budget'),
      ...r.eventLines.filter(l => (l.type === 'one_time' || l.type === 'goal_spend') && l.direction === 'expense').map(l => line(esc(l.label), l.cents === null ? '<span class="fc-unknown">Missing</span>' : esc(money(l.cents)), l.cents === null ? 'Not counted until the amount is entered' : l.fromGoalCents ? `${money(l.fromGoalCents)} paid from savings set aside earlier` : (l.type === 'goal_spend' ? 'Savings goal spent' : 'One-time'))),
    ];
    const goalLines = proj.goals.map(g => {
      const v = r.goals[g.id];
      return line(esc(g.label), v === null || v === undefined ? '<span class="fc-unknown">Unknown</span>' : esc(money(v)), v === null || v === undefined ? 'Starting amount unknown' : 'Held at the end of the month');
    });
    const totals = [
      line('<strong>Net (in − out)</strong>', r.netCents === null ? '<span class="fc-unknown">Unknown</span>' : esc(fmt.money(r.netCents, { signed: true }))),
      line('Set aside for goals', esc(money(r.contributionsCents)), 'Stays in your accounts'),
      r.goalDrawsCents ? line('Paid from goals', esc(money(r.goalDrawsCents)), 'Set aside in earlier months') : '',
      line('Left after goals', r.unassignedCents === null ? '<span class="fc-unknown">Unknown</span>' : esc(fmt.money(r.unassignedCents, { signed: true }))),
      r.returnCents ? line('Hypothetical return', esc(fmt.money(r.returnCents, { signed: true })), 'Illustration only') : '',
      line('<strong>Change in cash so far</strong>', r.cumulativeCents === null ? '<span class="fc-unknown">Unknown</span>' : esc(fmt.money(r.cumulativeCents, { signed: true }))),
      r.balanceCents !== null ? line('<strong>Balance</strong>', esc(money(r.balanceCents))) : '',
    ].filter(Boolean);
    const warn = r.warnings.length ? `<ul class="fc-warn-list">${r.warnings.map(w => `<li>${c.badge('Note', 'warn')} ${esc(w)}</li>`).join('')}</ul>` : '';
    const unknownLines = r.incomeLines.filter(l => l.basis !== 'none' && l.cents === null).map(l => l.label);
    const unknownNote = r.netCents === null ? `<p class="fine tone-warn">${esc(r.netUnknownReason === 'personal_spending'
      ? "Net is unknown: someone's personal spending can't be worked out because their transfer to joint is unknown."
      : 'Net is unknown because some income this month is not entered' + (unknownLines.length ? ': ' + listText(unknownLines) : '') + '.')} It is not counted as $0. See “What this forecast leaves out”.</p>` : '';
    const planned = r.netCents !== null && r.netCents < 0 && r.goalDrawsCents > 0
      ? `<p class="fine">Cash goes down this month partly because ${esc(money(r.goalDrawsCents))} set aside in earlier months is spent, as planned.</p>` : '';
    const history = spendingLink(ctx, null, null);
    return `<div class="fc-month-body">
      ${unknownNote}${planned}
      <div class="fc-mb-grid">
        <div><p class="fc-mb-title">Coming in</p><ul class="fc-mb-list">${inLines.concat(evIn).join('') || '<li><span>Nothing counted</span></li>'}${line('<strong>Total in</strong>', r.incomeCents === null ? '<span class="fc-unknown">Unknown</span>' : esc(money(r.incomeCents)), '', 'fc-mb-total')}</ul></div>
        <div><p class="fc-mb-title">Going out</p><ul class="fc-mb-list">${outLines.join('')}${line('<strong>Total out</strong>', esc(money(r.outCents)), '', 'fc-mb-total')}</ul></div>
        <div><p class="fc-mb-title">Result</p><ul class="fc-mb-list">${totals.join('')}</ul>${goalLines.length ? `<p class="fc-mb-title">Savings goals</p><ul class="fc-mb-list">${goalLines.join('')}</ul>` : ''}</div>
      </div>
      ${warn}
      ${history ? `<p class="fine">These come from your budget and this scenario, not from bank data. <a href="${esc(history)}">See what you actually spent in recent months</a>.</p>` : ''}
    </div>`;
  }

  /** Which column of a month has an event whose amount is missing (left out of that total). */
  function missingIn(r) {
    const miss = l => l.cents === null;
    return {
      income: r.eventLines.some(l => miss(l) && (l.direction === 'income' || l.direction === 'income_loss')),
      spending: r.eventLines.some(l => miss(l) && l.type === 'recurring' && l.direction === 'expense'),
      oneTime: r.eventLines.some(l => miss(l) && (l.type === 'one_time' || l.type === 'goal_spend') && l.direction === 'expense'),
    };
  }

  function monthsCard(ctx, R, proj) {
    const bal = proj.startBalanceCents !== null;
    const open = bal ? balanceOpenMonth(ctx) : null;
    const notYet = r => bal && open && r.month < open;
    const cell = (cls, label, value) => `<span class="fc-c ${cls}"><span class="fc-l">${label}</span><span class="fc-n">${value}</span></span>`;
    const u = v => (v === null || v === undefined ? '<span class="fc-unknown">Unknown</span>' : esc(whole(v)));
    const us = v => (v === null || v === undefined ? '<span class="fc-unknown">Unknown</span>' : esc(signedWhole(v)));
    const plusMissing = '<small class="fc-plus-missing">+ missing</small>';
    const firstUnknown = proj.summary.unknownNetMonths[0] || null;
    const items = proj.rows.map(r => {
      const pay = paycheckInfo(ctx, r);
      const flags = monthFlags(r, pay, bal);
      const miss = missingIn(r);
      const payText = pay.items.length ? pay.items.map(p => `<span class="${p.isExtra ? 'fc-pay-extra' : ''}">${esc(p.name)} ${p.assumed ? '~' : ''}${esc(p.n)}</span>`).join(', ') : '—';
      const oneTime = r.oneTimeCents ? u(r.oneTimeCents) + (miss.oneTime ? plusMissing : '') : (miss.oneTime ? '<span class="fc-unknown">Missing</span>' : '—');
      const balance = notYet(r) ? `<span class="fc-dim">From ${esc(fmt.month(open))}</span>` : u(r.balanceCents);
      const stateCls = [r.netCents !== null && r.netCents < 0 ? 'is-negative' : '', bal && r.balanceCents !== null && r.balanceCents < 0 ? 'is-below-zero' : '', r.netCents === null ? 'is-unknown' : '', pay.extra ? 'has-extra-pay' : ''].filter(Boolean).join(' ');
      return `<li><details class="fc-month ${stateCls}" id="fc-m-${esc(r.month)}" data-month="${esc(r.month)}" data-income-cents="${r.incomeCents ?? ''}" data-net-cents="${r.netCents ?? ''}" data-cumulative-cents="${r.cumulativeCents ?? ''}"${bal ? ` data-balance-cents="${r.balanceCents ?? ''}"` : ''}>
        <summary class="fc-row${bal ? ' has-balance' : ''}">
          <span class="fc-c fc-c-month"><span class="fc-chev" aria-hidden="true"></span><strong>${esc(fmt.month(r.month))}</strong>${flags.length ? `<span class="fc-flags">${flags.join(' ')}</span>` : ''}</span>
          ${cell('fc-desk fc-c-pay', 'Paychecks ', payText)}
          ${cell('num', 'In ', u(r.incomeCents) + (miss.income && r.incomeCents !== null ? plusMissing : ''))}
          ${cell('num fc-desk', 'Spending ', u(r.spendingCents) + (miss.spending ? plusMissing : ''))}
          ${cell('num fc-desk', 'Bills ', u(r.billsCents))}
          ${cell('num fc-desk', 'One-time ', oneTime)}
          ${cell('num fc-phone', 'Out ', u(r.outCents) + (miss.spending || miss.oneTime ? plusMissing : ''))}
          ${cell('num fc-c-net' + (r.netCents !== null && r.netCents < 0 ? ' tone-bad' : ''), 'Net ', us(r.netCents))}
          ${cell('num fc-desk', 'To goals ', r.contributionsCents ? u(r.contributionsCents) : '—')}
          ${cell('num fc-desk' + (r.unassignedCents !== null && r.unassignedCents < 0 ? ' tone-warn' : ''), 'Left after goals ', us(r.unassignedCents))}
          ${cell('num fc-c-cum', 'Change so far ', us(r.cumulativeCents) + (r.cumulativeCents === null && r.netCents !== null && firstUnknown ? `<small class="fc-dim">since ${esc(fmt.month(firstUnknown))}</small>` : ''))}
          ${bal ? cell('num fc-c-bal' + (r.balanceCents !== null && r.balanceCents < 0 ? ' tone-bad' : ''), 'Balance ', balance) : ''}
        </summary>
        ${monthBody(ctx, R, proj, r)}
      </details></li>`;
    }).join('');
    const head = `<div class="fc-row fc-row-head${bal ? ' has-balance' : ''}" aria-hidden="true">
      <span class="fc-c fc-c-month">Month</span><span class="fc-c fc-desk">Paychecks</span><span class="fc-c num">In</span><span class="fc-c num fc-desk">Spending</span><span class="fc-c num fc-desk">Bills</span><span class="fc-c num fc-desk">One-time</span><span class="fc-c num fc-phone">Out</span><span class="fc-c num">Net</span><span class="fc-c num fc-desk">To goals</span><span class="fc-c num fc-desk">Left after goals</span><span class="fc-c num">Change so far</span>${bal ? '<span class="fc-c num">Balance</span>' : ''}
    </div>`;
    const sm = proj.summary;
    const flagsSummary = [
      sm.negativeMonths.length ? `${plural(sm.negativeMonths.length, 'month')} with cash going down` : '',
      sm.contributionShortfallMonths.length ? `${plural(sm.contributionShortfallMonths.length, 'month')} where goal contributions are not covered` : '',
      sm.unknownNetMonths.length ? `${plural(sm.unknownNetMonths.length, 'month')} unknown` : '',
      bal && sm.firstNegativeBalanceMonth ? `cash below $0 from ${fmt.month(sm.firstNegativeBalanceMonth)}` : '',
    ].filter(Boolean);
    const unsetTargets = proj.missing.filter(m => m.source === 'plan' && String(m.id || '').startsWith('target:')).length;
    const notes = [
      unsetTargets ? `Spending leaves out ${esc(plural(unsetTargets, 'spending target'))} not entered yet, so real spending is likely higher. <button type="button" id="fc-months-see-missing" class="fc-linkbtn" data-action="fc:focus" data-target="fc-missing-h">See which</button>` : '',
      open && proj.rows.some(notYet) ? `Balances start in ${esc(fmt.month(open))}: the balance entered is dated ${esc(fmt.date(cashPlan(ctx).balances.asOf))} and already includes the months before.` : '',
      proj.rows.some(r => Object.values(missingIn(r)).some(Boolean)) ? '<span class="fc-plus-missing">+ missing</span> next to a total: a change in that month has no amount yet, so the total leaves it out.' : '',
      proj.rows.some(r => paycheckInfo(ctx, r).items.some(p => p.assumed)) ? '~ before a paycheck count: assumed, because that pay schedule is not entered.' : '',
    ].filter(Boolean);
    const tableCols = [
      { key: 'm', label: 'Month' }, { key: 'pay', label: 'Paychecks' }, { key: 'in', label: 'In', align: 'right' },
      { key: 'sp', label: 'Spending', align: 'right' }, { key: 'bills', label: 'Bills', align: 'right' }, { key: 'one', label: 'One-time', align: 'right' },
      { key: 'out', label: 'Out', align: 'right' }, { key: 'net', label: 'Net', align: 'right' }, { key: 'goals', label: 'To goals', align: 'right' },
      { key: 'left', label: 'Left after goals', align: 'right' }, { key: 'cum', label: 'Change so far', align: 'right' },
      ...(bal ? [{ key: 'bal', label: 'Balance', align: 'right' }] : []), { key: 'notes', label: 'Notes' },
    ];
    const t = v => fmt.money(v, { fallback: 'Unknown' });
    const ts = v => fmt.money(v, { signed: true, fallback: 'Unknown' });
    const tableRows = proj.rows.map(r => {
      const pay = paycheckInfo(ctx, r);
      const notes = [pay.extra ? pay.extra + ' paychecks' : '', r.netCents === null ? (r.netUnknownReason === 'personal_spending' ? 'Personal spending unknown' : 'Income unknown') : r.netCents < 0 ? 'Cash goes down' : '', bal && r.balanceCents !== null && r.balanceCents < 0 ? 'Below $0' : '', r.unassignedCents !== null && r.unassignedCents < 0 ? 'Goals not covered' : '', r.eventLines.some(l => l.cents === null) ? 'Missing amount' : ''].filter(Boolean).join('; ');
      return { m: fmt.month(r.month), pay: pay.items.map(p => `${p.name} ${p.assumed ? '~' : ''}${p.n}`).join(', ') || '—', in: t(r.incomeCents), sp: t(r.spendingCents), bills: t(r.billsCents), one: t(r.oneTimeCents), out: t(r.outCents), net: ts(r.netCents), goals: t(r.contributionsCents), left: ts(r.unassignedCents), cum: ts(r.cumulativeCents), bal: notYet(r) ? 'From ' + fmt.month(open) : t(r.balanceCents), notes };
    });
    const fullTable = c.disclosure('Show every month as one table', c.table({ caption: `Month-by-month forecast for ${R.selected.name}`, columns: tableCols, rows: tableRows, cls: 'fc-full-table' }), { cls: 'fc-full' });
    return `<section class="card fc-months-card" id="fc-months" aria-labelledby="fc-months-h">
      <div class="card-head"><div><h2 id="fc-months-h">Month by month: ${esc(R.selected.name)}</h2><p class="card-sub">${esc(TIMING[proj.timing] ? TIMING[proj.timing].short : proj.timing)}. Open a month to see each paycheck, bill and change behind its totals.${flagsSummary.length ? ' ' + esc(flagsSummary.join('; ')) + '.' : ''}</p></div></div>
      ${notes.length ? `<ul class="fc-months-notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>` : ''}
      <div class="fc-months">
        ${head}
        <ol class="fc-month-list" aria-label="Months">${items}</ol>
      </div>
      ${fullTable}
    </section>`;
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const R = routeOf(ctx);
    const head = header(ctx, R);
    let cmp = null, proj = null, baseProj = null, error = null;
    try {
      cmp = comparison(ctx, R);
      proj = projection(ctx, R, R.selected);
      baseProj = R.selected.id === BASELINE ? proj : projection(ctx, R, ctx.state.scenarios[0]);
    } catch (err) {
      error = err;
    }
    const stale = R.staleScenario ? c.notice({ tone: 'info', title: 'That scenario no longer exists.', body: `Showing “${esc(R.selected.name)}” instead.` }) : '';
    if (error) {
      return `${head}${stale}<div class="stack">${startNote(ctx, R)}${scenarioBar(ctx, R)}${c.notice({ tone: 'bad', title: 'This forecast could not be calculated.', body: esc(error.message || String(error)) + ' Check the scenario settings or the inputs in Budget.' })}</div>`;
    }
    return `${head}
      ${stale}
      <div class="stack fc-page">
        ${startNote(ctx, R)}
        ${scenarioBar(ctx, R)}
        ${compareCard(ctx, R, cmp)}
        <div class="fc-grid">
          ${editorCard(ctx, R, proj, baseProj)}
          <div class="stack fc-side">${missingCard(ctx, R, proj)}${goalsCard(ctx, R, proj)}</div>
        </div>
        ${monthsCard(ctx, R, proj)}
      </div>`;
  }

  // Links from other views may carry ?focus=<element id>: focus it once per navigation.
  let handledFocus = null;

  /**
   * Month inputs fire `change` on every keystroke that forms a valid month, and every change here
   * re-renders the page, which resets the field while the year is half typed (typing 2028 saved
   * 0008-05). Typed months are therefore applied on Enter or when leaving the field; a month
   * picked from the browser's calendar (no keystrokes) still applies at once. Implausible years
   * are explained instead of saved. Installed once on the view container, for this view only.
   */
  function installMonthTyping(container) {
    if (container.fcMonthTyping) return;
    container.fcMonthTyping = true;
    const mine = el => el && el.matches && el.matches('input[type="month"][data-bind], input[type="month"][data-action]') && !!el.closest('.fc-controls, .fc-page');
    const IGNORE = ['Tab', 'Shift', 'Escape', 'Enter', 'Control', 'Alt', 'Meta'];
    const commit = el => {
      el.removeAttribute('data-fc-typed');
      const v = el.value;
      const year = Number(String(v).slice(0, 4));
      if (v && (!E.months.isMonth(v) || year < 1990 || year > 2200)) {
        setError(el.id, `Check the year: ${v.slice(0, 4)} does not look right. Type the month as YYYY-MM.`);
        return;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    container.addEventListener('keydown', ev => {
      const el = ev.target;
      if (!mine(el)) return;
      if (ev.key === 'Enter') {
        if (el.getAttribute('data-fc-typed')) { ev.preventDefault(); ev.stopPropagation(); commit(el); }
        return;
      }
      if (!IGNORE.includes(ev.key)) el.setAttribute('data-fc-typed', '1');
    }, true);
    container.addEventListener('change', ev => {
      if (mine(ev.target) && ev.target.getAttribute('data-fc-typed')) ev.stopPropagation();
    }, true);
    container.addEventListener('focusout', ev => {
      if (mine(ev.target) && ev.target.getAttribute('data-fc-typed')) commit(ev.target);
    }, true);
  }

  function afterRender(container, ctx) {
    installMonthTyping(container);
    const target = ctx && ctx.route.params.focus;
    if (!target) handledFocus = null;
    else if (handledFocus !== target + '|' + JSON.stringify(ctx.route.params)) {
      handledFocus = target + '|' + JSON.stringify(ctx.route.params);
      if (!pendingFocus) pendingFocus = target;
    }
    if (!pendingFocus) return;
    const id = pendingFocus;
    pendingFocus = null;
    // The app restores the previously focused element right after this hook; run after it.
    setTimeout(() => focusEl(id), 0);
  }

  // ------------------------------------------------------------------ actions
  function parseValue(el) {
    const type = el.dataset.type || 'text';
    const raw = el.value;
    if (type === 'money') return E.money.inputToCents(raw);
    if (type === 'month') {
      if (!raw) return null;
      if (!E.months.isMonth(raw)) throw new E.ValidationError('Choose a month (YYYY-MM).');
      return raw;
    }
    if (type === 'bool') return raw === 'true';
    return String(raw).trim();
  }

  // Forms here act only on submit (Enter or the submit button); app.js already ignores clicks
  // inside a form, and this guard keeps that true if an action is ever called another way.
  const isSubmit = ev => !ev || ev.type === 'submit';

  function findEvent(ctx, sid, eid) {
    const s = scenarioById(ctx, sid);
    const ev = s && s.events.find(e => e.id === eid);
    if (!ev) throw new E.ValidationError('That change no longer exists in this scenario.');
    return { s, ev };
  }

  function copyName(ctx, name) {
    const taken = new Set(ctx.state.scenarios.map(s => s.name));
    const max = LIMITS.label || 80;
    for (let i = 1; i < 100; i++) {
      const suffix = i === 1 ? ' (copy)' : ` (copy ${i})`;
      const candidate = name.slice(0, max - suffix.length) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
    return name.slice(0, max - 7) + ' (copy)';
  }

  /** Add a scenario (blank or copied), compare it when there is room, then select it. */
  function createScenario(ctx, name, copyFrom, message) {
    const R = routeOf(ctx);
    let newId = null;
    ctx.app.update(st => {
      const before = new Set(st.scenarios.map(s => s.id));
      let next = E.state.addScenario(st, name, { copyFrom: copyFrom || undefined, now: nowIso() });
      newId = next.scenarios.find(s => !before.has(s.id)).id;
      if (!copyFrom) {
        // Same calculation settings as the current budget, so a comparison shows only the changes.
        const base = (st.scenarios[0] && st.scenarios[0].assumptions) || {};
        for (const k of ['incomeTiming', 'annualReturnPct', 'costGrowthPct', 'incomeGrowthPct']) {
          if (base[k] !== undefined && base[k] !== null) next = E.state.setPath(next, `scenarios[id=${newId}].assumptions.${k}`, base[k]);
        }
      }
      const ids = next.compareIds || [];
      if (ids.length < MAX_COMPARE && !ids.includes(newId)) next = E.state.setPath(next, 'compareIds', ids.concat(newId));
      return next;
    }, { message, rerender: false });
    ui.renaming = null;
    ui.adding = null;
    go(ctx, linkParams(ctx, R, { scenario: newId, compare: undefined }), { focus: 'fc-editor-h' });
  }

  const actions = {
    'fc:horizon': (ctx, el) => {
      const R = routeOf(ctx);
      const h = Number(el.dataset.value || el.value);
      if (!HORIZONS.includes(h)) return;
      go(ctx, linkParams(ctx, R, { horizon: h }));
    },

    'fc:start': (ctx, el) => {
      const R = routeOf(ctx);
      const v = el.value;
      const b = startBounds(ctx);
      if (v && !E.months.isMonth(v)) { setError(el.id, 'Choose a month (YYYY-MM).'); return; }
      if (v && (v < b.min || v > b.max)) { setError(el.id, `Choose a month from ${fmt.month(b.min)} to ${fmt.month(b.max)}.`); return; }
      setError(el.id, null);
      go(ctx, linkParams(ctx, R, { start: v && v !== ctx.forecastStart ? v : undefined }));
    },

    'fc:compare': (ctx, el) => {
      const R = routeOf(ctx);
      const id = el.dataset.id;
      const set = new Set(R.compare);
      if (el.checked) {
        if (set.size >= MAX_COMPARE) { el.checked = false; ctx.app.toast(`Compare up to ${MAX_COMPARE} scenarios at a time. Untick one first.`); return; }
        set.add(id);
      } else {
        set.delete(id);
        if (!set.size) { el.checked = true; ctx.app.toast('Keep at least one scenario in the comparison.'); return; }
      }
      const list = ctx.state.scenarios.map(s => s.id).filter(x => set.has(x));
      ctx.app.update(st => E.state.setPath(st, 'compareIds', list), { undoable: false, rerender: !R.compareFromUrl });
      if (R.compareFromUrl) go(ctx, linkParams(ctx, R, { compare: list.join(',') }));
    },

    'fc:create': (ctx, form, ev) => {
      if (!isSubmit(ev)) return;
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const copyFrom = String(data.get('copyFrom') || '');
      if (!name) { setError('fc-new-name', 'Give the scenario a name.'); return; }
      try {
        const from = copyFrom ? scenarioById(ctx, copyFrom) : null;
        createScenario(ctx, name, copyFrom || null, `Created “${name}”${from ? ` from “${from.name}”` : ''}. Your budget is unchanged.`);
      } catch (err) {
        if (err && err.name === 'ValidationError') { setError('fc-new-name', err.message); return; }
        throw err;
      }
    },

    'fc:duplicate': (ctx, el) => {
      const src = scenarioById(ctx, el.dataset.id);
      if (!src) throw new E.ValidationError('That scenario no longer exists.');
      const name = src.id === BASELINE ? 'New scenario' + (ctx.state.scenarios.some(s => s.name === 'New scenario') ? ' ' + ctx.state.scenarios.length : '') : copyName(ctx, src.name);
      createScenario(ctx, name, src.id === BASELINE ? null : src.id, src.id === BASELINE ? `Started “${name}”. Rename it and add changes.` : `Copied to “${name}”. The original stays as it is.`);
    },

    'fc:rename-open': (ctx, el) => {
      ui.renaming = el.dataset.id;
      pendingFocus = 'fc-rename-name';
      ctx.app.render();
    },

    'fc:rename-cancel': (ctx, el) => {
      ui.renaming = null;
      pendingFocus = domId('fc-ren', el.dataset.id);
      ctx.app.render();
    },

    'fc:rename': (ctx, form, ev) => {
      if (!isSubmit(ev)) return;
      const id = form.dataset.id;
      const name = String(new FormData(form).get('name') || '').trim();
      const s = scenarioById(ctx, id);
      if (!s) throw new E.ValidationError('That scenario no longer exists.');
      if (!name) { setError('fc-rename-name', 'Enter a name.'); return; }
      if (name === s.name) { ui.renaming = null; pendingFocus = domId('fc-ren', id); ctx.app.render(); return; }
      try {
        ctx.app.update(st => E.state.renameScenario(st, id, name, { now: nowIso() }), { message: `Renamed “${s.name}” to “${name}”.` });
      } catch (err) {
        if (err && err.name === 'ValidationError') { setError('fc-rename-name', err.message); return; }
        throw err;
      }
      ui.renaming = null;
      pendingFocus = domId('fc-ren', id);
    },

    'fc:delete': async (ctx, el) => {
      const id = el.dataset.id;
      const s = scenarioById(ctx, id);
      if (!s) return;
      if (id === BASELINE) throw new E.ValidationError('The current budget cannot be deleted: every scenario builds on it.');
      const ok = await ctx.app.confirm({
        title: `Delete “${s.name}”?`,
        body: `<p>This removes the scenario and its ${esc(plural(s.events.length, 'change'))}. Your budget, your other scenarios and your history are not affected.</p><p>You can undo it right after.</p>`,
        confirmLabel: 'Delete scenario',
        danger: true,
      });
      if (!ok) { pendingFocus = domId('fc-del', id); ctx.app.render(); return; }
      const fresh = UI.app ? UI.app.state : ctx.state;
      if (!fresh.scenarios.some(x => x.id === id)) return;
      const R = routeOf(ctx);
      ctx.app.update(st => E.state.deleteScenario(st, id), { message: `Deleted “${s.name}”.`, rerender: false });
      if (ui.renaming === id) ui.renaming = null;
      const over = {};
      if (R.selected.id === id) over.scenario = undefined;
      if (R.compareFromUrl) over.compare = R.compare.filter(x => x !== id).join(',') || undefined;
      go(ctx, linkParams(ctx, R, over), { focus: 'fc-scenarios-h' });
    },

    'fc:template': (ctx, el) => {
      const R = routeOf(ctx);
      const s = R.selected;
      const t = TEMPLATES[el.dataset.template];
      if (!t || s.id === BASELINE) return;
      if (t.form) {
        ui.adding = { scenarioId: s.id, key: t.key };
        pendingFocus = { leave: 'fc-tpl-stream', debt: 'fc-tpl-bill', target: 'fc-tpl-cat' }[t.form];
        ctx.app.render();
        return;
      }
      const ev = t.make(ctx);
      let newId = null;
      ctx.app.update(st => {
        const before = new Set(st.scenarios.find(x => x.id === s.id).events.map(e => e.id));
        const next = E.state.addEvent(st, s.id, ev, { now: nowIso() });
        newId = next.scenarios.find(x => x.id === s.id).events.find(e => !before.has(e.id)).id;
        return next;
      }, { message: `Added “${ev.label}”. It is listed as missing until its amount is entered.` });
      ui.adding = null;
      const gap = eventGaps(ev)[0];
      pendingFocus = gap ? fieldId(newId, gap.field) : domId('fc-ev', newId);
    },

    'fc:add-cancel': ctx => {
      const key = ui.adding && ui.adding.key;
      ui.adding = null;
      pendingFocus = key ? 'fc-tpl-' + key : 'fc-add-h';
      ctx.app.render();
    },

    'fc:add-form': (ctx, form, domEvent) => {
      if (!isSubmit(domEvent)) return;
      const R = routeOf(ctx);
      const s = R.selected;
      const kind = form.dataset.kind;
      const data = new FormData(form);
      const plan = ctx.state.plan;
      for (const id of ['fc-tpl-start', 'fc-tpl-end', 'fc-tpl-joint', 'fc-tpl-net', 'fc-tpl-amount', 'fc-tpl-stream', 'fc-tpl-bill', 'fc-tpl-cat']) setError(id, null);
      const monthOf = (name, id, required) => {
        const v = String(data.get(name) || '');
        if (!v) { if (required) throw Object.assign(new E.ValidationError('Choose a month.'), { inputId: id }); return null; }
        if (!E.months.isMonth(v)) throw Object.assign(new E.ValidationError('Choose a month (YYYY-MM).'), { inputId: id });
        return v;
      };
      const centsOf = (name, id) => {
        try { return E.money.inputToCents(String(data.get(name) || '')); } catch (err) { throw Object.assign(err, { inputId: id }); }
      };
      let ev;
      try {
        if (kind === 'leave') {
          const pid = String(data.get('personId') || '');
          const streams = (plan.incomes || []).filter(x => x.personId === pid && (x.kind === 'paycheck' || x.kind === 'contribution'));
          if (!streams.length) throw Object.assign(new E.ValidationError('Choose who is on leave.'), { inputId: 'fc-tpl-stream' });
          const startMonth = monthOf('startMonth', 'fc-tpl-start', true);
          const endMonth = monthOf('endMonth', 'fc-tpl-end', false);
          if (endMonth && endMonth < startMonth) throw Object.assign(new E.ValidationError('The last month cannot be before the first.'), { inputId: 'fc-tpl-end' });
          const who = ctx.person(pid);
          const joint = centsOf('joint', 'fc-tpl-joint');
          const net = centsOf('net', 'fc-tpl-net');
          const evs = streams.map(stream => {
            const e = { type: 'income_change', label: streams.length > 1 ? `${who} parental leave: ${stream.kind === 'contribution' ? 'transfer to joint' : 'pay'}` : `${who} parental leave`, streamId: stream.id, startMonth, endMonth, note: '' };
            if (stream.kind === 'contribution') e.jointPerPaycheckCents = joint;
            else {
              e.netPerPaycheckCents = net;
              // A paycheck that normally sends nothing to joint (the person transfers instead) keeps that.
              if (stream.jointPerPaycheckCents !== null && stream.jointPerPaycheckCents !== 0) e.jointPerPaycheckCents = joint;
            }
            return e;
          });
          ev = evs[0];
          ev.__more = evs.slice(1);
        } else if (kind === 'debt') {
          const bill = (plan.bills || []).find(b => b.id === data.get('billId'));
          if (!bill) throw Object.assign(new E.ValidationError('Choose the bill that ends.'), { inputId: 'fc-tpl-bill' });
          ev = { type: 'bill_change', label: `${bill.label} paid off`.slice(0, LIMITS.label || 80), billId: bill.id, startMonth: monthOf('startMonth', 'fc-tpl-start', true), endMonth: null, monthlyCents: 0, note: '' };
        } else if (kind === 'target') {
          const category = String(data.get('category') || '').trim();
          if (!category) throw Object.assign(new E.ValidationError('Choose a category.'), { inputId: 'fc-tpl-cat' });
          const startMonth = monthOf('startMonth', 'fc-tpl-start', true);
          const endMonth = monthOf('endMonth', 'fc-tpl-end', false);
          if (endMonth && endMonth < startMonth) throw Object.assign(new E.ValidationError('The last month cannot be before the first.'), { inputId: 'fc-tpl-end' });
          ev = { type: 'target_change', label: `${category} target`.slice(0, LIMITS.label || 80), category, startMonth, endMonth, monthlyCents: centsOf('amount', 'fc-tpl-amount'), note: '' };
        } else return;
        let newId = null;
        const more = ev.__more || [];
        delete ev.__more;
        const all = [ev, ...more];
        ctx.app.update(st => {
          const before = new Set(st.scenarios.find(x => x.id === s.id).events.map(e => e.id));
          let next = st;
          for (const e of all) next = E.state.addEvent(next, s.id, e, { now: nowIso() });
          newId = next.scenarios.find(x => x.id === s.id).events.find(e => !before.has(e.id)).id;
          return next;
        }, { message: all.length > 1 ? `Added ${all.length} leave changes to “${s.name}” (${all.map(e => e.label).join('; ')}).${all.some(e => eventGaps(e).length) ? ' Blank amounts are listed as missing.' : ''}` : `Added “${ev.label}” to “${s.name}”.${eventGaps(ev).length ? ' Blank amounts are listed as missing.' : ''}` });
        ui.adding = null;
        pendingFocus = domId('fc-ev', newId);
      } catch (err) {
        if (err && err.name === 'ValidationError') {
          const map = { startMonth: 'fc-tpl-start', endMonth: 'fc-tpl-end', streamId: 'fc-tpl-stream', billId: 'fc-tpl-bill', category: 'fc-tpl-cat', monthlyCents: 'fc-tpl-amount', jointPerPaycheckCents: 'fc-tpl-joint', netPerPaycheckCents: 'fc-tpl-net' };
          const target = err.inputId || map[err.field];
          if (target && document.getElementById(target)) { setError(target, err.message); return; }
        }
        throw err;
      }
    },

    'fc:remove-event': (ctx, el) => {
      const { s, ev } = findEvent(ctx, el.dataset.scenario, el.dataset.event);
      ctx.app.update(st => E.state.removeEvent(st, s.id, ev.id, { now: nowIso() }), { message: `Removed “${ev.label}” from “${s.name}”.` });
      pendingFocus = 'fc-events-h';
    },

    'fc:ev-mode': (ctx, el) => {
      const { scenario: sid, event: eid, field, mode } = el.dataset;
      const { s, ev } = findEvent(ctx, sid, eid);
      ctx.app.update(st => E.state.updateEvent(st, s.id, ev.id, { [field]: mode === 'keep' ? undefined : null }, { now: nowIso() }), {
        message: mode === 'keep' ? `“${ev.label}” now uses the budget amount for this.` : 'Enter the amount for these months; blank means unknown.',
      });
      pendingFocus = mode === 'keep' ? fieldId(eid, field) + '-set' : fieldId(eid, field);
    },

    'fc:goal-field': (ctx, el) => {
      const { scenario: sid, event: eid, field } = el.dataset;
      try {
        const { s, ev } = findEvent(ctx, sid, eid);
        const value = parseValue(el);
        const goal = Object.assign({}, ev.goal);
        if (JSON.stringify(field === 'label' ? ev.label : goal[field]) === JSON.stringify(value)) { setError(el.id, null); return; }
        goal[field] = value;
        const patch = field === 'label' ? { label: value, goal: Object.assign(goal, { label: value }) } : { goal };
        ctx.app.update(st => E.state.updateEvent(st, s.id, ev.id, patch, { now: nowIso() }), { message: `Saved in “${s.name}”. Your budget is unchanged.` });
        setError(el.id, null);
      } catch (err) {
        if (err && err.name === 'ValidationError') { setError(el.id, err.message); return; }
        throw err;
      }
    },

    'fc:rate': (ctx, el) => {
      const sid = el.dataset.scenario;
      const field = el.dataset.field;
      const raw = String(el.value).trim();
      const value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value)) { setError(el.id, 'Enter a number, or leave it blank for 0.'); return; }
      try {
        const s = scenarioById(ctx, sid);
        if (!s) throw new E.ValidationError('That scenario no longer exists.');
        if ((s.assumptions || {})[field] === value) { setError(el.id, null); if (raw === '') el.value = '0'; return; }
        ctx.app.update(st => E.state.setPath(st, `scenarios[id=${sid}].assumptions.${field}`, value), { message: `Saved for “${s.name}” (hypothetical).` });
        setError(el.id, null);
      } catch (err) {
        if (err && err.name === 'ValidationError') { setError(el.id, err.message); return; }
        throw err;
      }
    },

    'fc:align-settings': ctx => {
      const R = routeOf(ctx);
      const first = scenarioById(ctx, R.compare[0]);
      if (!first) return;
      const a = first.assumptions || {};
      ctx.app.update(st => {
        let next = st;
        for (const id of R.compare.slice(1)) {
          for (const k of ['incomeTiming', 'annualReturnPct', 'costGrowthPct', 'incomeGrowthPct']) {
            if (a[k] !== undefined && a[k] !== null) next = E.state.setPath(next, `scenarios[id=${id}].assumptions.${k}`, a[k]);
          }
        }
        return next;
      }, { message: `The compared scenarios now use the settings of “${first.name}”.` });
      pendingFocus = 'fc-compare-h';
    },

    'fc:focus': (ctx, el) => {
      if (!focusEl(el.dataset.target)) ctx.app.toast('That field is not on this page any more.');
    },

    'fc:goto': (ctx, el) => {
      const R = routeOf(ctx);
      const sid = el.dataset.scenario;
      if (sid === R.selected.id) { focusEl(el.dataset.target); return; }
      go(ctx, linkParams(ctx, R, { scenario: sid }), { focus: el.dataset.target });
    },
  };

  UI.views = UI.views || {};
  UI.views.forecast = { title: 'Forecast', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
