'use strict';
/*
 * Budget (route #/budget): "this month's plan". What its parts share, in the private
 * BudgetUI._budget namespace. The view is split by section; each file adds its part, in
 * src/manifest.json order:
 *   budget/common.js  this file: the model (the Plan screen's BudgetEngine.timeline.build, the same
 *                     cached build: ctx.memo('timeline')), formatting, form fields, and the pure
 *                     helpers the sections draw from (dollarFlow, paceOf, progressOf, upcoming,
 *                     goalView, sparkPath; unit-tested in tests/unit/budget-view.test.cjs)
 *   budget/hero.js    1. "<Month> plan": where each dollar goes (tl.summary)
 *   budget/month.js   2. This month so far: planned vs spent by group and category, plan editable
 *   budget/goals.js   3. Goals (and investments), 4. Coming up
 *   budget/setup.js   5. Setup details: pay, bills, debts, savings goals (the editors)
 *   views/budget.js   the view itself: composition, afterRender, the budget:* actions
 * Nothing outside the Budget view reads BudgetUI._budget.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc, domId, centsToInput } = UI.dom;
  const fmt = UI.fmt;

  // ------------------------------------------------------------------ formatting
  const isCents = v => Number.isSafeInteger(v);
  const known = v => v !== null && v !== undefined;
  const money = cents => fmt.money(cents);
  const whole = cents => fmt.money(cents, { whole: true });
  const signed = cents => fmt.money(cents, { signed: true });
  const signedWhole = cents => fmt.money(cents, { signed: true, whole: true });
  /** Dollars, with cents only when there are any: $2,222.02, $250. */
  const amt = fmt.amount;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const possessive = name => (/s$/i.test(name) ? name + "'" : name + "'s");
  const listText = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
  /** "October" for '2026-10'. */
  const monthName = m => fmt.monthLong(m).replace(/\s+\d{4}$/, '');
  /** Stable element id for a field, so focus survives re-renders and links from other views can target it. */
  const fid = (kind, key) => domId('bud-' + kind, String(key));
  /** Amount for an exact-entry box: cents kept, thousands separated (2,222.02 ; 250). */
  const inputText = UI.dom.centsToInputText;

  // ------------------------------------------------------------------ model
  const pad = n => String(n).padStart(2, '0');
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /**
   * The Plan screen's model: one BudgetEngine.timeline.build per derive, shared through ctx.memo
   * under the same key and with the same input as the Plan view, so both screens read one build.
   * Null without data (or when the build fails: the setup editors still work).
   */
  function model(ctx) {
    if (!ctx.months || !ctx.months.length) return null;
    try {
      if (UI._plan && typeof UI._plan.model === 'function') return UI._plan.model(ctx);
      return ctx.memo('timeline', () => E.timeline.build({
        txns: ctx.realTxns || ctx.txns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan,
        today: todayIso(), coverageMap: ctx.coverageMap,
      }));
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  // ------------------------------------------------------------------ pure helpers (no DOM, no engine model)
  const IN_LABEL = { other: 'Other money in', fromSavings: 'From savings', fromInvesting: 'From investments', short: 'Short by' };
  const OUT_GROUPS = [
    { key: 'essentials', label: 'Essentials', cls: 'essentials' },
    { key: 'flexible', label: 'Flexible', cls: 'flexible' },
    { key: 'irregular', label: 'Irregular', cls: 'irregular' },
    { key: 'other', label: 'Debt & business', cls: 'debt' },
  ];

  /**
   * "Where each dollar goes" for one plan month (tl.summary): the money-in side (each person, other
   * money in) and the money-out side (spending groups, savings, investing, left over), always
   * balanced. A negative amount changes sides: savings drawn down is "From savings" on the in side
   * (never an out segment, never part of Left over), money brought back from investments is "From
   * investments", and a month that does not cover itself shows "Short by" on the in side.
   * `netCents` is in − out: what all the cash accounts move by in the month (the Plan's combined
   * line); `leftCents` is what stays in checking (in − out − savings).
   * @returns {{ month, inSide, outSide, totalCents, inCents, outCents, netCents, leftCents,
   *   toSavingsCents, fromSavingsCents, investingCents, short }|null}
   */
  function dollarFlow(summary, people) {
    if (!summary || !isCents(summary.inCents)) return null;
    const ins = [], outs = [];
    const by = summary.inByPerson || {};
    for (const p of people || []) if (isCents(by[p.id]) && by[p.id]) ins.push({ key: p.id, label: p.name, cents: by[p.id], cls: p.id === 'p1' ? 'p1' : p.id === 'p2' ? 'p2' : 'in-other' });
    if (isCents(by.other) && by.other) ins.push({ key: 'other', label: IN_LABEL.other, cents: by.other, cls: 'in-other' });
    const og = summary.outByGroup || {};
    for (const g of OUT_GROUPS) if (isCents(og[g.key]) && og[g.key]) outs.push({ key: g.key, label: g.label, cents: og[g.key], cls: g.cls });
    if (isCents(summary.savingsCents) && summary.savingsCents) outs.push({ key: 'savings', label: 'Savings', cents: summary.savingsCents, cls: 'savings' });
    if (isCents(summary.investingCents) && summary.investingCents) outs.push({ key: 'investing', label: 'Investing', cents: summary.investingCents, cls: 'investing' });
    // A negative amount is money flowing the other way: it moves to the other side.
    const inSide = [], outSide = [];
    for (const x of ins) {
      if (x.cents > 0) inSide.push(x);
      else outSide.push(Object.assign({}, x, { label: x.label + ' (less)', cents: -x.cents }));
    }
    for (const x of outs) {
      if (x.cents > 0) { outSide.push(x); continue; }
      if (x.key === 'savings') inSide.push({ key: 'fromSavings', label: IN_LABEL.fromSavings, cents: -x.cents, cls: 'from-savings', draw: true });
      else if (x.key === 'investing') inSide.push({ key: 'fromInvesting', label: IN_LABEL.fromInvesting, cents: -x.cents, cls: 'from-investing', draw: true });
      else inSide.push(Object.assign({}, x, { key: x.key + '-back', label: x.label + ' (refunds)', cents: -x.cents }));
    }
    const sum = list => list.reduce((s, x) => s + x.cents, 0);
    const left = sum(inSide) - sum(outSide);
    if (left > 0) outSide.push({ key: 'left', label: 'Left over', cents: left, cls: 'left' });
    else if (left < 0) inSide.push({ key: 'short', label: IN_LABEL.short, cents: -left, cls: 'short', warn: true });
    const totalCents = Math.max(sum(inSide), sum(outSide));
    for (const x of inSide.concat(outSide)) x.share = totalCents > 0 ? x.cents / totalCents : 0;
    const savings = isCents(summary.savingsCents) ? summary.savingsCents : 0;
    const outCents = isCents(summary.outCents) ? summary.outCents : sum(outs.filter(x => x.key !== 'savings'));
    return {
      month: summary.month, inSide, outSide, totalCents,
      inCents: summary.inCents, outCents, netCents: summary.inCents - outCents,
      leftCents: isCents(summary.leftCents) ? summary.leftCents : left,
      toSavingsCents: Math.max(0, savings), fromSavingsCents: Math.max(0, -savings),
      investingCents: isCents(summary.investingCents) ? summary.investingCents : 0,
      short: left < 0,
    };
  }

  /** The share of a month gone by: covered days ÷ days in the month (0..1), or null. */
  function paceOf(coveredDays, totalDays) {
    if (!Number.isFinite(coveredDays) || !Number.isFinite(totalDays) || totalDays <= 0) return null;
    return Math.max(0, Math.min(1, coveredDays / totalDays));
  }

  /**
   * Spent against planned for one row. `pace` (0..1, or null for a whole month) is how far through
   * the month the spending is: a row is 'ahead' when it has spent noticeably more of its plan than
   * of the month (10 points or more, and $10 or more beyond its pace), 'over' once it passes the
   * plan. fillPct is the bar (0..100), overPct how far past the plan it went (0..100, relative to
   * the plan; 100 when there is no plan).
   * @returns {{ status: 'over'|'ahead'|'ok'|'none', ratio, fillPct, overPct, overCents, leftCents }}
   */
  function progressOf(spentCents, plannedCents, pace) {
    const spent = isCents(spentCents) ? spentCents : null;
    const planned = isCents(plannedCents) ? plannedCents : null;
    if (spent === null) return { status: 'none', ratio: null, fillPct: 0, overPct: 0, overCents: 0, leftCents: planned };
    if (planned === null || planned <= 0) {
      const over = spent > 0;
      return { status: over ? 'over' : 'ok', ratio: null, fillPct: over ? 100 : 0, overPct: over ? 100 : 0, overCents: Math.max(0, spent), leftCents: planned === null ? null : -Math.max(0, spent) };
    }
    const ratio = spent / planned;
    const overCents = Math.max(0, spent - planned);
    let status = overCents > 0 ? 'over' : 'ok';
    if (status === 'ok' && Number.isFinite(pace) && pace < 1 && ratio - pace >= 0.1 && spent - Math.round(planned * pace) >= 1000) status = 'ahead';
    return {
      status, ratio,
      fillPct: Math.max(0, Math.min(100, ratio * 100)),
      overPct: overCents ? Math.min(100, (overCents / planned) * 100) : 0,
      overCents, leftCents: planned - spent,
    };
  }

  /**
   * What is coming up: the plan's changes (the household's and the ones worked out from bills and
   * goals) that start from `fromMonth` on, and the goals' reach markers, in month order (then by
   * size), at most `limit`. Changes outside the horizon are left out.
   * @returns {[{ id, month, label, cents, kind: 'monthly'|'oneTime'|'goal', group, source, status, endMonth }]}
   */
  function upcoming(changes, markers, fromMonth, limit = 6) {
    const items = [];
    for (const ch of changes || []) {
      if (!ch || !E.months.isMonth(ch.startMonth) || ch.startMonth < fromMonth || ch.status === 'outside') continue;
      items.push({ id: ch.id, month: ch.startMonth, label: ch.label, cents: isCents(ch.cents) ? ch.cents : null, kind: ch.kind === 'monthly' ? 'monthly' : 'oneTime',
        group: ch.group, source: ch.source || 'plan', status: ch.status || 'applied', endMonth: ch.endMonth || null, scenario: ch.scenario || null });
    }
    for (const m of markers || []) {
      if (!m || m.kind !== 'goal' || !E.months.isMonth(m.month) || m.month < fromMonth) continue;
      items.push({ id: 'reach-' + m.id, month: m.month, label: m.label, cents: isCents(m.cents) ? m.cents : null, kind: 'goal', group: 'savings', source: 'goal', status: 'reach', endMonth: null, scenario: null });
    }
    items.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : Math.abs(b.cents || 0) - Math.abs(a.cents || 0)));
    return items.slice(0, Math.max(0, limit));
  }

  /**
   * One savings goal as its card shows it (tl.goals entry): progress (saved ÷ target, 0..1, null
   * when either is unknown) and where the plan gets it: 'reached', a month, 'beyond' the plan's
   * horizon, or 'noTarget'.
   */
  function goalView(goal) {
    const target = isCents(goal.targetCents) && goal.targetCents > 0 ? goal.targetCents : null;
    const saved = isCents(goal.savedCents) ? goal.savedCents : null;
    const progress = target !== null && saved !== null ? Math.max(0, Math.min(1, saved / target)) : null;
    let reach;
    if (target === null) reach = 'noTarget';
    else if (goal.already || (saved !== null && saved >= target)) reach = 'reached';
    else if (E.months.isMonth(goal.reachMonth)) reach = 'month';
    else reach = 'beyond';
    return { target, saved, progress, reach, month: reach === 'month' ? goal.reachMonth : null };
  }

  /**
   * A sparkline path for month-end values (null: unknown, a gap) in a w × h box with 2px of room:
   * { d (the known part, solid), dProjected (from `projectFrom` on, dashed), last: { x, y }, min, max }
   * or null with fewer than two known values.
   */
  function sparkPath(values, w, h, projectFrom = null) {
    const known = (values || []).map((v, i) => ({ v, i })).filter(p => isCents(p.v));
    if (known.length < 2) return null;
    const min = Math.min(...known.map(p => p.v)), max = Math.max(...known.map(p => p.v));
    const n = values.length - 1 || 1;
    const x = i => +(2 + (i / n) * (w - 4)).toFixed(1);
    const y = v => +(max === min ? h / 2 : 2 + (1 - (v - min) / (max - min)) * (h - 4)).toFixed(1);
    const path = list => list.reduce((s, p, k) => s + (k && p.i === list[k - 1].i + 1 ? 'L' : 'M') + x(p.i) + ' ' + y(p.v), '');
    const split = Number.isInteger(projectFrom) ? projectFrom : values.length;
    // The projected part starts at the last known point before it, so the two parts join.
    const past = known.filter(p => p.i < split);
    const ahead = split < values.length ? known.filter(p => p.i >= split - 1) : [];
    const lastP = known[known.length - 1];
    // A known value with no known neighbour draws no line: it is a dot (never joined across a gap).
    const has = new Set(known.map(p => p.i));
    const dots = past.filter(p => !has.has(p.i - 1) && !has.has(p.i + 1) && p !== lastP).map(p => ({ x: x(p.i), y: y(p.v) }));
    return { d: path(past), dProjected: ahead.length > 1 ? path(ahead) : '', dots, last: { x: x(lastP.i), y: y(lastP.v) }, min, max };
  }

  // ------------------------------------------------------------------ form fields (stable ids, toast messages)
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
  /** Show or clear the inline error under a field (`<id>-error`). */
  function setError(id, message) {
    const el = document.getElementById(id);
    const err = document.getElementById(id + '-error');
    if (el) { if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    if (err) { err.textContent = message || ''; err.hidden = !message; }
  }
  function focusAfterRender(id) {
    // app.update schedules the render with setTimeout(0); this runs right after it.
    setTimeout(() => { const el = document.getElementById(id); if (el) el.focus(); }, 0);
  }

  UI._budget = {
    isCents, known, money, whole, signed, signedWhole, amt, plural, possessive, listText, monthName, fid, inputText, todayIso,
    model, OUT_GROUPS, dollarFlow, paceOf, progressOf, upcoming, goalView, sparkPath,
    helpAndError, moneyField, selectField, inputField, setError, focusAfterRender,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
