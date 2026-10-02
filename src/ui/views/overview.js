'use strict';
/*
 * Plan (route #/overview): one chart that does most of the work, the balances it starts from,
 * and the dials underneath. Everything comes from BudgetEngine.timeline.build, worked out once
 * per render (ctx.memo).
 *   1. Chart     balance lines or money in and out each month, on one timeline; past and ahead
 *   2. Balances  the known balance of each joint cash account (or one joint cash figure)
 *   3. Dials     money in by person, money out by kind; card and bank spending open into their
 *                categories and places; "each month on this plan" adds the dials up
 *   4. More      baseline window, cover-from-savings, links to the detail views
 * Text boxes and sliders commit on change through app.update (undoable). While a slider is being
 * dragged only its own box and the sum line follow; the chart follows on release.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const DIAL_CLS = { p1: 'series-1', p2: 'series-2', inOther: 'series-muted', card: 'series-5', bank: 'series-4', savings: 'series-3', other: 'series-muted' };
  const SUM_NAME = { card: 'cards', bank: 'bills', other: 'other' };
  const MODES = [{ value: 'balance', label: 'Balance' }, { value: 'flows', label: 'Flows' }];
  const PAST = [{ value: 6, label: '6 mo' }, { value: 12, label: '12 mo' }, { value: 'all', label: 'All' }];
  const AHEAD = [{ value: 6, label: '6 mo' }, { value: 12, label: '1 yr' }, { value: 24, label: '2 yr' }, { value: 60, label: '5 yr' }];
  const BASELINES = [{ value: 3, label: 'Last 3' }, { value: 6, label: 'Last 6' }, { value: 12, label: 'Last 12' }, { value: 'all', label: 'All' }];
  const STEP_CENTS = 2500; // the sliders move in $25 steps; the exact box keeps cents

  /** Set by a change made on this page: the next render announces the new monthly sum. */
  let announceNext = false;

  // ------------------------------------------------------------------ formatting
  const isCents = v => Number.isSafeInteger(v);
  const whole = cents => fmt.money(cents, { whole: true });
  const exact = cents => fmt.money(cents);
  /** Dollars, with cents only when there are any: $2,222.02, $250. */
  const amt = cents => (isCents(cents) && cents % 100 !== 0 ? exact(cents) : whole(cents));
  const signedAmt = cents => (cents > 0 ? '+' : '') + amt(cents);
  const plural = (n, word, many) => n + ' ' + (n === 1 ? word : many || word + 's');
  /** Amount for an exact-entry box: cents kept, thousands separated, an ASCII minus. */
  function inputText(cents) {
    if (!isCents(cents)) return '';
    const abs = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(abs / 100).toLocaleString('en-US') + (abs % 100 ? '.' + String(abs % 100).padStart(2, '0') : '');
  }
  /** Typed amounts: commas and a typographic minus or dash are fine. */
  const typed = value => String(value || '').trim().replace(/[−–—]/g, '-');
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
  const choice = v => (v === 'all' ? 'all' : Number(v));

  // ------------------------------------------------------------------ model
  function model(ctx) {
    return ctx.memo('timeline', () => E.timeline.build({
      txns: ctx.realTxns || ctx.txns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan,
      today: todayIso(), coverageMap: ctx.coverageMap,
    }));
  }

  /** Without any known balance there is no balance line to draw: show the flows instead. */
  const modeOf = tl => (tl.balances.mode === 'none' ? 'flows' : tl.settings.mode);
  const dialLabel = d => (d.group === 'in' && d.key !== 'inOther' ? d.label + ' → joint' : d.label);
  const signedDial = d => d.key === 'savings' || d.key === 'other' || (d.baselineCents || 0) < 0 || (d.planCents || 0) < 0;

  /** Series switched off in the chart. Never chosen (null): the account lines are off. */
  function hiddenOf(ctx, tl) {
    const raw = ctx.state.ui && ctx.state.ui.plan ? ctx.state.ui.plan.hidden : null;
    if (Array.isArray(raw)) return raw;
    return tl.balances.accounts.map(a => 'acct-' + a.id);
  }

  // ------------------------------------------------------------------ 1. the chart
  function chartSpec(ctx, tl) {
    const from = Math.max(0, tl.window.fromIndex);
    const rows = tl.months.slice(from);
    const months = rows.map(m => m.month);
    const mode = modeOf(tl);
    const spec = {
      id: 'plan-chart', mode, months, todayMonth: tl.todayMonth, planStart: tl.planStart, hidden: hiddenOf(ctx, tl),
      title: mode === 'balance' ? 'Joint cash at the end of each month' : 'Money in and out of joint each month',
      titleHidden: UI.chart.isNarrow(),
      tableCaption: mode === 'balance' ? 'Joint cash at the end of each month' : 'Money in and out of joint each month',
    };
    if (mode === 'balance') {
      const b = tl.balances;
      const points = (list, account) => list.slice(from).map(p => ({
        month: p.month, cents: p.cents,
        status: p.gap && p.cents !== null ? 'gap' : p.status,
        note: account && p.anchor && account.anchor ? 'Known balance ' + exact(account.anchor.cents) + ' on ' + fmt.date(account.anchor.date) + '.' : '',
      }));
      spec.lines = [];
      if (b.combined) spec.lines.push({ key: 'combined', name: 'Combined cash', role: 'combined', points: points(b.combined.points) });
      for (const a of b.accounts) spec.lines.push({ key: 'acct-' + a.id, name: a.name, role: 'account', points: points(a.points, a) });
    } else {
      const known = (...vals) => (vals.some(v => v === null || v === undefined) ? null : vals.reduce((s, v) => s + v, 0));
      const cin = tl.people.map(p => ({ key: 'in-' + p.id, name: p.name + ' → joint', cls: DIAL_CLS[p.id] || 'series-muted', values: rows.map(m => m.in[p.id]) }));
      const otherIn = rows.map(m => known(m.in.unassigned, m.in.other));
      if (tl.dialsByKey.inOther || otherIn.some(v => v)) cin.push({ key: 'in-other', name: 'Other money in', cls: 'series-muted', values: otherIn });
      const fromSavings = rows.map(m => (m.savings === null ? null : Math.max(0, 0 - m.savings)));
      if (fromSavings.some(v => v > 0)) cin.push({ key: 'in-savings', name: 'From savings', cls: 'series-3', values: fromSavings });
      const cout = [
        { key: 'out-card', name: 'Cards', cls: 'series-5', values: rows.map(m => m.out.card) },
        { key: 'out-bank', name: 'Mortgage & bills', cls: 'series-4', values: rows.map(m => m.out.bank) },
      ];
      const toSavings = rows.map(m => (m.savings === null ? null : Math.max(0, m.savings)));
      if (toSavings.some(v => v > 0) || tl.dialsByKey.savings) cout.push({ key: 'out-savings', name: 'To savings', cls: 'series-3', values: toSavings });
      // Debt, business and investments: with the dial, and whenever a month shown had any (so the columns add up).
      const otherOut = rows.map(m => known(m.out.debt, m.out.business, m.out.invest));
      if (tl.dialsByKey.other || otherOut.some(v => v)) cout.push({ key: 'out-other', name: 'Debt, business, investing', cls: 'series-muted', values: otherOut });
      spec.columns = {
        in: cin, out: cout,
        notes: rows.map(m => {
          if (m.status === 'actual' && !m.complete) return 'Not every account’s export covers this month.';
          if (m.status === 'actual' && m.oneOffs.length) return 'Includes one-time: ' + m.oneOffs.map(o => o.merchant + ' ' + whole(o.cents)).join(', ') + '.';
          return '';
        }),
      };
      spec.net = { key: 'net', name: 'Net', values: rows.map(m => m.net) };
    }
    return spec;
  }

  function captionOf(tl, mode) {
    const parts = [];
    if (mode === 'balance' && tl.balances.mode === 'accounts' && tl.balances.accounts.length) parts.push('Combined cash = ' + tl.balances.accounts.map(a => a.name).join(' + ') + '.');
    if (tl.lastComplete) parts.push('Solid: your data through ' + fmt.month(tl.lastComplete) + '.');
    parts.push((mode === 'balance' ? 'Dashed' : 'Striped') + ': this plan from ' + fmt.month(tl.planStart) + '.');
    if (mode === 'balance' && tl.balances.mode === 'simple' && tl.balances.label) parts.push(tl.balances.label + '.');
    return parts.join(' ');
  }

  function chartCard(ctx, tl) {
    const mode = modeOf(tl);
    const controls = tl.balances.mode === 'none'
      ? `<a class="plan-prompt" id="plan-prompt" href="#plan-balances" data-action="plan:goto-balances">Enter today’s balances below to see where the money is heading</a>`
      : c.segmented({ label: 'Show', name: 'plan-mode', options: MODES, value: mode, action: 'plan:mode', hideLabel: true });
    const chart = UI.chart.cashChart(Object.assign(chartSpec(ctx, tl), { caption: captionOf(tl, mode), controls }));
    const ranges = `<div class="plan-ranges">
        ${c.segmented({ label: 'Past', name: 'plan-past', options: PAST, value: tl.settings.past, action: 'plan:past' })}
        ${c.segmented({ label: 'Ahead', name: 'plan-horizon', options: AHEAD, value: tl.settings.horizon, action: 'plan:horizon' })}
      </div>`;
    const b = tl.balances;
    const low = b.runsOut
      ? c.notice({ tone: 'warn', title: `On this plan the combined cash goes below $0 in ${fmt.monthLong(b.runsOut)}${b.lowest ? ` (lowest ${whole(b.lowest.cents)})` : ''}.` })
      : '';
    return `<section class="card plan-chart-card" id="plan-chart-card" aria-label="Plan chart">${chart}${ranges}${low}</section>`;
  }

  // ------------------------------------------------------------------ 2. balances
  function accountsOf(tl) {
    const b = tl.balances;
    const list = b.accounts.map(a => ({ id: a.id, name: a.name, group: a.group, anchor: a.anchor }))
      .concat(b.missing.map(m => ({ id: m.id, name: m.name, group: m.type === 'savings' ? 'savings' : 'checking', anchor: null })));
    const rank = a => (a.group === 'checking' ? 0 : 1);
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
  }

  function balanceField({ id, name, cents, date, datePath, account, source }) {
    return `<div class="plan-bal">
        <label class="plan-bal-name" for="${esc(id)}">${esc(name)}</label>
        <span class="input-money plan-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="Not entered" value="${esc(inputText(cents))}" data-action="plan:balance" data-commit="1" data-account="${esc(account)}" data-name="${esc(name)}" aria-describedby="${esc(id)}-src ${esc(id)}-error"></span>
        <label class="plan-bal-asof" for="${esc(id)}-date">as of</label>
        <input class="plan-date" id="${esc(id)}-date" type="date" value="${esc(date || '')}" data-bind="${esc(datePath)}" data-type="date" data-message="${esc(name + ': balance date saved.')}" aria-describedby="${esc(id)}-date-error">
        <p class="plan-bal-src fine" id="${esc(id)}-src">${source ? esc(source) : ''}</p>
        <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-date-error" role="alert" hidden></p>
      </div>`;
  }

  function balancesCard(ctx, tl) {
    const b = tl.balances;
    const bal = ctx.state.plan.balances || {};
    const entered = bal.accounts || {}, dates = bal.accountDates || {};
    const accounts = accountsOf(tl);
    let fields;
    if (accounts.length) {
      fields = accounts.map(a => {
        const cents = isCents(entered[a.id]) ? entered[a.id] : null;
        const date = dates[a.id] || (cents !== null ? bal.accountsAsOf : null) || '';
        const source = cents === null && a.anchor && a.anchor.source === 'bank' ? `From your export: ${exact(a.anchor.cents)} on ${fmt.date(a.anchor.date)}` : '';
        return balanceField({ id: 'plan-bal-' + a.id, name: a.name, cents, date, datePath: 'plan.balances.accountDates.' + a.id, account: a.id, source });
      }).join('');
    } else {
      fields = balanceField({ id: 'plan-bal-cash', name: 'Cash today', cents: isCents(bal.jointCashCents) ? bal.jointCashCents : null, date: bal.asOf || '', datePath: 'plan.balances.asOf', account: '', source: '' });
    }
    let total = '';
    const anchored = b.accounts.filter(a => a.anchor);
    if (b.mode === 'accounts' && anchored.length) {
      const sum = anchored.reduce((s, a) => s + a.anchor.cents, 0);
      const ds = anchored.map(a => a.anchor.date).sort();
      const when = ds[0] === ds[ds.length - 1] ? 'as of ' + fmt.date(ds[0]) : 'balances from ' + shortDate(ds[0]) + ' to ' + fmt.date(ds[ds.length - 1]);
      total = `<p class="plan-bal-total" id="plan-bal-total">Combined <strong>${esc(exact(sum))}</strong> ${esc(when)}</p>`;
    } else if (b.mode === 'simple' && b.combined && b.combined.anchor) {
      total = `<p class="plan-bal-total" id="plan-bal-total">Cash <strong>${esc(exact(b.combined.anchor.cents))}</strong> as of ${esc(fmt.date(b.combined.anchor.date))}</p>`;
    }
    const notes = b.notes.length ? `<p class="fine plan-bal-notes" id="plan-bal-notes">${esc(b.notes.join(' '))}</p>` : '';
    return `<section class="card plan-balances" id="plan-balances" aria-labelledby="plan-balances-h">
        <h2 class="plan-h" id="plan-balances-h">Balances</h2>
        <div class="plan-bal-list">${fields}${total}</div>${notes}
      </section>`;
  }

  // ------------------------------------------------------------------ 3. dials
  /** Slider range: a convenience around the baseline, widened for the value; never clamps it. */
  function rangeOf(d) {
    const base = isCents(d.baselineCents) ? d.baselineCents : 0;
    const value = isCents(d.planCents) ? d.planCents : 0;
    const big = Math.max(2 * Math.abs(base), 1000000, Math.abs(value));
    const unit = big > 2000000 ? 100000 : 50000;
    const hi = Math.ceil(big / unit) * unit;
    const lo = signedDial(d) ? 0 - hi : Math.min(0, Math.floor(Math.min(base, value) / STEP_CENTS) * STEP_CENTS);
    return { lo, hi };
  }

  function hintText(d) {
    const h = d.hint;
    if (!h || !h.count || !isCents(h.lastCents)) return '';
    return `Last deposit ${whole(h.lastCents)} on ${shortDate(h.lastDate)}` + (isCents(h.perMonthCents) && h.cadence ? `, ≈ ${whole(h.perMonthCents)}/mo (${h.cadence})` : '') + '.';
  }

  function dialHtml(ctx, tl, d) {
    const id = 'plan-dial-' + d.key;
    const label = dialLabel(d);
    const value = isCents(d.planCents) ? d.planCents : null;
    const { lo, hi } = rangeOf(d);
    const base = isCents(d.baselineCents) ? d.baselineCents : null;
    const frac = base === null ? null : Math.min(1, Math.max(0, (base - lo) / (hi - lo || 1)));
    const reset = d.source !== 'baseline' ? c.button('Reset', { action: 'plan:reset-dial', data: { dial: d.key }, cls: 'btn-small dial-reset', id: id + '-reset', ariaLabel: 'Reset ' + label + ' to its baseline' }) : '';
    const set = d.source === 'direct' ? ' · set by you' : d.source === 'rows' ? ' · from the list below' : '';
    const hint = d.group === 'in' ? hintText(d) : '';
    return `<div class="dial" data-dial="${esc(d.key)}" data-cents="${value === null ? '' : value}">
        <div class="dial-head">
          <label class="dial-label" for="${esc(id)}"><span class="key key-swatch ${esc(DIAL_CLS[d.key] || 'series-muted')}" aria-hidden="true"></span>${esc(label)}</label>
          <span class="input-money plan-amount dial-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="${signedDial(d) ? 'text' : 'decimal'}" autocomplete="off" spellcheck="false" value="${esc(inputText(value))}" placeholder="Unknown" data-action="plan:dial" data-commit="1" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-describedby="${esc(id)}-base ${esc(id)}-basis ${esc(id)}-error"></span>
        </div>
        <div class="dial-track"${frac === null ? '' : ` style="--f:${frac.toFixed(4)}"`}>
          ${frac === null ? '' : '<span class="dial-tick" aria-hidden="true"></span>'}
          <input class="dial-range" id="${esc(id)}-range" type="range" min="${lo / 100}" max="${hi / 100}" step="${STEP_CENTS / 100}" value="${(value || 0) / 100}" data-action="plan:dial-range" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-valuetext="${esc(amt(value || 0))} a month" aria-describedby="${esc(id)}-base">
        </div>
        <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
        <div class="dial-foot"><span class="dial-base" id="${esc(id)}-base">baseline ${esc(base === null ? 'unknown' : amt(base))}${esc(set)}</span>${reset}</div>
        <p class="dial-basis" id="${esc(id)}-basis">${esc(d.basis)}</p>
        ${hint ? `<p class="dial-hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}
        ${d.drill ? drillHtml(ctx, tl, d) : ''}
      </div>`;
  }

  // ---- drill-down (card, bank)
  function rowHtml(tl, r) {
    const id = 'plan-row-' + r.id;
    const name = r.label;
    const usual = r.stable && isCents(r.latestCents) ? `usually ${amt(r.latestCents)}` : `avg ${whole(r.avgCents)}/mo`;
    const seen = isCents(r.seenMonths) ? r.seenMonths : r.months;
    const of = isCents(r.ofMonths) ? r.ofMonths : tl.baseline.count;
    const edited = r.override ? ' ' + c.badge('edited', 'info') + ' ' + c.button('Reset', { action: 'plan:row-reset', data: { row: r.id, name }, cls: 'btn-small btn-ghost drill-reset', id: id + '-reset', ariaLabel: 'Reset ' + name + ' to its average' }) : '';
    return `<div class="drill-row level-${r.level}${r.included ? '' : ' is-out'}" data-row="${esc(r.id)}">
        <label class="drill-name" for="${esc(id)}-on"><input type="checkbox" id="${esc(id)}-on" data-action="plan:row-include" data-row="${esc(r.id)}" data-name="${esc(name)}"${r.included ? ' checked' : ''}><span>${esc(name)}</span></label>
        <span class="input-money drill-amt"><span aria-hidden="true">$</span><input id="${esc(id)}-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(inputText(r.planCents))}" data-action="plan:row-cents" data-commit="1" data-row="${esc(r.id)}" data-name="${esc(name)}" aria-label="${esc(name)}, dollars a month in the plan" aria-describedby="${esc(id)}-meta ${esc(id)}-error"></span>
        <p class="drill-meta" id="${esc(id)}-meta"><span>${esc(usual)} · ${esc(seen + ' of ' + of + ' mo')}</span>${edited}</p>
        <p class="field-error drill-error" id="${esc(id)}-error" role="alert" hidden></p>
      </div>`;
  }

  function oneTimeHtml(tl, d) {
    const out = tl.baseline.oneTime.filter(o => o.dialKey === d.key);
    const kept = (tl.baseline.keptIn || []).filter(o => o.dialKey === d.key);
    if (!out.length && !kept.length) return '';
    const item = (o, checked) => `<li><label class="drill-name" for="plan-onetime-${esc(o.id)}"><input type="checkbox" id="plan-onetime-${esc(o.id)}" data-action="plan:onetime" data-txn="${esc(o.id)}" data-name="${esc(o.merchant)}"${checked ? ' checked' : ''}><span>${esc(o.merchant)} · ${esc(fmt.date(o.date))} · ${esc(exact(o.cents))}${checked ? ' <small>counted in the plan</small>' : ''}</span></label></li>`;
    const sum = out.reduce((s, o) => s + o.cents, 0);
    const head = out.length ? `Left out as one-time (${out.length} · ${amt(sum)})` : 'Big purchases counted in the plan';
    return `<div class="drill-onetime" id="plan-onetime-${esc(d.key)}"><p class="drill-h">${esc(head)}</p>
        <ul class="drill-list">${out.map(o => item(o, false)).join('')}${kept.map(o => item(o, true)).join('')}</ul>
        <p class="fine">They still count in past months. Tick one to count it in the plan as well.</p></div>`;
  }

  function drillHtml(ctx, tl, d) {
    const drill = d.drill;
    const cats = drill.rows.filter(r => r.level === 1);
    const oneTime = oneTimeHtml(tl, d);
    if (!cats.length && !oneTime) return '';
    const notice = d.source === 'direct' && cats.length
      ? c.notice({ tone: 'info', title: `Dial set directly to ${amt(d.planCents)}; the rows add up to ${amt(drill.rowsCents)}.`, actions: c.button('Use the rows', { action: 'plan:use-rows', data: { dial: d.key }, cls: 'btn-small', id: 'plan-drill-' + d.key + '-use' }) })
      : '';
    const list = cats.map(cat => {
      const kids = drill.rows.filter(r => r.parent === cat.id);
      const only = kids.length === 1 && kids[0].kind === 'rest';
      const places = kids.filter(k => k.kind === 'merchant').length;
      const more = kids.some(k => k.kind === 'rest');
      const label = places ? `Show ${plural(places, 'place')}${more ? ' and everything else' : ''}` : 'Show everything in it';
      const sub = kids.length && !only
        ? `<details class="drill-kids" id="plan-drillrow-${esc(cat.id)}"><summary>${esc(label)}</summary><div class="drill-kids-body">${kids.map(k => rowHtml(tl, k)).join('')}</div></details>`
        : '';
      return `<li class="drill-cat">${rowHtml(tl, cat)}${sub}</li>`;
    }).join('');
    const summary = `What’s in this · ${plural(cats.length, 'category', 'categories')}${isCents(drill.rowsCents) ? ` · ${esc(amt(drill.rowsCents))}/mo` : ''}`;
    const body = `${notice}${oneTime}${cats.length ? `<ul class="drill-list">${list}</ul>` : ''}
      <p class="fine">Untick what you would stop paying for, or type a new amount: the dial follows the rows.</p>`;
    return c.disclosure(summary, body, { id: 'plan-drill-' + d.key, cls: 'plan-drill' });
  }

  // ---- who paid in: the baseline window's deposits and whose money each one is
  const PROVISIONAL = ['income', 'amount']; // matched by the pay in Budget or by amount, not the household's word

  /** Deposits into joint in the baseline months, newest first, with their automatic match. */
  function depositsOf(ctx, tl) {
    return ctx.memo('plan-deposits', () => {
      const txns = ctx.realTxns || ctx.txns;
      const rows = tl.baseline.months.length ? E.flows.breakdown(txns, ctx.dataset, { months: tl.baseline.months, coverageMap: ctx.coverageMap, plan: ctx.state.plan }) : [];
      const explain = E.balances.incomeAttribution(ctx.state.plan).explain;
      const byId = new Map(txns.map(t => [t.id, t]));
      return rows.flatMap(r => r.credits || [])
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1))
        .map(x => {
          const t = byId.get(x.id) || {};
          // What the match would be without the household's own choice (rules still count).
          const auto = explain(Object.assign({}, t, { personBasis: t.basePersonId ? 'rule' : null, personId: t.basePersonId || null }));
          const edited = x.basis === 'edit';
          return Object.assign({}, x, { auto, edited, provisional: PROVISIONAL.includes(x.basis), unassigned: !x.who && !edited });
        });
    });
  }

  function depositsHtml(ctx, tl) {
    const list = depositsOf(ctx, tl);
    if (!list.length) return '';
    const name = id => (tl.people.find(p => p.id === id) || {}).name || id;
    const provisional = list.filter(x => x.provisional && x.who);
    const open = list.filter(x => x.provisional || x.unassigned).length;
    const rows = list.map(x => {
      const sid = 'plan-dep-' + x.id;
      const autoLabel = x.edited ? 'Automatic match' : x.auto.who ? name(x.auto.who) + (x.auto.basis === 'rule' ? ' (rule)' : ' (suggested)') : 'Not assigned';
      const current = x.edited ? (x.who || 'none') : '';
      const opts = [['', autoLabel], ...tl.people.map(p => [p.id, p.name]), ['none', 'Neither']];
      const badge = x.provisional ? c.badge('provisional', 'neutral') : x.unassigned ? c.badge('not assigned', 'neutral') : '';
      return {
        what: `<span class="plan-dep-line"><strong>${esc(exact(x.cents))}</strong> ${esc(shortDate(x.date))}</span><small>${esc(x.description)}${x.accountLabel ? ' · ' + esc(x.accountLabel) : ''}</small>`,
        who: `<span class="plan-dep-who"><label class="sr-only" for="${esc(sid)}">Whose money is ${esc(x.description)} on ${esc(fmt.date(x.date))}</label><select id="${esc(sid)}" data-action="plan:person" data-txn="${esc(x.id)}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${badge}</span>`,
      };
    });
    const table = c.table({
      caption: 'Deposits into joint and whose money they are', cls: 'plan-dep-table',
      columns: [{ key: 'what', label: 'Deposit', html: r => r.what }, { key: 'who', label: 'Whose', html: r => r.who }],
      rows,
    });
    const range = tl.baseline.start === tl.baseline.end ? fmt.month(tl.baseline.start) : fmt.month(tl.baseline.start) + '–' + fmt.month(tl.baseline.end);
    const confirm = provisional.length ? c.button(`Confirm all ${provisional.length} provisional match${provisional.length === 1 ? '' : 'es'}`, { action: 'plan:confirm-deposits', id: 'plan-dep-confirm', cls: 'btn-small' }) : '';
    const summary = 'Who paid in' + (open ? ` · ${plural(open, 'deposit')} to confirm` : '');
    const body = `<p class="fine">Deposits into joint, ${esc(range)}. Suggested matches come from the pay in Budget or the amount: the bank’s words don’t name the person. Changing one moves it between the dials above; the bank’s description is kept.</p>${confirm}${table}`;
    return c.disclosure(esc(summary), body, { id: 'plan-deposits', cls: 'plan-deposits' });
  }

  /** Dial values in effect: the plan's, with any slider being dragged (not saved yet). */
  function valuesOf(tl, overrides = {}) {
    const out = {};
    for (const d of tl.dials) out[d.key] = Object.prototype.hasOwnProperty.call(overrides, d.key) ? overrides[d.key] : d.planCents;
    return out;
  }

  /** "Each month on this plan: $6,768 in − $2,222.02 cards − … = +$2,296.31 left in checking" (html and plain text). */
  function sumOf(tl, vals) {
    const ins = tl.groups.in.map(k => vals[k]);
    const keys = tl.groups.out.filter(k => k !== 'savings');
    if (ins.concat(keys.map(k => vals[k]), [vals.savings]).some(v => v === null || v === undefined)) {
      const text = 'Each month on this plan: not known yet (no complete month to start from).';
      return { html: esc(text), text };
    }
    const inTotal = ins.reduce((s, v) => s + v, 0);
    const terms = [[1, inTotal, 'in']];
    for (const k of keys) terms.push([-1, vals[k], SUM_NAME[k] || k]);
    if (tl.dialsByKey.savings) terms.push(vals.savings >= 0 ? [-1, vals.savings, 'to savings'] : [1, 0 - vals.savings, 'from savings']);
    const net = terms.reduce((s, [sign, v]) => s + sign * v, 0);
    const words = terms.map(([sign, v, name], i) => {
      const op = (sign < 0) !== (v < 0) ? '−' : '+';
      const text = amt(Math.abs(v)) + ' ' + name;
      return i === 0 ? (v < 0 ? '−' : '') + text : op + ' ' + text;
    });
    const result = signedAmt(net) + ' left in checking';
    return {
      html: `Each month on this plan: <span class="plan-sum-terms">${esc(words.join(' '))}</span> = <strong class="${net < 0 ? 'tone-bad' : ''}">${esc(signedAmt(net))}</strong> left in checking`,
      text: 'Each month on this plan: ' + words.join(' ') + ' = ' + result + '.',
      net,
    };
  }

  function dialsCard(ctx, tl) {
    const group = keys => keys.map(k => dialHtml(ctx, tl, tl.dialsByKey[k])).join('');
    const reset = tl.changed ? c.button('Reset all to baseline', { action: 'plan:reset', id: 'plan-reset', cls: 'btn-small' }) : '';
    return `<section class="card plan-dials" id="plan-dials" aria-label="Plan dials">
        <div class="plan-groups">
          <div class="plan-group" role="group" aria-labelledby="plan-g-in"><h2 class="plan-h" id="plan-g-in">Money in</h2>${group(tl.groups.in)}${depositsHtml(ctx, tl)}</div>
          <div class="plan-group" role="group" aria-labelledby="plan-g-out"><h2 class="plan-h" id="plan-g-out">Money out</h2>${group(tl.groups.out)}</div>
        </div>
        <div class="plan-sum-row"><p class="plan-sum" id="plan-sum">${sumOf(tl, valuesOf(tl)).html}</p>${reset}</div>
      </section>`;
  }

  // ------------------------------------------------------------------ 4. more options
  function moreHtml(ctx, tl) {
    const body = `${c.segmented({ label: 'Baseline: complete months to average', name: 'plan-baseline', options: BASELINES, value: tl.baseline.setting, action: 'plan:baseline' })}
      <p class="fine" id="plan-baseline-label">${esc(tl.baseline.label)}. One-time purchases are left out and yearly bills spread over 12 months.</p>
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
        ${moreHtml(ctx, tl)}
        <p class="sr-only" id="plan-live" aria-live="polite"></p>
        ${sample}
      </div></div>`;
  }

  // ------------------------------------------------------------------ behaviour
  function showError(el, message) {
    const box = el && document.getElementById(el.id + '-error');
    if (!el) return;
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (box) { box.textContent = message || ''; box.hidden = !message; }
  }

  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#plan-root');
    if (!rootEl) return;
    const tl = model(ctx);
    // A slider being dragged: its box, its spoken value and the monthly sum follow at once.
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
        const list = ev.detail && Array.isArray(ev.detail.hidden) ? ev.detail.hidden.slice(0, E.state.LIMITS.planHidden || 40) : [];
        try {
          ctx.app.update(st => E.state.setPath(st, 'ui.plan.hidden', list), { undoable: false, rerender: false });
        } catch (err) { console.warn('Chart series choice not saved:', err.message); }
      });
    }
    if (announceNext) {
      announceNext = false;
      const live = rootEl.querySelector('#plan-live');
      const text = sumOf(tl, valuesOf(tl)).text;
      if (live) setTimeout(() => { live.textContent = text; }, 120);
    }
  }

  /** A plan change: undoable, with a message, and the new monthly sum announced after the render. */
  function change(ctx, fn, message) {
    announceNext = true;
    const done = ctx.app.update(fn, { message });
    if (!done) announceNext = false;
    return done;
  }
  const setView = (ctx, key, value) => {
    const cur = ctx.state.ui.plan ? ctx.state.ui.plan[key] : undefined;
    if (cur === value) return;
    ctx.app.update(st => E.state.setPath(st, 'ui.plan.' + key, value), { undoable: false });
  };

  function dialCommit(ctx, key, cents) {
    const d = model(ctx).dialsByKey[key];
    if (!d || cents === d.planCents) return;
    change(ctx, st => E.timeline.setDial(st, key, cents), `${dialLabel(d)} set to ${amt(cents)}.`);
  }

  const actions = {
    'plan:mode': (ctx, el) => setView(ctx, 'mode', el.dataset.value === 'flows' ? 'flows' : 'balance'),
    'plan:past': (ctx, el) => setView(ctx, 'past', choice(el.dataset.value)),
    'plan:horizon': (ctx, el) => setView(ctx, 'horizon', choice(el.dataset.value)),
    'plan:baseline': (ctx, el) => {
      const v = choice(el.dataset.value);
      if (ctx.state.ui.plan && ctx.state.ui.plan.baselineMonths === v) return;
      change(ctx, st => E.state.setPath(st, 'ui.plan.baselineMonths', v), v === 'all' ? 'Baselines now average every complete month.' : `Baselines now average the last ${v} complete months.`);
    },
    'plan:cover': (ctx, el) => change(ctx, st => E.state.setPath(st, 'ui.plan.coverFromSavings', !!el.checked),
      el.checked ? 'Checking shortfalls in plan months now come from savings.' : 'Checking shortfalls in plan months are no longer moved from savings.'),
    'plan:goto-balances': ctx => {
      const first = document.querySelector('#plan-balances input[type="text"]');
      const card = document.getElementById('plan-balances');
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (first) first.focus({ preventScroll: true });
    },
    'plan:reset': ctx => change(ctx, st => E.timeline.resetPlan(st), 'Every dial is back to its baseline.'),
    'plan:reset-dial': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d) return;
      change(ctx, st => E.timeline.resetDial(st, d.key), `${dialLabel(d)} is back to its baseline (${amt(d.baselineCents)}).`);
    },
    'plan:use-rows': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d) return;
      change(ctx, st => E.timeline.setDial(st, d.key, null), `${dialLabel(d)} now follows its rows (${amt(d.drill ? d.drill.rowsCents : d.baselineCents)}).`);
    },
    'plan:dial': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d) return;
      const raw = typed(el.value);
      if (raw === '') {
        showError(el, null);
        if (d.source !== 'direct') { el.value = inputText(d.planCents); return; }
        change(ctx, st => E.timeline.setDial(st, d.key, null), `${dialLabel(d)} is back to ${d.drill && d.drill.overridden ? 'its rows' : 'its baseline'}.`);
        return;
      }
      let cents;
      try {
        cents = E.money.inputToCents(raw, { allowNegative: signedDial(d), field: d.key });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 125 or 125.50.');
        return;
      }
      showError(el, null);
      dialCommit(ctx, d.key, cents);
    },
    'plan:dial-range': (ctx, el) => dialCommit(ctx, el.dataset.dial, Math.round(Number(el.value) * 100)),
    'plan:row-include': (ctx, el) => {
      const on = !!el.checked;
      change(ctx, st => E.timeline.setRow(st, el.dataset.row, { included: on }), on ? `${el.dataset.name} counted in the plan again.` : `${el.dataset.name} left out of the plan.`);
    },
    'plan:row-cents': (ctx, el) => {
      const id = el.dataset.row;
      const cur = ((ctx.state.ui.plan || {}).rows || {})[id];
      const raw = typed(el.value);
      if (raw === '') {
        showError(el, null);
        if (!cur || cur.cents === undefined) return;
        change(ctx, st => E.timeline.setRow(st, id, { cents: null }), `${el.dataset.name} is back to its average.`);
        return;
      }
      let cents;
      try {
        cents = E.money.inputToCents(raw, { allowNegative: true, field: 'row' });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 125 or 125.50.');
        return;
      }
      showError(el, null);
      const row = (model(ctx).dialsByKey[id.split('-')[0]] || { drill: { rows: [] } }).drill.rows.find(r => r.id === id);
      if (row && row.planCents === cents) return;
      change(ctx, st => E.timeline.setRow(st, id, { cents }), `${el.dataset.name} set to ${amt(cents)} a month.`);
    },
    'plan:row-reset': (ctx, el) => change(ctx, st => E.timeline.setRow(st, el.dataset.row, { included: null, cents: null }), `${el.dataset.name} is back to its average.`),
    'plan:onetime': (ctx, el) => {
      announceNext = true;
      const on = !!el.checked;
      UI.shared.editLedger(ctx.app, el.dataset.txn, 'planningBaseline', on ? 'include' : 'exclude',
        on ? 'Counted in the plan on the Plan page' : 'Left out of the plan as one-time on the Plan page',
        { message: on ? 'Counted in the plan again.' : `${el.dataset.name} left out of the plan as one-time. It still counts in past months.` });
    },
    'plan:person': (ctx, el) => {
      const value = el.value === '' ? null : el.value;
      const tl = model(ctx);
      const x = depositsOf(ctx, tl).find(d => d.id === el.dataset.txn);
      const who = value === null ? 'back to the automatic match' : value === 'none' ? 'neither of you' : ((tl.people.find(p => p.id === value) || {}).name || value) + '’s';
      announceNext = true;
      UI.shared.editLedger(ctx.app, el.dataset.txn, 'person', value, 'Set on the Plan page',
        { message: `Deposit${x ? ' of ' + exact(x.cents) + ' on ' + fmt.date(x.date) : ''}: ${who}. The bank’s description is kept.` });
    },
    'plan:confirm-deposits': ctx => {
      const list = depositsOf(ctx, model(ctx)).filter(x => x.provisional && x.who);
      if (!list.length) return;
      announceNext = true;
      UI.shared.editMany(ctx.app, list.map(x => ({ txnId: x.id, field: 'person', value: x.who, reason: 'Confirmed on the Plan page' })),
        { message: `${plural(list.length, 'deposit')} confirmed as suggested.` });
    },
    'plan:balance': (ctx, el) => {
      const account = el.dataset.account || '';
      const name = el.dataset.name || 'Cash';
      let cents;
      try {
        cents = E.money.inputToCents(typed(el.value), { allowNegative: true, field: 'balance' });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 2,500 or 2,500.75.');
        return;
      }
      showError(el, null);
      const bal = ctx.state.plan.balances || {};
      const dateEl = document.getElementById(el.id + '-date');
      const date = dateEl && E.dates.isDate(dateEl.value) ? dateEl.value : todayIso();
      const first = model(ctx).balances.mode === 'none' && cents !== null;
      const current = account ? (bal.accounts || {})[account] : bal.jointCashCents;
      if ((current ?? null) === cents) return;
      const message = cents === null ? `${name}: balance removed.` : `${name}: balance ${exact(cents)} as of ${fmt.date(date)}.`;
      change(ctx, st => {
        let next;
        if (account) {
          next = E.state.setPath(st, 'plan.balances.accounts.' + account, cents === null ? undefined : cents);
          next = E.state.setPath(next, 'plan.balances.accountDates.' + account, cents === null ? undefined : date);
        } else {
          next = E.state.setPath(st, 'plan.balances.jointCashCents', cents);
          next = E.state.setPath(next, 'plan.balances.asOf', cents === null ? null : date);
        }
        if (first) next = E.state.setPath(next, 'ui.plan.mode', 'balance');
        return next;
      }, message);
    },
  };

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Plan', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
