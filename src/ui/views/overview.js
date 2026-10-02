'use strict';
/*
 * Home: the joint plan in four amounts, and what they leave.
 *   1. What goes into joint: each partner's contribution (from their current pay in Budget)
 *   2. Card spending: purchases minus refunds (paying the card from checking is not counted again)
 *   3. Bills and the mortgage paid straight from the bank
 *   4. Net to savings: adding to it, or drawing it down
 *   → the plan remainder after those allocations, and where the joint balances head.
 * Every amount says where it comes from (current plan, the household's own setting, or the
 * average of named months). The detail (how the plan adds up, the baseline and one-time expenses, who paid
 * in, savings in and out) is folded away further down.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const HORIZONS = [{ value: 12, label: '1 year' }, { value: 24, label: '2 years' }, { value: 60, label: '5 years' }];
  const WINDOWS = [{ value: 3, label: '3 months' }, { value: 6, label: '6 months' }, { value: 12, label: '12 months' }];
  const HISTORY_MONTHS = 24;
  const PERSON_CLS = { p1: 'series-1', p2: 'series-2' };
  /** The plan amounts Home can set (null = baseline). Reset clears exactly these. */
  const AMOUNT_KEYS = ['inCents', 'p1InCents', 'p2InCents', 'cardCents', 'bankCents', 'savedCents'];
  const DEFAULTS = { baselineMonths: 12, fundingWho: 'both', chartView: 'money', horizon: 24 };
  const VIEWS = [{ value: 'money', label: 'Money each month' }, { value: 'balances', label: 'Balances' }];

  const whole = cents => fmt.money(cents, { whole: true });
  const signed = cents => fmt.money(cents, { whole: true, signed: true });
  const exact = cents => fmt.money(cents);
  const isCents = v => Number.isSafeInteger(v);
  /** Amount for an exact-entry box: cents kept, thousands separated, an ASCII minus. */
  const inputText = cents => {
    if (!isCents(cents)) return '';
    const abs = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(abs / 100).toLocaleString('en-US') + (abs % 100 ? '.' + String(abs % 100).padStart(2, '0') : '');
  };
  const yearsText = months => (months % 12 === 0 ? (months / 12 === 1 ? '1 year' : months / 12 + ' years') : months + ' months');
  const homeOf = ctx => Object.assign({}, DEFAULTS, ctx.state.ui.home || {});
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  function rangeText(start, end) {
    if (!start) return 'no complete months';
    if (start === end) return fmt.month(start);
    const a = fmt.month(start), b = fmt.month(end);
    return start.slice(0, 4) === end.slice(0, 4) ? a.replace(/ \d{4}$/, '') + '–' + b : a + '–' + b;
  }

  // ------------------------------------------------------------------ model
  /** Everything Home needs, worked out once per data/state change. */
  function model(ctx) {
    return ctx.memo('home-model', () => {
      const txns = ctx.realTxns || ctx.txns;
      const plan = ctx.state.plan;
      const home = homeOf(ctx);
      const bal = plan.balances || {};
      // Balances entered without a date are taken as of the last day of the data.
      const asOf = bal.accountsAsOf || (ctx.months.length ? E.months.end(ctx.months[ctx.months.length - 1]) : null);
      const hist = E.balances.history(txns, ctx.dataset, { entered: bal.accounts || {}, asOf, months: ctx.months });
      const rows = E.flows.breakdown(txns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, plan });
      const base = E.flows.baseline(rows, { count: home.baselineMonths });
      const planMonth = ctx.forecastStart;
      const funding = E.flows.planFunding(plan, { month: planMonth, timing: plan.settings && plan.settings.incomeTiming });
      const people = (plan.people || []).filter(p => p && (p.id === 'p1' || p.id === 'p2'));
      const attributed = rows.some(r => r.actual && (r.actual.p1 || r.actual.p2));
      const split = people.length > 0 && (attributed || people.some(p => funding.people[p.id] && funding.people[p.id].jointCents !== null));
      // A balance can't go below $0, so the projection stops there once balances are real.
      const realChecking = hist.groups.checking.kind === 'balance';
      const limits = { checking: realChecking, savings: hist.groups.savings.kind === 'balance' || (hist.groups.savings.kind === 'none' && realChecking) };
      // Balances are projected only when they are known: a projected "change" can go below $0,
      // which a real balance can't, so it would mislead.
      const canProject = hist.total.kind === 'balance';
      return { hist, rows, base, funding, planMonth, people, split, limits, canProject, byId: new Map(txns.map(t => [t.id, t])) };
    });
  }

  function scenarioOf(ctx, m, overrides = {}) {
    const home = Object.assign({}, homeOf(ctx), overrides);
    return E.flows.scenario({ base: m.base, funding: m.funding, home, people: m.split ? m.people.map(p => p.id) : [] });
  }
  const baselineScenario = (ctx, m) => scenarioOf(ctx, m, Object.fromEntries(AMOUNT_KEYS.map(k => [k, null])));
  const hasSavings = m => m.hist.groups.savings.kind !== 'none';
  const oneTimeOf = (m, role) => m.base.oneTime.filter(o => !role || o.role === role);

  // ------------------------------------------------------------------ the four amounts
  function tile({ id, label, value, sub, tone = '' }) {
    return `<div class="metric home-tile" id="${esc(id)}"><span class="metric-label">${esc(label)}</span><span class="metric-value${tone ? ' tone-' + esc(tone) : ''}">${esc(value)}</span><span class="metric-sub">${sub}</span></div>`;
  }

  function basisOf(line, baseText) {
    return line.changed ? `<span class="home-basis is-set">Your setting</span> · baseline ${esc(whole(line.baseline))}` : `<span class="home-basis">${baseText}</span>`;
  }

  function planHtml(ctx, m, sc) {
    const range = rangeText(m.base.start, m.base.end);
    const avgText = `Average of ${esc(range)}`;
    const L = sc.lines;
    const perPerson = sc.persons.map(p => `${esc(p.name)} ${esc(whole(p.value))}${p.changed ? ' <span class="home-basis is-set">your setting</span>' : p.basis === 'plan' ? '' : ` <span class="home-basis">${esc(range)} average</span>`}`).join(' · ');
    const fundingBasis = sc.persons.length
      ? `${perPerson}<br>${sc.persons.every(p => !p.changed && p.basis === 'plan') ? '<span class="home-basis">Current plan: pay in Budget, joint part only</span>' : sc.persons.some(p => p.basis === 'plan') ? '<span class="home-basis">Budget pay, joint part only, unless set here</span>' : ''}`
      : basisOf(L.funding, avgText + ' (all money in: nobody’s deposits can be told apart)');
    const offText = role => {
      const list = oneTimeOf(m, role);
      return list.length ? `, ${plural(list.length, 'one-time expense')} left out (${esc(list.slice(0, 2).map(o => o.merchant + ' ' + whole(o.cents)).join(', '))}${list.length > 2 ? '…' : ''})` : '';
    };
    const cardSub = basisOf(L.card, `${avgText}${offText('card')}`) + '<br>Purchases minus refunds; card payments from checking not counted again';
    const bankSub = basisOf(L.bank, `${avgText}${offText('bank')}`) + '<br>Paid straight from checking, mortgage included';
    const sv = L.savings.value;
    const savingsSub = basisOf(L.savings, avgText + ' of net transfers') + `<br>${sv > 0 ? 'Adding to savings' : sv < 0 ? 'Drawing savings down: it does not prove the cash is there' : 'No change to savings'}`;
    const tiles = [
      tile({ id: 'home-tile-funding', label: 'Into joint each month', value: whole(L.funding.value), sub: fundingBasis }),
      tile({ id: 'home-tile-card', label: 'Card spending', value: whole(L.card.value), sub: cardSub }),
      tile({ id: 'home-tile-bank', label: 'Bills & mortgage from the bank', value: whole(L.bank.value), sub: bankSub }),
      tile({ id: 'home-tile-savings', label: sv < 0 ? 'Drawn from savings' : 'Net to savings', value: signed(sv), sub: savingsSub, tone: sv < 0 ? 'warn' : '' }),
    ].join('');
    const terms = [`${esc(whole(L.funding.value))} into joint`];
    if (L.otherIn.value) terms.push(`+ ${esc(whole(L.otherIn.value))} other planned income`);
    terms.push(`− ${esc(whole(L.card.value))} cards`, `− ${esc(whole(L.bank.value))} bank-paid`);
    if (L.debt.value) terms.push(`− ${esc(whole(L.debt.value))} debt payments`);
    if (L.business.value) terms.push(`− ${esc(whole(L.business.value))} business purchases`);
    terms.push(sv < 0 ? `+ ${esc(whole(0 - sv))} drawn from savings` : `− ${esc(whole(sv))} to savings`);
    if (L.invest.value) terms.push(`${L.invest.value < 0 ? '+' : '−'} ${esc(whole(Math.abs(L.invest.value)))} investments`);
    const r = sc.remainder;
    const remainder = `<div class="home-remainder" id="home-remainder">
        <p class="home-remainder-label">Plan remainder after allocations</p>
        <p class="home-remainder-value ${r < 0 ? 'tone-bad' : ''}"><strong>${esc(signed(r))}</strong> a month${r < 0 ? ` <span class="home-remainder-note">The plan is short by ${esc(whole(0 - r))} a month.</span>` : ''}</p>
        <p class="home-remainder-sum">${terms.join(' ')} = ${esc(signed(r))}</p>
        <p class="fine">Worked out from the amounts above. It is not cash in the bank, and not a safe-to-spend amount: today’s balances, card balances and payment timing are not part of it.${sc.changed ? ` Baseline plan: ${esc(signed(sc.baselineRemainder))} a month.` : ''}</p>
      </div>`;
    return `<div class="metrics home-tiles">${tiles}</div>${remainder}`;
  }

  // ------------------------------------------------------------------ controls
  function controlsOf(ctx, m, sc) {
    const range = rangeText(m.base.start, m.base.end);
    const list = [];
    if (sc.persons.length) {
      for (const p of sc.persons) {
        const fp = m.funding.people[p.id];
        const pay = fp ? fp.streams.find(s => s.kind === 'paycheck' && !s.viaTransfers) : null;
        const net = pay && isCents(pay.monthly.net) ? pay.monthly.net : null;
        list.push({
          key: p.id + 'InCents', id: 'home-in-' + p.id, group: 'in', label: p.name + ' → joint', value: p.value, baseline: p.baseline, changed: p.changed,
          baseText: p.basis === 'plan' ? 'from Budget pay' : `${range} average`, cls: PERSON_CLS[p.id], netMonthly: net, person: p,
          help: `What ${esc(p.name)} moves from their own pay or account into joint each month.`,
        });
      }
    } else {
      list.push({ key: 'inCents', id: 'home-in', group: 'in', label: 'Money into joint', value: sc.lines.funding.value, baseline: sc.lines.funding.baseline, changed: sc.lines.funding.changed, baseText: `${range} average`, help: 'Pay and transfers into your joint accounts each month.' });
    }
    const L = sc.lines;
    const off = oneTimeOf(m, 'card').length;
    list.push({ key: 'cardCents', id: 'home-card', group: 'out', primary: true, label: 'Monthly card spending', value: L.card.value, baseline: L.card.baseline, changed: L.card.changed,
      baseText: `${range} average${off ? ', one-time expenses left out' : ''}`,
      help: 'Purchases minus refunds on the household cards. Paying the card from checking is not counted again: those purchases are already in here. Planned spending can’t go below $0.' });
    list.push({ key: 'savedCents', id: 'home-saved', group: 'out', signed: true, label: 'Net to savings', value: L.savings.value, baseline: L.savings.baseline, changed: L.savings.changed,
      baseText: `${range} average`, help: 'Into savings minus out of savings each month. Below $0 means drawing savings down.' });
    list.push({ key: 'bankCents', id: 'home-bank', group: 'more', label: 'Bills & mortgage from the bank', value: L.bank.value, baseline: L.bank.baseline, changed: L.bank.changed,
      baseText: `${range} average`, help: 'Everything paid straight from checking: the mortgage, utilities, insurance and other bills. Card spending is set separately.' });
    return list;
  }

  function sliderRange(k) {
    const step = 50000;
    const top = Math.max(Math.abs(k.baseline) * 2, Math.abs(k.value) * 1.25, k.netMonthly || 0, 100000);
    const hi = Math.ceil(top / step) * step;
    const lo = k.signed ? 0 - hi : Math.min(0, Math.floor(k.value / step) * step);
    return { lo, hi };
  }

  function keptText(k, cents) {
    if (k.netMonthly === null || k.netMonthly === undefined) return '';
    const kept = k.netMonthly - cents;
    return kept >= 0
      ? `Of ${esc(whole(k.netMonthly))} take-home a month, ${esc(whole(kept))} stays in ${esc(k.person.name)}’s own account.`
      : `<span class="tone-bad">That is ${esc(whole(0 - kept))} more than ${esc(k.person.name)}’s take-home of ${esc(whole(k.netMonthly))} a month.</span>`;
  }

  function controlHtml(k) {
    const { lo, hi } = sliderRange(k);
    const reset = k.changed ? c.button(`Use baseline (${exact(k.baseline)})`, { action: 'home:reset-one', data: { key: k.key }, cls: 'btn-small home-reset-one', id: k.id + '-reset' }) : '';
    return `<div class="home-control${k.primary ? ' is-primary' : ''}${k.cls ? ' ' + esc(k.cls) : ''}" data-control="${esc(k.key)}" data-cents="${k.value}">
        <div class="home-control-head"><label for="${esc(k.id)}">${k.cls ? `<span class="key key-swatch ${esc(k.cls)}" aria-hidden="true"></span>` : ''}${esc(k.label)}</label>
          <span class="input-money home-amount"><span aria-hidden="true">$</span><input id="${esc(k.id)}-amount" type="text" inputmode="${k.signed ? 'text' : 'decimal'}" autocomplete="off" data-home-text="${esc(k.key)}"${k.signed ? ' data-signed="1"' : ''} value="${esc(inputText(k.value))}" aria-label="${esc(k.label)}, dollars a month" aria-describedby="${esc(k.id)}-help ${esc(k.id)}-error"></span></div>
        <input id="${esc(k.id)}" type="range" min="${lo / 100}" max="${hi / 100}" step="25" value="${k.value / 100}" data-home="${esc(k.key)}" aria-describedby="${esc(k.id)}-help" aria-valuetext="${esc(signedIf(k, k.value))} a month">
        <p class="field-error" id="${esc(k.id)}-error" role="alert" hidden></p>
        <p class="field-help" id="${esc(k.id)}-help">${k.help} <span class="home-kept" id="${esc(k.id)}-kept">${keptText(k, k.value)}</span> Baseline ${esc(exact(k.baseline))} (${esc(k.baseText)}).</p>
        ${reset}
      </div>`;
  }
  const signedIf = (k, cents) => (k.signed ? signed(cents) : whole(cents));

  function controlsCard(ctx, m, sc) {
    const list = controlsOf(ctx, m, sc);
    const group = g => list.filter(k => k.group === g).map(controlHtml).join('');
    const moreOpen = list.some(k => k.group === 'more' && k.changed);
    const home = homeOf(ctx);
    const legacy = isCents(home.outCents)
      ? c.notice({ tone: 'info', title: `An earlier “spending” setting of ${whole(home.outCents)} a month is saved but no longer used.`, body: 'Card spending and bank-paid bills are set separately now.', actions: c.button('Remove the old setting', { action: 'home:clear-legacy', cls: 'btn-small', id: 'home-clear-legacy' }) })
      : '';
    const body = `${legacy}<div class="home-groups">
        <div class="home-group" role="group" aria-labelledby="home-g-in"><h3 class="home-group-h" id="home-g-in">Money into joint</h3>${group('in')}</div>
        <div class="home-group" role="group" aria-labelledby="home-g-out"><h3 class="home-group-h" id="home-g-out">Money out of joint</h3>${group('out')}
          ${c.disclosure(`Bills & mortgage from the bank: <strong id="home-bank-summary">${esc(whole(sc.lines.bank.value))}</strong> a month`, group('more'), { cls: 'home-more-controls', id: 'home-more-controls', open: moreOpen })}</div>
      </div>
      <div class="home-control-actions">${c.button('Reset plan to baseline', { action: 'home:reset', id: 'home-reset', cls: 'btn-small', disabled: !sc.changed })}
        <p class="fine" id="home-reset-help">Reset puts every amount on this page back to its baseline: each partner’s pay in Budget and the averages of ${esc(rangeText(m.base.start, m.base.end))}. Transactions, Budget and one-time choices stay as they are.</p></div>`;
    return c.card(body, { title: 'Change the plan', subtitle: 'Everything on this page updates as you move these. Your transactions and Budget are not changed.', id: 'home-controls-card' });
  }

  // ------------------------------------------------------------------ where this leads
  function projectionOf(m, sc, months) {
    const latest = m.hist.latest;
    return E.balances.project({
      startMonth: E.months.add(latest.month, 1), months,
      start: { checking: latest.checking, savings: hasSavings(m) ? latest.savings : 0 },
      inCents: sc.inCents, outCents: sc.outCents, savedCents: sc.savedCents, limits: m.limits,
    });
  }

  /** The main chart: money each month (who paid in, spending, savings) or balances. */
  function chartHtml(ctx, m, sc, base, horizon) {
    return homeOf(ctx).chartView === 'balances' ? balanceChartHtml(ctx, m, sc, base, horizon) : moneyChartHtml(ctx, m, sc, horizon);
  }

  function moneyChartHtml(ctx, m, sc, horizon) {
    const shown = m.rows.slice(-HISTORY_MONTHS);
    const first = shown.findIndex(r => r.actual);
    const past = first === -1 ? [] : shown.slice(first);
    const ahead = Math.min(horizon, 24);
    const future = Array.from({ length: ahead }, (_, i) => E.months.add(m.planMonth, i));
    const flat = v => future.map(() => v);
    const pastOf = f => past.map(r => (r.actual ? f(r.actual) : null));
    const series = [];
    if (sc.persons.length) for (const p of sc.persons) series.push({ name: p.name + ' → joint', values: pastOf(a => a[p.id]).concat(flat(p.value)), cls: PERSON_CLS[p.id] });
    else series.push({ name: 'Into joint', values: pastOf(a => a.moneyIn).concat(flat(sc.lines.funding.value)), cls: 'series-1' });
    series.push({ name: 'Spending (cards + bank)', values: pastOf(a => a.consumption).concat(flat(sc.lines.card.value + sc.lines.bank.value)), cls: 'series-4' });
    series.push({ name: 'Net to savings', values: pastOf(a => a.savingsNet).concat(flat(sc.lines.savings.value)), cls: 'series-3' });
    const full = past.filter(r => r.actual);
    const range = full.length ? rangeText(full[0].month, full[full.length - 1].month) : '';
    const tot = k => full.reduce((s, r) => s + r.actual[k], 0);
    const who = sc.persons.length
      ? `${esc(range)} (${esc(plural(full.length, 'complete month'))}), actual into joint: ${sc.persons.map(p => `${esc(p.name)} <strong>${esc(whole(tot(p.id)))}</strong>`).join(' · ')}${sc.persons.length > 1 ? ` · together ${esc(whole(sc.persons.reduce((s, p) => s + tot(p.id), 0)))}` : ''}. Plan from ${esc(fmt.month(m.planMonth))}: ${sc.persons.map(p => `${esc(p.name)} ${esc(whole(p.value))}`).join(' · ')} a month.`
      : '';
    return c.lineChart({
      id: 'home-chart',
      title: `Money each month: actual ${range ? range + ' ' : ''}and the plan for the next ${yearsText(ahead)}`,
      series, labels: past.map(r => r.month).concat(future), projectFrom: past.length || null, nowLabel: 'Plan',
      tableCaption: 'Money into joint, spending and net savings per month',
      description: `${who ? who + '<br>' : ''}Past months show what happened, one-time expenses included. The dashed plan repeats every month and leaves them out.`,
    });
  }

  function balanceChartHtml(ctx, m, sc, base, horizon) {
    const h = m.hist;
    if (!m.canProject) {
      const end = h.latest.index, from = Math.max(0, end - HISTORY_MONTHS + 1);
      const change = kind => (kind === 'change' ? ' (change)' : '');
      const series = [{ name: 'Checking' + change(h.groups.checking.kind), values: h.groups.checking.values.slice(from, end + 1), cls: 'series-2' }];
      if (hasSavings(m)) series.push({ name: 'Savings' + change(h.groups.savings.kind), values: h.groups.savings.values.slice(from, end + 1), cls: 'series-3' });
      return c.lineChart({
        id: 'home-chart', title: 'Joint accounts, past months only (today’s balances not known)',
        series, labels: h.months.slice(from, end + 1), tableCaption: 'Accounts at the end of each month',
        description: '“Change” lines show how much an account went up or down since your first month of data, not what it holds.',
      });
    }
    const end = h.latest.index;
    const from = Math.max(0, end - HISTORY_MONTHS + 1);
    const pastMonths = h.months.slice(from, end + 1);
    const plan = projectionOf(m, sc, horizon);
    const labels = pastMonths.concat(plan.rows.map(r => r.month));
    const past = vals => vals.slice(from, end + 1);
    const none = pastMonths.map(() => null);
    const change = kind => (kind === 'change' ? ' (change)' : '');
    const series = [
      { name: 'Total' + change(h.total.kind), values: past(h.total.values).concat(plan.rows.map(r => r.total)), cls: 'series-1' },
      { name: 'Checking' + change(h.groups.checking.kind), values: past(h.groups.checking.values).concat(plan.rows.map(r => r.checking)), cls: 'series-2' },
    ];
    if (hasSavings(m)) series.push({ name: 'Savings' + change(h.groups.savings.kind), values: past(h.groups.savings.values).concat(plan.rows.map(r => r.savings)), cls: 'series-3' });
    else series.push({ name: 'Moved to savings from now', values: none.concat(plan.rows.map(r => r.savings)), cls: 'series-3' });
    if (plan.uncoveredCents > 0) series.push({ name: 'Short, not covered (so far)', values: none.concat(plan.rows.map(r => (r.uncovered > 0 ? r.uncovered : null))), cls: 'series-bad' });
    if (sc.changed) {
      const track = projectionOf(m, base, horizon);
      series.push({ name: 'Total on the baseline plan', values: pastMonths.map((x, i) => (i === pastMonths.length - 1 ? h.total.values[end] : null)).concat(track.rows.map(r => r.total)), cls: 'series-muted', noEndLabel: true });
    }
    return c.lineChart({
      id: 'home-chart',
      title: (h.total.kind === 'balance' ? 'Joint account balances' : 'Change in joint accounts (balances not known)') + ', past ' + pastMonths.length + ' months and the next ' + yearsText(horizon),
      series, labels, projectFrom: pastMonths.length, nowLabel: 'Now',
      tableCaption: 'Balances at the end of each month',
    });
  }

  function resultHtml(ctx, m, sc, base, horizon) {
    if (!m.canProject) {
      const toChecking = sc.inCents - sc.outCents - sc.savedCents;
      return `<p class="home-result-big">Where the balances lead: <strong>not known yet</strong></p>
        <p class="home-result-line">Each month this plan changes checking by <strong>${esc(signed(toChecking))}</strong>${hasSavings(m) ? ` and savings by <strong>${esc(signed(sc.savedCents))}</strong>` : ''}. Without today’s balances that can’t be turned into balances: a projected change can dip below $0, which a real account can’t.</p>
        <p class="fine">Enter today’s balances in “Add a balance” below (one number per account, from a statement or your bank’s app). Then this chart projects them, stopping at $0 and showing any shortfall instead.</p>`;
    }
    const plan = projectionOf(m, sc, horizon);
    const track = projectionOf(m, base, horizon);
    const end = plan.rows[plan.rows.length - 1], baseEnd = track.rows[track.rows.length - 1];
    const diff = end.total - baseEnd.total;
    const lines = [];
    const latest = m.hist.latest;
    const entered = m.hist.accounts.filter(a => a.source === 'entered');
    const from = entered.length === m.hist.accounts.length ? 'worked out from the balances you entered' : entered.length ? 'from your bank’s running balance and the balance you entered' : 'from your bank’s running balance';
    lines.push(`<p class="home-result-line" id="home-now">Now (end of ${esc(fmt.monthLong(latest.month))}): checking <strong>${esc(whole(latest.checking))}</strong>${hasSavings(m) ? ` · savings <strong>${esc(whole(latest.savings))}</strong>` : ''} · together ${esc(whole(latest.total))}, ${esc(from)}.</p>`);
    lines.push(`<p class="home-result-big">In ${esc(yearsText(horizon))} on this plan: <strong>${esc(whole(end.total))}</strong> in the joint accounts</p>`);
    const compared = !sc.changed ? '' : diff === 0 ? ' The total is the same as on the baseline plan: moving money between checking and savings does not change it.'
      : ` That is <strong class="home-diff ${diff < 0 ? 'tone-bad' : 'tone-good'}">${esc(signed(diff))}</strong> compared with the baseline plan.`;
    lines.push(`<p class="home-result-line">Then: checking ${esc(whole(end.checking))} · ${hasSavings(m) ? 'savings' : 'moved to savings'} ${esc(whole(end.savings))}.${compared}</p>`);
    const warn = text => `<p class="home-result-warn">${c.badge('Heads up', 'warn')} ${text}</p>`;
    if (plan.limited) {
      if (plan.coveredFromSavingsCents > 0) lines.push(warn(`From ${esc(fmt.monthLong(plan.firstShortMonth))} checking would need money from savings to stay above $0 (${esc(whole(plan.coveredFromSavingsCents))} moved over by ${esc(fmt.month(end.month))}).`));
      if (plan.savingsEmptyMonth) lines.push(warn(`Savings would be empty in ${esc(fmt.monthLong(plan.savingsEmptyMonth))}${sc.savedCents < 0 ? `: the ${esc(whole(0 - sc.savedCents))} a month drawdown can’t continue after that` : ''}.`));
      if (plan.firstUncoveredMonth) lines.push(`<p class="home-result-warn tone-bad">${c.badge('Short', 'bad')} From ${esc(fmt.monthLong(plan.firstUncoveredMonth))} checking and savings can’t cover the plan: ${esc(whole(plan.uncoveredCents))} short by ${esc(fmt.month(end.month))}. That would have to be borrowed or cut. Balances are shown at $0, never below.</p>`);
    }
    return lines.join('');
  }

  function trackCard(ctx, m, sc, base, horizon) {
    const view = homeOf(ctx).chartView;
    return c.card(`<div class="home-chart" id="home-chart-slot">${chartHtml(ctx, m, sc, base, horizon)}</div>
      <div id="home-result" class="home-result" aria-live="polite">${resultHtml(ctx, m, sc, base, horizon)}</div>`, {
      title: 'Over time', id: 'home-track',
      subtitle: 'Solid: what happened. Dashed: this plan, month after month. No interest or growth is added.',
      actions: `<div class="home-chart-actions">${c.segmented({ label: 'Show', name: 'home-view', options: VIEWS, value: view, action: 'home:view' })}${c.segmented({ label: 'Look ahead', name: 'home-horizon', options: HORIZONS, value: horizon, action: 'home:horizon' })}</div>`,
    });
  }

  // ------------------------------------------------------------------ money into joint, by person
  function whoOf(ctx, m) {
    const w = homeOf(ctx).fundingWho;
    return w !== 'both' && m.people.some(p => p.id === w) ? w : 'both';
  }

  function fundingHistory(ctx, m, who) {
    const shown = m.rows.slice(-HISTORY_MONTHS);
    const firstKnown = shown.findIndex(r => r.actual);
    const rows = firstKnown === -1 ? [] : shown.slice(firstKnown);
    const people = m.people.filter(p => who === 'both' || p.id === who);
    const stacks = people.map(p => ({ name: p.name, cls: PERSON_CLS[p.id], values: rows.map(r => (r.actual ? r.actual[p.id] : null)), hatched: rows.map(r => (r.actual ? r.actual[p.id + 'Provisional'] : null)) }));
    const side = who === 'both' && rows.some(r => r.actual && r.actual.unassigned) ? { name: 'Not assigned', cls: 'series-muted', values: rows.map(r => (r.actual ? r.actual.unassigned : null)) } : null;
    const full = rows.filter(r => r.actual);
    const tot = k => full.reduce((s, r) => s + r.actual[k], 0);
    const avg = k => (full.length ? E.money.divide(tot(k), full.length) : null);
    const range = full.length ? rangeText(full[0].month, full[full.length - 1].month) : '';
    const parts = people.map(p => `${p.name} ${whole(tot(p.id))} (${whole(avg(p.id))} a month${tot(p.id + 'Provisional') ? `, ${whole(tot(p.id + 'Provisional'))} provisional` : ''})`);
    const summary = full.length ? `${range}, ${plural(full.length, 'complete month')}: ${parts.join('; ')}${people.length > 1 ? `; together ${whole(tot('p1') + tot('p2'))}` : ''}${side ? `. Not assigned to either of you: ${whole(tot('unassigned'))}` : ''}.` : '';
    const gaps = rows.filter(r => !r.actual).length;
    const chart = c.stackedColumnChart({
      id: 'home-funding-chart', title: 'Actual money into joint each month' + (who === 'both' ? ', by person' : ', ' + people.map(p => p.name).join('')),
      labels: rows.map(r => r.month), stacks, side, totalName: 'Both together', summary, hatchedName: 'provisional (matched, not confirmed)',
      tableCaption: 'Actual money into joint per month, by person',
    });
    return `<h3 class="home-sub-h">Actual months</h3>${chart}${gaps ? `<p class="fine">${plural(gaps, 'month')} not shown: not every account’s export covers the whole month.</p>` : ''}
      <p class="fine">Actual deposits into the joint accounts. Interest and refunds are not counted here. Striped parts were matched to a person by amount or by the pay in Budget, not confirmed: check them below.</p>`;
  }

  function streamRows(s) {
    const per = s.perPaycheck, mo = s.monthly;
    if (s.viaTransfers && per.net === null) {
      return `<p class="home-stream-h">${esc(s.label)}</p><p class="fine">Take-home not entered. This pay doesn’t go to joint directly: money reaches joint by transfer.</p>`;
    }
    const unit = s.kind === 'contribution' ? 'transfer' : 'paycheck';
    const both = (p, mm) => (p === null && mm === null ? '<span class="muted">Not entered</span>' : `${p !== null ? `${esc(exact(p))} per ${unit}` : ''}${p !== null && mm !== null ? ' · ' : ''}${mm !== null ? `<strong>${esc(exact(mm))}</strong> a month` : ''}`);
    const rows = [];
    if (s.kind === 'paycheck') {
      if (per.gross !== null) rows.push(['Gross pay (pay stub)', `${both(per.gross, null)}${mo.gross !== null ? ` · ${esc(exact(mo.gross))} a month <span class="muted">(${esc(String(s.count))} × the stub, not a verified salary)</span>` : ''}`]);
      rows.push(['Take-home pay', both(per.net, mo.net)]);
      rows.push(['Kept personally', s.viaTransfers ? '<span class="muted">All of it: money reaches joint by transfer</span>' : both(per.kept, mo.kept)]);
      if (!s.viaTransfers) rows.push(['To joint', both(per.joint, mo.joint)]);
    } else {
      rows.push(['Transfers into joint', both(per.joint, mo.joint)]);
    }
    const freq = s.frequency && E.schedule.LABELS[s.frequency] ? E.schedule.LABELS[s.frequency] : null;
    const sched = freq ? `${freq}${s.frequencyStatus === 'confirmed' ? ', confirmed' : ', not confirmed'}` : 'Not known';
    rows.push(['Schedule', `${esc(sched)}: ${esc(plural(s.count, unit))} a month${s.basis === 'assumed' ? ' (assumed for now)' : s.basis === 'average' ? ' (yearly average)' : ''}`]);
    rows.push(['Since', s.startMonth ? esc(fmt.monthLong(s.startMonth)) : '<span class="muted">Start month not entered</span>']);
    return `<p class="home-stream-h">${esc(s.label)}</p><dl class="home-pay">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }

  /** Same measure on both sides: money into joint before vs now. */
  function comparisonText(m, p, planCents) {
    const fp = m.funding.people[p.id];
    if (fp && fp.ended.length) {
      const old = fp.ended.filter(s => isCents(s.monthly.joint));
      if (old.length) {
        const oldCents = old.reduce((s, x) => s + x.monthly.joint, 0);
        return `Old pay (${esc(old.map(s => s.label + (s.endMonth ? ', until ' + fmt.month(s.endMonth) : '')).join('; '))}): ${esc(whole(oldCents))} a month to joint → now ${esc(whole(planCents))}: <strong>${esc(signed(planCents - oldCents))}</strong> a month.`;
      }
    }
    const start = fp ? fp.streams.map(s => s.startMonth).filter(Boolean).sort().pop() : null;
    const before = m.rows.filter(r => r.actual && (!start || r.month < start));
    const used = (start ? before : m.rows.filter(r => r.actual && m.base.months.includes(r.month))).slice(-12);
    if (!used.length) return '';
    const avg = E.money.divide(used.reduce((s, r) => s + r.actual[p.id], 0), used.length);
    const what = start ? `Actual before ${fmt.month(start)} (${rangeText(used[0].month, used[used.length - 1].month)} average)` : `Actual ${rangeText(used[0].month, used[used.length - 1].month)} average`;
    return `${esc(what)}: ${esc(whole(avg))} a month to joint → plan ${esc(whole(planCents))}: <strong>${esc(signed(planCents - avg))}</strong> a month.${start ? '' : ' Set the current pay’s start month in Budget to compare with the months before it.'}`;
  }

  function planFundingHtml(ctx, m, sc, who) {
    if (!sc.persons.length) return '';
    const total = sc.lines.funding.value;
    const people = sc.persons.filter(p => who === 'both' || p.id === who);
    const bar = total > 0 ? `<div class="home-plan-bar" aria-hidden="true">${sc.persons.map(p => (p.value > 0 ? `<span class="home-plan-seg ${esc(PERSON_CLS[p.id])}${who !== 'both' && p.id !== who ? ' is-dim' : ''}" style="flex-basis:${(p.value / total * 100).toFixed(2)}%"></span>` : '')).join('')}</div>` : '';
    const legend = `<ul class="home-split-legend">${sc.persons.map(p => `<li><span class="key key-swatch ${esc(PERSON_CLS[p.id])}" aria-hidden="true"></span>${esc(p.name)} <strong>${esc(whole(p.value))}</strong> a month${total > 0 ? ` (${Math.round(p.value / total * 100)}%)` : ''}${p.changed ? ' <span class="home-basis is-set">your setting</span>' : p.basis === 'plan' ? '' : ' <span class="home-basis">recent average: no pay in Budget</span>'}</li>`).join('')}<li>Together <strong>${esc(whole(total))}</strong> a month</li></ul>`;
    const cards = people.map(p => {
      const fp = m.funding.people[p.id];
      const streams = fp ? fp.streams : [];
      const yours = p.changed ? `<p class="home-yours">On this page: <strong>${esc(whole(p.value))}</strong> a month to joint (Budget: ${esc(whole(p.baseline))}).</p>` : '';
      const ended = fp && fp.ended.length ? `<p class="fine">Old pay, kept in history: ${fp.ended.map(s => `${esc(s.label)}${s.endMonth ? ' (until ' + esc(fmt.month(s.endMonth)) + ')' : ''}`).join('; ')}.</p>` : '';
      return `<div class="home-person" data-person="${esc(p.id)}"><h4><span class="key key-swatch ${esc(PERSON_CLS[p.id])}" aria-hidden="true"></span>${esc(p.name)}</h4>
        ${streams.length ? streams.map(streamRows).join('') : '<p class="muted">No pay or transfer for this month in Budget yet.</p>'}
        ${yours}${ended}<p class="home-compare">${comparisonText(m, p, p.value)}</p></div>`;
    }).join('');
    return `${bar}${legend}<div class="home-people">${cards}</div>
      <p class="fine">Only the part that reaches joint funds the household plan. Gross and full take-home pay are shown for reference; what is kept personally is outside the joint budget and is not taken off again.</p>`;
  }

  function depositsHtml(ctx, m) {
    const credits = m.base.credits.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!credits.length) return '';
    const name = id => (m.people.find(p => p.id === id) || {}).name || id;
    const provisional = credits.filter(x => x.basis === 'income' || x.basis === 'amount');
    const attr = E.balances.incomeAttribution(ctx.state.plan).explain;
    const rows = credits.map(x => {
      const t = m.byId.get(x.id) || {};
      const auto = attr(Object.assign({}, t, { personBasis: t.basePersonId ? 'rule' : null, personId: t.basePersonId || null }));
      const autoText = auto.who ? `Automatic: ${name(auto.who)}${auto.basis === 'rule' ? ' (household rule)' : ' (provisional)'}` : 'Automatic: not assigned';
      const current = x.basis === 'edit' ? (x.who || 'none') : '';
      const opts = [['', autoText], ...m.people.map(p => [p.id, p.name]), ['none', 'Neither (not assigned)']];
      const sid = 'home-person-' + x.id;
      return {
        date: fmt.date(x.date), desc: x.description, acct: x.accountLabel, amt: exact(x.cents),
        who: `<label class="sr-only" for="${esc(sid)}">Whose money is ${esc(x.description)} on ${esc(fmt.date(x.date))}</label><select id="${esc(sid)}" data-action="home:person" data-txn="${esc(x.id)}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${x.basis === 'income' || x.basis === 'amount' ? ' ' + c.badge('Provisional', 'warn') : ''}`,
      };
    });
    const table = c.table({
      caption: 'Deposits into joint and whose money they are', cls: 'home-deposits-table',
      columns: [{ key: 'date', label: 'Date' }, { key: 'desc', label: 'Description (as the bank wrote it)' }, { key: 'acct', label: 'Account' }, { key: 'amt', label: 'Amount', align: 'right' }, { key: 'who', label: 'Whose money', html: r => r.who }],
      rows,
    });
    const confirm = provisional.length ? c.button(`Confirm the ${provisional.length} provisional match${provisional.length === 1 ? '' : 'es'} as shown`, { action: 'home:confirm-provisional', id: 'home-confirm-provisional', cls: 'btn-small' }) : '';
    return c.disclosure(`Whose money is each deposit? ${provisional.length ? `<span class="home-basis">${provisional.length} provisional</span>` : ''}`,
      `<p class="fine">Deposits into joint in ${esc(rangeText(m.base.start, m.base.end))}. Provisional ones were matched by the pay in Budget or by amount: the bank’s description doesn’t name the person. Change any of them; the original description is kept.</p>${confirm}${table}`,
      { cls: 'home-deposits', id: 'home-deposits' });
  }

  function fundingCard(ctx, m, sc) {
    if (!m.split) return '';
    const who = whoOf(ctx, m);
    const options = [{ value: 'both', label: 'Both' }, ...m.people.map(p => ({ value: p.id, label: p.name }))];
    return c.card(`${fundingHistory(ctx, m, who)}
      <h3 class="home-sub-h">Current plan, from ${esc(fmt.monthLong(m.planMonth))}</h3>
      <div id="home-plan-funding">${planFundingHtml(ctx, m, sc, who)}</div>
      ${depositsHtml(ctx, m)}`, {
      title: 'Money into joint, by person', id: 'home-funding',
      subtitle: 'Actual months and the current plan are shown apart: the new pay is never written into past months.',
      actions: c.segmented({ label: 'Show', name: 'home-who', options, value: who, action: 'home:who' }),
    });
  }

  // ------------------------------------------------------------------ the details
  function reconcileCard(ctx, m, sc) {
    const range = rangeText(m.base.start, m.base.end);
    const a = m.base.avg.actual, L = sc.lines;
    if (!a) return '';
    const basis = (line, text) => (line.changed ? 'Your setting' : text);
    const planRows = [];
    for (const person of sc.persons) planRows.push({ line: `${person.name} → joint`, plan: whole(person.value), avg: whole(person.historyCents), basis: person.changed ? 'Your setting' : person.basis === 'plan' ? 'Budget pay (joint part)' : `${range} average` });
    if (!sc.persons.length) planRows.push({ line: 'Money into joint', plan: whole(L.funding.value), avg: whole(a.moneyIn), basis: basis(L.funding, `${range} average`) });
    if (L.otherIn.value) planRows.push({ line: 'Other planned income', plan: whole(L.otherIn.value), avg: '—', basis: 'Budget' });
    planRows.push({ line: '− Card spending (purchases − refunds)', plan: whole(L.card.value), avg: whole(a.cardNet), basis: basis(L.card, `${range} average, one-time left out, yearly spread`) });
    planRows.push({ line: '− Bills & mortgage from the bank', plan: whole(L.bank.value), avg: whole(a.bankNet), basis: basis(L.bank, `${range} average, one-time left out, yearly spread`) });
    if (L.debt.value || a.debt) planRows.push({ line: '− Debt payments from joint (store card, loans)', plan: whole(L.debt.value), avg: whole(a.debt), basis: `${range} average` });
    if (L.business.value || a.business) planRows.push({ line: '− Business purchases paid from joint', plan: whole(L.business.value), avg: whole(a.business), basis: `${range} average` });
    planRows.push({ line: L.savings.value < 0 ? '+ Drawn from savings' : '− Net to savings', plan: signed(L.savings.value), avg: signed(a.savingsNet), basis: basis(L.savings, `${range} average`) });
    if (L.invest.value || a.investNet) planRows.push({ line: '− Investments (net)', plan: whole(L.invest.value), avg: whole(a.investNet), basis: `${range} average` });
    const planTable = c.table({
      caption: 'How the plan adds up', cls: 'home-recon-table',
      columns: [{ key: 'line', label: 'Line' }, { key: 'plan', label: 'Plan a month', align: 'right' }, { key: 'avg', label: `Actual ${range} a month`, align: 'right' }, { key: 'basis', label: 'Plan amount from' }],
      rows: planRows,
      footer: { line: 'Plan remainder after allocations', plan: `<strong>${esc(signed(sc.remainder))}</strong>`, avg: esc(signed(a.left)), basis: '' },
    });
    const notIn = c.table({
      caption: 'Not counted in the plan', cls: 'home-recon-table',
      columns: [{ key: 'line', label: 'Not in the plan' }, { key: 'avg', label: `Actual ${range} a month`, align: 'right' }, { key: 'why', label: 'Why' }],
      rows: [
        { line: 'Deposits not assigned to either of you', avg: whole(a.unassigned), why: 'Not recurring pay as far as anyone knows (person-to-person payments, reimbursements, unexplained transfers).' },
        { line: 'Interest', avg: exact(a.interest), why: 'Small and not counted on.' },
        { line: 'Card payments from checking', avg: whole(a.cardRepayments), why: 'They pay for card purchases already counted in card spending.' },
      ],
    });
    // The past months, every role apart, adding up to what was left over.
    const shown = m.rows.filter(r => m.base.months.includes(r.month));
    const monthRows = shown.map(r => ({ m: fmt.month(r.month), ...cols(r.actual) }));
    const t = m.base.total.actual;
    const monthTable = c.table({
      caption: 'Each month, by role', cls: 'home-recon-months',
      columns: [{ key: 'm', label: 'Month' }, { key: 'fund', label: 'Into joint (both)', align: 'right' }, { key: 'other', label: 'Other money in', align: 'right' }, { key: 'card', label: 'Cards', align: 'right' }, { key: 'bank', label: 'Bank-paid', align: 'right' }, { key: 'debt', label: 'Debt & business', align: 'right' }, { key: 'sav', label: 'Net to savings', align: 'right' }, { key: 'inv', label: 'Investments', align: 'right' }, { key: 'left', label: 'Left over', align: 'right' }],
      rows: monthRows,
      footer: Object.fromEntries(Object.entries(Object.assign({ m: 'Total' }, cols(t))).map(([k, v]) => [k, esc(v)])),
    });
    const explain = `<p class="fine">${esc(range)}: card purchases ${esc(exact(t.cardPurchases))} − card refunds ${esc(exact(t.cardRefunds))} = ${esc(exact(t.cardNet))} net card spending; + ${esc(exact(t.bankNet))} paid from the bank = ${esc(exact(t.consumption))} household spending. Card payments from checking (${esc(exact(t.cardRepayments))}), debt payments (${esc(exact(t.debt))}), savings and investment transfers are kept out of that total and shown on their own lines. One-time expenses left out of the plan still count in these actual months.</p>`;
    return c.disclosure('How the plan adds up', `${planTable}${notIn}<h3 class="home-sub-h">Actual months, ${esc(range)}</h3>${explain}${monthTable}`, { cls: 'home-detail', id: 'home-recon' });
  }

  function cols(x) {
    return {
      fund: whole(x.funding), other: whole(x.unassigned + x.interest), card: whole(x.cardNet), bank: whole(x.bankNet),
      debt: whole(x.debt + x.business), sav: signed(x.savingsNet), inv: whole(x.investNet), left: signed(x.left),
    };
  }

  function baselineCard(ctx, m, sc) {
    const b = m.base;
    if (!b.count) return '';
    const range = rangeText(b.start, b.end);
    const t = b.total.actual, a = b.avg.actual, p = b.avg.planning;
    const col = (role, line) => {
      const k = b.kinds[role];
      return {
        regular: exact(k.regular), yearly: exact(k.yearly), everyday: exact(k.everyday), oneTime: exact(k.oneTime),
        net: exact(t[role + 'Net']), avg: exact(a[role + 'Net']), base: exact(p[role + 'Net']),
        plan: exact(line.value) + (line.changed ? ' (your setting)' : ''),
      };
    };
    const card = col('card', sc.lines.card), bank = col('bank', sc.lines.bank);
    const rows = [
      ['Recurring (same place most months)', 'regular'], ['Yearly bills', 'yearly'], ['Varies month to month (refunds taken off)', 'everyday'],
      ['One-time expenses', 'oneTime'], [`All spending, ${range}`, 'net'], ['A month, as it happened', 'avg'],
      ['Baseline a month (one-time left out, yearly spread)', 'base'], ['Your plan a month', 'plan'],
    ].map(([label, k]) => ({ label, card: card[k], bank: bank[k], cls: k }));
    const tbl = c.table({ caption: 'Card and bank-paid spending: recurring, yearly, varying and one-time', cls: 'home-baseline-table', columns: [{ key: 'label', label: '' }, { key: 'card', label: 'Cards', align: 'right' }, { key: 'bank', label: 'Paid from the bank', align: 'right' }], rows, rowAttrs: r => ({ class: 'is-' + r.cls }) });
    const negative = p.cardNet < 0 ? `<p class="fine">In these months card refunds were more than purchases (${esc(exact(p.cardNet))} net). That stays in the actual figures; planned card spending can’t go below $0, so the plan starts at $0.</p>` : '';
    const where = o => `${o.role === 'card' ? 'on' : 'from'} ${o.accountLabel}`;
    const item = (o, extra, btn) => `<li><span><strong>${esc(o.merchant)}</strong> ${esc(fmt.date(o.date))} · ${esc(exact(o.cents))} ${esc(where(o))}${extra ? ` <span class="home-basis">${extra}</span>` : ''}</span>${btn}</li>`;
    const setBtn = (o, value, label, message, reason) => c.button(label, { action: 'ledger:set', cls: 'btn-small', id: 'home-' + (value || 'clear') + '-' + o.id, data: { txn: o.id, field: 'planningBaseline', value, reason, message } });
    const oneTime = b.oneTime.length ? `<h3 class="home-sub-h">One-time expenses: counted as spending, left out of the plan</h3><ul class="home-oneoffs" id="home-onetime">${b.oneTime.map(o => item(o, o.auto ? 'found automatically' : 'you chose this',
      setBtn(o, 'include', 'Count as regular', `${o.merchant} now counts toward the plan.`, 'Counted as regular spending on Home'))).join('')}</ul>
      <p class="fine">Found automatically: a purchase of ${esc(whole(E.flows.ONE_OFF_MIN_CENTS))} or more with no similar purchase from the same place in these months and none about a year apart. It still shows in every actual total; only the plan leaves it out.</p>` : '';
    const yearly = b.yearly.length ? `<h3 class="home-sub-h">Yearly bills: spread over 12 months</h3><ul class="home-oneoffs">${b.yearly.map(o => item(o, `${whole(Math.round(o.cents / 12))} a month in the plan`, '')).join('')}</ul>` : '';
    const kept = b.keptRegular.length ? `<h3 class="home-sub-h">Big purchases you count as regular</h3><ul class="home-oneoffs">${b.keptRegular.map(o => item(o, '', setBtn(o, 'exclude', 'Treat as one-time', `${o.merchant} left out of the plan. It still counts as spending.`, 'One-time: left out of the plan on Home'))).join('')}</ul>` : '';
    const shown = m.rows.filter(r => b.months.includes(r.month));
    const chart = shown.length > 1 ? c.lineChart({
      id: 'home-spend-chart', title: 'Card and bank-paid spending each month, as it happened',
      labels: shown.map(r => r.month),
      series: [
        { name: 'Cards (net)', values: shown.map(r => r.actual.cardNet), cls: 'series-1' },
        { name: 'Paid from the bank', values: shown.map(r => r.actual.bankNet), cls: 'series-2' },
        { name: 'Card baseline', values: shown.map(() => Math.max(0, p.cardNet)), cls: 'series-muted', noEndLabel: true },
      ],
      tableCaption: 'Card and bank-paid spending per month',
    }) : '';
    const body = `<div class="home-baseline-head">${c.segmented({ label: 'Baseline months', name: 'home-window', options: WINDOWS, value: homeOf(ctx).baselineMonths, action: 'home:baseline' })}
        <p class="fine">Using ${esc(plural(b.count, 'complete month'))}: ${esc(range)}${b.count < homeOf(ctx).baselineMonths ? ' (all there are)' : ''}. A month counts only when every account’s export covers all of it.</p></div>
      ${tbl}${negative}${oneTime}${yearly}${kept}${chart}`;
    return c.disclosure(`Spending baseline: recurring, yearly and one-time${b.oneTime.length ? ` <span class="home-basis">${plural(b.oneTime.length, 'one-time expense')} left out</span>` : ''}`, body, { cls: 'home-detail', id: 'home-baseline' });
  }

  function savingsCard(ctx, m) {
    const b = m.base;
    const shown = m.rows.filter(r => b.months.includes(r.month));
    if (!shown.length) return '';
    const t = b.total.actual;
    const range = rangeText(b.start, b.end);
    const rows = shown.map(r => ({ m: fmt.monthLong(r.month), inn: exact(r.actual.savingsIn), out: exact(r.actual.savingsOut), net: fmt.money(r.actual.savingsNet, { signed: true }), int: exact(r.actual.interest), inv: fmt.money(r.actual.investNet, { signed: true }) }));
    const table = c.table({
      caption: 'Savings in and out per month', cls: 'home-savings-table',
      columns: [{ key: 'm', label: 'Month' }, { key: 'inn', label: 'Into savings', align: 'right' }, { key: 'out', label: 'Out of savings', align: 'right' }, { key: 'net', label: 'Net transfers', align: 'right' }, { key: 'int', label: 'Interest', align: 'right' }, { key: 'inv', label: 'Investments (net)', align: 'right' }],
      rows,
      footer: { m: 'Total', inn: esc(exact(t.savingsIn)), out: esc(exact(t.savingsOut)), net: esc(fmt.money(t.savingsNet, { signed: true })), int: esc(exact(t.interest)), inv: esc(fmt.money(t.investNet, { signed: true })) },
    });
    const chart = c.columnChart({ title: 'Net transfers to savings', items: shown.map(r => ({ label: r.month, value: r.actual.savingsNet, note: `In ${exact(r.actual.savingsIn)}, out ${exact(r.actual.savingsOut)}` })), format: v => fmt.money(v, { whole: true, signed: true }) });
    const lead = `<p>${esc(range)}: ${esc(exact(t.savingsIn))} into savings, ${esc(exact(t.savingsOut))} out: <strong>${esc(fmt.money(t.savingsNet, { signed: true }))}</strong> net (${t.savingsNet < 0 ? 'drawn down' : t.savingsNet > 0 ? 'added' : 'no change'}), before ${esc(exact(t.interest))} interest. Investment transfers (${esc(fmt.money(t.investNet, { signed: true }))} net) are kept apart.</p>`;
    return c.disclosure('Savings in and out', `${lead}${chart}${table}<p class="fine">Transfer totals, not balances: they don’t say what savings holds today.</p>`, { cls: 'home-detail', id: 'home-savings' });
  }

  /** Accounts whose export has no running balance: one typed-in balance turns "change" into real balances. */
  function balancePrompt(ctx, m) {
    const missing = m.hist.accounts.filter(a => a.source !== 'bank');
    if (!missing.length) return '';
    const bal = ctx.state.plan.balances || {};
    const lastDay = ctx.months.length ? E.months.end(ctx.months[ctx.months.length - 1]) : '';
    const needs = missing.filter(a => a.source === 'change');
    const fields = missing.map(a => c.moneyField({ id: 'home-bal-' + a.id, label: a.label, path: 'plan.balances.accounts.' + a.id, cents: (bal.accounts || {})[a.id] ?? null, allowNegative: true, placeholder: 'Not entered', message: a.label + ' balance saved.', help: '' })).join('');
    const date = `<div class="field"><label for="home-bal-asof">Balance on</label><input id="home-bal-asof" type="date" data-bind="plan.balances.accountsAsOf" data-type="date" data-message="Balance date saved." value="${esc(bal.accountsAsOf || '')}" aria-describedby="home-bal-asof-help home-bal-asof-error"><p class="field-help" id="home-bal-asof-help">${lastDay ? `Your data ends ${esc(fmt.date(lastDay))}. Today’s balance is fine; left blank, the balances count as of ${esc(fmt.date(lastDay))}.` : ''}</p><p class="field-error" id="home-bal-asof-error" role="alert" hidden></p></div>`;
    const gaps = m.hist.accounts.filter(a => a.gap).map(a => `<p class="fine">${esc(a.note)}</p>`).join('');
    const body = `<p>${needs.length ? `Your ${esc(needs.map(a => a.label).join(' and '))} export has no running balance, so the chart shows how ${needs.length === 1 ? 'it has' : 'they have'} changed, not what ${needs.length === 1 ? 'it holds' : 'they hold'}. Enter today’s balance from your bank’s app (or a statement) and the whole history is worked out from the transactions. Then the plan starts from what you actually have: savings tops up checking when it runs low, a drawdown stops when savings is empty, and no balance goes below $0.` : 'These balances come from what you entered. Update them any time.'}</p><div class="home-bal-fields">${fields}${date}</div>${gaps}`;
    return needs.length ? c.card(body, { title: 'Add a balance', id: 'home-balances' }) : c.disclosure('Balances you entered', body, { cls: 'home-entered', id: 'home-entered' });
  }

  function render(ctx) {
    const header = c.pageHeader({
      title: 'Your joint plan',
      subtitle: ctx.months.length ? `Joint accounts. Actual months from your data through ${esc(fmt.date(E.months.end(ctx.months[ctx.months.length - 1])))}; the plan is a typical month from ${esc(fmt.monthLong(ctx.forecastStart))}.` : 'Your joint accounts.',
    });
    const sample = ctx.dataset.isSynthetic ? c.notice({ tone: 'info', title: 'This is a fictional sample household.', body: 'Load your own bank exports in Data &amp; privacy; they stay on this device.' }) : '';
    if (ctx.app.datasetError) return header + c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) });
    if (!ctx.months.length) {
      return header + c.card(c.empty('Load your bank exports to see your plan. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No data yet' });
    }
    const m = model(ctx);
    if (!m.hist.latest || !m.base.count) {
      const why = !m.hist.accounts.length ? 'There is no joint checking or savings account in the data.' : !m.base.count ? 'There is no complete month yet: every account’s export must cover a whole month.' : 'No month has a known balance yet.';
      return header + sample + c.card(c.empty(esc(why) + ' <a href="' + esc(ctx.href('review', { queue: 'coverage' })) + '">See which months are covered</a>.'), { title: 'Not enough data yet' }) + balancePrompt(ctx, m);
    }
    const sc = scenarioOf(ctx, m);
    const base = baselineScenario(ctx, m);
    const horizon = homeOf(ctx).horizon;
    const reviewCount = (() => { try { const q = ctx.reviewQueues().counts || {}; return (q.uncertain || 0) + (q.duplicates || 0); } catch { return 0; } })();
    const more = `<p class="home-more">More detail when you want it: <a href="${esc(ctx.href('spending'))}">where the money went</a> · <a href="${esc(ctx.href('budget'))}">pay, bills and goals</a> · <a href="${esc(ctx.href('forecast'))}">bigger plans like a baby or a repair</a>${reviewCount ? ` · <a href="${esc(ctx.href('review'))}">${reviewCount} transaction${reviewCount === 1 ? '' : 's'} could use a check (optional)</a>` : ''}.</p>`;
    return `${header}<div class="stack">${sample}
      <section class="home-plan" id="home-plan" aria-label="The plan in four amounts"><div id="home-plan-slot">${planHtml(ctx, m, sc)}</div><p class="sr-only" id="home-live" aria-live="polite"></p></section>
      ${controlsCard(ctx, m, sc)}
      ${trackCard(ctx, m, sc, base, horizon)}
      ${balancePrompt(ctx, m)}
      ${fundingCard(ctx, m, sc)}
      <div class="home-details">${reconcileCard(ctx, m, sc)}${baselineCard(ctx, m, sc)}${savingsCard(ctx, m)}</div>
      ${more}</div>`;
  }

  // ------------------------------------------------------------------ live controls
  /** Amounts being changed on the page but not saved yet (a slider mid-drag). */
  function readOverrides(container) {
    const out = {};
    for (const el of container.querySelectorAll('.home-control[data-dirty]')) out[el.dataset.control] = Number(el.dataset.cents);
    return out;
  }

  function redraw(container, ctx, m) {
    const sc = scenarioOf(ctx, m, readOverrides(container));
    const base = baselineScenario(ctx, m);
    const horizon = homeOf(ctx).horizon;
    const set = (sel, html) => { const el = container.querySelector(sel); if (el) el.innerHTML = html; };
    set('#home-plan-slot', planHtml(ctx, m, sc));
    // One short spoken update instead of re-reading every tile while a slider moves.
    const live = container.querySelector('#home-live');
    if (live) live.textContent = `Plan remainder ${signed(sc.remainder)} a month.`;
    set('#home-chart-slot', chartHtml(ctx, m, sc, base, horizon));
    set('#home-result', resultHtml(ctx, m, sc, base, horizon));
    set('#home-plan-funding', planFundingHtml(ctx, m, sc, whoOf(ctx, m)));
    set('#home-bank-summary', esc(whole(sc.lines.bank.value)));
    for (const k of controlsOf(ctx, m, sc)) set('#' + k.id + '-kept', keptText(k, k.value));
    const reset = container.querySelector('#home-reset');
    if (reset) reset.disabled = !sc.changed;
  }

  function commit(ctx, key, cents) {
    ctx.app.update(st => E.state.setPath(st, 'ui.home.' + key, cents), { undoable: false });
  }

  function showError(container, key, message) {
    const control = container.querySelector(`.home-control[data-control="${key}"]`);
    const box = control && control.querySelector('.field-error');
    const input = control && control.querySelector('input[data-home-text]');
    if (!box || !input) return;
    box.hidden = !message;
    box.textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  function afterRender(container, ctx) {
    if (!container.querySelector('.home-control')) return;
    const m = model(ctx);
    for (const el of container.querySelectorAll('input[type="range"][data-home]')) {
      const control = el.closest('.home-control');
      el.addEventListener('input', () => {
        const cents = Math.round(Number(el.value) * 100);
        control.dataset.cents = String(cents);
        control.dataset.dirty = '1';
        const text = control.querySelector('input[data-home-text]');
        if (text) text.value = inputText(cents);
        showError(container, el.dataset.home, null);
        el.setAttribute('aria-valuetext', (text && text.dataset.signed ? signed(cents) : whole(cents)) + ' a month');
        redraw(container, ctx, m);
      });
      el.addEventListener('change', () => commit(ctx, el.dataset.home, Math.round(Number(el.value) * 100)));
    }
    for (const el of container.querySelectorAll('input[data-home-text]')) {
      const key = el.dataset.homeText;
      const apply = () => {
        let cents;
        try {
          cents = E.money.inputToCents(el.value.replace(/[−–]/g, '-'), { allowNegative: !!el.dataset.signed, field: key });
        } catch (err) {
          showError(container, key, err.message || 'Enter an amount in dollars, such as 125 or 125.50.');
          return;
        }
        if (cents === null) { showError(container, key, 'Enter an amount, or use “Use baseline” to go back to the baseline.'); return; }
        showError(container, key, null);
        commit(ctx, key, cents);
      };
      el.addEventListener('change', apply);
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
    }
  }

  const setHome = (ctx, key, value, opts = {}) => ctx.app.update(st => E.state.setPath(st, 'ui.home.' + key, value), Object.assign({ undoable: false }, opts));

  const actions = {
    'home:reset': ctx => {
      ctx.app.update(st => ({ ...st, ui: { ...st.ui, home: { ...st.ui.home, ...Object.fromEntries(AMOUNT_KEYS.map(k => [k, null])) } } }),
        { message: 'Plan amounts on Home are back to their baselines (Budget pay and recent averages).' });
    },
    'home:reset-one': (ctx, el) => {
      if (!AMOUNT_KEYS.includes(el.dataset.key)) return;
      setHome(ctx, el.dataset.key, null, { undoable: true, message: 'Back to the baseline amount.' });
    },
    'home:clear-legacy': ctx => setHome(ctx, 'outCents', null, { undoable: true, message: 'The old spending setting was removed.' }),
    'home:horizon': (ctx, el) => setHome(ctx, 'horizon', Number(el.dataset.value || el.value)),
    'home:view': (ctx, el) => setHome(ctx, 'chartView', el.dataset.value || el.value),
    'home:baseline': (ctx, el) => setHome(ctx, 'baselineMonths', Number(el.dataset.value || el.value)),
    'home:who': (ctx, el) => setHome(ctx, 'fundingWho', el.dataset.value || el.value),
    'home:person': (ctx, el) => {
      const value = el.value === '' ? null : el.value;
      const t = model(ctx).byId.get(el.dataset.txn);
      UI.shared.editMany(ctx.app, [{ txnId: el.dataset.txn, field: 'person', value, reason: 'Set on Home' }],
        { message: value === null ? 'Back to the automatic match.' : `Deposit${t ? ' of ' + exact(t.amountCents) : ''} marked as ${value === 'none' ? 'not assigned' : ctx.person(value) + '’s'}. The original description is kept.` });
    },
    'home:confirm-provisional': ctx => {
      const m = model(ctx);
      const list = m.base.credits.filter(x => (x.basis === 'income' || x.basis === 'amount') && x.who);
      if (!list.length) return;
      UI.shared.editMany(ctx.app, list.map(x => ({ txnId: x.id, field: 'person', value: x.who, reason: 'Confirmed on Home' })),
        { message: `${list.length} deposit${list.length === 1 ? '' : 's'} confirmed.` });
    },
  };

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Home', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
