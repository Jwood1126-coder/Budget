'use strict';
/*
 * Budget: change what comes in, recurring bills, spending targets, savings and debt facts, and
 * see what every change does.
 *
 * Layout
 *   - A "Monthly plan" summary (sticky beside the editor on wide screens, on top on phones) built
 *     from BudgetEngine.plan.monthly for the current scope: coming in, spending targets, bills,
 *     debt payments, savings and what remains. After an edit it shows what changed
 *     (plan.whatChanged against the state before the last change, plus the 12-month forecast
 *     before and after), last month against the plan, the missing inputs (each with a link to the
 *     field that fixes it) and the assumptions.
 *   - The editor shows one section at a time (route param `section`), each its own URL so Back
 *     works. The default is Spending targets: it is the section a household revisits every month
 *     and where planned vs actual lives. Income, bills and debts change rarely, and their totals
 *     stay visible in the summary, so nothing is hidden by showing one section.
 *
 * Rules
 *   - Every edit is a data-bind (validated by BudgetEngine.state.setPath) or one app.update from an
 *     action, so each change is undoable from the toast. Blank stays unknown (null), never $0.
 *   - History ("Usual") is labelled and styled apart from the household's own targets.
 *   - Totals link to the transactions behind them in Spending.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc, domId, centsToInput } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const SECTIONS = [
    { id: 'income', label: 'Income' },
    { id: 'bills', label: 'Bills' },
    { id: 'targets', label: 'Targets' },
    { id: 'savings', label: 'Savings' },
    { id: 'debts', label: 'Debts' },
  ];
  const DEFAULT_SECTION = 'targets';
  const SCOPE_OPTIONS = [{ value: 'joint', label: 'Joint accounts' }, { value: 'household', label: 'Whole household' }];
  const WINDOW_OPTIONS = [3, 6, 12].map(n => ({ value: n, label: n + ' months' }));
  const AREA_SECTION = { income: 'income', bills: 'bills', targets: 'targets', savings: 'savings', balances: 'savings', debts: 'debts' };

  const FREQ_OPTIONS = [
    { value: 'unknown', label: 'Not known yet' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Every two weeks (biweekly)' },
    { value: 'semimonthly', label: 'Twice a month (semimonthly)' },
    { value: 'monthly', label: 'Monthly' },
  ];
  const FREQ_STATUS_OPTIONS = [
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'observed', label: 'Seen in bank data' },
    { value: 'unknown', label: 'Not confirmed' },
  ];
  const INCOME_STATUS_OPTIONS = [
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'observed', label: 'Seen in bank data' },
    { value: 'estimate', label: 'Estimate' },
    { value: 'unknown', label: 'Unknown' },
  ];
  const KIND_OPTIONS = [
    { value: 'paycheck', label: 'Paycheck' },
    { value: 'contribution', label: 'Transfer from a personal account into joint' },
    { value: 'other', label: 'Other income' },
  ];
  const KIND_LABEL = { paycheck: 'Paycheck', contribution: 'Transfer into joint', other: 'Other income' };
  const TIMING_OPTIONS = [
    { value: 'conservative', label: 'Typical month (safest)' },
    { value: 'average', label: 'Annual average' },
    { value: 'actual', label: 'Actual paydays, month by month' },
  ];
  const BILL_TYPE_OPTIONS = [
    { value: 'housing', label: 'Housing' }, { value: 'utility', label: 'Utility' }, { value: 'insurance', label: 'Insurance' },
    { value: 'subscription', label: 'Subscription' }, { value: 'debt', label: 'Debt payment' }, { value: 'other', label: 'Other' },
  ];
  const BILL_TYPE_LABEL = Object.fromEntries(BILL_TYPE_OPTIONS.map(o => [o.value, o.label]));
  const BILL_STATUS_OPTIONS = [
    { value: 'existing', label: 'Existing bill' },
    { value: 'estimate', label: 'Estimate (amount not exact)' },
    { value: 'planned', label: 'Planned: not yet a bill' },
  ];
  const BALANCE_STATUS_OPTIONS = [
    { value: 'approximate', label: 'Approximate' }, { value: 'statement', label: 'From a statement' },
    { value: 'confirmed', label: 'Confirmed' }, { value: 'unknown', label: 'Unknown' },
  ];
  const APR_STATUS_OPTIONS = [
    { value: 'unknown', label: 'Not known' },
    { value: 'displayed', label: 'As displayed by the lender (not confirmed)' },
    { value: 'confirmed', label: 'Confirmed from the loan terms' },
  ];
  const TERM_STATUS_OPTIONS = [{ value: 'unknown', label: 'Not confirmed' }, { value: 'confirmed', label: 'Confirmed' }];
  const YES_NO_OPTIONS = [{ value: '__null__', label: 'Not sure yet' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

  // ------------------------------------------------------------------ small helpers
  const money = cents => fmt.money(cents);
  const whole = cents => fmt.money(cents, { whole: true });
  const signed = cents => fmt.money(cents, { signed: true });
  const possessive = name => (/s$/i.test(name) ? name + "'" : name + "'s");
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const known = v => v !== null && v !== undefined;
  /** Stable element id for a field, so focus survives re-renders and missing-input links can target it. */
  const fid = (kind, key) => domId('bud-' + kind, String(key));
  const boolValue = v => (v === true ? 'true' : v === false ? 'false' : '__null__');
  /** Keep each amount on one line ("−$600.00" never breaks after the minus). Text-only markup. */
  const glue = html => String(html).replace(/>([^<]*)</g, (all, txt) => '>' + txt.replace(/[−+]?\$[\d,]+(?:\.\d+)?/g, m => `<span class="nowrap">${m}</span>`) + '<');
  const listText = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

  function sectionOf(ctx) {
    const s = ctx.route.params.section;
    return SECTIONS.some(x => x.id === s) ? s : DEFAULT_SECTION;
  }
  /** Link that switches section without moving focus off the control that was used. */
  function sectionLink(ctx, section, inner, { id, cls = '', current = false, params = {} } = {}) {
    const p = { section, ...params };
    // A link to the URL already shown stays a plain link: navigating to the same hash fires no
    // hashchange, so a keep-focus request would linger until some later navigation.
    const here = ctx.route.params;
    const same = Object.keys(p).length === Object.keys(here).length && Object.entries(p).every(([k, v]) => String(here[k]) === String(v));
    const nav = same ? '' : ` data-action="navigate" data-view="budget" data-params="${esc(JSON.stringify(p))}" data-keep-focus="1"`;
    return `<a${id ? ` id="${esc(id)}"` : ''} class="${esc(cls)}" href="${esc(ctx.href('budget', p))}"${nav}${current ? ' aria-current="page"' : ''}>${inner}</a>`;
  }
  function focusAfterRender(id) {
    // app.update schedules the render with setTimeout(0); this runs right after it.
    setTimeout(() => { const el = document.getElementById(id); if (el) el.focus(); }, 0);
  }
  function setError(id, message) {
    const el = document.getElementById(id);
    const err = document.getElementById(id + '-error');
    if (el) { if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    if (err) { err.textContent = message || ''; err.hidden = !message; }
  }
  function peopleOptions(ctx, { none = false } = {}) {
    const list = (ctx.state.plan.people || []).map(p => ({ value: p.id, label: p.name }));
    return none ? [{ value: '__null__', label: 'No one person' }, ...list] : list;
  }
  function fundingOptions(ctx) {
    return [
      { value: 'joint', label: 'Joint' },
      ...(ctx.state.plan.people || []).map(p => ({ value: p.id, label: p.name + ' (personal)' })),
      { value: 'unknown', label: 'Not confirmed' },
    ];
  }
  function fundingText(ctx, from) {
    if (from === 'joint') return 'joint';
    if (from === 'p1' || from === 'p2') return possessive(ctx.person(from)) + ' personal account';
    return 'an account not confirmed yet';
  }

  /**
   * Categories a target or bill can use: the taxonomy, categories of spending rows, targets and
   * bills. Leaves out names only used on transfers, income and payments ("Transfer", "Income"…),
   * which are never spending.
   */
  function spendCategories(ctx) {
    return ctx.memo('bud-spend-cats', () => {
      const set = new Set(E.categories.names());
      for (const t of ctx.txns) {
        if (t.kind !== 'spend') continue;
        if (t.category) set.add(t.category);
        for (const part of t.parts || []) if (part.category) set.add(part.category);
      }
      for (const k of Object.keys(ctx.state.plan.targets || {})) set.add(k);
      for (const b of ctx.state.plan.bills || []) if (b.category) set.add(b.category);
      return E.categories.sortNames([...set]);
    });
  }

  // ------------------------------------------------------------------ form fields (with stable ids and toast messages)
  function helpAndError(id, help) {
    return `<p class="field-help" id="${esc(id)}-help">${help}</p><p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>`;
  }
  function moneyField({ id, label, path, cents, help = '', placeholder = 'Not set', message, allowNegative = false, cls = '' }) {
    return `<div class="field ${esc(cls)}">
      <label for="${esc(id)}">${esc(label)}</label>
      <div class="input-money"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="${allowNegative ? 'text' : 'decimal'}" autocomplete="off" data-bind="${esc(path)}" data-type="money"${allowNegative ? ' data-allow-negative="1"' : ''}${message ? ` data-message="${esc(message)}"` : ''} value="${esc(centsToInput(cents))}" placeholder="${esc(placeholder)}" aria-describedby="${esc(id)}-help ${esc(id)}-error"></div>
      ${helpAndError(id, help)}
    </div>`;
  }
  function selectField({ id, label, path, value, options, help = '', message, action, data = {}, cls = '' }) {
    const dataAttrs = Object.entries(data).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
    return `<div class="field ${esc(cls)}">
      <label for="${esc(id)}">${esc(label)}</label>
      <select id="${esc(id)}"${path ? ` data-bind="${esc(path)}" data-type="select"` : ''}${action ? ` data-action="${esc(action)}"` : ''}${message ? ` data-message="${esc(message)}"` : ''}${dataAttrs} aria-describedby="${esc(id)}-help ${esc(id)}-error">
        ${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value ?? '__null__') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      ${helpAndError(id, help)}
    </div>`;
  }
  function inputField({ id, label, path, value, help = '', type = 'text', dataType = 'text', message, placeholder = '', maxlength, min, max, step, inputmode, cls = '' }) {
    return `<div class="field ${esc(cls)}">
      <label for="${esc(id)}">${esc(label)}</label>
      <input id="${esc(id)}" type="${esc(type)}" data-bind="${esc(path)}" data-type="${esc(dataType)}"${message ? ` data-message="${esc(message)}"` : ''} value="${esc(value ?? '')}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${known(min) ? ` min="${esc(min)}"` : ''}${known(max) ? ` max="${esc(max)}"` : ''}${step ? ` step="${esc(step)}"` : ''}${inputmode ? ` inputmode="${esc(inputmode)}"` : ''} autocomplete="off" aria-describedby="${esc(id)}-help ${esc(id)}-error">
      ${helpAndError(id, help)}
    </div>`;
  }

  // ------------------------------------------------------------------ derived data
  function planOpts(ctx) {
    // The plan describes the first month after the data (where the forecast starts): ended or
    // not-yet-started incomes and bills are left out, and 'actual paydays' counts that month.
    return { month: ctx.forecastStart };
  }
  /** How income is counted. The summary shows one month; the forecast counts every month. */
  function timingText(ctx, timing, { forecast = false } = {}) {
    if (timing === 'actual') return forecast ? 'actual paydays, month by month' : fmt.monthLong(ctx.forecastStart) + ', actual paydays';
    if (timing === 'average') return 'annual average month';
    return 'typical month';
  }
  /**
   * Link to the transactions behind a figure. Every actual and usual amount on this page is
   * joint-account spending (targets and joint bills are joint-funded), so the link opens the same
   * accounts and its total matches.
   */
  const spendHref = (ctx, params) => ctx.href('spending', { ...params, scope: 'joint' });

  /** Bills split into regular bills and debt payments (both in plan.bills). */
  function buckets(summary, ctx) {
    const typeOf = new Map((ctx.state.plan.bills || []).map(b => [b.id, b.type]));
    const out = { bills: 0, debt: 0, billLines: [], debtLines: [] };
    for (const l of summary.bills.lines) {
      const isDebt = (l.type || typeOf.get(l.id)) === 'debt';
      if (isDebt) { out.debt += l.cents || 0; out.debtLines.push(l); } else { out.bills += l.cents || 0; out.billLines.push(l); }
    }
    return out;
  }

  /**
   * Planned vs actual for the latest complete month plus the usual-spend history used beside the
   * targets. Joint accounts only, like compare.planVsActual (targets are joint-funded).
   */
  function comparison(ctx) {
    const month = ctx.latestComplete;
    const window = Number(ctx.state.plan.settings.comparisonWindow) || 3;
    const empty = { month: null, window, rows: new Map(), pva: [], signals: new Map(), avg12: new Map(), adjusted12: {}, baselineMonths: [], usableCount: 0, usable12: 0 };
    if (!month) return empty;
    return ctx.memo('budget-cmp:' + month + ':' + window, () => {
      const joint = ctx.txns.filter(t => t.accountScope !== 'personal');
      const pva = E.compare.planVsActual(ctx.state.plan, ctx.txns, ctx.dataset, { month, window });
      const u = E.compare.usual(joint, ctx.dataset, { month, window });
      const u12 = window === 12 ? u : E.compare.usual(joint, ctx.dataset, { month, window: 12 });
      const adjusted12 = E.compare.planningBaseline(joint, ctx.dataset, { endMonth: E.months.add(month, -1), window: 12 });
      return {
        month, window, pva,
        rows: new Map(pva.map(r => [r.category, r])),
        signals: new Map(u.categories.map(x => [x.category, x])),
        signals12: new Map(u12.categories.map(x => [x.category, x])),
        avg12: new Map(u12.categories.map(x => [x.category, x.averageCents])),
        adjusted12,
        baselineMonths: u.baselineMonths,
        baselineMonths12: u12.baselineMonths,
        usableCount: u.usableCount,
        usable12: u12.usableCount,
      };
    });
  }

  /**
   * Link to the transactions behind an average. A run of whole months opens that range in
   * Spending, which shows the same "per month over N months" figure; months with gaps (a partial
   * month left out) open the selected month with the same window, where Spending explains them.
   */
  function usualHref(ctx, cmp, cat, months, window) {
    if (!months || !months.length) return null;
    const first = months[0], last = months[months.length - 1];
    if (E.months.range(first, last).length === months.length) return spendHref(ctx, { period: first === last ? first : first + '..' + last, cat });
    return spendHref(ctx, { period: cmp.month, cat, window });
  }

  /**
   * What "Use usual" would set for a category: the trailing average (or the planning-adjusted
   * average when the household excluded rows from planning). Seasonal categories use the
   * 12-month average, because a 3-month average depends on the season.
   */
  function suggestionFor(cmp, category) {
    if (!cmp.month) return { cents: null, basis: null, irregular: false };
    const sig = cmp.signals.get(category);
    const irregular = !!sig && sig.signal === 'irregular';
    // Seasonal categories, and categories with one unusual month in the short window (a one-off
    // bill or purchase), use the 12-month average: a 3-month average of one charge is not a
    // monthly cost. The basis is named on the button.
    if ((E.categories.isSeasonal(category) || irregular) && cmp.usable12 > 0) {
      const avg = cmp.avg12.has(category) ? cmp.avg12.get(category) : 0;
      const adj = cmp.adjusted12[category] ? cmp.adjusted12[category].adjustedAvgCents : avg;
      const cents = adj ?? avg;
      return { cents, basis: 'year', adjusted: known(adj) && adj !== avg, irregular, signal: sig };
    }
    const row = cmp.rows.get(category);
    if (!row) return { cents: cmp.usableCount ? 0 : null, basis: 'usual', irregular, signal: sig };
    const adjusted = row.adjustedUsualCents;
    const useAdjusted = known(adjusted) && adjusted !== row.usualCents;
    return { cents: useAdjusted ? adjusted : row.usualCents, basis: 'usual', adjusted: useAdjusted, irregular, signal: sig };
  }
  /** Words for a suggestion's basis, used on buttons and in the bulk-fill summary. */
  function basisText(cmp, s) {
    const n = s.basis === 'year' ? cmp.usable12 : cmp.usableCount;
    return `${n}-month average${s.adjusted ? ', without rows you left out of planning' : ''}`;
  }

  /** Blank targets the bulk action would fill, and the ones it leaves blank (with why). */
  function fillPlan(ctx, cmp) {
    const targets = ctx.state.plan.targets || {};
    const blank = E.categories.sortNames(Object.keys(targets).filter(k => targets[k] === null));
    const fill = [], noHistory = [], oneOff = [];
    for (const cat of blank) {
      const s = suggestionFor(cmp, cat);
      if (!known(s.cents) || s.cents <= 0) noHistory.push(cat);
      else if (s.irregular) oneOff.push(cat);
      else fill.push({ category: cat, cents: s.cents, basis: s.basis, note: s.basis === 'year' ? basisText(cmp, s) : '' });
    }
    return { blank, fill, noHistory, oneOff };
  }

  /** The change the last undoable update made to the plan, with its consequences (or null). */
  function lastChange(ctx) {
    const stack = ctx.app.undoStack || [];
    const prev = stack.length ? stack[stack.length - 1] : null;
    const st = ctx.state;
    if (!prev || !prev.plan || prev.plan === st.plan) return null;
    if (JSON.stringify(prev.plan) === JSON.stringify(st.plan)) return null;
    return ctx.memo('budget-change:' + stack.length, () => {
      const opts = { scope: ctx.scope, month: ctx.forecastStart };
      let wc;
      try { wc = E.plan.whatChanged(prev.plan, st.plan, opts); } catch (err) { return null; }
      const lines = wc.lines.slice();
      // whatChanged reports the money line(s) last; they are shown as the headline instead.
      const detail = lines.filter(l => !/^Money left each month|^Over a year|^Over the 12 months|^The effect on money left/.test(l));
      const tBefore = prev.plan.settings?.incomeTiming, tAfter = st.plan.settings.incomeTiming;
      if (tBefore && tBefore !== tAfter) detail.unshift('How income is counted: ' + timingText(ctx, tBefore) + ' → ' + timingText(ctx, tAfter) + '.');
      const outBefore = wc.before.outflowCents + wc.before.savings.totalCents;
      const outAfter = wc.after.outflowCents + wc.after.savings.totalCents;
      const inB = wc.before.income.totalCents, inA = wc.after.income.totalCents;
      const inDelta = inB !== null && inA !== null ? inA - inB : null;
      let forecast = null;
      try {
        const scenario = st.scenarios[0];
        const after = ctx.project(scenario.id, { months: 12 });
        const before = E.forecast.project(prev.plan, (prev.scenarios || [])[0] || null, { startMonth: ctx.forecastStart, months: 12, scope: ctx.scope });
        forecast = { before: before.summary.endCumulativeCents, after: after.summary.endCumulativeCents };
      } catch (err) { forecast = null; }
      const unknownLine = lines.find(l => /^The effect on money left/.test(l)) || null;
      const touched = key => JSON.stringify(prev.plan[key]) !== JSON.stringify(st.plan[key]);
      return { wc, detail, outDelta: outAfter - outBefore, inDelta, forecast, unknownLine, savingsChanged: touched('savings'), incomeChanged: touched('incomes') || touched('settings') };
    });
  }

  /** "some income is unknown" from a plan summary's remainingUnknownNote. */
  function unknownWhy(summary) {
    return String(summary.remainingUnknownNote || 'Money left over cannot be worked out because some income is unknown.')
      .replace(/^Money left over cannot be worked out because /, '').replace(/\.$/, '');
  }

  function changeHeadline(ch) {
    const { wc } = ch;
    const before = wc.before.remainingCents, after = wc.after.remainingCents;
    if (known(wc.remainingDeltaCents)) {
      const year = known(wc.annualDeltaCents) ? `, ${signed(wc.annualDeltaCents)} a year` : '';
      return wc.remainingDeltaCents === 0
        ? `Remaining stays at ${money(after)} a month.`
        : `Remaining went from ${money(before)} to ${money(after)} (${signed(wc.remainingDeltaCents)} a month${year}).`;
    }
    // One side is unknown: say which, never a difference against an unknown.
    if (before === null && after !== null) return `Remaining is now ${money(after)} a month. Before this change it could not be worked out: ${unknownWhy(wc.before)}.`;
    if (before !== null && after === null) return `Remaining was ${money(before)} a month and now cannot be worked out: ${unknownWhy(wc.after)}.`;
    return (ch.outDelta ? `Going out ${signed(ch.outDelta)} a month. ` : '') + `Remaining is still unknown: ${unknownWhy(wc.after)}.`;
  }

  /**
   * Whole-household view only: a change in someone's take-home pay moves their personal spending
   * by the same amount (the whole personal share of pay is counted as spent), so Remaining does
   * not move. Returns the plain explanation when that is what happened, else ''.
   */
  function payChangeNote(ctx, ch) {
    if (ctx.scope !== 'household' || !ch.inDelta) return '';
    const moved = ch.wc.before.personal.map(p => {
      const a = ch.wc.after.personal.find(x => x.personId === p.personId);
      return a && known(p.spendingCents) && known(a.spendingCents) && a.spendingCents !== p.spendingCents ? { name: a.name, delta: a.spendingCents - p.spendingCents } : null;
    }).filter(Boolean);
    if (!moved.length) return '';
    const names = listText(moved.map(m => m.name));
    return `In the whole-household view, all of ${moved.length === 1 ? possessive(names) : "each person's"} pay that does not reach joint counts as personal spending, so ${moved.length === 1 ? `${possessive(names)} personal spending` : 'personal spending'} changed by ${moved.map(m => signed(m.delta)).join(' and ')} too${known(ch.wc.remainingDeltaCents) && ch.wc.remainingDeltaCents === 0 ? ' and Remaining did not change' : ''}. That is because no personal-spending estimate is entered, so all of it is assumed spent; enter one under Income to see how much stays in their account.`;
  }

  // ------------------------------------------------------------------ summary panel
  function missingFix(ctx, m) {
    const id = String(m.id || '');
    const plan = ctx.state.plan;
    let section = AREA_SECTION[m.area] || 'targets';
    let focus = null;
    if (id.startsWith('personal:')) {
      section = 'income';
      focus = Array.isArray(m.streamIds) && m.streamIds.length ? fid('inc-joint', m.streamIds[0]) : fid('personal', id.slice(9));
    } else if (id.startsWith('pay:')) {
      section = 'income';
      focus = 'bud-add-income-name';
    } else if (id.startsWith('target:')) {
      focus = fid('target', id.slice(7));
    } else if (m.area === 'income') {
      const s = plan.incomes.find(x => x.id === id);
      if (s) focus = fid(ctx.scope === 'joint' || s.kind === 'contribution' ? 'inc-joint' : 'inc-net', s.id);
    } else if (m.area === 'bills') {
      const b = plan.bills.find(x => x.id === id);
      if (b) focus = fid(b.fundedFrom === 'unknown' && ctx.scope === 'joint' ? 'bill-from' : 'bill-amt', b.id);
    } else if (m.area === 'savings') {
      focus = fid('goal-monthly', id);
    } else if (m.area === 'balances') {
      focus = 'bud-cash';
    } else if (m.area === 'debts') {
      focus = fid('debt-balance', id);
    }
    return ctx.href('budget', { section, focus });
  }

  function summaryRow(ctx, { label, value, sub = '', section, tone = '', cls = '', id }) {
    // The summary stays on screen across sections, so its links keep focus by id.
    const name = section ? sectionLink(ctx, section, esc(label), { id: id ? id + '-link' : undefined }) : esc(label);
    return `<div class="bud-sum-row ${esc(cls)}"${id ? ` id="${esc(id)}"` : ''}><dt>${name}</dt><dd class="num ${tone ? 'tone-' + esc(tone) : ''}">${esc(value)}</dd>${sub ? `<dd class="bud-sum-sub">${sub}</dd>` : ''}</div>`;
  }

  function summaryPanel(ctx, plan, cmp, change) {
    const b = buckets(plan, ctx);
    const inc = plan.income;
    const st = ctx.state;
    const billsById = new Map(st.plan.bills.map(x => [x.id, x]));
    const rows = [];

    // Coming in
    const unknownIncome = plan.missing.filter(m => m.area === 'income').map(m => {
      if (String(m.id).startsWith('pay:')) return possessive(ctx.person(String(m.id).slice(4))) + ' take-home pay';
      const line = inc.lines.find(l => l.id === m.id);
      return line ? line.label : m.label;
    });
    let incomeValue, incomeSub;
    if (inc.totalCents !== null) {
      incomeValue = whole(inc.totalCents);
      incomeSub = ctx.scope === 'joint' ? 'Pay reaching joint + transfers in' : 'Full take-home pay';
    } else if (known(inc.lowerBoundCents) && inc.lowerBoundCents > 0) {
      incomeValue = 'At least ' + whole(inc.lowerBoundCents);
      incomeSub = `<span class="tone-warn">Unknown: ${esc(listText(unknownIncome))}.</span> A lower bound${ctx.scope === 'household' ? ': pay is at least what is transferred into joint' : ''}.`;
    } else {
      incomeValue = 'Unknown';
      incomeSub = `<span class="tone-warn">Not entered: ${esc(listText(unknownIncome))}.</span>`;
    }
    rows.push(summaryRow(ctx, { label: 'Coming in', value: incomeValue, sub: incomeSub, section: 'income', id: 'bud-sum-income' }));

    // Spending targets
    const notSet = plan.spending.lines.filter(l => l.cents === null).length;
    rows.push(summaryRow(ctx, { label: 'Spending targets', value: whole(plan.spending.targetsCents), section: 'targets', id: 'bud-sum-targets',
      sub: notSet ? `<span class="tone-warn">${esc(notSet)} not set: left out, not $0</span>` : 'Every target is set' }));

    // Bills and debt payments. Bills the joint view leaves out are counted here (never dropped
    // silently); the Bills section and the assumptions name them.
    const excluded = [...plan.bills.excludedPersonal.map(x => ({ ...x, why: 'personal' })), ...plan.bills.excludedUnknownFunding.map(x => ({ ...x, why: 'unknown' }))];
    const exText = list => {
      const personal = list.filter(x => x.why === 'personal').length, unknown = list.filter(x => x.why === 'unknown').length;
      const parts = [];
      if (personal) parts.push(`${personal} paid personally`);
      if (unknown) parts.push(`<span class="tone-warn">${unknown} payer not confirmed</span>`);
      return parts.length ? `Not counted: ${parts.join(', ')}.` : '';
    };
    const exBills = excluded.filter(x => billsById.get(x.id)?.type !== 'debt');
    const exDebt = excluded.filter(x => billsById.get(x.id)?.type === 'debt');
    const missingAmt = plan.missing.filter(m => m.area === 'bills' && /amount not entered/.test(m.label)).length;
    rows.push(summaryRow(ctx, { label: 'Bills', value: whole(b.bills), section: 'bills', id: 'bud-sum-bills',
      sub: [ctx.scope === 'joint' ? 'Paid from joint.' : 'Every bill, whoever pays.', exText(exBills), missingAmt ? `<span class="tone-warn">${esc(plural(missingAmt, 'amount'))} not entered.</span>` : ''].filter(Boolean).join(' ') }));
    rows.push(summaryRow(ctx, { label: 'Debt payments', value: whole(b.debt), section: 'bills', id: 'bud-sum-debt',
      sub: [ctx.scope === 'joint' ? 'Paid from joint.' : 'Every loan and card payment.', exText(exDebt)].filter(Boolean).join(' ') }));

    // Personal spending (whole household only; it is part of what goes out)
    if (ctx.scope === 'household') {
      const parts = plan.personal.map(p => `${esc(p.name)}: ${p.spendingCents === null ? '<span class="tone-warn">unknown</span>' : esc(whole(p.spendingCents))}`);
      const partial = plan.personal.some(p => p.spendingCents === null && p.source !== 'none');
      rows.push(summaryRow(ctx, { label: 'Personal spending', value: (partial ? 'At least ' : '') + whole(plan.personalSpendingCents), section: 'income', id: 'bud-sum-personal',
        sub: parts.join(' · ') }));
    }

    // Savings
    const savingsMissing = plan.savings.lines.filter(l => l.cents === null).length;
    rows.push(summaryRow(ctx, { label: 'Savings', value: whole(plan.savings.totalCents), section: 'savings', id: 'bud-sum-savings',
      sub: `${esc(plural(plan.savings.lines.length, 'goal'))}${savingsMissing ? ` · <span class="tone-warn">${esc(plural(savingsMissing, 'amount'))} not set</span>` : ''}` }));

    // Remaining
    const remaining = plan.remainingCents;
    const remainingSub = remaining === null
      ? `<span class="tone-warn">${esc(plan.remainingUnknownNote || 'Needs complete income.')}</span>`
      : `a month${notSet ? `, before ${esc(plural(notSet, 'unset target'))}` : ''}. Coming in minus everything above.`;
    rows.push(summaryRow(ctx, { label: 'Remaining', value: remaining === null ? 'Unknown' : whole(remaining), tone: remaining !== null && remaining < 0 ? 'bad' : '', sub: remainingSub, cls: 'bud-sum-total', id: 'bud-sum-remaining' }));

    // What changed (after an edit in this session)
    const incomeText = s => (s.income.totalCents !== null ? money(s.income.totalCents)
      : known(s.income.lowerBoundCents) && s.income.lowerBoundCents > 0 ? 'at least ' + money(s.income.lowerBoundCents) : 'unknown');
    let flowLine = '';
    if (change) {
      const inB = incomeText(change.wc.before), inA = incomeText(change.wc.after);
      if (change.inDelta) flowLine = `Coming in ${signed(change.inDelta)} a month; going out ${signed(change.outDelta)} a month.`;
      else if (inB !== inA) flowLine = `Coming in: ${inB} → ${inA} a month.${change.outDelta ? ` Going out ${signed(change.outDelta)} a month.` : ''}`;
    }
    const payNote = change ? payChangeNote(ctx, change) : '';
    // The forecast can count actual paydays (three-paycheck months), so its yearly change may
    // differ from 12 × the monthly change; say so instead of leaving two numbers that disagree.
    const fc = change && change.forecast;
    const fcDelta = fc && fc.before !== null && fc.after !== null ? fc.after - fc.before : null;
    const fcDiffers = fcDelta !== null && known(change.wc.annualDeltaCents) && fcDelta !== change.wc.annualDeltaCents;
    const scenarioTiming = st.scenarios[0] && st.scenarios[0].assumptions && st.scenarios[0].assumptions.incomeTiming;
    const fcWhy = !fcDiffers ? ''
      : change.savingsChanged ? 'Money set aside for goals stays in your cash in the forecast, and a goal is only taken out when it is spent, so the forecast moves differently from Remaining.'
        : change.incomeChanged && scenarioTiming === 'actual' ? 'The forecast counts actual paydays, including months with an extra paycheck, so it differs from 12 × the monthly change.'
          : 'The forecast uses its own settings and dates, so it can differ from 12 × the monthly change.';
    const changeBox = change ? glue(`<div class="bud-change" id="bud-change">
        <h3>What changed</h3>
        <p class="bud-change-head"><strong>${esc(changeHeadline(change))}</strong></p>
        ${flowLine ? `<p>${esc(flowLine)}</p>` : ''}
        ${payNote ? `<p class="bud-change-why">${esc(payNote)}</p>` : ''}
        ${fc ? `<p class="bud-change-forecast">12-month forecast, change in ${ctx.scope === 'joint' ? 'joint cash' : 'cash'}: ${fcDelta === null
          ? `${esc(fc.before === null ? 'Unknown' : signed(fc.before))} → ${esc(fc.after === null ? 'Unknown' : signed(fc.after))}`
          : `${esc(signed(fc.before))} → ${esc(signed(fc.after))} (${esc(signed(fcDelta))})`}.${fcWhy ? ` ${esc(fcWhy)}` : ''}</p>` : ''}
        ${change.detail.length ? `<ul class="bud-change-lines">${change.detail.slice(0, 4).map(l => `<li>${esc(l)}</li>`).join('')}${change.detail.length > 4 ? `<li>${esc(plural(change.detail.length - 4, 'more change'))}</li>` : ''}</ul>` : ''}
        <button type="button" class="btn btn-small btn-secondary" id="bud-undo" data-action="budget:undo">Undo this change</button>
      </div>`) : '';

    // Last month against the plan
    let pvaLine = '';
    if (cmp.month) {
      // Every category row is either planned (a known target or joint bill) or not, so the two parts
      // add up to the month's joint spending, which is what the linked Spending page totals.
      const planned = cmp.pva.filter(r => r.plannedCents !== null);
      const plannedSum = planned.reduce((a, r) => a + r.plannedCents, 0);
      const actualSum = planned.reduce((a, r) => a + r.actualCents, 0);
      const unplannedSpend = cmp.pva.filter(r => r.plannedCents === null).reduce((a, r) => a + r.actualCents, 0);
      const over = planned.filter(r => r.status === 'over').sort((x, y) => y.diffToPlanCents - x.diffToPlanCents);
      pvaLine = `<div class="bud-sum-note" id="bud-sum-pva"><h3>${esc(fmt.monthLong(cmp.month))} against the plan</h3>
        <p>Joint accounts spent <a href="${esc(spendHref(ctx, { period: cmp.month }))}">${esc(money(actualSum + unplannedSpend))}</a>.
        Categories with a plan: ${esc(money(actualSum))}, where the plan expected ${esc(money(plannedSum))}.${unplannedSpend ? ` Categories with no target: ${esc(money(unplannedSpend))}.` : ''}
        ${over.length ? `Over plan: ${over.slice(0, 2).map(r => `<a href="${esc(spendHref(ctx, { period: cmp.month, cat: r.category }))}">${esc(r.category)}</a> ${esc(signed(r.diffToPlanCents))}`).join(', ')}${over.length > 2 ? ` and ${esc(over.length - 2)} more` : ''}.` : 'No category over plan.'}
        ${sectionLink(ctx, 'targets', 'Every category', { id: 'bud-sum-pva-link' })}</p></div>`;
    } else {
      pvaLine = `<div class="bud-sum-note"><p class="fine">No complete month of transactions yet, so there is nothing to compare the plan with.</p></div>`;
    }

    // Next 12 months (Current budget forecast)
    let next12 = '';
    try {
      const proj = ctx.project(st.scenarios[0].id, { months: 12 });
      const end = proj.summary.endCumulativeCents;
      const cash = ctx.scope === 'joint' ? 'joint cash' : 'cash';
      const scenarioTiming = st.scenarios[0].assumptions?.incomeTiming;
      const timingNote = scenarioTiming && scenarioTiming !== st.plan.settings.incomeTiming
        ? ` The forecast counts income by its own setting (${esc(timingText(ctx, scenarioTiming, { forecast: true }))}); change it in Forecast.` : '';
      let text;
      if (end === null) {
        // Say which unknown blocks it: income, or personal spending behind an unknown transfer.
        const reasons = new Set(proj.rows.map(r => r.netUnknownReason).filter(Boolean));
        const why = reasons.has('income') ? 'some income is unknown'
          : reasons.has('personal_spending') ? "someone's personal spending can't be worked out while their transfer into joint is unknown"
            : 'some amounts are unknown';
        text = `How much ${cash} changes is unknown: ${esc(why)}. <a href="${esc(ctx.href('forecast'))}">Open Forecast</a>.`;
      } else {
        const kept = proj.summary.totalContributionsCents;
        text = `${cash === 'cash' ? 'Cash' : 'Joint cash'} changes by <a href="${esc(ctx.href('forecast'))}"><strong class="${end < 0 ? 'tone-bad' : ''}">${esc(signed(end))}</strong></a> if the plan is followed${kept > 0 ? `, including ${esc(money(kept))} set aside for savings goals (still your cash)` : ''}.`
          + (proj.missing.length ? ` <span class="tone-warn">Leaves out ${esc(plural(proj.missing.length, 'missing amount'))}, so the real change is likely lower.</span>` : '');
      }
      next12 = `<div class="bud-sum-note" id="bud-sum-next12"><h3>Next 12 months</h3><p>${text}${timingNote}</p></div>`;
    } catch (err) { next12 = ''; }

    // Missing inputs, each linked to the field that fixes it
    const budgetMissing = plan.missing.filter(m => m.area !== 'balances' && m.area !== 'debts');
    const otherMissing = plan.missing.filter(m => m.area === 'balances' || m.area === 'debts');
    const missingList = list => `<ul class="bud-missing-list">${list.map(m => `<li><span>${esc(m.label)}</span> <a class="bud-fix" href="${esc(missingFix(ctx, m))}">Fix<span class="sr-only">: ${esc(m.label)}</span></a></li>`).join('')}</ul>`;
    const missing = plan.missing.length ? `<details class="bud-sum-details" id="bud-missing"><summary>${esc(plural(budgetMissing.length, 'missing input'))}${otherMissing.length ? ` <span class="fine">+ ${esc(otherMissing.length)} for forecasts</span>` : ''}</summary>
        ${budgetMissing.length ? `<p class="fine">Left out of the totals above (not counted as $0).</p>${missingList(budgetMissing)}` : ''}
        ${otherMissing.length ? `<p class="fine">Not part of the monthly totals, but forecasts and debt checks need them:</p>${missingList(otherMissing)}` : ''}
      </details>` : '<p class="fine bud-complete">Every input the monthly plan needs is filled in.</p>';
    const assumptions = `<details class="bud-sum-details" id="bud-assumptions"><summary>${esc(plural(plan.assumptions.length, 'assumption'))}</summary><ul class="bud-assume-list">${plan.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>`;
    const warnings = plan.warnings.length ? plan.warnings.map(w => c.notice({ tone: 'warn', body: esc(w) })).join('') : '';

    return `<aside class="card bud-summary" aria-labelledby="bud-summary-h">
      <div class="bud-summary-head">
        <h2 id="bud-summary-h" tabindex="-1">Monthly plan</h2>
        <p class="card-sub">${esc(ctx.scope === 'joint' ? 'Joint accounts' : 'Whole household')} · ${esc(timingText(ctx, plan.timing))}</p>
      </div>
      <dl class="bud-sum-list">${rows.join('')}</dl>
      ${changeBox}
      ${warnings}
      ${pvaLine}
      ${next12}
      ${missing}
      ${assumptions}
    </aside>`;
  }

  // ------------------------------------------------------------------ section navigation
  function sectionCounts(ctx, plan) {
    const counts = { income: 0, bills: 0, targets: 0, savings: 0, debts: 0 };
    for (const m of plan.missing) {
      const id = String(m.id || '');
      const s = id.startsWith('personal:') || id.startsWith('pay:') ? 'income' : AREA_SECTION[m.area];
      if (s && s !== 'debts') counts[s]++;
    }
    const bills = ctx.state.plan.bills;
    for (const d of ctx.state.plan.debts) {
      const bill = bills.find(b => b.id === d.paymentBillId);
      const housing = bill && (bill.type === 'housing' || bill.category === 'Mortgage');
      if (!E.money.isCents(d.balanceCents)) counts.debts++;
      else if (d.promo && (d.promo.balanceCents === null || !d.promo.expiresMonth)) counts.debts++;
      else if (housing && d.escrowIncluded !== true && d.escrowIncluded !== false) counts.debts++;
    }
    const text = { income: 'to fill', bills: 'to fill', targets: 'not set', savings: 'to fill', debts: 'to check' };
    return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n ? n + ' ' + text[k] : '']));
  }

  function sectionNav(ctx, active, counts) {
    return `<nav class="bud-tabs" aria-label="Budget sections"><ul class="section-nav">${SECTIONS.map(s => `<li>${sectionLink(ctx, s.id,
      `${esc(s.label)}${counts[s.id] ? `<span class="bud-tab-count">${esc(counts[s.id])}</span>` : ''}`, { id: 'bud-tab-' + s.id, current: s.id === active })}</li>`).join('')}</ul></nav>`;
  }

  // ------------------------------------------------------------------ income
  function countText(ctx, line) {
    const per = money(line.perPaycheckCents);
    const unit = line.kind === 'contribution' ? 'transfer' : 'paycheck';
    switch (line.basis) {
      case 'typical': return `${plural(line.count, unit)} × ${per}, a typical month`;
      case 'average': return `${per} × ${E.schedule.PER_YEAR[ctx.state.plan.incomes.find(s => s.id === line.id)?.frequency] || '?'} a year ÷ 12, the annual average`;
      case 'actual': return `${plural(line.count, unit)} × ${per} in ${fmt.monthLong(ctx.forecastStart)}${line.dates && line.dates.length ? ' (' + line.dates.map(fmt.date).join(', ') + ')' : ''}`;
      case 'assumed': return `${plural(line.count, unit)} × ${per}, assumed while the frequency is not known`;
      case 'none': return 'not active in this month';
      default: return '';
    }
  }

  function frequencyTable(ctx, s, amount, amountText) {
    if (!known(amount)) {
      return `<p class="fine">Enter ${s.kind === 'contribution' ? 'the transfer amount' : 'an amount'} to see what each frequency would mean in a month and over a year.</p>`;
    }
    const unit = s.kind === 'contribution' ? 'transfers' : 'paychecks';
    const rows = E.schedule.frequencyTable(amount);
    const current = s.frequency;
    const SHORT = { weekly: ['Weekly', 'weekly'], biweekly: ['Every two weeks', 'biweekly'], semimonthly: ['Twice a month', 'semimonthly'], monthly: ['Monthly', 'monthly'] };
    const table = c.table({
      caption: `What each frequency would mean for ${amountText}`,
      cls: 'bud-freq-table',
      columns: [
        { key: 'label', label: 'Frequency', html: r => `${esc(SHORT[r.frequency][0])}<small>${r.frequency !== 'weekly' && r.frequency !== 'monthly' ? esc(SHORT[r.frequency][1]) + ': ' : ''}${esc(r.perYear)} a year, ${r.extraChecksPerYear ? `<strong>${esc(r.extraChecksPerYear)} extra</strong>` : 'no extra'} ${esc(unit)}</small>${r.frequency === current ? c.badge('Your setting', s.frequencyStatus === 'confirmed' ? 'good' : 'info') : ''}` },
        { key: 'typ', label: 'Typical month', align: 'right', html: r => `${esc(money(r.typicalMonthCents))}<small>${esc(plural(r.typicalChecks, unit.slice(0, -1)))}</small>` },
        { key: 'high', label: 'Fullest month', align: 'right', html: r => (r.highMonthChecks ? `${esc(money(r.highMonthCents))}<small>${esc(r.highMonthChecks)} ${esc(unit)}</small>` : '<span class="muted">Same as typical</span>') },
        { key: 'avg', label: 'Average month', align: 'right', html: r => `${esc(money(r.averageMonthCents))}<small>annual ÷ 12</small>` },
        { key: 'year', label: 'A year', align: 'right', html: r => esc(money(r.annualCents)) },
      ],
      rows,
      rowAttrs: r => ({ class: r.frequency === current ? 'bud-freq-current' : null }),
    });
    const lead = current === 'unknown' || !E.schedule.FREQUENCIES.includes(current)
      ? `The frequency is not known yet, so the plan assumes ${plural(s.assumedPerMonthIfUnknown ?? 2, unit.slice(0, -1))} a month.`
      : s.frequencyStatus !== 'confirmed' ? `${E.schedule.LABELS[current]} is not confirmed yet.` : `${E.schedule.LABELS[current]} is confirmed.`;
    return `<p class="fine">${esc(lead)} A typical month and the fullest month count whole ${esc(unit)}. Extra ${esc(unit)} are the ones beyond ${s.kind === 'contribution' ? 'the usual number' : 'a typical month'} each year; the average month spreads them over the year.</p>${table}`;
  }

  function incomeCard(ctx, s, plan) {
    const isContribution = s.kind === 'contribution';
    const person = s.personId ? ctx.person(s.personId) : 'Household';
    const pathOf = f => `plan.incomes[id=${s.id}].${f}`;
    const msg = what => `${s.label}: ${what} saved.`;
    const net = E.money.isCents(s.netPerPaycheckCents) ? s.netPerPaycheckCents : null;
    const joint = E.money.isCents(s.jointPerPaycheckCents) ? s.jointPerPaycheckCents : null;
    const hasContribution = (ctx.state.plan.incomes || []).some(x => x.kind === 'contribution' && x.personId === s.personId && x.personId);
    const unit = isContribution ? 'transfer' : 'paycheck';

    // Amount fields
    const amountFields = isContribution
      ? moneyField({ id: fid('inc-joint', s.id), label: 'Amount per transfer into joint', path: pathOf('jointPerPaycheckCents'), cents: joint, message: msg('amount per transfer'), placeholder: 'Unknown',
        help: 'Blank means unknown, not $0.' })
      : moneyField({ id: fid('inc-gross', s.id), label: 'Gross pay per paycheck (optional)', path: pathOf('grossPerPaycheckCents'), cents: E.money.isCents(s.grossPerPaycheckCents) ? s.grossPerPaycheckCents : null, message: msg('gross pay'), placeholder: 'Not entered',
        help: 'From a pay stub, for reference only: the plan uses what reaches joint.' })
        + moneyField({ id: fid('inc-net', s.id), label: 'Take-home per paycheck', path: pathOf('netPerPaycheckCents'), cents: net, message: msg('take-home pay'), placeholder: 'Unknown',
        help: 'Full net pay, before any of it is split off. Blank means unknown.' })
        + moneyField({ id: fid('inc-joint', s.id), label: 'Amount reaching joint per paycheck', path: pathOf('jointPerPaycheckCents'), cents: joint, message: msg('amount reaching joint'), placeholder: 'Unknown',
          help: hasContribution ? `Blank is read as no direct deposit to joint: ${esc(possessive(person))} joint money comes through the transfer below.` : 'The part deposited straight into a joint account.' });

    // Personal allocation (paychecks only)
    let allocation = '';
    if (!isContribution && s.personId) {
      if (net !== null && joint !== null) {
        allocation = net >= joint
          ? `<p class="bud-alloc"><strong>${esc(money(net - joint))}</strong> per paycheck goes to ${esc(possessive(person))} personal account (take-home minus the amount reaching joint).</p>`
          : `<p class="bud-alloc tone-bad">The amount reaching joint is more than the take-home pay. Check both amounts.</p>`;
      } else if (net !== null && joint === null && hasContribution) {
        allocation = `<p class="bud-alloc">All ${esc(money(net))} per paycheck goes to ${esc(possessive(person))} personal account; ${esc(person)} moves money into joint by transfer.</p>`;
      } else {
        allocation = `<p class="bud-alloc muted">Personal allocation: unknown until both amounts are entered.</p>`;
      }
    }

    // Schedule
    const freq = s.frequency || 'unknown';
    const scheduleFields = [
      selectField({ id: fid('inc-freq', s.id), label: isContribution ? 'How often' : 'Pay frequency', path: pathOf('frequency'), value: freq, options: FREQ_OPTIONS, message: msg('frequency') }),
      selectField({ id: fid('inc-freq-status', s.id), label: 'Frequency is', path: pathOf('frequencyStatus'), value: s.frequencyStatus || 'unknown', options: FREQ_STATUS_OPTIONS, message: msg('frequency status') }),
    ];
    if (freq === 'weekly' || freq === 'biweekly') {
      scheduleFields.push(inputField({ id: fid('inc-anchor', s.id), label: isContribution ? 'One recent transfer date' : 'One recent payday', path: pathOf('anchorDate'), value: s.anchorDate || '', type: 'date', dataType: 'date', message: msg('payday'),
        help: 'Places paydays on the calendar, so months with an extra one are known.' }));
    } else if (freq === 'semimonthly') {
      const days = Array.isArray(s.semimonthlyDays) && s.semimonthlyDays.length === 2 ? s.semimonthlyDays : [15, 31];
      const dayOptions = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: i + 1 === 31 ? 'Last day' : String(i + 1) }));
      const a = fid('inc-day1', s.id), bId = fid('inc-day2', s.id);
      scheduleFields.push(`<fieldset class="bud-days field"><legend>${isContribution ? 'Transfer days' : 'Paydays'} each month</legend><div class="bud-days-row">
        ${['First', 'Second'].map((word, i) => { const id = i ? bId : a; return `<label class="sr-only" for="${esc(id)}">${word} day</label><select id="${esc(id)}" data-action="budget:set-days" data-stream="${esc(s.id)}" data-first="${esc(a)}" data-second="${esc(bId)}" aria-describedby="${esc(id)}-error">${dayOptions.map(o => `<option value="${o.value}"${o.value === days[i] ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`; }).join('<span aria-hidden="true">and</span>')}
        </div><p class="field-help">A weekend date moves to the Friday before.</p><p class="field-error" id="${esc(a)}-error" role="alert" hidden></p><p class="field-error" id="${esc(bId)}-error" role="alert" hidden></p></fieldset>`);
    } else if (freq === 'monthly') {
      scheduleFields.push(inputField({ id: fid('inc-mday', s.id), label: 'Day of the month', path: pathOf('monthlyDay'), value: s.monthlyDay ?? '', type: 'number', dataType: 'int', min: 1, max: 31, inputmode: 'numeric', message: msg('day of the month'), help: '31 means the last day.' }));
    } else {
      scheduleFields.push(selectField({ id: fid('inc-assumed', s.id), label: `${isContribution ? 'Transfers' : 'Paychecks'} a month to assume for now`, path: pathOf('assumedPerMonthIfUnknown'), value: s.assumedPerMonthIfUnknown ?? 2,
        options: [0, 1, 2, 3, 4, 5].map(n => ({ value: n, label: String(n) })), message: msg('assumed count'), help: 'Used only until the frequency is known, and listed as an assumption.' }));
    }

    // How this stream counts in the current plan
    const line = plan.income.lines.find(l => l.id === s.id);
    const nc = plan.income.notCounted.find(n => n.id === s.id);
    let counts;
    if (nc) counts = `<p class="bud-counts"><strong>Not counted in this view.</strong> ${esc(nc.reason)}</p>`;
    else if (line && line.cents === null) counts = `<p class="bud-counts tone-warn"><strong>Not counted:</strong> ${esc(ctx.scope === 'joint' ? 'the amount reaching joint' : 'the take-home pay')} is not entered. It is left out of the totals, not counted as $0.</p>`;
    else if (line) counts = `<p class="bud-counts"><strong>${esc(money(line.cents))} a month</strong> in this plan: ${esc(countText(ctx, line))}.${line.assumption ? ` <span class="tone-warn">${esc(line.assumption)}</span>` : ''}</p>`;
    else counts = '';

    // Frequency table: the amount that counts in this view (falls back to the other one)
    let tableAmount, tableText;
    if (isContribution) { tableAmount = joint ?? net; tableText = `${money(tableAmount)} per transfer into joint`; }
    else if (ctx.scope === 'household') { tableAmount = net ?? joint; tableText = net !== null ? `${money(net)} take-home per paycheck` : `${money(joint)} per paycheck reaching joint`; }
    else { tableAmount = joint ?? net; tableText = joint !== null ? `${money(joint)} per paycheck reaching joint` : `${money(net)} take-home per paycheck`; }
    const unconfirmed = freq === 'unknown' || s.frequencyStatus !== 'confirmed';
    const freqBlock = `<details class="disclosure bud-freq" id="${esc(fid('inc-freq-table', s.id))}"${unconfirmed ? ' open' : ''}>
      <summary>What each ${esc(isContribution ? 'transfer' : 'pay')} frequency would mean${known(tableAmount) ? ` for ${esc(tableText)}` : ''}</summary>
      <div class="disclosure-body">${frequencyTable(ctx, s, tableAmount, tableText)}</div></details>`;

    const more = c.disclosure('More about this income: name, person, start and end', `<div class="form-grid">
        ${inputField({ id: fid('inc-label', s.id), label: 'Name', path: pathOf('label'), value: s.label, maxlength: 80, message: 'Income name saved.' })}
        ${selectField({ id: fid('inc-person', s.id), label: 'Person', path: pathOf('personId'), value: s.personId ?? '__null__', options: peopleOptions(ctx, { none: true }), message: msg('person') })}
        ${selectField({ id: fid('inc-kind', s.id), label: 'Kind', path: pathOf('kind'), value: s.kind, options: KIND_OPTIONS, message: msg('kind') })}
        ${selectField({ id: fid('inc-status', s.id), label: 'How sure are these amounts?', path: pathOf('status'), value: s.status || 'unknown', options: INCOME_STATUS_OPTIONS, message: msg('status') })}
        ${inputField({ id: fid('inc-start', s.id), label: 'First month', path: pathOf('startMonth'), value: s.startMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('first month'), help: 'Leave blank if it is already coming in.' })}
        ${inputField({ id: fid('inc-end', s.id), label: 'Last month', path: pathOf('endMonth'), value: s.endMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('last month'), help: 'Leave blank if there is no end date.' })}
      </div>
      ${inputField({ id: fid('inc-note', s.id), label: 'Note', path: pathOf('note'), value: s.note || '', maxlength: 500, message: msg('note') })}
      <div class="bud-remove-row">${c.button('Remove this income', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'incomes', id: s.id, label: s.label, focus: 'bud-add-income-name' } })}</div>`,
    { cls: 'bud-more' });

    const contributionNote = isContribution
      ? `<p class="bud-contrib-note">${c.badge('Transfer', 'info')} Money moved from ${esc(possessive(person))} personal account into joint. It counts as joint income in the joint view, and never as extra income in the whole-household view (${esc(possessive(person))} pay is the income).</p>`
      : '';

    return c.card(`${contributionNote}
      <div class="bud-grid-2">${amountFields}</div>
      ${allocation}
      <div class="bud-grid-3 bud-sched">${scheduleFields.join('')}</div>
      ${counts}
      ${freqBlock}
      ${more}`, {
      title: s.label, id: fid('inc-card', s.id), cls: 'bud-income-card',
      subtitle: `${esc(person)} · ${esc(KIND_LABEL[s.kind] || s.kind)} ${c.certainty(s.status || 'unknown')}${s.note ? `<span class="bud-note">${esc(s.note)}</span>` : ''}`,
    });
  }

  function personalCard(ctx, plan) {
    const entries = plan.personal;
    if (!entries.length) return '';
    const body = entries.map(p => {
      const est = (ctx.state.plan.personalSpending || []).find(x => x.personId === p.personId);
      const rows = [
        ['Personal share of pay', p.allocationCents === null ? 'Unknown' : money(p.allocationCents) + ' a month'],
        ['Bills paid personally', money(p.billsCents)],
        ['Transfers into joint', p.contributionsCents === null ? 'Unknown' : money(p.contributionsCents)],
        ['Left for personal spending', p.spendingCents === null ? 'Unknown' : money(p.spendingCents)],
      ];
      // A known share of pay with an unknown transfer into joint: personal spending cannot be
      // worked out. Point at the transfer amount that fixes it.
      const blocked = p.unknownBecause === 'contribution'
        ? (ctx.state.plan.incomes || []).filter(s => s.kind === 'contribution' && s.personId === p.personId && !E.money.isCents(s.jointPerPaycheckCents))
        : [];
      const blockedNote = p.unknownBecause === 'contribution'
        ? `<p class="bud-counts tone-warn">${esc(`${possessive(p.name)} personal spending can't be worked out until the amount ${p.name} transfers into joint is entered.`)}${blocked.length ? ` ${sectionLink(ctx, 'income', 'Enter it', { params: { focus: fid('inc-joint', blocked[0].id) } })}` : ''}</p>`
        : '';
      return `<div class="bud-person">
        <h3>${esc(p.name)}</h3>
        <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${p.shortfallCents > 0 ? c.notice({ tone: 'warn', body: esc(`Personal bills and transfers are ${money(p.shortfallCents)} more than the personal share of pay. Check whether other personal money covers this.`) }) : ''}
        ${blockedNote}
        <p class="fine">${esc(p.note)}</p>
        ${moneyField({ id: fid('personal', p.personId), label: `${possessive(p.name)} personal spending estimate (a month)`, path: `plan.personalSpending[personId=${p.personId}].monthlyCents`, cents: est ? est.monthlyCents : null, placeholder: 'Unknown',
          message: `${possessive(p.name)} personal spending estimate saved.`, help: p.source === 'allocation' ? 'Not used: the personal share of pay above is counted instead.' : 'Used in the whole-household view only while the personal share of pay is unknown.' })}
      </div>`;
    }).join('');
    // The documented household model, said where the household will wonder about it.
    const why = `<div class="bud-why" id="bud-pay-why"><h3>Why changing take-home pay does not change Remaining in the whole-household view</h3>
      <p>All of a person's pay that does not reach joint is counted as their personal spending (after their personal bills and transfers into joint). So when take-home pay goes up and the amount reaching joint stays the same, personal spending goes up by the same amount, and Remaining stays the same. Remaining changes when the amount reaching joint changes, or when joint costs change.${ctx.scope === 'joint' ? ' In the joint view, personal accounts are not part of the budget at all.' : ''}</p></div>`;
    return c.card(`${ctx.scope === 'household' ? why : ''}<div class="bud-people">${body}</div>${ctx.scope === 'household' ? '' : c.disclosure('Why changing take-home pay does not change Remaining', why.replace(/<h3>[^<]*<\/h3>/, ''), { cls: 'bud-why-more' })}`, { title: 'Personal accounts', id: 'bud-personal',
      subtitle: 'Pay that does not reach joint pays personal bills and transfers into joint first. What is left counts once as personal spending in the whole-household view, so nothing is counted twice.' });
  }

  function addIncomeCard(ctx) {
    return c.card(`<form class="bud-add-form" data-action="budget:add-income" aria-label="Add an income">
        <div class="field"><label for="bud-add-income-name">Name</label><input id="bud-add-income-name" name="label" maxlength="80" placeholder="e.g. Sam paycheck" aria-describedby="bud-add-income-name-error"><p class="field-error" id="bud-add-income-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-income-person">Person</label><select id="bud-add-income-person" name="personId">${peopleOptions(ctx, { none: true }).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-income-kind">Kind</label><select id="bud-add-income-kind" name="kind">${KIND_OPTIONS.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add income</button></div>
      </form><p class="fine">New income starts with unknown amounts and frequency; fill them in on its card.</p>`, { title: 'Add income', id: 'bud-add-income' });
  }

  function incomeSection(ctx, plan) {
    const st = ctx.state;
    const timing = st.plan.settings.incomeTiming;
    const timingCard = c.card(`<div class="bud-timing">
        ${selectField({ id: 'bud-timing', label: 'Count income by', path: 'plan.settings.incomeTiming', value: timing, options: TIMING_OPTIONS, message: 'Income counting saved.',
          help: esc(E.plan.TIMING_TEXT[timing] || '') })}
        <div class="bud-timing-text">
          <p><strong>Every two weeks (biweekly)</strong> is 26 paychecks a year: most months get 2, and two months a year get 3. <strong>Twice a month (semimonthly)</strong> is 24 a year, always 2.</p>
          <p>A typical month counts 2 for both, so a third paycheck is a bonus rather than money the budget relies on. The annual average spreads the extra paychecks over the year, which is more than most months actually bring.</p>
          ${timing === 'actual' ? `<p>The summary shows ${esc(fmt.monthLong(ctx.forecastStart))}, the first month after your data, with its real paydays.</p>` : ''}
        </div>
      </div>`, { title: 'How income is counted', id: 'bud-timing-card' });
    const streams = (st.plan.incomes || []).map(s => incomeCard(ctx, s, plan)).join('');
    return `<div class="stack">${timingCard}${streams || c.card(c.empty('No income entered yet.'), { title: 'Income' })}${personalCard(ctx, plan)}${addIncomeCard(ctx)}</div>`;
  }

  // ------------------------------------------------------------------ bills
  function billStatusBadge(b) {
    if (b.status === 'planned') return c.badge('Planned: not yet a bill', 'info');
    if (b.status === 'estimate') return c.badge('Estimate', 'warn');
    return c.badge('Existing bill', 'neutral');
  }

  /** The latest yearly payment of a category seen in the data (review.queues annualSpikes), or null. */
  function yearlyPayment(ctx, category, upTo) {
    let q;
    try { q = ctx.reviewQueues(); } catch (err) { return null; }
    const list = ((q && q.annualSpikes) || []).filter(x => x.category === category && (!upTo || x.month <= upTo));
    return list.length ? list.reduce((a, x) => (x.month > a.month ? x : a)) : null;
  }

  function billActual(ctx, b, cmp) {
    if (b.status === 'planned') return '<span class="muted">Not a bill yet, so there is nothing to compare.</span>';
    if (b.fundedFrom === 'p1' || b.fundedFrom === 'p2') {
      const imported = (ctx.dataset.accounts || []).some(a => a.scope === 'personal' && a.ownerId === b.fundedFrom);
      return `<span class="muted">Paid from ${esc(possessive(ctx.person(b.fundedFrom)))} personal account${imported ? '. This page compares joint accounts only.' : ', which is not in the imported data.'}</span>`;
    }
    if (!cmp.month) return '<span class="muted">No complete month of data yet.</span>';
    if (b.fundedFrom === 'unknown') return '<span class="muted">Who pays is not confirmed, so it is not compared with the joint accounts yet.</span>';
    if (!b.category) {
      // Debt payments are not category spending: show the month's joint debt payments, labelled as a total.
      const s = E.ledger.summarize(E.ledger.filter(ctx.txns, { months: [cmp.month], scope: 'joint' }));
      return `<span class="bud-k">All joint debt payments, ${esc(fmt.month(cmp.month))}</span> <a href="${esc(spendHref(ctx, { period: cmp.month, kind: 'debt' }))}">${esc(money(s.debtPaymentsCents))}</a>`;
    }
    const row = cmp.rows.get(b.category);
    const actual = row ? row.actualCents : 0;
    const shared = row && row.sources.filter(x => x.kind === 'bill').length > 1;
    // A yearly bill reads $0 in most months: name the yearly payment so $0 is not misread.
    const yearly = yearlyPayment(ctx, b.category, cmp.month);
    const yearlyNote = yearly ? `<small class="bud-yearly">Paid once a year: <a href="${esc(spendHref(ctx, { period: yearly.month, cat: b.category }))}">${esc(money(yearly.totalCents))}</a> in ${esc(fmt.month(yearly.month))}, about ${esc(money(Math.round(yearly.totalCents / 12)))} a month.</small>` : '';
    return `<span class="bud-k">${esc(fmt.month(cmp.month))} actual${shared ? `, all of ${esc(b.category)}` : ''}</span> <a href="${esc(spendHref(ctx, { period: cmp.month, cat: b.category }))}">${esc(money(actual))}</a>${yearlyNote}`;
  }

  function billItem(ctx, b, cmp) {
    const pathOf = f => `plan.bills[id=${b.id}].${f}`;
    const msg = what => `${b.label}: ${what} saved.`;
    const cats = spendCategories(ctx);
    const catOptions = [{ value: '__null__', label: 'None (not compared with spending; for debt payments)' }, ...cats.map(n => ({ value: n, label: n }))];
    const debt = b.debtId ? ctx.state.plan.debts.find(d => d.id === b.debtId) : null;
    const meta = [BILL_TYPE_LABEL[b.type] || 'Other', b.category || null, b.endMonth ? 'Final payment ' + fmt.month(b.endMonth) : null].filter(Boolean).join(' · ');
    return `<li class="bud-bill" id="${esc(fid('bill', b.id))}">
      <div class="bud-bill-head"><h4 class="bud-item-title">${esc(b.label)}</h4><span class="bud-badges">${billStatusBadge(b)}</span></div>
      <p class="bud-meta">${esc(meta)}${b.note ? ` · <span>${esc(b.note)}</span>` : ''}</p>
      <div class="bud-bill-grid">
        ${moneyField({ id: fid('bill-amt', b.id), label: 'Monthly amount', path: pathOf('monthlyCents'), cents: b.monthlyCents, message: msg('amount'), placeholder: 'Not entered' })}
        ${selectField({ id: fid('bill-from', b.id), label: 'Paid from', path: pathOf('fundedFrom'), value: b.fundedFrom, options: fundingOptions(ctx), message: msg('paying account') })}
        <div class="bud-bill-actual">${billActual(ctx, b, cmp)}</div>
      </div>
      <details class="disclosure bud-more" id="${esc(fid('bill-more', b.id))}"><summary>Details: name, category, status, final payment</summary><div class="disclosure-body">
        <div class="form-grid">
          ${inputField({ id: fid('bill-label', b.id), label: 'Name', path: pathOf('label'), value: b.label, maxlength: 80, message: 'Bill name saved.' })}
          ${selectField({ id: fid('bill-cat', b.id), label: 'Category', path: pathOf('category'), value: b.category ?? '__null__', options: catOptions, message: msg('category'), help: 'Links the bill to spending in that category.' })}
          ${selectField({ id: fid('bill-type', b.id), label: 'Type', path: pathOf('type'), value: b.type || 'other', options: BILL_TYPE_OPTIONS, message: msg('type') })}
          ${selectField({ id: fid('bill-status', b.id), label: 'Status', path: pathOf('status'), value: b.status || 'existing', options: BILL_STATUS_OPTIONS, message: msg('status'), help: 'Planned means not yet a bill (for example a policy being considered).' })}
          ${inputField({ id: fid('bill-start', b.id), label: 'First payment month', path: pathOf('startMonth'), value: b.startMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('first month'), help: 'Leave blank if already paying.' })}
          ${inputField({ id: fid('bill-end', b.id), label: 'Final payment month', path: pathOf('endMonth'), value: b.endMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('final payment month'), help: 'Leave blank if unknown.' })}
        </div>
        ${inputField({ id: fid('bill-note', b.id), label: 'Note', path: pathOf('note'), value: b.note || '', maxlength: 500, message: msg('note') })}
        ${debt ? `<p class="fine">Pays the debt ${sectionLink(ctx, 'debts', esc(debt.label), { params: { focus: fid('debt-card', debt.id) + '-h' } })}.</p>` : ''}
        <div class="bud-remove-row">${c.button('Remove this bill', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'bills', id: b.id, label: b.label, focus: 'bud-add-bill-name' } })}</div>
      </div></details>
    </li>`;
  }

  function billsSection(ctx, plan, cmp) {
    const bills = ctx.state.plan.bills || [];
    const people = ctx.state.plan.people || [];
    const groups = [
      { key: 'joint', title: 'Paid from joint', note: 'Counted in both views.' },
      ...people.map(p => ({ key: p.id, title: `Paid from ${possessive(p.name)} personal account`, note: `Counted in the whole-household view. In the joint view it is paid from ${possessive(p.name)} share of pay instead.` })),
      { key: 'unknown', title: 'Paying account not confirmed', note: 'Left out of the joint view, because it does not show in the joint data. Included in the whole-household view. Choose who pays to settle it.' },
    ];
    const total = list => E.money.sum(list.map(b => b.monthlyCents));
    const groupHtml = groups.map(g => {
      const list = bills.filter(b => (g.key === 'unknown' ? !['joint', ...people.map(p => p.id)].includes(b.fundedFrom) : b.fundedFrom === g.key));
      if (!list.length) return '';
      const unknownAmounts = list.filter(b => b.monthlyCents === null).length;
      return `<section class="bud-bill-group" aria-labelledby="${esc(fid('bill-group', g.key))}">
        <div class="bud-group-head"><h3 id="${esc(fid('bill-group', g.key))}">${esc(g.title)}</h3><span class="num bud-group-total">${esc(money(total(list)))} a month${unknownAmounts ? ` <span class="tone-warn">+ ${esc(plural(unknownAmounts, 'unknown amount'))}</span>` : ''}</span></div>
        <p class="fine">${esc(g.note)}</p>
        <ul class="bud-bill-list">${list.map(b => billItem(ctx, b, cmp)).join('')}</ul>
      </section>`;
    }).join('');
    const cats = spendCategories(ctx);
    const addForm = `<form class="bud-add-form" data-action="budget:add-bill" aria-label="Add a bill">
        <div class="field"><label for="bud-add-bill-name">Name</label><input id="bud-add-bill-name" name="label" maxlength="80" placeholder="e.g. Car insurance" aria-describedby="bud-add-bill-name-error"><p class="field-error" id="bud-add-bill-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-bill-amount">Monthly amount</label><div class="input-money"><span aria-hidden="true">$</span><input id="bud-add-bill-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="Not entered" aria-describedby="bud-add-bill-amount-error"></div><p class="field-error" id="bud-add-bill-amount-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-bill-from">Paid from</label><select id="bud-add-bill-from" name="fundedFrom">${fundingOptions(ctx).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-bill-type">Type</label><select id="bud-add-bill-type" name="type">${BILL_TYPE_OPTIONS.map(o => `<option value="${esc(o.value)}"${o.value === 'other' ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-bill-cat">Category</label><select id="bud-add-bill-cat" name="category"><option value="__null__">None (for debt payments)</option>${cats.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add bill</button></div>
      </form>`;
    const intro = `<p class="fine">Fixed monthly costs, including loan and card payments. A blank amount is left out of the totals and listed as missing, never counted as $0. ${cmp.month ? `Actual amounts are from ${esc(fmt.monthLong(cmp.month))}, joint accounts.` : ''}</p>`;
    return `<div class="stack">
      ${c.card(intro + (groupHtml || c.empty('No bills entered yet.')), { title: 'Bills and debt payments', id: 'bud-bills' })}
      ${c.card(addForm, { title: 'Add a bill', id: 'bud-add-bill' })}
    </div>`;
  }

  // ------------------------------------------------------------------ spending targets
  function statusBadge(row) {
    if (!row) return '';
    switch (row.status) {
      case 'over': return c.badge('Over by ' + money(row.diffToPlanCents), 'warn');
      case 'under': return c.badge('Under by ' + money(-row.diffToPlanCents), 'good');
      case 'on_plan': return c.badge('On plan', 'good');
      case 'partial_month': return c.badge('Month incomplete', 'info');
      case 'irregular': return c.badge('Not due this month', 'info');
      default: return c.badge('No target', 'neutral');
    }
  }

  function targetRow(ctx, cat, cents, cmp) {
    const row = cmp.rows.get(cat);
    const sig = cmp.signals.get(cat);
    const sug = suggestionFor(cmp, cat);
    const rowId = fid('target-row', cat);
    const inputId = fid('target', cat);
    const seasonal = E.categories.isSeasonal(cat);
    const billSources = row ? row.sources.filter(x => x.kind === 'bill') : [];

    // Actual (latest complete month) and its status against the plan
    const actualCell = !cmp.month ? '<span class="muted">No data</span>'
      : `<a href="${esc(spendHref(ctx, { period: cmp.month, cat }))}">${esc(money(row ? row.actualCents : 0))}</a>`
        + `<span class="bud-status">${cents === null ? c.badge('No target', 'neutral') : statusBadge(row)}</span>`
        + (billSources.length ? `<small>Plan includes ${esc(billSources.map(x => x.label + ' ' + money(x.plannedCents)).join(', '))}</small>` : '');

    // Usual (history), kept visually apart from the target
    let usualCell = '<span class="muted">No history</span>';
    if (cmp.month && row && known(row.usualCents)) {
      const href = usualHref(ctx, cmp, cat, cmp.baselineMonths, cmp.window);
      usualCell = href ? `<a href="${esc(href)}">${esc(money(row.usualCents))}</a>` : esc(money(row.usualCents));
      if (known(row.adjustedUsualCents) && row.adjustedUsualCents !== row.usualCents) usualCell += `<small>Adjusted ${esc(money(row.adjustedUsualCents))}: without rows you left out of planning</small>`;
      if (sig && sig.signal === 'irregular' && sig.irregular) usualCell += `<small class="tone-warn">Only ${esc(fmt.month(sig.irregular.month))} had spending (${esc(money(sig.irregular.cents))}): not a monthly cost</small>`;
      if (sug.basis === 'year' && known(sug.cents)) {
        const yearHref = usualHref(ctx, cmp, cat, cmp.baselineMonths12, 12);
        usualCell += `<small>${seasonal ? 'Seasonal: depends on the time of year. ' : ''}${esc(basisText(cmp, sug)).replace(/^./, m => m.toUpperCase())}: ${yearHref ? `<a href="${esc(yearHref)}">${esc(money(sug.cents))}</a>` : esc(money(sug.cents))}</small>`;
      }
    } else if (cmp.month && row && row.usualCents === null) {
      usualCell = '<span class="muted">No full months yet</span>';
    }
    if (known(sug.cents) && sug.cents > 0 && sug.cents !== cents) {
      usualCell += `<button type="button" class="btn btn-small btn-ghost bt-use" id="${esc(fid('use-usual', cat))}" data-action="budget:use-usual" data-cat="${esc(cat)}" data-cents="${esc(sug.cents)}" data-basis="${esc(basisText(cmp, sug))}">Use ${esc(money(sug.cents))}${sug.basis === 'year' ? `<span class="bt-use-basis" aria-hidden="true">${esc(cmp.usable12)}-month avg.</span>` : ''}<span class="sr-only"> as the ${esc(cat)} target (${esc(basisText(cmp, sug))})</span></button>`;
    }

    return `<tr class="bt-row${cents === null ? ' is-unset' : ''}" id="${esc(rowId)}">
      <th scope="row"><span class="bt-cat" id="${esc(rowId)}-name">${esc(cat)}</span>${seasonal ? ` ${c.badge('Seasonal', 'info')}` : ''}
        <button type="button" class="bt-remove" id="${esc(fid('target-remove', cat))}" data-action="budget:remove-target" data-cat="${esc(cat)}" aria-label="${esc('Remove the ' + cat + ' target')}">Remove</button></th>
      <td class="bt-target"><span class="bt-label" aria-hidden="true">Your target</span>
        <div class="field field-compact"><div class="input-money"><span aria-hidden="true">$</span><input id="${esc(inputId)}" type="text" inputmode="decimal" autocomplete="off" data-bind="${esc('plan.targets.' + cat)}" data-type="money" data-message="${esc(cat + ' target saved.')}" value="${esc(centsToInput(cents))}" placeholder="Not set" aria-labelledby="${esc(rowId)}-name bt-col-target" aria-describedby="${esc(inputId)}-note ${esc(inputId)}-error"></div>
        <p class="field-error" id="${esc(inputId)}-error" role="alert" hidden></p>
        <p class="bt-note${cents === null ? ' tone-warn' : ''}" id="${esc(inputId)}-note">${cents === null ? 'Not set: left out of totals' : ''}</p></div></td>
      <td class="num bt-actual"><span class="bt-label" aria-hidden="true">${esc(cmp.month ? 'Actual, ' + fmt.month(cmp.month) : 'Actual')}</span>${actualCell}</td>
      <td class="num bt-usual"><span class="bt-label" aria-hidden="true">Usual (history)</span>${usualCell}</td>
    </tr>`;
  }

  function targetsSection(ctx, plan, cmp) {
    const targets = ctx.state.plan.targets || {};
    const cats = E.categories.sortNames(Object.keys(targets));
    const groups = [];
    for (const cat of cats) {
      const g = E.categories.groupOf(cat);
      if (!groups.length || groups[groups.length - 1].group !== g) groups.push({ group: g, cats: [] });
      groups[groups.length - 1].cats.push(cat);
    }
    const win = cmp.window;
    const baseText = cmp.baselineMonths.length ? E.compare.describeMonths(cmp.baselineMonths) : 'no full months';

    // Totals for the footer: targets that are set, against actual and usual for the same categories
    const set = cats.filter(k => targets[k] !== null);
    const totalTarget = E.money.sum(set.map(k => targets[k]));
    const totalActual = cmp.month ? E.money.sum(set.map(k => cmp.rows.get(k)?.actualCents ?? 0)) : null;
    const totalUsual = cmp.month && cmp.usableCount ? E.money.sum(set.map(k => cmp.rows.get(k)?.usualCents ?? 0)) : null;
    const notSet = cats.length - set.length;

    const table = cats.length ? `<div class="table-wrap bud-tt-wrap"><table class="table bud-tt">
        <caption class="sr-only">Spending targets with ${esc(cmp.month ? 'actual spending in ' + fmt.monthLong(cmp.month) : 'no actual data yet')} and the usual average of ${esc(baseText)}</caption>
        <thead><tr>
          <th scope="col" id="bt-col-cat">Category</th>
          <th scope="col" id="bt-col-target" class="bt-h-target">Your target</th>
          <th scope="col" id="bt-col-actual" class="num">${esc(cmp.month ? 'Actual · ' + fmt.month(cmp.month) : 'Actual')}</th>
          <th scope="col" id="bt-col-usual" class="num bt-h-usual">Usual · ${esc(win)}-month average</th>
        </tr></thead>
        ${groups.map(g => `<tbody><tr class="bt-group"><th colspan="4" scope="rowgroup">${esc(g.group)}</th></tr>${g.cats.map(cat => targetRow(ctx, cat, targets[cat], cmp)).join('')}</tbody>`).join('')}
        <tfoot><tr>
          <th scope="row">Targets set (${esc(set.length)} of ${esc(cats.length)})</th>
          <td class="num"><span class="bt-label" aria-hidden="true">Your targets</span>${esc(money(totalTarget))}${notSet ? `<small class="tone-warn">${esc(plural(notSet, 'target'))} not set</small>` : ''}</td>
          <td class="num"><span class="bt-label" aria-hidden="true">Actual</span>${totalActual === null ? '—' : esc(money(totalActual))}</td>
          <td class="num bt-usual"><span class="bt-label" aria-hidden="true">Usual</span>${totalUsual === null ? '—' : esc(money(totalUsual))}</td>
        </tr></tfoot>
      </table></div>` : c.empty('No spending targets yet. Add one below.');

    // Bulk fill (explicit, one undoable change, never touches entered targets)
    const fp = fillPlan(ctx, cmp);
    let fill = '';
    if (fp.blank.length && cmp.month) {
      const why = [];
      why.push(fp.fill.length ? `Copies the usual average into ${esc(plural(fp.fill.length, 'blank target'))}: ${fp.fill.map(f => `${esc(f.category)} ${esc(money(f.cents))}${f.note ? ` (${esc(f.note)})` : ''}`).join(', ')}.` : 'No blank target has a regular usual amount to copy.');
      const stay = [];
      if (fp.noHistory.length) stay.push(`${esc(listText(fp.noHistory))} (no spending in ${esc(baseText)})`);
      if (fp.oneOff.length) stay.push(`${esc(listText(fp.oneOff))} (one unusual month: set ${fp.oneOff.length === 1 ? 'it' : 'these'} yourself)`);
      if (stay.length) why.push(`Stays blank: ${stay.join('; ')}.`);
      why.push('Entered targets never change.');
      fill = `<div class="bud-fill">
        <button type="button" class="btn btn-secondary" id="bud-fill" data-action="budget:fill-targets"${fp.fill.length ? '' : ' disabled'} aria-describedby="bud-fill-why">Fill empty targets from usual averages</button>
        <p class="fine" id="bud-fill-why">${why.join(' ')}</p>
      </div>`;
    }

    // Categories with recent spending and no plan at all
    const planned = new Set(cmp.pva.filter(r => r.sources.length).map(r => r.category));
    const unplanned = [];
    if (cmp.month) {
      const seen = new Set();
      for (const [cat, sig] of cmp.signals) {
        if (planned.has(cat) || cat in targets) continue;
        if ((sig.averageCents || 0) > 0 || sig.actualCents > 0) { unplanned.push({ cat, usual: sig.averageCents, actual: sig.actualCents, sig }); seen.add(cat); }
      }
      for (const r of cmp.pva) if (!r.sources.length && !seen.has(r.category) && !(r.category in targets) && r.actualCents > 0) unplanned.push({ cat: r.category, usual: r.usualCents, actual: r.actualCents });
    }
    const notBudgeted = cmp.month ? `<section class="bud-unbudgeted" aria-labelledby="bud-unbudgeted-h">
        <h3 id="bud-unbudgeted-h">Not budgeted yet</h3>
        ${unplanned.length ? `<p class="fine">Recent spending with no target or bill, so the plan leaves it out.</p>
        <ul class="bud-unb-list">${unplanned.map(u => {
          // Same suggestion as "Use" on a target row: a one-off or seasonal category uses the
          // 12-month average, named on the button.
          const sug = suggestionFor(cmp, u.cat);
          const amt = known(sug.cents) && sug.cents > 0 ? sug.cents : null;
          const usualText = known(u.usual) ? `Usual ${money(u.usual)} (${win}-month average)` : 'Usual unknown';
          return `<li><div><a href="${esc(spendHref(ctx, { period: cmp.month, cat: u.cat }))}">${esc(u.cat)}</a>
            <small>${esc(usualText)} · ${esc(fmt.month(cmp.month))} ${esc(money(u.actual))}${u.sig && u.sig.signal === 'irregular' ? ' · one month only' : ''}${amt !== null && sug.basis === 'year' ? ` · ${esc(basisText(cmp, sug))} ${esc(money(amt))}` : ''}</small></div>
            <button type="button" class="btn btn-small btn-secondary" id="${esc(fid('add-unb', u.cat))}" data-action="budget:add-target" data-cat="${esc(u.cat)}" data-cents="${esc(amt ?? '')}" data-basis="${esc(amt !== null ? basisText(cmp, sug) : '')}">${esc(amt !== null ? 'Add at ' + money(amt) : 'Add target')}<span class="sr-only">${esc(` for ${u.cat}${amt !== null ? ` (${basisText(cmp, sug)})` : ''}`)}</span></button></li>`;
        }).join('')}</ul>` : `<p class="fine">Every category with spending in ${esc(baseText)} or ${esc(fmt.month(cmp.month))} has a target or a bill.</p>`}
      </section>` : '';

    const billCats = [...new Set(cmp.pva.filter(r => r.kind === 'bill').map(r => r.category))];
    // Categories already planned as joint bills stay available but say so (a target on top of the
    // bill would plan the same spending twice); the first other category is preselected.
    const billCatSet = new Set((ctx.state.plan.bills || []).filter(b => b.category).map(b => b.category));
    const free = spendCategories(ctx).filter(n => !(n in targets));
    const firstFree = free.find(n => !billCatSet.has(n));
    const addForm = `<form class="bud-add-form" data-action="budget:add-target-form" aria-label="Add a spending target">
        <div class="field"><label for="bud-add-target-cat">Category</label><select id="bud-add-target-cat" name="category">${free.map(n => `<option value="${esc(n)}"${n === firstFree ? ' selected' : ''}>${esc(n)}${billCatSet.has(n) ? ' (already a bill)' : ''}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-target-amount">Monthly target</label><div class="input-money"><span aria-hidden="true">$</span><input id="bud-add-target-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="Not set" aria-describedby="bud-add-target-amount-help bud-add-target-amount-error"></div>
          <p class="field-help" id="bud-add-target-amount-help">Blank adds it as not set.</p><p class="field-error" id="bud-add-target-amount-error" role="alert" hidden></p></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add target</button></div>
      </form>`;

    const history = !cmp.month
      ? 'history from your transactions. No complete month of transactions is loaded yet, so there is no history to show.'
      : cmp.usableCount
        ? `history: the average of ${plural(cmp.usableCount, 'full month')} before ${fmt.month(cmp.month)} (${baseText}).`
        : `history, but none of the ${win} months before ${fmt.month(cmp.month)} is fully covered by your exports, so there is no usual amount yet.`;
    const explain = `<p class="fine bud-legend"><span class="bud-key bud-key-target" aria-hidden="true"></span><strong>Your target</strong> is the plan. <span class="bud-key bud-key-usual" aria-hidden="true"></span><strong>Usual</strong> is ${esc(history)} ${cmp.month ? `Actual is ${esc(fmt.monthLong(cmp.month))}, the latest complete month. Joint accounts only. Click an amount to see the transactions.` : ''}</p>`;
    const windowToggle = c.segmented({ label: 'Usual = average of', name: 'bud-window', options: WINDOW_OPTIONS, value: win, action: 'budget:set-window' });

    return `<div class="stack">
      ${c.card(`${explain}${fill}${table}${billCats.length ? `<p class="fine bud-billcats">${esc(listText(billCats))} ${billCats.length === 1 ? 'is' : 'are'} planned as bills; see ${sectionLink(ctx, 'bills', 'Bills', { params: { focus: 'bud-bills-h' } })}.</p>` : ''}${notBudgeted}`,
        { title: 'Spending targets', id: 'bud-targets', subtitle: 'What you aim to spend each month by category, next to what actually happened.', actions: windowToggle })}
      ${c.card(addForm, { title: 'Add a spending target', id: 'bud-add-target' })}
    </div>`;
  }

  // ------------------------------------------------------------------ savings
  function goalStatus(g) {
    if (!g) return { badge: c.badge('Not projected', 'neutral'), note: '' };
    switch (g.status) {
      case 'funded': return { badge: c.badge('On track', 'good'), note: g.note };
      case 'short': return { badge: c.badge('Short by ' + money(g.shortfallCents), 'warn'), note: g.note };
      case 'unknown_start': return { badge: c.badge('Starting amount unknown', 'info'), note: g.note };
      case 'missing_amount': return { badge: c.badge('Monthly amount not set', 'warn'), note: g.note };
      default: return { badge: c.badge('No target set', 'neutral'), note: g.note };
    }
  }

  function goalItem(ctx, g, proj) {
    const pathOf = f => `plan.savings[id=${g.id}].${f}`;
    const msg = what => `${g.label}: ${what} saved.`;
    const status = goalStatus(proj);
    return `<li class="bud-goal" id="${esc(fid('goal', g.id))}">
      <div class="bud-bill-head"><h3 class="bud-item-title">${esc(g.label)}</h3><span class="bud-badges">${status.badge} ${c.badge(g.spendAtTarget ? 'Spend at target' : 'Keep', 'neutral')}</span></div>
      ${g.note ? `<p class="bud-meta">${esc(g.note)}</p>` : ''}
      <div class="bud-goal-grid">
        ${moneyField({ id: fid('goal-target', g.id), label: 'Target amount', path: pathOf('targetCents'), cents: g.targetCents, message: msg('target'), placeholder: 'Not set' })}
        ${inputField({ id: fid('goal-month', g.id), label: 'Target month', path: pathOf('targetMonth'), value: g.targetMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('target month'), help: 'Leave blank for no date.' })}
        ${moneyField({ id: fid('goal-saved', g.id), label: 'Saved so far', path: pathOf('savedCents'), cents: g.savedCents, message: msg('saved so far'), placeholder: 'Unknown', help: 'Blank means unknown, not $0.' })}
        ${moneyField({ id: fid('goal-monthly', g.id), label: 'Monthly contribution', path: pathOf('monthlyCents'), cents: g.monthlyCents, message: msg('monthly contribution'), placeholder: 'Not set' })}
        ${selectField({ id: fid('goal-spend', g.id), label: 'At the target', path: pathOf('spendAtTarget'), value: g.spendAtTarget ? 'true' : 'false', message: msg('spend or keep'),
          options: [{ value: 'true', label: 'Spend it (trip)' }, { value: 'false', label: 'Keep it (cushion)' }] })}
      </div>
      ${status.note ? `<p class="bud-counts">${esc(status.note)}</p>` : ''}
      <details class="disclosure bud-more" id="${esc(fid('goal-more', g.id))}"><summary>Name, note and remove</summary><div class="disclosure-body">
        <div class="form-grid">${inputField({ id: fid('goal-label', g.id), label: 'Name', path: pathOf('label'), value: g.label, maxlength: 80, message: 'Goal name saved.' })}
        ${inputField({ id: fid('goal-note', g.id), label: 'Note', path: pathOf('note'), value: g.note || '', maxlength: 500, message: msg('note') })}</div>
        <div class="bud-remove-row">${c.button('Remove this goal', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'savings', id: g.id, label: g.label, focus: 'bud-add-goal-name' } })}</div>
      </div></details>
    </li>`;
  }

  function savingsSection(ctx) {
    const st = ctx.state;
    const bal = st.plan.balances || {};
    const cashKnown = E.money.isCents(bal.jointCashCents);
    const cashCard = c.card(`<p class="fine">Bank exports do not include balances. Until you enter one, forecasts show how much joint cash goes up or down, not how much you will have.</p>
      <div class="bud-grid-2">
        ${moneyField({ id: 'bud-cash', label: 'Joint cash today', path: 'plan.balances.jointCashCents', cents: bal.jointCashCents ?? null, allowNegative: true, placeholder: 'Not entered', message: 'Joint cash balance saved.',
          help: 'Checking plus joint savings. A negative amount means overdrawn.' })}
        ${inputField({ id: 'bud-cash-asof', label: 'As of', path: 'plan.balances.asOf', value: bal.asOf || '', type: 'date', dataType: 'date', message: 'Balance date saved.', help: 'The date the balance was true.' })}
      </div>
      <p class="bud-counts">${cashKnown ? `Forecasts start from ${esc(money(bal.jointCashCents))}${bal.asOf ? ` (as of ${esc(fmt.date(bal.asOf))})` : ' (date not entered)'}.` : '<span class="tone-warn">Not entered: forecasts show the change in cash only.</span>'}</p>`,
    { title: 'Joint cash balance', id: 'bud-cash-card' });

    let proj = null;
    try { proj = ctx.project(st.scenarios[0].id, { months: 60 }); } catch (err) { proj = null; }
    const byId = new Map((proj ? proj.goals : []).map(g => [g.id, g]));
    const goals = st.plan.savings || [];
    const list = goals.length ? `<ul class="bud-goal-list">${goals.map(g => goalItem(ctx, g, byId.get(g.id))).join('')}</ul>` : c.empty('No savings goals yet.');
    const addForm = `<form class="bud-add-form" data-action="budget:add-goal" aria-label="Add a savings goal">
        <div class="field"><label for="bud-add-goal-name">Name</label><input id="bud-add-goal-name" name="label" maxlength="80" placeholder="e.g. Baby fund" aria-describedby="bud-add-goal-name-error"><p class="field-error" id="bud-add-goal-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-goal-spend">At the target</label><select id="bud-add-goal-spend" name="spendAtTarget"><option value="false">Keep it (cushion)</option><option value="true">Spend it (trip)</option></select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add goal</button></div>
      </form>`;
    const goalsCard = c.card(`<p class="fine"><strong>Spend at target</strong>: the money is used in the target month, like a trip. <strong>Keep</strong>: it stays saved, like an emergency cushion. Status is projected over the next 5 years if the current budget is followed (no growth or investment return).</p>${list}`,
      { title: 'Savings goals', id: 'bud-goals', subtitle: `${whole(E.money.sum(goals.map(g => g.monthlyCents)))} a month set aside` });
    return `<div class="stack">${goalsCard}${cashCard}${c.card(addForm, { title: 'Add a savings goal', id: 'bud-add-goal' })}</div>`;
  }

  // ------------------------------------------------------------------ debts
  const FACT_BADGE = {
    confirmed: ['Confirmed', 'good'], statement: ['From statement', 'good'], approximate: ['Approximate', 'warn'],
    unknown: ['Unknown', 'bad'], displayed: ['As displayed', 'info'], estimate: ['Estimate', 'warn'], illustrative: ['Illustrative', 'warn'],
  };

  function promoBlock(ctx, d, bill) {
    const pathOf = f => `plan.debts[id=${d.id}].promo.${f}`;
    if (!d.promo) return '';
    const p = d.promo;
    const payment = bill && E.money.isCents(bill.monthlyCents) && bill.monthlyCents >= 0 ? bill.monthlyCents : null;
    let check;
    try {
      check = E.debt.promoCheck({ promoBalanceCents: E.money.isCents(p.balanceCents) ? p.balanceCents : null, expiresMonth: p.expiresMonth, paymentCents: payment, fromMonth: ctx.forecastStart, deferredInterest: p.deferredInterest });
    } catch (err) { check = null; }
    let result = '';
    if (check) {
      const notes = check.notes.slice();
      if (check.status === 'needs_info') {
        result = `<div class="bud-promo-result" id="${esc(fid('promo-result', d.id))}">${c.badge('Needs information', 'info')}
          <p>To check whether ${payment === null ? 'the payment' : esc(money(payment)) + ' a month'} clears the promotion in time, enter:</p>
          <ul>${check.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
          <p class="fine">No judgement is made until then.</p>${notes.slice(1).map(n => `<p class="fine">${esc(n)}</p>`).join('')}</div>`;
      } else {
        const ok = check.status === 'on_track';
        result = `<div class="bud-promo-result" id="${esc(fid('promo-result', d.id))}">${c.badge(ok ? 'On track' : 'Short', ok ? 'good' : 'warn')}
          <dl class="kv"><dt>Needed each month to clear it by ${esc(fmt.month(p.expiresMonth))}</dt><dd>${esc(money(check.requiredMonthlyCents))}</dd>
          <dt>Current payment</dt><dd>${esc(money(payment))}</dd>
          <dt>Months from ${esc(fmt.month(ctx.forecastStart))}</dt><dd>${esc(check.monthsLeft)}</dd>
          ${ok ? '' : `<dt>Left on the promotion at the end</dt><dd class="tone-warn">About ${esc(money(check.projectedRemainingCents))}</dd>`}</dl>
          ${notes.map(n => `<p class="fine">${esc(n)}</p>`).join('')}</div>`;
      }
    }
    return `<div class="bud-promo"><h3>Promotional financing</h3>
      <div class="bud-grid-3">
        ${moneyField({ id: fid('promo-balance', d.id), label: 'Promotional balance', path: pathOf('balanceCents'), cents: p.balanceCents, placeholder: 'Unknown', message: `${d.label}: promotional balance saved.`, help: 'Only the part on the promotion; it may differ from the whole balance.' })}
        ${inputField({ id: fid('promo-end', d.id), label: 'Promotion ends', path: pathOf('expiresMonth'), value: p.expiresMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: `${d.label}: promotion end saved.`, help: 'The last month of the promotion.' })}
        ${selectField({ id: fid('promo-deferred', d.id), label: 'Deferred interest?', path: pathOf('deferredInterest'), value: boolValue(p.deferredInterest), options: YES_NO_OPTIONS, message: `${d.label}: deferred interest saved.`, help: 'Interest charged back to the purchase date if a balance remains.' })}
      </div>
      ${result}
      ${p.note ? `<p class="fine">${esc(p.note)}</p>` : ''}
      <button type="button" class="btn btn-ghost btn-small" id="${esc(fid('promo-remove', d.id))}" data-action="budget:remove-promo" data-debt="${esc(d.id)}">Remove promotional financing</button>
    </div>`;
  }

  function escrowBlock(ctx, d) {
    const insuranceBills = (ctx.state.plan.bills || []).filter(b => b.category === 'Home insurance' || /home insurance/i.test(b.label));
    const taxPlanned = (ctx.state.plan.bills || []).some(b => b.category === 'Property tax & HOA') || 'Property tax & HOA' in (ctx.state.plan.targets || {});
    let note;
    if (d.escrowIncluded === true) {
      note = insuranceBills.length
        ? `<p class="tone-warn">${esc(listText(insuranceBills.map(b => b.label)))} ${insuranceBills.length === 1 ? 'is' : 'are'} also a separate bill. If escrow already pays it, it is counted twice; remove the bill or confirm it is separate.</p>`
        : '<p class="fine">Property tax and home insurance are paid through the mortgage, so they need no separate budget lines.</p>';
    } else if (d.escrowIncluded === false) {
      note = `<p class="fine">Property tax and home insurance need their own budget lines.${taxPlanned ? '' : ' No property tax bill or target is set yet.'}</p>`;
    } else {
      note = '<p class="fine">Until this is known, property tax and home insurance may be budgeted twice or missed.</p>';
    }
    return `<div class="bud-escrow">
      ${selectField({ id: fid('debt-escrow', d.id), label: 'Does the payment include property tax and home insurance (escrow)?', path: `plan.debts[id=${d.id}].escrowIncluded`, value: boolValue(d.escrowIncluded), options: YES_NO_OPTIONS, message: `${d.label}: escrow answer saved.` })}
      ${note}</div>`;
  }

  function illustration(d, bill) {
    const rate = isNum(d.aprPct) ? d.aprPct : null;
    const range = Array.isArray(d.aprRange) && d.aprRange.length === 2 && d.aprRange.every(isNum) ? d.aprRange : null;
    if (rate === null && !range) return '';
    const balance = E.money.isCents(d.balanceCents) ? d.balanceCents : null;
    const payment = bill && E.money.isCents(bill.monthlyCents) ? bill.monthlyCents : null;
    let body;
    try {
      if (rate !== null) {
        const r = E.debt.amortize({ balanceCents: balance, aprPct: rate, paymentCents: payment });
        body = `<p>${esc(r.note)}</p>${r.months !== null ? `<dl class="kv"><dt>Months, if nothing changes</dt><dd>About ${esc(r.months)}</dd><dt>Interest over that time</dt><dd>About ${esc(money(r.interestCents))}</dd></dl>` : ''}`;
      } else {
        const r = E.debt.illustrativeRange({ balanceCents: balance, paymentCents: payment, aprMin: range[0], aprMax: range[1] });
        body = `<p>${esc(r.note)}</p>`;
      }
    } catch (err) { body = `<p>${esc(err.message)}</p>`; }
    const status = d.aprStatus === 'confirmed' ? 'confirmed' : 'as displayed, not confirmed';
    return `<details class="disclosure bud-illus" id="${esc(fid('debt-illus', d.id))}"><summary>Illustrative only: what the ${rate !== null ? 'rate' : 'rate range'} would mean</summary><div class="disclosure-body">
      ${body}
      <p class="fine">Assumes ${rate !== null ? `the ${esc(rate)}% rate (${esc(status)})` : `the ${esc(range[0])}%–${esc(range[1])}% range (${esc(status)}) applied to the whole balance as one loan`}, the same payment every month, interest added monthly and no new charges or fees. It is not a payoff date: the real terms may differ.</p>
    </div></details>`;
  }

  function debtCard(ctx, d) {
    const bills = ctx.state.plan.bills || [];
    const bill = d.paymentBillId ? bills.find(b => b.id === d.paymentBillId) || null : null;
    const pathOf = f => `plan.debts[id=${d.id}].${f}`;
    const msg = what => `${d.label}: ${what} saved.`;
    let sum = null;
    try { sum = E.debt.summary(d, bill, { month: ctx.forecastStart, people: ctx.people }); } catch (err) { sum = null; }
    const housing = !!(bill && (bill.type === 'housing' || bill.category === 'Mortgage')) || /mortgage|home loan/i.test(d.label || '');

    const facts = (sum ? sum.lines : []).filter(l => !['promo', 'escrow', 'paymentsLeft'].includes(l.key)).map(l => {
      let value = l.value;
      let b = FACT_BADGE[l.status];
      if (l.key === 'payment' && bill && E.money.isCents(bill.monthlyCents)) {
        value = `${money(bill.monthlyCents)} a month, paid from ${fundingText(ctx, bill.fundedFrom)}`;
        // The status is about the amount; who pays is said in the text (and may be unconfirmed).
        if (b) b = [l.status === 'confirmed' ? 'Amount confirmed' : 'Amount: ' + b[0].toLowerCase(), b[1]];
      }
      // The badge already says how sure the figure is; drop the same words in brackets.
      if (b) value = String(value).replace(/\s*\((approximate|statement balance|confirmed)\)$/i, '');
      return `<dt>${esc(l.label)}</dt><dd>${esc(value)}${b ? ` ${c.badge(b[0], b[1])}` : ''}</dd>`;
    }).join('');
    const lb = sum ? sum.lowerBound : null;
    const floor = lb && lb.months !== null
      ? `<p class="bud-floor"><strong>At least ${esc(plural(lb.months, 'more payment'))} at 0% interest.</strong> A floor, not a payoff date: any interest makes it longer.</p>`
      : lb ? `<p class="fine">${esc(lb.note)}</p>` : '';
    const warnings = sum ? sum.warnings.filter(w => !/^Promotion:|^Escrow unknown/.test(w)) : [];

    const billOptions = [{ value: '__null__', label: 'No payment linked' }, ...bills.map(b => ({ value: b.id, label: `${b.label} (${b.monthlyCents === null ? 'amount not entered' : money(b.monthlyCents)})` }))];
    const rangeMin = fid('debt-apr-min', d.id), rangeMax = fid('debt-apr-max', d.id);
    const range = Array.isArray(d.aprRange) ? d.aprRange : [null, null];
    const details = `<details class="disclosure bud-more" id="${esc(fid('debt-more', d.id))}"><summary>Update balance, rate and terms</summary><div class="disclosure-body">
      <div class="form-grid">
        ${moneyField({ id: fid('debt-balance', d.id), label: 'Balance', path: pathOf('balanceCents'), cents: d.balanceCents, placeholder: 'Unknown', message: msg('balance') })}
        ${selectField({ id: fid('debt-balance-status', d.id), label: 'Balance is', path: pathOf('balanceStatus'), value: d.balanceStatus || 'unknown', options: BALANCE_STATUS_OPTIONS, message: msg('balance status') })}
        ${inputField({ id: fid('debt-asof', d.id), label: 'Balance as of', path: pathOf('balanceAsOf'), value: d.balanceAsOf || '', type: 'date', dataType: 'date', message: msg('balance date') })}
        ${selectField({ id: fid('debt-bill', d.id), label: 'Monthly payment', value: d.paymentBillId ?? '__null__', options: billOptions, action: 'budget:link-payment', data: { debt: d.id }, help: 'The bill that pays this debt. Amounts are edited in Bills.' })}
        ${selectField({ id: fid('debt-apr-status', d.id), label: 'Interest rate is', path: pathOf('aprStatus'), value: d.aprStatus || 'unknown', options: APR_STATUS_OPTIONS, message: msg('rate status') })}
        ${inputField({ id: fid('debt-apr', d.id), label: 'Interest rate (APR %)', path: pathOf('aprPct'), value: isNum(d.aprPct) ? d.aprPct : '', type: 'text', dataType: 'number', inputmode: 'decimal', placeholder: 'Unknown', message: msg('rate'), help: 'One rate. Leave blank if unknown.' })}
        <fieldset class="field bud-range"><legend>Or a range shown by the lender (%)</legend><div class="bud-days-row">
          <label class="sr-only" for="${esc(rangeMin)}">Lowest rate</label><input id="${esc(rangeMin)}" type="text" inputmode="decimal" placeholder="Lowest" value="${esc(range[0] ?? '')}" data-action="budget:set-apr-range" data-debt="${esc(d.id)}" data-min="${esc(rangeMin)}" data-max="${esc(rangeMax)}" aria-describedby="${esc(rangeMin)}-error">
          <span aria-hidden="true">to</span>
          <label class="sr-only" for="${esc(rangeMax)}">Highest rate</label><input id="${esc(rangeMax)}" type="text" inputmode="decimal" placeholder="Highest" value="${esc(range[1] ?? '')}" data-action="budget:set-apr-range" data-debt="${esc(d.id)}" data-min="${esc(rangeMin)}" data-max="${esc(rangeMax)}" aria-describedby="${esc(rangeMax)}-error">
        </div><p class="field-help">For several loans with different rates.</p><p class="field-error" id="${esc(rangeMin)}-error" role="alert" hidden></p><p class="field-error" id="${esc(rangeMax)}-error" role="alert" hidden></p></fieldset>
        ${inputField({ id: fid('debt-loans', d.id), label: 'Number of loans', path: pathOf('loanCount'), value: d.loanCount ?? '', type: 'number', dataType: 'int', min: 1, max: 100, inputmode: 'numeric', message: msg('number of loans') })}
        ${inputField({ id: fid('debt-plan', d.id), label: 'Repayment plan', path: pathOf('repaymentPlan'), value: d.repaymentPlan || '', maxlength: 80, placeholder: 'Unknown', message: msg('repayment plan'), help: 'As named by the lender.' })}
        ${selectField({ id: fid('debt-terms', d.id), label: 'Remaining term and schedule', path: pathOf('termStatus'), value: d.termStatus || 'unknown', options: TERM_STATUS_OPTIONS, message: msg('terms status') })}
        ${selectField({ id: fid('debt-owner', d.id), label: 'Whose debt', path: pathOf('ownerId'), value: d.ownerId || 'joint', options: [{ value: 'joint', label: 'Joint' }, ...peopleOptions(ctx)], message: msg('owner') })}
        ${inputField({ id: fid('debt-label', d.id), label: 'Name', path: pathOf('label'), value: d.label, maxlength: 80, message: 'Debt name saved.' })}
      </div>
      ${inputField({ id: fid('debt-note', d.id), label: 'Note', path: pathOf('note'), value: d.note || '', maxlength: 500, message: msg('note') })}
      ${d.promo ? '' : `<div class="bud-promo-add"><p class="fine">Is part of this balance on a promotional plan, such as 0% until a date? Add it to check the payment against the end date.</p>
        <button type="button" class="btn btn-secondary btn-small" id="${esc(fid('promo-add', d.id))}" data-action="budget:add-promo" data-debt="${esc(d.id)}">Add promotional financing</button></div>`}
      <div class="bud-remove-row">${c.button('Remove this debt', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'debts', id: d.id, label: d.label, focus: 'bud-add-debt-name' } })}</div>
    </div></details>`;

    const owner = d.ownerId === 'joint' || !d.ownerId ? 'Joint' : ctx.person(d.ownerId);
    const body = `${d.note ? `<p class="bud-meta">${esc(d.note)}</p>` : ''}
      <dl class="bud-facts">${facts}</dl>
      ${floor}
      ${warnings.length ? `<div class="bud-tocheck"><h3>Still to confirm</h3><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${housing ? escrowBlock(ctx, d) : ''}
      ${promoBlock(ctx, d, bill)}
      ${illustration(d, bill)}
      ${details}`;
    return c.card(body, { title: d.label, id: fid('debt-card', d.id), cls: 'bud-debt-card', subtitle: `${esc(owner)}${bill ? ` · paid by the bill ${sectionLink(ctx, 'bills', esc(bill.label), { params: { focus: fid('bill-amt', bill.id) } })}` : ' · no payment linked'}` });
  }

  function debtsSection(ctx) {
    const debts = ctx.state.plan.debts || [];
    const addForm = `<form class="bud-add-form" data-action="budget:add-debt" aria-label="Add a debt">
        <div class="field"><label for="bud-add-debt-name">Name</label><input id="bud-add-debt-name" name="label" maxlength="80" placeholder="e.g. Furniture financing" aria-describedby="bud-add-debt-name-error"><p class="field-error" id="bud-add-debt-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-debt-owner">Whose debt</label><select id="bud-add-debt-owner" name="ownerId"><option value="joint">Joint</option>${peopleOptions(ctx).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add debt</button></div>
      </form><p class="fine">Add the monthly payment as a bill of type Debt payment, then link it on the debt.</p>`;
    const intro = c.notice({ tone: 'info', title: 'Facts, not forecasts', body: 'Payments are budgeted in Bills. Here you record what you know about each balance. No payoff date is estimated without confirmed terms; anything based on an entered rate is marked illustrative.' });
    return `<div class="stack">${intro}${debts.map(d => debtCard(ctx, d)).join('') || c.card(c.empty('No debts recorded.'), { title: 'Debts' })}${c.card(addForm, { title: 'Add a debt', id: 'bud-add-debt' })}</div>`;
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const section = sectionOf(ctx);
    let plan;
    try { plan = ctx.plan(planOpts(ctx)); } catch (err) {
      return c.pageHeader({ eyebrow: 'Budget', title: 'Your monthly budget' }) + c.notice({ tone: 'bad', title: 'The budget could not be calculated.', body: esc(err.message) });
    }
    const cmp = comparison(ctx);
    const change = lastChange(ctx);
    const header = c.pageHeader({
      eyebrow: 'Budget',
      title: 'Your monthly budget',
      subtitle: 'Change what comes in, bills, spending targets, savings and debts. The summary shows what each change does to the money left each month.',
      actions: c.segmented({ label: 'Show', name: 'scope', options: SCOPE_OPTIONS, value: ctx.scope, action: 'set-scope' }),
    });
    let body;
    switch (section) {
      case 'income': body = incomeSection(ctx, plan); break;
      case 'bills': body = billsSection(ctx, plan, cmp); break;
      case 'savings': body = savingsSection(ctx); break;
      case 'debts': body = debtsSection(ctx); break;
      default: body = targetsSection(ctx, plan, cmp);
    }
    return `${header}
      ${ctx.app.datasetError ? c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) }) : ''}
      <div class="bud-layout">
        ${summaryPanel(ctx, plan, cmp, change)}
        <div class="bud-main">
          ${sectionNav(ctx, section, sectionCounts(ctx, plan))}
          <div class="bud-section" id="bud-section-${esc(section)}">${body}</div>
        </div>
      </div>`;
  }

  // Missing-input links carry ?focus=<field id>: focus that field once per navigation.
  let handledFocus = null;
  // The plan last shown, to add the consequence of a change to its toast.
  let shownPlan = null;

  function afterRender(container, ctx) {
    // Phones show the tabs as a scrolling strip: keep the current one in view.
    const strip = container.querySelector('.bud-tabs .section-nav');
    const current = strip && strip.querySelector('[aria-current]');
    if (current && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, current.offsetLeft - strip.offsetLeft - 16);

    const target = ctx.route.params.focus;
    if (!target) handledFocus = null;
    else {
      // Once per navigation; again when the same link is used twice (the app then re-renders the
      // same URL and moves focus to the page title, which this replaces with the field).
      const first = handledFocus !== location.hash;
      handledFocus = location.hash;
      const el = document.getElementById(target);
      if (el) {
        if (first) { const d = el.closest('details'); if (d) d.open = true; }
        // A heading target (a card it links to) becomes focusable for this purpose only.
        if (!el.matches('a[href], button, input, select, textarea, summary, [tabindex]')) el.setAttribute('tabindex', '-1');
        setTimeout(() => {
          if (!first && !(document.activeElement && document.activeElement.id === 'page-title')) return;
          const d = el.closest('details');
          if (d) d.open = true;
          el.focus({ preventScroll: true });
          el.scrollIntoView({ block: 'center' });
        }, 0);
      }
    }

    // Say what an edit did in the toast too, so the consequence is seen next to where the edit was
    // made (on a phone the summary is off screen). Only right after a forward change made here.
    const st = ctx.state;
    const stack = ctx.app.undoStack || [];
    const top = stack.length ? stack[stack.length - 1] : null;
    const fresh = st.meta && st.meta.updatedAt && Date.now() - Date.parse(st.meta.updatedAt) < 3000;
    if (shownPlan && st.plan !== shownPlan && top && top.plan === shownPlan && fresh) {
      const ch = lastChange(ctx);
      // On wide screens the summary scrolls on its own: bring the new "What changed" box into
      // its view (the page itself does not move, so the edited field stays where it was).
      const box = container.querySelector('#bud-change');
      const panel = box && box.closest('.bud-summary');
      if (panel && panel.scrollHeight > panel.clientHeight + 1 && getComputedStyle(panel).position === 'sticky') {
        const bottom = box.offsetTop + box.offsetHeight + 8;
        if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = Math.min(box.offsetTop - 8, bottom - panel.clientHeight);
      }
      const toastEl = document.getElementById('toast');
      if (ch && toastEl && !toastEl.hidden) {
        const base = (toastEl.querySelector('span') || {}).textContent || '';
        const wc = ch.wc;
        let extra = '';
        if (known(wc.remainingDeltaCents) && wc.remainingDeltaCents !== 0) extra = `Remaining ${money(wc.before.remainingCents)} → ${money(wc.after.remainingCents)} a month (${signed(wc.remainingDeltaCents)}).`;
        else if (known(wc.remainingDeltaCents) && payChangeNote(ctx, ch)) extra = 'Remaining unchanged: in the whole-household view, personal spending moves with take-home pay.';
        else if (wc.before.remainingCents === null && wc.after.remainingCents !== null) extra = `Remaining is now ${money(wc.after.remainingCents)} a month.`;
        else if (!known(wc.remainingDeltaCents) && ch.outDelta) extra = `Going out ${signed(ch.outDelta)} a month.`;
        if (extra) ctx.app.toast((base ? base + ' ' : '') + extra, { undo: true });
      }
    }
    shownPlan = st.plan;
    // Lets tools and browser tests wait for the render that shows the current plan and scope.
    const layout = container.querySelector('.bud-layout');
    if (layout) { layout.__budPlan = st.plan; layout.dataset.scope = ctx.scope; }
  }

  // ------------------------------------------------------------------ actions
  function readAmount(form, name, errorId) {
    const raw = String(new FormData(form).get(name) || '');
    try {
      const cents = E.money.inputToCents(raw);
      setError(errorId, null);
      return { ok: true, cents };
    } catch (err) {
      setError(errorId, err.message);
      return { ok: false };
    }
  }
  function readLabel(form, id) {
    const v = String(new FormData(form).get('label') || '').trim();
    if (!v) { setError(id, 'Enter a name.'); document.getElementById(id)?.focus(); return null; }
    setError(id, null);
    return v;
  }
  const lastId = (state, list) => { const items = state.plan[list] || []; return items.length ? items[items.length - 1].id : null; };
  // Forms act on submit only (app.js already ignores clicks inside a form; this keeps it true if a
  // form action is ever run another way).
  const onSubmit = fn => (ctx, form, ev) => (ev && ev.type === 'submit' ? fn(ctx, form, ev) : undefined);

  const actions = {
    /** Undo from the "What changed" box: the box goes away, so focus moves to the summary it updated. */
    'budget:undo': ctx => {
      ctx.app.undo();
      focusAfterRender('bud-summary-h');
    },

    'budget:set-window': (ctx, el) => {
      const value = Number(el.dataset.value || el.value);
      ctx.app.update(st => E.state.setPath(st, 'plan.settings.comparisonWindow', value), { undoable: false });
    },

    'budget:use-usual': (ctx, el) => {
      const cat = el.dataset.cat;
      const cents = Number(el.dataset.cents);
      ctx.app.update(st => E.state.setPath(st, 'plan.targets.' + cat, cents), { message: `${cat} target set to ${money(cents)}, the ${el.dataset.basis || 'usual average'}.` });
      focusAfterRender(fid('target', cat));
    },

    'budget:fill-targets': ctx => {
      const fp = fillPlan(ctx, comparison(ctx));
      if (!fp.fill.length) { ctx.app.toast('No blank target has a regular usual amount to copy.'); return; }
      ctx.app.update(st => fp.fill.reduce((s, f) => {
        if (s.plan.targets[f.category] !== null) return s; // never overwrite an entered target
        return E.state.setPath(s, 'plan.targets.' + f.category, f.cents);
      }, st), { message: `Filled ${plural(fp.fill.length, 'empty target')} from usual averages: ${fp.fill.map(f => f.category + ' ' + money(f.cents) + (f.note ? ` (${f.note})` : '')).join(', ')}. Entered targets were not changed.` });
      // The button is disabled once nothing is left to fill, so move to the first filled target.
      focusAfterRender(fid('target', fp.fill[0].category));
    },

    'budget:add-target': (ctx, el) => {
      const cat = el.dataset.cat;
      const cents = el.dataset.cents === '' || el.dataset.cents === undefined ? null : Number(el.dataset.cents);
      ctx.app.update(st => E.state.setPath(st, 'plan.targets.' + cat, cents), { message: cents === null ? `Added a ${cat} target (not set yet).` : `Added a ${cat} target of ${money(cents)}, the ${el.dataset.basis || 'usual average'}.` });
      focusAfterRender(fid('target', cat));
    },

    'budget:add-target-form': onSubmit((ctx, form) => {
      const cat = String(new FormData(form).get('category') || '').trim();
      if (!cat) return;
      const amt = readAmount(form, 'amount', 'bud-add-target-amount');
      if (!amt.ok) { document.getElementById('bud-add-target-amount')?.focus(); return; }
      if (cat in (ctx.state.plan.targets || {})) throw new E.ValidationError(`${cat} already has a target.`);
      ctx.app.update(st => E.state.setPath(st, 'plan.targets.' + cat, amt.cents), { message: `Added a ${cat} target${amt.cents === null ? ' (not set yet)' : ' of ' + money(amt.cents)}.` });
      focusAfterRender(fid('target', cat));
    }),

    'budget:remove-target': (ctx, el) => {
      const cat = el.dataset.cat;
      ctx.app.update(st => E.state.setPath(st, 'plan.targets.' + cat, undefined), { message: `Removed the ${cat} target.` });
      focusAfterRender('bud-add-target-cat');
    },

    'budget:remove-item': (ctx, el) => {
      const { list, id, label, focus } = el.dataset;
      ctx.app.update(st => E.state.removeItem(st, list, id), { message: `Removed “${label}”.` });
      if (focus) focusAfterRender(focus);
    },

    'budget:add-income': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-income-name');
      if (!label) return;
      const data = new FormData(form);
      const personId = data.get('personId') === '__null__' ? null : String(data.get('personId'));
      const kind = String(data.get('kind') || 'paycheck');
      ctx.app.update(st => E.state.addItem(st, 'incomes', { label, personId, kind, frequency: 'unknown', frequencyStatus: 'unknown', status: 'unknown' }), { message: `Added “${label}”. Its amounts start as unknown.` });
      const id = lastId(ctx.app.state, 'incomes');
      if (id) focusAfterRender(fid(kind === 'contribution' ? 'inc-joint' : 'inc-net', id));
    }),

    'budget:add-bill': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-bill-name');
      if (!label) return;
      const amt = readAmount(form, 'amount', 'bud-add-bill-amount');
      if (!amt.ok) { document.getElementById('bud-add-bill-amount')?.focus(); return; }
      const data = new FormData(form);
      const category = data.get('category') === '__null__' ? null : String(data.get('category'));
      ctx.app.update(st => E.state.addItem(st, 'bills', { label, monthlyCents: amt.cents, fundedFrom: String(data.get('fundedFrom') || 'unknown'), type: String(data.get('type') || 'other'), category, status: 'existing' }),
        { message: `Added the bill “${label}”${amt.cents === null ? ' (amount not entered)' : ' at ' + money(amt.cents) + ' a month'}.` });
      const id = lastId(ctx.app.state, 'bills');
      if (id) focusAfterRender(fid('bill-amt', id));
    }),

    'budget:add-goal': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-goal-name');
      if (!label) return;
      const spendAtTarget = new FormData(form).get('spendAtTarget') === 'true';
      ctx.app.update(st => E.state.addItem(st, 'savings', { label, spendAtTarget }), { message: `Added the goal “${label}”.` });
      const id = lastId(ctx.app.state, 'savings');
      if (id) focusAfterRender(fid('goal-target', id));
    }),

    'budget:add-debt': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-debt-name');
      if (!label) return;
      const ownerId = String(new FormData(form).get('ownerId') || 'joint');
      ctx.app.update(st => E.state.addItem(st, 'debts', { label, ownerId, balanceStatus: 'unknown', aprStatus: 'unknown', termStatus: 'unknown' }), { message: `Added the debt “${label}”.` });
      const id = lastId(ctx.app.state, 'debts');
      if (id) setTimeout(() => { const d = document.getElementById(fid('debt-more', id)); if (d) d.open = true; focusAfterRender(fid('debt-balance', id)); }, 0);
    }),

    'budget:set-days': (ctx, el) => {
      const a = document.getElementById(el.dataset.first), b = document.getElementById(el.dataset.second);
      const days = [Number(a.value), Number(b.value)];
      if (days[0] === days[1]) { setError(el.id, 'Choose two different days.'); return; }
      setError(el.dataset.first, null); setError(el.dataset.second, null);
      ctx.app.update(st => E.state.setPath(st, `plan.incomes[id=${el.dataset.stream}].semimonthlyDays`, days), { message: 'Paydays saved.' });
    },

    'budget:link-payment': (ctx, el) => {
      const debtId = el.dataset.debt;
      const billId = el.value === '__null__' ? null : el.value;
      ctx.app.update(st => {
        let s = E.state.setPath(st, `plan.debts[id=${debtId}].paymentBillId`, billId);
        // Keep both sides linked one-to-one: the chosen bill points at this debt only.
        for (const b of s.plan.bills) if (b.debtId === debtId && b.id !== billId) s = E.state.setPath(s, `plan.bills[id=${b.id}].debtId`, null);
        for (const d of s.plan.debts) if (d.id !== debtId && billId && d.paymentBillId === billId) s = E.state.setPath(s, `plan.debts[id=${d.id}].paymentBillId`, null);
        if (billId) s = E.state.setPath(s, `plan.bills[id=${billId}].debtId`, debtId);
        return s;
      }, { message: billId ? 'Payment linked.' : 'Payment unlinked.' });
    },

    'budget:set-apr-range': (ctx, el) => {
      const minEl = document.getElementById(el.dataset.min), maxEl = document.getElementById(el.dataset.max);
      const parse = input => {
        const raw = input.value.trim().replace(/%$/, '');
        if (raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
      };
      const lo = parse(minEl), hi = parse(maxEl);
      setError(minEl.id, null); setError(maxEl.id, null);
      if (Number.isNaN(lo)) { setError(minEl.id, 'Enter a rate from 0 to 100.'); return; }
      if (Number.isNaN(hi)) { setError(maxEl.id, 'Enter a rate from 0 to 100.'); return; }
      if ((lo === null) !== (hi === null)) {
        // Wait for the other half; a range needs both ends.
        if (el === minEl && hi === null) return;
        if (el === maxEl && lo === null) { setError(minEl.id, 'Enter the lowest rate too, or clear both.'); return; }
        setError(hi === null ? maxEl.id : minEl.id, 'Enter both ends of the range, or clear both.');
        return;
      }
      const value = lo === null ? null : [Math.min(lo, hi), Math.max(lo, hi)];
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${el.dataset.debt}].aprRange`, value), { message: value ? 'Rate range saved.' : 'Rate range cleared.' });
    },

    'budget:add-promo': (ctx, el) => {
      const id = el.dataset.debt;
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${id}].promo.balanceCents`, null), { message: 'Promotional financing added. Enter its balance and end month.' });
      focusAfterRender(fid('promo-balance', id));
    },

    'budget:remove-promo': (ctx, el) => {
      const id = el.dataset.debt;
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${id}].promo`, null), { message: 'Promotional financing removed.' });
      setTimeout(() => { const d = document.getElementById(fid('debt-more', id)); if (d) d.open = true; focusAfterRender(fid('promo-add', id)); }, 0);
    },
  };

  UI.views = UI.views || {};
  UI.views.budget = { title: 'Budget', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
