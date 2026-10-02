'use strict';
/*
 * Home: four plain answers, from the household's own recent months (joint accounts).
 *   1. What is comfortable to save and spend this month?
 *   2. Where does that leave us? (balances now)
 *   3. If we keep this up, where do we end up? (balances projected on the current track)
 *   4. What if we change something? (money in / spending / saving sliders, redrawn as they move)
 * Everything granular (categories, plan lines, data checks) lives in the other views.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const HORIZONS = [{ value: 12, label: '1 year' }, { value: 24, label: '2 years' }, { value: 60, label: '5 years' }];
  const HISTORY_MONTHS = 24;
  const CONTROLS = [
    { key: 'inCents', id: 'home-in', label: 'Money coming in', usualKey: 'inCents', help: 'Pay and transfers into your joint accounts, per month.' },
    { key: 'outCents', id: 'home-out', label: 'Spending', usualKey: 'outCents', help: 'Everything paid out: bills, groceries, loans, everything else.' },
    { key: 'savedCents', id: 'home-saved', label: 'Moved to savings', usualKey: 'savedCents', help: 'Out of checking into savings each month. It is still your money.' },
  ];
  const whole = cents => fmt.money(cents, { whole: true });
  const dollars = cents => Math.round(cents / 100).toLocaleString('en-US');
  const signed = cents => fmt.money(cents, { whole: true, signed: true });
  const yearsText = months => (months % 12 === 0 ? (months / 12 === 1 ? '1 year' : months / 12 + ' years') : months + ' months');

  /** Everything Home needs, worked out once per data/state change. */
  function model(ctx) {
    return ctx.memo('home-model', () => {
      const txns = ctx.realTxns || ctx.txns;
      const bal = ctx.state.plan.balances || {};
      const hist = E.balances.history(txns, ctx.dataset, { entered: bal.accounts || {}, asOf: bal.accountsAsOf || null, months: ctx.months });
      const attribute = E.balances.incomeAttribution(ctx.state.plan);
      const flows = E.balances.monthlyFlows(txns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, planning: true, attribute });
      const usual = E.balances.usual(flows, { count: 12 });
      const comfy = E.balances.comfortable(flows, { count: 12 });
      // Income is shown per person when at least one partner's deposits can be told apart.
      const people = (ctx.state.plan.people || []).filter(p => p && (p.id === 'p1' || p.id === 'p2'));
      const earners = usual.bySource ? people.filter(p => usual.bySource[p.id] > 0) : [];
      return { hist, flows, usual, comfy, people, earners, split: earners.length > 0 };
    });
  }

  /**
   * The amounts the what-if uses: the household's own (saved, or `overrides` from sliders being
   * dragged), else the usual ones. With income split by person, money in = each partner's amount
   * + the usual other income (interest, refunds).
   */
  function chosen(ctx, m, overrides = {}) {
    const h = Object.assign({}, ctx.state.ui.home || {}, overrides);
    const pick = (k, usual) => (Number.isInteger(h[k]) ? h[k] : usual);
    const parts = m.split ? m.earners.map(p => ({ id: p.id, name: p.name, cents: pick(p.id + 'InCents', m.usual.bySource[p.id]), usual: m.usual.bySource[p.id] })) : null;
    const inCents = parts ? parts.reduce((s, x) => s + x.cents, 0) + (m.usual.inCents - m.earners.reduce((s, p) => s + m.usual.bySource[p.id], 0)) : pick('inCents', m.usual.inCents);
    const vals = { inCents, outCents: pick('outCents', m.usual.outCents), savedCents: pick('savedCents', m.usual.savedCents), parts };
    vals.changed = vals.inCents !== m.usual.inCents || vals.outCents !== m.usual.outCents || vals.savedCents !== m.usual.savedCents || (parts || []).some(x => x.cents !== x.usual);
    return vals;
  }
  const possessive = name => name + (/s$/i.test(name) ? '’' : '’s');

  /** Without a savings account in the data, "savings" means what is moved out to savings from now on. */
  const hasSavings = m => m.hist.groups.savings.kind !== 'none';

  function projectionOf(m, vals, months) {
    const latest = m.hist.latest;
    return E.balances.project({
      startMonth: E.months.add(latest.month, 1), months,
      start: { checking: latest.checking, savings: latest.savings },
      inCents: vals.inCents, outCents: vals.outCents, savedCents: vals.savedCents,
    });
  }

  // ------------------------------------------------------------------ the chart
  function chartHtml(ctx, m, vals, horizon) {
    const h = m.hist;
    const end = h.latest.index;
    const from = Math.max(0, end - HISTORY_MONTHS + 1);
    const pastMonths = h.months.slice(from, end + 1);
    const plan = projectionOf(m, vals, horizon);
    const track = projectionOf(m, m.usual, horizon);
    const labels = pastMonths.concat(plan.rows.map(r => r.month));
    const past = vals => vals.slice(from, end + 1);
    const changeNote = h.total.kind === 'change' ? ' (change)' : '';
    const series = [
      { name: 'Total' + changeNote, values: past(h.total.values).concat(plan.rows.map(r => r.total)), cls: 'series-1' },
      { name: 'Checking' + (h.groups.checking.kind === 'change' ? ' (change)' : ''), values: past(h.groups.checking.values).concat(plan.rows.map(r => r.checking)), cls: 'series-2' },
    ];
    if (hasSavings(m)) series.push({ name: 'Savings' + (h.groups.savings.kind === 'change' ? ' (change)' : ''), values: past(h.groups.savings.values).concat(plan.rows.map(r => r.savings)), cls: 'series-3' });
    else series.push({ name: 'Moved to savings from now', values: pastMonths.map(() => null).concat(plan.rows.map(r => r.savings)), cls: 'series-3' });
    if (vals.changed) series.push({ name: 'Total if nothing changes', values: pastMonths.map((x, i) => (i === pastMonths.length - 1 ? h.total.values[end] : null)).concat(track.rows.map(r => r.total)), cls: 'series-muted', noEndLabel: true });
    return c.lineChart({
      id: 'home-chart',
      title: 'Joint account balances, past ' + pastMonths.length + ' months and the next ' + yearsText(horizon),
      series, labels, projectFrom: pastMonths.length, nowLabel: 'Now',
      tableCaption: 'Balances at the end of each month',
    });
  }

  // ------------------------------------------------------------------ the answers
  function answers(ctx, m, vals, horizon) {
    const h = m.hist;
    const latest = h.latest;
    const month = E.months.add(latest.month, 1);
    const plan = projectionOf(m, vals, horizon);
    const track = projectionOf(m, m.usual, horizon);
    const end = track.rows[track.rows.length - 1];
    const yearAgo = h.total.values[latest.index - 12];
    const isBalance = h.total.kind === 'balance';
    const nowTile = c.metric({
      label: isBalance ? 'You have now' : 'Change since your data starts',
      value: whole(latest.total),
      sub: `${isBalance ? '' : 'Not a balance: enter one below. '}Checking ${esc(whole(latest.checking))}${hasSavings(m) ? ` · savings ${esc(whole(latest.savings))}` : ''}, end of ${esc(fmt.month(latest.month))}${Number.isInteger(yearAgo) ? `<br>${esc(signed(latest.total - yearAgo))} over the last 12 months` : ''}`,
    });
    const comfy = m.comfy;
    const spendUpTo = m.usual.inCents - comfy.comfortableCents;
    const saveTile = comfy.comfortableCents > 0
      ? c.metric({ label: `Comfortable to save in ${fmt.monthLong(month).split(' ')[0]}`, value: whole(comfy.comfortableCents), tone: 'good', sub: `Then spend up to ${esc(whole(spendUpTo))} (you usually spend ${esc(whole(m.usual.outCents))})${m.usual.savedCents > 0 ? `. Counts the ${esc(whole(m.usual.savedCents))} you already move to savings.` : ''}` })
      : c.metric({ label: `Comfortable to save in ${fmt.monthLong(month).split(' ')[0]}`, value: '$0', tone: 'warn', sub: `In most recent months spending used up what came in (usually ${esc(whole(m.usual.inCents))} in, ${esc(whole(m.usual.outCents))} out)` });
    const trackTile = c.metric({
      label: `On your current track, in ${yearsText(horizon)}`,
      value: whole(end.total),
      tone: end.total < latest.total ? 'bad' : '',
      sub: `${esc(signed(end.total - latest.total))} from now · ${hasSavings(m) ? 'savings' : 'moved to savings'} ${esc(whole(end.savings))}${track.firstShortMonth ? `<br><strong class="tone-bad">Checking runs out in ${esc(fmt.month(track.firstShortMonth))}</strong>` : ''}`,
    });
    return { tiles: `<div class="metrics home-answers">${saveTile}${nowTile}${trackTile}</div>`, month, plan, track };
  }

  /** The "this month" split of a usual month's money, and how "comfortable" was worked out. */
  function thisMonth(ctx, m, month) {
    const u = m.usual, comfy = m.comfy;
    const save = Math.min(comfy.comfortableCents, Math.max(0, u.inCents - u.outCents));
    const cushion = Math.max(0, u.inCents - u.outCents - save);
    const short = Math.max(0, u.outCents - u.inCents);
    const total = Math.max(u.inCents, u.outCents) || 1;
    const seg = (cls, cents, text) => (cents > 0 ? `<span class="home-split-seg ${cls}" style="flex-basis:${(cents / total * 100).toFixed(2)}%" title="${esc(text)}"></span>` : '');
    const bar = `<div class="home-split" aria-hidden="true">${seg('is-spend', Math.min(u.outCents, u.inCents), 'Usual spending')}${seg('is-save', save, 'Comfortable to save')}${seg('is-cushion', cushion, 'Cushion')}${seg('is-short', short, 'More out than in')}</div>`;
    const range = comfy.months.length ? `${fmt.month(comfy.months[0].month)}–${fmt.month(comfy.months[comfy.months.length - 1].month)}` : '';
    const list = `<ul class="home-split-legend">
        <li><span class="key key-swatch is-spend" aria-hidden="true"></span>Usual spending <strong>${esc(whole(u.outCents))}</strong></li>
        <li><span class="key key-swatch is-save" aria-hidden="true"></span>Comfortable to save <strong>${esc(whole(save))}</strong></li>
        ${cushion ? `<li><span class="key key-swatch is-cushion" aria-hidden="true"></span>Cushion for an expensive month <strong>${esc(whole(cushion))}</strong></li>` : ''}
        ${short ? `<li><span class="key key-swatch is-short" aria-hidden="true"></span>More going out than coming in <strong>${esc(whole(short))}</strong></li>` : ''}
      </ul>`;
    const how = c.disclosure('How these numbers are worked out', `<p>From your last ${comfy.count} complete month${comfy.count === 1 ? '' : 's'} (${esc(range)}), joint accounts only. A usual month brings in ${esc(whole(u.inCents))} and ${esc(whole(u.outCents))} goes out, leaving ${esc(whole(comfy.typicalLeftCents))} on average. But months differ: what was left ranged from ${esc(whole(comfy.lowestCents))} to ${esc(whole(comfy.highestCents))}. “Comfortable to save” is the amount left over in ${comfy.monthsAtLeast} of those ${comfy.count} months (rounded down to $50), so most months can afford it and an expensive month is covered by the cushion.</p>
      <p>Moving money to savings does not change your total: it moves it from checking to savings. One-off costs you left out of planning in Review are left out of “usual”. Transfers between your own accounts and card bills paid in full are not counted as spending.</p>`, { cls: 'home-how', id: 'home-how' });
    const from = m.split ? ` (${m.earners.map(p => esc(p.name) + ' ' + esc(whole(u.bySource[p.id]))).join(', ')}${u.inCents - m.earners.reduce((s, p) => s + u.bySource[p.id], 0) ? ', other ' + esc(whole(u.inCents - m.earners.reduce((s, p) => s + u.bySource[p.id], 0))) : ''})` : '';
    return c.card(`<p class="home-lede">A usual month brings in <strong>${esc(whole(u.inCents))}</strong>${from}. Here is how it splits:</p>${bar}${list}${how}`,
      { title: `${fmt.monthLong(month)}: what’s comfortable`, id: 'home-month' });
  }

  // ------------------------------------------------------------------ what if
  function controlsOf(m) {
    if (!m.split) return CONTROLS;
    const people = m.earners.map(p => ({ key: p.id + 'InCents', id: 'home-in-' + p.id, label: possessive(p.name) + ' income', usual: m.usual.bySource[p.id], help: 'What reaches the joint accounts from ' + p.name + ' each month.' }));
    return people.concat(CONTROLS.slice(1));
  }

  function controlsHtml(ctx, m, vals) {
    const max = (usual, cur) => {
      const top = Math.max(usual * 2, cur * 1.25, 100000);
      return Math.ceil(top / 50000) * 50000;
    };
    const current = k => (k.key.endsWith('InCents') && k.key !== 'inCents' ? vals.parts.find(x => x.id + 'InCents' === k.key).cents : vals[k.key]);
    const rows = controlsOf(m).map(k => {
      const usual = k.usual !== undefined ? k.usual : m.usual[k.usualKey];
      const cur = current(k);
      const hi = max(usual, cur);
      return `<div class="home-control">
        <div class="home-control-head"><label for="${k.id}">${esc(k.label)}</label>
          <span class="input-money home-amount"><span aria-hidden="true">$</span><input id="${k.id}-amount" type="text" inputmode="decimal" autocomplete="off" data-home-text="${k.key}" value="${esc(dollars(cur))}" aria-label="${esc(k.label)} per month, in dollars" aria-describedby="${k.id}-help"></span></div>
        <input id="${k.id}" type="range" min="0" max="${hi / 100}" step="25" value="${Math.round(cur / 100)}" data-home="${k.key}" aria-describedby="${k.id}-help" aria-valuetext="${esc(whole(cur))} a month">
        <p class="field-help" id="${k.id}-help">${esc(k.help)} Usually ${esc(whole(usual))}.</p>
      </div>`;
    }).join('');
    const comfy = m.comfy.comfortableCents;
    const tryIt = comfy > m.usual.savedCents ? c.button(`Try saving ${whole(comfy)} a month`, { action: 'home:try-comfortable', id: 'home-try', cls: 'btn-small' }) : '';
    const other = m.split ? m.usual.inCents - m.earners.reduce((s, p) => s + m.usual.bySource[p.id], 0) : 0;
    const otherNote = other ? `<p class="fine home-other-note">Plus about ${esc(whole(other))} a month of other money in (interest, refunds, deposits not matched to either of you), kept as usual.</p>` : '';
    return `<div class="home-whatif-grid">
        <div><div class="home-controls${m.split && m.earners.length > 1 ? ' is-four' : ''}" role="group" aria-label="What if">${rows}</div>${otherNote}</div>
        <div class="home-outcome">
          <div id="home-result" class="home-result" aria-live="polite">${resultHtml(ctx, m, vals)}</div>
          <div class="home-control-actions">${tryIt}${c.button('Back to usual amounts', { action: 'home:reset', id: 'home-reset', cls: 'btn-small', disabled: !vals.changed })}</div>
        </div>
      </div>`;
  }

  function resultHtml(ctx, m, vals) {
    const horizon = (ctx.state.ui.home || {}).horizon || 24;
    const plan = projectionOf(m, vals, horizon);
    const track = projectionOf(m, m.usual, horizon);
    const end = plan.rows[plan.rows.length - 1], base = track.rows[track.rows.length - 1];
    const diff = end.total - base.total;
    const left = vals.inCents - vals.outCents - vals.savedCents;
    return `<p class="home-result-line">Each month: ${esc(whole(vals.inCents))} in${vals.parts ? ` (${vals.parts.map(x => esc(x.name) + ' ' + esc(whole(x.cents))).join(', ')}${vals.inCents - vals.parts.reduce((s, x) => s + x.cents, 0) ? ', other ' + esc(whole(vals.inCents - vals.parts.reduce((s, x) => s + x.cents, 0))) : ''})` : ''} − ${esc(whole(vals.outCents))} spent − ${esc(whole(vals.savedCents))} to savings = <strong class="${left < 0 ? 'tone-bad' : ''}">${esc(signed(left))}</strong> in checking.</p>
      <p class="home-result-big">In ${esc(yearsText(horizon))}: <strong>${esc(whole(end.total))}</strong></p>
      <p class="home-result-line">Checking ${esc(whole(end.checking))} · ${hasSavings(m) ? 'savings' : 'moved to savings'} ${esc(whole(end.savings))}.${vals.changed ? ` That is <strong class="home-diff ${diff < 0 ? 'tone-bad' : 'tone-good'}">${esc(signed(diff))}</strong> compared with your current track.` : ' This is your current track.'}</p>
      ${plan.firstShortMonth ? `<p class="home-result-warn">${c.badge('Warning', 'bad')} Checking would run out in ${esc(fmt.monthLong(plan.firstShortMonth))}.</p>` : ''}`;
  }

  // ------------------------------------------------------------------ who brings in what
  function incomeCard(ctx, m) {
    if (!m.split) return '';
    const u = m.usual;
    const other = u.inCents - m.earners.reduce((s, p) => s + u.bySource[p.id], 0);
    const share = cents => (u.inCents > 0 ? Math.round(cents / u.inCents * 100) + '%' : '—');
    const howFor = p => {
      const streams = (ctx.state.plan.incomes || []).filter(i => i.personId === p.id);
      const kinds = new Set(streams.map(i => i.kind));
      return kinds.has('contribution') && !streams.some(i => i.kind === 'paycheck' && i.jointPerPaycheckCents) ? 'transfers into joint' : 'pay deposited to joint';
    };
    const tiles = m.earners.map(p => c.metric({ label: p.name, value: whole(u.bySource[p.id]), sub: `a month · ${esc(share(u.bySource[p.id]))} of money in · ${esc(howFor(p))}` })).join('')
      + (other ? c.metric({ label: 'Other', value: whole(other), sub: `a month · ${esc(share(other))} · interest, refunds and deposits not matched to either of you` }) : '');
    const shown = m.flows.slice(-HISTORY_MONTHS);
    const series = m.earners.map((p, i) => ({ name: p.name, values: shown.map(f => (f.bySource ? f.bySource[p.id] : null)), cls: 'series-' + (i + 1) }));
    if (other) series.push({ name: 'Other', values: shown.map(f => (f.bySource ? f.bySource.other : null)), cls: 'series-3' });
    const chart = c.lineChart({ id: 'home-income', title: 'Money into the joint accounts each month, by person', labels: shown.map(f => f.month), series, tableCaption: 'Money in per month, by person (complete months only)' });
    const missing = m.people.filter(p => !m.earners.includes(p));
    const note = `Averages of the same ${u.count} months as above. Only money that reaches the joint accounts is counted: pay kept in a personal account is not in your data.${missing.length ? ` No money in was matched to ${esc(missing.map(p => p.name).join(' or '))}.` : ''} Deposits are matched by the rules in your import and the incomes in <a href="${esc(ctx.href('budget', { section: 'income' }))}">Budget</a>.`;
    return c.card(`<div class="metrics home-income-metrics">${tiles}</div>${chart}<p class="fine">${note}</p>`, { title: 'Money coming in, by person', subtitle: 'Who brings in what, in a usual month and month by month.', id: 'home-income-card' });
  }

  // ------------------------------------------------------------------ month by month
  function patternCard(ctx, m) {
    const shown = m.flows.slice(-HISTORY_MONTHS);
    if (!shown.some(f => f.inCents !== null)) return '';
    const chart = c.lineChart({
      id: 'home-pattern',
      title: 'Money in, spending and saving each month',
      labels: shown.map(f => f.month),
      series: [
        { name: 'Money in', values: shown.map(f => f.inCents), cls: 'series-1' },
        { name: 'Spending', values: shown.map(f => f.outCents), cls: 'series-2' },
        { name: 'To savings', values: shown.map(f => f.savedCents), cls: 'series-3' },
      ],
      tableCaption: 'Money in, spending and saving per month (complete months only)',
    });
    const gaps = shown.filter(f => f.inCents === null).length;
    return c.card(chart + `<p class="fine">${gaps ? `${gaps} month${gaps === 1 ? ' is' : 's are'} not shown because some account’s export does not cover the whole month. ` : ''}Spending includes bills and loan payments, after refunds. <a href="${esc(ctx.href('spending'))}">See where the money went</a>.</p>`,
      { title: 'Month by month', subtitle: 'Your spending and saving pattern.', id: 'home-pattern-card' });
  }

  /** Accounts whose export has no running balance: one typed-in balance turns "change" into real balances. */
  function balancePrompt(ctx, m) {
    const missing = m.hist.accounts.filter(a => a.source !== 'bank');
    if (!missing.length) return '';
    const bal = ctx.state.plan.balances || {};
    const lastDay = ctx.months.length ? E.months.end(ctx.months[ctx.months.length - 1]) : '';
    const needs = missing.filter(a => a.source === 'change');
    const fields = missing.map(a => c.moneyField({ id: 'home-bal-' + a.id, label: a.label, path: 'plan.balances.accounts.' + a.id, cents: (bal.accounts || {})[a.id] ?? null, allowNegative: true, placeholder: 'Not entered', message: a.label + ' balance saved.', help: '' })).join('');
    const date = `<div class="field"><label for="home-bal-asof">Balance on</label><input id="home-bal-asof" type="date" data-bind="plan.balances.accountsAsOf" data-type="date" data-message="Balance date saved." value="${esc(bal.accountsAsOf || '')}" aria-describedby="home-bal-asof-help home-bal-asof-error"><p class="field-help" id="home-bal-asof-help">${lastDay ? `Your data ends ${esc(fmt.date(lastDay))}: a statement balance for that day works best.` : ''}</p><p class="field-error" id="home-bal-asof-error" role="alert" hidden></p></div>`;
    const body = `<p>${needs.length ? `Your ${esc(needs.map(a => a.label).join(' and '))} export has no running balance, so the chart shows how ${needs.length === 1 ? 'it has' : 'they have'} changed, not what ${needs.length === 1 ? 'it holds' : 'they hold'}. Enter one balance from a statement or your bank’s app and the whole history is worked out from the transactions.` : 'These balances come from what you entered. Update them any time.'}</p><div class="home-bal-fields">${fields}${date}</div>`;
    return needs.length ? c.card(body, { title: 'Add a balance', id: 'home-balances' }) : c.disclosure('Balances you entered', body, { cls: 'home-entered', id: 'home-entered' });
  }

  function render(ctx) {
    const header = c.pageHeader({
      title: 'Where you stand',
      subtitle: ctx.months.length ? `Your joint accounts, from your data through ${esc(fmt.date(E.months.end(ctx.months[ctx.months.length - 1])))}.` : 'Your joint accounts.',
    });
    const sample = ctx.dataset.isSynthetic ? c.notice({ tone: 'info', title: 'This is a fictional sample household.', body: 'Load your own bank exports in Data &amp; privacy; they stay on this device.' }) : '';
    if (ctx.app.datasetError) return header + c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) });
    if (!ctx.months.length) {
      return header + c.card(c.empty('Load your bank exports to see where you stand. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No data yet' });
    }
    const m = model(ctx);
    if (!m.hist.latest || m.usual.inCents === null) {
      const why = !m.hist.accounts.length ? 'There is no joint checking or savings account in the data.' : m.usual.inCents === null ? 'There is no complete month yet: every account’s export must cover a whole month.' : 'No month has a known balance yet.';
      return header + sample + c.card(c.empty(esc(why) + ' <a href="' + esc(ctx.href('review', { queue: 'coverage' })) + '">See which months are covered</a>.'), { title: 'Not enough data yet' }) + balancePrompt(ctx, m);
    }
    const vals = chosen(ctx, m);
    const horizon = (ctx.state.ui.home || {}).horizon || 24;
    const a = answers(ctx, m, vals, horizon);
    const chartCard = c.card(`<div class="home-chart" id="home-chart-slot">${chartHtml(ctx, m, vals, horizon)}</div>
      <div class="home-whatif"><h3 class="home-whatif-h">What if…</h3>${controlsHtml(ctx, m, vals)}</div>`, {
      title: 'Where this leads', id: 'home-track',
      subtitle: 'Solid: what happened. Dashed: where you are heading. Move the sliders to try a change.',
      actions: c.segmented({ label: 'Look ahead', name: 'home-horizon', options: HORIZONS, value: horizon, action: 'home:horizon' }),
    });
    const reviewCount = (() => { try { const q = ctx.reviewQueues().counts || {}; return (q.uncertain || 0) + (q.duplicates || 0); } catch { return 0; } })();
    const more = `<p class="home-more">More detail when you want it: <a href="${esc(ctx.href('spending'))}">where the money went</a> · <a href="${esc(ctx.href('budget'))}">bills and goals</a> · <a href="${esc(ctx.href('forecast'))}">bigger plans like a baby or a repair</a>${reviewCount ? ` · <a href="${esc(ctx.href('review'))}">${reviewCount} transaction${reviewCount === 1 ? '' : 's'} could use a check (optional)</a>` : ''}.</p>`;
    return `${header}<div class="stack">${sample}${a.tiles}${chartCard}${thisMonth(ctx, m, a.month)}${incomeCard(ctx, m)}${balancePrompt(ctx, m)}${patternCard(ctx, m)}${more}</div>`;
  }

  // ------------------------------------------------------------------ live sliders
  function readVals(container, ctx, m) {
    const overrides = {};
    for (const el of container.querySelectorAll('input[type="range"][data-home]')) overrides[el.dataset.home] = Math.round(Number(el.value) * 100);
    return chosen(ctx, m, overrides);
  }

  function redraw(container, ctx, m) {
    const vals = readVals(container, ctx, m);
    const horizon = (ctx.state.ui.home || {}).horizon || 24;
    const slot = container.querySelector('#home-chart-slot');
    if (slot) slot.innerHTML = chartHtml(ctx, m, vals, horizon);
    const res = container.querySelector('#home-result');
    if (res) res.innerHTML = resultHtml(ctx, m, vals);
    const reset = container.querySelector('#home-reset');
    if (reset) reset.disabled = !vals.changed;
  }

  function commit(ctx, key, cents) {
    ctx.app.update(st => E.state.setPath(st, 'ui.home.' + key, cents), { undoable: false });
  }

  function afterRender(container, ctx) {
    if (!container.querySelector('.home-controls')) return;
    const m = model(ctx);
    for (const el of container.querySelectorAll('input[type="range"][data-home]')) {
      el.addEventListener('input', () => {
        const cents = Math.round(Number(el.value) * 100);
        const text = container.querySelector(`[data-home-text="${el.dataset.home}"]`);
        if (text) text.value = dollars(cents);
        el.setAttribute('aria-valuetext', whole(cents) + ' a month');
        redraw(container, ctx, m);
      });
      el.addEventListener('change', () => commit(ctx, el.dataset.home, Math.round(Number(el.value) * 100)));
    }
    for (const el of container.querySelectorAll('input[data-home-text]')) {
      const apply = () => {
        let cents;
        try { cents = E.money.inputToCents(el.value); } catch { cents = null; }
        if (cents === null) {
          const slider = container.querySelector(`input[type="range"][data-home="${el.dataset.homeText}"]`);
          el.value = slider ? dollars(Math.round(Number(slider.value) * 100)) : '';
          return;
        }
        commit(ctx, el.dataset.homeText, cents);
      };
      el.addEventListener('change', apply);
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
    }
  }

  const actions = {
    'home:try-comfortable': ctx => {
      const m = model(ctx);
      ctx.app.update(st => E.state.setPath(st, 'ui.home.savedCents', m.comfy.comfortableCents), { undoable: false });
    },
    'home:reset': ctx => {
      ctx.app.update(st => ({ ...st, ui: { ...st.ui, home: { ...st.ui.home, inCents: null, p1InCents: null, p2InCents: null, outCents: null, savedCents: null } } }), { undoable: false, message: 'Back to your usual amounts.' });
    },
    'home:horizon': (ctx, el) => ctx.app.update(st => E.state.setPath(st, 'ui.home.horizon', Number(el.dataset.value || el.value)), { undoable: false }),
  };

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Home', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
